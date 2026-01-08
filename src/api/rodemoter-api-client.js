/**
 * Universal API Client for all services
 * Simple client implementation based on universal-api-config.js
 * Version: 2.0.0
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const os = require('os');

class UniversalAPIClient {
  constructor(serviceName, config = {}) {
    this.serviceName = serviceName;

    // Try to load the API configuration
    try {
      const apiConfig = require('./api-config.js');
      this.config = { ...apiConfig, ...config };
    } catch (error) {
      console.warn('Could not load api-config.js, using defaults');
      this.config = this.getDefaultConfig();
    }

    // User ownership mapping
    this.appOwnership = {
      'bema': { owner: 'dom', type: 'personal', access: 'restricted' },
      'Rodemoter': { owner: 'tetoeehoward', type: 'personal', access: 'restricted' },
      'Rotomoter': { owner: 'tetoeehoward', type: 'personal', access: 'restricted' },
      'tappedin-apps': { owner: 'tappedin', type: 'organization', access: 'shared' },
      'flex pbx': { owner: 'devinecr', type: 'system', access: 'admin' },
      'openlink': { owner: 'devinecr', type: 'utility', access: 'public' },
      'openlink-desktop': { owner: 'devinecr', type: 'utility', access: 'public' },
      'ask-ai': { owner: 'devinecr', type: 'utility', access: 'public' },
      'audio-portrait': { owner: 'devinecr', type: 'creative', access: 'public' }
    };

    this.activeEndpoint = null;
    this.endpointHealth = new Map();
    this.cache = new Map();
  }

  getDefaultConfig() {
    return {
      primaryAPI: {
        baseUrl: 'https://api.devine-creations.com',
        endpoints: {
          status: '/api/v1/status',
          register: '/api/v1/register',
          heartbeat: '/api/v1/heartbeat'
        }
      },
      fallbackEndpoints: [
        {
          baseUrl: 'https://api.devinecreations.net',
          endpoints: {
            status: '/api/v1/status',
            register: '/api/v1/register'
          }
        }
      ],
      networking: {
        timeout: 10000,
        retries: 3,
        retryDelay: 1000,
        useSSL: true
      }
    };
  }

  // Get app ownership info
  getAppOwnership() {
    const ownership = this.appOwnership[this.serviceName] || {
      owner: 'unknown',
      type: 'unknown',
      access: 'unknown'
    };
    return ownership;
  }

  // Simple API request method
  async request(endpoint, options = {}) {
    const endpoints = this.getAllEndpoints();
    let lastError = null;

    for (const apiEndpoint of endpoints) {
      try {
        const result = await this.makeRequest(apiEndpoint, endpoint, options);
        this.activeEndpoint = apiEndpoint.baseUrl;
        return result;
      } catch (error) {
        lastError = error;
        console.warn(`API endpoint ${apiEndpoint.baseUrl} failed:`, error.message);
      }
    }

    throw new Error(`All API endpoints failed. Last error: ${lastError?.message}`);
  }

  getAllEndpoints() {
    const endpoints = [this.config.primaryAPI];
    if (this.config.fallbackEndpoints) {
      endpoints.push(...this.config.fallbackEndpoints);
    }
    return endpoints;
  }

  async makeRequest(apiEndpoint, path, options) {
    return new Promise((resolve, reject) => {
      const url = new URL(`${apiEndpoint.baseUrl}${path}`);
      const isHTTPS = url.protocol === 'https:';

      const requestOptions = {
        hostname: url.hostname,
        port: url.port || (isHTTPS ? 443 : 80),
        path: url.pathname + url.search,
        method: options.method || 'GET',
        headers: {
          'User-Agent': `${this.serviceName}/2.0.0`,
          'Content-Type': 'application/json',
          'X-Service-Name': this.serviceName,
          'X-App-Owner': this.getAppOwnership().owner,
          'X-App-Type': this.getAppOwnership().type,
          ...options.headers
        },
        timeout: this.config.networking?.timeout || 10000
      };

      if (this.config.primaryAPI?.authentication?.apiKey) {
        requestOptions.headers['Authorization'] = `Bearer ${this.config.primaryAPI.authentication.apiKey}`;
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

  // Convenience methods for common operations

  async getStatus() {
    const endpoint = this.config.primaryAPI?.endpoints?.status || '/api/v1/status';
    return this.request(endpoint);
  }

  async register(additionalData = {}) {
    const endpoint = this.config.primaryAPI?.endpoints?.register || '/api/v1/register';
    const ownership = this.getAppOwnership();

    const data = {
      service: this.serviceName,
      owner: ownership.owner,
      type: ownership.type,
      access: ownership.access,
      platform: process.platform,
      arch: process.arch,
      version: '2.0.0',
      timestamp: new Date().toISOString(),
      hostname: os.hostname(),
      username: os.userInfo().username,
      ...additionalData
    };

    return this.request(endpoint, {
      method: 'POST',
      data
    });
  }

  async heartbeat() {
    const endpoint = this.config.primaryAPI?.endpoints?.heartbeat || '/api/v1/heartbeat';
    const ownership = this.getAppOwnership();

    const data = {
      service: this.serviceName,
      owner: ownership.owner,
      timestamp: new Date().toISOString(),
      status: 'active'
    };

    return this.request(endpoint, {
      method: 'POST',
      data
    });
  }

  // File operations
  async uploadFile(filePath, targetPath = '') {
    const endpoint = this.config.primaryAPI?.endpoints?.uploadFile || '/api/v1/files/upload';
    // Implementation would handle file upload
    return this.request(endpoint, {
      method: 'POST',
      data: { filePath, targetPath }
    });
  }

  async listFiles(directory = '') {
    const endpoint = this.config.primaryAPI?.endpoints?.listFiles || '/api/v1/files/list';
    return this.request(`${endpoint}?path=${encodeURIComponent(directory)}`);
  }

  // TTS operations (if supported)
  async synthesizeText(text, options = {}) {
    const endpoint = this.config.primaryAPI?.endpoints?.synthesize || '/api/v1/synthesize';
    return this.request(endpoint, {
      method: 'POST',
      data: { text, ...options }
    });
  }

  // User operations
  async createUser(userData) {
    const endpoint = this.config.primaryAPI?.endpoints?.createUser || '/api/v1/users';
    return this.request(endpoint, {
      method: 'POST',
      data: userData
    });
  }

  async getUser(userId) {
    const endpoint = this.config.primaryAPI?.endpoints?.getUser || '/api/v1/users';
    return this.request(`${endpoint}/${userId}`);
  }

  // Configuration
  async getConfig(key = null) {
    const endpoint = this.config.primaryAPI?.endpoints?.config || '/api/v1/config';
    const path = key ? `${endpoint}/${key}` : endpoint;
    return this.request(path);
  }

  async setConfig(key, value) {
    const endpoint = this.config.primaryAPI?.endpoints?.config || '/api/v1/config';
    return this.request(`${endpoint}/${key}`, {
      method: 'PUT',
      data: { value }
    });
  }

  // Health check
  async checkHealth() {
    try {
      const result = await this.getStatus();
      return {
        healthy: true,
        endpoint: this.activeEndpoint,
        response: result
      };
    } catch (error) {
      return {
        healthy: false,
        error: error.message
      };
    }
  }
}

// Export for use in applications
module.exports = {
  UniversalAPIClient,

  // Factory function
  createAPIClient: (serviceName, config) => {
    return new UniversalAPIClient(serviceName, config);
  },

  // Quick setup for specific services
  setupAppAPI: (appName) => {
    return new UniversalAPIClient(appName);
  }
};

// Example usage:
// const { createAPIClient } = require('./api-client');
// const api = createAPIClient('your-app-name');
//
// // Register the app
// api.register().then(result => console.log('Registered:', result));
//
// // Check status
// api.getStatus().then(status => console.log('Status:', status));
//
// // Send heartbeat
// api.heartbeat().then(result => console.log('Heartbeat:', result));