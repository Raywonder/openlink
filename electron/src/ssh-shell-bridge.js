/**
 * SSH/Shell Bridge for OpenLink
 * Enables SSH access and direct shell commands for power users
 * Provides fallback when web UI is unavailable
 */

const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

class SSHShellBridge {
    constructor(options = {}) {
        this.options = {
            enableSSH: false,
            sshPort: 2222,
            allowShellCommands: false,
            allowedUsers: ['admin', process.env.USER],
            commandTimeout: 30000,
            maxConcurrentSessions: 5,
            logCommands: true,
            ...options
        };

        this.activeSessions = new Map();
        this.commandHistory = [];
        this.isEnabled = false;
        this.sshServer = null;

        this.init();
    }

    async init() {
        if (this.options.enableSSH) {
            await this.setupSSHAccess();
        }

        if (this.options.allowShellCommands) {
            this.setupShellCommands();
        }

        this.log('SSH/Shell Bridge initialized');
    }

    /**
     * Setup SSH access for remote shell control
     */
    async setupSSHAccess() {
        try {
            // Check if SSH is available
            const sshStatus = await this.checkSSHStatus();

            if (sshStatus.running) {
                this.log('SSH daemon already running');
                this.options.sshPort = sshStatus.port || 22;
            } else {
                // Start SSH service if needed (macOS/Linux)
                if (process.platform !== 'win32') {
                    await this.startSSHService();
                }
            }

            // Create OpenLink-specific SSH commands
            await this.createSSHCommands();

            this.isEnabled = true;
            this.log(`SSH access enabled on port ${this.options.sshPort}`);

        } catch (error) {
            this.log(`Failed to setup SSH access: ${error.message}`);
        }
    }

    /**
     * Check SSH daemon status
     */
    async checkSSHStatus() {
        return new Promise((resolve) => {
            if (process.platform === 'darwin') {
                exec('sudo launchctl list | grep ssh', (error, stdout) => {
                    const running = !error && stdout.includes('ssh');
                    resolve({ running, port: 22 });
                });
            } else if (process.platform === 'linux') {
                exec('systemctl is-active sshd', (error, stdout) => {
                    const running = !error && stdout.trim() === 'active';
                    resolve({ running, port: 22 });
                });
            } else {
                // Windows - check for OpenSSH
                exec('Get-Service -Name sshd', { shell: 'powershell' }, (error, stdout) => {
                    const running = !error && stdout.includes('Running');
                    resolve({ running, port: 22 });
                });
            }
        });
    }

    /**
     * Start SSH service
     */
    async startSSHService() {
        return new Promise((resolve, reject) => {
            if (process.platform === 'darwin') {
                exec('sudo launchctl load -w /System/Library/LaunchDaemons/ssh.plist', (error) => {
                    if (error && !error.message.includes('already loaded')) {
                        reject(error);
                    } else {
                        resolve();
                    }
                });
            } else if (process.platform === 'linux') {
                exec('sudo systemctl start sshd', (error) => {
                    if (error) reject(error);
                    else resolve();
                });
            } else {
                // Windows OpenSSH
                exec('Start-Service sshd', { shell: 'powershell' }, (error) => {
                    if (error) reject(error);
                    else resolve();
                });
            }
        });
    }

    /**
     * Create SSH command scripts for OpenLink control
     */
    async createSSHCommands() {
        const commandsDir = path.join(os.homedir(), '.openlink', 'ssh-commands');

        if (!fs.existsSync(commandsDir)) {
            fs.mkdirSync(commandsDir, { recursive: true });
        }

        // Create command scripts
        const commands = {
            'openlink-status': this.generateStatusCommand(),
            'openlink-start-host': this.generateStartHostCommand(),
            'openlink-stop-host': this.generateStopHostCommand(),
            'openlink-connect': this.generateConnectCommand(),
            'openlink-get-session': this.generateGetSessionCommand(),
            'openlink-permissions': this.generatePermissionsCommand()
        };

        for (const [name, script] of Object.entries(commands)) {
            const scriptPath = path.join(commandsDir, name);
            fs.writeFileSync(scriptPath, script, { mode: 0o755 });
        }

        // Add to PATH
        await this.addToPath(commandsDir);
    }

    /**
     * Setup shell command interface
     */
    setupShellCommands() {
        // Create IPC listener for shell commands
        process.on('message', (message) => {
            if (message.type === 'shell-command') {
                this.executeShellCommand(message.command, message.sessionId);
            }
        });

        this.log('Shell command interface enabled');
    }

    /**
     * Execute shell command safely
     */
    async executeShellCommand(command, sessionId = null) {
        const session = {
            id: sessionId || crypto.randomBytes(16).toString('hex'),
            command,
            startTime: Date.now(),
            user: process.env.USER
        };

        this.activeSessions.set(session.id, session);

        if (this.options.logCommands) {
            this.commandHistory.push({
                ...session,
                timestamp: new Date().toISOString()
            });
        }

        try {
            const result = await this.runCommand(command, session.id);
            session.result = result;
            session.status = 'completed';

            return result;
        } catch (error) {
            session.error = error.message;
            session.status = 'failed';
            throw error;
        } finally {
            this.activeSessions.delete(session.id);
        }
    }

    /**
     * Run command with timeout and safety checks
     */
    async runCommand(command, sessionId) {
        return new Promise((resolve, reject) => {
            // Security check - only allow safe commands
            if (!this.isCommandSafe(command)) {
                reject(new Error('Command not allowed for security reasons'));
                return;
            }

            const child = spawn('sh', ['-c', command], {
                stdio: 'pipe',
                timeout: this.options.commandTimeout
            });

            let stdout = '';
            let stderr = '';

            child.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            child.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            child.on('close', (code) => {
                resolve({
                    sessionId,
                    code,
                    stdout: stdout.trim(),
                    stderr: stderr.trim(),
                    success: code === 0
                });
            });

            child.on('error', (error) => {
                reject(new Error(`Command execution failed: ${error.message}`));
            });

            // Store child process for potential termination
            const session = this.activeSessions.get(sessionId);
            if (session) {
                session.process = child;
            }
        });
    }

    /**
     * Check if command is safe to execute
     */
    isCommandSafe(command) {
        // Whitelist approach - only allow specific OpenLink and system commands
        const allowedCommands = [
            /^openlink-/,
            /^ps aux/,
            /^ls /,
            /^pwd$/,
            /^whoami$/,
            /^date$/,
            /^uptime$/,
            /^hostname$/,
            /^ifconfig/,
            /^netstat/,
            /^lsof/,
            /^top -l 1/,
            /^df -h/,
            /^free -h/,
            // OpenLink specific
            /electron\s+\./,
            /npm\s+(start|run)/,
            // Network diagnostics
            /^ping -c \d+ /,
            /^curl -s /,
            /^nslookup /
        ];

        // Blacklist dangerous commands
        const dangerousCommands = [
            /rm\s+-rf/,
            /sudo\s+rm/,
            />\s*\/dev\/null/,
            /chmod\s+777/,
            /chown\s+/,
            /passwd/,
            /su\s+/,
            /sudo\s+su/,
            /mkfs/,
            /fdisk/,
            /dd\s+/,
            /kill\s+-9/,
            /killall/,
            /reboot/,
            /shutdown/,
            /halt/,
            /init\s+0/
        ];

        // Check against dangerous patterns first
        for (const pattern of dangerousCommands) {
            if (pattern.test(command)) {
                return false;
            }
        }

        // Check against allowed patterns
        for (const pattern of allowedCommands) {
            if (pattern.test(command)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Generate command scripts
     */
    generateStatusCommand() {
        return `#!/bin/bash
# OpenLink Status Command
echo "OpenLink Status Report"
echo "====================="
echo "Date: $(date)"
echo "Host: $(hostname)"
echo "User: $(whoami)"
echo ""
echo "OpenLink Processes:"
ps aux | grep -i openlink | grep -v grep
echo ""
echo "Network Status:"
ifconfig | grep inet | grep -v 127.0.0.1
echo ""
echo "Active Connections:"
lsof -i | grep -i openlink | head -5
`;
    }

    generateStartHostCommand() {
        return `#!/bin/bash
# Start OpenLink Hosting Session
echo "Starting OpenLink hosting session..."
cd ~/dev/apps/openlink/electron 2>/dev/null || cd /Applications/OpenLink.app/Contents/Resources
if [ -f "src/main.js" ]; then
    echo "Starting development version..."
    npm start &
    sleep 3
    echo "Development server started. Check the app for session ID."
else
    echo "Starting installed version..."
    open -a OpenLink
    echo "OpenLink app opened. Use the GUI to start hosting."
fi
`;
    }

    generateStopHostCommand() {
        return `#!/bin/bash
# Stop OpenLink Sessions
echo "Stopping OpenLink sessions..."
pkill -f "OpenLink"
pkill -f "electron.*openlink"
echo "OpenLink processes terminated."
`;
    }

    generateConnectCommand() {
        return `#!/bin/bash
# Connect to OpenLink Session
if [ -z "$1" ]; then
    echo "Usage: openlink-connect <session-id>"
    exit 1
fi

SESSION_ID="$1"
echo "Connecting to session: $SESSION_ID"
open -a OpenLink --args --connect "$SESSION_ID"
`;
    }

    generateGetSessionCommand() {
        return `#!/bin/bash
# Get current OpenLink session information
echo "Current OpenLink Session Information:"
echo "===================================="

# Check for running sessions
ps aux | grep -i openlink | grep -v grep | while read line; do
    echo "Process: $line"
done

# Try to read session info from app data
SESSION_FILE="$HOME/Library/Application Support/OpenLink/session.json"
if [ -f "$SESSION_FILE" ]; then
    echo ""
    echo "Session Data:"
    cat "$SESSION_FILE"
fi
`;
    }

    generatePermissionsCommand() {
        return `#!/bin/bash
# Check and request macOS permissions for OpenLink
echo "Checking macOS permissions for OpenLink..."

if [ "$(uname)" != "Darwin" ]; then
    echo "This command is only for macOS"
    exit 1
fi

echo "Checking Screen Recording permission..."
# Check if screen recording is allowed
osascript -e 'tell application "System Events" to get name of every application process' >/dev/null 2>&1
if [ $? -eq 0 ]; then
    echo "✅ Screen Recording: Granted"
else
    echo "❌ Screen Recording: Denied - Please grant in System Preferences"
fi

echo ""
echo "Checking Accessibility permission..."
# Check accessibility permission
if [ -x "/usr/bin/sqlite3" ]; then
    RESULT=$(sqlite3 /Library/Application\\ Support/com.apple.TCC/TCC.db "SELECT * FROM access WHERE service='kTCCServiceAccessibility' AND client='com.openlink.app';" 2>/dev/null)
    if [ -n "$RESULT" ]; then
        echo "✅ Accessibility: Configured"
    else
        echo "❌ Accessibility: Not configured - Please grant in System Preferences"
    fi
else
    echo "⚠️  Accessibility: Cannot check - Please verify manually"
fi

echo ""
echo "To grant permissions:"
echo "1. Open System Preferences > Security & Privacy > Privacy"
echo "2. Add OpenLink to Screen Recording and Accessibility"
echo "3. Restart OpenLink"
`;
    }

    /**
     * Add directory to PATH
     */
    async addToPath(directory) {
        const shellRc = path.join(os.homedir(), '.zshrc');
        const pathExport = `\nexport PATH="$PATH:${directory}"\n`;

        try {
            const content = fs.readFileSync(shellRc, 'utf8');
            if (!content.includes(directory)) {
                fs.appendFileSync(shellRc, pathExport);
            }
        } catch (error) {
            // Create .zshrc if it doesn't exist
            fs.writeFileSync(shellRc, pathExport);
        }
    }

    /**
     * Get connection information
     */
    getConnectionInfo() {
        const hostname = os.hostname();
        const networkInterfaces = os.networkInterfaces();

        let localIP = null;
        for (const [name, interfaces] of Object.entries(networkInterfaces)) {
            for (const iface of interfaces) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    localIP = iface.address;
                    break;
                }
            }
            if (localIP) break;
        }

        return {
            hostname,
            localIP,
            sshPort: this.options.sshPort,
            sshEnabled: this.isEnabled,
            commandsAvailable: this.options.allowShellCommands
        };
    }

    /**
     * Generate SSH connection string
     */
    generateSSHConnection(username = process.env.USER) {
        const info = this.getConnectionInfo();

        if (!this.isEnabled) {
            return 'SSH access not enabled';
        }

        const connections = [];

        // Local IP connection
        if (info.localIP) {
            connections.push(`ssh ${username}@${info.localIP} -p ${info.sshPort}`);
        }

        // Hostname connection
        if (info.hostname) {
            connections.push(`ssh ${username}@${info.hostname} -p ${info.sshPort}`);
        }

        return connections;
    }

    /**
     * Kill session by ID
     */
    killSession(sessionId) {
        const session = this.activeSessions.get(sessionId);
        if (session && session.process) {
            session.process.kill();
            this.activeSessions.delete(sessionId);
            return true;
        }
        return false;
    }

    /**
     * Get active sessions
     */
    getActiveSessions() {
        return Array.from(this.activeSessions.values()).map(session => ({
            id: session.id,
            command: session.command,
            startTime: session.startTime,
            user: session.user,
            status: session.status || 'running'
        }));
    }

    /**
     * Logging utility
     */
    log(message) {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] SSH/Shell Bridge: ${message}`);
    }
}

module.exports = SSHShellBridge;