/**
 * OpenLink Unified API
 * Integrates hybrid configuration manager with complete API system
 */

const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');

const HybridConfigManager = require('./hybrid-config-manager');
const ClaudeOpenLinkManager = require('../claude-openlink-manager');

class OpenLinkUnifiedAPI {
    constructor(options = {}) {
        this.options = {
            port: options.port || 3000,
            wsPort: options.wsPort || 3001,
            enableClaude: options.enableClaude !== false,
            ...options
        };

        this.app = express();
        this.server = null;
        this.wss = null;

        // Initialize managers
        this.configManager = new HybridConfigManager(options);

        if (this.options.enableClaude) {
            this.claudeManager = new ClaudeOpenLinkManager();
        }

        this.clients = new Map();
        this.sessions = new Map();
        this.isRunning = false;

        this.setupExpress();
    }

    setupExpress() {
        // Middleware
        this.app.use(cors({
            origin: '*',
            credentials: true
        }));
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ extended: true }));

        // Request logging
        this.app.use((req, res, next) => {
            console.log(`📡 ${new Date().toISOString()} ${req.method} ${req.path} - ${req.ip}`);
            next();
        });

        this.setupAPIRoutes();
        this.setupClaudeRoutes();
        this.setupTestRoutes();
    }

    setupAPIRoutes() {
        // Health check
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'healthy',
                timestamp: new Date().toISOString(),
                uptime: process.uptime(),
                version: '1.0.0'
            });
        });

        // System status
        this.app.get('/api/status', (req, res) => {
            res.json({
                success: true,
                status: {
                    server: this.getServerStatus(),
                    config: this.configManager.getStatus(),
                    claude: this.claudeManager ? 'enabled' : 'disabled'
                }
            });
        });

        // Domain management
        this.app.post('/api/domains/request', async (req, res) => {
            try {
                const domain = await this.configManager.requestDomain(req.body);
                res.json({ success: true, domain });
            } catch (error) {
                console.error('❌ Domain request failed:', error);
                res.status(400).json({ success: false, error: error.message });
            }
        });

        this.app.delete('/api/domains/:domainId', async (req, res) => {
            try {
                await this.configManager.releaseDomain(req.params.domainId);
                res.json({ success: true });
            } catch (error) {
                console.error('❌ Domain release failed:', error);
                res.status(400).json({ success: false, error: error.message });
            }
        });

        this.app.get('/api/domains', (req, res) => {
            const status = this.configManager.getStatus();
            res.json({ success: true, domains: status.domains });
        });

        // Client registration and management
        this.app.post('/api/client/register', async (req, res) => {
            try {
                const client = await this.registerClient(req.body);
                res.json({ success: true, client });
            } catch (error) {
                console.error('❌ Client registration failed:', error);
                res.status(400).json({ success: false, error: error.message });
            }
        });

        this.app.get('/api/clients', (req, res) => {
            const clients = Array.from(this.clients.values());
            res.json({ success: true, clients });
        });

        // Session management
        this.app.post('/api/sessions/start', async (req, res) => {
            try {
                const session = await this.startSession(req.body);
                res.json({ success: true, session });
            } catch (error) {
                console.error('❌ Session start failed:', error);
                res.status(400).json({ success: false, error: error.message });
            }
        });

        this.app.get('/api/sessions', (req, res) => {
            const sessions = Array.from(this.sessions.values());
            res.json({ success: true, sessions });
        });

        this.app.delete('/api/sessions/:sessionId', async (req, res) => {
            try {
                await this.stopSession(req.params.sessionId);
                res.json({ success: true });
            } catch (error) {
                console.error('❌ Session stop failed:', error);
                res.status(400).json({ success: false, error: error.message });
            }
        });
    }

    setupClaudeRoutes() {
        if (!this.claudeManager) return;

        // Claude-specific API routes
        this.app.post('/api/claude/initialize', async (req, res) => {
            try {
                const result = await this.claudeManager.initialize();
                res.json({ success: true, result });
            } catch (error) {
                console.error('❌ Claude initialization failed:', error);
                res.status(500).json({ success: false, error: error.message });
            }
        });

        this.app.post('/api/claude/hosting/start', async (req, res) => {
            try {
                const result = await this.claudeManager.startHosting();
                res.json({ success: true, result });
            } catch (error) {
                console.error('❌ Claude hosting start failed:', error);
                res.status(400).json({ success: false, error: error.message });
            }
        });

        this.app.post('/api/claude/hosting/stop', async (req, res) => {
            try {
                const result = await this.claudeManager.stopHosting();
                res.json({ success: true, result });
            } catch (error) {
                console.error('❌ Claude hosting stop failed:', error);
                res.status(400).json({ success: false, error: error.message });
            }
        });

        this.app.get('/api/claude/status', async (req, res) => {
            try {
                const status = await this.claudeManager.getStatus();
                res.json({ success: true, status });
            } catch (error) {
                console.error('❌ Claude status check failed:', error);
                res.status(500).json({ success: false, error: error.message });
            }
        });

        this.app.post('/api/claude/permissions/test', async (req, res) => {
            try {
                const permissions = await this.claudeManager.testPermissions();
                res.json({ success: true, permissions });
            } catch (error) {
                console.error('❌ Claude permission test failed:', error);
                res.status(500).json({ success: false, error: error.message });
            }
        });

        this.app.post('/api/claude/connection/create', async (req, res) => {
            try {
                const connection = await this.claudeManager.createConnectionLink();
                res.json({ success: true, connection });
            } catch (error) {
                console.error('❌ Claude connection creation failed:', error);
                res.status(400).json({ success: false, error: error.message });
            }
        });
    }

    setupTestRoutes() {
        // Test routes for debugging
        this.app.post('/api/test/server-connection', async (req, res) => {
            try {
                const result = await this.configManager.testServerConnection();
                res.json({ success: true, result });
            } catch (error) {
                console.error('❌ Server connection test failed:', error);
                res.status(500).json({ success: false, error: error.message });
            }
        });

        this.app.post('/api/test/local-sudo', async (req, res) => {
            try {
                const command = req.body.command || 'whoami';
                const result = await this.configManager.executeLocalSudo(command);
                res.json({ success: true, result });
            } catch (error) {
                console.error('❌ Local sudo test failed:', error);
                res.status(500).json({ success: false, error: error.message });
            }
        });

        this.app.post('/api/test/remote-ssh', async (req, res) => {
            try {
                const command = req.body.command || 'hostname && date';
                const result = await this.configManager.executeRemoteSSH(command);
                res.json({ success: true, result });
            } catch (error) {
                console.error('❌ Remote SSH test failed:', error);
                res.status(500).json({ success: false, error: error.message });
            }
        });

        // Test domain creation
        this.app.post('/api/test/domain', async (req, res) => {
            try {
                const testDomain = {
                    clientId: 'test-client',
                    subdomain: req.body.subdomain || 'test-' + Date.now(),
                    baseDomain: req.body.baseDomain || 'openlink.local',
                    targetHost: req.body.targetHost || 'localhost',
                    targetPort: req.body.targetPort || 8000,
                    sslEnabled: false
                };

                const domain = await this.configManager.requestDomain(testDomain);
                res.json({ success: true, domain });
            } catch (error) {
                console.error('❌ Test domain creation failed:', error);
                res.status(400).json({ success: false, error: error.message });
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
            localIP: clientData.localIP || this.configManager.getLocalIP(),
            publicIP: clientData.publicIP,
            registeredAt: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            capabilities: clientData.capabilities || {
                hosting: true,
                connecting: true,
                fileTransfer: true,
                audioVideo: true
            },
            domains: [],
            sessions: []
        };

        this.clients.set(clientId, client);

        // Save to persistent storage
        await this.saveClientInfo(client);

        console.log(`📱 Client registered: ${clientId} (${client.name})`);
        return client;
    }

    async startSession(sessionData) {
        const sessionId = crypto.randomBytes(16).toString('hex');

        const session = {
            id: sessionId,
            clientId: sessionData.clientId,
            type: sessionData.type || 'hosting', // hosting, connecting
            startedAt: new Date().toISOString(),
            status: 'starting',
            config: sessionData.config || {},
            connections: [],
            domains: []
        };

        // If hosting session, might need to allocate domain
        if (session.type === 'hosting' && sessionData.requestDomain) {
            try {
                const domainRequest = {
                    clientId: session.clientId,
                    ...sessionData.domainConfig
                };

                const domain = await this.configManager.requestDomain(domainRequest);
                session.domains.push(domain.id);
                session.config.domain = domain;
            } catch (error) {
                session.status = 'failed';
                session.error = error.message;
                throw error;
            }
        }

        session.status = 'active';
        this.sessions.set(sessionId, session);

        // Update client with session
        const client = this.clients.get(session.clientId);
        if (client) {
            client.sessions.push(sessionId);
            client.lastSeen = new Date().toISOString();
        }

        console.log(`🎯 Session started: ${sessionId} (${session.type})`);
        return session;
    }

    async stopSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error('Session not found');
        }

        try {
            // Release any domains associated with this session
            for (const domainId of session.domains) {
                await this.configManager.releaseDomain(domainId);
            }

            session.status = 'stopped';
            session.stoppedAt = new Date().toISOString();

            this.sessions.delete(sessionId);

            // Update client
            const client = this.clients.get(session.clientId);
            if (client) {
                client.sessions = client.sessions.filter(id => id !== sessionId);
                client.lastSeen = new Date().toISOString();
            }

            console.log(`🛑 Session stopped: ${sessionId}`);

        } catch (error) {
            console.error(`❌ Error stopping session ${sessionId}:`, error);
            throw error;
        }
    }

    async saveClientInfo(client) {
        try {
            const clientsFile = path.join(os.homedir(), '.openlink', 'clients.json');
            const clientsDir = path.dirname(clientsFile);

            if (!fs.existsSync(clientsDir)) {
                fs.mkdirSync(clientsDir, { recursive: true });
            }

            let clients = {};
            if (fs.existsSync(clientsFile)) {
                clients = JSON.parse(fs.readFileSync(clientsFile, 'utf8'));
            }

            clients[client.id] = client;
            fs.writeFileSync(clientsFile, JSON.stringify(clients, null, 2));

        } catch (error) {
            console.warn('⚠️  Could not save client info:', error.message);
        }
    }

    setupWebSocket() {
        this.wss = new WebSocket.Server({
            server: this.server,
            path: '/ws'
        });

        this.wss.on('connection', (ws, req) => {
            const connectionId = crypto.randomBytes(8).toString('hex');
            console.log(`🔌 WebSocket connected: ${connectionId}`);

            ws.on('message', async (message) => {
                try {
                    const data = JSON.parse(message);
                    const response = await this.handleWebSocketMessage(data, connectionId);
                    ws.send(JSON.stringify(response));
                } catch (error) {
                    console.error(`❌ WebSocket message error: ${error.message}`);
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: error.message,
                        timestamp: Date.now()
                    }));
                }
            });

            ws.on('close', () => {
                console.log(`🔌 WebSocket disconnected: ${connectionId}`);
            });

            ws.on('error', (error) => {
                console.error(`🔌 WebSocket error (${connectionId}):`, error);
            });

            // Send welcome message
            ws.send(JSON.stringify({
                type: 'connected',
                connectionId,
                timestamp: Date.now(),
                serverInfo: {
                    version: '1.0.0',
                    features: ['domains', 'sessions', 'claude']
                }
            }));
        });

        console.log(`📡 WebSocket server available at ws://localhost:${this.options.port}/ws`);
    }

    async handleWebSocketMessage(data, connectionId) {
        const { type, payload, requestId } = data;

        const response = {
            type: `${type}_response`,
            requestId,
            timestamp: Date.now()
        };

        try {
            switch (type) {
                case 'domain_request':
                    response.data = await this.configManager.requestDomain(payload);
                    break;

                case 'domain_release':
                    await this.configManager.releaseDomain(payload.domainId);
                    response.data = { success: true };
                    break;

                case 'session_start':
                    response.data = await this.startSession(payload);
                    break;

                case 'session_stop':
                    await this.stopSession(payload.sessionId);
                    response.data = { success: true };
                    break;

                case 'client_register':
                    response.data = await this.registerClient(payload);
                    break;

                case 'status':
                    response.data = {
                        server: this.getServerStatus(),
                        config: this.configManager.getStatus()
                    };
                    break;

                case 'ping':
                    response.data = { pong: true };
                    break;

                default:
                    throw new Error(`Unknown message type: ${type}`);
            }

            response.success = true;

        } catch (error) {
            response.success = false;
            response.error = error.message;
        }

        return response;
    }

    getServerStatus() {
        return {
            running: this.isRunning,
            port: this.options.port,
            clients: this.clients.size,
            sessions: this.sessions.size,
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            platform: process.platform,
            hostname: os.hostname(),
            timestamp: new Date().toISOString()
        };
    }

    async startServer() {
        try {
            // Initialize Claude manager if enabled
            if (this.claudeManager) {
                await this.claudeManager.initialize();
                console.log('✅ Claude manager initialized');
            }

            // Create HTTP server
            this.server = http.createServer(this.app);

            // Setup WebSocket
            this.setupWebSocket();

            // Start listening
            await new Promise((resolve, reject) => {
                this.server.listen(this.options.port, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });

            this.isRunning = true;

            console.log('🚀 OpenLink Unified API Server started');
            console.log(`📡 HTTP API: http://localhost:${this.options.port}`);
            console.log(`🔌 WebSocket: ws://localhost:${this.options.port}/ws`);
            console.log(`🌐 Health check: http://localhost:${this.options.port}/health`);

            // Test server connectivity
            const serverTest = await this.configManager.testServerConnection();
            console.log('🔗 Remote server connection:', serverTest.success ? '✅ Connected' : '❌ Failed');

            return {
                success: true,
                port: this.options.port,
                endpoints: {
                    http: `http://localhost:${this.options.port}`,
                    ws: `ws://localhost:${this.options.port}/ws`,
                    health: `http://localhost:${this.options.port}/health`
                }
            };

        } catch (error) {
            console.error('❌ Failed to start server:', error);
            throw error;
        }
    }

    async stopServer() {
        try {
            // Stop all sessions
            for (const sessionId of this.sessions.keys()) {
                await this.stopSession(sessionId).catch(console.error);
            }

            // Close WebSocket server
            if (this.wss) {
                this.wss.close();
            }

            // Close HTTP server
            if (this.server) {
                await new Promise((resolve) => {
                    this.server.close(resolve);
                });
            }

            this.isRunning = false;
            console.log('🛑 OpenLink Unified API Server stopped');

            return { success: true };

        } catch (error) {
            console.error('❌ Failed to stop server:', error);
            throw error;
        }
    }
}

module.exports = OpenLinkUnifiedAPI;