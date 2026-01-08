/**
 * OpenLink Incremental Update Service
 *
 * Supports two types of updates:
 * 1. Full app updates (via electron-updater with blockmap differential downloads)
 * 2. Hot resource updates (JS, CSS, HTML files without app restart)
 *
 * Features:
 * - File manifest tracking with SHA256 hashes
 * - Delta downloads (only changed files)
 * - Hot reload for frontend resources
 * - Rollback capability on update failure
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { EventEmitter } = require('events');
const { app, BrowserWindow } = require('electron');

class IncrementalUpdater extends EventEmitter {
    constructor() {
        super();

        this.updateServers = [
            'https://raywonderis.me/uploads/website_specific/apps/openlink/updates/',
            'https://devinecreations.net/openlink/updates/'
        ];

        this.manifestFileName = 'file-manifest.json';
        this.localManifestPath = null;
        this.appResourcesPath = null;
        this.backupPath = null;
        this.hotReloadEnabled = true;

        this.updateState = {
            checking: false,
            available: false,
            downloading: false,
            progress: 0,
            changedFiles: [],
            totalBytes: 0,
            downloadedBytes: 0,
            error: null
        };
    }

    /**
     * Initialize the incremental updater
     */
    initialize() {
        const userDataPath = app.getPath('userData');
        this.localManifestPath = path.join(userDataPath, this.manifestFileName);
        this.backupPath = path.join(userDataPath, 'update-backup');

        if (app.isPackaged) {
            this.appResourcesPath = path.join(process.resourcesPath, 'app');
        } else {
            this.appResourcesPath = path.join(__dirname, '..', '..');
        }

        if (!fs.existsSync(this.backupPath)) {
            fs.mkdirSync(this.backupPath, { recursive: true });
        }

        if (!fs.existsSync(this.localManifestPath)) {
            this.generateLocalManifest();
        }

        console.log('[IncrementalUpdater] Initialized');
        console.log('[IncrementalUpdater] Resources path:', this.appResourcesPath);
    }

    /**
     * Generate SHA256 hash of a file
     */
    hashFile(filePath) {
        try {
            const content = fs.readFileSync(filePath);
            return crypto.createHash('sha256').update(content).digest('hex');
        } catch (error) {
            return null;
        }
    }

    /**
     * Generate manifest of all updatable files
     */
    generateLocalManifest() {
        const manifest = {
            version: app.getVersion(),
            generated: new Date().toISOString(),
            files: {}
        };

        const updatableDirs = [
            'src',
            'assets'
        ];

        const scanDirectory = (dir, basePath = '') => {
            if (!fs.existsSync(dir)) return;

            const items = fs.readdirSync(dir, { withFileTypes: true });

            for (const item of items) {
                const fullPath = path.join(dir, item.name);
                const relativePath = path.join(basePath, item.name);

                if (item.isDirectory()) {
                    if (!['node_modules', '.git', 'dist'].includes(item.name)) {
                        scanDirectory(fullPath, relativePath);
                    }
                } else if (item.isFile()) {
                    const ext = path.extname(item.name).toLowerCase();
                    if (['.js', '.css', '.html', '.json', '.txt', '.md', '.svg', '.png', '.ico'].includes(ext)) {
                        const hash = this.hashFile(fullPath);
                        const stats = fs.statSync(fullPath);

                        if (hash) {
                            manifest.files[relativePath] = {
                                hash: hash,
                                size: stats.size,
                                modified: stats.mtime.toISOString()
                            };
                        }
                    }
                }
            }
        };

        for (const dir of updatableDirs) {
            const fullDir = path.join(this.appResourcesPath, dir);
            if (fs.existsSync(fullDir)) {
                if (fs.statSync(fullDir).isDirectory()) {
                    scanDirectory(fullDir, dir);
                } else {
                    const hash = this.hashFile(fullDir);
                    const stats = fs.statSync(fullDir);
                    if (hash) {
                        manifest.files[dir] = {
                            hash: hash,
                            size: stats.size,
                            modified: stats.mtime.toISOString()
                        };
                    }
                }
            }
        }

        fs.writeFileSync(this.localManifestPath, JSON.stringify(manifest, null, 2));
        console.log(`[IncrementalUpdater] Generated manifest with ${Object.keys(manifest.files).length} files`);

        return manifest;
    }

    /**
     * Fetch remote manifest from update server
     */
    async fetchRemoteManifest(serverIndex = 0) {
        return new Promise((resolve, reject) => {
            if (serverIndex >= this.updateServers.length) {
                reject(new Error('All update servers failed'));
                return;
            }

            const url = this.updateServers[serverIndex] + this.manifestFileName;
            console.log(`[IncrementalUpdater] Fetching manifest from: ${url}`);

            const request = https.get(url, (response) => {
                if (response.statusCode === 200) {
                    let data = '';
                    response.on('data', chunk => data += chunk);
                    response.on('end', () => {
                        try {
                            resolve(JSON.parse(data));
                        } catch (e) {
                            reject(new Error('Invalid manifest JSON'));
                        }
                    });
                } else if (response.statusCode === 404) {
                    this.fetchRemoteManifest(serverIndex + 1)
                        .then(resolve)
                        .catch(reject);
                } else {
                    reject(new Error(`HTTP ${response.statusCode}`));
                }
            });

            request.on('error', (error) => {
                this.fetchRemoteManifest(serverIndex + 1)
                    .then(resolve)
                    .catch(reject);
            });

            request.setTimeout(10000, () => {
                request.destroy();
                this.fetchRemoteManifest(serverIndex + 1)
                    .then(resolve)
                    .catch(reject);
            });
        });
    }

    /**
     * Check for incremental updates
     */
    async checkForUpdates() {
        if (this.updateState.checking) {
            return { checking: true, message: 'Already checking' };
        }

        this.updateState.checking = true;
        this.updateState.error = null;
        this.emit('checking');

        try {
            let localManifest;
            if (fs.existsSync(this.localManifestPath)) {
                localManifest = JSON.parse(fs.readFileSync(this.localManifestPath, 'utf8'));
            } else {
                localManifest = this.generateLocalManifest();
            }

            const remoteManifest = await this.fetchRemoteManifest();

            const changedFiles = [];
            let totalBytes = 0;

            for (const [filePath, remoteInfo] of Object.entries(remoteManifest.files)) {
                const localInfo = localManifest.files[filePath];

                if (!localInfo || localInfo.hash !== remoteInfo.hash) {
                    changedFiles.push({
                        path: filePath,
                        hash: remoteInfo.hash,
                        size: remoteInfo.size,
                        isNew: !localInfo
                    });
                    totalBytes += remoteInfo.size;
                }
            }

            this.updateState.checking = false;
            this.updateState.changedFiles = changedFiles;
            this.updateState.totalBytes = totalBytes;

            if (changedFiles.length > 0) {
                this.updateState.available = true;
                this.emit('update-available', {
                    filesCount: changedFiles.length,
                    totalBytes: totalBytes,
                    version: remoteManifest.version,
                    files: changedFiles
                });

                return {
                    available: true,
                    filesCount: changedFiles.length,
                    totalBytes: totalBytes,
                    version: remoteManifest.version
                };
            } else {
                this.emit('up-to-date');
                return { available: false, message: 'All files up to date' };
            }
        } catch (error) {
            this.updateState.checking = false;
            this.updateState.error = error.message;
            this.emit('error', error);
            return { available: false, error: error.message };
        }
    }

    /**
     * Download a single file from update server
     */
    async downloadFile(filePath, serverIndex = 0) {
        return new Promise((resolve, reject) => {
            if (serverIndex >= this.updateServers.length) {
                reject(new Error('All servers failed'));
                return;
            }

            const url = this.updateServers[serverIndex] + 'files/' + filePath;

            const request = https.get(url, (response) => {
                if (response.statusCode === 200) {
                    const chunks = [];
                    response.on('data', chunk => {
                        chunks.push(chunk);
                        this.updateState.downloadedBytes += chunk.length;
                        this.updateState.progress = (this.updateState.downloadedBytes / this.updateState.totalBytes) * 100;
                        this.emit('progress', this.updateState.progress);
                    });
                    response.on('end', () => {
                        resolve(Buffer.concat(chunks));
                    });
                } else {
                    this.downloadFile(filePath, serverIndex + 1)
                        .then(resolve)
                        .catch(reject);
                }
            });

            request.on('error', () => {
                this.downloadFile(filePath, serverIndex + 1)
                    .then(resolve)
                    .catch(reject);
            });

            request.setTimeout(30000, () => {
                request.destroy();
                reject(new Error('Download timeout'));
            });
        });
    }

    /**
     * Backup a file before updating
     */
    backupFile(filePath) {
        const sourcePath = path.join(this.appResourcesPath, filePath);
        const backupFilePath = path.join(this.backupPath, filePath);

        if (fs.existsSync(sourcePath)) {
            const backupDir = path.dirname(backupFilePath);
            if (!fs.existsSync(backupDir)) {
                fs.mkdirSync(backupDir, { recursive: true });
            }

            fs.copyFileSync(sourcePath, backupFilePath);
            return true;
        }
        return false;
    }

    /**
     * Restore a file from backup
     */
    restoreFile(filePath) {
        const backupFilePath = path.join(this.backupPath, filePath);
        const targetPath = path.join(this.appResourcesPath, filePath);

        if (fs.existsSync(backupFilePath)) {
            fs.copyFileSync(backupFilePath, targetPath);
            return true;
        }
        return false;
    }

    /**
     * Apply downloaded updates
     */
    async applyUpdates() {
        if (!this.updateState.available || this.updateState.changedFiles.length === 0) {
            return { success: false, message: 'No updates to apply' };
        }

        this.updateState.downloading = true;
        this.updateState.downloadedBytes = 0;
        this.emit('downloading');

        const updatedFiles = [];
        const failedFiles = [];

        try {
            for (const fileInfo of this.updateState.changedFiles) {
                try {
                    this.backupFile(fileInfo.path);

                    const content = await this.downloadFile(fileInfo.path);

                    const downloadedHash = crypto.createHash('sha256').update(content).digest('hex');
                    if (downloadedHash !== fileInfo.hash) {
                        throw new Error('Hash mismatch');
                    }

                    const targetPath = path.join(this.appResourcesPath, fileInfo.path);
                    const targetDir = path.dirname(targetPath);

                    if (!fs.existsSync(targetDir)) {
                        fs.mkdirSync(targetDir, { recursive: true });
                    }

                    fs.writeFileSync(targetPath, content);
                    updatedFiles.push(fileInfo.path);

                    this.emit('file-updated', fileInfo.path);
                } catch (error) {
                    console.error(`[IncrementalUpdater] Failed to update ${fileInfo.path}:`, error);
                    failedFiles.push({ path: fileInfo.path, error: error.message });

                    this.restoreFile(fileInfo.path);
                }
            }

            this.updateState.downloading = false;
            this.updateState.available = false;

            this.generateLocalManifest();

            if (this.hotReloadEnabled) {
                const frontendUpdated = updatedFiles.some(f =>
                    f.includes('ui/') || f.endsWith('.html') || f.endsWith('.css')
                );

                if (frontendUpdated) {
                    this.triggerHotReload();
                }
            }

            const result = {
                success: failedFiles.length === 0,
                updatedFiles: updatedFiles,
                failedFiles: failedFiles,
                needsRestart: updatedFiles.some(f =>
                    f.includes('main.js') || f.includes('preload.js') || f.endsWith('.node')
                )
            };

            this.emit('update-complete', result);
            return result;

        } catch (error) {
            this.updateState.downloading = false;
            this.updateState.error = error.message;
            this.emit('error', error);

            for (const filePath of updatedFiles) {
                this.restoreFile(filePath);
            }

            return { success: false, error: error.message, rolledBack: true };
        }
    }

    /**
     * Trigger hot reload of frontend resources
     */
    triggerHotReload() {
        const windows = BrowserWindow.getAllWindows();

        for (const win of windows) {
            if (!win.isDestroyed()) {
                win.webContents.executeJavaScript(`
                    (function() {
                        document.querySelectorAll('link[rel="stylesheet"]').forEach(link => {
                            const href = link.href.split('?')[0];
                            link.href = href + '?v=' + Date.now();
                        });

                        if (window.onHotUpdate) {
                            window.onHotUpdate();
                        }

                        console.log('[HotReload] Styles reloaded');
                    })();
                `).catch(() => {});

                win.webContents.send('hot-update-available');
            }
        }

        console.log('[IncrementalUpdater] Hot reload triggered');
    }

    /**
     * Clean up old backups
     */
    cleanupBackups(maxAgeDays = 7) {
        if (!fs.existsSync(this.backupPath)) return;

        const maxAge = maxAgeDays * 24 * 60 * 60 * 1000;
        const now = Date.now();

        const cleanDir = (dir) => {
            const items = fs.readdirSync(dir, { withFileTypes: true });

            for (const item of items) {
                const fullPath = path.join(dir, item.name);

                if (item.isDirectory()) {
                    cleanDir(fullPath);
                    if (fs.readdirSync(fullPath).length === 0) {
                        fs.rmdirSync(fullPath);
                    }
                } else {
                    const stats = fs.statSync(fullPath);
                    if (now - stats.mtimeMs > maxAge) {
                        fs.unlinkSync(fullPath);
                    }
                }
            }
        };

        cleanDir(this.backupPath);
        console.log('[IncrementalUpdater] Cleaned up old backups');
    }

    /**
     * Get current update state
     */
    getState() {
        return { ...this.updateState };
    }

    /**
     * Enable or disable hot reload
     */
    setHotReload(enabled) {
        this.hotReloadEnabled = enabled;
    }
}

module.exports = new IncrementalUpdater();
