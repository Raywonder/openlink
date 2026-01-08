#!/usr/bin/env node

/**
 * OpenLink Comprehensive Diagnostic & Fix Tool
 * Diagnoses connectivity issues, fixes SSL certificates, and manages servers
 */

const https = require('https');
const http = require('http');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

class OpenLinkDiagnostic {
    constructor() {
        this.servers = [
            { name: 'Local Server', url: 'ws://localhost:8765', type: 'local' },
            { name: 'VPS1 TappedIn', url: 'ws://vps1.tappedin.fm:8765', type: 'fallback' },
            { name: 'OpenLink Official', url: 'wss://openlink.raywonderis.me', type: 'primary', domain: 'raywonderis.me' },
            { name: 'OpenLink TappedIn', url: 'wss://openlink.tappedin.fm', type: 'primary', domain: 'tappedin.fm' },
            { name: 'OpenLink Devine', url: 'wss://openlink.devinecreations.net', type: 'fallback', domain: 'devinecreations.net' },
            { name: 'OpenLink DC', url: 'wss://openlink.devine-creations.com', type: 'fallback', domain: 'devine-creations.com' },
            { name: 'OpenLink WH', url: 'wss://openlink.walterharper.com', type: 'fallback', domain: 'walterharper.com' },
            { name: 'OpenLink TH', url: 'wss://openlink.tetoeehoward.com', type: 'fallback', domain: 'tetoeehoward.com' }
        ];

        this.serverConfig = {
            host: '64.20.46.178',
            port: 450,
            user: 'root',
            keyPath: path.join(process.env.HOME, '.ssh/raywonder'),
            sudoPassword: 'DsmotifXS678!$'
        };
    }

    /**
     * Run comprehensive diagnostics
     */
    async runDiagnostic(sessionId = null) {
        console.log('🔍 OpenLink Comprehensive Diagnostic Tool\n');

        const results = {
            serverStatus: [],
            sslStatus: {},
            sessionStatus: null,
            recommendations: []
        };

        // Test all servers
        console.log('🌐 Testing Server Connectivity...');
        for (const server of this.servers) {
            const status = await this.testServer(server);
            results.serverStatus.push(status);
            console.log(`${status.online ? '✅' : '❌'} ${server.name}: ${status.status}`);
        }

        // Test SSL certificates
        console.log('\n🔒 Checking SSL Certificates...');
        for (const server of this.servers.filter(s => s.url.startsWith('wss://'))) {
            const sslStatus = await this.checkSSL(server);
            results.sslStatus[server.domain] = sslStatus;
            console.log(`${sslStatus.valid ? '✅' : '❌'} ${server.domain}: ${sslStatus.message}`);
        }

        // Test specific session if provided
        if (sessionId) {
            console.log(`\n🎯 Testing Session: ${sessionId}...`);
            results.sessionStatus = await this.testSession(sessionId);
            console.log(`${results.sessionStatus.found ? '✅' : '❌'} Session ${sessionId}: ${results.sessionStatus.message}`);
        }

        // Generate recommendations
        results.recommendations = this.generateRecommendations(results);

        console.log('\n📋 Recommendations:');
        results.recommendations.forEach((rec, i) => {
            console.log(`${i + 1}. ${rec}`);
        });

        return results;
    }

    /**
     * Test individual server connectivity
     */
    async testServer(server) {
        return new Promise((resolve) => {
            const isWS = server.url.startsWith('ws://');
            const isWSS = server.url.startsWith('wss://');

            if (isWS || isWSS) {
                // Test WebSocket connection
                const ws = new WebSocket(server.url);
                const timeout = setTimeout(() => {
                    ws.terminate();
                    resolve({ ...server, online: false, status: 'Connection timeout' });
                }, 5000);

                ws.on('open', () => {
                    clearTimeout(timeout);
                    ws.close();
                    resolve({ ...server, online: true, status: 'WebSocket OK' });
                });

                ws.on('error', (error) => {
                    clearTimeout(timeout);
                    resolve({ ...server, online: false, status: `Error: ${error.message}` });
                });
            } else {
                // Test HTTP/HTTPS
                const url = new URL(server.url);
                const client = url.protocol === 'https:' ? https : http;

                const req = client.request(url, { timeout: 5000 }, (res) => {
                    resolve({ ...server, online: true, status: `HTTP ${res.statusCode}` });
                });

                req.on('error', (error) => {
                    resolve({ ...server, online: false, status: `Error: ${error.message}` });
                });

                req.on('timeout', () => {
                    req.destroy();
                    resolve({ ...server, online: false, status: 'Connection timeout' });
                });

                req.end();
            }
        });
    }

    /**
     * Check SSL certificate status
     */
    async checkSSL(server) {
        return new Promise((resolve) => {
            if (!server.domain) {
                resolve({ valid: false, message: 'No domain specified' });
                return;
            }

            const url = `https://openlink.${server.domain}`;
            const req = https.request(url, { timeout: 5000 }, (res) => {
                const cert = res.socket.getPeerCertificate();
                const now = new Date();
                const expires = new Date(cert.valid_to);

                if (expires > now) {
                    const daysLeft = Math.floor((expires - now) / (1000 * 60 * 60 * 24));
                    resolve({ valid: true, message: `Valid (expires in ${daysLeft} days)`, expires, cert });
                } else {
                    resolve({ valid: false, message: 'Certificate expired', expires, cert });
                }
            });

            req.on('error', (error) => {
                resolve({ valid: false, message: `SSL Error: ${error.message}` });
            });

            req.on('timeout', () => {
                req.destroy();
                resolve({ valid: false, message: 'Connection timeout' });
            });

            req.end();
        });
    }

    /**
     * Test if a session exists on any server
     */
    async testSession(sessionId) {
        for (const server of this.servers.filter(s => s.online)) {
            try {
                const url = server.url.replace('ws://', 'http://').replace('wss://', 'https://');
                const testUrl = `${url}/${sessionId}`;

                const response = await this.httpRequest(testUrl);
                if (!response.includes('Not Found') && !response.includes('404')) {
                    return {
                        found: true,
                        message: `Found on ${server.name}`,
                        server: server.name,
                        url: testUrl
                    };
                }
            } catch (error) {
                // Continue to next server
            }
        }

        return { found: false, message: 'Session not found on any server' };
    }

    /**
     * Generate recommendations based on diagnostic results
     */
    generateRecommendations(results) {
        const recommendations = [];
        const onlineServers = results.serverStatus.filter(s => s.online);
        const offlineServers = results.serverStatus.filter(s => !s.online);

        if (onlineServers.length === 0) {
            recommendations.push('❌ CRITICAL: No servers are online. Check network connectivity.');
            recommendations.push('🔧 Start local signaling server: npm run dev');
        } else if (onlineServers.length < 3) {
            recommendations.push(`⚠️ Only ${onlineServers.length} servers online. Fix SSL certificates for better reliability.`);
        }

        // SSL recommendations
        Object.entries(results.sslStatus).forEach(([domain, status]) => {
            if (!status.valid) {
                recommendations.push(`🔒 Fix SSL certificate for ${domain}: Run SSL renewal tool`);
            }
        });

        // Session recommendations
        if (results.sessionStatus && !results.sessionStatus.found) {
            recommendations.push('🎯 Session not found. Check Windows PC server selection.');
            recommendations.push(`🌐 Recommended servers: ${onlineServers.map(s => s.name).join(', ')}`);
        }

        return recommendations;
    }

    /**
     * HTTP request helper
     */
    httpRequest(url, options = {}) {
        return new Promise((resolve, reject) => {
            const client = url.startsWith('https://') ? https : http;
            const req = client.request(url, { timeout: 5000, ...options }, (res) => {
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

    /**
     * Execute SSH command on server
     */
    async executeSSH(command) {
        return new Promise((resolve, reject) => {
            const sshCmd = `ssh -p ${this.serverConfig.port} -i ${this.serverConfig.keyPath} -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${this.serverConfig.user}@${this.serverConfig.host} "${command}"`;

            exec(sshCmd, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(`SSH Error: ${stderr || error.message}`));
                } else {
                    resolve(stdout.trim());
                }
            });
        });
    }

    /**
     * Request SSL certificate for a domain
     */
    async requestSSL(domain) {
        console.log(`🔒 Requesting SSL certificate for ${domain}...`);

        try {
            // Check if domain points to our server
            const dnsCheck = await this.executeSSH(`nslookup openlink.${domain} | grep "Address: ${this.serverConfig.host}"`);
            if (!dnsCheck) {
                throw new Error(`Domain openlink.${domain} does not point to server ${this.serverConfig.host}`);
            }

            // Request certificate using certbot
            const certbotCmd = `certbot certonly --webroot -w /home/dom/public_html -d openlink.${domain} --non-interactive --agree-tos --email webmaster@devine-creations.com`;
            const result = await this.executeSSH(certbotCmd);

            console.log(`✅ SSL certificate requested for openlink.${domain}`);
            console.log(result);

            // Update nginx configuration
            await this.updateNginxSSL(domain);

            return { success: true, domain, message: 'SSL certificate installed successfully' };
        } catch (error) {
            console.error(`❌ SSL request failed for ${domain}: ${error.message}`);
            return { success: false, domain, error: error.message };
        }
    }

    /**
     * Update nginx SSL configuration
     */
    async updateNginxSSL(domain) {
        console.log(`🔧 Updating nginx SSL configuration for ${domain}...`);

        const nginxConfig = `
# Auto-generated SSL config for openlink.${domain}
server {
    listen 443 ssl;
    http2 off;
    server_name openlink.${domain};

    ssl_certificate /etc/letsencrypt/live/openlink.${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/openlink.${domain}/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8765;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
        proxy_buffering off;
    }

    location /health {
        proxy_pass http://127.0.0.1:8765/health;
    }
}
`;

        await this.executeSSH(`echo '${nginxConfig}' > /etc/nginx/conf.d/openlink-${domain}-ssl.conf`);
        await this.executeSSH('nginx -t && systemctl reload nginx');

        console.log(`✅ Nginx SSL configuration updated for ${domain}`);
    }

    /**
     * Fix all offline servers
     */
    async fixAllServers() {
        console.log('🔧 Fixing all offline servers...\n');

        const diagnosticResults = await this.runDiagnostic();
        const offlineServers = diagnosticResults.serverStatus.filter(s => !s.online && s.domain);

        for (const server of offlineServers) {
            console.log(`\n🔧 Fixing ${server.name} (${server.domain})...`);

            // Request SSL certificate
            const sslResult = await this.requestSSL(server.domain);

            if (sslResult.success) {
                // Test server again
                const retestResult = await this.testServer(server);
                console.log(`${retestResult.online ? '✅' : '❌'} ${server.name}: ${retestResult.status}`);
            }
        }

        console.log('\n🎉 Server fix process completed!');
        console.log('🔄 Run diagnostic again to verify all fixes.');
    }
}

// CLI Interface
async function main() {
    const diagnostic = new OpenLinkDiagnostic();
    const args = process.argv.slice(2);
    const command = args[0];
    const param = args[1];

    switch (command) {
        case 'test':
            if (param) {
                console.log(`🎯 Testing session: ${param}`);
                await diagnostic.runDiagnostic(param);
            } else {
                await diagnostic.runDiagnostic();
            }
            break;

        case 'ssl':
            if (!param) {
                console.error('❌ Usage: node openlink-diagnostic.js ssl <domain>');
                process.exit(1);
            }
            await diagnostic.requestSSL(param);
            break;

        case 'fix':
            await diagnostic.fixAllServers();
            break;

        case 'server':
            if (param) {
                const server = diagnostic.servers.find(s => s.name.toLowerCase().includes(param.toLowerCase()));
                if (server) {
                    const result = await diagnostic.testServer(server);
                    console.log(`${result.online ? '✅' : '❌'} ${server.name}: ${result.status}`);
                } else {
                    console.error(`❌ Server not found: ${param}`);
                }
            } else {
                console.error('❌ Usage: node openlink-diagnostic.js server <name>');
            }
            break;

        default:
            console.log(`
🔍 OpenLink Diagnostic & Fix Tool

Usage:
  node openlink-diagnostic.js test [sessionId]  - Run full diagnostic
  node openlink-diagnostic.js ssl <domain>     - Request SSL certificate
  node openlink-diagnostic.js fix              - Fix all offline servers
  node openlink-diagnostic.js server <name>    - Test specific server

Examples:
  node openlink-diagnostic.js test IMNINW      - Test session IMNINW
  node openlink-diagnostic.js ssl devine-creations.com
  node openlink-diagnostic.js fix              - Fix all SSL issues
  node openlink-diagnostic.js server tappedin  - Test TappedIn server
            `);
            break;
    }
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = OpenLinkDiagnostic;