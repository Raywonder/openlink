/**
 * Claude OpenLink Manager
 * Integrates SSH/Shell Bridge with OpenLink for Claude control
 */

const SSHShellBridge = require('./ssh-shell-bridge');
const fs = require('fs');
const path = require('path');
const os = require('os');

class ClaudeOpenLinkManager {
    constructor() {
        this.bridge = new SSHShellBridge({
            enableSSH: false, // Start with shell only
            allowShellCommands: true,
            logCommands: true,
            commandTimeout: 60000 // 1 minute timeout
        });

        this.sessionInfo = null;
        this.isHosting = false;
        this.connections = [];
    }

    async initialize() {
        console.log('🚀 Initializing Claude OpenLink Manager...');

        // Create OpenLink command directory
        await this.setupCommands();

        // Get current status
        const status = await this.getStatus();
        console.log('📊 Current Status:', status);

        return status;
    }

    async setupCommands() {
        const commandsDir = path.join(os.homedir(), '.openlink', 'claude-commands');
        if (!fs.existsSync(commandsDir)) {
            fs.mkdirSync(commandsDir, { recursive: true });
        }

        // Create Claude-specific command scripts
        const commands = {
            'claude-openlink-status': this.generateClaudeStatusCommand(),
            'claude-start-hosting': this.generateClaudeStartHostCommand(),
            'claude-stop-hosting': this.generateClaudeStopHostCommand(),
            'claude-get-session-id': this.generateGetSessionIdCommand(),
            'claude-test-permissions': this.generateTestPermissionsCommand(),
            'claude-create-connection-link': this.generateCreateConnectionLinkCommand()
        };

        for (const [name, script] of Object.entries(commands)) {
            const scriptPath = path.join(commandsDir, name);
            fs.writeFileSync(scriptPath, script, { mode: 0o755 });
        }

        console.log('✅ Claude command scripts created');
    }

    async getStatus() {
        try {
            const result = await this.bridge.executeShellCommand('ps aux | grep -i openlink | grep -v grep');
            const processes = result.stdout.split('\n').filter(line => line.trim());

            const networkInfo = await this.bridge.executeShellCommand('ifconfig | grep "inet " | grep -v "127.0.0.1"');
            const hostname = await this.bridge.executeShellCommand('hostname');

            return {
                processes: processes.length,
                running: processes.length > 0,
                hostname: hostname.stdout.trim(),
                networkInfo: networkInfo.stdout.trim(),
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            console.error('❌ Error getting status:', error.message);
            return { error: error.message };
        }
    }

    async startHosting() {
        try {
            console.log('🏁 Starting OpenLink hosting session...');

            // First check if already running
            const status = await this.getStatus();
            if (status.running) {
                console.log('⚠️  OpenLink already running');
            }

            // Try to start hosting via multiple methods
            let result;

            // Method 1: Start development version
            try {
                result = await this.bridge.executeShellCommand('cd /Users/admin/dev/apps/openlink/electron && npm run dev > /tmp/openlink-start.log 2>&1 &');
                console.log('📱 Started development version');
            } catch (error) {
                console.log('⚠️  Dev version failed, trying installed app...');

                // Method 2: Open installed app
                result = await this.bridge.executeShellCommand('open -a "OpenLink"');
                console.log('📱 Opened installed OpenLink app');
            }

            // Wait a moment for startup
            await new Promise(resolve => setTimeout(resolve, 3000));

            // Try to get session info
            await this.refreshSessionInfo();

            this.isHosting = true;
            return {
                success: true,
                message: 'Hosting session started',
                sessionInfo: this.sessionInfo
            };

        } catch (error) {
            console.error('❌ Failed to start hosting:', error.message);
            return { success: false, error: error.message };
        }
    }

    async stopHosting() {
        try {
            console.log('🛑 Stopping OpenLink hosting session...');

            const result = await this.bridge.executeShellCommand('pkill -f "OpenLink"; pkill -f "electron.*openlink"');

            this.isHosting = false;
            this.sessionInfo = null;

            return {
                success: true,
                message: 'Hosting session stopped'
            };
        } catch (error) {
            console.error('❌ Failed to stop hosting:', error.message);
            return { success: false, error: error.message };
        }
    }

    async refreshSessionInfo() {
        try {
            // Check for session files
            const sessionPaths = [
                path.join(os.homedir(), 'Library/Application Support/OpenLink/session.json'),
                path.join(os.homedir(), 'Library/Application Support/openlink/session.json'),
                '/tmp/openlink-session.json'
            ];

            for (const sessionPath of sessionPaths) {
                try {
                    if (fs.existsSync(sessionPath)) {
                        const sessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
                        this.sessionInfo = sessionData;
                        console.log('📋 Found session info:', sessionData);
                        return sessionData;
                    }
                } catch (error) {
                    // Continue to next path
                }
            }

            // If no session file, try to extract from logs
            try {
                const logResult = await this.bridge.executeShellCommand('tail -20 /tmp/openlink-start.log 2>/dev/null | grep -i "session\\|hosting\\|id"');
                if (logResult.stdout) {
                    console.log('📝 Log output:', logResult.stdout);
                }
            } catch (error) {
                // Ignore log errors
            }

            return null;
        } catch (error) {
            console.error('❌ Error refreshing session info:', error.message);
            return null;
        }
    }

    async testPermissions() {
        try {
            console.log('🔐 Testing macOS permissions...');

            const tests = [
                {
                    name: 'Screen Recording',
                    command: 'osascript -e "tell application \\"System Events\\" to get name of every application process" >/dev/null 2>&1; echo $?'
                },
                {
                    name: 'Accessibility',
                    command: 'osascript -e "tell application \\"System Events\\" to click" 2>/dev/null; echo $?'
                },
                {
                    name: 'Input Monitoring',
                    command: 'ioreg -l | grep -i "IOHIDSystem" >/dev/null 2>&1; echo $?'
                }
            ];

            const results = {};
            for (const test of tests) {
                try {
                    const result = await this.bridge.executeShellCommand(test.command);
                    const exitCode = parseInt(result.stdout.trim());
                    results[test.name] = {
                        granted: exitCode === 0,
                        exitCode
                    };
                } catch (error) {
                    results[test.name] = {
                        granted: false,
                        error: error.message
                    };
                }
            }

            console.log('🔐 Permission test results:', results);
            return results;
        } catch (error) {
            console.error('❌ Permission test failed:', error.message);
            return { error: error.message };
        }
    }

    async createConnectionLink() {
        try {
            const status = await this.getStatus();
            await this.refreshSessionInfo();

            const connectionInfo = {
                hostname: status.hostname,
                localIP: this.extractLocalIP(status.networkInfo),
                sessionId: this.sessionInfo?.sessionId || 'UNKNOWN',
                timestamp: new Date().toISOString(),
                methods: []
            };

            // Add connection methods
            if (connectionInfo.localIP) {
                connectionInfo.methods.push({
                    type: 'direct_ip',
                    connection: `${connectionInfo.localIP}:8765`,
                    description: 'Direct IP connection'
                });
            }

            if (connectionInfo.hostname) {
                connectionInfo.methods.push({
                    type: 'hostname',
                    connection: `${connectionInfo.hostname}:8765`,
                    description: 'Hostname connection'
                });
            }

            if (connectionInfo.sessionId && connectionInfo.sessionId !== 'UNKNOWN') {
                connectionInfo.methods.push({
                    type: 'session_id',
                    connection: connectionInfo.sessionId,
                    description: 'OpenLink session ID'
                });
            }

            // Save connection info
            const connectionFile = path.join(os.homedir(), '.openlink', 'current-connection.json');
            fs.writeFileSync(connectionFile, JSON.stringify(connectionInfo, null, 2));

            console.log('🔗 Connection info created:', connectionInfo);
            return connectionInfo;
        } catch (error) {
            console.error('❌ Failed to create connection link:', error.message);
            return { error: error.message };
        }
    }

    extractLocalIP(networkInfo) {
        const lines = networkInfo.split('\n');
        for (const line of lines) {
            const match = line.match(/inet (\d+\.\d+\.\d+\.\d+)/);
            if (match && !match[1].startsWith('127.')) {
                return match[1];
            }
        }
        return null;
    }

    // Command script generators
    generateClaudeStatusCommand() {
        return `#!/bin/bash
echo "🤖 Claude OpenLink Status"
echo "========================="
echo "Date: $(date)"
echo "Host: $(hostname)"
echo "IP: $(ifconfig | grep 'inet ' | grep -v '127.0.0.1' | head -1 | awk '{print $2}')"
echo ""
echo "OpenLink Processes:"
ps aux | grep -i openlink | grep -v grep | head -5
echo ""
echo "Network Connections:"
lsof -i | grep -i openlink | head -3
echo ""
echo "Session Files:"
find ~/Library -name "*session*" -path "*OpenLink*" 2>/dev/null | head -3
`;
    }

    generateClaudeStartHostCommand() {
        return `#!/bin/bash
echo "🚀 Claude: Starting OpenLink hosting..."

# Try development version first
if [ -d "/Users/admin/dev/apps/openlink/electron" ]; then
    echo "📱 Starting development version..."
    cd /Users/admin/dev/apps/openlink/electron
    npm run dev > /tmp/openlink-claude-start.log 2>&1 &
    sleep 3
    echo "✅ Development version started"
else
    echo "📱 Opening installed OpenLink app..."
    open -a "OpenLink"
    sleep 2
    echo "✅ App opened"
fi

echo "🔍 Checking for session info..."
sleep 2
ps aux | grep -i openlink | grep -v grep | head -1
`;
    }

    generateClaudeStopHostCommand() {
        return `#!/bin/bash
echo "🛑 Claude: Stopping OpenLink..."
pkill -f "OpenLink"
pkill -f "electron.*openlink"
sleep 1
echo "✅ OpenLink stopped"
`;
    }

    generateGetSessionIdCommand() {
        return `#!/bin/bash
echo "🔍 Claude: Looking for session ID..."

# Check session files
SESSION_DIRS=(
    "$HOME/Library/Application Support/OpenLink"
    "$HOME/Library/Application Support/openlink"
    "/tmp"
)

for dir in "\${SESSION_DIRS[@]}"; do
    if [ -f "$dir/session.json" ]; then
        echo "📋 Found session file: $dir/session.json"
        cat "$dir/session.json"
        exit 0
    fi
done

# Check logs for session info
echo "📝 Checking logs for session info..."
tail -20 /tmp/openlink-claude-start.log 2>/dev/null | grep -i "session\\|hosting\\|id" | head -5

echo "⚠️  No session file found"
`;
    }

    generateTestPermissionsCommand() {
        return `#!/bin/bash
echo "🔐 Claude: Testing macOS permissions..."

echo "Screen Recording:"
osascript -e 'tell application "System Events" to get name of every application process' >/dev/null 2>&1
if [ $? -eq 0 ]; then
    echo "✅ Granted"
else
    echo "❌ Denied"
fi

echo ""
echo "Accessibility:"
osascript -e 'tell application "System Events" to click' 2>/dev/null
if [ $? -eq 0 ]; then
    echo "✅ Granted"
else
    echo "❌ Denied"
fi

echo ""
echo "Input Monitoring:"
ioreg -l | grep -i "IOHIDSystem" >/dev/null 2>&1
if [ $? -eq 0 ]; then
    echo "✅ Available"
else
    echo "❌ Unavailable"
fi
`;
    }

    generateCreateConnectionLinkCommand() {
        return `#!/bin/bash
echo "🔗 Claude: Creating connection link..."

HOSTNAME=$(hostname)
LOCAL_IP=$(ifconfig | grep 'inet ' | grep -v '127.0.0.1' | head -1 | awk '{print $2}')

echo "Host: $HOSTNAME"
echo "IP: $LOCAL_IP"
echo ""
echo "Connection methods:"
echo "1. Direct IP: $LOCAL_IP:8765"
echo "2. Hostname: $HOSTNAME:8765"
echo "3. Session ID: (check session files)"
echo ""
echo "For Windows PC, use:"
echo "  https://raywonderis.me/uploads/website_specific/apps/openlink/OpenLink Setup 1.3.6.exe"
`;
    }
}

module.exports = ClaudeOpenLinkManager;