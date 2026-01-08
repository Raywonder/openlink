#!/usr/bin/env node

/**
 * OpenLink Session Tracker & Troubleshooter
 * Tracks active sessions across all servers and provides troubleshooting tools
 */

const WebSocket = require('ws');
const { exec } = require('child_process');
const path = require('path');

class SessionTracker {
    constructor() {
        this.servers = [
            { name: 'Local Server', url: 'ws://localhost:8765', type: 'local' },
            { name: 'VPS1 TappedIn', url: 'ws://vps1.tappedin.fm:8765', type: 'fallback' },
            { name: 'OpenLink Official', url: 'wss://openlink.raywonderis.me', type: 'primary' },
            { name: 'OpenLink TappedIn', url: 'wss://openlink.tappedin.fm', type: 'primary' },
            { name: 'OpenLink Devine', url: 'wss://openlink.devinecreations.net', type: 'fallback' },
            { name: 'OpenLink DC', url: 'wss://openlink.devine-creations.com', type: 'fallback' },
            { name: 'OpenLink WH', url: 'wss://openlink.walterharper.com', type: 'fallback' },
            { name: 'OpenLink TH', url: 'wss://openlink.tetoeehoward.com', type: 'fallback' }
        ];

        this.serverConfig = {
            host: '64.20.46.178',
            port: 450,
            user: 'root',
            keyPath: path.join(process.env.HOME, '.ssh/raywonder')
        };

        this.activeSessions = new Map();
    }

    /**
     * Execute SSH command on server
     */
    async executeSSH(command) {
        return new Promise((resolve, reject) => {
            const sshCmd = `ssh -p ${this.serverConfig.port} -i ${this.serverConfig.keyPath} -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${this.serverConfig.user}@${this.serverConfig.host} "${command.replace(/"/g, '\\"')}"`;

            exec(sshCmd, { timeout: 30000 }, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(`SSH Error: ${stderr || error.message}`));
                } else {
                    resolve(stdout.trim());
                }
            });
        });
    }

    /**
     * Test WebSocket connection to a server
     */
    async testServerConnection(server) {
        return new Promise((resolve) => {
            const ws = new WebSocket(server.url);
            const timeout = setTimeout(() => {
                ws.terminate();
                resolve({ connected: false, error: 'Connection timeout' });
            }, 5000);

            ws.on('open', () => {
                clearTimeout(timeout);
                ws.close();
                resolve({ connected: true });
            });

            ws.on('error', (error) => {
                clearTimeout(timeout);
                resolve({ connected: false, error: error.message });
            });
        });
    }

    /**
     * Search for a session across all servers
     */
    async findSession(sessionId) {
        console.log(`🔍 Searching for session: ${sessionId}\n`);

        const results = [];

        for (const server of this.servers) {
            console.log(`🔍 Checking ${server.name}...`);

            // Test server connection first
            const connectionTest = await this.testServerConnection(server);
            if (!connectionTest.connected) {
                console.log(`❌ ${server.name}: Server offline (${connectionTest.error})`);
                results.push({
                    server: server.name,
                    status: 'offline',
                    error: connectionTest.error
                });
                continue;
            }

            // Try to connect and search for session
            try {
                const sessionExists = await this.checkSessionOnServer(server, sessionId);
                if (sessionExists.found) {
                    console.log(`✅ ${server.name}: Session found!`);
                    results.push({
                        server: server.name,
                        status: 'found',
                        details: sessionExists.details
                    });
                } else {
                    console.log(`⚪ ${server.name}: Session not found`);
                    results.push({
                        server: server.name,
                        status: 'not_found'
                    });
                }
            } catch (error) {
                console.log(`❌ ${server.name}: Error checking session (${error.message})`);
                results.push({
                    server: server.name,
                    status: 'error',
                    error: error.message
                });
            }
        }

        // Summary
        const foundServers = results.filter(r => r.status === 'found');
        const onlineServers = results.filter(r => r.status !== 'offline');

        console.log(`\n📊 Search Results:`);
        console.log(`   🎯 Session found on: ${foundServers.length} server(s)`);
        console.log(`   🌐 Online servers: ${onlineServers.length}/${this.servers.length}`);
        console.log(`   ❌ Offline servers: ${results.filter(r => r.status === 'offline').length}`);

        if (foundServers.length > 0) {
            console.log(`\n✅ Session ${sessionId} is available on:`);
            foundServers.forEach(result => {
                console.log(`   - ${result.server}`);
                if (result.details) {
                    console.log(`     Type: ${result.details.type || 'Unknown'}`);
                    console.log(`     Status: ${result.details.status || 'Unknown'}`);
                }
            });

            // Provide connection URLs
            console.log(`\n🔗 Connection URLs:`);
            foundServers.forEach(result => {
                const server = this.servers.find(s => s.name === result.server);
                const url = server.url.replace('ws://', 'http://').replace('wss://', 'https://');
                console.log(`   ${server.name}: ${url}/${sessionId}`);
            });
        } else {
            console.log(`\n❌ Session ${sessionId} not found on any server`);
            this.provideTroubleshootingSteps(sessionId, results);
        }

        return results;
    }

    /**
     * Check if session exists on a specific server
     */
    async checkSessionOnServer(server, sessionId) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(server.url);

            const timeout = setTimeout(() => {
                ws.terminate();
                reject(new Error('Connection timeout'));
            }, 10000);

            ws.on('open', () => {
                // Send session query message
                ws.send(JSON.stringify({
                    type: 'query_session',
                    sessionId: sessionId
                }));
            });

            ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data);

                    if (message.type === 'session_response') {
                        clearTimeout(timeout);
                        ws.close();

                        if (message.found) {
                            resolve({
                                found: true,
                                details: message.session
                            });
                        } else {
                            resolve({ found: false });
                        }
                    }
                } catch (error) {
                    // Ignore parsing errors, continue waiting
                }
            });

            ws.on('error', (error) => {
                clearTimeout(timeout);
                reject(error);
            });

            ws.on('close', () => {
                clearTimeout(timeout);
                // If we reach here without a response, session probably doesn't exist
                resolve({ found: false });
            });

            // Fallback: if no response in 5 seconds, assume session doesn't exist
            setTimeout(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    clearTimeout(timeout);
                    ws.close();
                    resolve({ found: false });
                }
            }, 5000);
        });
    }

    /**
     * Get all active sessions from the main server
     */
    async getActiveSessions() {
        console.log('📊 Getting active sessions from main server...\n');

        try {
            // Query the main signaling server for active sessions
            const result = await this.executeSSH('curl -s http://localhost:8765/api/sessions 2>/dev/null || echo "[]"');

            let sessions;
            try {
                sessions = JSON.parse(result);
            } catch (error) {
                console.log('⚠️ No session API available or invalid response');
                return [];
            }

            if (Array.isArray(sessions) && sessions.length > 0) {
                console.log(`📋 Found ${sessions.length} active session(s):`);
                sessions.forEach((session, i) => {
                    console.log(`   ${i + 1}. ${session.id || 'Unknown ID'} (${session.type || 'Unknown type'})`);
                    if (session.host) {
                        console.log(`      Host: ${session.host}`);
                    }
                    if (session.created) {
                        console.log(`      Created: ${new Date(session.created).toLocaleString()}`);
                    }
                });
            } else {
                console.log('📭 No active sessions found');
            }

            return sessions;
        } catch (error) {
            console.error(`❌ Failed to get sessions: ${error.message}`);
            return [];
        }
    }

    /**
     * Monitor sessions in real-time
     */
    async monitorSessions(duration = 60000) {
        console.log(`👁️ Monitoring sessions for ${duration / 1000} seconds...\n`);

        const startTime = Date.now();
        const seenSessions = new Set();

        while (Date.now() - startTime < duration) {
            try {
                const sessions = await this.getActiveSessions();

                sessions.forEach(session => {
                    const sessionKey = `${session.id}-${session.type}`;
                    if (!seenSessions.has(sessionKey)) {
                        seenSessions.add(sessionKey);
                        console.log(`🆕 New session detected: ${session.id} (${session.type})`);

                        // Test if session is accessible via web
                        this.testSessionWeb(session.id);
                    }
                });

                // Wait before next check
                await new Promise(resolve => setTimeout(resolve, 5000));
            } catch (error) {
                console.error(`❌ Monitoring error: ${error.message}`);
            }
        }

        console.log(`\n✅ Monitoring completed. Detected ${seenSessions.size} unique sessions.`);
    }

    /**
     * Test if session is accessible via web
     */
    async testSessionWeb(sessionId) {
        console.log(`🌐 Testing web access for session ${sessionId}...`);

        // Test on working servers
        const workingServers = [
            'https://openlink.tappedin.fm',
            'http://localhost:8765',
            'http://vps1.tappedin.fm:8765'
        ];

        for (const serverUrl of workingServers) {
            try {
                const testUrl = `${serverUrl}/${sessionId}`;
                const result = await this.httpRequest(testUrl, { timeout: 5000 });

                if (!result.includes('Not Found') && !result.includes('404')) {
                    console.log(`✅ Session ${sessionId} accessible at: ${testUrl}`);
                    return testUrl;
                }
            } catch (error) {
                // Continue to next server
            }
        }

        console.log(`⚠️ Session ${sessionId} not accessible via web`);
        return null;
    }

    /**
     * HTTP request helper
     */
    httpRequest(url, options = {}) {
        return new Promise((resolve, reject) => {
            const isHttps = url.startsWith('https://');
            const client = isHttps ? require('https') : require('http');

            const req = client.request(url, { timeout: options.timeout || 10000 }, (res) => {
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
     * Provide troubleshooting steps when session is not found
     */
    provideTroubleshootingSteps(sessionId, searchResults) {
        console.log(`\n🔧 Troubleshooting steps for session ${sessionId}:\n`);

        const offlineServers = searchResults.filter(r => r.status === 'offline');
        const onlineServers = searchResults.filter(r => r.status !== 'offline');

        if (offlineServers.length > onlineServers.length) {
            console.log('❌ CRITICAL: Most servers are offline');
            console.log('   1. Check network connectivity');
            console.log('   2. Run: node tools/openlink-diagnostic.js fix');
            console.log('   3. Run: node tools/ssl-manager.js setup');
        }

        console.log('\n🔍 For the Windows PC hosting the session:');
        console.log('   1. Check which server OpenLink is connected to');
        console.log('   2. Ensure it\'s using a working server:');

        if (onlineServers.length > 0) {
            console.log('      ✅ Working servers:');
            onlineServers.forEach(server => {
                const serverConfig = this.servers.find(s => s.name === server.server);
                console.log(`         - ${server.server}: ${serverConfig.url}`);
            });
        }

        if (offlineServers.length > 0) {
            console.log('      ❌ Avoid these offline servers:');
            offlineServers.forEach(server => {
                const serverConfig = this.servers.find(s => s.name === server.server);
                console.log(`         - ${server.server}: ${serverConfig.url}`);
            });
        }

        console.log('\n🔄 Commands to fix issues:');
        console.log('   node tools/openlink-diagnostic.js test');
        console.log('   node tools/ssl-manager.js setup');
        console.log('   node tools/openlink-diagnostic.js fix');
    }

    /**
     * Create a test session for verification
     */
    async createTestSession() {
        console.log('🧪 Creating test session for verification...\n');

        // Connect to local server and create a test session
        return new Promise((resolve, reject) => {
            const ws = new WebSocket('ws://localhost:8765');

            ws.on('open', () => {
                console.log('✅ Connected to local server');

                // Send host session request
                const sessionId = 'TEST-' + Math.random().toString(36).substr(2, 9).toUpperCase();
                ws.send(JSON.stringify({
                    type: 'host_session',
                    sessionId: sessionId,
                    clientInfo: {
                        platform: 'test',
                        version: '1.4.0'
                    }
                }));

                console.log(`📡 Requested test session: ${sessionId}`);

                ws.on('message', (data) => {
                    try {
                        const message = JSON.parse(data);
                        if (message.type === 'session_created') {
                            console.log(`✅ Test session created: ${message.sessionId}`);
                            console.log(`🔗 Test URL: http://localhost:8765/${message.sessionId}`);

                            ws.close();
                            resolve(message.sessionId);
                        }
                    } catch (error) {
                        // Ignore parsing errors
                    }
                });

                // Timeout after 10 seconds
                setTimeout(() => {
                    ws.close();
                    reject(new Error('Test session creation timeout'));
                }, 10000);
            });

            ws.on('error', (error) => {
                reject(new Error(`Test session failed: ${error.message}`));
            });
        });
    }
}

// CLI Interface
async function main() {
    const tracker = new SessionTracker();
    const args = process.argv.slice(2);
    const command = args[0];
    const param = args[1];

    switch (command) {
        case 'find':
            if (!param) {
                console.error('❌ Usage: node session-tracker.js find <sessionId>');
                process.exit(1);
            }
            await tracker.findSession(param);
            break;

        case 'list':
            await tracker.getActiveSessions();
            break;

        case 'monitor':
            const duration = param ? parseInt(param) * 1000 : 60000;
            await tracker.monitorSessions(duration);
            break;

        case 'test':
            try {
                const testSessionId = await tracker.createTestSession();
                console.log(`\n🧪 Testing session accessibility...`);
                await tracker.findSession(testSessionId);
            } catch (error) {
                console.error(`❌ Test session failed: ${error.message}`);
            }
            break;

        default:
            console.log(`
🎯 OpenLink Session Tracker & Troubleshooter

Usage:
  node session-tracker.js find <sessionId>     - Search for specific session
  node session-tracker.js list                 - List all active sessions
  node session-tracker.js monitor [seconds]    - Monitor sessions in real-time
  node session-tracker.js test                 - Create and test a session

Examples:
  node session-tracker.js find IMNINW          - Find session IMNINW
  node session-tracker.js list                 - Show all active sessions
  node session-tracker.js monitor 120          - Monitor for 2 minutes
  node session-tracker.js test                 - Create test session and verify
            `);
            break;
    }
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = SessionTracker;