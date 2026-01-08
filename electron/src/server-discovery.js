/**
 * OpenLink Server Discovery & Relay Module
 *
 * Full-featured server hosting and discovery system:
 * - Discovers and manages relay servers for WebRTC signaling
 * - Can act as a relay host for all OpenLink traffic when P2P fails
 * - Supports IPv4, IPv6, traditional domains, and Web3 domains (ENS, Unstoppable, Handshake)
 * - Auto-detects available servers and allows users to choose preferred hosts
 * - Traffic relay for signaling, media, and data channels when direct connection fails
 */

const https = require('https');
const http = require('http');
const dns = require('dns');
const { URL } = require('url');

class ServerDiscovery {
    constructor() {
        // Default servers list - always available
        this.defaultServers = [
            {
                name: 'Local Server',
                url: 'ws://localhost:8765',
                type: 'primary',
                region: 'Local',
                features: ['signaling']
            },
            {
                name: 'TappedIn (Legacy)',
                url: 'ws://vps1.tappedin.fm:8765',
                type: 'fallback',
                region: 'US',
                features: ['signaling']
            },
            {
                name: 'OpenLink',
                url: 'wss://openlink.raywonderis.me',
                type: 'primary',
                region: 'US',
                features: ['signaling', 'relay', 'turn']
            },
            {
                name: 'TappedIn',
                url: 'wss://openlink.tappedin.fm',
                type: 'fallback',
                region: 'US',
                features: ['signaling', 'relay', 'turn']
            },
            {
                name: 'Devine (.net)',
                url: 'wss://openlink.devinecreations.net',
                type: 'fallback',
                region: 'US',
                features: ['signaling', 'relay', 'turn']
            },
            {
                name: 'Devine Creations',
                url: 'wss://openlink.devine-creations.com',
                type: 'fallback',
                region: 'US',
                features: ['signaling', 'relay', 'turn']
            },
            {
                name: 'Walter Harper',
                url: 'wss://openlink.walterharper.com',
                type: 'fallback',
                region: 'US',
                features: ['signaling', 'relay', 'turn']
            },
            {
                name: 'Tetoee Howard',
                url: 'wss://openlink.tetoeehoward.com',
                type: 'fallback',
                region: 'US',
                features: ['signaling', 'relay', 'turn']
            }
        ];

        // Community servers (fetched from registry)
        this.communityServers = [];

        // User's saved servers
        this.savedServers = [];

        // Server status cache
        this.serverStatus = new Map();

        // Web3 resolver endpoints
        this.web3Resolvers = {
            ens: 'https://cloudflare-eth.com',
            unstoppable: 'https://resolve.unstoppabledomains.com'
        };
    }

    /**
     * Initialize the discovery system
     */
    async init(store) {
        this.store = store;
        this.savedServers = store.get('savedServers', []);

        // Fetch community servers in background
        this.fetchCommunityServers().catch(console.error);

        // Start periodic health checks
        this.startHealthChecks();
    }

    /**
     * Get all available servers
     */
    getAllServers() {
        const servers = [
            ...this.defaultServers,
            ...this.communityServers,
            ...this.savedServers
        ];

        // Add status info
        return servers.map(server => ({
            ...server,
            status: this.serverStatus.get(server.url) || 'unknown'
        }));
    }

    /**
     * Parse and validate server address
     * Supports: IPv4, IPv6, domains, Web3 domains
     */
    parseServerAddress(address) {
        // IPv4 pattern
        const ipv4Pattern = /^(\d{1,3}\.){3}\d{1,3}(:\d+)?$/;

        // IPv6 pattern (with optional port in brackets)
        const ipv6Pattern = /^\[?([a-fA-F0-9:]+)\]?(:\d+)?$/;

        // Web3 domain patterns
        const ensPattern = /\.eth$/i;
        const unstoppablePattern = /\.(crypto|nft|wallet|blockchain|bitcoin|x|888|dao|zil)$/i;
        const handshakePattern = /\.[a-z]+$/i; // Handshake TLDs

        let parsed = {
            original: address,
            type: 'unknown',
            host: null,
            port: null,
            protocol: 'wss'
        };

        // Check if it's a full URL
        if (address.startsWith('ws://') || address.startsWith('wss://')) {
            try {
                const url = new URL(address);
                parsed.host = url.hostname;
                parsed.port = url.port || (url.protocol === 'wss:' ? 443 : 80);
                parsed.protocol = url.protocol.replace(':', '');
                parsed.type = this.detectAddressType(url.hostname);
                return parsed;
            } catch (e) {
                console.error('Invalid URL:', address);
            }
        }

        // Check for IPv4
        if (ipv4Pattern.test(address)) {
            const parts = address.split(':');
            parsed.host = parts[0];
            parsed.port = parts[1] ? parseInt(parts[1]) : 443;
            parsed.type = 'ipv4';
            return parsed;
        }

        // Check for IPv6
        if (ipv6Pattern.test(address) || address.includes('::')) {
            // Handle [ipv6]:port format
            const match = address.match(/^\[?([a-fA-F0-9:]+)\]?(?::(\d+))?$/);
            if (match) {
                parsed.host = match[1];
                parsed.port = match[2] ? parseInt(match[2]) : 443;
                parsed.type = 'ipv6';
                return parsed;
            }
        }

        // Check for Web3 domains
        if (ensPattern.test(address)) {
            parsed.type = 'ens';
            parsed.host = address;
            parsed.port = 443;
            parsed.requiresResolution = true;
            return parsed;
        }

        if (unstoppablePattern.test(address)) {
            parsed.type = 'unstoppable';
            parsed.host = address;
            parsed.port = 443;
            parsed.requiresResolution = true;
            return parsed;
        }

        // Default to traditional domain
        const parts = address.split(':');
        parsed.host = parts[0];
        parsed.port = parts[1] ? parseInt(parts[1]) : 443;
        parsed.type = 'domain';

        return parsed;
    }

    /**
     * Detect address type from hostname
     */
    detectAddressType(hostname) {
        if (/^(\d{1,3}\.){3}\d{1,3}$/.test(hostname)) return 'ipv4';
        if (hostname.includes(':')) return 'ipv6';
        if (/\.eth$/i.test(hostname)) return 'ens';
        if (/\.(crypto|nft|wallet|blockchain|bitcoin|x|888|dao|zil)$/i.test(hostname)) return 'unstoppable';
        return 'domain';
    }

    /**
     * Resolve Web3 domain to traditional address
     */
    async resolveWeb3Domain(domain, type) {
        try {
            if (type === 'ens') {
                return await this.resolveENS(domain);
            } else if (type === 'unstoppable') {
                return await this.resolveUnstoppable(domain);
            }
        } catch (error) {
            console.error(`Failed to resolve ${type} domain:`, domain, error);
            throw error;
        }
        return null;
    }

    /**
     * Resolve ENS domain
     */
    async resolveENS(domain) {
        // ENS resolution via Cloudflare DNS-over-HTTPS
        const response = await this.fetchJSON(
            `https://cloudflare-dns.com/dns-query?name=_openlink.${domain}&type=TXT`,
            { headers: { 'Accept': 'application/dns-json' } }
        );

        if (response?.Answer?.[0]?.data) {
            // Extract server URL from TXT record
            const txtRecord = response.Answer[0].data.replace(/"/g, '');
            if (txtRecord.startsWith('openlink=')) {
                return txtRecord.substring(9);
            }
        }

        // Fallback: try to resolve the domain directly
        return `wss://${domain}`;
    }

    /**
     * Resolve Unstoppable Domains
     */
    async resolveUnstoppable(domain) {
        const response = await this.fetchJSON(
            `https://resolve.unstoppabledomains.com/domains/${domain}`,
            { headers: { 'Accept': 'application/json' } }
        );

        if (response?.records?.['openlink.server']) {
            return response.records['openlink.server'];
        }

        // Fallback to ipfs gateway
        if (response?.records?.['ipfs.html.value']) {
            return `wss://${domain}.crypto`;
        }

        throw new Error(`No OpenLink record found for ${domain}`);
    }

    /**
     * Check server health
     */
    async checkServerHealth(serverUrl) {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                resolve({ status: 'timeout', latency: null });
            }, 5000);

            const startTime = Date.now();

            try {
                const url = new URL(serverUrl);
                const protocol = url.protocol === 'wss:' ? https : http;
                const healthUrl = `${url.protocol === 'wss:' ? 'https' : 'http'}://${url.host}/health`;

                // Parse URL for request options
                const parsedHealthUrl = new URL(healthUrl);
                const options = {
                    hostname: parsedHealthUrl.hostname,
                    port: parsedHealthUrl.port || (parsedHealthUrl.protocol === 'https:' ? 443 : 80),
                    path: parsedHealthUrl.pathname,
                    method: 'GET',
                    rejectUnauthorized: false, // Allow self-signed certificates
                    timeout: 5000
                };

                const req = protocol.request(options, (res) => {
                    clearTimeout(timeout);
                    const latency = Date.now() - startTime;

                    if (res.statusCode === 200) {
                        resolve({ status: 'online', latency, online: true });
                    } else {
                        resolve({ status: 'degraded', latency, online: false });
                    }
                });

                req.on('error', (err) => {
                    clearTimeout(timeout);
                    console.log(`[ServerDiscovery] Health check failed for ${serverUrl}:`, err.message);
                    resolve({ status: 'offline', latency: null, online: false });
                });

                req.on('timeout', () => {
                    req.destroy();
                    clearTimeout(timeout);
                    resolve({ status: 'timeout', latency: null, online: false });
                });

                req.end();
            } catch (error) {
                clearTimeout(timeout);
                resolve({ status: 'error', latency: null, error: error.message, online: false });
            }
        });
    }

    /**
     * Start periodic health checks
     */
    startHealthChecks() {
        // Check all servers every 60 seconds
        setInterval(async () => {
            const servers = this.getAllServers();
            for (const server of servers) {
                const health = await this.checkServerHealth(server.url);
                this.serverStatus.set(server.url, health.status);
            }
        }, 60000);

        // Initial check
        this.checkAllServers();
    }

    /**
     * Check all servers immediately
     */
    async checkAllServers() {
        const servers = this.getAllServers();
        const results = await Promise.all(
            servers.map(async (server) => {
                const health = await this.checkServerHealth(server.url);
                this.serverStatus.set(server.url, health.status);
                return { server, health };
            })
        );
        return results;
    }

    /**
     * Fetch community servers from registry
     */
    async fetchCommunityServers() {
        try {
            const response = await this.fetchJSON(
                'https://raywonderis.me/openlink/servers.json'
            );

            if (response?.servers) {
                this.communityServers = response.servers.map(s => ({
                    ...s,
                    type: 'community'
                }));
            }
        } catch (error) {
            console.error('Failed to fetch community servers:', error);
        }
    }

    /**
     * Add a custom server
     */
    addServer(server) {
        const parsed = this.parseServerAddress(server.url || server);

        const newServer = {
            name: server.name || parsed.host,
            url: typeof server === 'string' ? server : server.url,
            type: 'custom',
            addressType: parsed.type,
            addedAt: Date.now()
        };

        // Check for duplicates
        if (this.savedServers.some(s => s.url === newServer.url)) {
            return { success: false, error: 'Server already exists' };
        }

        this.savedServers.push(newServer);
        this.store?.set('savedServers', this.savedServers);

        return { success: true, server: newServer };
    }

    /**
     * Remove a custom server
     */
    removeServer(url) {
        this.savedServers = this.savedServers.filter(s => s.url !== url);
        this.store?.set('savedServers', this.savedServers);
        this.serverStatus.delete(url);
        return { success: true };
    }

    /**
     * Set a server as preferred
     */
    setPreferredServer(url, preference) {
        // preference: 'always', 'once', 'never'
        const server = this.savedServers.find(s => s.url === url);
        if (server) {
            server.preference = preference;
            this.store?.set('savedServers', this.savedServers);
        }
        return { success: !!server };
    }

    /**
     * Get the best available server
     */
    async getBestServer() {
        // First, try preferred server
        const preferred = this.savedServers.find(s => s.preference === 'always');
        if (preferred) {
            const health = await this.checkServerHealth(preferred.url);
            if (health.status === 'online') {
                return preferred;
            }
        }

        // Check all servers and sort by latency
        const results = await this.checkAllServers();
        const online = results
            .filter(r => r.health.status === 'online')
            .sort((a, b) => (a.health.latency || 9999) - (b.health.latency || 9999));

        if (online.length > 0) {
            return online[0].server;
        }

        // Fallback to first default server
        return this.defaultServers[0];
    }

    /**
     * Build WebSocket URL with proper protocol and address
     */
    async buildServerUrl(serverInfo) {
        let url = serverInfo.url;

        // Resolve Web3 domains if needed
        if (serverInfo.requiresResolution ||
            serverInfo.addressType === 'ens' ||
            serverInfo.addressType === 'unstoppable') {

            const parsed = this.parseServerAddress(url);
            if (parsed.requiresResolution) {
                url = await this.resolveWeb3Domain(parsed.host, parsed.type);
            }
        }

        return url;
    }

    /**
     * Utility: Fetch JSON
     */
    fetchJSON(url, options = {}) {
        return new Promise((resolve, reject) => {
            const urlObj = new URL(url);
            const protocol = urlObj.protocol === 'https:' ? https : http;

            const req = protocol.get(url, {
                headers: {
                    'Accept': 'application/json',
                    ...options.headers
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            req.on('error', reject);
            req.setTimeout(10000, () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });
        });
    }

    /**
     * Resolve hostname using DNS (supports IPv4 and IPv6)
     */
    resolveHostname(hostname, preferIPv6 = false) {
        return new Promise((resolve, reject) => {
            const options = { all: true };

            dns.lookup(hostname, options, (err, addresses) => {
                if (err) {
                    reject(err);
                    return;
                }

                if (preferIPv6) {
                    const ipv6 = addresses.find(a => a.family === 6);
                    if (ipv6) {
                        resolve(ipv6.address);
                        return;
                    }
                }

                // Return first available
                if (addresses.length > 0) {
                    resolve(addresses[0].address);
                } else {
                    reject(new Error('No addresses found'));
                }
            });
        });
    }
}

/**
 * Relay Server Host - Runs as a full OpenLink relay
 * Can handle all OpenLink traffic when P2P connections fail
 */
class RelayServerHost {
    constructor(discovery) {
        this.discovery = discovery;
        this.server = null;
        this.wss = null;
        this.sessions = new Map();
        this.connections = new Map();
        this.isRunning = false;

        // Hosting configuration
        // WARNING: By default, servers are PUBLIC. Anyone can connect and use your relay.
        // Set isPublic: false and configure authentication to make it private.
        this.config = {
            isPublic: true,           // DEFAULT: Public - anyone can connect. Set false for private.
            requireAuth: false,       // Require authentication to connect
            authTokens: new Map(),    // Valid auth tokens (for private servers)
            allowedUsers: [],         // Whitelist of allowed machine IDs
            hostName: null,           // Human-readable name for this host
            maxConnections: 100,      // Connection limit
            maxSessionsPerClient: 5,  // Sessions per client limit

            // Authentication options
            pinCode: null,            // Simple PIN code for quick access (4-8 digits)
            password: null,           // Password protection (hashed)
            twoFactorSecret: null,    // TOTP 2FA secret key
            twoFactorEnabled: false,  // Whether 2FA is required

            // Access control
            accessMode: 'public',     // 'public', 'pin', 'password', '2fa', 'whitelist'
            whitelistedIPs: [],       // IP whitelist for restricted access
            blacklistedIPs: [],       // IP blacklist

            // Host-side connection verification (host can require PIN from connecting users)
            requireConnectionPin: false,    // Require PIN from connecting users
            connectionPin: null,            // PIN that connecting users must enter
            connectionPinExpiry: 0,         // 0 = no expiry, otherwise timestamp when PIN expires
            oneTimePin: false,              // If true, PIN changes after each use

            // Host identity verification (prove who you are)
            verification: {
                verified: false,            // Whether this host has been verified
                verifiedAt: null,           // Timestamp of verification
                verificationLevel: 'none',  // 'none', 'basic', 'verified', 'trusted'

                // Social/identity links for verification
                mastodon: null,             // e.g., "@user@mastodon.social"
                mastodonUrl: null,          // Full URL to profile
                twitter: null,              // Twitter/X handle
                github: null,               // GitHub username
                website: null,              // Personal/org website
                email: null,                // Verified email
                pgpKeyId: null,             // PGP key ID for verification

                // Organization verification
                organization: null,         // Organization name
                orgVerified: false,         // Whether org is verified

                // Custom verification links
                customLinks: [],            // Array of { name, url, verified }

                // Verification badges
                badges: []                  // Array of badge names earned
            }
        };

        // Public server warning flag
        this._publicWarningShown = false;

        // Statistics
        this.stats = {
            totalConnections: 0,
            totalSessions: 0,
            bytesRelayed: 0,
            startTime: null
        };

        // OpenLink shareable URL domains - randomly selected for connection URLs
        this.openlinkDomains = [
            'openlink.tappedin.fm',
            'openlink.devinecreations.net',
            'openlink.devine-creations.com'
        ];
    }

    /**
     * Configure the relay host
     */
    configure(options = {}) {
        Object.assign(this.config, options);

        // Generate auth tokens if required
        if (this.config.requireAuth && this.config.authTokens.size === 0) {
            this.generateAuthToken('admin');
        }
    }

    /**
     * Generate an auth token for a user
     */
    generateAuthToken(userId) {
        const token = require('crypto').randomBytes(32).toString('hex');
        this.config.authTokens.set(token, {
            userId,
            createdAt: Date.now(),
            lastUsed: null
        });
        return token;
    }

    /**
     * Validate authentication token
     */
    validateAuth(token) {
        if (!this.config.requireAuth) return true;

        const tokenInfo = this.config.authTokens.get(token);
        if (tokenInfo) {
            tokenInfo.lastUsed = Date.now();
            return true;
        }
        return false;
    }

    /**
     * Register as public host with central registry
     */
    async registerPublic(hostInfo) {
        if (!this.config.isPublic) return { success: false, error: 'Not configured as public' };

        try {
            const response = await this.discovery.fetchJSON(
                'https://raywonderis.me/openlink/register-host',
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name: this.config.hostName || hostInfo.name,
                        url: hostInfo.url,
                        features: ['signaling', 'relay', 'turn'],
                        region: hostInfo.region,
                        publicKey: hostInfo.publicKey
                    })
                }
            );

            return { success: true, registered: response };
        } catch (error) {
            console.error('Failed to register as public host:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Unregister from public directory
     */
    async unregisterPublic() {
        // Implementation for unregistering
        return { success: true };
    }

    /**
     * Set PIN code for access
     */
    setPinCode(pin) {
        if (!/^\d{4,8}$/.test(pin)) {
            return { success: false, error: 'PIN must be 4-8 digits' };
        }
        this.config.pinCode = pin;
        this.config.accessMode = 'pin';
        return { success: true };
    }

    /**
     * Set password for access
     */
    setPassword(password) {
        if (!password || password.length < 4) {
            return { success: false, error: 'Password must be at least 4 characters' };
        }
        // Hash the password
        const crypto = require('crypto');
        this.config.password = crypto.createHash('sha256').update(password).digest('hex');
        this.config.accessMode = 'password';
        return { success: true };
    }

    /**
     * Enable 2FA authentication
     */
    enable2FA() {
        const crypto = require('crypto');
        // Generate a random secret for TOTP
        const secret = crypto.randomBytes(20).toString('base32');
        this.config.twoFactorSecret = secret;
        this.config.twoFactorEnabled = true;
        this.config.accessMode = '2fa';
        return {
            success: true,
            secret,
            // Generate otpauth URL for QR code scanning
            otpauthUrl: `otpauth://totp/OpenLink:${this.config.hostName || 'relay'}?secret=${secret}&issuer=OpenLink`
        };
    }

    /**
     * Verify TOTP code
     */
    verifyTOTP(code) {
        if (!this.config.twoFactorEnabled || !this.config.twoFactorSecret) {
            return true; // 2FA not enabled
        }

        // Simple TOTP verification (30-second windows)
        const crypto = require('crypto');
        const counter = Math.floor(Date.now() / 30000);

        // Check current and previous window for clock drift
        for (let i = -1; i <= 1; i++) {
            const hmac = crypto.createHmac('sha1', Buffer.from(this.config.twoFactorSecret, 'base32'));
            const counterBuffer = Buffer.alloc(8);
            counterBuffer.writeBigInt64BE(BigInt(counter + i));
            hmac.update(counterBuffer);
            const hash = hmac.digest();

            const offset = hash[hash.length - 1] & 0xf;
            const binary = ((hash[offset] & 0x7f) << 24) |
                          ((hash[offset + 1] & 0xff) << 16) |
                          ((hash[offset + 2] & 0xff) << 8) |
                          (hash[offset + 3] & 0xff);
            const otp = (binary % 1000000).toString().padStart(6, '0');

            if (otp === code) {
                return true;
            }
        }
        return false;
    }

    /**
     * Verify client authentication
     */
    verifyClientAuth(authData, clientIP) {
        // Check IP blacklist
        if (this.config.blacklistedIPs.includes(clientIP)) {
            return { success: false, error: 'IP blocked' };
        }

        // Check IP whitelist if in whitelist mode
        if (this.config.accessMode === 'whitelist') {
            if (!this.config.whitelistedIPs.includes(clientIP)) {
                return { success: false, error: 'IP not whitelisted' };
            }
            return { success: true };
        }

        // Public access - no auth required
        if (this.config.accessMode === 'public') {
            return { success: true };
        }

        // PIN code verification
        if (this.config.accessMode === 'pin') {
            if (authData?.pin === this.config.pinCode) {
                return { success: true };
            }
            return { success: false, error: 'Invalid PIN' };
        }

        // Password verification
        if (this.config.accessMode === 'password') {
            const crypto = require('crypto');
            const hashedInput = crypto.createHash('sha256').update(authData?.password || '').digest('hex');
            if (hashedInput === this.config.password) {
                return { success: true };
            }
            return { success: false, error: 'Invalid password' };
        }

        // 2FA verification
        if (this.config.accessMode === '2fa') {
            // First verify password if set
            if (this.config.password) {
                const crypto = require('crypto');
                const hashedInput = crypto.createHash('sha256').update(authData?.password || '').digest('hex');
                if (hashedInput !== this.config.password) {
                    return { success: false, error: 'Invalid password' };
                }
            }
            // Then verify TOTP
            if (!this.verifyTOTP(authData?.totpCode)) {
                return { success: false, error: 'Invalid 2FA code' };
            }
            return { success: true };
        }

        return { success: false, error: 'Unknown access mode' };
    }

    /**
     * Start the relay server
     */
    async start(options = {}) {
        const port = options.port || 8765;
        const host = options.host || '0.0.0.0';

        // Show public server warning
        if (this.config.isPublic && !this._publicWarningShown) {
            console.warn('\n' + '='.repeat(70));
            console.warn('WARNING: SERVER IS RUNNING IN PUBLIC MODE');
            console.warn('='.repeat(70));
            console.warn('Your relay server is publicly accessible. Anyone can connect and use');
            console.warn('your server to relay their OpenLink traffic.');
            console.warn('');
            console.warn('To make your server private, configure authentication:');
            console.warn('  - setPinCode("1234")     - Simple PIN access');
            console.warn('  - setPassword("secret")  - Password protection');
            console.warn('  - enable2FA()            - Two-factor authentication');
            console.warn('');
            console.warn('Or set isPublic: false in your configuration.');
            console.warn('='.repeat(70) + '\n');
            this._publicWarningShown = true;
        }

        // Lazy load ws module
        const WebSocket = require('ws');

        // Create HTTP server for health checks and API
        this.server = http.createServer((req, res) => {
            if (req.url === '/health') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'healthy',
                    sessions: this.sessions.size,
                    connections: this.connections.size,
                    uptime: process.uptime()
                }));
            } else if (req.url === '/api/status') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    type: 'openlink-relay',
                    version: '1.0.0',
                    features: ['signaling', 'relay', 'turn'],
                    sessions: this.sessions.size
                }));
            } else {
                res.writeHead(404);
                res.end('Not found');
            }
        });

        // Create WebSocket server
        this.wss = new WebSocket.Server({ server: this.server });

        this.wss.on('connection', (ws, req) => {
            const clientId = this.generateId();
            const clientIP = req.socket.remoteAddress;

            // Store connection with pending auth state
            const conn = {
                ws,
                ip: clientIP,
                authenticated: this.config.accessMode === 'public', // Auto-auth if public
                authTimeout: null
            };
            this.connections.set(clientId, conn);

            // Require authentication within 30 seconds for non-public servers
            if (!conn.authenticated) {
                conn.authTimeout = setTimeout(() => {
                    if (!conn.authenticated) {
                        ws.send(JSON.stringify({ type: 'auth-timeout', error: 'Authentication timeout' }));
                        ws.close();
                    }
                }, 30000);

                // Send auth required message
                ws.send(JSON.stringify({
                    type: 'auth-required',
                    clientId,
                    accessMode: this.config.accessMode,
                    serverName: this.config.hostName
                }));
            }

            ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data);

                    // Handle authentication message
                    if (message.type === 'authenticate') {
                        const authResult = this.verifyClientAuth(message.auth, clientIP);
                        if (authResult.success) {
                            conn.authenticated = true;
                            if (conn.authTimeout) {
                                clearTimeout(conn.authTimeout);
                                conn.authTimeout = null;
                            }
                            ws.send(JSON.stringify({ type: 'auth-success', clientId }));
                        } else {
                            ws.send(JSON.stringify({ type: 'auth-failed', error: authResult.error }));
                        }
                        return;
                    }

                    // Only process other messages if authenticated
                    if (!conn.authenticated) {
                        ws.send(JSON.stringify({ type: 'error', error: 'Not authenticated' }));
                        return;
                    }

                    this.handleMessage(clientId, data);
                } catch (e) {
                    // Handle non-JSON messages if authenticated
                    if (conn.authenticated) {
                        this.handleMessage(clientId, data);
                    }
                }
            });

            ws.on('close', () => {
                if (conn.authTimeout) {
                    clearTimeout(conn.authTimeout);
                }
                this.handleDisconnect(clientId);
            });

            ws.on('error', (error) => {
                console.error('WebSocket error:', error);
                if (conn.authTimeout) {
                    clearTimeout(conn.authTimeout);
                }
                this.handleDisconnect(clientId);
            });

            // Send connected message (with auth state)
            if (conn.authenticated) {
                ws.send(JSON.stringify({ type: 'connected', clientId }));
            }
        });

        return new Promise((resolve, reject) => {
            this.server.listen(port, host, () => {
                this.isRunning = true;
                console.log(`OpenLink relay server running on ${host}:${port}`);
                resolve({ host, port });
            });

            this.server.on('error', reject);
        });
    }

    /**
     * Stop the relay server
     */
    stop() {
        if (this.wss) {
            this.wss.close();
        }
        if (this.server) {
            this.server.close();
        }
        this.isRunning = false;
        this.sessions.clear();
        this.connections.clear();
    }

    /**
     * Handle incoming WebSocket messages
     */
    handleMessage(clientId, data) {
        try {
            const message = JSON.parse(data);
            const { type, sessionId, targetId, payload } = message;

            switch (type) {
                case 'create-session':
                    this.createSession(clientId, sessionId);
                    break;

                case 'join-session':
                    this.joinSession(clientId, sessionId);
                    break;

                case 'leave-session':
                    this.leaveSession(clientId, sessionId);
                    break;

                case 'signal':
                    // Relay WebRTC signaling data
                    this.relayToSession(clientId, sessionId, message);
                    break;

                case 'relay-data':
                    // Relay arbitrary data through server when P2P fails
                    this.relayData(clientId, targetId, payload);
                    break;

                case 'relay-media':
                    // Relay media chunks when P2P fails
                    this.relayMedia(clientId, targetId, payload);
                    break;

                case 'broadcast':
                    // Broadcast to all session participants
                    this.broadcastToSession(clientId, sessionId, payload);
                    break;

                default:
                    console.log('Unknown message type:', type);
            }
        } catch (error) {
            console.error('Error handling message:', error);
        }
    }

    /**
     * Create a new session
     */
    createSession(clientId, customSessionId) {
        const sessionId = customSessionId || this.generateSessionId();
        const session = {
            id: sessionId,
            host: clientId,
            participants: [clientId],
            createdAt: Date.now()
        };

        this.sessions.set(sessionId, session);

        this.sendToClient(clientId, {
            type: 'session-created',
            sessionId,
            isHost: true
        });

        return sessionId;
    }

    /**
     * Join an existing session
     */
    joinSession(clientId, sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            this.sendToClient(clientId, {
                type: 'error',
                error: 'Session not found',
                sessionId
            });
            return;
        }

        session.participants.push(clientId);

        // Notify the joiner
        this.sendToClient(clientId, {
            type: 'session-joined',
            sessionId,
            host: session.host,
            participants: session.participants
        });

        // Notify other participants
        session.participants.forEach(pid => {
            if (pid !== clientId) {
                this.sendToClient(pid, {
                    type: 'peer-joined',
                    sessionId,
                    peerId: clientId
                });
            }
        });
    }

    /**
     * Leave a session
     */
    leaveSession(clientId, sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        session.participants = session.participants.filter(p => p !== clientId);

        // Notify remaining participants
        session.participants.forEach(pid => {
            this.sendToClient(pid, {
                type: 'peer-left',
                sessionId,
                peerId: clientId
            });
        });

        // Clean up empty sessions
        if (session.participants.length === 0) {
            this.sessions.delete(sessionId);
        }
    }

    /**
     * Relay signaling messages within a session
     */
    relayToSession(senderId, sessionId, message) {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        const targetId = message.targetId;
        if (targetId && session.participants.includes(targetId)) {
            this.sendToClient(targetId, {
                ...message,
                senderId
            });
        } else {
            // Broadcast to all except sender
            session.participants.forEach(pid => {
                if (pid !== senderId) {
                    this.sendToClient(pid, {
                        ...message,
                        senderId
                    });
                }
            });
        }
    }

    /**
     * Relay data directly between two clients
     */
    relayData(senderId, targetId, payload) {
        this.sendToClient(targetId, {
            type: 'relay-data',
            senderId,
            payload
        });
    }

    /**
     * Relay media chunks between clients
     */
    relayMedia(senderId, targetId, payload) {
        const conn = this.connections.get(targetId);
        if (conn && conn.ws.readyState === 1) {
            // Send binary data directly for efficiency
            conn.ws.send(payload);
        }
    }

    /**
     * Broadcast to all session participants
     */
    broadcastToSession(senderId, sessionId, payload) {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        session.participants.forEach(pid => {
            if (pid !== senderId) {
                this.sendToClient(pid, {
                    type: 'broadcast',
                    senderId,
                    payload
                });
            }
        });
    }

    /**
     * Handle client disconnect
     */
    handleDisconnect(clientId) {
        // Leave all sessions
        this.sessions.forEach((session, sessionId) => {
            if (session.participants.includes(clientId)) {
                this.leaveSession(clientId, sessionId);
            }
        });

        this.connections.delete(clientId);
    }

    /**
     * Send message to a specific client
     */
    sendToClient(clientId, message) {
        const conn = this.connections.get(clientId);
        if (conn && conn.ws.readyState === 1) {
            conn.ws.send(JSON.stringify(message));
        }
    }

    /**
     * Generate unique client ID
     */
    generateId() {
        return 'c_' + Math.random().toString(36).substring(2, 15);
    }

    /**
     * Generate session ID - creates a complex, unique shareable connection key
     * Format: mixed case letters, numbers, and URL-safe special characters
     * Example: sNkjVdowPo-rT9-325f_ybv
     */
    generateSessionId() {
        const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        const specialChars = '-_';
        let result = '';

        // Generate 20-24 character complex ID with occasional special chars
        const length = 20 + Math.floor(Math.random() * 5);

        for (let i = 0; i < length; i++) {
            // Add special char every 5-7 characters (but not at start/end)
            if (i > 0 && i < length - 1 && i % (5 + Math.floor(Math.random() * 3)) === 0) {
                result += specialChars[Math.floor(Math.random() * specialChars.length)];
            } else {
                result += chars[Math.floor(Math.random() * chars.length)];
            }
        }

        return result;
    }

    /**
     * Generate a shareable OpenLink connection URL
     * @param {string} sessionId - Optional existing session ID, generates new one if not provided
     * @param {string} preferredDomain - Optional preferred domain, random if not provided
     * @returns {object} - { url, sessionId, domain }
     */
    generateShareableUrl(sessionId = null, preferredDomain = null) {
        // Generate session ID if not provided
        if (!sessionId) {
            sessionId = this.generateSessionId();
        }

        // Select domain - use preferred or pick randomly
        let domain;
        if (preferredDomain && this.openlinkDomains.includes(preferredDomain)) {
            domain = preferredDomain;
        } else {
            domain = this.openlinkDomains[Math.floor(Math.random() * this.openlinkDomains.length)];
        }

        // Generate the shareable URL
        const url = `https://${domain}/${sessionId}`;

        return {
            url,
            sessionId,
            domain,
            shortUrl: `${domain}/${sessionId}`
        };
    }

    /**
     * Parse an OpenLink connection URL to extract session ID
     * @param {string} url - The OpenLink URL to parse
     * @returns {object|null} - { sessionId, domain } or null if invalid
     */
    parseShareableUrl(url) {
        try {
            // Handle full URLs or short format
            let cleanUrl = url.trim();

            // Check if it's one of our domains
            for (const domain of this.openlinkDomains) {
                // Match both https://domain/id and domain/id formats
                const patterns = [
                    new RegExp(`^https?://${domain.replace('.', '\\.')}/(.+)$`),
                    new RegExp(`^${domain.replace('.', '\\.')}/(.+)$`)
                ];

                for (const pattern of patterns) {
                    const match = cleanUrl.match(pattern);
                    if (match) {
                        return {
                            sessionId: match[1],
                            domain
                        };
                    }
                }
            }

            return null;
        } catch (error) {
            console.error('Failed to parse OpenLink URL:', error);
            return null;
        }
    }

    /**
     * Get server status
     */
    getStatus() {
        return {
            running: this.isRunning,
            sessions: this.sessions.size,
            connections: this.connections.size,
            isPublic: this.config.isPublic,
            accessMode: this.config.accessMode,
            hostName: this.config.hostName,
            stats: this.stats
        };
    }

    /**
     * Get configuration (for UI)
     */
    getConfig() {
        return {
            isPublic: this.config.isPublic,
            accessMode: this.config.accessMode,
            hostName: this.config.hostName,
            maxConnections: this.config.maxConnections,
            twoFactorEnabled: this.config.twoFactorEnabled,
            hasPin: !!this.config.pinCode,
            hasPassword: !!this.config.password
        };
    }

    /**
     * Set server to private mode
     */
    setPrivate() {
        this.config.isPublic = false;
        return { success: true };
    }

    /**
     * Set server to public mode
     */
    setPublic() {
        this.config.isPublic = true;
        this.config.accessMode = 'public';
        this._publicWarningShown = false; // Reset warning for next start
        return { success: true };
    }

    // ==================== Host-side Connection PIN ====================

    /**
     * Set a PIN that connecting users must enter
     * This adds an extra layer of security - host controls who can connect
     */
    setConnectionPin(pin, options = {}) {
        if (!/^\d{4,8}$/.test(pin)) {
            return { success: false, error: 'PIN must be 4-8 digits' };
        }

        this.config.requireConnectionPin = true;
        this.config.connectionPin = pin;
        this.config.oneTimePin = options.oneTime || false;

        // Set expiry if specified (in minutes)
        if (options.expiryMinutes) {
            this.config.connectionPinExpiry = Date.now() + (options.expiryMinutes * 60 * 1000);
        } else {
            this.config.connectionPinExpiry = 0;
        }

        return {
            success: true,
            pin,
            expiry: this.config.connectionPinExpiry,
            oneTime: this.config.oneTimePin
        };
    }

    /**
     * Generate a random connection PIN
     */
    generateConnectionPin(digits = 6, options = {}) {
        const pin = Math.floor(Math.random() * Math.pow(10, digits))
            .toString()
            .padStart(digits, '0');

        return this.setConnectionPin(pin, options);
    }

    /**
     * Verify a connection PIN from incoming user
     */
    verifyConnectionPin(pin) {
        if (!this.config.requireConnectionPin) {
            return { success: true, required: false };
        }

        // Check expiry
        if (this.config.connectionPinExpiry > 0 && Date.now() > this.config.connectionPinExpiry) {
            return { success: false, error: 'PIN has expired' };
        }

        // Verify PIN
        if (pin !== this.config.connectionPin) {
            return { success: false, error: 'Invalid PIN' };
        }

        // If one-time PIN, generate a new one
        if (this.config.oneTimePin) {
            this.generateConnectionPin(this.config.connectionPin.length);
        }

        return { success: true };
    }

    /**
     * Clear connection PIN requirement
     */
    clearConnectionPin() {
        this.config.requireConnectionPin = false;
        this.config.connectionPin = null;
        this.config.connectionPinExpiry = 0;
        this.config.oneTimePin = false;
        return { success: true };
    }

    // ==================== Host Identity Verification ====================

    /**
     * Set verification information for this host
     */
    setVerification(verificationInfo) {
        Object.assign(this.config.verification, verificationInfo);
        return { success: true, verification: this.getVerificationInfo() };
    }

    /**
     * Set Mastodon verification
     */
    setMastodonVerification(handle, url) {
        // Handle format: @user@instance.social
        if (!handle.match(/^@[\w]+@[\w.-]+$/)) {
            return { success: false, error: 'Invalid Mastodon handle format. Use @user@instance.social' };
        }

        this.config.verification.mastodon = handle;
        this.config.verification.mastodonUrl = url || `https://${handle.split('@')[2]}/@${handle.split('@')[1]}`;

        return { success: true, mastodon: handle, url: this.config.verification.mastodonUrl };
    }

    /**
     * Set social links for verification
     */
    setSocialLinks(links) {
        if (links.twitter) this.config.verification.twitter = links.twitter;
        if (links.github) this.config.verification.github = links.github;
        if (links.website) this.config.verification.website = links.website;
        if (links.email) this.config.verification.email = links.email;
        if (links.pgpKeyId) this.config.verification.pgpKeyId = links.pgpKeyId;

        return { success: true, links: this.getVerificationLinks() };
    }

    /**
     * Add a custom verification link
     */
    addCustomVerificationLink(name, url) {
        this.config.verification.customLinks.push({
            name,
            url,
            verified: false,
            addedAt: Date.now()
        });

        return { success: true, customLinks: this.config.verification.customLinks };
    }

    /**
     * Set organization verification
     */
    setOrganization(orgName, verified = false) {
        this.config.verification.organization = orgName;
        this.config.verification.orgVerified = verified;

        return { success: true, organization: orgName, verified };
    }

    /**
     * Get all verification info for display to connecting users
     */
    getVerificationInfo() {
        const v = this.config.verification;
        return {
            verified: v.verified,
            verificationLevel: v.verificationLevel,
            verifiedAt: v.verifiedAt,
            hostName: this.config.hostName,

            // Social links
            links: this.getVerificationLinks(),

            // Organization
            organization: v.organization,
            orgVerified: v.orgVerified,

            // Badges
            badges: v.badges,

            // Trust indicators
            trustScore: this.calculateTrustScore()
        };
    }

    /**
     * Get verification links
     */
    getVerificationLinks() {
        const v = this.config.verification;
        const links = [];

        if (v.mastodon) {
            links.push({
                type: 'mastodon',
                handle: v.mastodon,
                url: v.mastodonUrl,
                icon: 'mastodon'
            });
        }

        if (v.twitter) {
            links.push({
                type: 'twitter',
                handle: `@${v.twitter}`,
                url: `https://twitter.com/${v.twitter}`,
                icon: 'twitter'
            });
        }

        if (v.github) {
            links.push({
                type: 'github',
                handle: v.github,
                url: `https://github.com/${v.github}`,
                icon: 'github'
            });
        }

        if (v.website) {
            links.push({
                type: 'website',
                url: v.website,
                icon: 'globe'
            });
        }

        if (v.email) {
            links.push({
                type: 'email',
                value: v.email,
                icon: 'email'
            });
        }

        if (v.pgpKeyId) {
            links.push({
                type: 'pgp',
                keyId: v.pgpKeyId,
                url: `https://keys.openpgp.org/search?q=${v.pgpKeyId}`,
                icon: 'key'
            });
        }

        // Add custom links
        v.customLinks.forEach(link => {
            links.push({
                type: 'custom',
                name: link.name,
                url: link.url,
                verified: link.verified,
                icon: 'link'
            });
        });

        return links;
    }

    /**
     * Calculate trust score based on verification
     */
    calculateTrustScore() {
        let score = 0;
        const v = this.config.verification;

        // Base verification
        if (v.verified) score += 30;

        // Verification level
        switch (v.verificationLevel) {
            case 'basic': score += 10; break;
            case 'verified': score += 25; break;
            case 'trusted': score += 40; break;
        }

        // Social proofs
        if (v.mastodon) score += 10;
        if (v.twitter) score += 5;
        if (v.github) score += 10;
        if (v.website) score += 5;
        if (v.email) score += 5;
        if (v.pgpKeyId) score += 15;

        // Organization
        if (v.organization) score += 5;
        if (v.orgVerified) score += 15;

        // Badges
        score += v.badges.length * 5;

        // Custom links
        v.customLinks.forEach(link => {
            if (link.verified) score += 5;
        });

        return Math.min(100, score); // Cap at 100
    }

    /**
     * Get trust level from score
     */
    getTrustLevel() {
        const score = this.calculateTrustScore();

        if (score >= 80) return { level: 'highly-trusted', label: 'Highly Trusted', color: 'green' };
        if (score >= 60) return { level: 'trusted', label: 'Trusted', color: 'blue' };
        if (score >= 40) return { level: 'verified', label: 'Verified', color: 'teal' };
        if (score >= 20) return { level: 'basic', label: 'Basic Verification', color: 'yellow' };
        return { level: 'unverified', label: 'Unverified', color: 'gray' };
    }
}

/**
 * Trust & Report System for Public Hosts
 * Tracks reports and can auto-ban hosts with too many reports
 */
class HostTrustManager {
    constructor() {
        this.REPORT_THRESHOLD = 3;  // Reports needed before alert/ban
        this.BAN_DURATION_HOURS = 24; // Default ban duration
        this.ADMIN_EMAIL = 'webmaster@devine-creations.com';
        this.REPORT_ENDPOINT = 'https://raywonderis.me/openlink/api/report-host';
    }

    /**
     * Report a public host as untrusted
     */
    async reportHost(hostUrl, reporterId, reason) {
        try {
            const response = await this.sendReport({
                hostUrl,
                reporterId,
                reason,
                timestamp: Date.now(),
                action: 'report'
            });

            console.log(`Host reported: ${hostUrl}, reason: ${reason}`);
            return response;
        } catch (error) {
            console.error('Failed to report host:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Send report to central server
     */
    async sendReport(reportData) {
        return new Promise((resolve, reject) => {
            const https = require('https');
            const url = new URL(this.REPORT_ENDPOINT);

            const postData = JSON.stringify(reportData);

            const options = {
                hostname: url.hostname,
                port: url.port || 443,
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                }
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const result = JSON.parse(data);
                        resolve(result);
                    } catch (e) {
                        resolve({ success: res.statusCode === 200 });
                    }
                });
            });

            req.on('error', reject);
            req.setTimeout(10000, () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });

            req.write(postData);
            req.end();
        });
    }

    /**
     * Check if a host is currently banned
     */
    async checkHostBanStatus(hostUrl) {
        try {
            const response = await this.fetchJSON(
                `https://raywonderis.me/openlink/api/host-status?url=${encodeURIComponent(hostUrl)}`
            );
            return response;
        } catch (error) {
            return { banned: false, error: error.message };
        }
    }

    /**
     * Get report count for a host
     */
    async getHostReportCount(hostUrl) {
        try {
            const response = await this.fetchJSON(
                `https://raywonderis.me/openlink/api/host-reports?url=${encodeURIComponent(hostUrl)}`
            );
            return response.count || 0;
        } catch (error) {
            return 0;
        }
    }

    /**
     * Server-side: Process incoming report (for the central server)
     * This would be implemented on the raywonderis.me server
     */
    async processReport(reportData) {
        // This is a stub - actual implementation would be on the server
        // The server would:
        // 1. Store the report in database
        // 2. Check report count for this host
        // 3. If >= 3 reports, send email alert and potentially ban

        const reportCount = await this.getHostReportCount(reportData.hostUrl);

        if (reportCount >= this.REPORT_THRESHOLD - 1) {
            // This is the 3rd (or more) report - trigger alert
            await this.sendAdminAlert(reportData.hostUrl, reportCount + 1);
            await this.banHost(reportData.hostUrl, this.BAN_DURATION_HOURS);
        }

        return {
            success: true,
            totalReports: reportCount + 1,
            actionTaken: reportCount >= this.REPORT_THRESHOLD - 1 ? 'banned_and_alerted' : 'logged'
        };
    }

    /**
     * Send alert email to webmaster
     */
    async sendAdminAlert(hostUrl, reportCount) {
        // In practice, this would be done server-side
        // Using the server's email service
        const alertData = {
            to: this.ADMIN_EMAIL,
            subject: `OpenLink Host Report Alert: ${hostUrl}`,
            body: `
A public OpenLink host has received ${reportCount} untrust reports and has been automatically banned.

Host URL: ${hostUrl}
Report Count: ${reportCount}
Ban Duration: ${this.BAN_DURATION_HOURS} hours
Timestamp: ${new Date().toISOString()}

Please review this host and take appropriate action.

- OpenLink Trust System
            `.trim()
        };

        console.log(`Alert would be sent to ${this.ADMIN_EMAIL} for host ${hostUrl}`);

        // Send to server to actually dispatch email
        try {
            await this.sendReport({
                ...alertData,
                action: 'admin_alert',
                hostUrl,
                reportCount
            });
        } catch (e) {
            console.error('Failed to send admin alert:', e);
        }

        return { success: true };
    }

    /**
     * Ban a host from public access
     */
    async banHost(hostUrl, durationHours) {
        try {
            const response = await this.sendReport({
                action: 'ban',
                hostUrl,
                durationHours,
                timestamp: Date.now(),
                expiresAt: Date.now() + (durationHours * 60 * 60 * 1000)
            });

            console.log(`Host banned: ${hostUrl} for ${durationHours} hours`);
            return response;
        } catch (error) {
            console.error('Failed to ban host:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Unban a host (admin action)
     */
    async unbanHost(hostUrl, adminToken) {
        try {
            const response = await this.sendReport({
                action: 'unban',
                hostUrl,
                adminToken,
                timestamp: Date.now()
            });

            console.log(`Host unbanned: ${hostUrl}`);
            return response;
        } catch (error) {
            console.error('Failed to unban host:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Utility: Fetch JSON
     */
    fetchJSON(url) {
        return new Promise((resolve, reject) => {
            const https = require('https');

            https.get(url, {
                headers: { 'Accept': 'application/json' }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(e);
                    }
                });
            }).on('error', reject);
        });
    }
}

// Export all classes
ServerDiscovery.RelayServerHost = RelayServerHost;
ServerDiscovery.HostTrustManager = HostTrustManager;
module.exports = ServerDiscovery;
