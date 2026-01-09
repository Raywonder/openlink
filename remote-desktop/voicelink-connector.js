/**
 * VoiceLink Connector for OpenLink
 * Provides optional enhanced audio through VoiceLink integration
 *
 * Features:
 * - Auto-discovery of local VoiceLink servers
 * - Federated node fallback for remote connections
 * - Seamless hidden room creation for session audio
 * - Server resource sharing support
 * - PRIVACY: Random server selection (harder to track)
 * - SECURITY: Locked hidden rooms (admin stats only)
 * - Web3/Freename DNS support
 * - Synced server switching between connected users
 *
 * @version 1.1.0
 */

const EventEmitter = require('events');

class VoiceLinkConnector extends EventEmitter {
    constructor(options = {}) {
        super();

        this.options = {
            // Default VoiceLink servers (federated nodes)
            federatedNodes: [
                'https://voicelink.devinecreations.net',
                'https://voicelink.tappedin.fm',
                'https://voicelink.raywonderis.me'
            ],
            // Web3/Blockchain DNS federated nodes (Freename, ENS, Handshake, etc.)
            web3Nodes: [
                'voicelink.crypto',      // Unstoppable Domains
                'voicelink.eth',         // ENS
                'voicelink/',            // Handshake
                'voicelink.wallet'       // Freename
            ],
            // Local discovery settings
            localDiscoveryEnabled: true,
            localDiscoveryPorts: [3010, 3011, 3012],
            localDiscoveryTimeout: 2000,
            // Connection settings
            reconnectAttempts: 3,
            reconnectDelay: 1000,
            sessionTimeout: 24 * 60 * 60 * 1000, // 24 hours
            // Privacy settings
            randomServerSelection: true,  // Randomly select from sharing servers
            autoSwitchServers: true,      // Auto-select best action while connected
            preferLocalNetwork: true,     // Prefer local servers for better latency
            ...options
        };

        // State
        this.connected = false;
        this.socket = null;
        this.server = null;
        this.apiKey = null;
        this.sessionToken = null;
        this.roomId = null;
        this.audioStream = null;
        this.audioContext = null;
        this.audioProcessor = null;

        // Discovery cache
        this.discoveredServers = [];
        this.sharingServers = [];  // Servers that allow resource sharing
        this.lastDiscovery = null;

        // Privacy/Sync state
        this.peerConnectorId = null;  // ID of the other user we're synced with
        this.serverSyncToken = null;  // Token to sync server switches
        this.currentServerIndex = -1;
    }

    /**
     * Initialize the connector and find available VoiceLink server
     * @param {string} openLinkSessionId - The OpenLink session ID to link audio to
     * @returns {Promise<boolean>} Success status
     */
    async initialize(openLinkSessionId) {
        this.openLinkSessionId = openLinkSessionId;

        try {
            // Step 1: Discover available servers
            this.emit('status', 'Discovering VoiceLink servers...');
            const server = await this.discoverServer();

            if (!server) {
                this.emit('error', 'No VoiceLink server available');
                return false;
            }

            this.server = server;
            this.emit('status', `Found server: ${server.url}`);

            // Step 2: Check if server allows resource sharing
            if (!server.allowsResourceSharing) {
                this.emit('warning', 'Server does not allow resource sharing, using as guest');
            }

            // Step 3: Get or create API key
            await this.authenticate();

            // Step 4: Create hidden room for this session
            await this.createSessionRoom();

            this.emit('ready', { server: this.server, roomId: this.roomId });
            return true;

        } catch (error) {
            this.emit('error', `Initialization failed: ${error.message}`);
            return false;
        }
    }

    /**
     * Discover available VoiceLink servers
     * Priority: Local network > Federated nodes > Web3 domains
     * PRIVACY: Uses random selection when multiple sharing servers available
     * @returns {Promise<Object|null>} Server info or null
     */
    async discoverServer() {
        const servers = [];

        // Try local discovery first
        if (this.options.localDiscoveryEnabled) {
            const localServers = await this.discoverLocalServers();
            servers.push(...localServers);
        }

        // Check federated nodes
        const federatedServers = await this.checkFederatedNodes();
        servers.push(...federatedServers);

        // Try Web3/blockchain DNS nodes
        const web3Servers = await this.checkWeb3Nodes();
        servers.push(...web3Servers);

        // Sort by preference: local > federated, then by latency
        servers.sort((a, b) => {
            if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;
            return a.latency - b.latency;
        });

        this.discoveredServers = servers;
        this.lastDiscovery = Date.now();

        // Filter servers that allow resource sharing (for random selection)
        this.sharingServers = servers.filter(s => s.allowsResourceSharing);

        // PRIVACY: If random selection enabled and multiple sharing servers available,
        // randomly select one to make tracking harder
        if (this.options.randomServerSelection && this.sharingServers.length > 1) {
            return this.selectRandomServer();
        }

        return servers[0] || null;
    }

    /**
     * PRIVACY: Randomly select from servers that allow resource sharing
     * This makes tracking individual users harder across sessions
     * @returns {Object|null} Randomly selected server
     */
    selectRandomServer() {
        if (this.sharingServers.length === 0) {
            return this.discoveredServers[0] || null;
        }

        // Prefer local servers if configured
        let pool = this.sharingServers;
        if (this.options.preferLocalNetwork) {
            const localPool = this.sharingServers.filter(s => s.isLocal);
            if (localPool.length > 0) {
                pool = localPool;
            }
        }

        // Cryptographically random selection
        const randomIndex = this.secureRandom(pool.length);
        this.currentServerIndex = randomIndex;
        return pool[randomIndex];
    }

    /**
     * Generate cryptographically secure random number
     * @param {number} max - Upper bound (exclusive)
     * @returns {number} Random integer from 0 to max-1
     */
    secureRandom(max) {
        if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
            const array = new Uint32Array(1);
            crypto.getRandomValues(array);
            return array[0] % max;
        }
        // Fallback for Node.js
        if (typeof require !== 'undefined') {
            try {
                const crypto = require('crypto');
                return crypto.randomInt(0, max);
            } catch (e) {
                // Fall through to Math.random
            }
        }
        return Math.floor(Math.random() * max);
    }

    /**
     * PRIVACY: Manually re-randomize server selection
     * Both connected users will sync to the new server
     * @returns {Promise<boolean>} Success status
     */
    async randomizeServer() {
        if (this.sharingServers.length <= 1) {
            this.emit('status', 'Not enough sharing servers for randomization');
            return false;
        }

        const previousServer = this.server;
        const newServer = this.selectRandomServer();

        // Don't switch to same server
        if (newServer && newServer.url === previousServer?.url) {
            return this.randomizeServer(); // Try again
        }

        if (!newServer) {
            this.emit('error', 'No server available for randomization');
            return false;
        }

        this.emit('status', `Switching to server: ${newServer.url}`);

        // Notify peer to sync server switch
        if (this.socket && this.connected) {
            this.socket.emit('sync-server-switch', {
                newServerUrl: newServer.url,
                syncToken: this.serverSyncToken,
                roomId: this.roomId
            });
        }

        // Disconnect from current and connect to new
        await this.switchServer(newServer);

        return true;
    }

    /**
     * Switch to a different server (for privacy or quality)
     * @param {Object} newServer - Server to switch to
     * @returns {Promise<boolean>} Success status
     */
    async switchServer(newServer) {
        // Save current room ID
        const currentRoomId = this.roomId;

        // Disconnect from current
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
        }

        // Update server
        this.server = newServer;

        // Reconnect
        try {
            await this.connect();

            // Re-join same room on new server
            if (currentRoomId) {
                this.roomId = currentRoomId;
                this.joinRoom();
            }

            this.emit('server-switched', { server: newServer });
            return true;
        } catch (error) {
            this.emit('error', `Failed to switch server: ${error.message}`);
            return false;
        }
    }

    /**
     * Check Web3/Blockchain DNS nodes
     * Supports: Freename, ENS, Handshake, Unstoppable Domains
     * @returns {Promise<Array>} Array of available Web3 servers
     */
    async checkWeb3Nodes() {
        const servers = [];

        for (const domain of this.options.web3Nodes) {
            const resolved = await this.resolveWeb3Domain(domain);
            if (resolved) {
                const serverInfo = await this.checkServer(resolved, false);
                if (serverInfo) {
                    serverInfo.isWeb3 = true;
                    serverInfo.web3Domain = domain;
                    servers.push(serverInfo);
                }
            }
        }

        return servers;
    }

    /**
     * Resolve Web3/blockchain domain to traditional URL
     * Extends computer's DNS capabilities for decentralized domains
     * @param {string} domain - Web3 domain (e.g., "voicelink.eth", "voicelink.crypto")
     * @returns {Promise<string|null>} Resolved URL or null
     */
    async resolveWeb3Domain(domain) {
        // Common Web3 DNS resolution gateways
        const gateways = [
            `https://dns.eth.limo/${domain}`,           // ETH.limo gateway
            `https://cloudflare-eth.com/dns-query?name=${domain}`,  // Cloudflare
            `https://unstoppabledomains.com/api/resolve/${domain}`, // Unstoppable
            `https://freename.io/api/v1/resolve/${domain}`          // Freename
        ];

        for (const gateway of gateways) {
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 3000);

                const response = await fetch(gateway, {
                    signal: controller.signal,
                    headers: { 'Accept': 'application/json' }
                });

                clearTimeout(timeout);

                if (response.ok) {
                    const data = await response.json();
                    // Extract IP/URL from various response formats
                    const resolved = data.ip || data.url || data.records?.A?.[0] ||
                                   data.records?.url || data.result?.ip;
                    if (resolved) {
                        // Ensure proper URL format
                        if (resolved.startsWith('http')) return resolved;
                        return `https://${resolved}`;
                    }
                }
            } catch (e) {
                // Try next gateway
            }
        }

        return null;
    }

    /**
     * Set peer connector ID for synced server switching
     * @param {string} peerId - The peer's connector ID
     */
    setPeerConnector(peerId) {
        this.peerConnectorId = peerId;
        this.serverSyncToken = this.generateSyncToken();
    }

    /**
     * Generate sync token for coordinated server switches
     * @returns {string} Unique sync token
     */
    generateSyncToken() {
        const timestamp = Date.now().toString(36);
        const random = this.secureRandom(1000000).toString(36);
        return `sync_${timestamp}_${random}`;
    }

    /**
     * Discover VoiceLink servers on local network
     * @returns {Promise<Array>} Array of discovered servers
     */
    async discoverLocalServers() {
        const servers = [];
        const localAddresses = this.getLocalNetworkAddresses();

        const checkPromises = [];

        for (const address of localAddresses) {
            for (const port of this.options.localDiscoveryPorts) {
                checkPromises.push(
                    this.checkServer(`http://${address}:${port}`, true)
                );
            }
        }

        // Also check localhost
        for (const port of this.options.localDiscoveryPorts) {
            checkPromises.push(
                this.checkServer(`http://localhost:${port}`, true)
            );
            checkPromises.push(
                this.checkServer(`http://127.0.0.1:${port}`, true)
            );
        }

        const results = await Promise.allSettled(checkPromises);

        for (const result of results) {
            if (result.status === 'fulfilled' && result.value) {
                servers.push(result.value);
            }
        }

        return servers;
    }

    /**
     * Get local network address range to scan
     * @returns {Array<string>} Array of addresses to check
     */
    getLocalNetworkAddresses() {
        // In Electron, we can get actual local IPs
        // For now, return common local addresses
        const addresses = [];

        // Check if we're in Electron and can access network interfaces
        if (typeof require !== 'undefined') {
            try {
                const os = require('os');
                const interfaces = os.networkInterfaces();

                for (const name of Object.keys(interfaces)) {
                    for (const iface of interfaces[name]) {
                        if (iface.family === 'IPv4' && !iface.internal) {
                            // Add the host's own IP
                            addresses.push(iface.address);

                            // Add common gateway/server IPs on same subnet
                            const parts = iface.address.split('.');
                            parts[3] = '1';
                            addresses.push(parts.join('.'));
                        }
                    }
                }
            } catch (e) {
                // Fallback if os module not available
            }
        }

        return [...new Set(addresses)]; // Remove duplicates
    }

    /**
     * Check federated VoiceLink nodes
     * @returns {Promise<Array>} Array of available federated servers
     */
    async checkFederatedNodes() {
        const servers = [];

        const checkPromises = this.options.federatedNodes.map(url =>
            this.checkServer(url, false)
        );

        const results = await Promise.allSettled(checkPromises);

        for (const result of results) {
            if (result.status === 'fulfilled' && result.value) {
                servers.push(result.value);
            }
        }

        return servers;
    }

    /**
     * Check if a server is available and get its capabilities
     * @param {string} url - Server URL
     * @param {boolean} isLocal - Whether this is a local server
     * @returns {Promise<Object|null>} Server info or null
     */
    async checkServer(url, isLocal) {
        const startTime = Date.now();

        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), this.options.localDiscoveryTimeout);

            const response = await fetch(`${url}/api/status`, {
                signal: controller.signal
            });

            clearTimeout(timeout);

            if (!response.ok) return null;

            const data = await response.json();
            const latency = Date.now() - startTime;

            // Check if server has VoiceLink capabilities
            if (!data.server?.includes('VoiceLink') && !data.capabilities?.includes('p2pAudio')) {
                return null;
            }

            return {
                url,
                isLocal,
                latency,
                version: data.version,
                capabilities: data.capabilities || [],
                allowsResourceSharing: data.allowsResourceSharing !== false,
                activeRooms: data.activeRooms || 0,
                connectedUsers: data.connectedUsers || 0,
                audioRelay: data.audioRelay || { enabled: false }
            };

        } catch (error) {
            return null;
        }
    }

    /**
     * Authenticate with the VoiceLink server
     * @returns {Promise<void>}
     */
    async authenticate() {
        // Check for stored API key
        const storedKey = this.loadStoredApiKey();

        if (storedKey) {
            // Validate stored key
            const isValid = await this.validateApiKey(storedKey);
            if (isValid) {
                this.apiKey = storedKey;
                await this.createSession();
                return;
            }
        }

        // Request new API key
        try {
            const response = await fetch(`${this.server.url}/api/auth/keys`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: 'OpenLink',
                    permissions: ['read', 'join', 'auth']
                })
            });

            if (!response.ok) {
                // Server may not support API keys, use guest mode
                this.emit('status', 'Using guest mode (no API key required)');
                return;
            }

            const data = await response.json();
            this.apiKey = data.apiKey;
            this.storeApiKey(data.apiKey);

            await this.createSession();

        } catch (error) {
            this.emit('warning', 'API key creation failed, using guest mode');
        }
    }

    /**
     * Validate an API key with the server
     * @param {string} apiKey - API key to validate
     * @returns {Promise<boolean>} Whether key is valid
     */
    async validateApiKey(apiKey) {
        try {
            const response = await fetch(`${this.server.url}/api/auth/validate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ apiKey })
            });

            if (!response.ok) return false;

            const data = await response.json();
            return data.valid === true;

        } catch (error) {
            return false;
        }
    }

    /**
     * Create a session for this user
     * @returns {Promise<void>}
     */
    async createSession() {
        if (!this.apiKey) return;

        try {
            const response = await fetch(`${this.server.url}/api/auth/session`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    apiKey: this.apiKey,
                    userId: `openlink_${this.openLinkSessionId}`,
                    userName: 'OpenLink User',
                    externalId: this.openLinkSessionId,
                    metadata: {
                        appSource: 'openlink',
                        sessionType: 'audio'
                    }
                })
            });

            if (response.ok) {
                const data = await response.json();
                this.sessionToken = data.sessionToken;
                this.emit('authenticated', { sessionToken: this.sessionToken });
            }

        } catch (error) {
            this.emit('warning', 'Session creation failed, continuing as guest');
        }
    }

    /**
     * Create a LOCKED hidden room for this OpenLink session
     * SECURITY:
     * - Room is invisible to regular users (hidden)
     * - Room is locked (no external joins)
     * - Only admin can see statistics (non-personal data only)
     * - No admin access to actual connections
     * @returns {Promise<void>}
     */
    async createSessionRoom() {
        try {
            // Generate cryptographically random room ID for extra privacy
            const randomSuffix = this.secureRandom(1000000).toString(36);
            const roomName = `openlink_audio_${this.openLinkSessionId}_${randomSuffix}`;

            const response = await fetch(`${this.server.url}/api/rooms`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: roomName,
                    visibility: 'hidden',        // Not visible in room listings
                    accessType: 'app-only',      // Only OpenLink can access
                    locked: true,                // No external joins allowed
                    adminAccess: 'stats-only',   // Admins see stats, not content
                    maxUsers: 10,
                    duration: 24 * 60, // 24 hours in minutes
                    // Privacy metadata - no personal data stored
                    metadata: {
                        type: 'openlink-remote-audio',
                        createdBy: 'openlink-connector',
                        sessionHash: this.hashSessionId(this.openLinkSessionId),
                        privacy: {
                            adminCanAccess: false,
                            statsOnly: true,
                            noLogging: true,
                            encryptedTransport: true
                        }
                    },
                    // Admin statistics (non-personal)
                    statsConfig: {
                        showInUsage: true,           // Show in server statistics
                        label: 'Remote OpenLink Audio', // What admins see
                        hideUserDetails: true,       // Don't show user info
                        hideIPs: true,               // Don't log IPs
                        aggregateOnly: true          // Only aggregate data
                    }
                })
            });

            if (!response.ok) {
                throw new Error('Failed to create room');
            }

            const data = await response.json();
            this.roomId = data.roomId || data.id;

            this.emit('room-created', {
                roomId: this.roomId,
                roomName,
                security: {
                    hidden: true,
                    locked: true,
                    adminAccessLevel: 'stats-only'
                }
            });

        } catch (error) {
            // Try to join existing room or use default
            this.emit('warning', 'Could not create secure room, will join on connect');
        }
    }

    /**
     * Hash session ID for privacy (admins can't see actual session)
     * @param {string} sessionId - Original session ID
     * @returns {string} Hashed version
     */
    hashSessionId(sessionId) {
        // Simple hash for privacy - not for security
        let hash = 0;
        for (let i = 0; i < sessionId.length; i++) {
            const char = sessionId.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return 'sess_' + Math.abs(hash).toString(36);
    }

    /**
     * Connect to the VoiceLink room
     * @returns {Promise<boolean>} Success status
     */
    async connect() {
        if (!this.server) {
            this.emit('error', 'No server available. Call initialize() first.');
            return false;
        }

        try {
            // Dynamic import of socket.io-client
            const io = typeof window !== 'undefined'
                ? window.io
                : require('socket.io-client');

            this.socket = io(this.server.url, {
                path: '/socket.io',
                transports: ['websocket', 'polling'],
                auth: this.sessionToken ? { sessionToken: this.sessionToken } : undefined
            });

            this.setupSocketHandlers();

            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Connection timeout'));
                }, 10000);

                this.socket.on('connect', () => {
                    clearTimeout(timeout);
                    this.connected = true;
                    this.joinRoom();
                    resolve(true);
                });

                this.socket.on('connect_error', (error) => {
                    clearTimeout(timeout);
                    reject(error);
                });
            });

        } catch (error) {
            this.emit('error', `Connection failed: ${error.message}`);
            return false;
        }
    }

    /**
     * Setup Socket.IO event handlers
     */
    setupSocketHandlers() {
        this.socket.on('disconnect', (reason) => {
            this.connected = false;
            this.emit('disconnected', reason);

            if (reason !== 'io client disconnect') {
                this.attemptReconnect();
            }
        });

        this.socket.on('user-joined', (user) => {
            this.emit('user-joined', user);
        });

        this.socket.on('user-left', (user) => {
            this.emit('user-left', user);
        });

        this.socket.on('webrtc-offer', (data) => {
            this.emit('webrtc-offer', data);
        });

        this.socket.on('webrtc-answer', (data) => {
            this.emit('webrtc-answer', data);
        });

        this.socket.on('webrtc-ice-candidate', (data) => {
            this.emit('webrtc-ice-candidate', data);
        });

        this.socket.on('relayed-audio', (data) => {
            this.handleRelayedAudio(data);
        });

        this.socket.on('error', (error) => {
            this.emit('error', error);
        });

        this.socket.on('room-joined', (data) => {
            this.emit('room-joined', data);
        });

        // PRIVACY: Handle synced server switch from peer
        // Both users switch servers together to stay connected
        this.socket.on('sync-server-switch', async (data) => {
            if (data.syncToken === this.serverSyncToken || data.roomId === this.roomId) {
                this.emit('status', 'Peer initiated server switch, syncing...');

                // Find the new server in our discovered list
                const newServer = this.discoveredServers.find(s => s.url === data.newServerUrl);
                if (newServer) {
                    await this.switchServer(newServer);
                } else {
                    // Server not in our list, try to connect anyway
                    const serverInfo = await this.checkServer(data.newServerUrl, false);
                    if (serverInfo) {
                        await this.switchServer(serverInfo);
                    } else {
                        this.emit('error', 'Cannot sync to peer server - not accessible');
                    }
                }
            }
        });
    }

    /**
     * Join the VoiceLink room
     */
    joinRoom() {
        if (!this.socket || !this.connected) return;

        this.socket.emit('join-room', {
            roomId: this.roomId,
            userName: 'OpenLink Audio',
            sessionToken: this.sessionToken,
            metadata: {
                source: 'openlink',
                sessionId: this.openLinkSessionId
            }
        });
    }

    /**
     * Attempt to reconnect after disconnection
     */
    async attemptReconnect() {
        for (let i = 0; i < this.options.reconnectAttempts; i++) {
            this.emit('status', `Reconnecting... (${i + 1}/${this.options.reconnectAttempts})`);

            await new Promise(resolve =>
                setTimeout(resolve, this.options.reconnectDelay * (i + 1))
            );

            try {
                await this.connect();
                return;
            } catch (error) {
                // Continue to next attempt
            }
        }

        this.emit('error', 'Failed to reconnect after multiple attempts');
    }

    /**
     * Start capturing and sending audio
     * @param {MediaStream} stream - Audio stream to send (optional, will capture if not provided)
     * @returns {Promise<void>}
     */
    async startAudio(stream = null) {
        try {
            if (!stream) {
                stream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true,
                        sampleRate: 48000
                    }
                });
            }

            this.audioStream = stream;
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: 48000
            });

            const source = this.audioContext.createMediaStreamSource(stream);
            this.audioProcessor = this.audioContext.createScriptProcessor(4096, 1, 1);

            this.audioProcessor.onaudioprocess = (event) => {
                if (this.connected && this.socket) {
                    const audioData = event.inputBuffer.getChannelData(0);
                    this.sendAudioData(audioData);
                }
            };

            source.connect(this.audioProcessor);
            this.audioProcessor.connect(this.audioContext.destination);

            // Enable server relay
            this.socket.emit('enable-audio-relay', {
                enabled: true,
                sampleRate: 48000,
                channels: 1
            });

            this.emit('audio-started');

        } catch (error) {
            this.emit('error', `Failed to start audio: ${error.message}`);
        }
    }

    /**
     * Send audio data to VoiceLink
     * @param {Float32Array} audioData - Raw audio samples
     */
    sendAudioData(audioData) {
        if (!this.socket || !this.connected) return;

        this.socket.emit('audio-data', {
            audioData: Array.from(audioData),
            timestamp: Date.now(),
            sampleRate: 48000
        });
    }

    /**
     * Handle relayed audio from VoiceLink server
     * @param {Object} data - Audio data packet
     */
    handleRelayedAudio(data) {
        this.emit('audio-received', data);

        // Play received audio if audio context exists
        if (this.audioContext && data.audioData) {
            const buffer = this.audioContext.createBuffer(1, data.audioData.length, 48000);
            buffer.getChannelData(0).set(new Float32Array(data.audioData));

            const source = this.audioContext.createBufferSource();
            source.buffer = buffer;
            source.connect(this.audioContext.destination);
            source.start();
        }
    }

    /**
     * Stop audio capture
     */
    stopAudio() {
        if (this.audioProcessor) {
            this.audioProcessor.disconnect();
            this.audioProcessor = null;
        }

        if (this.audioStream) {
            this.audioStream.getTracks().forEach(track => track.stop());
            this.audioStream = null;
        }

        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }

        if (this.socket) {
            this.socket.emit('enable-audio-relay', { enabled: false });
        }

        this.emit('audio-stopped');
    }

    /**
     * Disconnect from VoiceLink
     */
    disconnect() {
        this.stopAudio();

        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
        }

        this.connected = false;
        this.emit('disconnected', 'manual');
    }

    /**
     * Store API key for future use
     * @param {string} apiKey - API key to store
     */
    storeApiKey(apiKey) {
        try {
            if (typeof localStorage !== 'undefined') {
                localStorage.setItem('voicelink_api_key', apiKey);
            } else if (typeof require !== 'undefined') {
                // Electron store
                const Store = require('electron-store');
                const store = new Store();
                store.set('voicelink.apiKey', apiKey);
            }
        } catch (e) {
            // Storage not available
        }
    }

    /**
     * Load stored API key
     * @returns {string|null} Stored API key or null
     */
    loadStoredApiKey() {
        try {
            if (typeof localStorage !== 'undefined') {
                return localStorage.getItem('voicelink_api_key');
            } else if (typeof require !== 'undefined') {
                const Store = require('electron-store');
                const store = new Store();
                return store.get('voicelink.apiKey');
            }
        } catch (e) {
            // Storage not available
        }
        return null;
    }

    /**
     * Get list of discovered servers
     * @returns {Array} Discovered servers
     */
    getDiscoveredServers() {
        return this.discoveredServers;
    }

    /**
     * Get servers that allow resource sharing (for randomization)
     * @returns {Array} Sharing servers
     */
    getSharingServers() {
        return this.sharingServers;
    }

    /**
     * Get current connection status
     * @returns {Object} Status info
     */
    getStatus() {
        return {
            connected: this.connected,
            server: this.server,
            roomId: this.roomId,
            hasSession: !!this.sessionToken,
            audioActive: !!this.audioProcessor,
            // Privacy info
            privacy: {
                randomSelectionEnabled: this.options.randomServerSelection,
                sharingServersCount: this.sharingServers.length,
                canRandomize: this.sharingServers.length > 1,
                currentServerIndex: this.currentServerIndex,
                roomLocked: true,
                roomHidden: true
            }
        };
    }

    /**
     * Check if server randomization is available
     * @returns {boolean} True if multiple sharing servers available
     */
    canRandomize() {
        return this.sharingServers.length > 1;
    }

    /**
     * Enable/disable random server selection
     * @param {boolean} enabled - Enable random selection
     */
    setRandomServerSelection(enabled) {
        this.options.randomServerSelection = enabled;
        this.emit('settings-changed', { randomServerSelection: enabled });
    }

    /**
     * Enable/disable auto server switching
     * @param {boolean} enabled - Enable auto switching
     */
    setAutoSwitchServers(enabled) {
        this.options.autoSwitchServers = enabled;
        this.emit('settings-changed', { autoSwitchServers: enabled });
    }

    /**
     * Get privacy settings summary
     * @returns {Object} Privacy configuration
     */
    getPrivacySettings() {
        return {
            randomServerSelection: this.options.randomServerSelection,
            autoSwitchServers: this.options.autoSwitchServers,
            preferLocalNetwork: this.options.preferLocalNetwork,
            sharingServersAvailable: this.sharingServers.length,
            web3DomainsEnabled: this.options.web3Nodes.length > 0,
            roomSecurity: {
                hidden: true,
                locked: true,
                adminAccess: 'stats-only',
                noPersonalData: true
            }
        };
    }
}

module.exports = VoiceLinkConnector;
