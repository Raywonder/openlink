/**
 * OpenLink Server-Side Manager
 * Handles hosting, session management, and server operations
 */

const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

class OpenLinkServerManager {
    constructor(options = {}) {
        this.options = {
            httpPort: options.httpPort || 8765,
            httpsPort: options.httpsPort || 8766,
            wsPort: options.wsPort || 8767,
            enableHTTPS: options.enableHTTPS || false,
            corsOrigins: options.corsOrigins || ['*'],
            maxConnections: options.maxConnections || 10,
            sessionTimeout: options.sessionTimeout || 3600000, // 1 hour
            ...options
        };

        this.app = express();
        this.server = null;
        this.wss = null;
        this.sessions = new Map();
        this.connections = new Map();
        this.hostingSessions = new Map();
        this.isRunning = false;

        this.setupExpress();
        this.setupWebSocket();
    }

    setupExpress() {
        // Middleware
        this.app.use(cors({
            origin: this.options.corsOrigins,
            credentials: true
        }));
        this.app.use(express.json());
        this.app.use(express.static(path.join(__dirname, '../ui')));

        // API Routes
        this.setupAPIRoutes();
    }

    setupAPIRoutes() {
        // Server status
        this.app.get('/api/status', (req, res) => {
            res.json(this.getServerStatus());
        });

        // Start hosting session
        this.app.post('/api/host/start', async (req, res) => {
            try {
                const session = await this.startHostingSession(req.body);
                res.json({ success: true, session });
            } catch (error) {
                res.status(500).json({ success: false, error: error.message });
            }
        });

        // Stop hosting session
        this.app.post('/api/host/stop/:sessionId', async (req, res) => {
            try {
                await this.stopHostingSession(req.params.sessionId);
                res.json({ success: true });
            } catch (error) {
                res.status(500).json({ success: false, error: error.message });
            }
        });

        // Get hosting session info
        this.app.get('/api/host/:sessionId', (req, res) => {
            const session = this.hostingSessions.get(req.params.sessionId);
            if (session) {
                res.json({ success: true, session });
            } else {
                res.status(404).json({ success: false, error: 'Session not found' });
            }
        });

        // List all hosting sessions
        this.app.get('/api/host', (req, res) => {
            const sessions = Array.from(this.hostingSessions.values());
            res.json({ success: true, sessions });
        });

        // Connect to session
        this.app.post('/api/connect', async (req, res) => {
            try {
                const connection = await this.createConnection(req.body);
                res.json({ success: true, connection });
            } catch (error) {
                res.status(500).json({ success: false, error: error.message });
            }
        });

        // Get connection info
        this.app.get('/api/connect/:connectionId', (req, res) => {
            const connection = this.connections.get(req.params.connectionId);
            if (connection) {
                res.json({ success: true, connection });
            } else {
                res.status(404).json({ success: false, error: 'Connection not found' });
            }
        });

        // System commands (for Claude integration)
        this.app.post('/api/system/command', async (req, res) => {
            try {
                const result = await this.executeSystemCommand(req.body);
                res.json({ success: true, result });
            } catch (error) {
                res.status(500).json({ success: false, error: error.message });
            }
        });

        // Permission management
        this.app.post('/api/permissions/check', async (req, res) => {
            try {
                const permissions = await this.checkPermissions();
                res.json({ success: true, permissions });
            } catch (error) {
                res.status(500).json({ success: false, error: error.message });
            }
        });

        // Network info
        this.app.get('/api/network', (req, res) => {
            res.json({ success: true, network: this.getNetworkInfo() });
        });
    }

    setupWebSocket() {
        // WebSocket server will be created when HTTP server starts
    }

    async startServer() {
        try {
            // Create HTTP server
            this.server = http.createServer(this.app);

            // Setup WebSocket
            this.wss = new WebSocket.Server({
                server: this.server,
                path: '/ws'
            });

            this.setupWebSocketHandlers();

            // Start listening
            await new Promise((resolve, reject) => {
                this.server.listen(this.options.httpPort, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });

            this.isRunning = true;
            console.log(`🚀 OpenLink Server started on port ${this.options.httpPort}`);
            console.log(`📡 WebSocket available at ws://localhost:${this.options.httpPort}/ws`);

            return {
                success: true,
                ports: {
                    http: this.options.httpPort,
                    ws: this.options.httpPort
                }
            };

        } catch (error) {
            console.error('❌ Failed to start server:', error);
            throw error;
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

            // Clean up sessions
            this.hostingSessions.clear();
            this.connections.clear();
            this.sessions.clear();

            this.isRunning = false;
            console.log('🛑 OpenLink Server stopped');

            return { success: true };

        } catch (error) {
            console.error('❌ Failed to stop server:', error);
            throw error;
        }
    }

    setupWebSocketHandlers() {
        this.wss.on('connection', (ws, req) => {
            const connectionId = crypto.randomBytes(16).toString('hex');

            console.log(`🔌 New WebSocket connection: ${connectionId}`);

            ws.on('message', async (message) => {
                try {
                    const data = JSON.parse(message);
                    await this.handleWebSocketMessage(ws, connectionId, data);
                } catch (error) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: error.message
                    }));
                }
            });

            ws.on('close', () => {
                console.log(`🔌 WebSocket disconnected: ${connectionId}`);
                this.connections.delete(connectionId);
            });

            ws.on('error', (error) => {
                console.error(`🔌 WebSocket error: ${connectionId}`, error);
            });

            // Send welcome message
            ws.send(JSON.stringify({
                type: 'connected',
                connectionId,
                timestamp: Date.now()
            }));
        });
    }

    async handleWebSocketMessage(ws, connectionId, data) {
        switch (data.type) {
            case 'host_start':
                const session = await this.startHostingSession(data.params);
                ws.send(JSON.stringify({
                    type: 'host_started',
                    session
                }));
                break;

            case 'host_stop':
                await this.stopHostingSession(data.sessionId);
                ws.send(JSON.stringify({
                    type: 'host_stopped',
                    sessionId: data.sessionId
                }));
                break;

            case 'connect_request':
                const connection = await this.createConnection(data.params);
                ws.send(JSON.stringify({
                    type: 'connection_created',
                    connection
                }));
                break;

            case 'system_command':
                const result = await this.executeSystemCommand(data.params);
                ws.send(JSON.stringify({
                    type: 'command_result',
                    result
                }));
                break;

            case 'ping':
                ws.send(JSON.stringify({
                    type: 'pong',
                    timestamp: Date.now()
                }));
                break;

            default:
                throw new Error(`Unknown message type: ${data.type}`);
        }
    }

    async startHostingSession(params = {}) {
        const sessionId = crypto.randomBytes(16).toString('hex');

        const session = {
            id: sessionId,
            type: 'host',
            startTime: Date.now(),
            hostname: os.hostname(),
            localIP: this.getLocalIP(),
            publicIP: await this.getPublicIP(),
            port: this.options.httpPort,
            permissions: await this.checkPermissions(),
            status: 'starting',
            connections: [],
            settings: {
                allowInput: params.allowInput !== false,
                allowAudio: params.allowAudio !== false,
                allowFileTransfer: params.allowFileTransfer !== false,
                requirePassword: params.requirePassword || false,
                password: params.password || null,
                maxConnections: params.maxConnections || 5
            }
        };

        try {
            // Check permissions before starting
            if (!session.permissions.screenRecording) {
                throw new Error('Screen Recording permission required');
            }

            // Start screen capture (implementation depends on platform)
            await this.startScreenCapture(session);

            session.status = 'active';
            this.hostingSessions.set(sessionId, session);

            // Save session info for external access
            await this.saveSessionInfo(session);

            console.log(`🎥 Hosting session started: ${sessionId}`);
            return session;

        } catch (error) {
            session.status = 'failed';
            session.error = error.message;
            console.error(`❌ Failed to start hosting session: ${error.message}`);
            throw error;
        }
    }

    async stopHostingSession(sessionId) {
        const session = this.hostingSessions.get(sessionId);
        if (!session) {
            throw new Error('Session not found');
        }

        try {
            // Stop screen capture
            await this.stopScreenCapture(session);

            // Disconnect all connections
            for (const connectionId of session.connections) {
                const connection = this.connections.get(connectionId);
                if (connection && connection.ws) {
                    connection.ws.close();
                }
                this.connections.delete(connectionId);
            }

            session.status = 'stopped';
            session.endTime = Date.now();

            this.hostingSessions.delete(sessionId);

            console.log(`🛑 Hosting session stopped: ${sessionId}`);
            return { success: true };

        } catch (error) {
            console.error(`❌ Failed to stop hosting session: ${error.message}`);
            throw error;
        }
    }

    async createConnection(params) {
        const connectionId = crypto.randomBytes(16).toString('hex');

        const connection = {
            id: connectionId,
            type: 'client',
            sessionId: params.sessionId,
            startTime: Date.now(),
            clientInfo: {
                userAgent: params.userAgent || 'Unknown',
                platform: params.platform || 'Unknown',
                version: params.version || 'Unknown'
            },
            status: 'connecting'
        };

        try {
            // Validate session exists
            const session = this.hostingSessions.get(params.sessionId);
            if (!session) {
                throw new Error('Session not found');
            }

            // Check connection limits
            if (session.connections.length >= session.settings.maxConnections) {
                throw new Error('Maximum connections reached');
            }

            // Check password if required
            if (session.settings.requirePassword && params.password !== session.settings.password) {
                throw new Error('Invalid password');
            }

            connection.status = 'connected';
            this.connections.set(connectionId, connection);
            session.connections.push(connectionId);

            console.log(`🔗 Connection created: ${connectionId} -> ${params.sessionId}`);
            return connection;

        } catch (error) {
            connection.status = 'failed';
            connection.error = error.message;
            console.error(`❌ Failed to create connection: ${error.message}`);
            throw error;
        }
    }

    async executeSystemCommand(params) {
        const { command, type = 'shell' } = params;

        // Security check - only allow specific commands
        if (!this.isCommandAllowed(command)) {
            throw new Error('Command not allowed for security reasons');
        }

        try {
            const { spawn } = require('child_process');

            return new Promise((resolve, reject) => {
                const child = spawn('sh', ['-c', command], {
                    stdio: 'pipe',
                    timeout: 30000
                });

                let stdout = '';
                let stderr = '';

                child.stdout.on('data', (data) => {
                    stdout += data.toString();
                });

                child.stderr.on('data', (data) => {
                    stderr += data.toString();
                });

                child.on('close', (code) => {
                    resolve({
                        command,
                        code,
                        stdout: stdout.trim(),
                        stderr: stderr.trim(),
                        success: code === 0,
                        timestamp: Date.now()
                    });
                });

                child.on('error', (error) => {
                    reject(new Error(`Command execution failed: ${error.message}`));
                });
            });

        } catch (error) {
            console.error(`❌ System command failed: ${error.message}`);
            throw error;
        }
    }

    isCommandAllowed(command) {
        // Whitelist of allowed commands for security
        const allowedPatterns = [
            /^ps aux/,
            /^hostname$/,
            /^whoami$/,
            /^date$/,
            /^uptime$/,
            /^ifconfig/,
            /^netstat/,
            /^lsof/,
            /^openlink-/,
            /^claude-/
        ];

        const dangerousPatterns = [
            /rm\s+-rf/,
            /sudo/,
            /chmod\s+777/,
            /passwd/,
            /su\s+/,
            /reboot/,
            /shutdown/,
            /kill\s+-9/
        ];

        // Check dangerous patterns first
        for (const pattern of dangerousPatterns) {
            if (pattern.test(command)) {
                return false;
            }
        }

        // Check allowed patterns
        for (const pattern of allowedPatterns) {
            if (pattern.test(command)) {
                return true;
            }
        }

        return false;
    }

    async checkPermissions() {
        if (process.platform !== 'darwin') {
            return { screenRecording: true, accessibility: true };
        }

        try {
            const { spawn } = require('child_process');

            const checkScreenRecording = () => {
                return new Promise((resolve) => {
                    const child = spawn('osascript', ['-e', 'tell application "System Events" to get name of every application process'], {
                        stdio: 'pipe'
                    });
                    child.on('close', (code) => {
                        resolve(code === 0);
                    });
                    child.on('error', () => resolve(false));
                });
            };

            const checkAccessibility = () => {
                return new Promise((resolve) => {
                    const child = spawn('osascript', ['-e', 'tell application "System Events" to click'], {
                        stdio: 'pipe'
                    });
                    child.on('close', (code) => {
                        resolve(code === 0);
                    });
                    child.on('error', () => resolve(false));
                });
            };

            const [screenRecording, accessibility] = await Promise.all([
                checkScreenRecording(),
                checkAccessibility()
            ]);

            return { screenRecording, accessibility };

        } catch (error) {
            console.warn('❌ Permission check failed:', error.message);
            return { screenRecording: false, accessibility: false };
        }
    }

    async startScreenCapture(session) {
        // Platform-specific screen capture implementation
        // This would integrate with the existing OpenLink screen capture code
        console.log(`🎥 Starting screen capture for session ${session.id}`);
        return true;
    }

    async stopScreenCapture(session) {
        console.log(`🛑 Stopping screen capture for session ${session.id}`);
        return true;
    }

    async saveSessionInfo(session) {
        const sessionFile = path.join(os.tmpdir(), 'openlink-session.json');
        const sessionInfo = {
            id: session.id,
            hostname: session.hostname,
            localIP: session.localIP,
            publicIP: session.publicIP,
            port: session.port,
            startTime: session.startTime,
            status: session.status
        };

        fs.writeFileSync(sessionFile, JSON.stringify(sessionInfo, null, 2));

        // Also save to user directory
        const userSessionDir = path.join(os.homedir(), '.openlink');
        if (!fs.existsSync(userSessionDir)) {
            fs.mkdirSync(userSessionDir, { recursive: true });
        }

        const userSessionFile = path.join(userSessionDir, 'current-session.json');
        fs.writeFileSync(userSessionFile, JSON.stringify(sessionInfo, null, 2));
    }

    getLocalIP() {
        const interfaces = os.networkInterfaces();
        for (const [name, addrs] of Object.entries(interfaces)) {
            for (const addr of addrs) {
                if (addr.family === 'IPv4' && !addr.internal) {
                    return addr.address;
                }
            }
        }
        return null;
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

    getNetworkInfo() {
        return {
            hostname: os.hostname(),
            localIP: this.getLocalIP(),
            interfaces: os.networkInterfaces()
        };
    }

    getServerStatus() {
        return {
            running: this.isRunning,
            startTime: this.startTime || null,
            ports: {
                http: this.options.httpPort,
                ws: this.options.httpPort
            },
            sessions: this.hostingSessions.size,
            connections: this.connections.size,
            network: this.getNetworkInfo()
        };
    }
}

module.exports = OpenLinkServerManager;