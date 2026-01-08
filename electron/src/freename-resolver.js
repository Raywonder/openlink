/**
 * Freename Web3 Domain Resolver
 * Resolves Web3 domains (e.g., user.eth, user.metaverse, user.crypto)
 * to cryptocurrency wallet addresses using Freename API
 *
 * API Documentation: https://docs.freename.io
 */

const https = require('https');
const http = require('http');

// Freename API configuration
const FREENAME_API_BASE = 'https://api.freename.io';
const FREENAME_API_VERSION = 'v1';

// Supported TLDs for Web3 domains
const WEB3_TLDS = [
    // Freename TLDs
    'metaverse', 'web3', 'nft', 'dweb', 'dao', 'defi', 'hodl', 'moon',
    'chain', 'dapp', 'token', 'coin', 'wallet', 'crypto', 'blockchain',
    // Unstoppable Domains TLDs
    'x', 'wallet', 'bitcoin', 'blockchain', 'crypto', 'dao', 'nft',
    // ENS
    'eth',
    // Handshake
    'hns',
    // eCripto official domains
    'app'
];

// Cryptocurrency chain mapping
const CHAIN_MAPPING = {
    'ECR': 'ECR',      // eCripto native
    'ETH': 'ETH',      // Ethereum
    'BTC': 'BTC',      // Bitcoin
    'MATIC': 'MATIC',  // Polygon
    'BNB': 'BNB',      // BNB Chain
    'SOL': 'SOL',      // Solana
    'AVAX': 'AVAX',    // Avalanche
    'USDT': 'USDT',    // Tether (multiple chains)
    'USDC': 'USDC'     // USD Coin (multiple chains)
};

class FreenameResolver {
    constructor(options = {}) {
        this.apiBase = options.apiBase || FREENAME_API_BASE;
        this.apiVersion = options.apiVersion || FREENAME_API_VERSION;
        this.timeout = options.timeout || 10000;
        this.cache = new Map();
        this.cacheExpiry = options.cacheExpiry || 300000; // 5 minutes default
    }

    /**
     * Check if a string looks like a Web3 domain
     * @param {string} input - The input to check
     * @returns {boolean}
     */
    isWeb3Domain(input) {
        if (!input || typeof input !== 'string') return false;

        const parts = input.toLowerCase().trim().split('.');
        if (parts.length < 2) return false;

        const tld = parts[parts.length - 1];
        return WEB3_TLDS.includes(tld);
    }

    /**
     * Resolve a Web3 domain to wallet addresses
     * @param {string} domain - The Web3 domain (e.g., "user.metaverse")
     * @param {string} preferredChain - Preferred blockchain (optional)
     * @returns {Promise<Object>} Resolution result
     */
    async resolve(domain, preferredChain = null) {
        if (!domain || typeof domain !== 'string') {
            return {
                success: false,
                error: 'Invalid domain',
                domain: domain
            };
        }

        const normalizedDomain = domain.toLowerCase().trim();

        // Check cache first
        const cached = this.getCached(normalizedDomain);
        if (cached) {
            console.log(`[FreenameResolver] Cache hit for ${normalizedDomain}`);
            return this.formatResult(cached, preferredChain);
        }

        try {
            console.log(`[FreenameResolver] Resolving ${normalizedDomain}`);
            const result = await this.fetchFromAPI(normalizedDomain);

            // Cache the result
            this.setCache(normalizedDomain, result);

            return this.formatResult(result, preferredChain);
        } catch (error) {
            console.error(`[FreenameResolver] Error resolving ${normalizedDomain}:`, error.message);
            return {
                success: false,
                error: error.message,
                domain: normalizedDomain
            };
        }
    }

    /**
     * Fetch domain data from Freename API
     * @param {string} domain - The domain to resolve
     * @returns {Promise<Object>}
     */
    fetchFromAPI(domain) {
        return new Promise((resolve, reject) => {
            const url = `${this.apiBase}/api/${this.apiVersion}/resolver/resolve/${encodeURIComponent(domain)}`;
            const urlObj = new URL(url);

            const options = {
                hostname: urlObj.hostname,
                port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
                path: urlObj.pathname + urlObj.search,
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'eCripto/1.1.3'
                },
                timeout: this.timeout
            };

            const protocol = urlObj.protocol === 'https:' ? https : http;

            const req = protocol.request(options, (res) => {
                let data = '';

                res.on('data', chunk => data += chunk);

                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);

                        if (res.statusCode === 200) {
                            resolve(parsed);
                        } else if (res.statusCode === 404) {
                            reject(new Error('Domain not found'));
                        } else {
                            reject(new Error(parsed.message || `API error: ${res.statusCode}`));
                        }
                    } catch (e) {
                        reject(new Error('Invalid API response'));
                    }
                });
            });

            req.on('error', (error) => {
                reject(new Error(`Network error: ${error.message}`));
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });

            req.end();
        });
    }

    /**
     * Format API result for application use
     * @param {Object} apiResult - Raw API result
     * @param {string} preferredChain - Preferred blockchain
     * @returns {Object}
     */
    formatResult(apiResult, preferredChain) {
        if (!apiResult || !apiResult.records) {
            return {
                success: false,
                error: 'No records found',
                domain: apiResult?.name || 'unknown'
            };
        }

        const addresses = {};
        const records = apiResult.records;

        // Extract wallet addresses from records
        // Freename API returns records like: { "crypto.ETH.address": "0x...", "crypto.BTC.address": "bc1..." }
        for (const [key, value] of Object.entries(records)) {
            if (key.startsWith('crypto.') && key.endsWith('.address')) {
                const chain = key.split('.')[1].toUpperCase();
                addresses[chain] = value;
            }
        }

        // Determine primary address
        let primaryAddress = null;
        let primaryChain = null;

        if (preferredChain && addresses[preferredChain.toUpperCase()]) {
            primaryAddress = addresses[preferredChain.toUpperCase()];
            primaryChain = preferredChain.toUpperCase();
        } else if (addresses.ECR) {
            // Prefer eCripto if available
            primaryAddress = addresses.ECR;
            primaryChain = 'ECR';
        } else if (addresses.ETH) {
            // Fallback to Ethereum
            primaryAddress = addresses.ETH;
            primaryChain = 'ETH';
        } else {
            // Use first available
            const chains = Object.keys(addresses);
            if (chains.length > 0) {
                primaryChain = chains[0];
                primaryAddress = addresses[primaryChain];
            }
        }

        return {
            success: true,
            domain: apiResult.name || apiResult.domain,
            owner: apiResult.owner || null,
            primaryAddress,
            primaryChain,
            addresses,
            metadata: {
                avatar: records['social.avatar'] || records['avatar'] || null,
                email: records['email'] || null,
                url: records['url'] || records['website'] || null,
                twitter: records['social.twitter'] || null,
                description: records['description'] || null
            },
            raw: apiResult
        };
    }

    /**
     * Get cached result
     * @param {string} domain
     * @returns {Object|null}
     */
    getCached(domain) {
        const entry = this.cache.get(domain);
        if (!entry) return null;

        if (Date.now() - entry.timestamp > this.cacheExpiry) {
            this.cache.delete(domain);
            return null;
        }

        return entry.data;
    }

    /**
     * Set cache entry
     * @param {string} domain
     * @param {Object} data
     */
    setCache(domain, data) {
        this.cache.set(domain, {
            data,
            timestamp: Date.now()
        });
    }

    /**
     * Clear cache
     */
    clearCache() {
        this.cache.clear();
    }

    /**
     * Resolve multiple domains in parallel
     * @param {string[]} domains
     * @param {string} preferredChain
     * @returns {Promise<Object[]>}
     */
    async resolveMultiple(domains, preferredChain = null) {
        return Promise.all(
            domains.map(domain => this.resolve(domain, preferredChain))
        );
    }

    /**
     * Check if an address matches any Web3 domain
     * @param {string} address - Wallet address to reverse lookup
     * @returns {Promise<Object>} Reverse lookup result
     */
    async reverseLookup(address) {
        // Note: Freename reverse lookup may require authentication
        // This is a placeholder for future implementation
        return {
            success: false,
            error: 'Reverse lookup not yet implemented',
            address
        };
    }

    /**
     * Get supported TLDs
     * @returns {string[]}
     */
    getSupportedTLDs() {
        return [...WEB3_TLDS];
    }

    /**
     * Get supported chains
     * @returns {Object}
     */
    getSupportedChains() {
        return { ...CHAIN_MAPPING };
    }
}

// Singleton instance for shared use
let sharedInstance = null;

/**
 * Get or create shared resolver instance
 * @param {Object} options
 * @returns {FreenameResolver}
 */
function getResolver(options = {}) {
    if (!sharedInstance) {
        sharedInstance = new FreenameResolver(options);
    }
    return sharedInstance;
}

module.exports = {
    FreenameResolver,
    getResolver,
    isWeb3Domain: (input) => new FreenameResolver().isWeb3Domain(input),
    WEB3_TLDS,
    CHAIN_MAPPING
};
