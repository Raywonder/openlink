#!/usr/bin/env node

/**
 * OpenLink Network Manager
 * Handles online/offline connectivity with automatic IP-based fallback
 * Online mode: Uses domains with SSL
 * Offline mode: Uses direct IP addresses on local network
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const WebSocket = require('ws');
const https = require('https');
const http = require('http');
const path = require('path');

class NetworkManager {
    constructor() {
        // Server configurations with both domain and IP endpoints
        this.serverConfigs = [
            {
                name: 'Local Mac Mini',
                online: { url: 'ws://localhost:8765', ssl: false },
                offline: { ip: '10.0.0.156', port: 8765, ssl: false },
                type: 'local',
                priority: 1
            },
            {
                name: 'Main Server (raywonderis.me)',
                online: { url: 'wss://openlink.raywonderis.me', ssl: true },
                offline: { ip: '64.20.46.178', port: 8765, ssl: false },
                type: 'primary',
                priority: 2
            },
            {
                name: 'VPS1 TappedIn',
                online: { url: 'ws://vps1.tappedin.fm:8765', ssl: false },
                offline: { ip: '64.20.46.178', port: 8765, ssl: false }, // Same as main for now
                type: 'fallback',
                priority: 3
            },
            {
                name: 'TappedIn Server',
                online: { url: 'wss://openlink.tappedin.fm', ssl: true },
                offline: { ip: '64.20.46.178', port: 8765, ssl: false }, // Same as main for now
                type: 'fallback',
                priority: 4
            }
        ];

        this.currentMode = 'auto'; // auto, online, offline
        this.networkStatus = null;
        this.localIP = null;
        this.publicIP = null;
    }

    /**
     * Detect current network status and set appropriate mode
     */
    async detectNetworkMode() {
        console.log('🔍 Detecting network connectivity...\n');

        // Get local IP
        this.localIP = await this.getLocalIP();
        console.log(`📱 Local IP: ${this.localIP || 'Not found'}`);

        // Test internet connectivity
        const hasInternet = await this.testInternetConnectivity();
        console.log(`🌐 Internet: ${hasInternet ? 'Connected' : 'Offline'}`);

        if (hasInternet) {
            // Get public IP
            this.publicIP = await this.getPublicIP();
            console.log(`🌍 Public IP: ${this.publicIP || 'Not detected'}`);
        }

        // Test local network connectivity
        const localNetwork = await this.testLocalNetwork();
        console.log(`🏠 Local Network: ${localNetwork ? 'Connected' : 'Offline'}`);

        // Determine optimal mode (only if auto-detecting)
        if (this.currentMode === 'auto') {
            if (hasInternet) {
                this.currentMode = 'online';
                console.log(`✅ Auto-detected: ONLINE (using domains with SSL)`);
            } else if (localNetwork) {
                this.currentMode = 'offline';
                console.log(`📡 Auto-detected: OFFLINE (using direct IPs on local network)`);
            } else {
                this.currentMode = 'offline';
                console.log(`⚠️ Auto-detected: OFFLINE (limited connectivity - using localhost only)`);
            }
        } else {
            console.log(`🔧 Forced mode: ${this.currentMode.toUpperCase()} (using ${this.currentMode === 'offline' ? 'direct IPs' : 'domains'})`);
        }

        this.networkStatus = {
            mode: this.currentMode,
            hasInternet,
            localNetwork,
            localIP: this.localIP,
            publicIP: this.publicIP,
            timestamp: new Date()
        };

        return this.networkStatus;
    }

    /**
     * Get local IP address
     */
    async getLocalIP() {
        try {
            const { stdout } = await execAsync('ifconfig | grep "inet " | grep -v "127.0.0.1" | head -1');
            const match = stdout.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/);
            return match ? match[1] : null;
        } catch (error) {
            console.warn(`⚠️ Could not detect local IP: ${error.message}`);
            return null;
        }
    }

    /**
     * Test internet connectivity
     */
    async testInternetConnectivity() {
        try {
            // Test multiple endpoints for reliability
            const testSites = ['8.8.8.8', 'cloudflare.com', 'google.com'];

            for (const site of testSites) {
                try {
                    await execAsync(`ping -c 1 -W 3000 ${site}`, { timeout: 5000 });
                    return true;
                } catch (error) {
                    // Continue to next site
                }
            }
            return false;
        } catch (error) {
            return false;
        }
    }

    /**
     * Get public IP address
     */
    async getPublicIP() {
        const services = [
            'https://api.ipify.org',
            'https://ifconfig.me/ip',
            'https://icanhazip.com'
        ];

        for (const service of services) {
            try {
                const response = await this.httpRequest(service, { timeout: 5000 });
                const ip = response.trim();
                if (ip.match(/^\d+\.\d+\.\d+\.\d+$/)) {
                    return ip;
                }
            } catch (error) {
                // Try next service
            }
        }
        return null;
    }

    /**
     * Test local network connectivity
     */
    async testLocalNetwork() {
        if (!this.localIP) return false;

        try {
            // Try to ping the gateway
            const gateway = this.localIP.replace(/\.\d+$/, '.1');
            await execAsync(`ping -c 1 -W 2000 ${gateway}`, { timeout: 3000 });
            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Get optimal servers for current network mode
     */
    getOptimalServers() {
        const servers = [];

        for (const config of this.serverConfigs.sort((a, b) => a.priority - b.priority)) {
            if (this.currentMode === 'online') {
                // Use domain endpoints with SSL
                servers.push({
                    name: config.name,
                    url: config.online.url,
                    ssl: config.online.ssl,
                    type: config.type,
                    mode: 'online'
                });
            } else {
                // Use direct IP endpoints
                if (config.type === 'local' && this.localIP) {
                    // Local server - use detected local IP or localhost
                    servers.push({
                        name: config.name,
                        url: `ws://${this.localIP}:${config.offline.port}`,
                        ssl: false,
                        type: config.type,
                        mode: 'offline',
                        ip: this.localIP,
                        port: config.offline.port
                    });
                } else if (config.offline.ip) {
                    // Remote server via direct IP (works with public IP if internet available)
                    servers.push({
                        name: config.name + ' (Direct IP)',
                        url: `ws://${config.offline.ip}:${config.offline.port}`,
                        ssl: false,
                        type: config.type,
                        mode: 'offline',
                        ip: config.offline.ip,
                        port: config.offline.port
                    });
                }
            }
        }

        return servers;
    }

    /**
     * Test server connectivity based on current mode
     */
    async testServer(server) {
        console.log(`🔍 Testing ${server.name} (${server.mode} mode)...`);

        return new Promise((resolve) => {
            const ws = new WebSocket(server.url);
            const timeout = setTimeout(() => {
                ws.terminate();
                resolve({
                    ...server,
                    online: false,
                    status: 'Connection timeout',
                    responseTime: null
                });
            }, 5000);

            const startTime = Date.now();

            ws.on('open', () => {
                const responseTime = Date.now() - startTime;
                clearTimeout(timeout);
                ws.close();
                resolve({
                    ...server,
                    online: true,
                    status: `Connected (${responseTime}ms)`,
                    responseTime
                });
            });

            ws.on('error', (error) => {
                const responseTime = Date.now() - startTime;
                clearTimeout(timeout);
                resolve({
                    ...server,
                    online: false,
                    status: `Error: ${error.message}`,
                    responseTime
                });
            });
        });
    }

    /**
     * Run comprehensive network and server testing
     */
    async runDiagnostic() {
        console.log('🌐 OpenLink Network Manager - Comprehensive Diagnostic\n');

        // Detect network mode (preserves forced mode automatically)
        await this.detectNetworkMode();

        console.log(`\n🎯 Testing servers in ${this.currentMode.toUpperCase()} mode...\n`);

        // Get optimal servers for current mode
        const servers = this.getOptimalServers();

        if (servers.length === 0) {
            console.log('❌ No servers available for current network configuration');
            return { networkStatus: this.networkStatus, servers: [], recommendations: this.getRecommendations([]) };
        }

        // Test all servers
        const results = [];
        for (const server of servers) {
            const result = await this.testServer(server);
            results.push(result);

            const statusIcon = result.online ? '✅' : '❌';
            const responseInfo = result.responseTime ? ` (${result.responseTime}ms)` : '';
            console.log(`${statusIcon} ${server.name}: ${result.status}${responseInfo}`);
        }

        // Generate recommendations
        const recommendations = this.getRecommendations(results);

        console.log(`\n📊 Summary:`);
        console.log(`   🌐 Network Mode: ${this.currentMode.toUpperCase()}`);
        console.log(`   ✅ Online Servers: ${results.filter(r => r.online).length}/${results.length}`);
        console.log(`   📡 Local IP: ${this.localIP || 'Not detected'}`);
        if (this.publicIP) {
            console.log(`   🌍 Public IP: ${this.publicIP}`);
        }

        console.log(`\n💡 Recommendations:`);
        recommendations.forEach((rec, i) => {
            console.log(`   ${i + 1}. ${rec}`);
        });

        return {
            networkStatus: this.networkStatus,
            servers: results,
            recommendations
        };
    }

    /**
     * Generate recommendations based on test results
     */
    getRecommendations(results) {
        const recommendations = [];
        const onlineServers = results.filter(r => r.online);
        const offlineServers = results.filter(r => !r.online);

        if (this.currentMode === 'offline') {
            recommendations.push('📡 OFFLINE MODE: Using direct IP connections (local network or public IP)');

            if (onlineServers.length === 0) {
                recommendations.push('❌ No servers reachable via IP - check network connectivity');
                recommendations.push('🔧 Start local signaling server: cd electron && node src/signaling-server.js');
            } else {
                recommendations.push(`✅ ${onlineServers.length} server(s) reachable via direct IP`);
                recommendations.push('💡 For Windows PC: Use these IP-based URLs:');
                onlineServers.forEach(server => {
                    if (server.ip) {
                        const ipType = server.ip.startsWith('10.') || server.ip.startsWith('192.168.') || server.ip.startsWith('172.') ? 'Local' : 'Public';
                        recommendations.push(`   📍 ${server.name}: ws://${server.ip}:${server.port} (${ipType} IP)`);
                    } else {
                        recommendations.push(`   📍 ${server.name}: ${server.url}`);
                    }
                });
            }
        } else {
            recommendations.push('🌐 ONLINE MODE: Using domain endpoints with SSL');

            if (onlineServers.length < 2) {
                recommendations.push('⚠️ Limited server availability - consider fixing SSL certificates');
                recommendations.push('🔧 Run: node tools/ssl-manager.js setup');
            } else {
                recommendations.push(`✅ ${onlineServers.length} domain server(s) available`);
            }
        }

        // Windows PC specific recommendations
        recommendations.push('🖥️ For Windows PC configuration:');
        if (this.currentMode === 'offline') {
            recommendations.push(`   📱 Mac Mini IP: ws://${this.localIP || 'localhost'}:8765`);
            recommendations.push('   ⚠️ Ensure both devices on same local network');
        } else {
            const workingDomains = onlineServers.filter(s => s.ssl).map(s => s.url);
            if (workingDomains.length > 0) {
                recommendations.push(`   🔒 Use HTTPS domains: ${workingDomains[0]}`);
            }
        }

        return recommendations;
    }

    /**
     * Force switch network mode
     */
    async setMode(mode) {
        if (!['online', 'offline', 'auto'].includes(mode)) {
            throw new Error('Invalid mode. Use: online, offline, or auto');
        }

        console.log(`🔄 Switching to ${mode.toUpperCase()} mode...`);

        if (mode === 'auto') {
            await this.detectNetworkMode();
        } else {
            this.currentMode = mode;
        }

        console.log(`✅ Mode set to: ${this.currentMode.toUpperCase()}`);
        return this.currentMode;
    }

    /**
     * Get connection configuration for OpenLink app
     */
    getConnectionConfig() {
        const servers = this.getOptimalServers().filter(server => {
            // Only return servers that are likely to work
            return server.mode === this.currentMode;
        });

        return {
            mode: this.currentMode,
            networkStatus: this.networkStatus,
            preferredServers: servers.slice(0, 3), // Top 3 servers
            fallbackServers: servers.slice(3),
            localEndpoint: this.localIP ? `ws://${this.localIP}:8765` : 'ws://localhost:8765',
            recommendations: this.getRecommendations([])
        };
    }

    /**
     * HTTP request helper
     */
    httpRequest(url, options = {}) {
        return new Promise((resolve, reject) => {
            const client = url.startsWith('https://') ? https : http;
            const req = client.request(url, {
                timeout: options.timeout || 10000,
                rejectUnauthorized: false // Allow self-signed certs
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(data));
            });

            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });

            req.end();
        });
    }
}

// CLI Interface
async function main() {
    const networkManager = new NetworkManager();
    const args = process.argv.slice(2);
    const command = args[0];
    const param = args[1];

    switch (command) {
        case 'detect':
            await networkManager.detectNetworkMode();
            break;

        case 'test':
            await networkManager.runDiagnostic();
            break;

        case 'mode':
            if (!param || !['online', 'offline', 'auto'].includes(param)) {
                console.error('❌ Usage: node network-manager.js mode <online|offline|auto>');
                process.exit(1);
            }
            await networkManager.setMode(param);
            break;

        case 'config':
            await networkManager.detectNetworkMode();
            const config = networkManager.getConnectionConfig();
            console.log('🔧 OpenLink Connection Configuration:\n');
            console.log(JSON.stringify(config, null, 2));
            break;

        case 'ip':
            const localIP = await networkManager.getLocalIP();
            const publicIP = await networkManager.getPublicIP();
            console.log(`📱 Local IP: ${localIP || 'Not found'}`);
            if (publicIP) {
                console.log(`🌍 Public IP: ${publicIP}`);
            }
            break;

        default:
            console.log(`
🌐 OpenLink Network Manager

Handles online/offline connectivity with automatic IP-based fallback.
- ONLINE mode: Uses domains with SSL certificates
- OFFLINE mode: Uses direct IP addresses on local network

Usage:
  node network-manager.js detect                  - Detect current network mode
  node network-manager.js test                    - Run full network diagnostic
  node network-manager.js mode <online|offline|auto>  - Set network mode
  node network-manager.js config                  - Get OpenLink connection config
  node network-manager.js ip                      - Show IP addresses

Examples:
  node network-manager.js detect                  - Auto-detect best mode
  node network-manager.js mode offline            - Force offline mode (IP-based)
  node network-manager.js test                    - Test all servers in current mode
            `);
            break;
    }
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = NetworkManager;