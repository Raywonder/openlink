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
            console.log(`[Signaling] Client connected: ${clientId}`);

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

            // Send welcome
            this.send(ws, { type: 'welcome', clientId });
        });

        this.server.listen(this.port, () => {
            console.log(`[Signaling] Server listening on port ${this.port}`);
        });

        // Cleanup stale sessions periodically
        setInterval(() => this.cleanupSessions(), 60000);
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

            case 'join':
                this.handleJoin(ws, clientId, message);
                break;

            case 'leave':
                this.handleLeave(ws, clientId);
                break;

            case 'offer':
            case 'answer':
            case 'ice_candidate':
                this.handleWebRTCSignaling(ws, clientId, message);
                break;

            case 'broadcast':
                this.handleBroadcast(ws, clientId, message);
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
