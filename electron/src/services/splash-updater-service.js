/**
 * Splash Updater Service
 * Shows splash screen and checks for updates before main window
 */

const { BrowserWindow, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

class SplashUpdaterService {
    constructor(store) {
        this.store = store;
        this.splashWindow = null;
        this.updateAvailable = false;
        this.updateDownloaded = false;
        this.downloadProgress = 0;
    }

    /**
     * Create and show splash screen
     */
    async showSplash() {
        this.splashWindow = new BrowserWindow({
            width: 400,
            height: 300,
            frame: false,
            transparent: true,
            resizable: false,
            center: true,
            alwaysOnTop: true,
            skipTaskbar: true,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, '../preload-splash.js')
            }
        });

        // Load splash screen HTML
        await this.splashWindow.loadFile(path.join(__dirname, '../ui/splash-screen.html'));
        this.splashWindow.show();

        return this.splashWindow;
    }

    /**
     * Check for updates and optionally install
     */
    async checkForUpdates() {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                console.log('[Splash] Update check timed out');
                resolve({ updated: false, reason: 'timeout' });
            }, 30000); // 30 second timeout

            autoUpdater.on('update-available', (info) => {
                console.log('[Splash] Update available:', info.version);
                this.updateAvailable = true;
                this.sendToSplash('update-available', info);
            });

            autoUpdater.on('update-not-available', () => {
                console.log('[Splash] No update available');
                clearTimeout(timeout);
                resolve({ updated: false, reason: 'up-to-date' });
            });

            autoUpdater.on('download-progress', (progress) => {
                this.downloadProgress = progress.percent;
                this.sendToSplash('download-progress', {
                    percent: progress.percent,
                    bytesPerSecond: progress.bytesPerSecond,
                    transferred: progress.transferred,
                    total: progress.total
                });
            });

            autoUpdater.on('update-downloaded', (info) => {
                console.log('[Splash] Update downloaded:', info.version);
                this.updateDownloaded = true;
                clearTimeout(timeout);

                // Auto-restart to install
                this.sendToSplash('update-ready', info);

                setTimeout(() => {
                    autoUpdater.quitAndInstall(true, true);
                }, 2000);

                resolve({ updated: true, version: info.version });
            });

            autoUpdater.on('error', (error) => {
                console.log('[Splash] Update error:', error.message);
                clearTimeout(timeout);
                resolve({ updated: false, reason: 'error', error: error.message });
            });

            // Start update check
            autoUpdater.checkForUpdates().catch((err) => {
                console.log('[Splash] Update check failed:', err.message);
                clearTimeout(timeout);
                resolve({ updated: false, reason: 'error', error: err.message });
            });
        });
    }

    /**
     * Send message to splash window
     */
    sendToSplash(channel, data) {
        if (this.splashWindow && !this.splashWindow.isDestroyed()) {
            this.splashWindow.webContents.send(channel, data);
        }
    }

    /**
     * Close splash window
     */
    closeSplash() {
        if (this.splashWindow && !this.splashWindow.isDestroyed()) {
            this.splashWindow.close();
            this.splashWindow = null;
        }
    }

    /**
     * Run the splash update flow
     */
    async run() {
        console.log('[Splash] Starting update check...');

        await this.showSplash();
        this.sendToSplash('status', { message: 'Checking for updates...' });

        const result = await this.checkForUpdates();

        if (!result.updated) {
            this.sendToSplash('status', { message: 'Starting OpenLink...' });
            await new Promise(r => setTimeout(r, 1000));
            this.closeSplash();
        }

        return result;
    }
}

module.exports = SplashUpdaterService;
