/**
 * Universal API Configuration for all services
 * Supports api.*.* endpoints with automatic failover
 * Version: 2.0.0
 *
 * Usage in any project:
 * const { UniversalAPIClient } = require('./shared-api-config');
 * const api = new UniversalAPIClient('project-name');
 */

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { URL } = require('url');

class UniversalAPIClient {
  constructor(serviceName, config = {}) {
    this.serviceName = serviceName;
    this.config = {
      // Primary API endpoints with automatic failover
      endpoints: [
        'api.devine-creations.com',
        'api.devinecreations.net',
        'api.tappedin.fm',
        'tts.tappedin.fm' // Legacy support
      ],

      // API configuration
      timeout: config.timeout || 10000,
      retries: config.retries || 3,
      retryDelay: config.retryDelay || 1000,

      // Authentication
      apiKey: config.apiKey || process.env.API_KEY,
      userAgent: `UniversalAPI-${serviceName}/2.0.0`,

      // Service-specific settings
      useSSL: config.useSSL !== false,
      port: config.port || (config.useSSL !== false ? 443 : 80),

      // Advanced features
      enableCaching: config.enableCaching !== false,
      cacheTimeout: config.cacheTimeout || 300000, // 5 minutes
      enableMetrics: config.enableMetrics !== false,

      ...config
    };

    this.activeEndpoint = null;
    this.endpointHealth = new Map();
    this.cache = new Map();
    this.metrics = {
      requests: 0,
      errors: 0,
      cacheHits: 0,
      avgResponseTime: 0,
      endpointFailures: new Map()
    };

    // Initialize endpoint health tracking
    this.config.endpoints.forEach(endpoint => {
      this.endpointHealth.set(endpoint, {
        status: 'unknown',
        lastCheck: 0,
        responseTime: 0,
        consecutiveFailures: 0
      });
    });
  }

  /**
   * Make an API request with automatic failover
   */
  async request(path, options = {}) {
    const startTime = Date.now();
    this.metrics.requests++;

    // Check cache first
    if (this.config.enableCaching && options.method !== 'POST' && options.method !== 'PUT') {
      const cacheKey = this.getCacheKey(path, options);
      const cached = this.cache.get(cacheKey);
      if (cached && (Date.now() - cached.timestamp) < this.config.cacheTimeout) {
        this.metrics.cacheHits++;
        return cached.data;
      }
    }

    let lastError = null;

    // Try each endpoint
    for (const endpoint of this.getOrderedEndpoints()) {
      try {
        const result = await this.makeRequest(endpoint, path, options);

        // Update health status
        this.updateEndpointHealth(endpoint, true, Date.now() - startTime);
        this.activeEndpoint = endpoint;

        // Cache successful GET requests
        if (this.config.enableCaching && (!options.method || options.method === 'GET')) {
          const cacheKey = this.getCacheKey(path, options);
          this.cache.set(cacheKey, {
            data: result,
            timestamp: Date.now()
          });
        }

        // Update metrics
        this.updateMetrics(Date.now() - startTime, false);

        return result;

      } catch (error) {
        this.updateEndpointHealth(endpoint, false);
        lastError = error;
        console.warn(`[${this.serviceName}] API endpoint ${endpoint} failed:`, error.message);
      }
    }

    // All endpoints failed
    this.metrics.errors++;
    this.updateMetrics(Date.now() - startTime, true);
    throw new Error(`All API endpoints failed. Last error: ${lastError?.message}`);
  }

  /**
   * Service-specific convenience methods
   */

  // Authentication & Registration
  async register(data) {
    return this.request('/api/v1/register', {
      method: 'POST',
      data: {
        service: this.serviceName,
        timestamp: new Date().toISOString(),
        deploymentType: this.detectDeploymentType(),
        ...data
      }
    });
  }

  async authenticate(credentials) {
    return this.request('/api/v1/auth', {
      method: 'POST',
      data: credentials
    });
  }

  // Health & Status
  async getStatus() {
    return this.request('/api/v1/status');
  }

  async heartbeat() {
    return this.request('/api/v1/heartbeat', {
      method: 'POST',
      data: {
        service: this.serviceName,
        timestamp: new Date().toISOString(),
        metrics: this.getMetrics()
      }
    });
  }

  // File Operations (CopyParty integration)
  async uploadFile(file, path = '') {
    return this.request('/api/v1/files/upload', {
      method: 'POST',
      data: { file, path },
      headers: { 'Content-Type': 'multipart/form-data' }
    });
  }

  async downloadFile(filePath) {
    return this.request(`/api/v1/files/download/${encodeURIComponent(filePath)}`);
  }

  async listFiles(directory = '') {
    return this.request(`/api/v1/files/list?path=${encodeURIComponent(directory)}`);
  }

  // TTS Services (Legacy compatibility)
  async synthesizeText(text, options = {}) {
    return this.request('/api/v1/tts/synthesize', {
      method: 'POST',
      data: { text, ...options }
    });
  }

  // User Management
  async createUser(userData) {
    return this.request('/api/v1/users', {
      method: 'POST',
      data: userData
    });
  }

  async getUser(userId) {
    return this.request(`/api/v1/users/${userId}`);
  }

  async updateUser(userId, data) {
    return this.request(`/api/v1/users/${userId}`, {
      method: 'PUT',
      data
    });
  }

  // Settings & Configuration
  async getConfig(key = null) {
    const path = key ? `/api/v1/config/${key}` : '/api/v1/config';
    return this.request(path);
  }

  async setConfig(key, value) {
    return this.request(`/api/v1/config/${key}`, {
      method: 'PUT',
      data: { value }
    });
  }

  // Extension Assignment (FlexPhone/PBX)
  async requestExtension(username, preferredExtension = null, domain = null) {
    return this.request('/api/v1/extensions/request', {
      method: 'POST',
      data: { username, preferredExtension, domain }
    });
  }

  async releaseExtension(extensionId) {
    return this.request(`/api/v1/extensions/${extensionId}/release`, {
      method: 'DELETE'
    });
  }

  // Service Discovery
  async discoverServices() {
    return this.request('/api/v1/services/discover');
  }

  async registerService(serviceInfo) {
    return this.request('/api/v1/services/register', {
      method: 'POST',
      data: serviceInfo
    });
  }

  // eCripto Blockchain Methods
  async getEcriptoHealth() {
    return this.request('/api/health', { ecripto: true });
  }

  async getWalletBalance(address) {
    return this.request('/api/wallet/balance', {
      method: 'POST',
      data: { address },
      ecripto: true
    });
  }

  async createWallet(options = {}) {
    return this.request('/api/wallet/create', {
      method: 'POST',
      data: options,
      ecripto: true
    });
  }

  async claimFaucet(address) {
    return this.request('/api/faucet/claim', {
      method: 'POST',
      data: { address },
      ecripto: true
    });
  }

  async createPayment(paymentData) {
    return this.request('/api/payment/create', {
      method: 'POST',
      data: paymentData,
      ecripto: true
    });
  }

  async confirmPayment(paymentId, txHash) {
    return this.request('/api/payment/confirm', {
      method: 'POST',
      data: { paymentId, txHash },
      ecripto: true
    });
  }

  async getStakingInfo(address) {
    return this.request('/api/staking/info', {
      method: 'POST',
      data: { address },
      ecripto: true
    });
  }

  async stakeECRP(address, amount) {
    return this.request('/api/staking/stake', {
      method: 'POST',
      data: { address, amount },
      ecripto: true
    });
  }

  async generateBTCAddress(walletAddress) {
    return this.request('/api/btc/generate-address', {
      method: 'POST',
      data: { walletAddress },
      ecripto: true
    });
  }

  async getBTCExchangeInfo() {
    return this.request('/api/btc/exchange-info', { ecripto: true });
  }

  async getExchangeRates() {
    return this.request('/api/exchange-rates', { ecripto: true });
  }

  async getServices() {
    return this.request('/api/services/list', { ecripto: true });
  }

  async purchaseService(serviceId, walletAddress, amount) {
    return this.request('/api/services/purchase', {
      method: 'POST',
      data: { serviceId, walletAddress, amount },
      ecripto: true
    });
  }

  /**
   * Internal methods
   */

  getOrderedEndpoints() {
    // Sort endpoints by health (best first)
    return [...this.config.endpoints].sort((a, b) => {
      const healthA = this.endpointHealth.get(a);
      const healthB = this.endpointHealth.get(b);

      // Prioritize healthy endpoints
      if (healthA.status === 'healthy' && healthB.status !== 'healthy') return -1;
      if (healthB.status === 'healthy' && healthA.status !== 'healthy') return 1;

      // Then by consecutive failures (fewer is better)
      if (healthA.consecutiveFailures !== healthB.consecutiveFailures) {
        return healthA.consecutiveFailures - healthB.consecutiveFailures;
      }

      // Finally by response time
      return healthA.responseTime - healthB.responseTime;
    });
  }

  async makeRequest(endpoint, path, options) {
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.config.useSSL ? 'https' : 'http'}://${endpoint}:${this.config.port}${path}`);
      const isHTTPS = this.config.useSSL;

      const requestOptions = {
        hostname: url.hostname,
        port: url.port || this.config.port,
        path: url.pathname + url.search,
        method: options.method || 'GET',
        headers: {
          'User-Agent': this.config.userAgent,
          'Content-Type': 'application/json',
          'X-Service-Name': this.serviceName,
          ...options.headers
        },
        timeout: this.config.timeout
      };

      if (this.config.apiKey) {
        requestOptions.headers['Authorization'] = `Bearer ${this.config.apiKey}`;
      }

      let postData = '';
      if (options.data) {
        postData = JSON.stringify(options.data);
        requestOptions.headers['Content-Length'] = Buffer.byteLength(postData);
      }

      const req = (isHTTPS ? https : http).request(requestOptions, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const result = res.headers['content-type']?.includes('application/json')
              ? JSON.parse(data)
              : data;

            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(result);
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${result.message || data}`));
            }
          } catch (error) {
            reject(new Error(`Invalid JSON response: ${data}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      if (postData) {
        req.write(postData);
      }

      req.end();
    });
  }

  updateEndpointHealth(endpoint, success, responseTime = 0) {
    const health = this.endpointHealth.get(endpoint);
    if (!health) return;

    health.lastCheck = Date.now();
    health.responseTime = responseTime;

    if (success) {
      health.status = 'healthy';
      health.consecutiveFailures = 0;
    } else {
      health.consecutiveFailures++;
      if (health.consecutiveFailures >= 3) {
        health.status = 'unhealthy';
      }

      // Track failures in metrics
      const current = this.metrics.endpointFailures.get(endpoint) || 0;
      this.metrics.endpointFailures.set(endpoint, current + 1);
    }
  }

  updateMetrics(responseTime, isError) {
    if (isError) {
      this.metrics.errors++;
    } else {
      // Update average response time
      this.metrics.avgResponseTime =
        (this.metrics.avgResponseTime + responseTime) / 2;
    }
  }

  getCacheKey(path, options) {
    return crypto.createHash('md5')
      .update(`${path}${JSON.stringify(options.data || {})}`)
      .digest('hex');
  }

  detectDeploymentType() {
    // Detect how the application was deployed
    if (process.pkg) return 'packaged';
    if (process.platform === 'darwin' && process.execPath.includes('.app')) return 'app';
    if (process.execPath.includes('node_modules')) return 'development';
    return 'unknown';
  }

  getMetrics() {
    return {
      ...this.metrics,
      endpointHealth: Array.from(this.endpointHealth.entries()),
      cacheSize: this.cache.size,
      activeEndpoint: this.activeEndpoint
    };
  }

  // Cache management
  clearCache() {
    this.cache.clear();
  }

  // Health check for all endpoints
  async checkAllEndpoints() {
    const results = {};

    for (const endpoint of this.config.endpoints) {
      try {
        const startTime = Date.now();
        await this.makeRequest(endpoint, '/api/v1/status', {});
        const responseTime = Date.now() - startTime;

        results[endpoint] = {
          status: 'healthy',
          responseTime,
          timestamp: new Date().toISOString()
        };

        this.updateEndpointHealth(endpoint, true, responseTime);
      } catch (error) {
        results[endpoint] = {
          status: 'unhealthy',
          error: error.message,
          timestamp: new Date().toISOString()
        };

        this.updateEndpointHealth(endpoint, false);
      }
    }

    return results;
  }
}

// Export for use in other projects
module.exports = {
  UniversalAPIClient,

  // Convenience factory functions
  createAPIClient: (serviceName, config) => new UniversalAPIClient(serviceName, config),

  // Quick setup for common use cases
  setupFlexPBXAPI: () => new UniversalAPIClient('flexpbx'),
  setupTTSAPI: () => new UniversalAPIClient('tts'),
  setupFileAPI: () => new UniversalAPIClient('files'),
  setupUserAPI: () => new UniversalAPIClient('users'),
  setupEcriptoAPI: () => new UniversalAPIClient('ecripto', {
    endpoints: ['ecripto.app', 'localhost:3456'],
    port: 443,
    useSSL: true
  })
};