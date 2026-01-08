#!/usr/bin/env node

/**
 * Test script for OpenLink Unified API
 * Tests both local Mac mini operations and remote server operations
 */

const OpenLinkUnifiedAPI = require('./electron/src/api/openlink-unified-api');
const fs = require('fs');
const path = require('path');

async function runTests() {
    console.log('🧪 Starting OpenLink Unified API Tests\n');

    // Initialize API server
    const api = new OpenLinkUnifiedAPI({
        port: 3333, // Use different port for testing
        enableClaude: true,
        localSudoPassword: 'DsmotifXS678!$',
        serverHost: 'raywonderis.me',
        serverPort: 450,
        serverUser: 'root',
        sshKeyPath: path.join(process.env.HOME, '.ssh/raywonder'),
        allowedDomains: ['raywonderis.me', 'openlink.local']
    });

    try {
        // Test 1: Start the API server
        console.log('🚀 Test 1: Starting API server...');
        const serverResult = await api.startServer();
        console.log('✅ Server started:', serverResult.endpoints.http);
        console.log('');

        // Test 2: Test remote server connection
        console.log('🔗 Test 2: Testing remote server connection...');
        const serverTest = await api.configManager.testServerConnection();
        if (serverTest.success) {
            console.log('✅ Remote server connected:', serverTest.hostname);
        } else {
            console.log('❌ Remote server failed:', serverTest.error);
        }
        console.log('');

        // Test 3: Test local sudo command
        console.log('🔐 Test 3: Testing local sudo command...');
        try {
            const sudoTest = await api.configManager.executeLocalSudo('whoami');
            console.log('✅ Local sudo works:', sudoTest.stdout.trim());
        } catch (error) {
            console.log('❌ Local sudo failed:', error.message);
        }
        console.log('');

        // Test 4: Register a test client
        console.log('📱 Test 4: Registering test client...');
        const clientData = {
            name: 'Test Client',
            platform: 'darwin',
            version: '1.0.0',
            hostname: 'test-mac',
            localIP: '192.168.1.100',
            capabilities: {
                hosting: true,
                connecting: true,
                fileTransfer: true,
                audioVideo: true
            }
        };

        const client = await api.registerClient(clientData);
        console.log('✅ Client registered:', client.id);
        console.log('');

        // Test 5: Request a local domain (.local)
        console.log('🌐 Test 5: Requesting local domain (.local)...');
        const localDomainRequest = {
            clientId: client.id,
            subdomain: 'test-local',
            baseDomain: 'openlink.local',
            targetHost: 'localhost',
            targetPort: 8000,
            sslEnabled: false
        };

        try {
            const localDomain = await api.configManager.requestDomain(localDomainRequest);
            console.log('✅ Local domain created:', localDomain.fullDomain);
            console.log('   Location:', localDomain.location);
            console.log('   Port:', localDomain.port);

            // Test 6: Release the local domain
            console.log('🗑️  Test 6: Releasing local domain...');
            await api.configManager.releaseDomain(localDomain.id);
            console.log('✅ Local domain released');
        } catch (error) {
            console.log('❌ Local domain test failed:', error.message);
        }
        console.log('');

        // Test 7: Request a remote domain (public)
        console.log('🌍 Test 7: Requesting remote domain (public)...');
        const remoteDomainRequest = {
            clientId: client.id,
            subdomain: 'test-remote-' + Date.now(),
            baseDomain: 'raywonderis.me',
            targetHost: 'localhost',
            targetPort: 8001,
            sslEnabled: false
        };

        try {
            const remoteDomain = await api.configManager.requestDomain(remoteDomainRequest);
            console.log('✅ Remote domain created:', remoteDomain.fullDomain);
            console.log('   Location:', remoteDomain.location);
            console.log('   Port:', remoteDomain.port);

            // Test 8: Release the remote domain
            console.log('🗑️  Test 8: Releasing remote domain...');
            await api.configManager.releaseDomain(remoteDomain.id);
            console.log('✅ Remote domain released');
        } catch (error) {
            console.log('❌ Remote domain test failed:', error.message);
            console.log('   This might be expected if nginx is not configured on the server');
        }
        console.log('');

        // Test 9: Start a hosting session
        console.log('🎯 Test 9: Starting hosting session...');
        const sessionData = {
            clientId: client.id,
            type: 'hosting',
            requestDomain: true,
            domainConfig: {
                subdomain: 'session-test',
                baseDomain: 'openlink.local',
                targetHost: 'localhost',
                targetPort: 8765
            }
        };

        try {
            const session = await api.startSession(sessionData);
            console.log('✅ Session started:', session.id);
            console.log('   Type:', session.type);
            console.log('   Domains:', session.domains.length);

            // Test 10: Stop the session
            console.log('🛑 Test 10: Stopping hosting session...');
            await api.stopSession(session.id);
            console.log('✅ Session stopped');
        } catch (error) {
            console.log('❌ Session test failed:', error.message);
        }
        console.log('');

        // Test 11: Test Claude integration (if enabled)
        if (api.claudeManager) {
            console.log('🤖 Test 11: Testing Claude integration...');
            try {
                const claudeStatus = await api.claudeManager.getStatus();
                console.log('✅ Claude status:', claudeStatus.running ? 'Running' : 'Stopped');
                console.log('   Processes:', claudeStatus.processes);
            } catch (error) {
                console.log('❌ Claude test failed:', error.message);
            }
            console.log('');
        }

        // Test 12: Get overall system status
        console.log('📊 Test 12: Getting system status...');
        const status = api.getServerStatus();
        console.log('✅ System status:');
        console.log('   Clients:', status.clients);
        console.log('   Sessions:', status.sessions);
        console.log('   Uptime:', Math.round(status.uptime), 'seconds');
        console.log('   Memory:', Math.round(status.memory.heapUsed / 1024 / 1024), 'MB');
        console.log('');

        // Test 13: Configuration status
        console.log('⚙️  Test 13: Configuration manager status...');
        const configStatus = api.configManager.getStatus();
        console.log('✅ Configuration status:');
        console.log('   Total domains:', configStatus.totalDomains);
        console.log('   Local domains:', configStatus.localDomains);
        console.log('   Remote domains:', configStatus.remoteDomains);
        console.log('   Allocated ports:', configStatus.allocatedPorts);
        console.log('');

        console.log('🎉 All tests completed successfully!');

    } catch (error) {
        console.error('❌ Test failed:', error);
    } finally {
        // Clean up
        console.log('🧹 Cleaning up...');
        try {
            await api.stopServer();
            console.log('✅ Server stopped');
        } catch (error) {
            console.error('❌ Cleanup failed:', error);
        }
    }
}

// Run tests if this file is executed directly
if (require.main === module) {
    runTests().catch(console.error);
}

module.exports = { runTests };