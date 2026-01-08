#!/usr/bin/env node

/**
 * OpenLink CLI - Command Line Interface
 * Fallback system when OpenLink UI is failing
 * Provides all OpenLink functionality via command line
 */

const { program } = require('commander');
const chalk = require('chalk');
const ora = require('ora');
const inquirer = require('inquirer');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Import OpenLink managers
const ClaudeOpenLinkManager = require('../claude-openlink-manager');
const HybridConfigManager = require('../api/hybrid-config-manager');
const DynamicDomainManager = require('../api/dynamic-domain-manager');
const OpenLinkUnifiedAPI = require('../api/openlink-unified-api');

class OpenLinkCLI {
    constructor() {
        this.claudeManager = null;
        this.configManager = null;
        this.domainManager = null;
        this.apiServer = null;
        this.isUIFallback = false;

        this.setupCLI();
    }

    setupCLI() {
        program
            .name('openlink')
            .description('OpenLink Remote Desktop CLI - Fallback for UI failures')
            .version('1.3.6')
            .option('-v, --verbose', 'enable verbose logging')
            .option('-q, --quiet', 'suppress non-error output')
            .option('--ui-fallback', 'run as UI fallback mode');

        // Status and diagnostics
        program
            .command('status')
            .description('Show OpenLink system status')
            .option('--json', 'output as JSON')
            .action(this.handleStatus.bind(this));

        program
            .command('check')
            .description('Check system health and permissions')
            .action(this.handleCheck.bind(this));

        // Hosting commands
        program
            .command('host')
            .description('Start hosting a session')
            .option('--port <port>', 'port to use', '8765')
            .option('--password <password>', 'session password')
            .option('--no-audio', 'disable audio sharing')
            .option('--no-input', 'disable remote input')
            .action(this.handleHost.bind(this));

        program
            .command('stop-host')
            .description('Stop hosting session')
            .action(this.handleStopHost.bind(this));

        // Connection commands
        program
            .command('connect <session-id>')
            .description('Connect to a session')
            .option('--password <password>', 'session password')
            .action(this.handleConnect.bind(this));

        program
            .command('disconnect')
            .description('Disconnect from current session')
            .action(this.handleDisconnect.bind(this));

        // Domain management
        program
            .command('domain')
            .description('Domain management commands')
            .addCommand(this.createDomainCommands());

        // Server management
        program
            .command('server')
            .description('Server management commands')
            .addCommand(this.createServerCommands());

        // Session management
        program
            .command('sessions')
            .description('List active sessions')
            .option('--json', 'output as JSON')
            .action(this.handleListSessions.bind(this));

        // Configuration
        program
            .command('config')
            .description('Configuration management')
            .addCommand(this.createConfigCommands());

        // Emergency and recovery
        program
            .command('emergency')
            .description('Emergency recovery commands')
            .addCommand(this.createEmergencyCommands());

        // UI fallback detection
        program
            .command('detect-ui-failure')
            .description('Check if UI is failing and enable CLI fallback')
            .action(this.detectUIFailure.bind(this));
    }

    createDomainCommands() {
        const domainCmd = program.createCommand('domain');

        domainCmd
            .command('request <subdomain>')
            .description('Request a new domain')
            .option('--base <base>', 'base domain', 'openlink.local')
            .option('--port <port>', 'target port', '8765')
            .option('--host <host>', 'target host', 'localhost')
            .option('--ssl', 'enable SSL')
            .option('--temporary', 'create temporary domain')
            .option('--duration <duration>', 'duration in minutes', '60')
            .action(this.handleDomainRequest.bind(this));

        domainCmd
            .command('list')
            .description('List active domains')
            .option('--json', 'output as JSON')
            .action(this.handleDomainList.bind(this));

        domainCmd
            .command('release <domain-id>')
            .description('Release a domain')
            .action(this.handleDomainRelease.bind(this));

        domainCmd
            .command('permit <domain-pattern>')
            .description('Create a permit for domain access')
            .option('--duration <duration>', 'permit duration in minutes', '60')
            .option('--permissions <permissions>', 'comma-separated permissions', 'read,connect')
            .action(this.handleDomainPermit.bind(this));

        return domainCmd;
    }

    createServerCommands() {
        const serverCmd = program.createCommand('server');

        serverCmd
            .command('start')
            .description('Start OpenLink server')
            .option('--port <port>', 'server port', '3000')
            .action(this.handleServerStart.bind(this));

        serverCmd
            .command('stop')
            .description('Stop OpenLink server')
            .action(this.handleServerStop.bind(this));

        serverCmd
            .command('test-connection')
            .description('Test remote server connection')
            .action(this.handleServerTestConnection.bind(this));

        return serverCmd;
    }

    createConfigCommands() {
        const configCmd = program.createCommand('config');

        configCmd
            .command('show')
            .description('Show current configuration')
            .action(this.handleConfigShow.bind(this));

        configCmd
            .command('set <key> <value>')
            .description('Set configuration value')
            .action(this.handleConfigSet.bind(this));

        configCmd
            .command('reset')
            .description('Reset configuration to defaults')
            .action(this.handleConfigReset.bind(this));

        return configCmd;
    }

    createEmergencyCommands() {
        const emergencyCmd = program.createCommand('emergency');

        emergencyCmd
            .command('kill-all')
            .description('Kill all OpenLink processes')
            .action(this.handleEmergencyKillAll.bind(this));

        emergencyCmd
            .command('reset-permissions')
            .description('Reset macOS permissions')
            .action(this.handleEmergencyResetPermissions.bind(this));

        emergencyCmd
            .command('repair-config')
            .description('Repair corrupted configuration')
            .action(this.handleEmergencyRepairConfig.bind(this));

        emergencyCmd
            .command('clean-domains')
            .description('Clean up all domains')
            .action(this.handleEmergencyCleanDomains.bind(this));

        return emergencyCmd;
    }

    async initializeManagers() {
        const spinner = ora('Initializing OpenLink managers...').start();

        try {
            // Initialize Claude manager
            this.claudeManager = new ClaudeOpenLinkManager();
            await this.claudeManager.initialize();

            // Initialize config manager
            this.configManager = new HybridConfigManager();

            // Initialize domain manager
            this.domainManager = new DynamicDomainManager(this.configManager);

            spinner.succeed('Managers initialized');
        } catch (error) {
            spinner.fail(`Failed to initialize managers: ${error.message}`);
            throw error;
        }
    }

    async detectUIFailure() {
        console.log(chalk.yellow('🔍 Detecting UI failure...'));

        const checks = [
            this.checkUIProcess(),
            this.checkUIResponsiveness(),
            this.checkUIFiles(),
            this.checkElectronHealth()
        ];

        const results = await Promise.allSettled(checks);
        const failures = results.filter(r => r.status === 'rejected' || !r.value);

        if (failures.length >= 2) {
            console.log(chalk.red('❌ UI failure detected! Enabling CLI fallback mode...'));
            this.isUIFallback = true;
            await this.enableFallbackMode();
        } else {
            console.log(chalk.green('✅ UI appears to be working normally'));
        }
    }

    async checkUIProcess() {
        try {
            const { spawn } = require('child_process');
            return new Promise((resolve) => {
                const ps = spawn('ps', ['aux']);
                let output = '';

                ps.stdout.on('data', (data) => {
                    output += data.toString();
                });

                ps.on('close', () => {
                    const hasOpenLink = output.includes('OpenLink') || output.includes('electron.*openlink');
                    resolve(hasOpenLink);
                });
            });
        } catch (error) {
            return false;
        }
    }

    async checkUIResponsiveness() {
        // Try to connect to the UI's internal API if available
        try {
            const http = require('http');
            return new Promise((resolve) => {
                const req = http.get('http://localhost:8765/health', { timeout: 5000 }, (res) => {
                    resolve(res.statusCode === 200);
                });

                req.on('error', () => resolve(false));
                req.on('timeout', () => resolve(false));
            });
        } catch (error) {
            return false;
        }
    }

    async checkUIFiles() {
        const requiredFiles = [
            path.join(__dirname, '../ui/index.html'),
            path.join(__dirname, '../ui/app.js'),
            path.join(__dirname, '../main.js')
        ];

        return requiredFiles.every(file => fs.existsSync(file));
    }

    async checkElectronHealth() {
        try {
            const { spawn } = require('child_process');
            return new Promise((resolve) => {
                const electron = spawn('electron', ['--version'], { timeout: 5000 });
                electron.on('close', (code) => resolve(code === 0));
                electron.on('error', () => resolve(false));
            });
        } catch (error) {
            return false;
        }
    }

    async enableFallbackMode() {
        console.log(chalk.blue('🔧 Enabling CLI fallback mode...'));

        // Save fallback state
        const fallbackFile = path.join(os.homedir(), '.openlink', 'cli-fallback.json');
        const fallbackData = {
            enabled: true,
            enabledAt: new Date().toISOString(),
            reason: 'UI failure detected'
        };

        fs.mkdirSync(path.dirname(fallbackFile), { recursive: true });
        fs.writeFileSync(fallbackFile, JSON.stringify(fallbackData, null, 2));

        // Initialize managers for fallback mode
        await this.initializeManagers();

        console.log(chalk.green('✅ CLI fallback mode enabled'));
        console.log(chalk.yellow('💡 Use "openlink --help" to see available commands'));
    }

    // Command handlers
    async handleStatus(options) {
        const spinner = ora('Getting OpenLink status...').start();

        try {
            await this.initializeManagers();

            const status = {
                ui: await this.checkUIResponsiveness() ? 'running' : 'failed',
                claude: await this.claudeManager.getStatus(),
                domains: this.domainManager ? this.domainManager.getStatus() : null,
                config: this.configManager ? this.configManager.getStatus() : null,
                system: {
                    platform: process.platform,
                    hostname: os.hostname(),
                    uptime: os.uptime(),
                    memory: process.memoryUsage()
                },
                timestamp: new Date().toISOString()
            };

            spinner.stop();

            if (options.json) {
                console.log(JSON.stringify(status, null, 2));
            } else {
                this.displayStatus(status);
            }

        } catch (error) {
            spinner.fail(`Failed to get status: ${error.message}`);
            process.exit(1);
        }
    }

    async handleCheck() {
        console.log(chalk.blue('🔍 Running OpenLink health checks...\n'));

        const checks = [
            { name: 'UI Process', check: this.checkUIProcess.bind(this) },
            { name: 'UI Responsiveness', check: this.checkUIResponsiveness.bind(this) },
            { name: 'Required Files', check: this.checkUIFiles.bind(this) },
            { name: 'Electron Health', check: this.checkElectronHealth.bind(this) }
        ];

        if (this.configManager) {
            checks.push({
                name: 'Server Connection',
                check: async () => {
                    const result = await this.configManager.testServerConnection();
                    return result.success;
                }
            });
        }

        for (const { name, check } of checks) {
            const spinner = ora(`Checking ${name}...`).start();
            try {
                const result = await check();
                if (result) {
                    spinner.succeed(`${name}: OK`);
                } else {
                    spinner.fail(`${name}: Failed`);
                }
            } catch (error) {
                spinner.fail(`${name}: Error - ${error.message}`);
            }
        }
    }

    async handleHost(options) {
        const spinner = ora('Starting hosting session...').start();

        try {
            await this.initializeManagers();

            const result = await this.claudeManager.startHosting();

            if (result.success) {
                spinner.succeed('Hosting session started');
                console.log(chalk.green(`📡 Session ID: ${result.sessionInfo?.sessionId || 'N/A'}`));
                console.log(chalk.blue(`🌐 Port: ${options.port}`));

                // Create connection link
                const connectionInfo = await this.claudeManager.createConnectionLink();
                if (connectionInfo.methods) {
                    console.log(chalk.yellow('\n📋 Connection methods:'));
                    connectionInfo.methods.forEach(method => {
                        console.log(`  ${method.type}: ${method.connection}`);
                    });
                }
            } else {
                spinner.fail(`Failed to start hosting: ${result.error}`);
                process.exit(1);
            }

        } catch (error) {
            spinner.fail(`Hosting failed: ${error.message}`);
            process.exit(1);
        }
    }

    async handleStopHost() {
        const spinner = ora('Stopping hosting session...').start();

        try {
            await this.initializeManagers();

            const result = await this.claudeManager.stopHosting();

            if (result.success) {
                spinner.succeed('Hosting session stopped');
            } else {
                spinner.fail(`Failed to stop hosting: ${result.error}`);
                process.exit(1);
            }

        } catch (error) {
            spinner.fail(`Stop hosting failed: ${error.message}`);
            process.exit(1);
        }
    }

    async handleConnect(sessionId, options) {
        console.log(chalk.blue(`🔗 Connecting to session: ${sessionId}`));

        // This would integrate with the existing connection logic
        console.log(chalk.yellow('💡 Connection functionality requires UI integration'));
        console.log(chalk.blue(`To connect manually, use the OpenLink app with session ID: ${sessionId}`));
    }

    async handleDomainRequest(subdomain, options) {
        const spinner = ora(`Requesting domain: ${subdomain}.${options.base}...`).start();

        try {
            await this.initializeManagers();

            const domainRequest = {
                subdomain,
                baseDomain: options.base,
                clientId: 'cli-client-' + Date.now(),
                targetHost: options.host,
                targetPort: parseInt(options.port),
                sslEnabled: options.ssl,
                temporary: options.temporary,
                duration: options.temporary ? parseInt(options.duration) * 60 * 1000 : null
            };

            const domain = await this.domainManager.requestDomain(domainRequest);

            spinner.succeed(`Domain created: ${domain.fullDomain}`);
            console.log(chalk.green(`🌐 Access URL: ${domain.accessUrl}`));
            console.log(chalk.blue(`🔑 Domain ID: ${domain.id}`));

            if (domain.permitToken) {
                console.log(chalk.yellow(`🎫 Permit Token: ${domain.permitToken}`));
            }

        } catch (error) {
            spinner.fail(`Domain request failed: ${error.message}`);
            process.exit(1);
        }
    }

    async handleDomainList(options) {
        const spinner = ora('Fetching domains...').start();

        try {
            await this.initializeManagers();

            const status = this.domainManager.getStatus();
            const domains = Array.from(this.domainManager.domains.values());

            spinner.stop();

            if (options.json) {
                console.log(JSON.stringify(domains, null, 2));
            } else {
                console.log(chalk.blue('📋 Active Domains:\n'));

                if (domains.length === 0) {
                    console.log(chalk.gray('  No active domains'));
                } else {
                    domains.forEach(domain => {
                        console.log(chalk.green(`  ${domain.fullDomain}`));
                        console.log(chalk.gray(`    ID: ${domain.id}`));
                        console.log(chalk.gray(`    Port: ${domain.port}`));
                        console.log(chalk.gray(`    Expires: ${domain.expiresAt}`));
                        console.log('');
                    });
                }

                console.log(chalk.blue(`Total: ${domains.length} domains`));
            }

        } catch (error) {
            spinner.fail(`Failed to list domains: ${error.message}`);
            process.exit(1);
        }
    }

    async handleEmergencyKillAll() {
        console.log(chalk.red('🚨 Emergency: Killing all OpenLink processes...'));

        const { spawn } = require('child_process');

        const commands = [
            'pkill -f "OpenLink"',
            'pkill -f "electron.*openlink"',
            'pkill -f "openlink"'
        ];

        for (const cmd of commands) {
            try {
                await new Promise((resolve) => {
                    const proc = spawn('sh', ['-c', cmd]);
                    proc.on('close', resolve);
                });
            } catch (error) {
                // Ignore errors
            }
        }

        console.log(chalk.green('✅ All OpenLink processes terminated'));
    }

    displayStatus(status) {
        console.log(chalk.blue('📊 OpenLink System Status\n'));

        // UI Status
        const uiStatus = status.ui === 'running' ? chalk.green('✅ Running') : chalk.red('❌ Failed');
        console.log(`UI: ${uiStatus}`);

        // Claude Status
        if (status.claude) {
            const claudeStatus = status.claude.running ? chalk.green('✅ Running') : chalk.yellow('⏸️ Stopped');
            console.log(`Claude Manager: ${claudeStatus} (${status.claude.processes} processes)`);
        }

        // Domains
        if (status.domains) {
            console.log(`Domains: ${status.domains.domains.active} active`);
            console.log(`  Local: ${status.domains.domains.byType.local}`);
            console.log(`  Public: ${status.domains.domains.byType.public}`);
        }

        // System
        console.log(`\nSystem: ${status.system.platform} (${status.system.hostname})`);
        console.log(`Uptime: ${Math.round(status.system.uptime / 3600)}h`);
        console.log(`Memory: ${Math.round(status.system.memory.heapUsed / 1024 / 1024)}MB`);

        if (this.isUIFallback) {
            console.log(chalk.yellow('\n⚠️  Running in CLI fallback mode due to UI failure'));
        }
    }

    run() {
        // Check if already in fallback mode
        const fallbackFile = path.join(os.homedir(), '.openlink', 'cli-fallback.json');
        if (fs.existsSync(fallbackFile)) {
            try {
                const fallbackData = JSON.parse(fs.readFileSync(fallbackFile, 'utf8'));
                if (fallbackData.enabled) {
                    this.isUIFallback = true;
                    console.log(chalk.yellow('⚠️  CLI fallback mode is active'));
                }
            } catch (error) {
                // Ignore errors reading fallback file
            }
        }

        program.parse();
    }
}

// Create and run CLI
const cli = new OpenLinkCLI();

// Export for use as module
module.exports = OpenLinkCLI;

// Run if executed directly
if (require.main === module) {
    cli.run();
}