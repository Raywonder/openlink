/**
 * OpenLink Startup Recovery & Pre-launch Updater
 *
 * This module runs BEFORE the main app to:
 * 1. Check for updates before starting
 * 2. Detect if previous launch crashed
 * 3. Auto-update if crash detected
 * 4. Provide safe-mode startup
 */

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn, execSync } = require('child_process');

class StartupRecovery {
    constructor() {
        this.appDataPath = app.getPath('userData');
        this.crashFlagFile = path.join(this.appDataPath, '.crash_flag');
        this.lastStartFile = path.join(this.appDataPath, '.last_start');
        this.updateUrl = 'https://raywonderis.me/uploads/website_specific/apps/openlink/';
        this.crashThresholdMs = 10000; // If app exits within 10s, consider it a crash
    }

    /**
     * Run pre-launch checks
     * Returns: { shouldContinue: boolean, message: string }
     */
    async runPreLaunchChecks() {
        console.log('[StartupRecovery] Running pre-launch checks...');

        // Check for crash flag
        const crashDetected = this.detectCrash();

        if (crashDetected) {
            console.log('[StartupRecovery] Previous crash detected, checking for updates...');

            const updateAvailable = await this.checkForUpdate();

            if (updateAvailable) {
                console.log('[StartupRecovery] Update available, triggering update...');
                await this.triggerEmergencyUpdate();
                return { shouldContinue: false, message: 'Update triggered due to crash' };
            } else {
                console.log('[StartupRecovery] No update available, starting in safe mode...');
                this.clearCrashFlag();
                return { shouldContinue: true, safeMode: true, message: 'Starting in safe mode after crash' };
            }
        }

        // Set crash flag before starting (will be cleared on clean exit)
        this.setCrashFlag();

        return { shouldContinue: true, message: 'Normal startup' };
    }

    /**
     * Detect if previous launch crashed
     */
    detectCrash() {
        try {
            if (!fs.existsSync(this.crashFlagFile)) {
                return false;
            }

            const flagData = JSON.parse(fs.readFileSync(this.crashFlagFile, 'utf8'));
            const timeSinceStart = Date.now() - flagData.startTime;

            // If crash flag exists and start was recent, previous launch crashed
            if (timeSinceStart < 60000) { // Within 1 minute
                console.log(`[StartupRecovery] Crash flag found, age: ${timeSinceStart}ms`);
                return true;
            }

            // Old crash flag, clean it up
            this.clearCrashFlag();
            return false;

        } catch (e) {
            console.log('[StartupRecovery] Error reading crash flag:', e.message);
            return false;
        }
    }

    /**
     * Set crash flag (called on startup)
     */
    setCrashFlag() {
        try {
            fs.writeFileSync(this.crashFlagFile, JSON.stringify({
                startTime: Date.now(),
                version: app.getVersion(),
                platform: process.platform
            }));
        } catch (e) {
            console.error('[StartupRecovery] Failed to set crash flag:', e.message);
        }
    }

    /**
     * Clear crash flag (called on clean exit)
     */
    clearCrashFlag() {
        try {
            if (fs.existsSync(this.crashFlagFile)) {
                fs.unlinkSync(this.crashFlagFile);
            }
        } catch (e) {
            console.error('[StartupRecovery] Failed to clear crash flag:', e.message);
        }
    }

    /**
     * Mark successful startup (call after app is fully loaded)
     */
    markSuccessfulStart() {
        this.clearCrashFlag();
        console.log('[StartupRecovery] Marked successful startup');
    }

    /**
     * Check if update is available
     */
    async checkForUpdate() {
        return new Promise((resolve) => {
            const ymlFile = process.platform === 'darwin' ? 'latest-mac.yml' :
                           process.platform === 'win32' ? 'latest.yml' : 'latest-linux.yml';

            const url = this.updateUrl + ymlFile;

            https.get(url, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        // Parse YAML manually (basic)
                        const versionMatch = data.match(/version:\s*['"]?([^\s'"]+)/);
                        if (versionMatch) {
                            const latestVersion = versionMatch[1];
                            const currentVersion = app.getVersion();

                            console.log(`[StartupRecovery] Current: ${currentVersion}, Latest: ${latestVersion}`);

                            if (this.isNewerVersion(latestVersion, currentVersion)) {
                                resolve({ available: true, version: latestVersion, data });
                            } else {
                                resolve(false);
                            }
                        } else {
                            resolve(false);
                        }
                    } catch (e) {
                        console.error('[StartupRecovery] Failed to parse update info:', e.message);
                        resolve(false);
                    }
                });
            }).on('error', (e) => {
                console.error('[StartupRecovery] Failed to check for update:', e.message);
                resolve(false);
            });
        });
    }

    /**
     * Compare versions
     */
    isNewerVersion(latest, current) {
        const normalize = (v) => {
            // Handle versions like "1.5.5-patch1"
            const [base, patch] = v.replace(/^v/, '').split('-patch');
            const parts = base.split('.').map(Number);
            parts.push(patch ? parseInt(patch) : 0);
            return parts;
        };

        const latestParts = normalize(latest);
        const currentParts = normalize(current);

        for (let i = 0; i < Math.max(latestParts.length, currentParts.length); i++) {
            const l = latestParts[i] || 0;
            const c = currentParts[i] || 0;
            if (l > c) return true;
            if (l < c) return false;
        }
        return false;
    }

    /**
     * Trigger emergency update (download and run installer)
     */
    async triggerEmergencyUpdate() {
        const updateInfo = await this.checkForUpdate();
        if (!updateInfo) return false;

        console.log('[StartupRecovery] Triggering emergency update to', updateInfo.version);

        if (process.platform === 'win32') {
            return await this.downloadAndRunWindowsUpdate(updateInfo);
        } else if (process.platform === 'darwin') {
            return await this.downloadAndRunMacUpdate(updateInfo);
        }

        return false;
    }

    /**
     * Download and run Windows update
     */
    async downloadAndRunWindowsUpdate(updateInfo) {
        return new Promise((resolve) => {
            // Parse installer filename from YAML
            const fileMatch = updateInfo.data.match(/url:\s*(.+\.exe)/);
            if (!fileMatch) {
                console.error('[StartupRecovery] Could not find installer URL');
                resolve(false);
                return;
            }

            const installerName = fileMatch[1].trim();
            const downloadUrl = this.updateUrl + encodeURIComponent(installerName).replace(/%20/g, '%20');
            const tempPath = path.join(app.getPath('temp'), installerName);

            console.log('[StartupRecovery] Downloading:', downloadUrl);

            const file = fs.createWriteStream(tempPath);

            https.get(downloadUrl, (response) => {
                if (response.statusCode === 302 || response.statusCode === 301) {
                    // Follow redirect
                    https.get(response.headers.location, (res) => {
                        res.pipe(file);
                        file.on('finish', () => {
                            file.close();
                            this.runWindowsInstaller(tempPath);
                            resolve(true);
                        });
                    });
                } else {
                    response.pipe(file);
                    file.on('finish', () => {
                        file.close();
                        this.runWindowsInstaller(tempPath);
                        resolve(true);
                    });
                }
            }).on('error', (e) => {
                console.error('[StartupRecovery] Download failed:', e.message);
                fs.unlink(tempPath, () => {});
                resolve(false);
            });
        });
    }

    /**
     * Kill all OpenLink processes (Windows)
     */
    killOpenLinkProcesses() {
        if (process.platform !== 'win32') return;

        console.log('[StartupRecovery] Killing existing OpenLink processes...');

        try {
            // Kill any running OpenLink processes
            execSync('taskkill /F /IM "OpenLink.exe" /T 2>nul', { stdio: 'ignore' });
        } catch (e) {
            // Process might not exist, ignore error
        }

        try {
            // Also kill any electron processes that might be OpenLink
            execSync('taskkill /F /IM "electron.exe" /T 2>nul', { stdio: 'ignore' });
        } catch (e) {
            // Process might not exist, ignore error
        }

        // Wait a moment for processes to fully terminate
        const waitSync = (ms) => {
            const end = Date.now() + ms;
            while (Date.now() < end) { /* busy wait */ }
        };
        waitSync(2000);

        console.log('[StartupRecovery] Processes killed');
    }

    /**
     * Run Windows installer
     */
    runWindowsInstaller(installerPath) {
        console.log('[StartupRecovery] Running installer:', installerPath);

        try {
            // Kill any existing OpenLink processes first
            this.killOpenLinkProcesses();

            // Create a batch script that waits and runs the installer
            const batchScript = `
@echo off
echo Waiting for OpenLink to close...
timeout /t 3 /nobreak >nul
taskkill /F /IM "OpenLink.exe" /T 2>nul
taskkill /F /IM "electron.exe" /T 2>nul
timeout /t 2 /nobreak >nul
echo Installing update...
start "" "${installerPath}" /S /silent
exit
`;
            const batchPath = path.join(app.getPath('temp'), 'openlink-update.bat');
            fs.writeFileSync(batchPath, batchScript);

            // Run the batch script detached
            spawn('cmd.exe', ['/c', batchPath], {
                detached: true,
                stdio: 'ignore',
                windowsHide: true
            }).unref();

            // Exit current app immediately
            app.quit();

        } catch (e) {
            console.error('[StartupRecovery] Failed to run installer:', e.message);
        }
    }

    /**
     * Download and run Mac update
     */
    async downloadAndRunMacUpdate(updateInfo) {
        return new Promise((resolve) => {
            // Parse DMG filename from YAML
            const fileMatch = updateInfo.data.match(/url:\s*(.+\.dmg)/);
            if (!fileMatch) {
                console.error('[StartupRecovery] Could not find DMG URL');
                resolve(false);
                return;
            }

            const dmgName = fileMatch[1].trim();
            const downloadUrl = this.updateUrl + encodeURIComponent(dmgName);
            const tempPath = path.join(app.getPath('temp'), dmgName);

            console.log('[StartupRecovery] Downloading:', downloadUrl);

            const file = fs.createWriteStream(tempPath);

            https.get(downloadUrl, (response) => {
                response.pipe(file);
                file.on('finish', () => {
                    file.close();
                    this.runMacInstaller(tempPath);
                    resolve(true);
                });
            }).on('error', (e) => {
                console.error('[StartupRecovery] Download failed:', e.message);
                resolve(false);
            });
        });
    }

    /**
     * Run Mac installer (mount DMG and copy app)
     */
    runMacInstaller(dmgPath) {
        console.log('[StartupRecovery] Installing from DMG:', dmgPath);

        try {
            // Mount DMG
            execSync(`hdiutil attach "${dmgPath}" -nobrowse -quiet`);

            // Find the mounted volume
            const volumes = fs.readdirSync('/Volumes').filter(v => v.includes('OpenLink'));
            if (volumes.length === 0) {
                throw new Error('Could not find mounted DMG volume');
            }

            const volumePath = `/Volumes/${volumes[0]}`;
            const appPath = fs.readdirSync(volumePath).find(f => f.endsWith('.app'));

            if (!appPath) {
                throw new Error('Could not find app in DMG');
            }

            // Copy app to Applications
            execSync(`rm -rf "/Applications/${appPath}"`);
            execSync(`cp -R "${volumePath}/${appPath}" /Applications/`);

            // Unmount
            execSync(`hdiutil detach "${volumePath}" -quiet`);

            // Relaunch
            spawn('open', ['-a', appPath.replace('.app', '')], {
                detached: true,
                stdio: 'ignore'
            }).unref();

            app.quit();

        } catch (e) {
            console.error('[StartupRecovery] Mac install failed:', e.message);
        }
    }
}

module.exports = StartupRecovery;
