/**
 * OpenLink Monitor Service
 * Reports instance status to a central hub for distributed deployments
 */

const https = require('https');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const Store = require('electron-store');
const log = require('electron-log');

class MonitorService {
    constructor(options = {}) {
        this.options = {
            hubUrl: options.hubUrl || 'https://openlink.raywonderis.me',
            reportInterval: options.reportInterval || 60000, // 1 minute
            enabled: options.enabled !== false,
            ...options
        };

        this.store = new Store({ name: 'openlink-monitor' });
        this.instanceId = this.store.get('instanceId') || this.generateInstanceId();
        this.store.set('instanceId', this.instanceId);

        this.status = {
            online: false,
            hosting: false,
            sessionId: null,
            connectedClients: 0,
            lastReport: null,
            errors: []
        };

        this.reportTimer = null;
        this.eventLog = [];
        this.maxEventLogSize = 100;
    }

    /**
     * Generate unique instance ID
     */
    generateInstanceId() {
        return crypto.randomBytes(16).toString('hex');
    }

    /**
     * Start reporting to hub
     */
    start() {
        if (!this.options.enabled) {
            log.info('[Monitor] Disabled, not starting');
            return;
        }

        this.status.online = true;
        this.sendReport('startup');

        this.reportTimer = setInterval(() => {
            this.sendReport('heartbeat');
        }, this.options.reportInterval);

        log.info(`[Monitor] Started reporting to ${this.options.hubUrl}`);
    }

    /**
     * Stop reporting
     */
    stop() {
        if (this.reportTimer) {
            clearInterval(this.reportTimer);
            this.reportTimer = null;
        }

        this.status.online = false;
        this.sendReport('shutdown');

        log.info('[Monitor] Stopped reporting');
    }

    /**
     * Update status
     * @param {object} updates - Status fields to update
     */
    updateStatus(updates) {
        Object.assign(this.status, updates);

        // Immediately report significant changes
        if ('hosting' in updates || 'sessionId' in updates || 'connectedClients' in updates) {
            this.sendReport('status-change');
        }
    }

    /**
     * Log an event
     * @param {string} eventType - Type of event
     * @param {object} data - Event data
     */
    logEvent(eventType, data = {}) {
        const event = {
            type: eventType,
            timestamp: new Date().toISOString(),
            data
        };

        this.eventLog.push(event);

        // Trim event log if too large
        if (this.eventLog.length > this.maxEventLogSize) {
            this.eventLog = this.eventLog.slice(-this.maxEventLogSize);
        }

        // Report event to hub
        this.sendEvent(event);
    }

    /**
     * Send report to hub
     * @param {string} eventType - Type of report
     */
    async sendReport(eventType = 'heartbeat') {
        if (!this.options.enabled) return;

        const report = {
            instanceId: this.instanceId,
            eventType,
            timestamp: new Date().toISOString(),
            version: this.getVersion(),
            status: {
                ...this.status,
                hostname: os.hostname(),
                platform: os.platform(),
                arch: os.arch(),
                uptime: os.uptime(),
                nodeVersion: process.version,
                memoryUsage: process.memoryUsage(),
                cpuUsage: process.cpuUsage()
            }
        };

        try {
            await this.postToHub('/api/v2/monitor/report', report);
            this.status.lastReport = new Date().toISOString();
            this.status.errors = [];
        } catch (error) {
            log.debug(`[Monitor] Report failed: ${error.message}`);
            this.status.errors.push({
                time: new Date().toISOString(),
                error: error.message
            });
            // Keep only last 5 errors
            if (this.status.errors.length > 5) {
                this.status.errors = this.status.errors.slice(-5);
            }
        }
    }

    /**
     * Send event to hub
     * @param {object} event - Event to send
     */
    async sendEvent(event) {
        if (!this.options.enabled) return;

        try {
            await this.postToHub('/api/v2/monitor/report', {
                instanceId: this.instanceId,
                ...event
            });
        } catch (error) {
            log.debug(`[Monitor] Event send failed: ${error.message}`);
        }
    }

    /**
     * Get all instances from hub
     * @returns {array} List of instances
     */
    async getInstances() {
        try {
            const response = await this.getFromHub('/api/v2/monitor/instances');
            return response?.instances || [];
        } catch (error) {
            log.error(`[Monitor] Failed to get instances: ${error.message}`);
            return [];
        }
    }

    /**
     * Get alerts from hub
     * @returns {array} List of alerts
     */
    async getAlerts() {
        try {
            const response = await this.getFromHub('/api/v2/monitor/alerts');
            return response?.alerts || [];
        } catch (error) {
            log.error(`[Monitor] Failed to get alerts: ${error.message}`);
            return [];
        }
    }

    /**
     * HTTP POST to hub
     * @param {string} path - API path
     * @param {object} data - Data to send
     */
    postToHub(path, data) {
        return new Promise((resolve, reject) => {
            const url = new URL(this.options.hubUrl + path);
            const isHttps = url.protocol === 'https:';
            const postData = JSON.stringify(data);

            const options = {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData),
                    'X-Instance-ID': this.instanceId,
                    'User-Agent': 'OpenLink-Monitor/1.0'
                },
                timeout: 10000
            };

            const client = isHttps ? https : http;
            const req = client.request(options, (res) => {
                let responseData = '';
                res.on('data', chunk => responseData += chunk);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(responseData));
                    } catch (e) {
                        resolve({ raw: responseData });
                    }
                });
            });

            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });
            req.write(postData);
            req.end();
        });
    }

    /**
     * HTTP GET from hub
     * @param {string} path - API path
     */
    getFromHub(path) {
        return new Promise((resolve, reject) => {
            const url = new URL(this.options.hubUrl + path);
            const isHttps = url.protocol === 'https:';

            const options = {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname,
                headers: {
                    'X-Instance-ID': this.instanceId,
                    'User-Agent': 'OpenLink-Monitor/1.0'
                },
                timeout: 10000
            };

            const client = isHttps ? https : http;
            client.get(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        resolve({ raw: data });
                    }
                });
            }).on('error', reject);
        });
    }

    /**
     * Get current status
     * @returns {object} Current status
     */
    getStatus() {
        return {
            instanceId: this.instanceId,
            enabled: this.options.enabled,
            hubUrl: this.options.hubUrl,
            reportInterval: this.options.reportInterval,
            ...this.status,
            eventLogSize: this.eventLog.length
        };
    }

    /**
     * Get recent events
     * @param {number} count - Number of events to return
     * @returns {array} Recent events
     */
    getRecentEvents(count = 20) {
        return this.eventLog.slice(-count);
    }

    /**
     * Get app version
     * @returns {string} App version
     */
    getVersion() {
        try {
            const pkg = require('../../package.json');
            return pkg.version;
        } catch (e) {
            return 'unknown';
        }
    }

    /**
     * Set enabled state
     * @param {boolean} enabled - Whether monitoring is enabled
     */
    setEnabled(enabled) {
        if (enabled && !this.options.enabled) {
            this.options.enabled = true;
            this.start();
        } else if (!enabled && this.options.enabled) {
            this.stop();
            this.options.enabled = false;
        }
    }

    /**
     * Set hub URL
     * @param {string} url - Hub URL
     */
    setHubUrl(url) {
        this.options.hubUrl = url;
        this.store.set('hubUrl', url);
        log.info(`[Monitor] Hub URL changed to ${url}`);
    }
}

module.exports = MonitorService;
