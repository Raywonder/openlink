/**
 * Hybrid Configuration Manager
 * Handles both local Mac mini operations (with sudo) and remote server operations (via SSH)
 */

const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const crypto = require('crypto');
const os = require('os');

class HybridConfigManager {
    constructor(options = {}) {
        this.options = {
            // Local Mac mini settings
            localSudoPassword: options.localSudoPassword || 'DsmotifXS678!$',
            localNginxPath: options.localNginxPath || '/usr/local/etc/nginx/conf.d/openlink-domains.conf',

            // Remote server settings
            serverHost: options.serverHost || 'raywonderis.me',
            serverPort: options.serverPort || 450,
            serverUser: options.serverUser || 'root',
            sshKeyPath: options.sshKeyPath || path.join(os.homedir(), '.ssh/raywonder'),
            serverNginxPath: options.serverNginxPath || '/etc/nginx/conf.d/openlink-domains.conf',

            // Domain settings
            allowedDomains: options.allowedDomains || ['raywonderis.me', 'openlink.local'],
            basePort: options.basePort || 8000,
            maxPorts: options.maxPorts || 1000,

            ...options
        };

        this.activeDomains = new Map();
        this.portAllocations = new Map();
    }

    /**
     * Execute command locally on Mac mini with sudo
     */
    async executeLocalSudo(command) {
        return new Promise((resolve, reject) => {
            const sudoCommand = `echo "${this.options.localSudoPassword}" | sudo -S ${command}`;

            exec(sudoCommand, { timeout: 30000 }, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(`Local sudo command failed: ${stderr || error.message}`));
                } else {
                    resolve({ stdout, stderr });
                }
            });
        });
    }

    /**
     * Execute command on remote server via SSH
     */
    async executeRemoteSSH(command) {
        return new Promise((resolve, reject) => {
            const sshCommand = `ssh -p ${this.options.serverPort} -i ${this.options.sshKeyPath} -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${this.options.serverUser}@${this.options.serverHost} "${command}"`;

            exec(sshCommand, { timeout: 60000 }, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(`Remote SSH command failed: ${stderr || error.message}`));
                } else {
                    resolve({ stdout, stderr });
                }
            });
        });
    }

    /**
     * Upload file to remote server via SCP
     */
    async uploadFileToServer(localPath, remotePath) {
        return new Promise((resolve, reject) => {
            const scpCommand = `scp -P ${this.options.serverPort} -i ${this.options.sshKeyPath} -o StrictHostKeyChecking=no "${localPath}" ${this.options.serverUser}@${this.options.serverHost}:"${remotePath}"`;

            exec(scpCommand, { timeout: 60000 }, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(`File upload failed: ${stderr || error.message}`));
                } else {
                    resolve({ stdout, stderr });
                }
            });
        });
    }

    /**
     * Request domain configuration (decides local vs remote based on domain)
     */
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
            expiresAt: new Date(Date.now() + (24 * 60 * 60 * 1000)).toISOString(),
            status: 'configuring',
            location: this.determineDomainLocation(domainRequest.baseDomain)
        };

        domain.fullDomain = `${domain.subdomain}.${domain.baseDomain}`;

        try {
            if (domain.location === 'local') {
                await this.configureLocalDomain(domain);
            } else {
                await this.configureRemoteDomain(domain);
            }

            domain.status = 'active';
            this.activeDomains.set(domainId, domain);
            this.portAllocations.set(port, domainId);

            console.log(`🌐 Domain configured: ${domain.fullDomain} (${domain.location})`);
            return domain;

        } catch (error) {
            this.releasePort(port);
            throw new Error(`Failed to configure domain: ${error.message}`);
        }
    }

    /**
     * Determine if domain should be configured locally or remotely
     */
    determineDomainLocation(baseDomain) {
        // .local domains and development domains go to local nginx
        if (baseDomain.endsWith('.local') || baseDomain === 'localhost') {
            return 'local';
        }

        // Public domains go to remote server
        if (this.options.allowedDomains.includes(baseDomain)) {
            return 'remote';
        }

        // Default to local for unknown domains
        return 'local';
    }

    /**
     * Configure domain on local Mac mini nginx
     */
    async configureLocalDomain(domain) {
        try {
            const nginxConfig = this.generateNginxServerBlock(domain);

            // Read existing config or create new one
            let existingConfig = '';
            if (fs.existsSync(this.options.localNginxPath)) {
                existingConfig = fs.readFileSync(this.options.localNginxPath, 'utf8');
            }

            // Add new server block
            const updatedConfig = existingConfig + '\n\n' + nginxConfig;

            // Write to temp file first
            const tempFile = `/tmp/openlink-nginx-local-${Date.now()}.conf`;
            fs.writeFileSync(tempFile, updatedConfig);

            // Use sudo to copy to nginx directory
            await this.executeLocalSudo(`cp "${tempFile}" "${this.options.localNginxPath}"`);

            // Clean up temp file
            fs.unlinkSync(tempFile);

            // Test and reload local nginx
            await this.testLocalNginx();
            await this.reloadLocalNginx();

            console.log(`✅ Local nginx configured for ${domain.fullDomain}`);

        } catch (error) {
            console.error(`❌ Failed to configure local nginx: ${error.message}`);
            throw error;
        }
    }

    /**
     * Configure domain on remote server nginx
     */
    async configureRemoteDomain(domain) {
        try {
            const nginxConfig = this.generateNginxServerBlock(domain);

            // Create temp file locally
            const tempFile = `/tmp/openlink-nginx-remote-${Date.now()}.conf`;

            // Read existing remote config
            let existingConfig = '';
            try {
                const result = await this.executeRemoteSSH(`cat ${this.options.serverNginxPath}`);
                existingConfig = result.stdout;
            } catch (error) {
                // File might not exist yet, that's okay
                console.log('📝 Creating new remote nginx config file');
            }

            // Add new server block
            const updatedConfig = existingConfig + '\n\n' + nginxConfig;
            fs.writeFileSync(tempFile, updatedConfig);

            // Upload to server
            await this.uploadFileToServer(tempFile, this.options.serverNginxPath);

            // Clean up temp file
            fs.unlinkSync(tempFile);

            // Test and reload remote nginx
            await this.testRemoteNginx();
            await this.reloadRemoteNginx();

            console.log(`✅ Remote nginx configured for ${domain.fullDomain}`);

        } catch (error) {
            console.error(`❌ Failed to configure remote nginx: ${error.message}`);
            throw error;
        }
    }

    /**
     * Generate nginx server block configuration
     */
    generateNginxServerBlock(domain) {
        const upstream = domain.location === 'local'
            ? `${domain.targetHost}:${domain.targetPort}`
            : `${this.getLocalIP()}:${domain.targetPort}`; // For remote, proxy back to local Mac

        return `
# OpenLink Domain: ${domain.fullDomain} (ID: ${domain.id}, Location: ${domain.location})
# Created: ${domain.createdAt}
# Expires: ${domain.expiresAt}
upstream ${domain.id}_upstream {
    server ${upstream};
}

server {
    listen 80;
    server_name ${domain.fullDomain};

    # Security headers
    add_header X-Frame-Options SAMEORIGIN;
    add_header X-Content-Type-Options nosniff;
    add_header X-XSS-Protection "1; mode=block";
    add_header Referrer-Policy "strict-origin-when-cross-origin";

    # WebSocket and proxy settings
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Timeouts for long-running connections
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    proxy_connect_timeout 10s;

    # Buffer settings for better performance
    proxy_buffering on;
    proxy_buffer_size 4k;
    proxy_buffers 8 4k;

    # Main proxy location
    location / {
        proxy_pass http://${domain.id}_upstream;

        # CORS headers for OpenLink
        add_header Access-Control-Allow-Origin *;
        add_header Access-Control-Allow-Methods "GET, POST, OPTIONS, PUT, DELETE";
        add_header Access-Control-Allow-Headers "Origin, X-Requested-With, Content-Type, Accept, Authorization";

        # Handle preflight requests
        if ($request_method = 'OPTIONS') {
            add_header Access-Control-Allow-Origin *;
            add_header Access-Control-Allow-Methods "GET, POST, OPTIONS, PUT, DELETE";
            add_header Access-Control-Allow-Headers "Origin, X-Requested-With, Content-Type, Accept, Authorization";
            add_header Content-Length 0;
            add_header Content-Type text/plain;
            return 204;
        }
    }

    # WebSocket endpoint with special handling
    location /ws {
        proxy_pass http://${domain.id}_upstream;
        proxy_redirect off;
    }

    # API endpoints
    location /api/ {
        proxy_pass http://${domain.id}_upstream;
        proxy_redirect off;
    }

    # SignalR/Socket.IO support
    location /signalr/ {
        proxy_pass http://${domain.id}_upstream;
        proxy_redirect off;
    }

    # Health check endpoint
    location /health {
        access_log off;
        return 200 "healthy: ${domain.fullDomain}\\n";
        add_header Content-Type text/plain;
    }

    # OpenLink status endpoint
    location /.openlink/status {
        access_log off;
        return 200 '{"domain": "${domain.fullDomain}", "id": "${domain.id}", "location": "${domain.location}", "status": "active"}';
        add_header Content-Type application/json;
    }
}`;
    }

    /**
     * Test local nginx configuration
     */
    async testLocalNginx() {
        try {
            await this.executeLocalSudo('nginx -t');
            return true;
        } catch (error) {
            throw new Error(`Local nginx config test failed: ${error.message}`);
        }
    }

    /**
     * Test remote nginx configuration
     */
    async testRemoteNginx() {
        try {
            await this.executeRemoteSSH('nginx -t');
            return true;
        } catch (error) {
            throw new Error(`Remote nginx config test failed: ${error.message}`);
        }
    }

    /**
     * Reload local nginx
     */
    async reloadLocalNginx() {
        try {
            await this.executeLocalSudo('nginx -s reload');
            console.log('🔄 Local nginx reloaded');
        } catch (error) {
            throw new Error(`Local nginx reload failed: ${error.message}`);
        }
    }

    /**
     * Reload remote nginx
     */
    async reloadRemoteNginx() {
        try {
            await this.executeRemoteSSH('nginx -s reload');
            console.log('🔄 Remote nginx reloaded');
        } catch (error) {
            throw new Error(`Remote nginx reload failed: ${error.message}`);
        }
    }

    /**
     * Release domain configuration
     */
    async releaseDomain(domainId) {
        const domain = this.activeDomains.get(domainId);
        if (!domain) {
            throw new Error('Domain not found');
        }

        try {
            if (domain.location === 'local') {
                await this.removeLocalDomainConfiguration(domain);
            } else {
                await this.removeRemoteDomainConfiguration(domain);
            }

            this.activeDomains.delete(domainId);
            this.releasePort(domain.port);

            console.log(`🗑️  Domain released: ${domain.fullDomain} (${domain.location})`);

        } catch (error) {
            console.error(`❌ Failed to release domain: ${error.message}`);
            throw error;
        }
    }

    /**
     * Remove local domain configuration
     */
    async removeLocalDomainConfiguration(domain) {
        try {
            // Read current config
            let config = '';
            if (fs.existsSync(this.options.localNginxPath)) {
                config = fs.readFileSync(this.options.localNginxPath, 'utf8');
            }

            const updatedConfig = this.removeDomainFromConfig(config, domain);

            if (updatedConfig !== config) {
                const tempFile = `/tmp/openlink-nginx-remove-local-${Date.now()}.conf`;
                fs.writeFileSync(tempFile, updatedConfig);
                await this.executeLocalSudo(`cp "${tempFile}" "${this.options.localNginxPath}"`);
                fs.unlinkSync(tempFile);
                await this.reloadLocalNginx();
            }

        } catch (error) {
            throw new Error(`Failed to remove local domain config: ${error.message}`);
        }
    }

    /**
     * Remove remote domain configuration
     */
    async removeRemoteDomainConfiguration(domain) {
        try {
            // Get current remote config
            const result = await this.executeRemoteSSH(`cat ${this.options.serverNginxPath}`);
            const config = result.stdout;

            const updatedConfig = this.removeDomainFromConfig(config, domain);

            if (updatedConfig !== config) {
                const tempFile = `/tmp/openlink-nginx-remove-remote-${Date.now()}.conf`;
                fs.writeFileSync(tempFile, updatedConfig);
                await this.uploadFileToServer(tempFile, this.options.serverNginxPath);
                fs.unlinkSync(tempFile);
                await this.reloadRemoteNginx();
            }

        } catch (error) {
            throw new Error(`Failed to remove remote domain config: ${error.message}`);
        }
    }

    /**
     * Remove domain configuration from nginx config string
     */
    removeDomainFromConfig(config, domain) {
        const startMarker = `# OpenLink Domain: ${domain.fullDomain} (ID: ${domain.id}`;
        const endMarker = '# OpenLink Domain:';

        const startIndex = config.indexOf(startMarker);
        if (startIndex === -1) {
            return config; // Domain not found in config
        }

        let endIndex = config.indexOf(endMarker, startIndex + 1);
        if (endIndex === -1) {
            endIndex = config.length;
        }

        return config.slice(0, startIndex) + config.slice(endIndex);
    }

    /**
     * Get local IP address
     */
    getLocalIP() {
        const interfaces = os.networkInterfaces();
        for (const [name, addrs] of Object.entries(interfaces)) {
            for (const addr of addrs) {
                if (addr.family === 'IPv4' && !addr.internal) {
                    return addr.address;
                }
            }
        }
        return 'localhost';
    }

    /**
     * Port allocation utilities
     */
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

    /**
     * Get status of all managed domains
     */
    getStatus() {
        const domains = Array.from(this.activeDomains.values());

        return {
            totalDomains: domains.length,
            localDomains: domains.filter(d => d.location === 'local').length,
            remoteDomains: domains.filter(d => d.location === 'remote').length,
            allocatedPorts: this.portAllocations.size,
            domains: domains,
            config: {
                localNginxPath: this.options.localNginxPath,
                serverNginxPath: this.options.serverNginxPath,
                serverHost: this.options.serverHost,
                serverPort: this.options.serverPort
            }
        };
    }

    /**
     * Test connectivity to remote server
     */
    async testServerConnection() {
        try {
            const result = await this.executeRemoteSSH('echo "Server connection test successful" && hostname && date');
            return {
                success: true,
                hostname: result.stdout.split('\n')[1],
                date: result.stdout.split('\n')[2],
                message: result.stdout.split('\n')[0]
            };
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
}

module.exports = HybridConfigManager;