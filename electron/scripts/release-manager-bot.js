#!/usr/bin/env node
/**
 * Ollama Release Manager Bot
 * Automatically manages download pages and cleans up old releases
 *
 * Features:
 * - Detects new build files and updates download pages
 * - Removes obsolete installers after configurable retention period
 * - Uses Ollama for intelligent changelog generation
 * - Sends notifications on updates
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// Configuration
const CONFIG = {
    // Apps to manage
    apps: {
        openlink: {
            name: 'OpenLink',
            buildDir: '/home/dom/public_html/uploads/website_specific/apps/openlink',
            indexFile: '/home/dom/public_html/uploads/website_specific/apps/openlink/index.html',
            color: '#89b4fa',
            bgGradient: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
            description: 'Accessible remote desktop and screen sharing application with WebRTC technology.',
            features: [
                'Peer-to-peer WebRTC connections',
                'Remote management (enable SSH remotely)',
                'openlink:// protocol URL handler',
                'Subdomain-based shareable URLs',
                'Multiple signaling servers for redundancy',
                'Session password protection',
                'eCripto payment integration',
                'Auto-update support',
                'Accessible design with screen reader support'
            ],
            platforms: {
                mac: { extensions: ['.dmg'], size: '~112 MB' },
                windows: { extensions: ['.exe'], size: '~91 MB' },
                linux: { extensions: ['.AppImage', '.deb'], size: '~113 MB' }
            },
            retentionDays: 30,  // Keep old versions for 30 days
            keepVersions: 3     // Always keep at least 3 versions
        },
        ecripto: {
            name: 'eCripto',
            buildDir: '/home/ecriptoapp/public_html/downloads',
            indexFile: '/home/ecriptoapp/public_html/downloads/index.html',
            color: '#a855f7',
            bgGradient: 'linear-gradient(135deg, #1a1a2e 0%, #2d1b4e 100%)',
            description: 'Cryptocurrency wallet and blockchain application with device sync, payments, and smart contract integration.',
            features: [
                'Multi-device wallet sync',
                'ecripto:// protocol URL handler',
                'Smart contract integration',
                'Payment processing',
                'Secure key management'
            ],
            platforms: {
                'mac-arm': { extensions: ['-arm64.dmg'], size: '~100 MB', label: 'macOS (Apple Silicon)' },
                'mac-intel': { extensions: ['.dmg'], excludePatterns: ['-arm64'], size: '~104 MB', label: 'macOS (Intel)' },
                windows: { extensions: ['.exe'], includePatterns: ['Setup'], size: '~90 MB' },
                linux: { extensions: ['.AppImage'], size: '~113 MB' }
            },
            retentionDays: 30,
            keepVersions: 3
        }
    },

    // Ollama configuration
    ollama: {
        host: 'localhost',
        port: 11434,
        model: 'llama3.2:3b',
        enabled: true
    },

    // Notification settings
    notifications: {
        enabled: true,
        logFile: '/var/log/release-manager.log'
    },

    // Check interval (milliseconds)
    checkInterval: 60000,  // 1 minute

    // Dry run mode (don't actually delete files)
    dryRun: false
};

class ReleaseManagerBot {
    constructor(config = CONFIG) {
        this.config = config;
        this.knownVersions = {};
        this.lastCheck = {};
    }

    /**
     * Parse version from filename
     */
    parseVersion(filename) {
        // Match patterns like: App-1.5.5-patch1.dmg, App Setup 1.5.5.exe, app_1.5.5_amd64.deb
        const patterns = [
            /[-_\s](\d+\.\d+\.\d+(?:-patch\d+)?(?:-[a-z]+\d*)?)/i,
            /[-_\s]v?(\d+\.\d+\.\d+)/i
        ];

        for (const pattern of patterns) {
            const match = filename.match(pattern);
            if (match) {
                return match[1];
            }
        }
        return null;
    }

    /**
     * Compare versions (returns positive if a > b, negative if a < b, 0 if equal)
     */
    compareVersions(a, b) {
        const normalize = (v) => {
            const [base, patch] = v.split('-patch');
            const parts = base.split('.').map(Number);
            parts.push(patch ? parseInt(patch) : 0);
            return parts;
        };

        const partsA = normalize(a);
        const partsB = normalize(b);

        for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
            const numA = partsA[i] || 0;
            const numB = partsB[i] || 0;
            if (numA !== numB) return numA - numB;
        }
        return 0;
    }

    /**
     * Get all release files for an app
     */
    getReleaseFiles(appKey) {
        const app = this.config.apps[appKey];
        if (!fs.existsSync(app.buildDir)) {
            return [];
        }

        const files = fs.readdirSync(app.buildDir);
        const releases = [];

        for (const file of files) {
            const filePath = path.join(app.buildDir, file);
            const stat = fs.statSync(filePath);

            if (!stat.isFile()) continue;

            const version = this.parseVersion(file);
            if (!version) continue;

            const ext = path.extname(file).toLowerCase();
            if (!['.dmg', '.exe', '.appimage', '.deb', '.zip'].includes(ext)) continue;

            releases.push({
                filename: file,
                path: filePath,
                version,
                size: stat.size,
                modified: stat.mtime,
                age: Date.now() - stat.mtime.getTime()
            });
        }

        return releases;
    }

    /**
     * Get latest version for an app
     */
    getLatestVersion(appKey) {
        const releases = this.getReleaseFiles(appKey);
        if (releases.length === 0) return null;

        const versions = [...new Set(releases.map(r => r.version))];
        versions.sort((a, b) => this.compareVersions(b, a));

        return versions[0];
    }

    /**
     * Generate download page HTML
     */
    generateDownloadPage(appKey) {
        const app = this.config.apps[appKey];
        const latestVersion = this.getLatestVersion(appKey);

        if (!latestVersion) {
            this.log(`No releases found for ${app.name}`);
            return null;
        }

        const releases = this.getReleaseFiles(appKey);
        const latestFiles = releases.filter(r => r.version === latestVersion);

        // Build platform cards
        let platformCards = '';

        if (appKey === 'openlink') {
            platformCards = this.generateOpenLinkCards(latestVersion, latestFiles);
        } else if (appKey === 'ecripto') {
            platformCards = this.generateEcriptoCards(latestVersion, latestFiles);
        }

        // Build features list
        const featuresList = app.features.map(f => `                <li>${f}</li>`).join('\n');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${app.name} - Download</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: ${app.bgGradient};
            color: #fff;
            min-height: 100vh;
            padding: 40px 20px;
        }
        .container { max-width: 900px; margin: 0 auto; }
        h1 { font-size: 2.5rem; margin-bottom: 10px; color: ${app.color}; }
        .version { color: #a6adc8; margin-bottom: 30px; }
        .description { font-size: 1.1rem; color: #cdd6f4; margin-bottom: 40px; line-height: 1.6; }
        .downloads { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin-bottom: 40px; }
        .download-card {
            background: rgba(255,255,255,0.05);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 12px;
            padding: 24px;
            text-align: center;
            transition: transform 0.2s, border-color 0.2s;
        }
        .download-card:hover { transform: translateY(-4px); border-color: ${app.color}; }
        .download-card h3 { margin-bottom: 15px; color: ${app.color}; }
        .download-card .size { color: #6c7086; font-size: 0.9rem; margin-bottom: 15px; }
        .btn {
            display: inline-block;
            background: ${app.color};
            color: #1a1a2e;
            padding: 12px 24px;
            border-radius: 8px;
            text-decoration: none;
            font-weight: 600;
            transition: background 0.2s;
        }
        .btn:hover { opacity: 0.9; }
        .btn-secondary { background: transparent; border: 1px solid ${app.color}; color: ${app.color}; }
        .btn-secondary:hover { background: rgba(255,255,255,0.1); }
        .features { margin-top: 40px; }
        .features h2 { margin-bottom: 20px; color: ${app.color}; }
        .features ul { list-style: none; }
        .features li { padding: 8px 0; color: #cdd6f4; }
        .features li:before { content: "✓ "; color: #a6e3a1; }
        .updated { margin-top: 20px; font-size: 0.85rem; color: #6c7086; }
        footer { margin-top: 60px; text-align: center; color: #6c7086; }
        footer a { color: ${app.color}; }
    </style>
</head>
<body>
    <div class="container">
        <h1>${app.name}</h1>
        <p class="version">Version ${latestVersion}</p>
        <p class="description">${app.description}</p>

        <div class="downloads">
${platformCards}
        </div>

        <div class="features">
            <h2>Features</h2>
            <ul>
${featuresList}
            </ul>
        </div>

        <p class="updated">Last updated: ${new Date().toISOString().split('T')[0]}</p>

        <footer>
            <p>&copy; ${new Date().getFullYear()} <a href="https://devine-creations.com">Devine Creations</a></p>
        </footer>
    </div>
</body>
</html>`;
    }

    /**
     * Generate OpenLink platform cards
     */
    generateOpenLinkCards(version, files) {
        const dmg = files.find(f => f.filename.endsWith('.dmg') && !f.filename.includes('-mac.zip'));
        const exeSetup = files.find(f => f.filename.includes('Setup') && f.filename.endsWith('.exe'));
        const exePortable = files.find(f => !f.filename.includes('Setup') && f.filename.endsWith('.exe'));
        const appImage = files.find(f => f.filename.endsWith('.AppImage'));
        const deb = files.find(f => f.filename.endsWith('.deb'));

        return `            <div class="download-card">
                <h3>macOS</h3>
                <p class="size">~112 MB</p>
                <a href="${dmg ? dmg.filename : `OpenLink-${version}.dmg`}" class="btn">Download DMG</a>
            </div>
            <div class="download-card">
                <h3>Windows</h3>
                <p class="size">~91 MB</p>
                <a href="${exeSetup ? encodeURIComponent(exeSetup.filename).replace(/%20/g, '%20') : `OpenLink%20Setup%20${version}.exe`}" class="btn">Download Installer</a>
                <br><br>
                <a href="${exePortable ? encodeURIComponent(exePortable.filename).replace(/%20/g, '%20') : `OpenLink%20${version}.exe`}" class="btn btn-secondary">Portable</a>
            </div>
            <div class="download-card">
                <h3>Linux</h3>
                <p class="size">~113 MB</p>
                <a href="${appImage ? appImage.filename : `OpenLink-${version}.AppImage`}" class="btn">Download AppImage</a>
                <br><br>
                <a href="${deb ? deb.filename : `openlink_${version}_amd64.deb`}" class="btn btn-secondary">.deb Package</a>
            </div>`;
    }

    /**
     * Generate eCripto platform cards
     */
    generateEcriptoCards(version, files) {
        const dmgArm = files.find(f => f.filename.includes('-arm64.dmg'));
        const dmgIntel = files.find(f => f.filename.endsWith('.dmg') && !f.filename.includes('-arm64'));
        const exeSetup = files.find(f => f.filename.includes('Setup') && f.filename.endsWith('.exe'));
        const appImage = files.find(f => f.filename.endsWith('.AppImage'));

        return `            <div class="download-card">
                <h3>macOS (Apple Silicon)</h3>
                <p class="size">~100 MB</p>
                <a href="${dmgArm ? dmgArm.filename : `eCripto-${version}-arm64.dmg`}" class="btn">Download DMG</a>
            </div>
            <div class="download-card">
                <h3>macOS (Intel)</h3>
                <p class="size">~104 MB</p>
                <a href="${dmgIntel ? dmgIntel.filename : `eCripto-${version}.dmg`}" class="btn">Download DMG</a>
            </div>
            <div class="download-card">
                <h3>Windows</h3>
                <p class="size">~90 MB</p>
                <a href="${exeSetup ? encodeURIComponent(exeSetup.filename) : `eCripto%20Setup%20${version}.exe`}" class="btn">Download Installer</a>
            </div>
            <div class="download-card">
                <h3>Linux</h3>
                <p class="size">~113 MB</p>
                <a href="${appImage ? appImage.filename : `eCripto-${version}.AppImage`}" class="btn">Download AppImage</a>
            </div>`;
    }

    /**
     * Update download page if new version detected
     */
    async updateDownloadPage(appKey) {
        const app = this.config.apps[appKey];
        const latestVersion = this.getLatestVersion(appKey);

        if (!latestVersion) return false;

        const knownVersion = this.knownVersions[appKey];

        if (knownVersion === latestVersion) {
            return false; // No update needed
        }

        this.log(`New version detected for ${app.name}: ${latestVersion} (was: ${knownVersion || 'unknown'})`);

        // Generate new page
        const html = this.generateDownloadPage(appKey);
        if (!html) return false;

        // Write to file
        if (!this.config.dryRun) {
            fs.writeFileSync(app.indexFile, html);
            this.log(`Updated download page: ${app.indexFile}`);
        } else {
            this.log(`[DRY RUN] Would update: ${app.indexFile}`);
        }

        // Generate changelog with Ollama
        if (this.config.ollama.enabled && knownVersion) {
            await this.generateChangelog(appKey, knownVersion, latestVersion);
        }

        this.knownVersions[appKey] = latestVersion;
        return true;
    }

    /**
     * Clean up old releases
     */
    cleanupOldReleases(appKey) {
        const app = this.config.apps[appKey];
        const releases = this.getReleaseFiles(appKey);

        if (releases.length === 0) return;

        // Group by version
        const byVersion = {};
        for (const release of releases) {
            if (!byVersion[release.version]) {
                byVersion[release.version] = [];
            }
            byVersion[release.version].push(release);
        }

        // Sort versions newest first
        const versions = Object.keys(byVersion).sort((a, b) => this.compareVersions(b, a));

        // Keep at least keepVersions
        const versionsToKeep = versions.slice(0, app.keepVersions);
        const versionsToCheck = versions.slice(app.keepVersions);

        const retentionMs = app.retentionDays * 24 * 60 * 60 * 1000;
        const filesToDelete = [];

        for (const version of versionsToCheck) {
            const versionFiles = byVersion[version];
            const oldestFile = versionFiles.reduce((a, b) => a.age > b.age ? a : b);

            if (oldestFile.age > retentionMs) {
                filesToDelete.push(...versionFiles);
            }
        }

        if (filesToDelete.length === 0) {
            return;
        }

        this.log(`Cleaning up ${filesToDelete.length} old files for ${app.name}:`);

        for (const file of filesToDelete) {
            const ageInDays = Math.floor(file.age / (24 * 60 * 60 * 1000));

            if (!this.config.dryRun) {
                try {
                    fs.unlinkSync(file.path);
                    this.log(`  Deleted: ${file.filename} (v${file.version}, ${ageInDays} days old)`);
                } catch (e) {
                    this.log(`  Error deleting ${file.filename}: ${e.message}`);
                }
            } else {
                this.log(`  [DRY RUN] Would delete: ${file.filename} (v${file.version}, ${ageInDays} days old)`);
            }
        }
    }

    /**
     * Generate changelog using Ollama
     */
    async generateChangelog(appKey, oldVersion, newVersion) {
        const app = this.config.apps[appKey];

        const prompt = `Generate a brief changelog entry for ${app.name} updating from version ${oldVersion} to ${newVersion}.
Keep it to 2-3 bullet points max. Be concise. Format as markdown bullet points.
If it's a patch version (like -patch1), mention it's a bug fix release.`;

        try {
            const response = await this.queryOllama(prompt);
            this.log(`Changelog for ${app.name} ${newVersion}:\n${response}`);
            return response;
        } catch (e) {
            this.log(`Failed to generate changelog: ${e.message}`);
            return null;
        }
    }

    /**
     * Query Ollama
     */
    async queryOllama(prompt) {
        return new Promise((resolve, reject) => {
            const data = JSON.stringify({
                model: this.config.ollama.model,
                prompt: prompt,
                stream: false
            });

            const options = {
                hostname: this.config.ollama.host,
                port: this.config.ollama.port,
                path: '/api/generate',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data)
                }
            };

            const req = http.request(options, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(body);
                        resolve(json.response || '');
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            req.on('error', reject);
            req.setTimeout(30000, () => {
                req.destroy();
                reject(new Error('Ollama request timeout'));
            });

            req.write(data);
            req.end();
        });
    }

    /**
     * Log message
     */
    log(message) {
        const timestamp = new Date().toISOString();
        const logLine = `[${timestamp}] ${message}`;
        console.log(logLine);

        if (this.config.notifications.logFile) {
            try {
                fs.appendFileSync(this.config.notifications.logFile, logLine + '\n');
            } catch (e) {
                // Ignore log write errors
            }
        }
    }

    /**
     * Run single check
     */
    async check() {
        for (const appKey of Object.keys(this.config.apps)) {
            try {
                await this.updateDownloadPage(appKey);
                this.cleanupOldReleases(appKey);
            } catch (e) {
                this.log(`Error checking ${appKey}: ${e.message}`);
            }
        }
    }

    /**
     * Start watching for changes
     */
    async start() {
        this.log('Release Manager Bot starting...');
        this.log(`Watching apps: ${Object.keys(this.config.apps).join(', ')}`);
        this.log(`Check interval: ${this.config.checkInterval / 1000}s`);
        this.log(`Dry run: ${this.config.dryRun}`);

        // Initial check
        await this.check();

        // Set up interval
        setInterval(() => this.check(), this.config.checkInterval);

        this.log('Release Manager Bot running. Press Ctrl+C to stop.');
    }

    /**
     * Run once (for cron jobs)
     */
    async runOnce() {
        this.log('Release Manager Bot - Single run');
        await this.check();
        this.log('Done.');
    }
}

// CLI handling
const args = process.argv.slice(2);
const bot = new ReleaseManagerBot(CONFIG);

if (args.includes('--dry-run')) {
    CONFIG.dryRun = true;
}

if (args.includes('--once')) {
    bot.runOnce();
} else if (args.includes('--daemon')) {
    bot.start();
} else {
    console.log(`
Ollama Release Manager Bot

Usage:
  node release-manager-bot.js --once      Run once and exit (for cron)
  node release-manager-bot.js --daemon    Run continuously
  node release-manager-bot.js --dry-run   Don't actually modify files

Options:
  --dry-run    Preview changes without applying them
  --once       Run single check and exit
  --daemon     Run continuously, checking every minute
`);
}

module.exports = ReleaseManagerBot;
