/**
 * Windows Hotkey Manager
 * Disables system hotkeys like Win+L during remote desktop sessions
 * so they can be sent to the remote machine instead.
 *
 * IMPORTANT: This modifies Windows registry settings.
 * - Requires the app to run with appropriate permissions
 * - Restores original settings when session ends or app closes
 */

const { exec, spawn } = require('child_process');
const log = require('electron-log');
const os = require('os');

class WindowsHotkeyManager {
    constructor() {
        this.originalWinLState = null;
        this.isDisabled = false;
        this.platform = os.platform();

        // Registry path for disabling Win+L
        this.regPath = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System';
        this.regKey = 'DisableLockWorkstation';
    }

    /**
     * Check if we're on Windows
     */
    isWindows() {
        return this.platform === 'win32';
    }

    /**
     * Get current registry value for DisableLockWorkstation
     * @returns {Promise<boolean|null>} true if disabled, false if enabled, null if not set
     */
    async getCurrentState() {
        if (!this.isWindows()) return null;

        return new Promise((resolve) => {
            exec(`reg query "${this.regPath}" /v ${this.regKey}`, (error, stdout) => {
                if (error) {
                    // Key doesn't exist, Win+L is enabled by default
                    resolve(null);
                    return;
                }

                // Parse output - looking for REG_DWORD 0x1 (disabled) or 0x0 (enabled)
                const match = stdout.match(/REG_DWORD\s+0x([0-9a-f]+)/i);
                if (match) {
                    resolve(parseInt(match[1], 16) === 1);
                } else {
                    resolve(null);
                }
            });
        });
    }

    /**
     * Disable Win+L hotkey (allows capturing it for remote desktop)
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async disableWinL() {
        if (!this.isWindows()) {
            return { success: false, error: 'Not Windows platform' };
        }

        if (this.isDisabled) {
            return { success: true, note: 'Already disabled' };
        }

        try {
            // Save current state before modifying
            this.originalWinLState = await this.getCurrentState();

            // Set registry key to disable Win+L
            // REG_DWORD value of 1 disables Win+L
            return new Promise((resolve) => {
                exec(`reg add "${this.regPath}" /v ${this.regKey} /t REG_DWORD /d 1 /f`, (error, stdout, stderr) => {
                    if (error) {
                        log.error('[WindowsHotkeyManager] Failed to disable Win+L:', error.message);
                        resolve({ success: false, error: error.message });
                        return;
                    }

                    this.isDisabled = true;
                    log.info('[WindowsHotkeyManager] Win+L disabled for remote session');
                    resolve({ success: true });
                });
            });
        } catch (e) {
            log.error('[WindowsHotkeyManager] Error disabling Win+L:', e);
            return { success: false, error: e.message };
        }
    }

    /**
     * Re-enable Win+L hotkey (restore normal Windows behavior)
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async enableWinL() {
        if (!this.isWindows()) {
            return { success: false, error: 'Not Windows platform' };
        }

        if (!this.isDisabled) {
            return { success: true, note: 'Already enabled' };
        }

        try {
            // Restore original state
            if (this.originalWinLState === null) {
                // Key didn't exist before, delete it
                return new Promise((resolve) => {
                    exec(`reg delete "${this.regPath}" /v ${this.regKey} /f`, (error) => {
                        // Ignore errors - key might not exist
                        this.isDisabled = false;
                        log.info('[WindowsHotkeyManager] Win+L restored (key deleted)');
                        resolve({ success: true });
                    });
                });
            } else if (this.originalWinLState === false) {
                // Key was set to 0 (enabled)
                return new Promise((resolve) => {
                    exec(`reg add "${this.regPath}" /v ${this.regKey} /t REG_DWORD /d 0 /f`, (error) => {
                        this.isDisabled = false;
                        log.info('[WindowsHotkeyManager] Win+L restored (set to 0)');
                        resolve({ success: true });
                    });
                });
            } else {
                // Key was already set to disabled (unusual case)
                this.isDisabled = false;
                return { success: true, note: 'Win+L was already disabled before session' };
            }
        } catch (e) {
            log.error('[WindowsHotkeyManager] Error enabling Win+L:', e);
            return { success: false, error: e.message };
        }
    }

    /**
     * Get current state
     */
    getState() {
        return {
            platform: this.platform,
            isWindows: this.isWindows(),
            winLDisabled: this.isDisabled,
            originalState: this.originalWinLState
        };
    }

    /**
     * Cleanup - ensure Win+L is re-enabled when app closes
     */
    async cleanup() {
        if (this.isDisabled) {
            log.info('[WindowsHotkeyManager] Cleaning up - re-enabling Win+L');
            await this.enableWinL();
        }
    }
}

module.exports = WindowsHotkeyManager;
