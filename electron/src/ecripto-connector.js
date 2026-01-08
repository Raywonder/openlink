/**
 * OpenLink - eCripto Connector
 * Integrates with eCripto for payments and machine identification
 * Supports native app, browser extension, and web API
 */

const https = require('https');
const http = require('http');
const { net } = require('electron');
const Store = require('electron-store');
const { getResolver, isWeb3Domain } = require('./freename-resolver');

class EcriptoConnector {
    constructor(options = {}) {
        this.options = {
            apiUrl: options.apiUrl || 'https://ecripto.raywonderis.me/api/v1',
            localApiPort: options.localApiPort || 31415,  // eCripto local API port
            timeout: options.timeout || 10000,
            ...options
        };

        this.store = new Store({
            name: 'openlink-ecripto',
            encryptionKey: 'openlink-ecripto-key-2024'
        });

        this.connectionMode = null;  // 'native', 'extension', 'web', null
        this.capabilities = [];
        this.walletAddress = null;
        this.isInitialized = false;
        this.localApiAvailable = false;
        this.lastLocalCheck = null;
        this.healthInterval = null;
        this.eventListeners = new Map();
    }

    /**
     * Initialize and detect available eCripto connection modes
     */
    async initialize() {
        console.log('[eCripto] Initializing connector...');

        // Restore previously saved wallet address if available
        const savedWallet = this.store.get('savedWalletAddress');
        if (savedWallet) {
            console.log(`[eCripto] Restored saved wallet: ${savedWallet.substring(0, 8)}...`);
            this.walletAddress = savedWallet;
        }

        // Try local app first with retries
        const localResult = await this.checkLocalWithRetry(3, 1000);
        if (localResult.available) {
            this.connectionMode = 'native';
            this.capabilities = localResult.capabilities || [];
            this.walletAddress = localResult.walletAddress;
            this.saveWalletAddress(this.walletAddress);
            this.localApiAvailable = true;
            this.lastLocalCheck = Date.now();
            console.log('[eCripto] Connected via native mode');
            console.log(`[eCripto] Capabilities: ${this.capabilities.join(', ')}`);
            this.isInitialized = true;

            // Start health monitoring
            this.startHealthMonitor();

            return {
                success: true,
                mode: 'native',
                capabilities: this.capabilities,
                walletAddress: this.walletAddress
            };
        }

        // Try extension
        try {
            const extResult = await this.checkBrowserExtension();
            if (extResult.available) {
                this.connectionMode = 'extension';
                this.capabilities = extResult.capabilities || [];
                this.walletAddress = extResult.walletAddress;
                this.saveWalletAddress(this.walletAddress);
                console.log('[eCripto] Connected via extension mode');
                this.isInitialized = true;
                this.startHealthMonitor();
                return {
                    success: true,
                    mode: 'extension',
                    capabilities: this.capabilities,
                    walletAddress: this.walletAddress
                };
            }
        } catch (e) {
            console.log(`[eCripto] Extension not available: ${e.message}`);
        }

        // Try web API as fallback
        try {
            const webResult = await this.checkWebApi();
            if (webResult.available) {
                this.connectionMode = 'web';
                this.capabilities = webResult.capabilities || [];
                this.walletAddress = webResult.walletAddress;
                this.saveWalletAddress(this.walletAddress);
                console.log('[eCripto] Connected via web API mode');
                this.isInitialized = true;
                this.startHealthMonitor();
                return {
                    success: true,
                    mode: 'web',
                    capabilities: this.capabilities,
                    walletAddress: this.walletAddress
                };
            }
        } catch (e) {
            console.log(`[eCripto] Web API not available: ${e.message}`);
        }

        console.log('[eCripto] No eCripto connection available');
        this.isInitialized = true;
        this.startHealthMonitor(); // Still monitor for local app becoming available
        return { success: false, mode: null, capabilities: [] };
    }

    /**
     * Check local API with retry logic
     */
    async checkLocalWithRetry(maxRetries = 3, delayMs = 1000) {
        for (let i = 0; i < maxRetries; i++) {
            try {
                const result = await this.checkNativeApp();
                if (result.available) {
                    return result;
                }
            } catch (e) {
                console.log(`[eCripto] Local check attempt ${i + 1}/${maxRetries} failed: ${e.message}`);
            }
            if (i < maxRetries - 1) {
                await this.delay(delayMs);
            }
        }
        return { available: false };
    }

    /**
     * Delay helper
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Start health monitoring for connection changes
     */
    startHealthMonitor() {
        if (this.healthInterval) {
            clearInterval(this.healthInterval);
        }

        this.healthInterval = setInterval(async () => {
            const wasAvailable = this.localApiAvailable;
            const wasMode = this.connectionMode;

            try {
                const result = await this.checkNativeApp();
                this.localApiAvailable = result.available;
                this.lastLocalCheck = Date.now();

                if (result.available && wasMode !== 'native') {
                    // Local app became available - switch to it
                    this.connectionMode = 'native';
                    this.capabilities = result.capabilities || [];
                    this.walletAddress = result.walletAddress;
                    console.log('[eCripto] Switched to native mode');
                    this.emit('connection-mode-changed', { mode: 'native', available: true });
                } else if (!result.available && wasMode === 'native') {
                    // Local app went offline - fall back to web
                    this.connectionMode = 'web';
                    console.log('[eCripto] Local app offline, falling back to web mode');
                    this.emit('connection-mode-changed', { mode: 'web', available: false });
                }
            } catch (e) {
                if (wasAvailable) {
                    this.localApiAvailable = false;
                    if (wasMode === 'native') {
                        this.connectionMode = 'web';
                        console.log('[eCripto] Local app connection lost');
                        this.emit('connection-mode-changed', { mode: 'web', available: false });
                    }
                }
            }
        }, 60000); // Check every 60 seconds
    }

    /**
     * Stop health monitoring
     */
    stopHealthMonitor() {
        if (this.healthInterval) {
            clearInterval(this.healthInterval);
            this.healthInterval = null;
        }
    }

    /**
     * Event emitter methods
     */
    on(event, callback) {
        if (!this.eventListeners.has(event)) {
            this.eventListeners.set(event, []);
        }
        this.eventListeners.get(event).push(callback);
    }

    off(event, callback) {
        const listeners = this.eventListeners.get(event);
        if (listeners) {
            const index = listeners.indexOf(callback);
            if (index > -1) {
                listeners.splice(index, 1);
            }
        }
    }

    emit(event, data) {
        const listeners = this.eventListeners.get(event);
        if (listeners) {
            listeners.forEach(callback => {
                try {
                    callback(data);
                } catch (e) {
                    console.error(`[eCripto] Event listener error: ${e.message}`);
                }
            });
        }
    }

    /**
     * Get current connection status
     */
    getConnectionStatus() {
        return {
            mode: this.connectionMode,
            localApiAvailable: this.localApiAvailable,
            lastLocalCheck: this.lastLocalCheck,
            capabilities: this.capabilities,
            walletAddress: this.walletAddress,
            isInitialized: this.isInitialized
        };
    }

    /**
     * Check if native eCripto app is running
     */
    async checkNativeApp() {
        return new Promise((resolve, reject) => {
            const options = {
                hostname: '127.0.0.1',
                port: this.options.localApiPort,
                path: '/api/status',
                method: 'GET'
            };

            const req = http.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const status = JSON.parse(data);
                        resolve({
                            available: true,
                            capabilities: status.capabilities || ['balance', 'send', 'receive', 'verify'],
                            walletAddress: status.walletAddress
                        });
                    } catch (e) {
                        reject(new Error('Invalid JSON response'));
                    }
                });
            });

            req.setTimeout(3000, () => {
                req.destroy();
                reject(new Error('Connection timeout'));
            });

            req.on('error', (err) => {
                reject(new Error(`Connection failed: ${err.message}`));
            });

            req.end();
        });
    }

    /**
     * Check for browser extension via IPC
     */
    async checkBrowserExtension() {
        // Browser extension communicates via a special file or socket
        // This is a placeholder - actual implementation depends on how eCripto extension works
        return { available: false };
    }

    /**
     * Check web API availability
     */
    async checkWebApi() {
        return new Promise((resolve, reject) => {
            const url = new URL(`${this.options.apiUrl}/status`);

            const req = net.request({
                method: 'GET',
                protocol: url.protocol,
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname
            });

            req.on('response', (response) => {
                let data = '';
                response.on('data', chunk => data += chunk.toString());
                response.on('end', () => {
                    try {
                        const status = JSON.parse(data);
                        // Web API has limited capabilities (no direct wallet access without auth)
                        resolve({
                            available: status.online || status.status === 'ok',
                            capabilities: ['verify', 'lookup', 'payment-link'],
                            walletAddress: null  // Requires authentication
                        });
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            req.on('error', reject);
            req.end();
        });
    }

    /**
     * Get current balance
     */
    async getBalance() {
        if (!this.hasCapability('balance')) {
            throw new Error('Balance capability not available');
        }

        if (this.connectionMode === 'native') {
            return this.nativeRequest('GET', '/api/wallet/balance');
        }

        throw new Error('Balance only available with native app');
    }

    /**
     * Send payment - supports Web3 domains via Freename
     */
    async sendPayment(options) {
        let { amount, recipient, memo } = options;

        // Resolve Web3 domain if needed
        let resolvedRecipient = recipient;
        let domainInfo = null;

        if (isWeb3Domain(recipient)) {
            console.log(`[eCripto] Resolving Web3 domain: ${recipient}`);
            const resolver = getResolver();
            const result = await resolver.resolve(recipient, 'ECR');

            if (result.success && result.primaryAddress) {
                resolvedRecipient = result.primaryAddress;
                domainInfo = {
                    domain: result.domain,
                    chain: result.primaryChain,
                    metadata: result.metadata
                };
                console.log(`[eCripto] Resolved ${recipient} to ${resolvedRecipient}`);
            } else {
                return {
                    success: false,
                    error: `Could not resolve Web3 domain: ${result.error || 'Domain not found'}`,
                    domain: recipient
                };
            }
        }

        if (!this.hasCapability('send')) {
            // Fall back to payment link
            return this.createPaymentLink({ ...options, recipient: resolvedRecipient });
        }

        if (this.connectionMode === 'native') {
            const result = await this.nativeRequest('POST', '/api/wallet/send', {
                amount,
                recipient: resolvedRecipient,
                memo
            });

            return {
                ...result,
                originalRecipient: recipient,
                domain: domainInfo
            };
        }

        throw new Error('Direct send only available with native app');
    }

    /**
     * Resolve Web3 domain to wallet address
     */
    async resolveWeb3Domain(domain, preferredChain = 'ECR') {
        const resolver = getResolver();
        return await resolver.resolve(domain, preferredChain);
    }

    /**
     * Check if input is a Web3 domain
     */
    isWeb3Domain(input) {
        return isWeb3Domain(input);
    }

    /**
     * Create a payment request link
     */
    async createPaymentLink(options) {
        const { amount, recipient, memo, callbackUrl } = options;

        if (this.connectionMode === 'native') {
            return this.nativeRequest('POST', '/api/payment/create-link', {
                amount,
                recipient,
                memo,
                callbackUrl
            });
        }

        // Web API fallback
        const params = new URLSearchParams({
            amount: amount.toString(),
            to: recipient,
            memo: memo || '',
            callback: callbackUrl || ''
        });

        return {
            success: true,
            paymentUrl: `https://ecripto.raywonderis.me/pay?${params}`,
            type: 'web'
        };
    }

    /**
     * Verify a transaction
     */
    async verifyTransaction(transactionId) {
        if (!this.hasCapability('verify')) {
            throw new Error('Verify capability not available');
        }

        if (this.connectionMode === 'native') {
            return this.nativeRequest('GET', `/api/transaction/${transactionId}`);
        }

        // Web API
        return this.webRequest('GET', `/transaction/${transactionId}`);
    }

    /**
     * Look up a user/address - supports Web3 domains via Freename
     */
    async lookupUser(identifier) {
        // Check if it's a Web3 domain and resolve locally first
        if (isWeb3Domain(identifier)) {
            console.log(`[eCripto] Looking up Web3 domain: ${identifier}`);
            const resolver = getResolver();
            const result = await resolver.resolve(identifier, 'ECR');

            if (result.success && result.primaryAddress) {
                return {
                    success: true,
                    found: true,
                    address: result.primaryAddress,
                    chain: result.primaryChain,
                    domain: result.domain,
                    type: 'web3-domain',
                    allAddresses: result.addresses,
                    metadata: result.metadata
                };
            } else {
                return {
                    success: false,
                    found: false,
                    error: result.error || 'Domain not found',
                    domain: identifier,
                    type: 'web3-domain'
                };
            }
        }

        if (!this.hasCapability('lookup')) {
            throw new Error('Lookup capability not available');
        }

        if (this.connectionMode === 'native') {
            return this.nativeRequest('GET', `/api/user/lookup?q=${encodeURIComponent(identifier)}`);
        }

        return this.webRequest('GET', `/user/lookup?q=${encodeURIComponent(identifier)}`);
    }

    /**
     * Generate a receive address/QR for this machine
     */
    async generateReceiveAddress(options = {}) {
        if (!this.hasCapability('receive')) {
            throw new Error('Receive capability not available');
        }

        if (this.connectionMode === 'native') {
            return this.nativeRequest('POST', '/api/wallet/receive', {
                label: options.label || 'OpenLink Payment',
                amount: options.amount
            });
        }

        throw new Error('Receive only available with native app');
    }

    /**
     * Subscribe to payment notifications
     */
    onPaymentReceived(callback) {
        if (this.connectionMode === 'native') {
            // Set up WebSocket connection to native app
            this.setupPaymentWebSocket(callback);
        }
    }

    setupPaymentWebSocket(callback) {
        const WebSocket = require('ws');
        const ws = new WebSocket(`ws://localhost:${this.options.localApiPort}/ws/payments`);

        ws.on('message', (data) => {
            try {
                const payment = JSON.parse(data);
                callback(payment);
            } catch (e) {
                console.error('[eCripto] WebSocket parse error:', e);
            }
        });

        ws.on('error', (error) => {
            console.error('[eCripto] WebSocket error:', error);
        });

        ws.on('close', () => {
            // Reconnect after delay
            setTimeout(() => this.setupPaymentWebSocket(callback), 5000);
        });

        return ws;
    }

    /**
     * Check if a capability is available
     */
    hasCapability(capability) {
        return this.capabilities.includes(capability);
    }

    /**
     * Get available payment methods for a connection
     */
    async getPaymentMethods() {
        const methods = [];

        if (this.hasCapability('send')) {
            methods.push({
                id: 'direct',
                name: 'Direct eCripto Payment',
                description: 'Pay directly from your eCripto wallet'
            });
        }

        if (this.hasCapability('payment-link')) {
            methods.push({
                id: 'web',
                name: 'Web Payment',
                description: 'Pay via eCripto web wallet'
            });
        }

        return methods;
    }

    /**
     * Process payment for remote access
     */
    async processAccessPayment(hostInfo, amount) {
        console.log(`[eCripto] Processing payment of ${amount} to ${hostInfo.walletAddress || hostInfo.hostId}`);

        // Check if host has a wallet address
        if (hostInfo.walletAddress && this.hasCapability('send')) {
            // Direct payment
            const result = await this.sendPayment({
                amount,
                recipient: hostInfo.walletAddress,
                memo: `OpenLink access: ${hostInfo.sessionId}`
            });

            if (result.success) {
                return {
                    success: true,
                    method: 'direct',
                    transactionId: result.transactionId
                };
            }
        }

        // Fall back to payment link
        const linkResult = await this.createPaymentLink({
            amount,
            recipient: hostInfo.walletAddress || 'openlink-escrow',
            memo: `OpenLink access: ${hostInfo.sessionId}`,
            callbackUrl: `openlink://payment-complete/${hostInfo.sessionId}`
        });

        return {
            success: true,
            method: 'web',
            paymentUrl: linkResult.paymentUrl
        };
    }

    /**
     * Register this machine with eCripto for identification
     */
    async registerMachine(machineInfo) {
        if (this.connectionMode === 'native') {
            return this.nativeRequest('POST', '/api/openlink/register-machine', {
                hostname: machineInfo.hostname,
                platform: machineInfo.platform,
                publicKey: machineInfo.publicKey
            });
        }

        // Store locally if no native app
        this.store.set('machineRegistration', {
            ...machineInfo,
            registeredAt: Date.now()
        });

        return { success: true, local: true };
    }

    /**
     * Get machine identity from eCripto
     */
    async getMachineIdentity() {
        if (this.connectionMode === 'native') {
            try {
                return await this.nativeRequest('GET', '/api/openlink/machine-identity');
            } catch (e) {
                // Fall back to local storage
            }
        }

        return this.store.get('machineRegistration') || null;
    }

    /**
     * Native app HTTP request
     */
    async nativeRequest(method, path, body = null) {
        return new Promise((resolve, reject) => {
            const options = {
                hostname: 'localhost',
                port: this.options.localApiPort,
                path: path,
                method: method,
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: this.options.timeout
            };

            const req = http.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const result = JSON.parse(data);
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            resolve(result);
                        } else {
                            reject(new Error(result.error || 'Request failed'));
                        }
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });

            if (body) {
                req.write(JSON.stringify(body));
            }

            req.end();
        });
    }

    /**
     * Web API request
     */
    async webRequest(method, path, body = null) {
        return new Promise((resolve, reject) => {
            const url = new URL(`${this.options.apiUrl}${path}`);

            const req = net.request({
                method: method,
                protocol: url.protocol,
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname + url.search
            });

            req.setHeader('Content-Type', 'application/json');

            req.on('response', (response) => {
                let data = '';
                response.on('data', chunk => data += chunk.toString());
                response.on('end', () => {
                    try {
                        const result = JSON.parse(data);
                        if (response.statusCode >= 200 && response.statusCode < 300) {
                            resolve(result);
                        } else {
                            reject(new Error(result.error || 'Request failed'));
                        }
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            req.on('error', reject);

            if (body) {
                req.write(JSON.stringify(body));
            }

            req.end();
        });
    }

    /**
     * Get connection status
     */
    getStatus() {
        return {
            initialized: this.isInitialized,
            connected: this.connectionMode !== null,
            mode: this.connectionMode,
            capabilities: this.capabilities,
            walletAddress: this.walletAddress
        };
    }

    /**
     * Save wallet address to persistent storage
     */
    saveWalletAddress(address) {
        if (address) {
            this.store.set('savedWalletAddress', address);
            console.log(`[eCripto] Wallet address saved: ${address.substring(0, 8)}...`);
        }
    }

    /**
     * Clear saved wallet address
     */
    clearWalletAddress() {
        this.walletAddress = null;
        this.store.delete('savedWalletAddress');
        console.log('[eCripto] Wallet address cleared');
    }

    /**
     * Disconnect and clear wallet
     */
    disconnect() {
        this.clearWalletAddress();
        this.connectionMode = null;
        this.capabilities = [];
        this.isInitialized = false;
        this.emit('disconnected');
    }
}

module.exports = EcriptoConnector;
