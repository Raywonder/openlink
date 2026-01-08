/**
 * OpenLink Signaling Server v2
 * Enhanced with proper API endpoints, domain management, and CLI integration
 */

const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Import managers
const HybridConfigManager = require('./api/hybrid-config-manager');
const DynamicDomainManager = require('./api/dynamic-domain-manager');

class OpenLinkSignalingServerV2 {
    constructor(options = {}) {
        this.options = {
            port: options.port || 8765,
            corsOrigins: options.corsOrigins || ['*'],
            maxConnections: options.maxConnections || 100,
            sessionTimeout: options.sessionTimeout || 3600000, // 1 hour
            enableDomains: options.enableDomains !== false,
            enableCLI: options.enableCLI !== false,
            ...options
        };

        this.app = express();
        this.server = null;
        this.wss = null;

        // Connection and session management
        this.sessions = new Map(); // sessionId -> session data
        this.connections = new Map(); // connectionId -> connection data
        this.rooms = new Map(); // roomId -> room data

        // Managers
        if (this.options.enableDomains) {
            this.configManager = new HybridConfigManager();
            this.domainManager = new DynamicDomainManager(this.configManager);
        }

        this.isRunning = false;
        this.startTime = Date.now();

        this.setupExpress();
    }

    setupExpress() {
        // Middleware
        this.app.use(cors({
            origin: this.options.corsOrigins,
            credentials: true
        }));
        this.app.use(express.json({ limit: '50mb' }));
        this.app.use(express.urlencoded({ extended: true }));

        // Request logging
        this.app.use((req, res, next) => {
            if (!req.path.includes('health')) {
                console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - ${req.ip}`);
            }
            next();
        });

        this.setupAPIRoutes();
    }

    setupAPIRoutes() {
        // Health check
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'healthy',
                version: '1.5.6',
                uptime: Date.now() - this.startTime,
                connections: this.connections.size,
                sessions: this.sessions.size,
                timestamp: new Date().toISOString()
            });
        });

        // Simple link validation (for client apps)
        this.app.get('/api/validate/:linkId', (req, res) => {
            const linkId = req.params.linkId.toLowerCase();
            const session = this.sessions.get(linkId);

            let status = 'inactive';
            let hasHost = false;
            let clientCount = 0;

            if (session) {
                hasHost = session.host ? true : false;
                clientCount = session.clients ? session.clients.size : 0;
                status = hasHost ? 'active' : 'no_host';
            }

            res.json({
                linkId,
                status,
                active: status === 'active',
                hasHost,
                clientCount,
                canRegenerate: true
            });
        });

        // Simple link regeneration (for client apps)
        this.app.post('/api/regenerate/:linkId', (req, res) => {
            const linkId = req.params.linkId.toLowerCase();

            // Create or update session
            if (!this.sessions.has(linkId)) {
                this.sessions.set(linkId, {
                    id: linkId,
                    host: null,
                    clients: new Map(),
                    created: Date.now(),
                    regenerated: true,
                    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24 hours
                });
            } else {
                const session = this.sessions.get(linkId);
                session.regenerated = true;
                session.regeneratedAt = new Date().toISOString();
            }

            res.json({
                success: true,
                linkId,
                status: 'regenerated',
                expiresAt: this.sessions.get(linkId).expiresAt
            });
        });

        // Get session status (for session pages)
        this.app.get('/api/session/:sessionId', (req, res) => {
            const sessionId = req.params.sessionId.toLowerCase();
            const session = this.sessions.get(sessionId);

            if (!session) {
                return res.json({ exists: false, id: sessionId });
            }

            res.json({
                exists: true,
                id: sessionId,
                hasHost: session.host ? true : false,
                clientCount: session.clients ? session.clients.size : 0,
                created: session.created,
                expiresAt: session.expiresAt
            });
        });

        // Client detection and reporting
        this.app.get('/api/v2/clients', (req, res) => {
            const clients = [];
            this.connections.forEach((conn, id) => {
                clients.push({
                    id: conn.id,
                    userAgent: conn.userAgent,
                    platform: conn.platform,
                    os: conn.os,
                    ip: conn.ip,
                    country: conn.country,
                    connectedAt: conn.connectedAt,
                    lastActivity: conn.lastActivity,
                    version: conn.version
                });
            });

            res.json({
                success: true,
                clients,
                total: clients.length,
                timestamp: new Date().toISOString()
            });
        });

        // Real-time client monitoring
        this.app.get('/api/v2/clients/monitor', (req, res) => {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*'
            });

            const sendUpdate = () => {
                const data = {
                    timestamp: new Date().toISOString(),
                    connections: this.connections.size,
                    sessions: this.sessions.size,
                    clients: Array.from(this.connections.values()).map(conn => ({
                        id: conn.id,
                        platform: conn.platform,
                        os: conn.os,
                        ip: conn.ip,
                        lastActivity: conn.lastActivity
                    }))
                };
                res.write(`data: ${JSON.stringify(data)}\n\n`);
            };

            // Send initial data
            sendUpdate();

            // Send updates every 5 seconds
            const interval = setInterval(sendUpdate, 5000);

            req.on('close', () => {
                clearInterval(interval);
            });
        });

        // Server status and info
        this.app.get('/api/v2/status', (req, res) => {
            res.json({
                success: true,
                status: this.getServerStatus()
            });
        });

        // Session management
        this.app.post('/api/v2/sessions/create', (req, res) => {
            try {
                const session = this.createSession(req.body);
                res.json({ success: true, session });
            } catch (error) {
                res.status(400).json({ success: false, error: error.message });
            }
        });

        this.app.get('/api/v2/sessions/:sessionId', (req, res) => {
            const session = this.sessions.get(req.params.sessionId);
            if (session) {
                res.json({ success: true, session });
            } else {
                res.status(404).json({ success: false, error: 'Session not found' });
            }
        });

        this.app.delete('/api/v2/sessions/:sessionId', (req, res) => {
            try {
                this.destroySession(req.params.sessionId);
                res.json({ success: true });
            } catch (error) {
                res.status(400).json({ success: false, error: error.message });
            }
        });

        this.app.get('/api/v2/sessions', (req, res) => {
            const sessions = Array.from(this.sessions.values()).map(s => ({
                id: s.id,
                type: s.type || 'session',
                status: s.host ? 'active' : 'waiting',
                createdAt: s.created || s.createdAt,
                hasHost: s.host ? true : false,
                clientCount: s.clients ? s.clients.size : 0
            }));
            res.json({ success: true, sessions, total: sessions.length });
        });

        // Session control endpoints
        this.app.post('/api/v2/sessions/:sessionId/kick', (req, res) => {
            try {
                const { clientConnectionId, reason } = req.body;
                if (!clientConnectionId) {
                    return res.status(400).json({ success: false, error: 'clientConnectionId required' });
                }
                const result = this.kickClient(req.params.sessionId, clientConnectionId, reason);
                res.json(result);
            } catch (error) {
                res.status(400).json({ success: false, error: error.message });
            }
        });

        this.app.post('/api/v2/sessions/:sessionId/password', (req, res) => {
            try {
                const { password, notifyClients } = req.body;
                const result = this.changeSessionPassword(
                    req.params.sessionId,
                    password || null,
                    notifyClients !== false
                );
                res.json(result);
            } catch (error) {
                res.status(400).json({ success: false, error: error.message });
            }
        });

        this.app.post('/api/v2/sessions/:sessionId/regenerate-link', (req, res) => {
            try {
                const result = this.regenerateSessionLink(req.params.sessionId);
                res.json(result);
            } catch (error) {
                res.status(400).json({ success: false, error: error.message });
            }
        });

        this.app.get('/api/v2/sessions/:sessionId/clients', (req, res) => {
            try {
                const clients = this.getSessionClients(req.params.sessionId);
                res.json({
                    success: true,
                    sessionId: req.params.sessionId,
                    clients,
                    count: clients.length
                });
            } catch (error) {
                res.status(404).json({ success: false, error: error.message });
            }
        });

        // Monitor Hub endpoints (for distributed deployments)
        this.monitorInstances = new Map();
        this.monitorAlerts = [];

        this.app.post('/api/v2/monitor/report', (req, res) => {
            try {
                const { instanceId, status, eventType } = req.body;
                if (!instanceId) {
                    return res.status(400).json({ success: false, error: 'instanceId required' });
                }

                const instance = {
                    ...status,
                    instanceId,
                    lastSeen: new Date().toISOString(),
                    ip: req.ip || req.connection?.remoteAddress
                };

                this.monitorInstances.set(instanceId, instance);

                // Generate alerts for certain events
                if (eventType === 'error' || eventType === 'shutdown') {
                    this.monitorAlerts.push({
                        id: `alert_${Date.now()}`,
                        instanceId,
                        eventType,
                        message: status.message || `Instance ${eventType}`,
                        timestamp: new Date().toISOString()
                    });
                    // Keep only last 100 alerts
                    if (this.monitorAlerts.length > 100) {
                        this.monitorAlerts = this.monitorAlerts.slice(-100);
                    }
                }

                // Cleanup stale instances (not seen in 5 minutes)
                const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
                for (const [id, inst] of this.monitorInstances) {
                    if (new Date(inst.lastSeen).getTime() < fiveMinutesAgo) {
                        this.monitorInstances.delete(id);
                    }
                }

                res.json({ success: true, instanceId, registered: true });
            } catch (error) {
                res.status(500).json({ success: false, error: error.message });
            }
        });

        this.app.get('/api/v2/monitor/instances', (req, res) => {
            const instances = Array.from(this.monitorInstances.values());
            res.json({
                success: true,
                instances,
                total: instances.length,
                online: instances.filter(i => i.online).length
            });
        });

        this.app.get('/api/v2/monitor/alerts', (req, res) => {
            const limit = parseInt(req.query.limit) || 50;
            const alerts = this.monitorAlerts.slice(-limit);
            res.json({ success: true, alerts, total: this.monitorAlerts.length });
        });

        this.app.delete('/api/v2/monitor/instances/:instanceId', (req, res) => {
            const deleted = this.monitorInstances.delete(req.params.instanceId);
            res.json({ success: true, deleted });
        });

        // Connection endpoints
        this.app.get('/api/v2/connections', (req, res) => {
            const connections = Array.from(this.connections.values()).map(c => ({
                id: c.id,
                sessionId: c.sessionId,
                type: c.type,
                status: c.status,
                connectedAt: c.connectedAt
            }));
            res.json({ success: true, connections });
        });

        // Domain management (if enabled)
        if (this.domainManager) {
            this.app.post('/api/v2/domains/request', async (req, res) => {
                try {
                    const domain = await this.domainManager.requestDomain(req.body);
                    res.json({ success: true, domain });
                } catch (error) {
                    res.status(400).json({ success: false, error: error.message });
                }
            });

            this.app.get('/api/v2/domains', (req, res) => {
                const status = this.domainManager.getStatus();
                res.json({ success: true, domains: status.domains });
            });

            this.app.delete('/api/v2/domains/:domainId', async (req, res) => {
                try {
                    await this.domainManager.configManager.releaseDomain(req.params.domainId);
                    res.json({ success: true });
                } catch (error) {
                    res.status(400).json({ success: false, error: error.message });
                }
            });

            this.app.post('/api/v2/domains/permits', async (req, res) => {
                try {
                    const permit = await this.domainManager.createPermit(req.body);
                    res.json({ success: true, permit });
                } catch (error) {
                    res.status(400).json({ success: false, error: error.message });
                }
            });

            this.app.post('/api/v2/domains/:domainId/temp-urls', async (req, res) => {
                try {
                    const tempUrl = await this.domainManager.createTemporaryUrl(req.params.domainId, req.body);
                    res.json({ success: true, tempUrl });
                } catch (error) {
                    res.status(400).json({ success: false, error: error.message });
                }
            });
        }

        // WebRTC signaling endpoints
        this.app.post('/api/v2/signaling/offer', (req, res) => {
            try {
                this.handleSignalingOffer(req.body);
                res.json({ success: true });
            } catch (error) {
                res.status(400).json({ success: false, error: error.message });
            }
        });

        this.app.post('/api/v2/signaling/answer', (req, res) => {
            try {
                this.handleSignalingAnswer(req.body);
                res.json({ success: true });
            } catch (error) {
                res.status(400).json({ success: false, error: error.message });
            }
        });

        this.app.post('/api/v2/signaling/ice-candidate', (req, res) => {
            try {
                this.handleICECandidate(req.body);
                res.json({ success: true });
            } catch (error) {
                res.status(400).json({ success: false, error: error.message });
            }
        });

        // CLI endpoints (if enabled)
        if (this.options.enableCLI) {
            this.app.post('/api/v2/cli/execute', async (req, res) => {
                try {
                    const result = await this.executeCLICommand(req.body);
                    res.json({ success: true, result });
                } catch (error) {
                    res.status(400).json({ success: false, error: error.message });
                }
            });

            this.app.get('/api/v2/cli/status', (req, res) => {
                res.json({
                    success: true,
                    cli: {
                        enabled: true,
                        version: '1.4.0',
                        availableCommands: [
                            'status', 'host', 'stop-host', 'connect',
                            'domain-request', 'domain-list', 'emergency-kill'
                        ]
                    }
                });
            });
        }

        // Static file serving for the web interface
        this.app.use('/app', express.static(path.join(__dirname, 'ui')));

        // Default route
        this.app.get('/', (req, res) => {
            res.json({
                name: 'OpenLink Signaling Server',
                version: '1.4.0',
                status: 'running',
                endpoints: {
                    health: '/health',
                    status: '/api/v2/status',
                    websocket: '/ws',
                    api: '/api/v2/',
                    app: '/app/'
                },
                documentation: 'https://github.com/openlink/docs'
            });
        });
    }

    createSession(sessionData) {
        const sessionId = crypto.randomBytes(16).toString('hex');

        const session = {
            id: sessionId,
            type: sessionData.type || 'hosting', // hosting, connecting
            hostId: sessionData.hostId || sessionId,
            status: 'waiting',
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + this.options.sessionTimeout).toISOString(),
            connections: [],
            settings: {
                password: sessionData.password || null,
                maxConnections: sessionData.maxConnections || 5,
                allowInput: sessionData.allowInput !== false,
                allowAudio: sessionData.allowAudio !== false,
                allowVideo: sessionData.allowVideo !== false,
                allowFileTransfer: sessionData.allowFileTransfer !== false
            },
            metadata: sessionData.metadata || {},
            stats: {
                totalConnections: 0,
                bytesTransferred: 0,
                lastActivity: new Date().toISOString()
            }
        };

        this.sessions.set(sessionId, session);

        console.log(`[Sessions] Created session: ${sessionId} (${session.type})`);
        return session;
    }

    destroySession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error('Session not found');
        }

        // Disconnect all connections in this session
        session.connections.forEach(connectionId => {
            const connection = this.connections.get(connectionId);
            if (connection && connection.ws) {
                connection.ws.close();
            }
            this.connections.delete(connectionId);
        });

        this.sessions.delete(sessionId);
        console.log(`[Sessions] Destroyed session: ${sessionId}`);
    }

    /**
     * Kick a specific client from a session
     * @param {string} sessionId - The session ID
     * @param {string} clientConnectionId - The connection ID to kick
     * @param {string} reason - Reason for kicking
     * @returns {object} Result with success status
     */
    kickClient(sessionId, clientConnectionId, reason = 'Kicked by host') {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error('Session not found');
        }

        // Check if client exists in session
        if (!session.clients || !session.clients.has(clientConnectionId)) {
            throw new Error('Client not found in session');
        }

        const clientConnection = this.connections.get(clientConnectionId);
        const clientInfo = session.clients.get(clientConnectionId);

        // Notify the client they're being kicked
        if (clientConnection && clientConnection.ws && clientConnection.ws.readyState === WebSocket.OPEN) {
            clientConnection.ws.send(JSON.stringify({
                type: 'kicked',
                reason,
                sessionId,
                timestamp: Date.now()
            }));

            // Close connection after brief delay
            setTimeout(() => {
                if (clientConnection.ws.readyState === WebSocket.OPEN) {
                    clientConnection.ws.close(4001, reason);
                }
            }, 500);
        }

        // Remove from session
        session.clients.delete(clientConnectionId);
        this.connections.delete(clientConnectionId);

        // Notify host
        if (session.host) {
            const hostConnection = this.connections.get(session.host);
            if (hostConnection && hostConnection.ws && hostConnection.ws.readyState === WebSocket.OPEN) {
                hostConnection.ws.send(JSON.stringify({
                    type: 'client_kicked',
                    clientConnectionId,
                    reason,
                    clientCount: session.clients.size,
                    timestamp: Date.now()
                }));
            }
        }

        // Broadcast to remaining clients
        this.broadcastToSession(sessionId, {
            type: 'peer_left',
            peerId: clientConnectionId,
            reason: 'kicked'
        }, clientConnectionId);

        console.log(`[Sessions] Kicked ${clientConnectionId} from ${sessionId}: ${reason}`);
        return { success: true, clientConnectionId, reason, remainingClients: session.clients.size };
    }

    /**
     * Change session password mid-session
     * @param {string} sessionId - The session ID
     * @param {string} newPassword - New password (null to remove)
     * @param {boolean} notifyClients - Whether to notify connected clients
     * @returns {object} Result with success status
     */
    changeSessionPassword(sessionId, newPassword, notifyClients = true) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error('Session not found');
        }

        const hadPassword = !!session.password;
        session.password = newPassword || null;
        session.passwordChangedAt = new Date().toISOString();

        // Notify all connected clients about password change
        if (notifyClients && session.clients) {
            session.clients.forEach((clientInfo, clientId) => {
                const clientConnection = this.connections.get(clientId);
                if (clientConnection && clientConnection.ws && clientConnection.ws.readyState === WebSocket.OPEN) {
                    clientConnection.ws.send(JSON.stringify({
                        type: 'password_changed',
                        sessionId,
                        passwordRequired: !!newPassword,
                        timestamp: Date.now()
                    }));
                }
            });
        }

        // Notify host
        if (session.host) {
            const hostConnection = this.connections.get(session.host);
            if (hostConnection && hostConnection.ws && hostConnection.ws.readyState === WebSocket.OPEN) {
                hostConnection.ws.send(JSON.stringify({
                    type: 'password_change_confirmed',
                    sessionId,
                    passwordRequired: !!newPassword,
                    timestamp: Date.now()
                }));
            }
        }

        console.log(`[Sessions] Password ${newPassword ? 'changed' : 'removed'} for ${sessionId}`);
        return { success: true, sessionId, passwordRequired: !!newPassword };
    }

    /**
     * Regenerate session link (creates new session ID, migrates connections)
     * @param {string} oldSessionId - The current session ID
     * @returns {object} Result with old and new session IDs
     */
    regenerateSessionLink(oldSessionId) {
        const session = this.sessions.get(oldSessionId);
        if (!session) {
            throw new Error('Session not found');
        }

        // Generate new session ID
        const newSessionId = this.generateLinkId();

        // Clone session with new ID
        const newSession = {
            ...session,
            id: newSessionId,
            regeneratedFrom: oldSessionId,
            regeneratedAt: new Date().toISOString()
        };

        // Store with new ID
        this.sessions.set(newSessionId, newSession);

        // Update host connection
        if (session.host) {
            const hostConnection = this.connections.get(session.host);
            if (hostConnection) {
                hostConnection.sessionId = newSessionId;
                if (hostConnection.ws && hostConnection.ws.readyState === WebSocket.OPEN) {
                    hostConnection.ws.send(JSON.stringify({
                        type: 'session_regenerated',
                        oldSessionId,
                        newSessionId,
                        timestamp: Date.now()
                    }));
                }
            }
        }

        // Notify clients and update their session reference
        if (session.clients) {
            session.clients.forEach((clientInfo, clientId) => {
                const clientConnection = this.connections.get(clientId);
                if (clientConnection) {
                    clientConnection.sessionId = newSessionId;
                    if (clientConnection.ws && clientConnection.ws.readyState === WebSocket.OPEN) {
                        clientConnection.ws.send(JSON.stringify({
                            type: 'session_link_changed',
                            oldSessionId,
                            newSessionId,
                            timestamp: Date.now()
                        }));
                    }
                }
            });
        }

        // Remove old session
        this.sessions.delete(oldSessionId);

        console.log(`[Sessions] Regenerated ${oldSessionId} -> ${newSessionId}`);
        return { success: true, oldSessionId, newSessionId };
    }

    /**
     * Get connected clients for a session
     * @param {string} sessionId - The session ID
     * @returns {array} List of connected clients
     */
    getSessionClients(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error('Session not found');
        }

        const clients = [];
        if (session.clients) {
            session.clients.forEach((info, id) => {
                const conn = this.connections.get(id);
                clients.push({
                    connectionId: id,
                    joinedAt: info.joinedAt || info.connectedAt,
                    clientInfo: info.clientInfo || {},
                    platform: conn?.platform || 'unknown',
                    os: conn?.os || 'unknown',
                    ip: conn?.ip || 'unknown',
                    lastActivity: conn?.lastActivity
                });
            });
        }

        return clients;
    }

    /**
     * Broadcast message to all clients in a session
     * @param {string} sessionId - The session ID
     * @param {object} message - Message to broadcast
     * @param {string} excludeConnectionId - Connection to exclude
     */
    broadcastToSession(sessionId, message, excludeConnectionId = null) {
        const session = this.sessions.get(sessionId);
        if (!session || !session.clients) return;

        session.clients.forEach((info, clientId) => {
            if (clientId === excludeConnectionId) return;
            const conn = this.connections.get(clientId);
            if (conn && conn.ws && conn.ws.readyState === WebSocket.OPEN) {
                conn.ws.send(JSON.stringify(message));
            }
        });
    }

    async start() {
        try {
            this.server = http.createServer(this.app);

            // Setup WebSocket server
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

            console.log(`[Signaling] OpenLink Signaling Server v2 started`);
            console.log(`[Signaling] HTTP API: http://localhost:${this.options.port}`);
            console.log(`[Signaling] WebSocket: ws://localhost:${this.options.port}/ws`);
            console.log(`[Signaling] Health check: http://localhost:${this.options.port}/health`);

            // Start cleanup timer
            this.startCleanupTimer();

            return {
                success: true,
                port: this.options.port,
                endpoints: {
                    http: `http://localhost:${this.options.port}`,
                    ws: `ws://localhost:${this.options.port}/ws`,
                    api: `http://localhost:${this.options.port}/api/v2/`
                }
            };

        } catch (error) {
            console.error('[Signaling] Failed to start server:', error);
            throw error;
        }
    }

    setupWebSocketHandlers() {
        this.wss.on('connection', (ws, req) => {
            const connectionId = crypto.randomBytes(16).toString('hex');

            // Extract client information
            const userAgent = req.headers['user-agent'] || 'Unknown';
            const clientIP = req.headers['x-forwarded-for'] ||
                            req.headers['x-real-ip'] ||
                            req.socket.remoteAddress ||
                            'Unknown';

            // Detect OS and platform from User-Agent
            const osInfo = this.detectOSFromUserAgent(userAgent);

            console.log(`[WebSocket] New connection: ${connectionId} from ${clientIP} (${osInfo.platform})`);

            const connection = {
                id: connectionId,
                ws: ws,
                sessionId: null,
                type: 'unknown',
                status: 'connected',
                connectedAt: new Date().toISOString(),
                lastActivity: new Date().toISOString(),
                lastPing: Date.now(),

                // Client information
                ip: clientIP,
                userAgent: userAgent,
                platform: osInfo.platform,
                os: osInfo.os,
                architecture: osInfo.architecture,
                version: null, // Will be updated when client identifies itself
                country: null, // Could be populated with GeoIP lookup

                remoteAddress: req.socket.remoteAddress
            };

            this.connections.set(connectionId, connection);

            ws.on('message', async (message) => {
                try {
                    const data = JSON.parse(message);
                    await this.handleWebSocketMessage(connectionId, data);
                } catch (error) {
                    console.error(`[WebSocket] Message error: ${error.message}`);
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: error.message
                    }));
                }
            });

            ws.on('close', () => {
                console.log(`[WebSocket] Connection closed: ${connectionId}`);
                this.cleanupConnection(connectionId);
            });

            ws.on('error', (error) => {
                console.error(`[WebSocket] Connection error: ${connectionId}`, error);
                this.cleanupConnection(connectionId);
            });

            // Send welcome message with client detection request
            ws.send(JSON.stringify({
                type: 'connected',
                connectionId,
                version: '1.4.5',
                timestamp: Date.now(),
                detected: {
                    platform: osInfo.platform,
                    os: osInfo.os,
                    ip: clientIP
                },
                requestClientInfo: true // Ask client to send detailed info
            }));
        });
    }

    // Detect OS information from User-Agent string
    detectOSFromUserAgent(userAgent) {
        const ua = userAgent.toLowerCase();

        let platform = 'Unknown';
        let os = 'Unknown';
        let architecture = 'Unknown';

        // Platform detection
        if (ua.includes('win') || ua.includes('windows')) {
            platform = 'Windows';
            if (ua.includes('win64') || ua.includes('wow64') || ua.includes('x64')) {
                architecture = 'x64';
            } else if (ua.includes('win32')) {
                architecture = 'x86';
            }

            // Windows version detection
            if (ua.includes('windows nt 10.0')) os = 'Windows 10/11';
            else if (ua.includes('windows nt 6.3')) os = 'Windows 8.1';
            else if (ua.includes('windows nt 6.2')) os = 'Windows 8';
            else if (ua.includes('windows nt 6.1')) os = 'Windows 7';
            else os = 'Windows';

        } else if (ua.includes('mac') || ua.includes('darwin')) {
            platform = 'macOS';

            if (ua.includes('intel')) architecture = 'Intel';
            else if (ua.includes('ppc')) architecture = 'PowerPC';
            else if (ua.includes('arm')) architecture = 'Apple Silicon';
            else architecture = 'Intel'; // Default assumption

            // macOS version detection
            const macVersion = ua.match(/mac os x (\d+)_(\d+)/);
            if (macVersion) {
                const major = parseInt(macVersion[1]);
                const minor = parseInt(macVersion[2]);
                if (major >= 11) os = `macOS ${major}.${minor}`;
                else if (major === 10) os = `macOS 10.${minor}`;
                else os = 'macOS';
            } else {
                os = 'macOS';
            }

        } else if (ua.includes('linux')) {
            platform = 'Linux';

            if (ua.includes('x86_64') || ua.includes('amd64')) architecture = 'x64';
            else if (ua.includes('i386') || ua.includes('i686')) architecture = 'x86';
            else if (ua.includes('arm')) architecture = 'ARM';

            // Linux distro detection
            if (ua.includes('ubuntu')) os = 'Ubuntu';
            else if (ua.includes('debian')) os = 'Debian';
            else if (ua.includes('fedora')) os = 'Fedora';
            else if (ua.includes('centos')) os = 'CentOS';
            else if (ua.includes('red hat')) os = 'Red Hat';
            else os = 'Linux';

        } else if (ua.includes('electron')) {
            platform = 'Electron';
            os = 'Electron App';
        }

        return { platform, os, architecture };
    }

    async handleWebSocketMessage(connectionId, data) {
        const connection = this.connections.get(connectionId);
        if (!connection) return;

        const { type, payload, sessionId } = data;

        switch (type) {
            case 'join-session':
                await this.handleJoinSession(connectionId, payload);
                break;

            case 'leave-session':
                await this.handleLeaveSession(connectionId);
                break;

            case 'offer':
                await this.handleSignalingOffer({ ...payload, connectionId });
                break;

            case 'answer':
                await this.handleSignalingAnswer({ ...payload, connectionId });
                break;

            case 'ice-candidate':
                await this.handleICECandidate({ ...payload, connectionId });
                break;

            case 'ping':
                connection.lastPing = Date.now();
                connection.lastActivity = new Date().toISOString();
                connection.ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
                break;

            case 'client-info':
                this.handleClientInfo(connectionId, payload);
                break;

            // Session creation via WebSocket
            case 'create_session':
            case 'create-session':
                await this.handleCreateSession(connectionId, data);
                break;

            case 'host_session':
            case 'host-session':
                await this.handleHostSession(connectionId, data);
                break;

            case 'join':
                await this.handleJoinByLinkId(connectionId, data);
                break;

            // Remote host setup for flip session
            case 'remote-host-setup':
                await this.handleRemoteHostSetup(connectionId, data);
                break;

            case 'remote-host-ready':
                await this.handleRemoteHostReady(connectionId, data);
                break;

            case 'remote-host-declined':
                await this.handleRemoteHostDeclined(connectionId, data);
                break;

            // Wallet-based quick connect
            case 'register-wallet':
                await this.handleRegisterWallet(connectionId, data);
                break;

            case 'wallet-connect':
                await this.handleWalletConnect(connectionId, data);
                break;

            // Session control messages (host only)
            case 'kick-client':
                await this.handleKickClientMessage(connectionId, data);
                break;

            case 'change-password':
                await this.handleChangePasswordMessage(connectionId, data);
                break;

            case 'regenerate-link':
                await this.handleRegenerateLinkMessage(connectionId, data);
                break;

            case 'get-clients':
                await this.handleGetClientsMessage(connectionId, data);
                break;

            default:
                console.warn(`[WebSocket] Unknown message type: ${type} from ${connectionId}`);
                // Don't throw error, just ignore unknown messages
        }
    }

    // Session control WebSocket handlers
    async handleKickClientMessage(connectionId, data) {
        const connection = this.connections.get(connectionId);
        if (!connection || connection.type !== 'host') {
            connection?.ws?.send(JSON.stringify({
                type: 'error',
                error: 'Only hosts can kick clients',
                requestType: 'kick-client'
            }));
            return;
        }

        try {
            const { clientConnectionId, reason } = data;
            const result = this.kickClient(connection.sessionId, clientConnectionId, reason);
            connection.ws.send(JSON.stringify({
                type: 'kick-result',
                ...result
            }));
        } catch (error) {
            connection.ws.send(JSON.stringify({
                type: 'kick-result',
                success: false,
                error: error.message
            }));
        }
    }

    async handleChangePasswordMessage(connectionId, data) {
        const connection = this.connections.get(connectionId);
        if (!connection || connection.type !== 'host') {
            connection?.ws?.send(JSON.stringify({
                type: 'error',
                error: 'Only hosts can change password',
                requestType: 'change-password'
            }));
            return;
        }

        try {
            const { password, notifyClients } = data;
            const result = this.changeSessionPassword(connection.sessionId, password, notifyClients);
            connection.ws.send(JSON.stringify({
                type: 'password-change-result',
                ...result
            }));
        } catch (error) {
            connection.ws.send(JSON.stringify({
                type: 'password-change-result',
                success: false,
                error: error.message
            }));
        }
    }

    async handleRegenerateLinkMessage(connectionId, data) {
        const connection = this.connections.get(connectionId);
        if (!connection || connection.type !== 'host') {
            connection?.ws?.send(JSON.stringify({
                type: 'error',
                error: 'Only hosts can regenerate link',
                requestType: 'regenerate-link'
            }));
            return;
        }

        try {
            const result = this.regenerateSessionLink(connection.sessionId);
            connection.ws.send(JSON.stringify({
                type: 'regenerate-link-result',
                ...result
            }));
        } catch (error) {
            connection.ws.send(JSON.stringify({
                type: 'regenerate-link-result',
                success: false,
                error: error.message
            }));
        }
    }

    async handleGetClientsMessage(connectionId, data) {
        const connection = this.connections.get(connectionId);
        if (!connection || connection.type !== 'host') {
            connection?.ws?.send(JSON.stringify({
                type: 'error',
                error: 'Only hosts can get clients list',
                requestType: 'get-clients'
            }));
            return;
        }

        try {
            const clients = this.getSessionClients(connection.sessionId);
            connection.ws.send(JSON.stringify({
                type: 'clients-list',
                sessionId: connection.sessionId,
                clients,
                count: clients.length
            }));
        } catch (error) {
            connection.ws.send(JSON.stringify({
                type: 'clients-list',
                success: false,
                error: error.message
            }));
        }
    }

    // Handle session creation via WebSocket
    async handleCreateSession(connectionId, data) {
        const connection = this.connections.get(connectionId);
        if (!connection) return;

        const { linkId, sessionId, password, hostInfo, settings } = data;
        const id = linkId || sessionId || this.generateLinkId();

        console.log(`[Sessions] Creating session ${id} for connection ${connectionId}`);

        // Create or update session
        const session = {
            id: id,
            host: connectionId,
            hostInfo: hostInfo || {},
            clients: new Map(),
            password: password || null,
            settings: settings || {},
            created: Date.now(),
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        };

        this.sessions.set(id, session);

        // Update connection with session info
        connection.sessionId = id;
        connection.type = 'host';
        connection.machineId = hostInfo?.machineId || connection.machineId;
        connection.machineName = hostInfo?.machineName || connection.machineName;

        // Send confirmation
        connection.ws.send(JSON.stringify({
            type: 'session_created',
            sessionId: id,
            linkId: id,
            expiresAt: session.expiresAt,
            timestamp: Date.now()
        }));

        console.log(`[Sessions] Session ${id} created and hosted by ${connectionId}`);
    }

    // Handle host session request (when hosting starts)
    async handleHostSession(connectionId, data) {
        const connection = this.connections.get(connectionId);
        if (!connection) return;

        const { linkId, sessionId, password, hostInfo } = data;
        const id = linkId || sessionId;

        if (!id) {
            connection.ws.send(JSON.stringify({
                type: 'error',
                message: 'Session ID required'
            }));
            return;
        }

        console.log(`[Sessions] Host session ${id} from ${connectionId}`);

        // Get or create session
        let session = this.sessions.get(id);
        if (!session) {
            session = {
                id: id,
                host: connectionId,
                hostInfo: hostInfo || {},
                clients: new Map(),
                password: password || null,
                created: Date.now(),
                createdAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
            };
            this.sessions.set(id, session);
        } else {
            // Update existing session with new host
            session.host = connectionId;
            session.hostInfo = hostInfo || session.hostInfo;
        }

        connection.sessionId = id;
        connection.type = 'host';

        connection.ws.send(JSON.stringify({
            type: 'host_session_ok',
            sessionId: id,
            linkId: id,
            timestamp: Date.now()
        }));
    }

    // Handle join by link ID
    async handleJoinByLinkId(connectionId, data) {
        const connection = this.connections.get(connectionId);
        if (!connection) return;

        const { linkId, sessionId, password, clientInfo } = data;
        const id = linkId || sessionId;

        if (!id) {
            connection.ws.send(JSON.stringify({
                type: 'join_error',
                error: 'Link ID required'
            }));
            return;
        }

        console.log(`[Sessions] Join request for ${id} from ${connectionId}`);

        const session = this.sessions.get(id);
        if (!session) {
            connection.ws.send(JSON.stringify({
                type: 'join_error',
                error: 'Session not found',
                linkId: id
            }));
            return;
        }

        // Check password if required
        if (session.password && session.password !== password) {
            connection.ws.send(JSON.stringify({
                type: 'join_error',
                error: 'Invalid password',
                linkId: id
            }));
            return;
        }

        // Check if host is connected
        if (!session.host) {
            connection.ws.send(JSON.stringify({
                type: 'join_error',
                error: 'Host not available',
                linkId: id
            }));
            return;
        }

        // Add client to session
        session.clients.set(connectionId, {
            connectionId,
            clientInfo: clientInfo || {},
            joinedAt: Date.now()
        });

        connection.sessionId = id;
        connection.type = 'client';

        // Notify the client they've joined
        connection.ws.send(JSON.stringify({
            type: 'joined',
            sessionId: id,
            linkId: id,
            hostConnectionId: session.host,
            hostInfo: session.hostInfo
        }));

        // Notify the host about new client
        const hostConnection = this.connections.get(session.host);
        if (hostConnection && hostConnection.ws) {
            hostConnection.ws.send(JSON.stringify({
                type: 'client_joined',
                clientConnectionId: connectionId,
                clientInfo: clientInfo || {},
                clientCount: session.clients.size
            }));
        }

        console.log(`[Sessions] Client ${connectionId} joined session ${id}`);
    }

    // Generate a random link ID (8 chars)
    generateLinkId() {
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let id = '';
        for (let i = 0; i < 8; i++) {
            id += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return id;
    }

    // Handle remote host setup request - someone wants a target machine to start hosting
    async handleRemoteHostSetup(connectionId, data) {
        const { targetMachineId, fromMachineId } = data;
        console.log(`[RemoteHost] Setup request from ${fromMachineId} to ${targetMachineId}`);

        // Find the target connection by machineId
        const targetConnection = this.findConnectionByMachineId(targetMachineId);

        if (!targetConnection) {
            const connection = this.connections.get(connectionId);
            if (connection && connection.ws) {
                connection.ws.send(JSON.stringify({
                    type: 'remote-host-error',
                    error: 'Target machine not found or offline'
                }));
            }
            return;
        }

        // Forward the request to the target machine
        targetConnection.ws.send(JSON.stringify({
            type: 'remote-host-request',
            fromMachineId: fromMachineId,
            requestingConnectionId: connectionId
        }));
    }

    // Handle when target machine is ready to host
    async handleRemoteHostReady(connectionId, data) {
        const { targetMachineId, sessionId, password } = data;
        console.log(`[RemoteHost] Ready: ${connectionId} hosting for ${targetMachineId}`);

        // Find the requesting machine's connection
        const targetConnection = this.findConnectionByMachineId(targetMachineId);

        if (targetConnection && targetConnection.ws) {
            targetConnection.ws.send(JSON.stringify({
                type: 'remote-host-session-ready',
                sessionId: sessionId,
                password: password
            }));
        }
    }

    // Handle when target machine declines to host
    async handleRemoteHostDeclined(connectionId, data) {
        const { targetMachineId } = data;
        console.log(`[RemoteHost] Declined by ${connectionId} for ${targetMachineId}`);

        const targetConnection = this.findConnectionByMachineId(targetMachineId);

        if (targetConnection && targetConnection.ws) {
            targetConnection.ws.send(JSON.stringify({
                type: 'remote-host-declined',
                message: 'Remote machine declined to start hosting'
            }));
        }
    }

    // Register a wallet address for quick connect
    async handleRegisterWallet(connectionId, data) {
        const { walletAddress, machineId, machineName } = data;
        const connection = this.connections.get(connectionId);

        if (!connection) return;

        // Store wallet association
        connection.walletAddress = walletAddress?.toLowerCase();
        connection.machineId = machineId;
        connection.machineName = machineName;

        console.log(`[Wallet] Registered ${walletAddress} for machine ${machineId}`);

        connection.ws.send(JSON.stringify({
            type: 'wallet-registered',
            walletAddress: walletAddress
        }));
    }

    // Handle wallet-based quick connect - find other devices with same wallet
    async handleWalletConnect(connectionId, data) {
        const { walletAddress } = data;
        const connection = this.connections.get(connectionId);

        if (!connection || !walletAddress) return;

        const normalizedWallet = walletAddress.toLowerCase();

        // Find all connections with the same wallet (excluding self)
        const linkedDevices = [];
        for (const [id, conn] of this.connections.entries()) {
            if (id !== connectionId && conn.walletAddress === normalizedWallet) {
                linkedDevices.push({
                    connectionId: id,
                    machineId: conn.machineId,
                    machineName: conn.machineName || 'Unknown Device',
                    platform: conn.platform,
                    os: conn.os
                });
            }
        }

        connection.ws.send(JSON.stringify({
            type: 'wallet-devices',
            devices: linkedDevices
        }));
    }

    // Find connection by machineId
    findConnectionByMachineId(machineId) {
        for (const [id, conn] of this.connections.entries()) {
            if (conn.machineId === machineId) {
                return conn;
            }
        }
        return null;
    }

    handleClientInfo(connectionId, payload) {
        const connection = this.connections.get(connectionId);
        if (!connection) return;

        // Update connection with detailed client information
        if (payload.version) connection.version = payload.version;
        if (payload.platform) connection.platform = payload.platform;
        if (payload.os) connection.os = payload.os;
        if (payload.architecture) connection.architecture = payload.architecture;
        if (payload.hostname) connection.hostname = payload.hostname;
        if (payload.appVersion) connection.appVersion = payload.appVersion;
        if (payload.buildNumber) connection.buildNumber = payload.buildNumber;
        if (payload.locale) connection.locale = payload.locale;

        connection.lastActivity = new Date().toISOString();

        console.log(`[WebSocket] Client info updated: ${connectionId} - ${connection.platform} ${connection.os} (v${connection.version})`);

        // Acknowledge receipt
        connection.ws.send(JSON.stringify({
            type: 'client-info-received',
            timestamp: Date.now()
        }));
    }

    async handleJoinSession(connectionId, payload) {
        const { sessionId, password, type } = payload;

        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error('Session not found');
        }

        // Check password if required
        if (session.settings.password && session.settings.password !== password) {
            throw new Error('Invalid session password');
        }

        // Check connection limits
        if (session.connections.length >= session.settings.maxConnections) {
            throw new Error('Session is full');
        }

        const connection = this.connections.get(connectionId);
        connection.sessionId = sessionId;
        connection.type = type || 'client';

        session.connections.push(connectionId);
        session.stats.totalConnections++;
        session.stats.lastActivity = new Date().toISOString();

        // Notify other connections in the session
        this.broadcastToSession(sessionId, {
            type: 'peer-joined',
            connectionId,
            peerType: connection.type
        }, connectionId);

        // Send session info to the new connection
        connection.ws.send(JSON.stringify({
            type: 'joined-session',
            sessionId,
            connectionId,
            session: {
                id: session.id,
                type: session.type,
                settings: session.settings,
                connectionCount: session.connections.length
            }
        }));

        console.log(`[Sessions] Connection ${connectionId} joined session ${sessionId}`);
    }

    handleSignalingOffer(data) {
        const { sessionId, targetConnectionId, offer, connectionId } = data;

        const targetConnection = this.connections.get(targetConnectionId);
        if (targetConnection) {
            targetConnection.ws.send(JSON.stringify({
                type: 'offer',
                fromConnectionId: connectionId,
                offer
            }));
        }
    }

    handleSignalingAnswer(data) {
        const { sessionId, targetConnectionId, answer, connectionId } = data;

        const targetConnection = this.connections.get(targetConnectionId);
        if (targetConnection) {
            targetConnection.ws.send(JSON.stringify({
                type: 'answer',
                fromConnectionId: connectionId,
                answer
            }));
        }
    }

    handleICECandidate(data) {
        const { sessionId, targetConnectionId, candidate, connectionId } = data;

        const targetConnection = this.connections.get(targetConnectionId);
        if (targetConnection) {
            targetConnection.ws.send(JSON.stringify({
                type: 'ice-candidate',
                fromConnectionId: connectionId,
                candidate
            }));
        }
    }

    broadcastToSession(sessionId, message, excludeConnectionId = null) {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        session.connections.forEach(connectionId => {
            if (connectionId === excludeConnectionId) return;

            const connection = this.connections.get(connectionId);
            if (connection && connection.ws) {
                connection.ws.send(JSON.stringify(message));
            }
        });
    }

    cleanupConnection(connectionId) {
        const connection = this.connections.get(connectionId);
        if (!connection) return;

        // Remove from session
        if (connection.sessionId) {
            const session = this.sessions.get(connection.sessionId);
            if (session) {
                session.connections = session.connections.filter(id => id !== connectionId);

                // Notify other connections in the session
                this.broadcastToSession(connection.sessionId, {
                    type: 'peer-left',
                    connectionId
                });

                // Delete session if empty
                if (session.connections.length === 0) {
                    this.sessions.delete(connection.sessionId);
                    console.log(`[Sessions] Cleaned up empty session: ${connection.sessionId}`);
                }
            }
        }

        this.connections.delete(connectionId);
    }

    async executeCLICommand(commandData) {
        const { command, args = [], options = {} } = commandData;

        switch (command) {
            case 'status':
                return this.getServerStatus();

            case 'create-session':
                return this.createSession(args[0] || {});

            case 'list-sessions':
                return Array.from(this.sessions.values());

            case 'destroy-session':
                this.destroySession(args[0]);
                return { success: true };

            default:
                throw new Error(`Unknown CLI command: ${command}`);
        }
    }

    getServerStatus() {
        return {
            version: '1.4.0',
            running: this.isRunning,
            uptime: Date.now() - this.startTime,
            port: this.options.port,
            connections: {
                total: this.connections.size,
                byType: this.getConnectionsByType()
            },
            sessions: {
                total: this.sessions.size,
                active: Array.from(this.sessions.values()).filter(s => s.connections.length > 0).length
            },
            features: {
                domains: !!this.domainManager,
                cli: this.options.enableCLI
            },
            memory: process.memoryUsage(),
            platform: process.platform,
            hostname: os.hostname(),
            timestamp: new Date().toISOString()
        };
    }

    getConnectionsByType() {
        const types = {};
        for (const connection of this.connections.values()) {
            types[connection.type] = (types[connection.type] || 0) + 1;
        }
        return types;
    }

    startCleanupTimer() {
        setInterval(() => {
            this.cleanupExpiredSessions();
        }, 60000); // Every minute
    }

    cleanupExpiredSessions() {
        const now = Date.now();

        for (const [sessionId, session] of this.sessions.entries()) {
            if (new Date(session.expiresAt).getTime() < now) {
                console.log(`[Cleanup] Removing expired session: ${sessionId}`);
                this.destroySession(sessionId);
            }
        }
    }

    async stop() {
        try {
            // Close all WebSocket connections
            for (const connection of this.connections.values()) {
                if (connection.ws) {
                    connection.ws.close();
                }
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
            console.log('[Signaling] Server stopped');

            return { success: true };

        } catch (error) {
            console.error('[Signaling] Error stopping server:', error);
            throw error;
        }
    }
}

module.exports = OpenLinkSignalingServerV2;

// Auto-start if run directly (not required as module)
if (require.main === module) {
    const port = parseInt(process.argv[2]) || 8765;
    const server = new OpenLinkSignalingServerV2({
        port,
        enableDomains: false, // Disable domain management for simpler startup
        enableCLI: false
    });

    server.start().then(() => {
        console.log(`[Signaling] Server running on port ${port}`);
    }).catch(err => {
        console.error('[Signaling] Failed to start:', err);
        process.exit(1);
    });

    // Handle shutdown signals
    process.on('SIGINT', async () => {
        console.log('\n[Signaling] Shutting down...');
        await server.stop();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        console.log('\n[Signaling] Shutting down...');
        await server.stop();
        process.exit(0);
    });
}