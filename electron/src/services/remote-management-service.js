/**
 * Remote Management Service for OpenLink
 * Enables remote system management over WebSocket connection
 * Allows enabling SSH, running PowerShell commands, and system configuration
 */

const { exec, spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

class RemoteManagementService {
    constructor(options = {}) {
        this.options = {
            allowRemoteCommands: true,
            requireApproval: true,  // Require user approval for sensitive commands
            commandTimeout: 60000,
            logCommands: true,
            ...options
        };

        this.pendingApprovals = new Map();
        this.commandHistory = [];
        this.isEnabled = false;
    }

    /**
     * Initialize the service
     */
    init(mainWindow) {
        this.mainWindow = mainWindow;
        this.isEnabled = true;
        console.log('[RemoteManagement] Service initialized');
    }

    /**
     * Handle remote management command
     * @param {string} command - The command to execute
     * @param {Object} context - Connection context
     * @returns {Promise<Object>} - Command result
     */
    async handleCommand(command, context = {}) {
        const parsed = this.parseCommand(command);

        if (!parsed) {
            return { success: false, error: 'Invalid command' };
        }

        // Check if command requires approval
        if (this.options.requireApproval && this.isSensitiveCommand(parsed.action)) {
            return await this.requestApproval(parsed, context);
        }

        return await this.executeCommand(parsed, context);
    }

    /**
     * Parse command string into action and parameters
     */
    parseCommand(command) {
        const parts = command.trim().split(/\s+/);
        if (parts.length === 0) return null;

        const action = parts[0].toLowerCase();
        const params = parts.slice(1);

        return { action, params, raw: command };
    }

    /**
     * Check if command requires user approval
     */
    isSensitiveCommand(action) {
        const sensitiveActions = [
            'enable-ssh',
            'disable-ssh',
            'install-openssh',
            'install-ssh-full',
            'configure-sshd',
            'generate-ssh-keys',
            'run-powershell',
            'restart-service',
            'stop-service',
            'reboot',
            'shutdown'
        ];
        return sensitiveActions.includes(action);
    }

    /**
     * Request user approval for sensitive command
     */
    async requestApproval(parsed, context) {
        return new Promise((resolve) => {
            const approvalId = Date.now().toString();

            this.pendingApprovals.set(approvalId, {
                command: parsed,
                context,
                resolve,
                timestamp: Date.now()
            });

            // Send approval request to renderer
            if (this.mainWindow) {
                this.mainWindow.webContents.send('remote-management-approval', {
                    id: approvalId,
                    action: parsed.action,
                    params: parsed.params,
                    fromDevice: context.deviceName || 'Unknown device',
                    fromUser: context.userName || 'Unknown user'
                });
            }

            // Auto-deny after timeout
            setTimeout(() => {
                if (this.pendingApprovals.has(approvalId)) {
                    this.pendingApprovals.delete(approvalId);
                    resolve({ success: false, error: 'Approval timeout' });
                }
            }, 60000);
        });
    }

    /**
     * Handle approval response from user
     */
    async handleApprovalResponse(approvalId, approved) {
        const pending = this.pendingApprovals.get(approvalId);
        if (!pending) {
            return { success: false, error: 'Approval not found or expired' };
        }

        this.pendingApprovals.delete(approvalId);

        if (approved) {
            const result = await this.executeCommand(pending.command, pending.context);
            pending.resolve(result);
            return result;
        } else {
            const result = { success: false, error: 'User denied the request' };
            pending.resolve(result);
            return result;
        }
    }

    /**
     * Execute the command
     */
    async executeCommand(parsed, context) {
        const { action, params } = parsed;

        // Log command
        if (this.options.logCommands) {
            this.commandHistory.push({
                action,
                params,
                context,
                timestamp: Date.now()
            });
        }

        try {
            switch (action) {
                case 'enable-ssh':
                    return await this.enableSSH();
                case 'disable-ssh':
                    return await this.disableSSH();
                case 'install-openssh':
                    return await this.installOpenSSH();
                case 'install-ssh-full':
                    return await this.installSSHFull({
                        generateKeys: !params.includes('--no-keys'),
                        allowPasswordAuth: !params.includes('--no-password')
                    });
                case 'configure-sshd':
                    return await this.configureSSHD(!params.includes('--no-password'));
                case 'generate-ssh-keys':
                    return await this.generateSSHKeys();
                case 'ssh-status':
                    return await this.getSSHStatus();
                case 'get-ip':
                    return this.getIPAddresses();
                case 'get-system-info':
                    return this.getSystemInfo();
                case 'restart-openlink':
                    return await this.restartOpenLink();
                case 'update-openlink':
                    return await this.triggerUpdate();
                case 'run-powershell':
                    return await this.runPowerShell(params.join(' '));
                case 'ping':
                    return { success: true, message: 'pong', timestamp: Date.now() };
                default:
                    return { success: false, error: `Unknown command: ${action}` };
            }
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Enable SSH on Windows
     */
    async enableSSH() {
        if (process.platform !== 'win32') {
            return await this.enableSSHUnix();
        }

        return new Promise((resolve) => {
            const commands = [
                // Start the SSH service
                'Start-Service sshd',
                // Set to auto-start
                "Set-Service -Name sshd -StartupType 'Automatic'"
            ];

            exec(`powershell -Command "${commands.join('; ')}"`, (error, stdout, stderr) => {
                if (error) {
                    // Try to install first if service doesn't exist
                    if (stderr.includes('Cannot find any service')) {
                        this.installOpenSSH().then(resolve);
                        return;
                    }
                    resolve({ success: false, error: stderr || error.message });
                } else {
                    resolve({
                        success: true,
                        message: 'SSH service enabled and set to auto-start',
                        output: stdout
                    });
                }
            });
        });
    }

    /**
     * Enable SSH on macOS/Linux
     */
    async enableSSHUnix() {
        return new Promise((resolve) => {
            if (process.platform === 'darwin') {
                exec('sudo launchctl load -w /System/Library/LaunchDaemons/ssh.plist', (error, stdout, stderr) => {
                    if (error && !error.message.includes('already loaded')) {
                        resolve({ success: false, error: stderr || error.message });
                    } else {
                        resolve({ success: true, message: 'SSH enabled (Remote Login)' });
                    }
                });
            } else {
                exec('sudo systemctl enable --now sshd', (error, stdout, stderr) => {
                    if (error) {
                        resolve({ success: false, error: stderr || error.message });
                    } else {
                        resolve({ success: true, message: 'SSH service enabled' });
                    }
                });
            }
        });
    }

    /**
     * Disable SSH
     */
    async disableSSH() {
        return new Promise((resolve) => {
            if (process.platform === 'win32') {
                exec('powershell -Command "Stop-Service sshd; Set-Service -Name sshd -StartupType Disabled"', (error, stdout, stderr) => {
                    if (error) {
                        resolve({ success: false, error: stderr || error.message });
                    } else {
                        resolve({ success: true, message: 'SSH service disabled' });
                    }
                });
            } else if (process.platform === 'darwin') {
                exec('sudo launchctl unload -w /System/Library/LaunchDaemons/ssh.plist', (error) => {
                    resolve({ success: !error, message: error ? error.message : 'SSH disabled' });
                });
            } else {
                exec('sudo systemctl disable --now sshd', (error) => {
                    resolve({ success: !error, message: error ? error.message : 'SSH disabled' });
                });
            }
        });
    }

    /**
     * Install OpenSSH Server on Windows
     */
    async installOpenSSH() {
        if (process.platform !== 'win32') {
            return { success: false, error: 'This command is only for Windows' };
        }

        return new Promise((resolve) => {
            const installCommand = `
                Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0;
                Start-Service sshd;
                Set-Service -Name sshd -StartupType 'Automatic';
                New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -ErrorAction SilentlyContinue
            `;

            exec(`powershell -Command "${installCommand}"`, { timeout: 120000 }, (error, stdout, stderr) => {
                if (error) {
                    resolve({
                        success: false,
                        error: stderr || error.message,
                        note: 'May require administrator privileges'
                    });
                } else {
                    resolve({
                        success: true,
                        message: 'OpenSSH Server installed and configured',
                        output: stdout
                    });
                }
            });
        });
    }

    /**
     * Get SSH status
     */
    async getSSHStatus() {
        return new Promise((resolve) => {
            if (process.platform === 'win32') {
                exec('powershell -Command "Get-Service sshd | Select-Object Status, StartType | ConvertTo-Json"', (error, stdout) => {
                    if (error) {
                        resolve({
                            success: true,
                            installed: false,
                            running: false,
                            message: 'OpenSSH Server not installed'
                        });
                    } else {
                        try {
                            const status = JSON.parse(stdout);
                            resolve({
                                success: true,
                                installed: true,
                                running: status.Status === 4, // 4 = Running
                                startType: status.StartType,
                                platform: 'windows'
                            });
                        } catch (e) {
                            resolve({ success: true, installed: true, running: stdout.includes('Running') });
                        }
                    }
                });
            } else if (process.platform === 'darwin') {
                exec('sudo launchctl list | grep ssh', (error, stdout) => {
                    resolve({
                        success: true,
                        installed: true,
                        running: !error && stdout.includes('ssh'),
                        platform: 'darwin'
                    });
                });
            } else {
                exec('systemctl is-active sshd', (error, stdout) => {
                    resolve({
                        success: true,
                        installed: true,
                        running: !error && stdout.trim() === 'active',
                        platform: 'linux'
                    });
                });
            }
        });
    }

    /**
     * Full SSH installation with configuration (for remote Windows machines)
     * @param {object} options - Installation options
     * @returns {object} Result with installation steps
     */
    async installSSHFull(options = {}) {
        const { generateKeys = true, allowPasswordAuth = true } = options;

        if (process.platform !== 'win32') {
            return { success: false, error: 'Full SSH install only available for Windows' };
        }

        const steps = [];

        // Step 1: Check if already installed
        steps.push({ step: 'check', status: 'pending' });
        const status = await this.getSSHStatus();
        if (status.installed && status.running) {
            steps[0].status = 'skipped';
            steps[0].message = 'SSH already installed and running';
            return { success: true, alreadyInstalled: true, status, steps };
        }
        steps[0].status = 'complete';

        // Step 2: Install OpenSSH
        steps.push({ step: 'install', status: 'pending' });
        try {
            const installResult = await this.installOpenSSH();
            if (!installResult.success) {
                steps[1].status = 'failed';
                steps[1].error = installResult.error;
                return { success: false, steps, error: installResult.error };
            }
            steps[1].status = 'complete';
        } catch (e) {
            steps[1].status = 'failed';
            steps[1].error = e.message;
            return { success: false, steps, error: e.message };
        }

        // Step 3: Configure sshd_config
        steps.push({ step: 'configure', status: 'pending' });
        try {
            await this.configureSSHD(allowPasswordAuth);
            steps[2].status = 'complete';
        } catch (e) {
            steps[2].status = 'warning';
            steps[2].error = e.message;
            // Non-fatal, continue
        }

        // Step 4: Generate keys if requested
        if (generateKeys) {
            steps.push({ step: 'keygen', status: 'pending' });
            try {
                await this.generateSSHKeys();
                steps[3].status = 'complete';
            } catch (e) {
                steps[3].status = 'warning';
                steps[3].error = e.message;
                // Non-fatal
            }
        }

        // Step 5: Final verification
        steps.push({ step: 'verify', status: 'pending' });
        const finalStatus = await this.getSSHStatus();
        steps[steps.length - 1].status = finalStatus.running ? 'complete' : 'failed';

        return {
            success: finalStatus.running,
            steps,
            status: finalStatus,
            ipAddresses: this.getIPAddresses()
        };
    }

    /**
     * Configure sshd_config on Windows
     * @param {boolean} allowPasswordAuth - Whether to allow password authentication
     */
    async configureSSHD(allowPasswordAuth = true) {
        if (process.platform !== 'win32') {
            return { success: false, error: 'SSHD configuration only available for Windows' };
        }

        return new Promise((resolve, reject) => {
            const configPath = 'C:\\\\ProgramData\\\\ssh\\\\sshd_config';
            const passwordSetting = allowPasswordAuth ? 'yes' : 'no';

            const configCommands = `
                $configPath = "${configPath}"

                # Ensure config file exists
                if (!(Test-Path $configPath)) {
                    $defaultConfig = "C:\\Windows\\System32\\OpenSSH\\sshd_config_default"
                    if (Test-Path $defaultConfig) {
                        Copy-Item $defaultConfig $configPath
                    }
                }

                if (Test-Path $configPath) {
                    # Set password authentication
                    $content = Get-Content $configPath
                    $content = $content -replace '#?PasswordAuthentication.*', 'PasswordAuthentication ${passwordSetting}'
                    $content | Set-Content $configPath

                    # Restart service to apply
                    Restart-Service sshd -Force
                    Write-Output "Configuration updated successfully"
                } else {
                    Write-Error "Config file not found"
                }
            `;

            exec(`powershell -Command "${configCommands}"`, { timeout: 30000 }, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(stderr || error.message));
                } else {
                    resolve({ success: true, output: stdout });
                }
            });
        });
    }

    /**
     * Generate SSH host keys on Windows
     */
    async generateSSHKeys() {
        if (process.platform !== 'win32') {
            return { success: false, error: 'SSH key generation only available for Windows' };
        }

        return new Promise((resolve, reject) => {
            const keygenCommand = `
                $sshDir = "C:\\ProgramData\\ssh"
                if (!(Test-Path $sshDir)) {
                    New-Item -ItemType Directory -Path $sshDir -Force
                }

                # Generate host keys if they don't exist
                $keyTypes = @("rsa", "ecdsa", "ed25519")
                foreach ($type in $keyTypes) {
                    $keyFile = "$sshDir\\ssh_host_${type}_key"
                    if (!(Test-Path $keyFile)) {
                        ssh-keygen -t $type -f $keyFile -N '""' -q
                        Write-Output "Generated $type key"
                    }
                }

                Write-Output "SSH keys ready"
            `;

            exec(`powershell -Command "${keygenCommand}"`, { timeout: 30000 }, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(stderr || error.message));
                } else {
                    resolve({ success: true, output: stdout });
                }
            });
        });
    }

    /**
     * Get IP addresses
     */
    getIPAddresses() {
        const interfaces = os.networkInterfaces();
        const addresses = [];

        for (const [name, nets] of Object.entries(interfaces)) {
            for (const net of nets) {
                if (!net.internal) {
                    addresses.push({
                        interface: name,
                        family: net.family,
                        address: net.address
                    });
                }
            }
        }

        // Check for Tailscale
        const tailscale = addresses.find(a => a.interface.toLowerCase().includes('tailscale') ||
                                               a.address.startsWith('100.64.') ||
                                               a.address.startsWith('100.'));

        return {
            success: true,
            addresses,
            tailscale: tailscale ? tailscale.address : null,
            primary: addresses.find(a => a.family === 'IPv4')?.address || null
        };
    }

    /**
     * Get system information
     */
    getSystemInfo() {
        return {
            success: true,
            hostname: os.hostname(),
            platform: os.platform(),
            arch: os.arch(),
            release: os.release(),
            uptime: os.uptime(),
            totalMemory: os.totalmem(),
            freeMemory: os.freemem(),
            cpus: os.cpus().length,
            user: os.userInfo().username,
            homeDir: os.homedir()
        };
    }

    /**
     * Restart OpenLink application
     */
    async restartOpenLink() {
        // Use electron's app.relaunch() via IPC
        if (this.mainWindow) {
            this.mainWindow.webContents.send('trigger-restart');
        }
        return { success: true, message: 'Restart triggered' };
    }

    /**
     * Trigger application update
     */
    async triggerUpdate() {
        if (this.mainWindow) {
            this.mainWindow.webContents.send('trigger-update-check');
        }
        return { success: true, message: 'Update check triggered' };
    }

    /**
     * Run PowerShell command (Windows only, with strict filtering)
     */
    async runPowerShell(command) {
        if (process.platform !== 'win32') {
            return { success: false, error: 'PowerShell only available on Windows' };
        }

        // Whitelist safe commands
        const safePatterns = [
            /^Get-Service/i,
            /^Get-Process/i,
            /^Get-NetIPAddress/i,
            /^Get-NetAdapter/i,
            /^Get-ComputerInfo/i,
            /^Get-WmiObject/i,
            /^hostname$/i,
            /^ipconfig$/i,
            /^whoami$/i,
            /^Get-ChildItem/i
        ];

        const isSafe = safePatterns.some(pattern => pattern.test(command));
        if (!isSafe) {
            return {
                success: false,
                error: 'Command not in whitelist. Only read-only diagnostic commands are allowed remotely.'
            };
        }

        return new Promise((resolve) => {
            exec(`powershell -Command "${command}"`, { timeout: this.options.commandTimeout }, (error, stdout, stderr) => {
                if (error) {
                    resolve({ success: false, error: stderr || error.message });
                } else {
                    resolve({ success: true, output: stdout });
                }
            });
        });
    }

    /**
     * Get command history
     */
    getCommandHistory() {
        return this.commandHistory.slice(-50); // Last 50 commands
    }
}

module.exports = RemoteManagementService;
