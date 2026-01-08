/**
 * OpenLink Remote Desktop - Signaling Server
 * WebSocket server for WebRTC signaling and session management
 */

const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');

class SignalingServer {
    constructor(options = {}) {
        this.port = options.port || 8765;
        this.sessions = new Map();  // sessionId -> { host, clients, created }
        this.clients = new Map();   // ws -> { sessionId, isHost, id }

        this.server = null;
        this.wss = null;
    }

    start() {
        return new Promise((resolve, reject) => {
            // Create HTTP server
            this.server = http.createServer((req, res) => {
                // Health check endpoint
                if (req.url === '/health') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        status: 'ok',
                        sessions: this.sessions.size,
                        clients: this.clients.size
                    }));
                    return;
                }

                res.writeHead(404);
                res.end('Not Found');
            });

            // Create WebSocket server
            this.wss = new WebSocket.Server({ server: this.server });

            this.wss.on('connection', (ws, req) => {
                const clientId = this.generateClientId();

                // Extract session ID from subdomain (e.g., session123.openlink.raywonderis.me)
                const host = req.headers.host || '';
                const subdomainSession = this.extractSessionFromHost(host);

                console.log(`[Signaling] Client connected: ${clientId}, host: ${host}, subdomain-session: ${subdomainSession || 'none'}`);

                ws.on('message', (data) => {
                    try {
                        const message = JSON.parse(data);
                        this.handleMessage(ws, clientId, message);
                    } catch (error) {
                        console.error('[Signaling] Invalid message:', error);
                        this.sendError(ws, 'Invalid message format');
                    }
                });

                ws.on('close', () => {
                    this.handleDisconnect(ws, clientId);
                });

                ws.on('error', (error) => {
                    console.error(`[Signaling] Client error (${clientId}):`, error);
                });

                // Send welcome with subdomain session if present
                this.send(ws, {
                    type: 'welcome',
                    clientId,
                    subdomainSession: subdomainSession || null
                });

                // Store subdomain session for this client
                if (subdomainSession) {
                    ws._subdomainSession = subdomainSession;
                }
            });

            // Handle server errors (like EADDRINUSE) - attach BEFORE listen
            this.server.once('error', async (err) => {
                if (err.code === 'EADDRINUSE') {
                    console.warn(`[Signaling] Port ${this.port} is already in use. Auto-recovering...`);

                    // First, try to kill the existing process on this port
                    try {
                        const { exec } = require('child_process');
                        await new Promise((res) => {
                            exec(`lsof -ti :${this.port} | xargs kill -9 2>/dev/null`, () => res());
                        });
                        await new Promise(res => setTimeout(res, 1000));

                        // Retry with same port after killing
                        this.server = require('http').createServer((req, res) => {
                            if (req.url === '/health') {
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ status: 'ok', sessions: this.sessions.size, clients: this.clients.size }));
                                return;
                            }
                            res.writeHead(404);
                            res.end('Not Found');
                        });
                        this.wss = new WebSocket.Server({ server: this.server });
                        this.setupWebSocketHandlers();

                        this.server.listen(this.port, '0.0.0.0', () => {
                            console.log(`[Signaling] Server listening on 0.0.0.0:${this.port} (after recovery)`);
                            resolve({ mode: 'server', port: this.port });
                        });

                        this.server.once('error', () => {
                            // Still failed - try alternative port
                            this.port = this.port + 1;
                            console.log(`[Signaling] Trying alternative port ${this.port}...`);
                            this.server.listen(this.port, '0.0.0.0', () => {
                                console.log(`[Signaling] Server listening on 0.0.0.0:${this.port}`);
                                resolve({ mode: 'server', port: this.port });
                            });
                        });
                    } catch (killErr) {
                        // Try to connect to existing server
                        const connected = await this.tryConnectToExisting();
                        if (connected) {
                            console.log('[Signaling] Connected to existing signaling server');
                            resolve({ mode: 'client', port: this.port });
                        } else {
                            console.warn('[Signaling] Running in client-only mode (no local server)');
                            resolve({ mode: 'client-only', port: null });
                        }
                    }
                } else {
                    console.error('[Signaling] Server error:', err);
                    // Don't reject - resolve with client-only mode
                    resolve({ mode: 'client-only', port: null, error: err.message });
                }
            });

            // Bind to 0.0.0.0 to accept connections from all networks (local, Tailscale, external)
            this.server.listen(this.port, '0.0.0.0', () => {
                console.log(`[Signaling] Server listening on 0.0.0.0:${this.port} (all interfaces)`);
                resolve({ mode: 'server', port: this.port });
            });

            // Cleanup stale sessions periodically
            setInterval(() => this.cleanupSessions(), 60000);
        });
    }

    // Try to connect to an existing signaling server
    async tryConnectToExisting() {
        return new Promise((resolve) => {
            const ws = new WebSocket(`ws://localhost:${this.port}`);
            const timeout = setTimeout(() => {
                ws.close();
                resolve(false);
            }, 2000);

            ws.on('open', () => {
                clearTimeout(timeout);
                ws.close();
                resolve(true);
            });

            ws.on('error', () => {
                clearTimeout(timeout);
                resolve(false);
            });
        });
    }

    stop() {
        if (this.wss) {
            this.wss.close();
        }
        if (this.server) {
            this.server.close();
        }
    }

    handleMessage(ws, clientId, message) {
        console.log(`[Signaling] Message from ${clientId}: ${message.type}`);

        switch (message.type) {
            case 'create_session':
                this.handleCreateSession(ws, clientId, message);
                break;

            case 'host':
                // Treat 'host' as 'join' with isHost=true for backward compatibility
                message.isHost = true;
                this.handleJoin(ws, clientId, message);
                break;

            case 'join':
                this.handleJoin(ws, clientId, message);
                break;

            case 'leave':
                this.handleLeave(ws, clientId);
                break;

            case 'offer':
            case 'answer':
            case 'ice_candidate':
            case 'ice-candidate':
                this.handleWebRTCSignaling(ws, clientId, message);
                break;

            case 'broadcast':
                this.handleBroadcast(ws, clientId, message);
                break;

            case 'change_session_id':
                this.handleSessionIdChange(ws, clientId, message);
                break;

            case 'update_settings':
                this.handleUpdateSettings(ws, clientId, message);
                break;

            case 'update_password':
                this.handleUpdatePassword(ws, clientId, message);
                break;

            default:
                this.sendError(ws, `Unknown message type: ${message.type}`);
        }
    }

    handleCreateSession(ws, clientId, message) {
        const sessionId = message.sessionId || this.generateSessionId();

        if (this.sessions.has(sessionId)) {
            this.sendError(ws, 'Session already exists');
            return;
        }

        // Create session
        this.sessions.set(sessionId, {
            host: ws,
            hostId: clientId,
            clients: new Map(),
            created: Date.now(),
            settings: message.settings || {}
        });

        // Track client
        this.clients.set(ws, {
            sessionId,
            isHost: true,
            id: clientId
        });

        this.send(ws, {
            type: 'session_created',
            sessionId
        });

        console.log(`[Signaling] Session created: ${sessionId}`);
    }

    handleJoin(ws, clientId, message) {
        const { sessionId, isHost } = message;

        if (!sessionId) {
            this.sendError(ws, 'Session ID required');
            return;
        }

        let session = this.sessions.get(sessionId);

        // If joining as host and session doesn't exist, create it
        if (!session && isHost) {
            session = {
                host: ws,
                hostId: clientId,
                clients: new Map(),
                created: Date.now(),
                settings: {}
            };
            this.sessions.set(sessionId, session);
        }

        if (!session) {
            this.sendError(ws, 'Session not found');
            return;
        }

        if (isHost) {
            session.host = ws;
            session.hostId = clientId;
        } else {
            session.clients.set(clientId, ws);
        }

        // Track client
        this.clients.set(ws, {
            sessionId,
            isHost,
            id: clientId
        });

        this.send(ws, {
            type: 'joined',
            sessionId,
            isHost
        });

        // Notify other participants
        if (isHost) {
            // Notify all clients that host joined
            session.clients.forEach((clientWs, cid) => {
                this.send(clientWs, {
                    type: 'peer_joined',
                    peerId: clientId,
                    isHost: true
                });
            });
        } else {
            // Notify host that client joined
            if (session.host?.readyState === WebSocket.OPEN) {
                this.send(session.host, {
                    type: 'peer_joined',
                    peerId: clientId,
                    isHost: false
                });
            }
        }

        console.log(`[Signaling] Client ${clientId} joined session ${sessionId} as ${isHost ? 'host' : 'client'}`);
    }

    handleLeave(ws, clientId) {
        const clientInfo = this.clients.get(ws);
        if (!clientInfo) return;

        const session = this.sessions.get(clientInfo.sessionId);
        if (!session) return;

        if (clientInfo.isHost) {
            // Host leaving - notify all clients
            session.clients.forEach((clientWs) => {
                this.send(clientWs, {
                    type: 'host_disconnected'
                });
            });
            // Remove session
            this.sessions.delete(clientInfo.sessionId);
        } else {
            // Client leaving
            session.clients.delete(clientId);
            if (session.host?.readyState === WebSocket.OPEN) {
                this.send(session.host, {
                    type: 'peer_disconnected',
                    peerId: clientId
                });
            }
        }

        this.clients.delete(ws);
        console.log(`[Signaling] Client ${clientId} left session ${clientInfo.sessionId}`);
    }

    handleDisconnect(ws, clientId) {
        const clientInfo = this.clients.get(ws);
        if (clientInfo) {
            this.handleLeave(ws, clientId);
        }
        console.log(`[Signaling] Client disconnected: ${clientId}`);
    }

    handleWebRTCSignaling(ws, clientId, message) {
        const clientInfo = this.clients.get(ws);
        if (!clientInfo) {
            this.sendError(ws, 'Not in a session');
            return;
        }

        const session = this.sessions.get(clientInfo.sessionId);
        if (!session) {
            this.sendError(ws, 'Session not found');
            return;
        }

        // Forward to appropriate peer(s)
        if (clientInfo.isHost) {
            // Host sending to specific client or all clients
            if (message.targetId) {
                const targetWs = session.clients.get(message.targetId);
                if (targetWs?.readyState === WebSocket.OPEN) {
                    this.send(targetWs, {
                        ...message,
                        fromId: clientId
                    });
                }
            } else {
                // Broadcast to all clients
                session.clients.forEach((clientWs) => {
                    if (clientWs.readyState === WebSocket.OPEN) {
                        this.send(clientWs, {
                            ...message,
                            fromId: clientId
                        });
                    }
                });
            }
        } else {
            // Client sending to host
            if (session.host?.readyState === WebSocket.OPEN) {
                this.send(session.host, {
                    ...message,
                    fromId: clientId
                });
            }
        }
    }

    handleBroadcast(ws, clientId, message) {
        const clientInfo = this.clients.get(ws);
        if (!clientInfo) return;

        const session = this.sessions.get(clientInfo.sessionId);
        if (!session) return;

        // Broadcast to all in session except sender
        const broadcastMsg = {
            type: 'broadcast',
            data: message.data,
            fromId: clientId
        };

        if (clientInfo.isHost) {
            session.clients.forEach((clientWs) => {
                if (clientWs.readyState === WebSocket.OPEN) {
                    this.send(clientWs, broadcastMsg);
                }
            });
        } else {
            if (session.host?.readyState === WebSocket.OPEN) {
                this.send(session.host, broadcastMsg);
            }
            session.clients.forEach((clientWs, cid) => {
                if (cid !== clientId && clientWs.readyState === WebSocket.OPEN) {
                    this.send(clientWs, broadcastMsg);
                }
            });
        }
    }

    handleSessionIdChange(ws, clientId, message) {
        const clientInfo = this.clients.get(ws);
        if (!clientInfo || !clientInfo.isHost) {
            this.sendError(ws, 'Only hosts can change session ID');
            return;
        }

        const { newSessionId } = message;
        if (!newSessionId) {
            this.sendError(ws, 'New session ID required');
            return;
        }

        if (this.sessions.has(newSessionId)) {
            this.sendError(ws, 'Session ID already in use');
            return;
        }

        const oldSessionId = clientInfo.sessionId;
        const session = this.sessions.get(oldSessionId);
        if (!session) {
            this.sendError(ws, 'Session not found');
            return;
        }

        // Notify all clients about the session ID change BEFORE moving
        session.clients.forEach((clientWs, cid) => {
            if (clientWs.readyState === WebSocket.OPEN) {
                this.send(clientWs, {
                    type: 'session_id_changed',
                    oldSessionId,
                    newSessionId,
                    reconnectDelay: 1000  // ms to wait before reconnecting
                });
            }
        });

        // Move session to new ID
        this.sessions.delete(oldSessionId);
        this.sessions.set(newSessionId, session);

        // Update host's client info
        clientInfo.sessionId = newSessionId;

        // Update all clients' info
        session.clients.forEach((clientWs, cid) => {
            const info = this.clients.get(clientWs);
            if (info) {
                info.sessionId = newSessionId;
            }
        });

        // Confirm to host
        this.send(ws, {
            type: 'session_id_change_confirmed',
            oldSessionId,
            newSessionId
        });

        console.log(`[Signaling] Session ID changed: ${oldSessionId} -> ${newSessionId}`);
    }

    handleUpdateSettings(ws, clientId, message) {
        const clientInfo = this.clients.get(ws);
        if (!clientInfo) {
            this.sendError(ws, 'Not in a session');
            return;
        }

        const session = this.sessions.get(clientInfo.sessionId);
        if (!session) {
            this.sendError(ws, 'Session not found');
            return;
        }

        // Only hosts can update session settings
        if (clientInfo.isHost && message.settings) {
            session.settings = { ...session.settings, ...message.settings };

            // Notify clients of settings update
            session.clients.forEach((clientWs) => {
                if (clientWs.readyState === WebSocket.OPEN) {
                    this.send(clientWs, {
                        type: 'settings_updated',
                        settings: session.settings
                    });
                }
            });

            this.send(ws, {
                type: 'settings_update_confirmed',
                settings: session.settings
            });

            console.log(`[Signaling] Session ${clientInfo.sessionId} settings updated`);
        }
    }

    handleUpdatePassword(ws, clientId, message) {
        const clientInfo = this.clients.get(ws);
        if (!clientInfo || !clientInfo.isHost) {
            this.sendError(ws, 'Only hosts can update session password');
            return;
        }

        const { password } = message;
        if (!password) {
            this.sendError(ws, 'Password required');
            return;
        }

        const session = this.sessions.get(clientInfo.sessionId);
        if (!session) {
            this.sendError(ws, 'Session not found');
            return;
        }

        // Update session password
        session.password = password;

        // Notify all connected clients of password change
        session.clients.forEach((clientWs) => {
            if (clientWs.readyState === WebSocket.OPEN) {
                this.send(clientWs, {
                    type: 'password_updated',
                    sessionId: clientInfo.sessionId,
                    password: password
                });
            }
        });

        // Confirm to host
        this.send(ws, {
            type: 'password_update_confirmed',
            sessionId: clientInfo.sessionId
        });

        console.log(`[Signaling] Session ${clientInfo.sessionId} password updated`);
    }

    cleanupSessions() {
        const now = Date.now();
        const maxAge = 3600000; // 1 hour

        this.sessions.forEach((session, sessionId) => {
            // Remove sessions older than maxAge with no clients
            if (now - session.created > maxAge && session.clients.size === 0) {
                if (session.host?.readyState !== WebSocket.OPEN) {
                    this.sessions.delete(sessionId);
                    console.log(`[Signaling] Cleaned up stale session: ${sessionId}`);
                }
            }
        });
    }

    send(ws, message) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
        }
    }

    sendError(ws, message) {
        this.send(ws, { type: 'error', message });
    }

    generateSessionId() {
        return 'session-' + crypto.randomBytes(6).toString('hex');
    }

    generateClientId() {
        return 'client-' + crypto.randomBytes(4).toString('hex');
    }

    /**
     * Extract session ID from subdomain
     * Supports formats:
     * - session123.openlink.raywonderis.me -> session123
     * - session123.openlink.tappedin.fm -> session123
     * - openlink.raywonderis.me (no subdomain) -> null
     */
    extractSessionFromHost(host) {
        if (!host) return null;

        // Remove port if present
        const hostname = host.split(':')[0];

        // Known OpenLink base domains
        const baseDomains = [
            'openlink.raywonderis.me',
            'openlink.tappedin.fm',
            'openlink.devinecreations.net',
            'openlink.devine-creations.com',
            'openlink.walterharper.com',
            'openlink.tetoeehoward.com'
        ];

        // Check if this is a subdomain of any known base domain
        for (const baseDomain of baseDomains) {
            if (hostname.endsWith('.' + baseDomain)) {
                // Extract the subdomain part
                const subdomain = hostname.slice(0, -(baseDomain.length + 1));
                if (subdomain && subdomain.length > 0) {
                    console.log(`[Signaling] Extracted session from subdomain: ${subdomain}`);
                    return subdomain;
                }
            }
        }

        return null;
    }

    getStats() {
        return {
            activeSessions: this.sessions.size,
            connectedClients: this.clients.size,
            sessions: Array.from(this.sessions.entries()).map(([id, session]) => ({
                id,
                hasHost: session.host?.readyState === WebSocket.OPEN,
                clientCount: session.clients.size,
                age: Date.now() - session.created
            }))
        };
    }
}

// CLI usage
if (require.main === module) {
    const port = parseInt(process.argv[2]) || 8765;
    const server = new SignalingServer({ port });
    server.start();

    process.on('SIGINT', () => {
        console.log('\n[Signaling] Shutting down...');
        server.stop();
        process.exit(0);
    });
}

module.exports = SignalingServer;
