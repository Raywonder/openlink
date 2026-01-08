#!/usr/bin/env node

const NetworkManager = require('./tools/network-manager');

async function testOfflineMode() {
    console.log('🧪 Testing Offline Mode Configuration\n');

    const manager = new NetworkManager();

    console.log('1. Initial mode:', manager.currentMode);

    await manager.setMode('offline');
    console.log('2. After setMode(offline):', manager.currentMode);

    // Test getOptimalServers
    console.log('\n📡 Getting servers for offline mode...');
    const servers = manager.getOptimalServers();

    console.log(`\nFound ${servers.length} servers for offline mode:`);
    servers.forEach((server, i) => {
        console.log(`${i + 1}. ${server.name}: ${server.url} (${server.mode} mode)`);
        if (server.ip && server.port) {
            console.log(`   Direct IP: ${server.ip}:${server.port}`);
        }
    });

    console.log('\n🔍 Testing each server...');
    for (const server of servers) {
        const result = await manager.testServer(server);
        const icon = result.online ? '✅' : '❌';
        console.log(`${icon} ${server.name}: ${result.status}`);
    }
}

testOfflineMode().catch(console.error);