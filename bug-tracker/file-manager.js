/**
 * Enhanced File Manager for openlink
 * Handles local/remote file synchronization and path management
 */

class FileManager {
    constructor(config) {
        this.config = config;
        this.localFiles = [];
        this.remoteFiles = [];
        this.syncInProgress = false;
    }

    initialize() {
        this.setupPathManagement();
        this.refreshFiles();
        console.log('📁 File Manager initialized');
    }

    setupPathManagement() {
        this.setupPathEventListeners();
        this.updatePathPreviews();
    }

    setupPathEventListeners() {
        // Path input listeners
        document.getElementById('local-path')?.addEventListener('input', () => {
            this.updatePathPreviews();
            this.validatePath('local');
        });

        document.getElementById('remote-path')?.addEventListener('input', () => {
            this.updatePathPreviews();
            this.validatePath('remote');
        });
    }

    updatePathPreviews() {
        const localPath = document.getElementById('local-path')?.value || this.config.localPath;
        const remotePath = document.getElementById('remote-path')?.value || this.config.remoteConfig.remotePath;
        const webPath = this.config.remoteConfig.publicPath;

        document.getElementById('preview-local-app').textContent = localPath;
        document.getElementById('preview-remote-app').textContent = remotePath;
        document.getElementById('preview-web-path').textContent = webPath;
    }

    async validatePath(type) {
        const pathInput = document.getElementById(type === 'local' ? 'local-path' : 'remote-path');
        if (!pathInput) return;

        const path = pathInput.value;
        console.log(`Validating ${type} path: ${path}`);

        // Add visual feedback
        pathInput.className = 'validating';

        try {
            if (type === 'local') {
                // Check local path existence
                const exists = await this.checkLocalPath(path);
                pathInput.className = exists ? 'valid' : 'invalid';
            } else {
                // Check remote path via SSH
                const accessible = await this.checkRemotePath(path);
                pathInput.className = accessible ? 'valid' : 'invalid';
            }
        } catch (error) {
            pathInput.className = 'invalid';
            console.error(`Path validation failed: ${error.message}`);
        }
    }

    async checkLocalPath(path) {
        // In a real implementation, this would use Node.js fs module
        // For now, we'll simulate path checking
        return path && path.length > 0;
    }

    async checkRemotePath(path) {
        // In a real implementation, this would use SSH to check remote path
        // For now, we'll simulate remote path checking
        return path && path.startsWith('/');
    }

    async refreshFiles() {
        if (this.syncInProgress) return;

        try {
            this.syncInProgress = true;

            // Refresh local files
            await this.loadLocalFiles();

            // Refresh remote files
            await this.loadRemoteFiles();

            this.updateFileDisplay();
        } catch (error) {
            console.error('Failed to refresh files:', error);
            this.showError('Failed to load files');
        } finally {
            this.syncInProgress = false;
        }
    }

    async loadLocalFiles() {
        // Simulate loading local files
        this.localFiles = [
            { name: 'package.json', size: '2.1 KB', modified: new Date(), type: 'file' },
            { name: 'src/', size: '-', modified: new Date(), type: 'directory' },
            { name: 'README.md', size: '1.5 KB', modified: new Date(), type: 'file' }
        ];
    }

    async loadRemoteFiles() {
        // Simulate loading remote files via SSH
        this.remoteFiles = [
            { name: 'package.json', size: '2.1 KB', modified: new Date(), type: 'file', synced: true },
            { name: 'src/', size: '-', modified: new Date(), type: 'directory', synced: true },
            { name: 'config.json', size: '512 B', modified: new Date(), type: 'file', synced: false }
        ];
    }

    updateFileDisplay() {
        this.updateFileList('local-files', this.localFiles);
        this.updateFileList('remote-files', this.remoteFiles);
    }

    updateFileList(containerId, files) {
        const container = document.getElementById(containerId);
        if (!container) return;

        if (files.length === 0) {
            container.innerHTML = '<div class="no-files">No files found</div>';
            return;
        }

        const filesHTML = files.map(file => `
            <div class="file-item ${file.type}" data-file-name="${file.name}">
                <div class="file-icon">${file.type === 'directory' ? '📁' : '📄'}</div>
                <div class="file-details">
                    <div class="file-name">${this.escapeHtml(file.name)}</div>
                    <div class="file-meta">
                        <span class="file-size">${file.size}</span>
                        <span class="file-date">${file.modified.toLocaleDateString()}</span>
                        ${file.synced !== undefined ?
                            `<span class="sync-status ${file.synced ? 'synced' : 'unsynced'}">${file.synced ? '✓' : '○'}</span>`
                            : ''}
                    </div>
                </div>
                <div class="file-actions">
                    <button class="btn-micro" onclick="fileManager.previewFile('${file.name}')">👁️</button>
                    <button class="btn-micro" onclick="fileManager.editFile('${file.name}')">✏️</button>
                </div>
            </div>
        `).join('');

        container.innerHTML = filesHTML;
    }

    async syncToRemote() {
        if (this.syncInProgress) {
            this.showError('Sync already in progress');
            return;
        }

        try {
            this.syncInProgress = true;
            this.showProgress('Uploading to remote server...');

            // Simulate upload process
            const steps = ['Connecting to server...', 'Transferring files...', 'Setting permissions...', 'Complete!'];

            for (let i = 0; i < steps.length; i++) {
                this.showProgress(steps[i]);
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            this.showSuccess('Files uploaded successfully');
            await this.refreshFiles();

        } catch (error) {
            console.error('Sync to remote failed:', error);
            this.showError('Upload failed: ' + error.message);
        } finally {
            this.syncInProgress = false;
        }
    }

    async syncFromRemote() {
        if (this.syncInProgress) {
            this.showError('Sync already in progress');
            return;
        }

        try {
            this.syncInProgress = true;
            this.showProgress('Downloading from remote server...');

            // Simulate download process
            const steps = ['Connecting to server...', 'Fetching file list...', 'Downloading files...', 'Complete!'];

            for (let i = 0; i < steps.length; i++) {
                this.showProgress(steps[i]);
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            this.showSuccess('Files downloaded successfully');
            await this.refreshFiles();

        } catch (error) {
            console.error('Sync from remote failed:', error);
            this.showError('Download failed: ' + error.message);
        } finally {
            this.syncInProgress = false;
        }
    }

    async compareFiles() {
        this.showProgress('Comparing local and remote files...');

        try {
            // Simulate file comparison
            await new Promise(resolve => setTimeout(resolve, 2000));

            const differences = [
                { file: 'package.json', status: 'modified', local: '2024-01-15', remote: '2024-01-10' },
                { file: 'config.json', status: 'remote-only', local: null, remote: '2024-01-12' },
                { file: 'temp.log', status: 'local-only', local: '2024-01-16', remote: null }
            ];

            this.showComparisonResults(differences);

        } catch (error) {
            console.error('File comparison failed:', error);
            this.showError('Comparison failed: ' + error.message);
        }
    }

    showComparisonResults(differences) {
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h3>📊 File Comparison Results</h3>
                    <button class="modal-close" onclick="this.parentElement.parentElement.parentElement.remove()">&times;</button>
                </div>
                <div class="modal-body">
                    <div class="comparison-results">
                        ${differences.map(diff => `
                            <div class="diff-item status-${diff.status}">
                                <div class="diff-file">${diff.file}</div>
                                <div class="diff-status">${diff.status.replace('-', ' ')}</div>
                                <div class="diff-dates">
                                    <span>Local: ${diff.local || 'N/A'}</span>
                                    <span>Remote: ${diff.remote || 'N/A'}</span>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        modal.style.display = 'block';
    }

    async testRemoteConnection() {
        try {
            this.showProgress('Testing remote connection...');

            // Simulate connection test
            await new Promise(resolve => setTimeout(resolve, 2000));

            this.showSuccess('Remote connection successful');
        } catch (error) {
            console.error('Connection test failed:', error);
            this.showError('Connection failed: ' + error.message);
        }
    }

    browseLocal() {
        // In a real implementation, this would open a file dialog
        const path = prompt('Enter local path:', this.config.localPath);
        if (path) {
            document.getElementById('local-path').value = path;
            this.updatePathPreviews();
            this.validatePath('local');
        }
    }

    previewFile(filename) {
        console.log(`Previewing file: ${filename}`);
        // Implementation would show file preview modal
    }

    editFile(filename) {
        console.log(`Editing file: ${filename}`);
        // Implementation would open file editor
    }

    showProgress(message) {
        // Create or update progress indicator
        let indicator = document.getElementById('sync-progress');
        if (!indicator) {
            indicator = document.createElement('div');
            indicator.id = 'sync-progress';
            indicator.className = 'sync-progress';
            document.body.appendChild(indicator);
        }

        indicator.textContent = message;
        indicator.className = 'sync-progress show';
    }

    showSuccess(message) {
        this.hideProgress();
        appTracker.showToast(message, 'success');
    }

    showError(message) {
        this.hideProgress();
        appTracker.showToast(message, 'error');
    }

    hideProgress() {
        const indicator = document.getElementById('sync-progress');
        if (indicator) {
            indicator.classList.remove('show');
        }
    }

    escapeHtml(unsafe) {
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }
}

// Deploy Manager
class DeployManager {
    constructor(config) {
        this.config = config;
    }

    async testConnection() {
        appTracker.showToast('Testing SSH connection...', 'info');

        try {
            // Simulate SSH connection test
            await new Promise(resolve => setTimeout(resolve, 2000));
            appTracker.showToast('SSH connection successful', 'success');
        } catch (error) {
            appTracker.showToast('Connection failed: ' + error.message, 'error');
        }
    }

    async deployApp() {
        if (confirm('Deploy application to remote server?')) {
            appTracker.showToast('Starting deployment...', 'info');

            try {
                // Simulate deployment process
                const steps = [
                    'Building application...',
                    'Connecting to server...',
                    'Uploading files...',
                    'Setting permissions...',
                    'Restarting services...',
                    'Deployment complete!'
                ];

                for (const step of steps) {
                    this.updateDeployLog(step);
                    await new Promise(resolve => setTimeout(resolve, 1500));
                }

                appTracker.showToast('Deployment successful!', 'success');
            } catch (error) {
                appTracker.showToast('Deployment failed: ' + error.message, 'error');
            }
        }
    }

    async rollback() {
        if (confirm('Rollback to previous version?')) {
            appTracker.showToast('Rolling back deployment...', 'info');

            try {
                await new Promise(resolve => setTimeout(resolve, 3000));
                appTracker.showToast('Rollback successful', 'success');
            } catch (error) {
                appTracker.showToast('Rollback failed: ' + error.message, 'error');
            }
        }
    }

    updateStatus() {
        // Update deployment status display
        console.log('Updating deployment status');
    }

    updateDeployLog(message) {
        const logContainer = document.getElementById('deploy-log');
        if (logContainer) {
            const logEntry = document.createElement('div');
            logEntry.className = 'log-entry';
            logEntry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
            logContainer.appendChild(logEntry);
            logContainer.scrollTop = logContainer.scrollHeight;
        }
    }
}

// Log Manager
class LogManager {
    constructor(config) {
        this.config = config;
        this.logs = [];
    }

    refreshLogs() {
        // Simulate loading application logs
        this.logs = [
            { timestamp: new Date(), level: 'info', message: 'Application started' },
            { timestamp: new Date(), level: 'warning', message: 'Configuration file missing' },
            { timestamp: new Date(), level: 'error', message: 'Database connection failed' }
        ];

        this.updateLogsDisplay();
    }

    updateLogsDisplay() {
        const container = document.getElementById('logs-container');
        if (!container) return;

        const logsHTML = this.logs.map(log => `
            <div class="log-entry level-${log.level}">
                <span class="log-timestamp">${log.timestamp.toLocaleTimeString()}</span>
                <span class="log-level">${log.level.toUpperCase()}</span>
                <span class="log-message">${this.escapeHtml(log.message)}</span>
            </div>
        `).join('');

        container.innerHTML = logsHTML;
    }

    clearLogs() {
        if (confirm('Clear all logs?')) {
            this.logs = [];
            this.updateLogsDisplay();
            appTracker.showToast('Logs cleared', 'info');
        }
    }

    exportLogs() {
        const logData = this.logs.map(log =>
            `[${log.timestamp.toISOString()}] ${log.level.toUpperCase()}: ${log.message}`
        ).join('\n');

        const blob = new Blob([logData], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = `${this.config.name}-logs-${new Date().toISOString().split('T')[0]}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        appTracker.showToast('Logs exported', 'success');
    }

    escapeHtml(unsafe) {
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }
}