/**
 * OpenLink API Server
 * Unified API for client/server communication with nginx configuration management
 */

const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn, exec } = require('child_process');

class OpenLinkAPIServer {
    constructor(options = {}) {
        this.options = {
            port: options.port || 3000,
            nginxConfigPath: options.nginxConfigPath || '/etc/nginx/conf.d/openlink-domains.conf',
            nginxMainConfig: options.nginxMainConfig || '/etc/nginx/nginx.conf',
            sudoPassword: options.sudoPassword || 'DsmotifXS678!$',
            allowedDomains: options.allowedDomains || ['raywonderis.me', 'openlink.local'],
            basePort: options.basePort || 8000,
            maxPorts: options.maxPorts || 1000,
            sslEnabled: options.sslEnabled || false,
            certPath: options.certPath || '/etc/ssl/certs',
            ...options
        };

        this.app = express();
        this.server = null;
        this.wss = null;
        this.activeDomains = new Map();
        this.portAllocations = new Map();
        this.sessions = new Map();
        this.isRunning = false;

        this.setupExpress();
        this.loadExistingDomains();
    }

    setupExpress() {
        // Middleware
        this.app.use(cors({
            origin: '*',
            credentials: true
        }));
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ extended: true }));

        // Logging middleware
        this.app.use((req, res, next) => {
            console.log(`📡 ${req.method} ${req.path} - ${req.ip}`);
            next();
        });

        this.setupClientRoutes();
        this.setupServerRoutes();
        this.setupDomainRoutes();
        this.setupNginxRoutes();
    }

    setupClientRoutes() {
        // Client API endpoints
        this.app.post('/api/client/register', async (req, res) => {
            try {
                const client = await this.registerClient(req.body);
                res.json({ success: true, client });
            } catch (error) {
                res.status(400).json({ success: false, error: error.message });
            }
        });

        this.app.post('/api/client/connect', async (req, res) => {
            try {
                const connection = await this.createClientConnection(req.body);
                res.json({ success: true, connection });
            } catch (error) {
                res.status(400).json({ success: false, error: error.message });
            }
        });

        this.app.post('/api/client/domain/request', async (req, res) => {
            try {
                const domain = await this.requestDomain(req.body);
                res.json({ success: true, domain });
            } catch (error) {
                res.status(400).json({ success: false, error: error.message });
            }
        });

        this.app.get('/api/client/domain/:domainId', async (req, res) => {
            try {
                const domain = this.activeDomains.get(req.params.domainId);
                if (!domain) {
                    return res.status(404).json({ success: false, error: 'Domain not found' });
                }
                res.json({ success: true, domain });
            } catch (error) {
                res.status(400).json({ success: false, error: error.message });
            }
        });

        this.app.delete('/api/client/domain/:domainId', async (req, res) => {
            try {
                await this.releaseDomain(req.params.domainId);
                res.json({ success: true });
            } catch (error) {
                res.status(400).json({ success: false, error: error.message });
            }
        });
    }

    setupServerRoutes() {
        // Server API endpoints
        this.app.post('/api/server/session/start', async (req, res) => {
            try {
                const session = await this.startServerSession(req.body);
                res.json({ success: true, session });
            } catch (error) {
                res.status(400).json({ success: false, error: error.message });
            }
        });

        this.app.post('/api/server/session/stop/:sessionId', async (req, res) => {
            try {
                await this.stopServerSession(req.params.sessionId);
                res.json({ success: true });
            } catch (error) {
                res.status(400).json({ success: false, error: error.message });
            }
        });

        this.app.get('/api/server/sessions', (req, res) => {
            const sessions = Array.from(this.sessions.values());
            res.json({ success: true, sessions });
        });

        this.app.get('/api/server/status', (req, res) => {
            res.json({
                success: true,
                status: this.getServerStatus()
            });
        });

        this.app.post('/api/server/nginx/reload', async (req, res) => {
            try {
                await this.reloadNginx();
                res.json({ success: true, message: 'Nginx reloaded successfully' });
            } catch (error) {
                res.status(500).json({ success: false, error: error.message });
            }
        });
    }

    setupDomainRoutes() {
        // Domain management
        this.app.get('/api/domains', (req, res) => {
            const domains = Array.from(this.activeDomains.values());
            res.json({ success: true, domains });
        });

        this.app.post('/api/domains/allocate', async (req, res) => {
            try {
                const allocation = await this.allocateDomain(req.body);
                res.json({ success: true, allocation });
            } catch (error) {
                res.status(400).json({ success: false, error: error.message });
            }
        });

        this.app.post('/api/domains/configure', async (req, res) => {
            try {
                await this.configureDomainProxy(req.body);
                res.json({ success: true, message: 'Domain configured successfully' });
            } catch (error) {
                res.status(500).json({ success: false, error: error.message });
            }
        });

        this.app.delete('/api/domains/:domainId', async (req, res) => {
            try {
                await this.removeDomainConfiguration(req.params.domainId);
                res.json({ success: true });
            } catch (error) {
                res.status(500).json({ success: false, error: error.message });
            }
        });
    }

    setupNginxRoutes() {
        // Nginx configuration management
        this.app.get('/api/nginx/config', async (req, res) => {
            try {
                const config = await this.getNginxConfig();
                res.json({ success: true, config });
            } catch (error) {
                res.status(500).json({ success: false, error: error.message });
            }
        });

        this.app.post('/api/nginx/config/update', async (req, res) => {
            try {
                await this.updateNginxConfig(req.body.config);
                res.json({ success: true, message: 'Nginx configuration updated' });
            } catch (error) {
                res.status(500).json({ success: false, error: error.message });
            }
        });

        this.app.post('/api/nginx/test', async (req, res) => {
            try {
                const result = await this.testNginxConfig();
                res.json({ success: true, result });
            } catch (error) {
                res.status(500).json({ success: false, error: error.message });
            }
        });
    }

    async registerClient(clientData) {
        const clientId = crypto.randomBytes(16).toString('hex');

        const client = {
            id: clientId,
            name: clientData.name || 'Unknown Client',
            platform: clientData.platform || process.platform,
            version: clientData.version || '1.0.0',
            hostname: clientData.hostname || os.hostname(),
            localIP: clientData.localIP,
            publicIP: await this.getPublicIP(),
            registeredAt: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            capabilities: clientData.capabilities || {
                hosting: true,
                connecting: true,
                fileTransfer: true,
                audioVideo: true
            }
        };

        // Store client info
        const clientsFile = path.join(os.tmpdir(), 'openlink-clients.json');
        let clients = {};

        try {
            if (fs.existsSync(clientsFile)) {
                clients = JSON.parse(fs.readFileSync(clientsFile, 'utf8'));
            }
        } catch (error) {
            console.warn('❌ Could not read clients file:', error.message);
        }

        clients[clientId] = client;
        fs.writeFileSync(clientsFile, JSON.stringify(clients, null, 2));

        console.log(`📱 Client registered: ${clientId} (${client.name})`);
        return client;
    }

    async createClientConnection(connectionData) {
        const connectionId = crypto.randomBytes(16).toString('hex');

        const connection = {
            id: connectionId,
            clientId: connectionData.clientId,
            sessionId: connectionData.sessionId,
            type: connectionData.type || 'peer', // peer, relay, direct
            createdAt: new Date().toISOString(),
            status: 'establishing',
            endpoints: {
                local: connectionData.localEndpoint,
                public: connectionData.publicEndpoint,
                relay: connectionData.relayEndpoint
            }
        };

        // Store connection
        // This would integrate with the existing WebRTC signaling logic

        console.log(`🔗 Connection created: ${connectionId}`);
        return connection;
    }

    async requestDomain(domainRequest) {
        const domainId = crypto.randomBytes(16).toString('hex');
        const port = this.allocatePort();

        if (!port) {
            throw new Error('No available ports');
        }

        const domain = {
            id: domainId,
            clientId: domainRequest.clientId,
            subdomain: domainRequest.subdomain || domainId,
            baseDomain: domainRequest.baseDomain || this.options.allowedDomains[0],
            port: port,
            targetHost: domainRequest.targetHost || 'localhost',
            targetPort: domainRequest.targetPort,
            sslEnabled: domainRequest.sslEnabled || false,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + (24 * 60 * 60 * 1000)).toISOString(), // 24 hours
            status: 'configuring'
        };

        domain.fullDomain = `${domain.subdomain}.${domain.baseDomain}`;

        try {
            // Configure nginx proxy
            await this.configureDomainProxy(domain);
            domain.status = 'active';

            this.activeDomains.set(domainId, domain);
            this.portAllocations.set(port, domainId);

            console.log(`🌐 Domain allocated: ${domain.fullDomain}:${port} -> ${domain.targetHost}:${domain.targetPort}`);
            return domain;

        } catch (error) {
            this.releasePort(port);
            throw new Error(`Failed to configure domain: ${error.message}`);
        }
    }

    async configureDomainProxy(domain) {
        const nginxConfig = this.generateNginxServerBlock(domain);

        try {
            // Read existing config or create new one
            let existingConfig = '';
            if (fs.existsSync(this.options.nginxConfigPath)) {
                existingConfig = fs.readFileSync(this.options.nginxConfigPath, 'utf8');
            }

            // Add new server block
            const updatedConfig = existingConfig + '\n\n' + nginxConfig;

            // Write config with sudo
            await this.writeSudoFile(this.options.nginxConfigPath, updatedConfig);

            // Test and reload nginx
            await this.testNginxConfig();
            await this.reloadNginx();

            console.log(`✅ Nginx configured for ${domain.fullDomain}`);

        } catch (error) {
            console.error(`❌ Failed to configure nginx for ${domain.fullDomain}:`, error.message);
            throw error;
        }
    }

    generateNginxServerBlock(domain) {
        const config = `
# OpenLink Domain: ${domain.fullDomain} (ID: ${domain.id})
server {
    listen 80;
    server_name ${domain.fullDomain};

    # Security headers
    add_header X-Frame-Options SAMEORIGIN;
    add_header X-Content-Type-Options nosniff;
    add_header X-XSS-Protection "1; mode=block";

    # WebSocket support
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Timeouts for WebRTC
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;

    location / {
        proxy_pass http://${domain.targetHost}:${domain.targetPort};

        # CORS headers for OpenLink
        add_header Access-Control-Allow-Origin *;
        add_header Access-Control-Allow-Methods "GET, POST, OPTIONS, PUT, DELETE";
        add_header Access-Control-Allow-Headers "Origin, X-Requested-With, Content-Type, Accept, Authorization";

        # Handle preflight requests
        if ($request_method = 'OPTIONS') {
            add_header Access-Control-Allow-Origin *;
            add_header Access-Control-Allow-Methods "GET, POST, OPTIONS, PUT, DELETE";
            add_header Access-Control-Allow-Headers "Origin, X-Requested-With, Content-Type, Accept, Authorization";
            return 204;
        }
    }

    # WebSocket endpoint
    location /ws {
        proxy_pass http://${domain.targetHost}:${domain.targetPort};
    }

    # API endpoints
    location /api/ {
        proxy_pass http://${domain.targetHost}:${domain.targetPort};
    }

    # Health check
    location /health {
        access_log off;
        return 200 "healthy\\n";
        add_header Content-Type text/plain;
    }

    # Created: ${domain.createdAt}
    # Expires: ${domain.expiresAt}
}`;

        if (domain.sslEnabled) {
            return config + `

# SSL version for ${domain.fullDomain}
server {
    listen 443 ssl http2;
    server_name ${domain.fullDomain};

    ssl_certificate ${this.options.certPath}/${domain.fullDomain}.crt;
    ssl_certificate_key ${this.options.certPath}/${domain.fullDomain}.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-RSA-AES256-GCM-SHA512:DHE-RSA-AES256-GCM-SHA512:ECDHE-RSA-AES256-GCM-SHA384:DHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;

    # Security headers
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload";
    add_header X-Frame-Options SAMEORIGIN;
    add_header X-Content-Type-Options nosniff;
    add_header X-XSS-Protection "1; mode=block";

    # Same proxy configuration as HTTP
    location / {
        proxy_pass http://${domain.targetHost}:${domain.targetPort};
        # ... (same proxy settings)
    }
}`;
        }

        return config;
    }

    async writeSudoFile(filePath, content) {
        return new Promise((resolve, reject) => {
            const tempFile = `/tmp/openlink-nginx-${Date.now()}.conf`;

            // Write to temp file first
            fs.writeFileSync(tempFile, content);

            // Use sudo to move to final location
            const command = `echo "${this.options.sudoPassword}" | sudo -S cp "${tempFile}" "${filePath}"`;

            exec(command, { timeout: 10000 }, (error, stdout, stderr) => {
                // Clean up temp file
                try {
                    fs.unlinkSync(tempFile);
                } catch (e) {
                    // Ignore cleanup errors
                }

                if (error) {
                    reject(new Error(`Sudo file write failed: ${error.message}`));
                } else {
                    resolve();
                }
            });
        });
    }

    async testNginxConfig() {
        return new Promise((resolve, reject) => {
            const command = `echo "${this.options.sudoPassword}" | sudo -S nginx -t`;

            exec(command, { timeout: 10000 }, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(`Nginx config test failed: ${stderr || error.message}`));
                } else {
                    resolve({ stdout, stderr });
                }
            });
        });
    }

    async reloadNginx() {
        return new Promise((resolve, reject) => {
            const command = `echo "${this.options.sudoPassword}" | sudo -S nginx -s reload`;

            exec(command, { timeout: 10000 }, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(`Nginx reload failed: ${stderr || error.message}`));
                } else {
                    resolve();
                }
            });
        });
    }

    async getNginxConfig() {
        try {
            if (fs.existsSync(this.options.nginxConfigPath)) {
                return fs.readFileSync(this.options.nginxConfigPath, 'utf8');
            }
            return '';
        } catch (error) {
            throw new Error(`Failed to read nginx config: ${error.message}`);
        }
    }

    allocatePort() {
        for (let port = this.options.basePort; port < this.options.basePort + this.options.maxPorts; port++) {
            if (!this.portAllocations.has(port)) {
                return port;
            }
        }
        return null;
    }

    releasePort(port) {
        this.portAllocations.delete(port);
    }

    async releaseDomain(domainId) {
        const domain = this.activeDomains.get(domainId);
        if (!domain) {
            throw new Error('Domain not found');
        }

        try {
            await this.removeDomainConfiguration(domainId);
            this.activeDomains.delete(domainId);
            this.releasePort(domain.port);

            console.log(`🗑️  Domain released: ${domain.fullDomain}`);
        } catch (error) {
            console.error(`❌ Failed to release domain: ${error.message}`);
            throw error;
        }
    }

    async removeDomainConfiguration(domainId) {
        const domain = this.activeDomains.get(domainId);
        if (!domain) {
            throw new Error('Domain not found');
        }

        try {
            // Read current config
            let config = '';
            if (fs.existsSync(this.options.nginxConfigPath)) {
                config = fs.readFileSync(this.options.nginxConfigPath, 'utf8');
            }

            // Remove the server block for this domain
            const startMarker = `# OpenLink Domain: ${domain.fullDomain} (ID: ${domain.id})`;
            const nextMarker = '# OpenLink Domain:';

            const startIndex = config.indexOf(startMarker);
            if (startIndex !== -1) {
                let endIndex = config.indexOf(nextMarker, startIndex + 1);
                if (endIndex === -1) {
                    endIndex = config.length;
                }

                const updatedConfig = config.slice(0, startIndex) + config.slice(endIndex);
                await this.writeSudoFile(this.options.nginxConfigPath, updatedConfig);
                await this.reloadNginx();
            }

            console.log(`✅ Nginx configuration removed for ${domain.fullDomain}`);

        } catch (error) {
            console.error(`❌ Failed to remove nginx config: ${error.message}`);
            throw error;
        }
    }

    loadExistingDomains() {
        // Load existing domains from nginx config if any
        try {
            if (fs.existsSync(this.options.nginxConfigPath)) {
                const config = fs.readFileSync(this.options.nginxConfigPath, 'utf8');
                const domainMatches = config.match(/# OpenLink Domain: (.+) \(ID: (.+)\)/g);

                if (domainMatches) {
                    for (const match of domainMatches) {
                        const [, fullDomain, id] = match.match(/# OpenLink Domain: (.+) \(ID: (.+)\)/);
                        console.log(`🔄 Found existing domain: ${fullDomain} (${id})`);
                    }
                }
            }
        } catch (error) {
            console.warn('⚠️  Could not load existing domains:', error.message);
        }
    }

    async getPublicIP() {
        try {
            const https = require('https');
            return new Promise((resolve, reject) => {
                https.get('https://api.ipify.org', (res) => {
                    let data = '';
                    res.on('data', (chunk) => data += chunk);
                    res.on('end', () => resolve(data.trim()));
                }).on('error', reject);
            });
        } catch (error) {
            return null;
        }
    }

    getServerStatus() {
        return {
            running: this.isRunning,
            port: this.options.port,
            domains: this.activeDomains.size,
            allocatedPorts: this.portAllocations.size,
            sessions: this.sessions.size,
            nginx: {
                configPath: this.options.nginxConfigPath,
                configExists: fs.existsSync(this.options.nginxConfigPath)
            },
            timestamp: new Date().toISOString()
        };
    }

    async startServer() {
        try {
            this.server = http.createServer(this.app);

            // Setup WebSocket
            this.wss = new WebSocket.Server({
                server: this.server,
                path: '/ws'
            });

            this.setupWebSocketHandlers();

            await new Promise((resolve, reject) => {
                this.server.listen(this.options.port, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });

            this.isRunning = true;
            console.log(`🚀 OpenLink API Server started on port ${this.options.port}`);
            console.log(`📡 WebSocket available at ws://localhost:${this.options.port}/ws`);
            console.log(`🌐 Nginx config path: ${this.options.nginxConfigPath}`);

            return { success: true, port: this.options.port };

        } catch (error) {
            console.error('❌ Failed to start API server:', error);
            throw error;
        }
    }

    setupWebSocketHandlers() {
        this.wss.on('connection', (ws) => {
            const connectionId = crypto.randomBytes(16).toString('hex');
            console.log(`🔌 WebSocket connected: ${connectionId}`);

            ws.on('message', async (message) => {
                try {
                    const data = JSON.parse(message);
                    const response = await this.handleWebSocketMessage(data);
                    ws.send(JSON.stringify(response));
                } catch (error) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: error.message
                    }));
                }
            });

            ws.on('close', () => {
                console.log(`🔌 WebSocket disconnected: ${connectionId}`);
            });

            ws.send(JSON.stringify({
                type: 'connected',
                connectionId,
                timestamp: Date.now()
            }));
        });
    }

    async handleWebSocketMessage(data) {
        switch (data.type) {
            case 'domain_request':
                return await this.requestDomain(data.params);

            case 'domain_release':
                await this.releaseDomain(data.domainId);
                return { type: 'domain_released', domainId: data.domainId };

            case 'nginx_reload':
                await this.reloadNginx();
                return { type: 'nginx_reloaded' };

            case 'status':
                return { type: 'status', status: this.getServerStatus() };

            default:
                throw new Error(`Unknown message type: ${data.type}`);
        }
    }

    async stopServer() {
        try {
            if (this.wss) {
                this.wss.close();
            }

            if (this.server) {
                await new Promise((resolve) => {
                    this.server.close(resolve);
                });
            }

            this.isRunning = false;
            console.log('🛑 OpenLink API Server stopped');

        } catch (error) {
            console.error('❌ Failed to stop API server:', error);
            throw error;
        }
    }
}

module.exports = OpenLinkAPIServer;