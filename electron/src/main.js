/**
 * OpenLink - Main Electron Process
 * Accessible remote desktop and link sharing application
 * Features: Auto-start, login screen support, clipboard sharing, volume control
 */

const { app, BrowserWindow, ipcMain, clipboard, Tray, Menu, nativeImage, screen, globalShortcut, dialog, desktopCapturer, systemPreferences, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const Store = require('electron-store');
const log = require('electron-log');
const { autoUpdater } = require('electron-updater');

// Early startup recovery - check for crashes and updates before loading other modules
const StartupRecovery = require('./services/startup-recovery');
const startupRecovery = new StartupRecovery();

// macOS permission handling (only load on macOS)
let macScreenCapturePermissions = null;
let nodeMacPermissions = null;
if (process.platform === 'darwin') {
    try {
        macScreenCapturePermissions = require('mac-screen-capture-permissions');
        nodeMacPermissions = require('node-mac-permissions');
    } catch (e) {
        log.warn('Failed to load macOS permission modules:', e.message);
    }
}

// Wrap module loading in try-catch to prevent crashes from bad modules
let NotificationService, OllamaService, incrementalUpdater, RemoteManagementService, DropinManagementService, MonitorService;
let SplashUpdaterService, FeatureGateService, RateLimitService, TrustScoreService, AlternativePaymentService, AnnouncementService;
let UserVerificationService;
try {
    NotificationService = require('./services/notification-service');
    OllamaService = require('./services/ollama-service');
    incrementalUpdater = require('./services/incremental-updater');
    RemoteManagementService = require('./services/remote-management-service');
    ({ DropinManagementService } = require('./services/dropin-management-service'));
    MonitorService = require('./services/monitor-service');
    // v1.7.4+ services
    SplashUpdaterService = require('./services/splash-updater-service');
    FeatureGateService = require('./services/feature-gate-service');
    RateLimitService = require('./services/rate-limit-service');
    TrustScoreService = require('./services/trust-score-service');
    AlternativePaymentService = require('./services/alternative-payment-service');
    AnnouncementService = require('./services/announcement-service');
    UserVerificationService = require('./services/user-verification-service');
} catch (moduleError) {
    log.error('Failed to load module:', moduleError);
    // Continue with null services - app will still work with reduced functionality
}

// Telemetry Service - sends errors and events to server for monitoring
class TelemetryService {
    constructor() {
        this.serverUrl = 'https://openlink.devinecreations.net/api/telemetry/report';
        this.queue = [];
        this.deviceId = null;
        this.deviceName = os.hostname();
        this.platform = `${os.platform()}-${os.arch()}`;
        this.version = app.getVersion();
        this.isOnline = true;
        this.flushInterval = null;

        // Start flush interval
        this.flushInterval = setInterval(() => this.flush(), 30000);
    }

    setDeviceId(id) {
        this.deviceId = id;
    }

    async report(type, message, metadata = {}) {
        const event = {
            type,
            message: String(message),
            stack: metadata.stack || null,
            deviceId: this.deviceId,
            deviceName: this.deviceName,
            platform: this.platform,
            version: this.version,
            sessionId: metadata.sessionId || null,
            metadata: {
                ...metadata,
                stack: undefined // Don't duplicate stack in metadata
            }
        };

        log.info(`[Telemetry] ${type}: ${message}`);

        // Try to send immediately
        try {
            await this.send(event);
        } catch (e) {
            // Queue for later
            this.queue.push(event);
            if (this.queue.length > 100) {
                this.queue.shift(); // Keep queue manageable
            }
        }
    }

    async send(event) {
        const https = require('https');
        const data = JSON.stringify(event);

        return new Promise((resolve, reject) => {
            const url = new URL(this.serverUrl);
            const req = https.request({
                hostname: url.hostname,
                port: url.port || 443,
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data)
                },
                timeout: 5000
            }, (res) => {
                if (res.statusCode === 200) {
                    resolve();
                } else {
                    reject(new Error(`HTTP ${res.statusCode}`));
                }
            });

            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Timeout'));
            });
            req.write(data);
            req.end();
        });
    }

    async flush() {
        if (this.queue.length === 0) return;

        const events = [...this.queue];
        this.queue = [];

        for (const event of events) {
            try {
                await this.send(event);
            } catch (e) {
                // Re-queue failed events (up to limit)
                if (this.queue.length < 50) {
                    this.queue.push(event);
                }
            }
        }
    }

    error(message, error = null) {
        return this.report('error', message, {
            stack: error?.stack || new Error().stack
        });
    }

    success(message, metadata = {}) {
        return this.report('success', message, metadata);
    }

    event(message, metadata = {}) {
        return this.report('event', message, metadata);
    }

    destroy() {
        if (this.flushInterval) {
            clearInterval(this.flushInterval);
        }
        this.flush();
    }
}

const telemetry = new TelemetryService();

// Configure logging
log.transports.file.level = 'info';
log.transports.console.level = 'debug';

// Configuration store
const store = new Store({
    name: 'openlink-config',
    encryptionKey: 'openlink-secure-key-2024',
    defaults: {
        autoStart: true,
        runAtLogin: true,
        startMinimized: false,
        allowRemoteConnections: 'ask',  // 'always', 'never', 'ask'
        trustedMachines: {},
        // Host settings - what remote users can access
        shareAudio: true,
        allowInput: true,
        allowClipboard: true,
        allowFiles: true,
        // eCripto integration
        eCriptoEnabled: false,
        // Wallet settings
        walletAddress: '',
        walletNetwork: 'ecripto',
        savedWallets: [],
        autoConnectWallet: false,
        // Session persistence
        persistSessionId: true,
        lastSessionId: null,
        customSessionId: '',
        sessionPassword: '',
        sessionIdWords: '',
        autoHostStartup: false,
        // Server selection
        selectedServer: '',
        // Window visibility
        keepWindowVisible: false,
        // Audio settings
        audioSettings: {
            autoEnableMic: false,
            alwaysEnableMedia: true,
            remoteVolume: 100,
            localVolume: 100
        },
        clipboardSettings: {
            enableSharing: true,
            doubleCopyTransfer: true  // Copy twice to transfer
        },
        sharedFilesPath: path.join(os.homedir(), 'Documents', 'OpenLink', 'shared_files'),
        recentConnections: [],
        windowState: null,
        // First-run / onboarding
        setupComplete: false,
        onboardingVersion: 0  // Increment to re-show onboarding after major changes
    }
});

// Global references
let mainWindow = null;
let tray = null;
let signalingServer = null;
let hostInputHandler = null;
let screenReaderController = null;
let ecriptoConnector = null;
let windowsHotkeyManager = null;
let notificationService = null;
let userVerificationService = null;
let ollamaService = null;
let dvcKeyboard = null;
let remoteManagementService = null;
let dropinManagementService = null;
let monitorService = null;
// v1.7.4+ service instances
let splashUpdaterService = null;
let featureGateService = null;
let rateLimitService = null;
let trustScoreService = null;
let alternativePaymentService = null;
let announcementService = null;
let splashWindow = null;

// Clipboard monitoring for double-copy feature
let lastClipboardText = '';
let lastClipboardTime = 0;
let clipboardCheckInterval = null;

// ==================== App Initialization ====================

/**
 * Check for pending reconnection after an update restart
 * Restores hosting or connection state from before the update
 */
function checkPendingUpdateReconnect() {
    const pendingReconnect = store.get('pendingUpdateReconnect');

    if (!pendingReconnect) {
        return;
    }

    // Check if this reconnect is recent (within 5 minutes)
    const fiveMinutes = 5 * 60 * 1000;
    if (Date.now() - pendingReconnect.timestamp > fiveMinutes) {
        log.info('Pending reconnect too old, clearing');
        store.delete('pendingUpdateReconnect');
        return;
    }

    log.info('Found pending update reconnect:', pendingReconnect);

    // Clear the pending reconnect so we don't try again
    store.delete('pendingUpdateReconnect');

    // Wait for main window to be ready, then trigger reconnection
    setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            // Send reconnection info to renderer
            mainWindow.webContents.send('update-reconnect', {
                wasHosting: pendingReconnect.wasHosting,
                sessionId: pendingReconnect.sessionId,
                wasConnected: pendingReconnect.wasConnected,
                connectedTo: pendingReconnect.connectedTo,
                fromVersion: pendingReconnect.fromVersion,
                toVersion: pendingReconnect.toVersion
            });

            log.info('Sent update-reconnect event to renderer');

            // Show notification about successful update and reconnection
            if (notificationService) {
                const reconnectType = pendingReconnect.wasHosting ? 'hosting session' : 'connection';
                notificationService.send({
                    title: 'OpenLink Updated',
                    message: `Updated to v${pendingReconnect.toVersion}. Restoring your ${reconnectType}...`,
                    priority: 'normal'
                });
            }
        }
    }, 2000); // Give the renderer time to initialize
}

// Handle openlink:// protocol URLs
let pendingProtocolUrl = null;

// Parse openlink:// URL to extract session info
// Format: openlink://server.domain.com/sessionId
function parseProtocolUrl(url) {
    if (!url || !url.startsWith('openlink://')) return null;
    try {
        const urlStr = url.replace('openlink://', 'https://');
        const parsed = new URL(urlStr);
        const sessionId = parsed.pathname.replace(/^\/+/, '').split('/')[0];
        const server = parsed.hostname;
        return { server, sessionId };
    } catch (e) {
        log.error('Failed to parse protocol URL:', e);
        return null;
    }
}

// Handle protocol URL on macOS
app.on('open-url', (event, url) => {
    event.preventDefault();
    log.info('[Protocol] Received URL:', url);
    const parsed = parseProtocolUrl(url);
    if (parsed && mainWindow) {
        mainWindow.show();
        mainWindow.focus();
        if (process.platform === 'darwin') app.dock.show();
        // Send to renderer to connect
        mainWindow.webContents.send('protocol-connect', parsed);
    } else if (parsed) {
        // Store for when window is ready
        pendingProtocolUrl = parsed;
    }
});

// Handle single instance / protocol URL on Windows/Linux
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (event, commandLine) => {
        // Find protocol URL in command line args
        const urlArg = commandLine.find(arg => arg.startsWith('openlink://'));
        if (urlArg) {
            log.info('[Protocol] Second instance URL:', urlArg);
            const parsed = parseProtocolUrl(urlArg);
            if (parsed && mainWindow) {
                mainWindow.show();
                mainWindow.focus();
                mainWindow.webContents.send('protocol-connect', parsed);
            }
        } else if (mainWindow) {
            // No URL, just focus window
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });
}

// Register protocol handler on Windows
if (process.platform === 'win32') {
    app.setAsDefaultProtocolClient('openlink');
}

// Create splash screen for startup updates
function createSplashWindow() {
    splashWindow = new BrowserWindow({
        width: 400,
        height: 300,
        frame: false,
        transparent: true,
        resizable: false,
        center: true,
        alwaysOnTop: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload-splash.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    splashWindow.loadFile(path.join(__dirname, 'ui', 'splash-screen.html'));
    return splashWindow;
}

// Close splash and show main window
function closeSplashAndShowMain() {
    if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close();
        splashWindow = null;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        if (process.platform === 'darwin') {
            app.dock.show();
        }
    }
}

// Fix macOS permissions on startup (for unsigned apps)
async function fixMacPermissionsOnStartup() {
    if (process.platform !== 'darwin') return;

    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);

    try {
        // Check if Screen Recording permission is already granted
        const hasPermission = macScreenCapturePermissions?.hasScreenCapturePermission?.() || false;

        if (!hasPermission) {
            log.info('[Permissions] Screen Recording not granted, attempting to fix...');

            // Write permission fix script to temp file and execute with admin privileges
            const bundleId = 'com.openlink.app';
            const tmpScript = '/tmp/openlink-fix-permissions.sh';
            const tccDb = '/Library/Application Support/com.apple.TCC/TCC.db';

            // Create the shell script
            const scriptContent = `#!/bin/bash
sqlite3 "${tccDb}" "DELETE FROM access WHERE client='${bundleId}' AND service='kTCCServiceScreenCapture';"
sqlite3 "${tccDb}" "INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, flags) VALUES ('kTCCServiceScreenCapture', '${bundleId}', 0, 2, 0, 1, 0);"
sqlite3 "${tccDb}" "DELETE FROM access WHERE client='${bundleId}' AND service='kTCCServiceAccessibility';"
sqlite3 "${tccDb}" "INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, flags) VALUES ('kTCCServiceAccessibility', '${bundleId}', 0, 2, 0, 1, 0);"
`;
            try {
                // Write script to temp file
                fs.writeFileSync(tmpScript, scriptContent, { mode: 0o755 });

                // Execute with admin privileges using osascript
                await execAsync(`osascript -e 'do shell script "${tmpScript}" with administrator privileges'`);

                // Clean up
                fs.unlinkSync(tmpScript);

                log.info('[Permissions] Successfully granted Screen Recording and Accessibility permissions');
                log.info('[Permissions] Restarting app to apply permission changes...');
                telemetry.success('Permissions auto-granted on startup, restarting').catch(() => {});

                // Restart the app so macOS recognizes the new permissions
                setTimeout(() => {
                    app.relaunch();
                    app.exit(0);
                }, 1000);
                return; // Exit early, app will restart
            } catch (e) {
                // Clean up on error
                try { fs.unlinkSync(tmpScript); } catch {}
                log.warn('[Permissions] Auto-grant failed (user may have cancelled):', e.message);
            }
        } else {
            log.info('[Permissions] Screen Recording already granted');
        }
    } catch (error) {
        log.warn('[Permissions] Permission check error:', error.message);
    }
}

// Cleanup leftover processes and port conflicts on startup
async function cleanupOnStartup() {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);

    try {
        if (process.platform === 'darwin' || process.platform === 'linux') {
            // Kill any processes using our port
            try {
                await execAsync('kill -9 $(lsof -t -i :8765) 2>/dev/null || true');
            } catch (e) {
                // Port may already be free
            }

            // Kill leftover OpenLink processes (not including ourselves)
            const currentPid = process.pid;
            try {
                const { stdout } = await execAsync('pgrep -f "OpenLink" 2>/dev/null || true');
                const pids = stdout.trim().split('\n').filter(p => p && parseInt(p) !== currentPid);
                for (const pid of pids) {
                    try {
                        await execAsync(`kill -9 ${pid} 2>/dev/null || true`);
                    } catch (e) {}
                }
            } catch (e) {}
        } else if (process.platform === 'win32') {
            // Windows: Kill leftover OpenLink processes
            try {
                await execAsync('taskkill /F /IM "OpenLink.exe" /T 2>nul', { shell: true });
            } catch (e) {
                // May fail if no processes to kill
            }
            // Free up port 8765
            try {
                const { stdout } = await execAsync('netstat -ano | findstr :8765', { shell: true });
                const lines = stdout.trim().split('\n');
                for (const line of lines) {
                    const parts = line.trim().split(/\s+/);
                    const pid = parts[parts.length - 1];
                    if (pid && parseInt(pid) !== process.pid) {
                        await execAsync(`taskkill /F /PID ${pid} 2>nul`, { shell: true });
                    }
                }
            } catch (e) {}
        }
        log.info('Startup cleanup completed');
    } catch (error) {
        log.warn('Startup cleanup error (non-fatal):', error.message);
    }
}

// App ready
app.whenReady().then(async () => {
    log.info('OpenLink starting...');

    // Clean up any leftover processes/ports from previous instances
    await cleanupOnStartup();

    // Fix macOS permissions (for unsigned apps that lose permissions on rebuild)
    await fixMacPermissionsOnStartup();

    // Run startup recovery checks (detect crashes, check for emergency updates)
    try {
        const recoveryResult = await startupRecovery.runPreLaunchChecks();
        log.info('Startup recovery:', recoveryResult.message);

        if (!recoveryResult.shouldContinue) {
            log.info('Startup recovery triggered update, exiting...');
            return;
        }

        if (recoveryResult.safeMode) {
            log.warn('Starting in safe mode due to previous crash');
            // Could disable certain features in safe mode
        }
    } catch (recoveryError) {
        log.error('Startup recovery failed:', recoveryError);
        // Continue anyway
    }

    // Register as default protocol handler on macOS and Linux
    if (process.platform !== 'win32') {
        app.setAsDefaultProtocolClient('openlink');
    }

    // Enable accessibility support for screen readers (VoiceOver, NVDA, etc.)
    app.accessibilitySupportEnabled = true;
    log.info('Accessibility support enabled');

    // Hide dock initially on macOS (will be shown when window is visible)
    if (process.platform === 'darwin') {
        app.dock.hide();
    }

    // Show splash screen and check for updates first
    if (SplashUpdaterService) {
        createSplashWindow();
        splashUpdaterService = new SplashUpdaterService(splashWindow, autoUpdater);

        try {
            const updateResult = await splashUpdaterService.run();
            log.info('Splash updater result:', updateResult);

            if (updateResult.updateInstalled) {
                // App will restart, don't continue
                return;
            }
        } catch (updateError) {
            log.error('Splash update check failed:', updateError);
        }

        // Close splash, will show main window after initialization
        if (splashWindow && !splashWindow.isDestroyed()) {
            splashWindow.close();
            splashWindow = null;
        }
    }

    // Create shared files directory
    const sharedPath = store.get('sharedFilesPath');
    if (!fs.existsSync(sharedPath)) {
        fs.mkdirSync(sharedPath, { recursive: true });
    }

    // Initialize components
    await initializeComponents();

    // Initialize notification service
    notificationService = new NotificationService(store);
    log.info('Notification service initialized');

    // Initialize user verification service
    if (UserVerificationService) {
        userVerificationService = new UserVerificationService(store, notificationService, ecriptoConnector);
        log.info('User verification service initialized');
    }

    // Initialize Ollama service for AI-powered notifications
    ollamaService = new OllamaService({ model: 'llama3.2:3b' });
    ollamaService.checkAvailability().then(available => {
        log.info(`Ollama service ${available ? 'available' : 'not available'}`);
    });

    // Initialize remote management service
    remoteManagementService = new RemoteManagementService({
        allowRemoteCommands: true,
        requireApproval: true
    });
    log.info('Remote management service initialized');

    // Initialize drop-in management service
    if (DropinManagementService) {
        dropinManagementService = new DropinManagementService();
        log.info('Drop-in management service initialized');
    }

    // Initialize monitor service for hub reporting
    if (MonitorService) {
        monitorService = new MonitorService({
            enabled: store.get('monitoring.enabled', false),
            hubUrl: store.get('monitoring.hubUrl', 'https://hub.openlink.tappedin.fm'),
            reportInterval: store.get('monitoring.reportInterval', 60000)
        });
        monitorService.start();
        log.info('Monitor service initialized');
    }

    // Initialize v1.7.4+ services (after ecriptoConnector is ready)
    if (FeatureGateService && ecriptoConnector) {
        featureGateService = new FeatureGateService(store, ecriptoConnector);
        log.info('Feature gate service initialized');
    }

    if (RateLimitService && ecriptoConnector) {
        rateLimitService = new RateLimitService(store, ecriptoConnector);
        log.info('Rate limit service initialized');
    }

    if (TrustScoreService && ecriptoConnector) {
        trustScoreService = new TrustScoreService(store, ecriptoConnector);
        log.info('Trust score service initialized');
    }

    if (AlternativePaymentService && ecriptoConnector) {
        alternativePaymentService = new AlternativePaymentService(store, ecriptoConnector);
        log.info('Alternative payment service initialized');
    }

    if (AnnouncementService && ecriptoConnector) {
        announcementService = new AnnouncementService(store, ecriptoConnector);
        announcementService.recordSessionStart();
        log.info('Announcement service initialized');
    }

    // Create window
    createMainWindow();

    // Create tray
    createTray();

    // Set up auto-start
    setupAutoStart();

    // Start clipboard monitoring
    if (store.get('clipboardSettings.enableSharing')) {
        startClipboardMonitoring();
    }

    // Check for updates
    autoUpdater.checkForUpdatesAndNotify();

    // Initialize incremental updater for hot file updates
    incrementalUpdater.initialize();
    log.info('Incremental updater initialized');

    // Check for pending reconnection after update
    checkPendingUpdateReconnect();

    // Check if app was restarted after update (--updated flag)
    if (process.argv.includes('--updated')) {
        log.info('App restarted after update - checking permissions');
        setTimeout(async () => {
            await checkAndPromptForPermissionsAfterUpdate();
        }, 2000);
    }

    // Register global shortcuts
    registerGlobalShortcuts();
});

app.on('window-all-closed', () => {
    // Keep running in tray on macOS and Windows
    if (process.platform !== 'darwin') {
        // Don't quit, minimize to tray
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
    }
});

app.on('before-quit', async () => {
    if (signalingServer) {
        signalingServer.stop();
    }
    if (clipboardCheckInterval) {
        clearInterval(clipboardCheckInterval);
    }
    // Cleanup Windows hotkey manager (re-enable Win+L if it was disabled)
    if (windowsHotkeyManager) {
        await windowsHotkeyManager.cleanup();
    }
});

// ==================== Component Initialization ====================

async function initializeComponents() {
    // Start signaling server
    try {
        const SignalingServer = require('./signaling-server');
        signalingServer = new SignalingServer({ port: 8765 });
        const result = await signalingServer.start();
        log.info(`Signaling server started (mode: ${result.mode}, port: ${result.port})`);
    } catch (e) {
        log.warn('Signaling server not started, running in client-only mode:', e.message);
        // App can still work without local signaling server
    }

    // Initialize host input handler
    try {
        const HostInputHandler = require('./host-input-handler');
        hostInputHandler = new HostInputHandler();
        log.info('Host input handler initialized');
    } catch (e) {
        log.warn('Host input handler not available:', e.message);
    }

    // Initialize screen reader controller
    try {
        const ScreenReaderController = require('./screen-reader-controller');
        screenReaderController = new ScreenReaderController();
        log.info('Screen reader controller initialized');
    } catch (e) {
        log.warn('Screen reader controller not available:', e.message);
    }

    // Initialize eCripto connector
    try {
        const EcriptoConnector = require('./ecripto-connector');
        ecriptoConnector = new EcriptoConnector();
        const ecriptoStatus = await ecriptoConnector.initialize();
        if (ecriptoStatus.success) {
            log.info(`eCripto connected via ${ecriptoStatus.mode} mode`);
            log.info(`eCripto capabilities: ${ecriptoStatus.capabilities.join(', ')}`);
        } else {
            log.info('eCripto not available, web fallback enabled');
        }
    } catch (e) {
        log.warn('eCripto connector not available:', e.message);
    }

    // Initialize Windows hotkey manager (for disabling Win+L during remote sessions)
    try {
        const WindowsHotkeyManager = require('./windows-hotkey-manager');
        windowsHotkeyManager = new WindowsHotkeyManager();
        log.info('Windows hotkey manager initialized');
    } catch (e) {
        log.warn('Windows hotkey manager not available:', e.message);
    }

    // Initialize DVCKeyboard for accessible remote keyboard input
    try {
        const DVCKeyboard = require('./dvc-keyboard');
        dvcKeyboard = new DVCKeyboard({
            announceKeys: true,
            enableMacros: true,
            onSend: (data) => {
                // Forward keyboard events to renderer for WebRTC transmission
                if (mainWindow) {
                    mainWindow.webContents.send('dvc-keyboard-input', data);
                }
            },
            onAnnounce: (text) => {
                // Send announcements to renderer for screen reader
                if (mainWindow) {
                    mainWindow.webContents.send('dvc-keyboard-announce', text);
                }
            }
        });
        log.info('DVCKeyboard initialized');
    } catch (e) {
        log.warn('DVCKeyboard not available:', e.message);
    }
}

// ==================== macOS Permission Management ====================

/**
 * Check and prompt for macOS system permissions
 * Returns: { granted: boolean, status: string }
 */
function checkMacPermission(type) {
    if (process.platform !== 'darwin') {
        return { granted: true, status: 'not-applicable' };
    }

    try {
        if (type === 'screen') {
            // Use Electron's API as primary - more reliable
            const status = systemPreferences.getMediaAccessStatus('screen');
            log.info(`Screen permission check - Electron API: ${status}`);

            // Also check with npm package for comparison
            if (macScreenCapturePermissions) {
                const npmResult = macScreenCapturePermissions.hasScreenCapturePermission();
                log.info(`Screen permission check - npm package: ${npmResult}`);
            }

            // 'granted' means fully granted, 'restricted' and 'not-determined' need prompt
            const granted = status === 'granted';
            return { granted, status };
        } else if (type === 'accessibility') {
            // Use Electron's API as primary
            const trusted = systemPreferences.isTrustedAccessibilityClient(false);
            log.info(`Accessibility permission check - Electron API: ${trusted}`);

            // Also check with npm package for comparison
            if (nodeMacPermissions) {
                const npmStatus = nodeMacPermissions.getAuthStatus('accessibility');
                log.info(`Accessibility permission check - npm package: ${npmStatus}`);
            }

            return { granted: trusted, status: trusted ? 'granted' : 'denied' };
        } else if (type === 'microphone') {
            const status = systemPreferences.getMediaAccessStatus('microphone');
            return { granted: status === 'granted', status };
        } else if (type === 'camera') {
            const status = systemPreferences.getMediaAccessStatus('camera');
            return { granted: status === 'granted', status };
        }
    } catch (e) {
        log.error(`Failed to check ${type} permission:`, e);
    }
    return { granted: false, status: 'unknown' };
}

/**
 * Trigger macOS permission prompt
 * This actually prompts the user for permission
 */
async function triggerMacPermissionPrompt(type) {
    if (process.platform !== 'darwin') {
        return { granted: true, status: 'not-applicable' };
    }

    try {
        if (type === 'screen') {
            // mac-screen-capture-permissions can trigger the permission dialog
            if (macScreenCapturePermissions) {
                // Check if we've already prompted
                const hasPrompted = macScreenCapturePermissions.hasPromptedForPermission();
                log.info(`Screen capture prompt status: hasPrompted=${hasPrompted}`);

                // Call hasScreenCapturePermission to trigger the dialog if not prompted
                const hasPermission = macScreenCapturePermissions.hasScreenCapturePermission();

                if (!hasPermission && !hasPrompted) {
                    // The dialog should have been triggered, wait and check again
                    await new Promise(resolve => setTimeout(resolve, 500));
                    const recheckPermission = macScreenCapturePermissions.hasScreenCapturePermission();
                    return { granted: recheckPermission, status: recheckPermission ? 'granted' : 'pending', prompted: true };
                }

                return { granted: hasPermission, status: hasPermission ? 'granted' : 'denied', prompted: hasPrompted };
            }
        } else if (type === 'accessibility') {
            // Use node-mac-permissions to trigger accessibility prompt
            if (nodeMacPermissions) {
                const currentStatus = nodeMacPermissions.getAuthStatus('accessibility');
                if (currentStatus === 'not determined') {
                    // Ask for permission - this triggers the prompt
                    nodeMacPermissions.askForAccessibilityAccess();
                    return { granted: false, status: 'pending', prompted: true };
                }
                return { granted: currentStatus === 'authorized', status: currentStatus };
            }
            // Fallback - trigger via isTrustedAccessibilityClient with prompt
            const trusted = systemPreferences.isTrustedAccessibilityClient(true);  // true = prompt
            return { granted: trusted, status: trusted ? 'granted' : 'pending', prompted: true };
        }
    } catch (e) {
        log.error(`Failed to trigger ${type} permission prompt:`, e);
    }
    return { granted: false, status: 'unknown' };
}

/**
 * Request macOS permission and open System Preferences if needed
 */
async function requestMacPermission(type, promptUser = true) {
    if (process.platform !== 'darwin') {
        return { granted: true, status: 'not-applicable' };
    }

    const current = checkMacPermission(type);
    if (current.granted) {
        return current;
    }

    // For media types, try to request permission
    if (type === 'microphone' || type === 'camera') {
        try {
            const granted = await systemPreferences.askForMediaAccess(type);
            return { granted, status: granted ? 'granted' : 'denied' };
        } catch (e) {
            log.error(`Failed to request ${type} permission:`, e);
        }
    }

    // For screen recording and accessibility, we need to prompt user to open System Preferences
    if (promptUser && (type === 'screen' || type === 'accessibility')) {
        const prefPane = type === 'screen'
            ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
            : 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';

        const permissionName = type === 'screen' ? 'Screen Recording' : 'Accessibility';

        const result = await dialog.showMessageBox(mainWindow, {
            type: 'warning',
            title: `${permissionName} Permission Required`,
            message: `OpenLink needs ${permissionName} permission to function properly.`,
            detail: `This allows OpenLink to ${type === 'screen' ? 'share your screen with remote users' : 'control keyboard and mouse for remote sessions'}.\n\nClick "Open Settings" to grant permission, then restart OpenLink.`,
            buttons: ['Open Settings', 'Cancel'],
            defaultId: 0,
            cancelId: 1
        });

        if (result.response === 0) {
            shell.openExternal(prefPane);
            return { granted: false, status: 'pending', openedSettings: true };
        }
    }

    return { granted: false, status: current.status };
}

/**
 * Get all macOS permission statuses
 */
function getAllMacPermissions() {
    if (process.platform !== 'darwin') {
        return {
            screen: { granted: true, status: 'not-applicable' },
            accessibility: { granted: true, status: 'not-applicable' },
            microphone: { granted: true, status: 'not-applicable' },
            camera: { granted: true, status: 'not-applicable' }
        };
    }

    return {
        screen: checkMacPermission('screen'),
        accessibility: checkMacPermission('accessibility'),
        microphone: checkMacPermission('microphone'),
        camera: checkMacPermission('camera')
    };
}

/**
 * Check permissions on startup and prompt user if needed
 * Shows a comprehensive permission setup dialog
 */
async function checkStartupPermissions() {
    if (process.platform !== 'darwin') {
        return { allGranted: true };
    }

    const permissions = getAllMacPermissions();
    const screenGranted = permissions.screen.granted;
    const accessibilityGranted = permissions.accessibility.granted;

    // If all critical permissions are granted, no need to prompt
    if (screenGranted && accessibilityGranted) {
        log.info('All macOS permissions granted');
        return { allGranted: true, permissions };
    }

    // Check if we've already prompted recently (don't nag on every restart)
    const lastPrompt = store.get('lastPermissionPrompt') || 0;
    const hoursSincePrompt = (Date.now() - lastPrompt) / (1000 * 60 * 60);

    // Only show on first launch or if user explicitly requests via settings
    const hasCompletedSetup = store.get('setupComplete');
    if (hasCompletedSetup && hoursSincePrompt < 24) {
        log.info('Skipping permission prompt (prompted recently)');
        return { allGranted: false, permissions, skipped: true };
    }

    log.info('Missing permissions - will prompt user');
    return { allGranted: false, permissions, shouldPrompt: true };
}

/**
 * Show comprehensive permission setup dialog
 */
async function showPermissionSetupDialog() {
    if (process.platform !== 'darwin' || !mainWindow) {
        return;
    }

    const permissions = getAllMacPermissions();
    const missingPermissions = [];

    if (!permissions.screen.granted) {
        missingPermissions.push('Screen Recording');
    }
    if (!permissions.accessibility.granted) {
        missingPermissions.push('Accessibility');
    }

    if (missingPermissions.length === 0) {
        return { allGranted: true };
    }

    store.set('lastPermissionPrompt', Date.now());

    const detail = `OpenLink needs the following permissions to work properly:

${!permissions.screen.granted ? '❌ Screen Recording - Required to share your screen\n' : '✅ Screen Recording - Granted\n'}${!permissions.accessibility.granted ? '❌ Accessibility - Required for remote control\n' : '✅ Accessibility - Granted\n'}
To grant permissions:
1. Click "Open System Settings"
2. Add OpenLink to the list (toggle ON)
3. Restart OpenLink after granting permissions`;

    const result = await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'OpenLink Permissions Setup',
        message: 'Permissions Required',
        detail,
        buttons: ['Open System Settings', 'Grant Screen Recording', 'Grant Accessibility', 'Later'],
        defaultId: 0,
        cancelId: 3
    });

    if (result.response === 0) {
        // Open main Privacy settings
        shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy');
        return { openedSettings: 'privacy' };
    } else if (result.response === 1) {
        // Open Screen Recording settings
        shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
        return { openedSettings: 'screen' };
    } else if (result.response === 2) {
        // Open Accessibility settings
        shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
        return { openedSettings: 'accessibility' };
    }

    return { dismissed: true };
}

/**
 * Open specific permission settings pane
 */
function openPermissionSettings(type) {
    if (process.platform !== 'darwin') return;

    const urls = {
        screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
        accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
        microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
        camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
        privacy: 'x-apple.systempreferences:com.apple.preference.security?Privacy'
    };

    const url = urls[type] || urls.privacy;
    shell.openExternal(url);
    log.info(`Opened ${type} permission settings`);
}

/**
 * Check and prompt for permissions after app update
 * Updates can sometimes invalidate permissions due to code signing changes
 */
async function checkAndPromptForPermissionsAfterUpdate() {
    if (process.platform !== 'darwin') {
        return;
    }

    log.info('Checking permissions after update...');
    const permissions = getAllMacPermissions();

    const screenGranted = permissions.screen?.granted;
    const accessibilityGranted = permissions.accessibility?.granted;

    if (screenGranted && accessibilityGranted) {
        log.info('All permissions still valid after update');
        // Notify user that update is complete
        if (mainWindow) {
            mainWindow.webContents.send('update-complete', {
                version: app.getVersion(),
                permissionsOk: true
            });
        }
        return;
    }

    log.warn('Some permissions may need to be re-granted after update');
    const missingPerms = [];
    if (!screenGranted) missingPerms.push('Screen Recording');
    if (!accessibilityGranted) missingPerms.push('Accessibility');

    // Show dialog to user about permission restoration
    const result = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Permissions May Need Restoration',
        message: `OpenLink was updated successfully!`,
        detail: `However, the following permissions may need to be re-granted:\n\n${missingPerms.join(', ')}\n\nThis sometimes happens after app updates due to macOS security.\n\nWould you like to open System Settings to restore permissions?`,
        buttons: ['Open System Settings', 'Remind Me Later', 'Skip'],
        defaultId: 0,
        cancelId: 2
    });

    if (result.response === 0) {
        // Open the appropriate settings pane
        if (!screenGranted) {
            shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
        } else if (!accessibilityGranted) {
            shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
        }
    } else if (result.response === 1) {
        // Set a reminder to prompt again in 1 hour
        store.set('permissionReminderTime', Date.now() + (60 * 60 * 1000));
    }

    // Notify renderer about permission status
    if (mainWindow) {
        mainWindow.webContents.send('update-complete', {
            version: app.getVersion(),
            permissionsOk: false,
            missingPermissions: missingPerms
        });
    }
}

// ==================== Window Management ====================

function createMainWindow() {
    const savedState = store.get('windowState') || {};
    const shouldStartHidden = store.get('startMinimized') || process.argv.includes('--hidden');

    mainWindow = new BrowserWindow({
        width: savedState.width || 1024,
        height: savedState.height || 768,
        x: savedState.x,
        y: savedState.y,
        minWidth: 800,
        minHeight: 600,
        show: !shouldStartHidden,  // Show immediately unless starting minimized
        title: 'OpenLink',
        accessibleTitle: 'OpenLink Remote Desktop Application',
        icon: getIconPath(),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
            // Enable accessibility features for screen readers
            accessibleTitle: 'OpenLink'
        },
        // Enable display on login screen (Windows)
        skipTaskbar: shouldStartHidden,  // Hide from taskbar when minimized to tray
        autoHideMenuBar: true
    });

    // Only show window if not starting minimized
    mainWindow.once('ready-to-show', () => {
        // Mark successful startup (clears crash detection flag)
        if (startupRecovery) {
            startupRecovery.markSuccessfulStart();
        }

        if (!shouldStartHidden) {
            mainWindow.show();
            // Show dock when window is visible on macOS
            if (process.platform === 'darwin') {
                app.dock.show();
            }
        } else {
            // Hide dock when starting minimized on macOS
            if (process.platform === 'darwin') {
                app.dock.hide();
            }
        }
    });

    // Load main UI
    mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));

    // Save window state on close
    mainWindow.on('close', (e) => {
        const closeBehavior = store.get('closeBehavior', 'tray');

        if (!app.isQuitting && closeBehavior === 'tray') {
            e.preventDefault();
            mainWindow.hide();
            // Hide from dock (Cmd+Tab) when minimized to tray on macOS
            if (process.platform === 'darwin') {
                app.dock.hide();
            }
            return false;
        }

        // Save window state before closing
        const bounds = mainWindow.getBounds();
        store.set('windowState', {
            width: bounds.width,
            height: bounds.height,
            x: bounds.x,
            y: bounds.y
        });

        // If closeBehavior is 'quit', allow the close to proceed
        if (closeBehavior === 'quit') {
            app.isQuitting = true;
        }
    });

    // Also hide from dock when window is hidden via other means
    mainWindow.on('hide', () => {
        if (process.platform === 'darwin') {
            app.dock.hide();
        }
    });

    // Show in dock when window becomes visible
    mainWindow.on('show', () => {
        if (process.platform === 'darwin') {
            app.dock.show();
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    // Handle window ready
    mainWindow.webContents.on('did-finish-load', () => {
        // Send initial settings
        mainWindow.webContents.send('settings-loaded', {
            audioSettings: store.get('audioSettings'),
            clipboardSettings: store.get('clipboardSettings'),
            recentConnections: store.get('recentConnections')
        });

        // Handle pending protocol URL (from app launch via openlink://)
        if (pendingProtocolUrl) {
            log.info('[Protocol] Sending pending URL to renderer:', pendingProtocolUrl);
            mainWindow.webContents.send('protocol-connect', pendingProtocolUrl);
            pendingProtocolUrl = null;
        }
    });
}

function getIconPath() {
    const platform = os.platform();
    const iconDir = path.join(__dirname, '..', 'assets');

    if (platform === 'win32') {
        return path.join(iconDir, 'icon.ico');
    } else if (platform === 'darwin') {
        return path.join(iconDir, 'icon.icns');
    } else {
        return path.join(iconDir, 'icon.png');
    }
}

// ==================== Tray ====================

function createTray() {
    const iconPath = path.join(__dirname, '..', 'assets', 'tray-icon.png');
    let trayIcon;

    try {
        trayIcon = nativeImage.createFromPath(iconPath);
        if (trayIcon.isEmpty()) {
            trayIcon = nativeImage.createEmpty();
        }
    } catch (e) {
        trayIcon = nativeImage.createEmpty();
    }

    tray = new Tray(trayIcon);
    updateTrayMenu();

    tray.on('click', () => {
        if (mainWindow) {
            if (mainWindow.isVisible()) {
                mainWindow.hide();
            } else {
                mainWindow.show();
                mainWindow.focus();
            }
        }
    });
}

// Track connection state for tray menu
let trayConnectionState = {
    isHosting: false,
    isConnected: false,
    connectedTo: null,
    sessionId: null,
    currentUrl: null,
    connectedClients: [],  // Array of { id, name, device, platform, connectedAt, isReturning, isTrusted, walletAddress }
    clientCount: 0
};

// Connection history storage
function getConnectionHistory() {
    return store.get('connectionHistory', {});
}

function addToConnectionHistory(clientInfo) {
    const history = getConnectionHistory();
    const clientId = clientInfo.machineId || clientInfo.id;

    if (!history[clientId]) {
        history[clientId] = {
            firstSeen: Date.now(),
            lastSeen: Date.now(),
            connectionCount: 1,
            name: clientInfo.name || 'Unknown Device',
            device: clientInfo.device || clientInfo.platform || 'Unknown',
            walletAddress: clientInfo.walletAddress || null,
            isTrusted: false,
            isPersonalDevice: false
        };
    } else {
        history[clientId].lastSeen = Date.now();
        history[clientId].connectionCount++;
        if (clientInfo.name) history[clientId].name = clientInfo.name;
        if (clientInfo.walletAddress) history[clientId].walletAddress = clientInfo.walletAddress;
    }

    store.set('connectionHistory', history);
    return history[clientId];
}

function markDeviceAsTrusted(clientId, trusted = true) {
    const history = getConnectionHistory();
    if (history[clientId]) {
        history[clientId].isTrusted = trusted;
        history[clientId].isPersonalDevice = trusted;
        store.set('connectionHistory', history);
    }
    updateTrayMenu();
}

function isReturningClient(clientId) {
    const history = getConnectionHistory();
    return history[clientId]?.connectionCount > 1;
}

function updateTrayConnectionState(state) {
    trayConnectionState = { ...trayConnectionState, ...state };
    updateTrayMenu();
}

// Build the dynamic status section for tray menu
function buildStatusSection() {
    const items = [];
    const history = getConnectionHistory();

    if (trayConnectionState.isHosting) {
        // Hosting status
        items.push({
            label: `🟢 Hosting: ${trayConnectionState.sessionId || 'Active'}`,
            sublabel: `${trayConnectionState.clientCount || 0} client(s) connected`,
            enabled: false
        });

        // Current URL if available
        if (trayConnectionState.currentUrl) {
            items.push({
                label: `📎 ${trayConnectionState.currentUrl}`,
                sublabel: 'Click to copy URL to clipboard',
                click: () => {
                    clipboard.writeText(trayConnectionState.currentUrl);
                    if (mainWindow) {
                        mainWindow.webContents.send('notification', {
                            title: 'URL Copied',
                            body: 'Shareable link copied to clipboard'
                        });
                    }
                }
            });
        }

        // Connected clients submenu
        if (trayConnectionState.connectedClients && trayConnectionState.connectedClients.length > 0) {
            items.push({ type: 'separator' });
            items.push({
                label: `Connected Clients (${trayConnectionState.connectedClients.length})`,
                sublabel: 'View and manage connected devices',
                submenu: trayConnectionState.connectedClients.map(client => {
                    const clientHistory = history[client.id] || {};
                    const isReturning = clientHistory.connectionCount > 1;
                    const isTrusted = clientHistory.isTrusted || clientHistory.isPersonalDevice;
                    const hasWallet = client.walletAddress || clientHistory.walletAddress;

                    let statusIcon = '👤';
                    if (isTrusted) statusIcon = '⭐';
                    else if (hasWallet) statusIcon = '💳';
                    else if (isReturning) statusIcon = '🔄';

                    const connectionInfo = isReturning
                        ? `Connected ${clientHistory.connectionCount} times`
                        : 'First time connecting';

                    return {
                        label: `${statusIcon} ${client.name || 'Unknown Device'}`,
                        sublabel: `${client.device || client.platform || 'Unknown'} - ${connectionInfo}`,
                        submenu: [
                            {
                                label: `Device: ${client.device || client.platform || 'Unknown'}`,
                                enabled: false
                            },
                            {
                                label: `ID: ${client.id?.substring(0, 12) || 'Unknown'}...`,
                                enabled: false
                            },
                            {
                                label: hasWallet ? `Wallet: ${(client.walletAddress || clientHistory.walletAddress).substring(0, 10)}...` : 'No wallet linked',
                                enabled: false
                            },
                            {
                                label: isReturning ? `Visits: ${clientHistory.connectionCount}` : 'First visit',
                                enabled: false
                            },
                            { type: 'separator' },
                            {
                                label: isTrusted ? '⭐ Personal Device' : 'Mark as Personal Device',
                                sublabel: isTrusted ? 'This device is trusted' : 'Trust this device for drop-in access',
                                type: 'checkbox',
                                checked: isTrusted,
                                click: () => {
                                    markDeviceAsTrusted(client.id, !isTrusted);
                                    // Also update trusted machines for drop-in
                                    const trusted = store.get('trustedMachines', {});
                                    if (!isTrusted) {
                                        trusted[client.id] = {
                                            name: client.name || 'Personal Device',
                                            permission: 'dropin',
                                            sessionId: trayConnectionState.sessionId,
                                            walletAddress: client.walletAddress || clientHistory.walletAddress
                                        };
                                    } else {
                                        delete trusted[client.id];
                                    }
                                    store.set('trustedMachines', trusted);
                                }
                            },
                            {
                                label: 'Disconnect',
                                sublabel: 'Remove this client from the session',
                                click: () => {
                                    if (mainWindow) {
                                        mainWindow.webContents.send('disconnect-client', client.id);
                                    }
                                }
                            }
                        ]
                    };
                })
            });
        } else {
            items.push({
                label: 'No clients connected',
                sublabel: 'Waiting for connections...',
                enabled: false
            });
        }
    } else if (trayConnectionState.isConnected) {
        // Connected to remote status
        items.push({
            label: `🔗 Connected to: ${trayConnectionState.connectedTo || 'Remote'}`,
            sublabel: 'You are viewing a remote computer',
            enabled: false
        });
    } else {
        // Not connected
        items.push({
            label: '⚪ Not Connected',
            sublabel: 'Start hosting or connect to a remote computer',
            enabled: false
        });
    }

    return items;
}

function updateTrayMenu() {
    if (!tray) return;

    const allowConnections = store.get('allowRemoteConnections', 'ask');
    const shareAudio = store.get('shareAudio', true);
    const allowInput = store.get('allowInput', true);
    const allowClipboard = store.get('allowClipboard', true);
    const allowFiles = store.get('allowFiles', true);
    const runAtLogin = store.get('runAtLogin', false);
    const eCriptoEnabled = store.get('eCriptoEnabled', false);
    const allowDropin = store.get('allowDropin', true);

    // Get readable setting values
    const connectionPermissionText = allowConnections === 'always' ? 'Always Allow'
        : allowConnections === 'never' ? 'Never Allow' : 'Ask Each Time';

    // Build status section
    const statusItems = buildStatusSection();

    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Open OpenLink',
            sublabel: 'Show the main OpenLink window',
            click: () => {
                if (mainWindow) {
                    mainWindow.show();
                    mainWindow.focus();
                    // Show in dock when window is visible
                    if (process.platform === 'darwin') {
                        app.dock.show();
                    }
                } else {
                    createMainWindow();
                }
            }
        },
        { type: 'separator' },
        // Dynamic Status Section
        ...statusItems,
        { type: 'separator' },
        // Connection Permission Submenu - Fixed: title is now "Connection Permissions"
        {
            label: 'Connection Permissions',
            sublabel: 'Control who can connect to your computer',
            submenu: [
                {
                    label: `Currently set to: ${connectionPermissionText}`,
                    sublabel: 'Your current permission setting',
                    enabled: false
                },
                { type: 'separator' },
                {
                    label: 'Ask for Each Connection',
                    sublabel: 'Prompt before allowing any connection - most secure',
                    type: 'radio',
                    checked: allowConnections === 'ask',
                    click: () => {
                        store.set('allowRemoteConnections', 'ask');
                        updateTrayMenu();
                    }
                },
                {
                    label: 'Always Allow',
                    sublabel: 'Allow all connections without prompting - use with caution',
                    type: 'radio',
                    checked: allowConnections === 'always',
                    click: async () => {
                        const { response } = await dialog.showMessageBox({
                            type: 'warning',
                            title: 'Security Warning',
                            message: 'Are you sure you want to always allow connections?',
                            detail: 'This will allow anyone with your session ID to connect without asking for permission. Only enable this if you trust all potential connections.',
                            buttons: ['Cancel', 'Enable Always Allow'],
                            defaultId: 0,
                            cancelId: 0
                        });
                        if (response === 1) {
                            store.set('allowRemoteConnections', 'always');
                            updateTrayMenu();
                        }
                    }
                },
                {
                    label: 'Never Allow',
                    sublabel: 'Block all incoming connections',
                    type: 'radio',
                    checked: allowConnections === 'never',
                    click: () => {
                        store.set('allowRemoteConnections', 'never');
                        updateTrayMenu();
                    }
                }
            ]
        },
        { type: 'separator' },
        // Hosting Options Submenu
        {
            label: 'Hosting Options',
            sublabel: 'What remote users can access on your computer',
            submenu: [
                {
                    label: `Share Audio is currently ${shareAudio ? 'enabled' : 'disabled'}`,
                    sublabel: 'Allow remote users to hear audio from your computer',
                    type: 'checkbox',
                    checked: shareAudio,
                    click: (item) => {
                        store.set('shareAudio', item.checked);
                        if (mainWindow) mainWindow.webContents.send('settings-updated', { shareAudio: item.checked });
                        updateTrayMenu();
                    }
                },
                {
                    label: `Remote Input is currently ${allowInput ? 'enabled' : 'disabled'}`,
                    sublabel: 'Allow remote users to control your keyboard and mouse',
                    type: 'checkbox',
                    checked: allowInput,
                    click: (item) => {
                        store.set('allowInput', item.checked);
                        if (mainWindow) mainWindow.webContents.send('settings-updated', { allowInput: item.checked });
                        updateTrayMenu();
                    }
                },
                {
                    label: `Clipboard Sharing is currently ${allowClipboard ? 'enabled' : 'disabled'}`,
                    sublabel: 'Sync clipboard contents between computers',
                    type: 'checkbox',
                    checked: allowClipboard,
                    click: (item) => {
                        store.set('allowClipboard', item.checked);
                        if (mainWindow) mainWindow.webContents.send('settings-updated', { allowClipboard: item.checked });
                        updateTrayMenu();
                    }
                },
                {
                    label: `File Transfers is currently ${allowFiles ? 'enabled' : 'disabled'}`,
                    sublabel: 'Allow sending and receiving files during sessions',
                    type: 'checkbox',
                    checked: allowFiles,
                    click: (item) => {
                        store.set('allowFiles', item.checked);
                        if (mainWindow) mainWindow.webContents.send('settings-updated', { allowFiles: item.checked });
                        updateTrayMenu();
                    }
                }
            ]
        },
        { type: 'separator' },
        // Application Options Submenu
        {
            label: 'Application',
            sublabel: 'OpenLink application settings',
            submenu: [
                {
                    label: `Run at Login is currently ${runAtLogin ? 'enabled' : 'disabled'}`,
                    sublabel: 'Start OpenLink automatically when you log in',
                    type: 'checkbox',
                    checked: runAtLogin,
                    click: (item) => {
                        store.set('runAtLogin', item.checked);
                        setupAutoStart();
                        updateTrayMenu();
                    }
                },
                {
                    label: `eCripto Integration is currently ${eCriptoEnabled ? 'enabled' : 'disabled'}`,
                    sublabel: 'Enable secure connections via eCripto wallet',
                    type: 'checkbox',
                    checked: eCriptoEnabled,
                    click: (item) => {
                        store.set('eCriptoEnabled', item.checked);
                        if (mainWindow) mainWindow.webContents.send('settings-updated', { eCriptoEnabled: item.checked });
                        updateTrayMenu();
                    }
                }
            ]
        },
        { type: 'separator' },
        // Check for Updates
        {
            label: 'Check for Updates...',
            sublabel: 'Download and install the latest version of OpenLink',
            click: () => {
                autoUpdater.checkForUpdatesAndNotify().then((result) => {
                    if (!result || !result.updateInfo) {
                        dialog.showMessageBox({
                            type: 'info',
                            title: 'No Updates Available',
                            message: 'You are running the latest version of OpenLink.',
                            buttons: ['OK']
                        });
                    }
                }).catch((err) => {
                    log.error('Update check failed:', err);
                    dialog.showMessageBox({
                        type: 'error',
                        title: 'Update Check Failed',
                        message: 'Could not check for updates. Please try again later.',
                        buttons: ['OK']
                    });
                });
            }
        },
        { type: 'separator' },
        // Drop-in Contacts Section
        ...buildDropinContactsMenu(),
        { type: 'separator' },
        {
            label: 'Quit OpenLink',
            sublabel: 'Exit OpenLink completely',
            click: () => {
                app.isQuitting = true;
                app.quit();
            }
        }
    ]);

    function buildDropinContactsMenu() {
        const trusted = store.get('trustedMachines');
        const dropinContacts = [];

        for (const [machineId, data] of Object.entries(trusted)) {
            if (data?.permission === 'dropin' && data.sessionId) {
                dropinContacts.push({
                    machineId,
                    name: data.name,
                    sessionId: data.sessionId
                });
            }
        }

        if (dropinContacts.length === 0) {
            return [{
                label: 'Drop-in Contacts',
                sublabel: 'Quick connect to trusted family and friends',
                submenu: [
                    {
                        label: 'No drop-in contacts set up',
                        sublabel: 'Add contacts by connecting and granting drop-in access',
                        enabled: false
                    },
                    { type: 'separator' },
                    {
                        label: 'How to add contacts...',
                        sublabel: 'Learn how to set up drop-in connections',
                        click: () => {
                            dialog.showMessageBox({
                                type: 'info',
                                title: 'Drop-in Contacts',
                                message: 'How to set up Drop-in Contacts',
                                detail: 'Drop-in contacts allow instant connections with trusted people (family, close friends).\n\nTo add a drop-in contact:\n1. Open OpenLink main window\n2. Connect to a trusted person\n3. When prompted, select "Enable Drop-in Access"\n\nOnce set up, you can instantly connect to them from this menu.',
                                buttons: ['OK']
                            });
                        }
                    }
                ]
            }];
        }

        return [
            {
                label: 'Drop-in Contacts',
                sublabel: 'Quick connect to trusted family and friends',
                submenu: [
                    {
                        label: `${dropinContacts.length} contact${dropinContacts.length > 1 ? 's' : ''} available`,
                        sublabel: 'Trusted contacts you can connect to instantly',
                        enabled: false
                    },
                    { type: 'separator' },
                    ...dropinContacts.map(contact => ({
                        label: `Connect to ${contact.name}`,
                        sublabel: `Start a remote session with ${contact.name}`,
                        click: () => {
                            if (mainWindow) {
                                mainWindow.show();
                                mainWindow.focus();
                                mainWindow.webContents.send('quick-connect', { sessionId: contact.sessionId, name: contact.name });
                            }
                        }
                    }))
                ]
            }
        ];
    }

    // Determine status label for tooltip
    const statusLabel = trayConnectionState.isHosting
        ? `Hosting (${trayConnectionState.clientCount || 0} clients)`
        : trayConnectionState.isConnected
            ? 'Connected'
            : 'Ready';

    tray.setContextMenu(contextMenu);
    tray.setToolTip(`OpenLink - ${statusLabel}`);
}

// ==================== Auto-Start ====================

function setupAutoStart() {
    const runAtLogin = store.get('runAtLogin');

    app.setLoginItemSettings({
        openAtLogin: runAtLogin,
        openAsHidden: store.get('startMinimized'),
        path: app.getPath('exe'),
        args: ['--hidden']
    });

    log.info(`Auto-start ${runAtLogin ? 'enabled' : 'disabled'}`);
}

// ==================== Global Shortcuts ====================

function registerGlobalShortcuts() {
    // Control menu hotkey: Option+Shift+Backspace
    globalShortcut.register('Alt+Shift+Backspace', () => {
        if (mainWindow) {
            mainWindow.webContents.send('open-control-menu');
        }
    });
}

// ==================== Clipboard Sharing ====================

function startClipboardMonitoring() {
    clipboardCheckInterval = setInterval(() => {
        const currentText = clipboard.readText();
        const currentTime = Date.now();

        if (currentText && currentText !== lastClipboardText) {
            const timeDiff = currentTime - lastClipboardTime;

            // Double-copy detection (within 1 second)
            if (store.get('clipboardSettings.doubleCopyTransfer') && timeDiff < 1000) {
                // This is a double-copy, trigger transfer
                if (mainWindow) {
                    mainWindow.webContents.send('clipboard-transfer', {
                        text: currentText,
                        type: 'double-copy'
                    });
                }
                log.info('Double-copy detected, transferring to remote');
            }

            lastClipboardText = currentText;
            lastClipboardTime = currentTime;

            // Notify of clipboard change
            if (mainWindow) {
                mainWindow.webContents.send('clipboard-changed', {
                    text: currentText,
                    isDoubleCopy: timeDiff < 1000
                });
            }
        }
    }, 200);
}

// ==================== IPC Handlers ====================

// macOS Permission handlers
ipcMain.handle('check-mac-permissions', () => {
    return getAllMacPermissions();
});

ipcMain.handle('check-mac-permission', (event, type) => {
    return checkMacPermission(type);
});

ipcMain.handle('request-mac-permission', async (event, type) => {
    return await requestMacPermission(type, true);
});

ipcMain.handle('trigger-mac-permission-prompt', async (event, type) => {
    return await triggerMacPermissionPrompt(type);
});

ipcMain.handle('show-permission-setup', async () => {
    return await showPermissionSetupDialog();
});

ipcMain.handle('open-permission-settings', (event, type) => {
    openPermissionSettings(type);
    return { opened: true, type };
});

// Grant permissions via terminal (requires sudo)
// This generates the command the user can run
ipcMain.handle('get-permission-commands', () => {
    if (process.platform !== 'darwin') {
        return { supported: false };
    }

    const bundleId = 'com.openlink.app';
    const commands = {
        // Screen Recording - add to TCC database
        screenRecording: `sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version) VALUES ('kTCCServiceScreenCapture', '${bundleId}', 0, 2, 0, 1);"`,
        // Accessibility - use tccutil or direct insert
        accessibility: `sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version) VALUES ('kTCCServiceAccessibility', '${bundleId}', 0, 2, 0, 1);"`,
        // All-in-one command
        grantAll: `# Run these commands with sudo to grant OpenLink permissions:
sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version) VALUES ('kTCCServiceScreenCapture', '${bundleId}', 0, 2, 0, 1);"
sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version) VALUES ('kTCCServiceAccessibility', '${bundleId}', 0, 2, 0, 1);"
echo "Permissions granted. Please restart OpenLink."`,
        // Reset permissions (useful if something is stuck)
        reset: `tccutil reset ScreenCapture ${bundleId} && tccutil reset Accessibility ${bundleId}`
    };

    return { supported: true, commands, bundleId };
});

// Try to grant permissions via sudo prompt (requires admin password)
ipcMain.handle('grant-permissions-with-sudo', async () => {
    if (process.platform !== 'darwin') {
        return { success: false, error: 'Only supported on macOS' };
    }

    const { exec } = require('child_process');
    const bundleId = 'com.openlink.app';

    // Use osascript to prompt for admin password and run sqlite3
    const script = `
        do shell script "sqlite3 '/Library/Application Support/com.apple.TCC/TCC.db' \\"INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version) VALUES ('kTCCServiceScreenCapture', '${bundleId}', 0, 2, 0, 1);\\" && sqlite3 '/Library/Application Support/com.apple.TCC/TCC.db' \\"INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version) VALUES ('kTCCServiceAccessibility', '${bundleId}', 0, 2, 0, 1);\\"" with administrator privileges
    `;

    return new Promise((resolve) => {
        exec(`osascript -e '${script}'`, (error, stdout, stderr) => {
            if (error) {
                log.error('Failed to grant permissions:', error);
                // If SIP is enabled, this will fail - guide user to System Settings
                if (stderr.includes('Operation not permitted') || stderr.includes('read-only')) {
                    resolve({
                        success: false,
                        error: 'System Integrity Protection prevents automatic permission granting. Please grant permissions manually in System Settings.',
                        sipEnabled: true
                    });
                } else {
                    resolve({ success: false, error: error.message });
                }
            } else {
                log.info('Permissions granted via sudo');
                resolve({ success: true, message: 'Permissions granted. Please restart OpenLink.' });
            }
        });
    });
});

// Desktop capturer for screen sharing (fixes "Not supported" error)
ipcMain.handle('get-screen-sources', async () => {
    try {
        // Check screen recording permission on macOS
        if (process.platform === 'darwin') {
            const screenPerm = checkMacPermission('screen');
            if (!screenPerm.granted) {
                log.warn('Screen Recording permission not granted, prompting user...');
                const result = await requestMacPermission('screen', true);
                if (!result.granted && !result.openedSettings) {
                    return { error: 'permission_denied', permission: 'screen', status: result.status };
                }
                // If settings were opened, check permission again after a short delay
                if (result.openedSettings) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    const recheckPerm = checkMacPermission('screen');
                    if (!recheckPerm.granted) {
                        return { error: 'permission_pending', permission: 'screen', status: recheckPerm.status,
                                message: 'Permission prompt opened. Please grant permission and try again.' };
                    }
                }
            }
        }

        const sources = await desktopCapturer.getSources({
            types: ['screen', 'window'],
            thumbnailSize: { width: 150, height: 150 }
        });
        return sources.map(source => ({
            id: source.id,
            name: source.name,
            thumbnail: source.thumbnail.toDataURL()
        }));
    } catch (e) {
        log.error('Failed to get screen sources:', e);
        // Check if it's a permission error
        if (e.message && e.message.includes('permission')) {
            return { error: 'permission_denied', permission: 'screen', message: e.message };
        }
        return [];
    }
});

// Get screen reader detection status
ipcMain.handle('detect-screen-reader', async () => {
    if (screenReaderController) {
        const status = screenReaderController.getStatus();
        return {
            detected: status.detectedScreenReader !== null,
            screenReader: status.detectedScreenReader,
            isEnabled: status.isEnabled,
            brltty: status.brltty
        };
    }
    return { detected: false, screenReader: null, isEnabled: false, brltty: { available: false, enabled: false } };
});

// BRLTTY support
ipcMain.handle('enable-brltty', async () => {
    if (screenReaderController) {
        return await screenReaderController.enableBRLTTY();
    }
    return false;
});

ipcMain.handle('disable-brltty', async () => {
    if (screenReaderController) {
        screenReaderController.disableBRLTTY();
        return true;
    }
    return false;
});

ipcMain.handle('send-braille', async (event, text) => {
    if (screenReaderController) {
        return await screenReaderController.braille(text);
    }
    return false;
});

// Settings
ipcMain.handle('get-settings', () => {
    const walletData = {
        walletAddress: store.get('walletAddress'),
        savedWallets: store.get('savedWallets') || [],
        autoConnectWallet: store.get('autoConnectWallet')
    };
    log.info('[Settings] Loading - wallet data:', JSON.stringify(walletData));
    return {
        audioSettings: store.get('audioSettings'),
        clipboardSettings: store.get('clipboardSettings'),
        allowRemoteConnections: store.get('allowRemoteConnections'),
        autoStart: store.get('autoStart'),
        runAtLogin: store.get('runAtLogin'),
        startMinimized: store.get('startMinimized'),
        sharedFilesPath: store.get('sharedFilesPath'),
        recentConnections: store.get('recentConnections'),
        trustedMachines: store.get('trustedMachines'),
        // Host settings - what remote users can access
        shareAudio: store.get('shareAudio'),
        allowInput: store.get('allowInput'),
        allowClipboard: store.get('allowClipboard'),
        allowFiles: store.get('allowFiles'),
        // eCripto integration
        eCriptoEnabled: store.get('eCriptoEnabled'),
        // Wallet settings - CRITICAL for persistence
        walletAddress: store.get('walletAddress'),
        walletNetwork: store.get('walletNetwork'),
        savedWallets: store.get('savedWallets') || [],
        autoConnectWallet: store.get('autoConnectWallet'),
        // Session persistence
        persistSessionId: store.get('persistSessionId'),
        lastSessionId: store.get('lastSessionId'),
        customSessionId: store.get('customSessionId'),
        sessionPassword: store.get('sessionPassword'),
        sessionIdWords: store.get('sessionIdWords'),
        autoHostStartup: store.get('autoHostStartup'),
        // Server selection
        selectedServer: store.get('selectedServer'),
        // Window visibility
        keepWindowVisible: store.get('keepWindowVisible'),
        // Onboarding status
        setupComplete: store.get('setupComplete'),
        onboardingVersion: store.get('onboardingVersion')
    };
});

// Telemetry IPC handlers
ipcMain.handle('telemetry-report', async (event, { type, message, metadata }) => {
    return telemetry.report(type, message, metadata);
});

ipcMain.handle('telemetry-error', async (event, { message, stack, sessionId }) => {
    return telemetry.error(message, { stack, sessionId });
});

ipcMain.handle('telemetry-success', async (event, { message, metadata }) => {
    return telemetry.success(message, metadata);
});

ipcMain.handle('telemetry-event', async (event, { message, metadata }) => {
    return telemetry.event(message, metadata);
});

ipcMain.handle('save-settings', (event, settings) => {
    // Log wallet data being saved
    if (settings.walletAddress !== undefined || settings.savedWallets !== undefined) {
        log.info('[Settings] Saving - wallet:', settings.walletAddress, 'savedWallets count:', (settings.savedWallets || []).length);
    }

    for (const [key, value] of Object.entries(settings)) {
        store.set(key, value);
    }

    // Apply settings
    if (settings.runAtLogin !== undefined) {
        setupAutoStart();
    }

    // Update tray menu to reflect new settings
    updateTrayMenu();

    return true;
});

// Notification service handlers
ipcMain.handle('notification-get-settings', () => {
    if (notificationService) {
        return notificationService.getSettings();
    }
    return { native: { enabled: true }, pushover: { enabled: false }, email: { enabled: false } };
});

ipcMain.handle('notification-save-settings', (event, settings) => {
    if (notificationService) {
        return notificationService.saveSettings(settings);
    }
    return null;
});

ipcMain.handle('notification-send', async (event, options) => {
    if (notificationService) {
        return notificationService.send(options);
    }
    return { error: 'Notification service not initialized' };
});

ipcMain.handle('notification-test-pushover', async () => {
    if (notificationService) {
        return notificationService.testPushover();
    }
    throw new Error('Notification service not initialized');
});

ipcMain.handle('notification-test-email', async () => {
    if (notificationService) {
        return notificationService.testEmail();
    }
    throw new Error('Notification service not initialized');
});

ipcMain.handle('notification-test-sms', async () => {
    if (notificationService) {
        return notificationService.testSMS();
    }
    throw new Error('Notification service not initialized');
});

ipcMain.handle('notification-get-sms-carriers', async () => {
    if (notificationService) {
        return notificationService.getSupportedCarriers();
    }
    return [];
});

// ==================== User Verification IPC Handlers ====================
ipcMain.handle('verification-get-status', () => {
    if (userVerificationService) {
        return userVerificationService.getVerificationStatus();
    }
    return { isVerified: false, methods: {}, primaryMethod: null };
});

ipcMain.handle('verification-send-phone-code', async (event, phoneNumber, carrier) => {
    if (!userVerificationService) {
        throw new Error('Verification service not initialized');
    }
    return userVerificationService.sendPhoneVerificationCode(phoneNumber, carrier);
});

ipcMain.handle('verification-send-email-code', async (event, email) => {
    if (!userVerificationService) {
        throw new Error('Verification service not initialized');
    }
    return userVerificationService.sendEmailVerificationCode(email);
});

ipcMain.handle('verification-verify-code', (event, codeId, inputCode) => {
    if (!userVerificationService) {
        throw new Error('Verification service not initialized');
    }
    return userVerificationService.verifyCode(codeId, inputCode);
});

ipcMain.handle('verification-check-for-link', () => {
    if (userVerificationService) {
        return userVerificationService.requiresVerificationForLink();
    }
    return { required: false };
});

ipcMain.handle('verification-initiate-link', async (event, linkConfig, method, target) => {
    if (!userVerificationService) {
        throw new Error('Verification service not initialized');
    }
    return userVerificationService.initiateLinkCreation(linkConfig, method, target);
});

ipcMain.handle('verification-complete-link', (event, codeId, inputCode) => {
    if (!userVerificationService) {
        throw new Error('Verification service not initialized');
    }
    return userVerificationService.completeLinkCreation(codeId, inputCode);
});

ipcMain.handle('verification-remove', (event, type) => {
    if (userVerificationService) {
        return userVerificationService.removeVerification(type);
    }
    return { success: false };
});

ipcMain.handle('verification-get-carriers', () => {
    if (userVerificationService) {
        return userVerificationService.getSMSCarriers();
    }
    return [];
});

// ==================== v1.7.4+ Feature Gate IPC Handlers ====================

// Feature gate - check feature access
ipcMain.handle('feature-check-access', async (event, feature) => {
    if (featureGateService) {
        return featureGateService.checkAccess(feature);
    }
    return { allowed: true, reason: 'Feature gate not initialized' };
});

// Feature gate - get current tier
ipcMain.handle('feature-get-tier', async () => {
    if (featureGateService) {
        return featureGateService.getCurrentTier();
    }
    return 'free';
});

// Feature gate - get all features
ipcMain.handle('feature-get-all', async () => {
    if (featureGateService) {
        return featureGateService.getAllFeatures();
    }
    return {};
});

// Rate limit - check if action allowed
ipcMain.handle('ratelimit-check', async (event, action) => {
    if (rateLimitService) {
        return rateLimitService.check(action);
    }
    return { allowed: true };
});

// Rate limit - record action
ipcMain.handle('ratelimit-record', async (event, action) => {
    if (rateLimitService) {
        return rateLimitService.record(action);
    }
    return true;
});

// Rate limit - get remaining
ipcMain.handle('ratelimit-get-remaining', async (event, action) => {
    if (rateLimitService) {
        return rateLimitService.getRemaining(action);
    }
    return { remaining: 999 };
});

// Trust score - get current score
ipcMain.handle('trust-get-score', async () => {
    if (trustScoreService) {
        return trustScoreService.getScore();
    }
    return { score: 0, tier: 'none', benefits: [] };
});

// Trust score - refresh from server
ipcMain.handle('trust-refresh', async () => {
    if (trustScoreService) {
        return trustScoreService.refresh();
    }
    return null;
});

// Trust score - get tier benefits
ipcMain.handle('trust-get-benefits', async () => {
    if (trustScoreService) {
        return trustScoreService.getTierBenefits();
    }
    return [];
});

// Alternative payments - get products
ipcMain.handle('payment-get-products', async () => {
    if (alternativePaymentService) {
        return alternativePaymentService.getProducts();
    }
    return [];
});

// Alternative payments - create PayPal order
ipcMain.handle('payment-paypal-create', async (event, productId) => {
    if (alternativePaymentService) {
        return alternativePaymentService.createPayPalOrder(productId);
    }
    throw new Error('Payment service not initialized');
});

// Alternative payments - capture PayPal order
ipcMain.handle('payment-paypal-capture', async (event, orderId) => {
    if (alternativePaymentService) {
        return alternativePaymentService.capturePayPalOrder(orderId);
    }
    throw new Error('Payment service not initialized');
});

// Alternative payments - create Stripe session
ipcMain.handle('payment-stripe-create', async (event, productId) => {
    if (alternativePaymentService) {
        return alternativePaymentService.createStripeSession(productId);
    }
    throw new Error('Payment service not initialized');
});

// Alternative payments - create crypto payment
ipcMain.handle('payment-crypto-create', async (event, productId, currency) => {
    if (alternativePaymentService) {
        return alternativePaymentService.createCryptoPayment(productId, currency);
    }
    throw new Error('Payment service not initialized');
});

// Alternative payments - check payment status
ipcMain.handle('payment-check-status', async (event, paymentId) => {
    if (alternativePaymentService) {
        return alternativePaymentService.checkPaymentStatus(paymentId);
    }
    throw new Error('Payment service not initialized');
});

// Alternative payments - verify access
ipcMain.handle('payment-verify-access', async () => {
    if (alternativePaymentService) {
        return alternativePaymentService.verifyAccess();
    }
    return { hasAccess: false };
});

// Announcements - get relevant announcements
ipcMain.handle('announcements-get', async (event, conditions = []) => {
    if (announcementService) {
        return announcementService.getRelevantAnnouncements(conditions);
    }
    return [];
});

// Announcements - get next announcement
ipcMain.handle('announcements-get-next', async (event, conditions = []) => {
    if (announcementService) {
        return announcementService.getNextAnnouncement(conditions);
    }
    return null;
});

// Announcements - dismiss
ipcMain.handle('announcements-dismiss', async (event, announcementId) => {
    if (announcementService) {
        announcementService.dismiss(announcementId);
        return true;
    }
    return false;
});

// Announcements - should show
ipcMain.handle('announcements-should-show', async () => {
    if (announcementService) {
        return announcementService.shouldShowAnnouncements();
    }
    return false;
});

// ==================== End v1.7.4+ IPC Handlers ====================

// Tray connection state update
ipcMain.handle('update-tray-status', (event, state) => {
    updateTrayConnectionState(state);
    return true;
});

// Record client connection to history
ipcMain.handle('record-client-connection', (event, clientInfo) => {
    const historyEntry = addToConnectionHistory(clientInfo);
    return {
        isReturning: historyEntry.connectionCount > 1,
        connectionCount: historyEntry.connectionCount,
        isTrusted: historyEntry.isTrusted,
        isPersonalDevice: historyEntry.isPersonalDevice
    };
});

// Mark device as trusted/personal
ipcMain.handle('mark-device-trusted', (event, { clientId, trusted }) => {
    markDeviceAsTrusted(clientId, trusted);
    return true;
});

// Get connection history for a client
ipcMain.handle('get-client-history', (event, clientId) => {
    const history = getConnectionHistory();
    return history[clientId] || null;
});

// Get all connection history
ipcMain.handle('get-all-connection-history', () => {
    return getConnectionHistory();
});

// Audio settings
ipcMain.handle('set-remote-volume', (event, volume) => {
    store.set('audioSettings.remoteVolume', volume);
    return true;
});

ipcMain.handle('set-local-volume', (event, volume) => {
    store.set('audioSettings.localVolume', volume);
    return true;
});

ipcMain.handle('set-auto-enable-mic', (event, enabled) => {
    store.set('audioSettings.autoEnableMic', enabled);
    return true;
});

ipcMain.handle('set-always-enable-media', (event, enabled) => {
    store.set('audioSettings.alwaysEnableMedia', enabled);
    return true;
});

// Clipboard
ipcMain.handle('set-clipboard', (event, text) => {
    clipboard.writeText(text);
    lastClipboardText = text;
    lastClipboardTime = Date.now();
    return true;
});

ipcMain.handle('get-clipboard', () => {
    return clipboard.readText();
});

ipcMain.handle('transfer-clipboard', (event, { text, direction }) => {
    // direction: 'local-to-remote' or 'remote-to-local'
    if (direction === 'local-to-remote') {
        // Send to remote via WebRTC
        if (mainWindow) {
            mainWindow.webContents.send('send-to-remote', { type: 'clipboard', text });
        }
    } else {
        // Set local clipboard
        clipboard.writeText(text);
    }
    return true;
});

// File transfer
ipcMain.handle('save-received-file', async (event, { fileName, data, isBase64 }) => {
    const savePath = path.join(store.get('sharedFilesPath'), fileName);

    try {
        const buffer = isBase64 ? Buffer.from(data, 'base64') : Buffer.from(data);
        await fs.promises.writeFile(savePath, buffer);
        log.info(`File saved: ${savePath}`);
        return { success: true, path: savePath };
    } catch (e) {
        log.error(`Failed to save file: ${e.message}`);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('open-shared-folder', () => {
    const folderPath = store.get('sharedFilesPath');
    require('electron').shell.openPath(folderPath);
    return true;
});

// Remote management
ipcMain.handle('remote-management-command', async (event, command, context) => {
    if (remoteManagementService) {
        return await remoteManagementService.handleCommand(command, context);
    }
    return { success: false, error: 'Remote management service not initialized' };
});

ipcMain.handle('remote-management-approval', async (event, approvalId, approved) => {
    if (remoteManagementService) {
        return await remoteManagementService.handleApprovalResponse(approvalId, approved);
    }
    return { success: false, error: 'Remote management service not initialized' };
});

ipcMain.handle('get-ssh-status', async () => {
    if (remoteManagementService) {
        return await remoteManagementService.handleCommand('ssh-status', {});
    }
    return { success: false, error: 'Remote management service not initialized' };
});

ipcMain.handle('enable-ssh', async () => {
    if (remoteManagementService) {
        return await remoteManagementService.handleCommand('enable-ssh', {});
    }
    return { success: false, error: 'Remote management service not initialized' };
});

ipcMain.handle('get-remote-system-info', async () => {
    if (remoteManagementService) {
        return remoteManagementService.handleCommand('get-system-info', {});
    }
    return { success: false, error: 'Remote management service not initialized' };
});

// Remote input
ipcMain.handle('execute-remote-input', async (event, inputData) => {
    // Check accessibility permission on macOS
    if (process.platform === 'darwin') {
        const accessPerm = checkMacPermission('accessibility');
        if (!accessPerm.granted) {
            log.warn('Accessibility permission not granted for remote input');
            // Don't block on first input attempt, just log it
            // The permission prompt will be shown via check-mac-permissions
            // or when the user explicitly requests it
            const result = await requestMacPermission('accessibility', true);
            if (!result.granted && !result.openedSettings) {
                return { error: 'permission_denied', permission: 'accessibility', status: result.status };
            }
        }
    }

    if (hostInputHandler) {
        hostInputHandler.handleInput(inputData);
        return { success: true };
    }
    return { success: false, error: 'no_handler' };
});

// Screen reader
ipcMain.handle('speak-text', (event, text, interrupt = false) => {
    if (screenReaderController) {
        screenReaderController.speak(text, interrupt);
        return true;
    }
    return false;
});

ipcMain.handle('toggle-screen-reader', (event, enabled) => {
    if (screenReaderController) {
        if (enabled) {
            screenReaderController.enableScreenReader();
        } else {
            screenReaderController.disableScreenReader();
        }
        return true;
    }
    return false;
});

// Capslock sync - turn capslock on/off
ipcMain.handle('set-capslock', async (event, state) => {
    const { exec } = require('child_process');

    try {
        if (process.platform === 'darwin') {
            // macOS: Use AppleScript to toggle capslock
            // state=false means turn off, state=true means turn on
            if (!state) {
                // Turn off capslock using AppleScript
                exec(`osascript -e 'tell application "System Events" to key code 57'`);
            }
            return { success: true, platform: 'darwin' };
        } else if (process.platform === 'win32') {
            // Windows: Use PowerShell to simulate capslock key press if needed
            if (!state) {
                // Check current state and toggle if needed
                exec(`powershell -command "[System.Windows.Forms.Control]::IsKeyLocked('CapsLock')"`);
            }
            return { success: true, platform: 'win32' };
        } else {
            // Linux: Use xdotool to toggle capslock
            if (!state) {
                exec('xdotool key Caps_Lock');
            }
            return { success: true, platform: 'linux' };
        }
    } catch (e) {
        log.warn('Failed to set capslock:', e.message);
        return { success: false, error: e.message };
    }
});

// Connection permissions
ipcMain.handle('check-connection-permission', (event, machineId) => {
    const permission = store.get('allowRemoteConnections');
    const trusted = store.get('trustedMachines');

    // Drop-in contacts get instant access (bidirectional trust)
    if (trusted[machineId]?.permission === 'dropin') return 'allow';
    if (trusted[machineId] === 'always') return 'allow';
    if (trusted[machineId] === 'never') return 'deny';
    if (permission === 'always') return 'allow';
    if (permission === 'never') return 'deny';

    return 'ask';
});

ipcMain.handle('set-machine-permission', async (event, machineId, permission, machineInfo = {}) => {
    const trusted = store.get('trustedMachines');

    // For drop-in permission, require confirmation
    if (permission === 'dropin') {
        const { response } = await dialog.showMessageBox({
            type: 'warning',
            title: 'Enable Drop-in Access',
            message: 'Enable drop-in access for this contact?',
            detail: `This allows "${machineInfo.name || machineId}" to connect instantly without asking permission. Only enable this for people you fully trust (family, close friends).\n\nYou can also connect to them instantly when they are hosting.`,
            buttons: ['Cancel', 'Enable Drop-in'],
            defaultId: 0,
            cancelId: 0
        });

        if (response !== 1) {
            return false;
        }

        // Store with full info for drop-in contacts
        trusted[machineId] = {
            permission: 'dropin',
            name: machineInfo.name || `Contact ${machineId.substring(0, 8)}`,
            sessionId: machineInfo.sessionId || null,
            lastSeen: new Date().toISOString()
        };
    } else {
        trusted[machineId] = permission;
    }

    store.set('trustedMachines', trusted);
    updateTrayMenu(); // Update tray to show drop-in contacts
    return true;
});

// Get drop-in contacts for quick access
ipcMain.handle('get-dropin-contacts', () => {
    const trusted = store.get('trustedMachines');
    const dropinContacts = [];

    for (const [machineId, data] of Object.entries(trusted)) {
        if (data?.permission === 'dropin') {
            dropinContacts.push({
                machineId,
                name: data.name,
                sessionId: data.sessionId,
                lastSeen: data.lastSeen
            });
        }
    }

    return dropinContacts;
});

// Update drop-in contact's session ID when they connect
ipcMain.handle('update-dropin-session', (event, machineId, sessionId) => {
    const trusted = store.get('trustedMachines');

    if (trusted[machineId]?.permission === 'dropin') {
        trusted[machineId].sessionId = sessionId;
        trusted[machineId].lastSeen = new Date().toISOString();
        store.set('trustedMachines', trusted);
        updateTrayMenu();
        return true;
    }

    return false;
});

// Connection request dialog
ipcMain.handle('show-connection-request', async (event, { machineId, machineName }) => {
    const { dialog } = require('electron');

    const result = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['Allow', 'Deny', 'Always Allow', 'Always Deny'],
        defaultId: 0,
        title: 'Connection Request',
        message: `${machineName || machineId} wants to connect to your computer.`,
        detail: 'Do you want to allow this connection?'
    });

    switch (result.response) {
        case 0: return { allow: true, remember: false };
        case 1: return { allow: false, remember: false };
        case 2:
            const trusted = store.get('trustedMachines');
            trusted[machineId] = 'always';
            store.set('trustedMachines', trusted);
            return { allow: true, remember: true };
        case 3:
            const trustedDeny = store.get('trustedMachines');
            trustedDeny[machineId] = 'never';
            store.set('trustedMachines', trustedDeny);
            return { allow: false, remember: true };
    }
});

// Generic native dialog
ipcMain.handle('show-native-dialog', async (event, options) => {
    const { dialog } = require('electron');

    const result = await dialog.showMessageBox(mainWindow, {
        type: options.type || 'info',
        buttons: options.buttons || ['OK'],
        defaultId: options.defaultId || 0,
        title: options.title || 'OpenLink',
        message: options.message || '',
        detail: options.detail || ''
    });

    return {
        response: result.response,
        buttonLabel: options.buttons ? options.buttons[result.response] : 'OK'
    };
});

// Show notification
ipcMain.handle('show-notification', (event, { title, body, silent }) => {
    const { Notification } = require('electron');

    if (Notification.isSupported()) {
        const notification = new Notification({
            title: title || 'OpenLink',
            body: body || '',
            silent: silent || false
        });
        notification.show();
        return true;
    }
    return false;
});

// Connection notification with sound
ipcMain.handle('notify-connection', async (event, { type, name, machineId, sessionId }) => {
    const { Notification, shell } = require('electron');
    const { exec } = require('child_process');

    // Map event types to sound files
    const soundMap = {
        'connected': 'connected.wav',
        'dropin-connected': 'dropin.wav',
        'disconnected': 'disconnect.wav',
        'connection-lost': 'connection lost.wav',
        'reconnected': 'reconnected.wav',
        'message': 'message.wav',
        'notification': 'notification.wav',
        'alert': 'alert.wav',
        'error': 'error.wav',
        'hosting-started': 'hosting-started.wav',
        'hosting-stopped': 'hosting-stopped.wav'
    };

    const soundFile = soundMap[type] || 'message.wav';
    // In production, sounds are in extraResources; in dev, they're relative to electron folder
    const soundsPath = app.isPackaged
        ? path.join(process.resourcesPath, 'assets', 'sounds', soundFile)
        : path.join(__dirname, '..', '..', 'assets', 'sounds', soundFile);

    // Play custom sound
    if (process.platform === 'darwin') {
        exec(`afplay "${soundsPath}"`);
    } else if (process.platform === 'win32') {
        // Windows uses powershell to play wav files
        exec(`powershell -c (New-Object Media.SoundPlayer "${soundsPath}").PlaySync()`);
    } else {
        // Linux fallback - try aplay or paplay
        exec(`aplay "${soundsPath}" 2>/dev/null || paplay "${soundsPath}" 2>/dev/null || true`);
    }

    // Show notification
    if (Notification.isSupported()) {
        let title, body;

        switch (type) {
            case 'connected':
                title = 'Connected';
                body = `${name || machineId || 'Someone'} has connected to your computer`;
                break;
            case 'disconnected':
                title = 'Disconnected';
                body = `${name || machineId || 'Remote user'} has disconnected`;
                break;
            case 'dropin-connected':
                title = 'Drop-in Connected';
                body = `${name || 'Trusted contact'} has connected (drop-in access)`;
                break;
            case 'hosting-started':
                title = 'Hosting Started';
                body = `Session ID: ${sessionId || 'Unknown'}`;
                break;
            case 'hosting-stopped':
                title = 'Hosting Stopped';
                body = 'Your hosting session has ended';
                break;
            default:
                title = 'OpenLink';
                body = type || 'Connection event';
        }

        const notification = new Notification({
            title,
            body,
            silent: true  // We play our own sound
        });

        notification.on('click', () => {
            if (mainWindow) {
                mainWindow.show();
                mainWindow.focus();
            }
        });

        notification.show();
    }

    // Update tray connection state
    if (type === 'connected' || type === 'dropin-connected') {
        updateTrayConnectionState({
            isConnected: true,
            connectedTo: name || machineId
        });

        // If this is a drop-in contact, update their session ID
        if (machineId && sessionId) {
            const trusted = store.get('trustedMachines');
            if (trusted[machineId]?.permission === 'dropin') {
                trusted[machineId].sessionId = sessionId;
                trusted[machineId].lastSeen = new Date().toISOString();
                store.set('trustedMachines', trusted);
                updateTrayMenu();
            }
        }
    } else if (type === 'disconnected') {
        updateTrayConnectionState({
            isConnected: false,
            connectedTo: null
        });
    } else if (type === 'hosting-started') {
        updateTrayConnectionState({
            isHosting: true,
            sessionId: sessionId
        });
    } else if (type === 'hosting-stopped') {
        updateTrayConnectionState({
            isHosting: false,
            sessionId: null
        });
    }

    return true;
});

// Session control IPC handlers
ipcMain.handle('session-kick-client', async (event, sessionId, clientConnectionId, reason) => {
    // Send message via WebSocket to signaling server
    if (mainWindow) {
        mainWindow.webContents.send('send-to-remote', {
            type: 'kick-client',
            sessionId,
            clientConnectionId,
            reason: reason || 'Removed by host'
        });
    }

    // Also notify via notification service
    if (notificationService) {
        await notificationService.send({
            title: 'Client Removed',
            message: `A client was removed from your session`,
            priority: 'normal'
        });
    }

    return { success: true, pending: true };
});

ipcMain.handle('session-change-password', async (event, sessionId, password, notifyClients = true) => {
    // Send message via WebSocket to signaling server
    if (mainWindow) {
        mainWindow.webContents.send('send-to-remote', {
            type: 'change-password',
            sessionId,
            password: password || null,
            notifyClients
        });
    }

    // Notify via notification service
    if (notificationService) {
        await notificationService.send({
            title: 'Password Changed',
            message: password ? 'Session password has been updated.' : 'Session password protection removed.',
            priority: 'normal'
        });
    }

    return { success: true, pending: true };
});

ipcMain.handle('session-regenerate-link', async (event, sessionId) => {
    // Send message via WebSocket to signaling server
    if (mainWindow) {
        mainWindow.webContents.send('send-to-remote', {
            type: 'regenerate-link',
            sessionId
        });
    }

    // Notify via notification service
    if (notificationService) {
        await notificationService.send({
            title: 'Link Regenerated',
            message: 'Your session link has been regenerated. The old link will no longer work.',
            priority: 'high'
        });
    }

    return { success: true, pending: true };
});

ipcMain.handle('session-get-clients', async (event, sessionId) => {
    // Send request via WebSocket to signaling server
    if (mainWindow) {
        mainWindow.webContents.send('send-to-remote', {
            type: 'get-clients',
            sessionId
        });
    }
    // The response will come back via WebSocket and be forwarded to renderer
    return { success: true, pending: true };
});

// Monitor service IPC handlers
ipcMain.handle('monitor-get-status', async () => {
    if (!monitorService) return { enabled: false, error: 'Monitor service not available' };
    return monitorService.getStatus();
});

ipcMain.handle('monitor-get-instances', async () => {
    if (!monitorService) return { instances: [], error: 'Monitor service not available' };
    return await monitorService.getInstances();
});

ipcMain.handle('monitor-get-alerts', async () => {
    if (!monitorService) return { alerts: [], error: 'Monitor service not available' };
    return await monitorService.getAlerts();
});

ipcMain.handle('monitor-get-recent-events', async (event, count) => {
    if (!monitorService) return { events: [], error: 'Monitor service not available' };
    return monitorService.getRecentEvents(count);
});

ipcMain.handle('monitor-set-enabled', async (event, enabled) => {
    if (!monitorService) return { success: false, error: 'Monitor service not available' };
    monitorService.setEnabled(enabled);
    store.set('monitoring.enabled', enabled);
    return { success: true, enabled };
});

ipcMain.handle('monitor-set-hub-url', async (event, url) => {
    if (!monitorService) return { success: false, error: 'Monitor service not available' };
    monitorService.setHubUrl(url);
    store.set('monitoring.hubUrl', url);
    return { success: true, hubUrl: url };
});

ipcMain.handle('monitor-send-report', async () => {
    if (!monitorService) return { success: false, error: 'Monitor service not available' };
    await monitorService.sendReport('manual');
    return { success: true };
});

ipcMain.handle('monitor-log-event', async (event, eventType, data) => {
    if (!monitorService) return { success: false, error: 'Monitor service not available' };
    monitorService.logEvent(eventType, data);
    return { success: true };
});

// Confirm dialog (simple yes/no)
ipcMain.handle('confirm-dialog', async (event, { title, message }) => {
    const { dialog } = require('electron');

    const result = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['Yes', 'No'],
        defaultId: 0,
        title: title || 'Confirm',
        message: message
    });

    return result.response === 0;
});

// Recent connections
ipcMain.handle('add-recent-connection', (event, connection) => {
    const recent = store.get('recentConnections');

    // Remove if already exists
    const filtered = recent.filter(c => c.sessionId !== connection.sessionId);

    // Add to front
    filtered.unshift({
        ...connection,
        lastConnected: Date.now()
    });

    // Keep only last 10
    store.set('recentConnections', filtered.slice(0, 10));
    return true;
});

// System info
ipcMain.handle('get-system-info', async () => {
    const networkInterfaces = os.networkInterfaces();
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);

    let localIp = 'Unknown';
    let tailscaleIp = null;
    let tailscaleStatus = 'not_installed'; // 'connected', 'stopped', 'not_installed'

    // Find all IPs including Tailscale
    const candidates = [];
    for (const [name, iface] of Object.entries(networkInterfaces)) {
        for (const config of iface) {
            if (config.family === 'IPv4' && !config.internal) {
                // Check if this is a Tailscale IP (100.x.x.x range)
                if (config.address.startsWith('100.')) {
                    tailscaleIp = config.address;
                    tailscaleStatus = 'connected';
                }
                candidates.push({
                    name,
                    address: config.address,
                    // Prioritize common private network ranges (not Tailscale for local)
                    priority: config.address.startsWith('192.168.') ? 1 :
                              config.address.startsWith('10.') ? 2 :
                              config.address.startsWith('172.') ? 3 :
                              config.address.startsWith('100.') ? 5 : 4  // Tailscale lower priority for local
                });
            }
        }
    }

    // If no Tailscale IP found, check if Tailscale is installed but not connected
    if (!tailscaleIp) {
        try {
            if (process.platform === 'darwin') {
                // macOS: Check if Tailscale app exists
                const fs = require('fs');
                if (fs.existsSync('/Applications/Tailscale.app')) {
                    // Try to get status
                    try {
                        await execAsync('/Applications/Tailscale.app/Contents/MacOS/Tailscale status', { timeout: 3000 });
                        tailscaleStatus = 'stopped'; // Installed but no IP means stopped
                    } catch (e) {
                        // Status command failed - Tailscale is installed but not running
                        tailscaleStatus = 'stopped';
                    }
                }
            } else if (process.platform === 'win32') {
                // Windows: Check for tailscale.exe
                try {
                    await execAsync('where tailscale', { timeout: 3000 });
                    tailscaleStatus = 'stopped';
                } catch {
                    // Not in PATH, check Program Files
                    const fs = require('fs');
                    if (fs.existsSync('C:\\Program Files\\Tailscale\\tailscale.exe') ||
                        fs.existsSync('C:\\Program Files (x86)\\Tailscale\\tailscale.exe')) {
                        tailscaleStatus = 'stopped';
                    }
                }
            } else {
                // Linux: Check for tailscale command
                try {
                    await execAsync('which tailscale', { timeout: 3000 });
                    tailscaleStatus = 'stopped';
                } catch {
                    // Not installed
                }
            }
        } catch {
            // Error checking - assume not installed
        }
    }

    // Sort by priority and pick the best one for local network
    if (candidates.length > 0) {
        candidates.sort((a, b) => a.priority - b.priority);
        localIp = candidates[0].address;
    }

    // Get public IP with multiple fallback services
    let publicIp = null;
    const https = require('https');
    const http = require('http');

    const ipServices = [
        { url: 'https://openlink.tappedin.fm/api/ip', parse: (data) => JSON.parse(data).ip },
        { url: 'https://api.ipify.org?format=json', parse: (data) => JSON.parse(data).ip },
        { url: 'https://ipinfo.io/json', parse: (data) => JSON.parse(data).ip },
        { url: 'https://api.myip.com', parse: (data) => JSON.parse(data).ip },
        { url: 'http://ip-api.com/json', parse: (data) => JSON.parse(data).query, protocol: 'http' }
    ];

    const fetchIp = (service) => {
        return new Promise((resolve) => {
            const protocol = service.protocol === 'http' ? http : https;
            const req = protocol.get(service.url, { timeout: 5000 }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const ip = service.parse(data);
                        if (ip && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
                            resolve(ip);
                        } else {
                            resolve(null);
                        }
                    } catch {
                        resolve(null);
                    }
                });
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
        });
    };

    // Try each service until one succeeds
    for (const service of ipServices) {
        try {
            publicIp = await fetchIp(service);
            if (publicIp) break;
        } catch {
            continue;
        }
    }

    return {
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        release: os.release(),
        localIp: localIp,
        ip: localIp, // Keep for backwards compatibility
        publicIp: publicIp,
        tailscaleIp: tailscaleIp, // Tailscale network IP if available
        tailscaleStatus: tailscaleStatus, // 'connected', 'stopped', or 'not_installed'
        totalMemory: `${Math.round(os.totalmem() / (1024 * 1024 * 1024))} GB`,
        freeMemory: `${Math.round(os.freemem() / (1024 * 1024 * 1024))} GB`,
        cpus: os.cpus().length,
        cpuModel: os.cpus()[0]?.model || 'Unknown',
        screenResolution: (() => {
            const primaryDisplay = screen.getPrimaryDisplay();
            return `${primaryDisplay.size.width}x${primaryDisplay.size.height}`;
        })()
    };
});

// System commands
ipcMain.handle('system-command', (event, command) => {
    const { exec } = require('child_process');

    switch (command) {
        case 'restart':
            if (process.platform === 'win32') {
                exec('shutdown /r /t 5');
            } else if (process.platform === 'darwin') {
                exec('sudo shutdown -r +1');
            } else {
                exec('sudo reboot');
            }
            return true;

        case 'shutdown':
            if (process.platform === 'win32') {
                exec('shutdown /s /t 5');
            } else if (process.platform === 'darwin') {
                exec('sudo shutdown -h +1');
            } else {
                exec('sudo shutdown -h now');
            }
            return true;

        case 'lock':
            if (process.platform === 'win32') {
                exec('rundll32.exe user32.dll,LockWorkStation');
            } else if (process.platform === 'darwin') {
                exec('pmset displaysleepnow');
            } else {
                exec('gnome-screensaver-command -l');
            }
            return true;
    }

    return false;
});

// Window management
ipcMain.handle('minimize-to-tray', () => {
    if (mainWindow) {
        mainWindow.hide();
    }
    return true;
});

ipcMain.handle('show-window', () => {
    if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
    }
    return true;
});

ipcMain.handle('bring-to-front', () => {
    if (mainWindow) {
        if (mainWindow.isMinimized()) {
            mainWindow.restore();
        }
        mainWindow.show();
        mainWindow.focus();
        // On macOS, also bring app to foreground
        if (process.platform === 'darwin') {
            app.focus({ steal: true });
        }
    }
    return true;
});

// App info
ipcMain.handle('get-app-info', () => {
    return {
        version: app.getVersion(),
        name: app.getName(),
        path: app.getPath('exe'),
        userData: app.getPath('userData')
    };
});

// Auto-updater events
autoUpdater.on('update-available', async (info) => {
    if (mainWindow) {
        mainWindow.webContents.send('update-available', info);
    }

    // Generate AI-powered notification if Ollama is available
    if (ollamaService && notificationService) {
        const features = info.releaseNotes ? [] : ['Bug fixes and improvements'];
        const message = await ollamaService.generateUpdateNotification('OpenLink', info.version, features);
        notificationService.send({
            title: 'OpenLink Update Available',
            message: message,
            priority: 'normal'
        });
        log.info(`Update notification sent for version ${info.version}`);
    }
});

autoUpdater.on('update-downloaded', async (info) => {
    log.info(`Update downloaded: version ${info.version}`);

    // Save connection state before updating so we can restore after restart
    const updateState = {
        wasHosting: trayConnectionState.isHosting,
        sessionId: trayConnectionState.sessionId,
        wasConnected: trayConnectionState.isConnected,
        connectedTo: trayConnectionState.connectedTo,
        timestamp: Date.now(),
        fromVersion: app.getVersion(),
        toVersion: info.version
    };
    store.set('pendingUpdateReconnect', updateState);
    log.info('Saved connection state for update reconnection:', updateState);

    // Send update info to renderer with countdown
    if (mainWindow) {
        mainWindow.webContents.send('update-downloaded', {
            ...info,
            countdownSeconds: 10,
            willReconnect: updateState.wasHosting || updateState.wasConnected
        });
    }

    // Generate AI-powered notification for downloaded update
    if (ollamaService && notificationService) {
        const message = await ollamaService.generateEventNotification('update-downloaded', {
            appName: 'OpenLink',
            version: info.version
        });
        const reconnectMsg = updateState.wasHosting || updateState.wasConnected
            ? ' Your session will be restored after update.'
            : '';
        notificationService.send({
            title: 'Update Ready to Install',
            message: message + ' Restarting in 10 seconds...' + reconnectMsg,
            priority: 'high'
        });
        log.info(`Update downloaded notification sent for version ${info.version}`);
    }

    // Auto-restart with countdown
    let countdown = 10;
    const countdownInterval = setInterval(() => {
        countdown--;
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('update-countdown', countdown);
        }
        if (countdown <= 0) {
            clearInterval(countdownInterval);
            log.info('Auto-installing update after countdown');
            // On Windows, use silent install for smoother experience
            const isSilent = process.platform === 'win32';
            autoUpdater.quitAndInstall(isSilent, true); // isForceRunAfter=true
        }
    }, 1000);

    // Store interval so it can be cancelled if user wants to delay
    global.updateCountdownInterval = countdownInterval;
});

ipcMain.handle('install-update', () => {
    // Clear any countdown timer
    if (global.updateCountdownInterval) {
        clearInterval(global.updateCountdownInterval);
    }
    autoUpdater.quitAndInstall(false, true);
});

ipcMain.handle('delay-update', () => {
    // Cancel the auto-restart countdown
    if (global.updateCountdownInterval) {
        clearInterval(global.updateCountdownInterval);
        global.updateCountdownInterval = null;
        log.info('Update countdown cancelled by user');
        return { success: true, message: 'Update delayed. The app will update on next restart.' };
    }
    return { success: false, message: 'No active countdown to cancel' };
});

// ==================== Ollama AI Service ====================

ipcMain.handle('ollama-status', async () => {
    if (ollamaService) {
        const available = await ollamaService.checkAvailability();
        return { ...ollamaService.getStatus(), available };
    }
    return { available: false, model: null, host: 'localhost', port: 11434 };
});

ipcMain.handle('ollama-get-models', async () => {
    if (ollamaService) {
        return await ollamaService.getModels();
    }
    return [];
});

ipcMain.handle('ollama-set-model', (event, model) => {
    if (ollamaService) {
        ollamaService.setModel(model);
        return { success: true };
    }
    return { success: false, error: 'Ollama service not available' };
});

ipcMain.handle('ollama-generate-update-notification', async (event, { appName, version, features }) => {
    if (ollamaService) {
        const message = await ollamaService.generateUpdateNotification(appName, version, features || []);
        return { success: true, message };
    }
    return { success: false, error: 'Ollama service not available' };
});

ipcMain.handle('ollama-generate-event-notification', async (event, { eventType, context }) => {
    if (ollamaService) {
        const message = await ollamaService.generateEventNotification(eventType, context || {});
        return { success: true, message };
    }
    return { success: false, error: 'Ollama service not available' };
});

// ==================== eCripto Integration ====================

ipcMain.handle('ecripto-status', () => {
    if (ecriptoConnector) {
        return ecriptoConnector.getStatus();
    }
    return { initialized: false, connected: false, mode: null, capabilities: [] };
});

ipcMain.handle('ecripto-get-balance', async () => {
    if (ecriptoConnector && ecriptoConnector.hasCapability('balance')) {
        try {
            return await ecriptoConnector.getBalance();
        } catch (e) {
            return { error: e.message };
        }
    }
    return { error: 'Balance not available' };
});

ipcMain.handle('ecripto-send-payment', async (event, options) => {
    if (ecriptoConnector) {
        try {
            return await ecriptoConnector.sendPayment(options);
        } catch (e) {
            return { error: e.message };
        }
    }
    return { error: 'eCripto not available' };
});

ipcMain.handle('ecripto-create-payment-link', async (event, options) => {
    if (ecriptoConnector) {
        try {
            return await ecriptoConnector.createPaymentLink(options);
        } catch (e) {
            return { error: e.message };
        }
    }
    return { error: 'eCripto not available' };
});

ipcMain.handle('ecripto-verify-transaction', async (event, transactionId) => {
    if (ecriptoConnector && ecriptoConnector.hasCapability('verify')) {
        try {
            return await ecriptoConnector.verifyTransaction(transactionId);
        } catch (e) {
            return { error: e.message };
        }
    }
    return { error: 'Verify not available' };
});

ipcMain.handle('ecripto-process-access-payment', async (event, { hostInfo, amount }) => {
    if (ecriptoConnector) {
        try {
            return await ecriptoConnector.processAccessPayment(hostInfo, amount);
        } catch (e) {
            return { error: e.message };
        }
    }
    return { error: 'eCripto not available' };
});

ipcMain.handle('ecripto-generate-receive-address', async (event, options) => {
    if (ecriptoConnector && ecriptoConnector.hasCapability('receive')) {
        try {
            return await ecriptoConnector.generateReceiveAddress(options);
        } catch (e) {
            return { error: e.message };
        }
    }
    return { error: 'Receive not available' };
});

ipcMain.handle('ecripto-get-payment-methods', async () => {
    if (ecriptoConnector) {
        try {
            return await ecriptoConnector.getPaymentMethods();
        } catch (e) {
            return [];
        }
    }
    return [];
});

// ==================== Server Discovery & Relay ====================

let serverDiscovery = null;
let relayHost = null;

// Initialize server discovery on app ready
function initServerDiscovery() {
    try {
        const ServerDiscovery = require('./server-discovery');
        serverDiscovery = new ServerDiscovery();
        serverDiscovery.init(store);
        log.info('Server discovery initialized');
    } catch (e) {
        log.warn('Server discovery not available:', e.message);
    }
}

// Call initialization after app is ready
app.whenReady().then(() => {
    initServerDiscovery();
});

// Server Discovery IPC handlers
ipcMain.handle('get-servers', () => {
    if (serverDiscovery) {
        return serverDiscovery.getAllServers();
    }
    return [];
});

ipcMain.handle('check-server-health', async (event, url) => {
    if (serverDiscovery) {
        return await serverDiscovery.checkServerHealth(url);
    }
    return { status: 'error', error: 'Discovery not available' };
});

ipcMain.handle('get-best-server', async () => {
    if (serverDiscovery) {
        return await serverDiscovery.getBestServer();
    }
    return null;
});

ipcMain.handle('add-server', (event, server) => {
    if (serverDiscovery) {
        return serverDiscovery.addServer(server);
    }
    return { success: false, error: 'Discovery not available' };
});

ipcMain.handle('remove-server', (event, url) => {
    if (serverDiscovery) {
        return serverDiscovery.removeServer(url);
    }
    return { success: false, error: 'Discovery not available' };
});

ipcMain.handle('set-preferred-server', (event, url, preference) => {
    if (serverDiscovery) {
        return serverDiscovery.setPreferredServer(url, preference);
    }
    return { success: false, error: 'Discovery not available' };
});

// Link Validation IPC handlers
let preferredLinkDomain = 'openlink.tappedin.fm'; // Default preferred domain

ipcMain.handle('link-validate', async (event, linkId, serverDomain = preferredLinkDomain) => {
    try {
        const https = require('https');
        const url = `https://${serverDomain}/api/validate/${linkId}`;

        return new Promise((resolve) => {
            const req = https.get(url, { timeout: 5000 }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const result = JSON.parse(data);
                        log.info(`[LinkValidation] Validated ${linkId} on ${serverDomain}: ${result.status}`);
                        resolve(result);
                    } catch (e) {
                        resolve({ linkId, status: 'error', error: 'Invalid response' });
                    }
                });
            });

            req.on('error', (err) => {
                log.warn(`[LinkValidation] Error validating ${linkId}: ${err.message}`);
                resolve({ linkId, status: 'error', error: err.message });
            });

            req.on('timeout', () => {
                req.destroy();
                resolve({ linkId, status: 'timeout', error: 'Request timed out' });
            });
        });
    } catch (e) {
        log.error(`[LinkValidation] Exception: ${e.message}`);
        return { linkId, status: 'error', error: e.message };
    }
});

ipcMain.handle('link-regenerate', async (event, linkId, serverDomain = preferredLinkDomain) => {
    try {
        const https = require('https');
        const url = `https://${serverDomain}/api/regenerate/${linkId}`;

        return new Promise((resolve) => {
            const req = https.request(url, {
                method: 'POST',
                timeout: 5000,
                headers: { 'Content-Type': 'application/json' }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const result = JSON.parse(data);
                        log.info(`[LinkValidation] Regenerated ${linkId} on ${serverDomain}: ${result.status}`);
                        resolve(result);
                    } catch (e) {
                        resolve({ success: false, linkId, error: 'Invalid response' });
                    }
                });
            });

            req.on('error', (err) => {
                log.warn(`[LinkValidation] Error regenerating ${linkId}: ${err.message}`);
                resolve({ success: false, linkId, error: err.message });
            });

            req.on('timeout', () => {
                req.destroy();
                resolve({ success: false, linkId, error: 'Request timed out' });
            });

            req.end();
        });
    } catch (e) {
        log.error(`[LinkValidation] Exception: ${e.message}`);
        return { success: false, linkId, error: e.message };
    }
});

ipcMain.handle('link-ensure-active', async (event, linkId, serverDomain = preferredLinkDomain, options = {}) => {
    const { autoRegenerate = true } = options;

    try {
        // First validate
        const validation = await new Promise((resolve) => {
            const https = require('https');
            const url = `https://${serverDomain}/api/validate/${linkId}`;

            const req = https.get(url, { timeout: 5000 }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        resolve({ status: 'error' });
                    }
                });
            });

            req.on('error', () => resolve({ status: 'error' }));
            req.on('timeout', () => { req.destroy(); resolve({ status: 'timeout' }); });
        });

        // If active, return success
        if (validation.active && validation.hasHost) {
            return { success: true, active: true, regenerated: false, validation };
        }

        // If not active and autoRegenerate is enabled, try to regenerate
        if (autoRegenerate && (validation.status === 'inactive' || validation.status === 'no_host')) {
            const regenResult = await new Promise((resolve) => {
                const https = require('https');
                const url = `https://${serverDomain}/api/regenerate/${linkId}`;

                const req = https.request(url, {
                    method: 'POST',
                    timeout: 5000,
                    headers: { 'Content-Type': 'application/json' }
                }, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        try {
                            resolve(JSON.parse(data));
                        } catch (e) {
                            resolve({ success: false });
                        }
                    });
                });

                req.on('error', () => resolve({ success: false }));
                req.on('timeout', () => { req.destroy(); resolve({ success: false }); });
                req.end();
            });

            log.info(`[LinkValidation] Auto-regenerated ${linkId}: ${regenResult.success}`);
            return { success: regenResult.success, active: false, regenerated: regenResult.success, validation, regeneration: regenResult };
        }

        return { success: false, active: false, regenerated: false, validation };
    } catch (e) {
        log.error(`[LinkValidation] ensureActive error: ${e.message}`);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('link-get-preferred-domain', () => {
    return preferredLinkDomain;
});

ipcMain.handle('link-set-preferred-domain', (event, domain) => {
    preferredLinkDomain = domain;
    log.info(`[LinkValidation] Preferred domain set to: ${domain}`);
    return { success: true, domain };
});

// Relay Host IPC handlers
ipcMain.handle('start-relay-host', async (event, options = {}) => {
    if (!serverDiscovery) {
        return { success: false, error: 'Server discovery not available' };
    }

    try {
        const ServerDiscovery = require('./server-discovery');
        relayHost = new ServerDiscovery.RelayServerHost(serverDiscovery);

        // Apply configuration if provided
        if (options.hostName) relayHost.config.hostName = options.hostName;
        if (options.isPublic !== undefined) relayHost.config.isPublic = options.isPublic;

        const result = await relayHost.start(options);

        // Notify renderer of status change
        if (mainWindow) {
            mainWindow.webContents.send('relay-status-changed', relayHost.getStatus());
        }

        log.info(`Relay host started on port ${result.port}`);
        return { success: true, ...result };
    } catch (e) {
        log.error('Failed to start relay host:', e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('stop-relay-host', () => {
    if (relayHost) {
        relayHost.stop();
        const status = relayHost.getStatus();
        relayHost = null;

        if (mainWindow) {
            mainWindow.webContents.send('relay-status-changed', { running: false });
        }

        log.info('Relay host stopped');
        return { success: true };
    }
    return { success: false, error: 'No relay host running' };
});

ipcMain.handle('get-relay-status', () => {
    if (relayHost) {
        return relayHost.getStatus();
    }
    return { running: false };
});

ipcMain.handle('get-relay-config', () => {
    if (relayHost) {
        return relayHost.getConfig();
    }
    return null;
});

// Relay authentication configuration
ipcMain.handle('set-relay-pin', (event, pin) => {
    if (relayHost) {
        return relayHost.setPinCode(pin);
    }
    return { success: false, error: 'No relay host running' };
});

ipcMain.handle('set-relay-password', (event, password) => {
    if (relayHost) {
        return relayHost.setPassword(password);
    }
    return { success: false, error: 'No relay host running' };
});

ipcMain.handle('enable-relay-2fa', () => {
    if (relayHost) {
        return relayHost.enable2FA();
    }
    return { success: false, error: 'No relay host running' };
});

ipcMain.handle('set-relay-public', () => {
    if (relayHost) {
        return relayHost.setPublic();
    }
    return { success: false, error: 'No relay host running' };
});

ipcMain.handle('set-relay-private', () => {
    if (relayHost) {
        return relayHost.setPrivate();
    }
    return { success: false, error: 'No relay host running' };
});

ipcMain.handle('set-relay-hostname', (event, name) => {
    if (relayHost) {
        relayHost.config.hostName = name;
        return { success: true };
    }
    return { success: false, error: 'No relay host running' };
});

// Client-side server authentication
ipcMain.handle('authenticate-server', async (event, url, auth) => {
    // This would be used by the client to authenticate with a remote server
    // The actual WebSocket connection and auth is handled in the renderer
    return { success: true, note: 'Authentication handled by WebSocket in renderer' };
});

// ==================== Host Trust & Reporting ====================

let hostTrustManager = null;

// Initialize trust manager
function initHostTrustManager() {
    try {
        const ServerDiscovery = require('./server-discovery');
        hostTrustManager = new ServerDiscovery.HostTrustManager();
        log.info('Host trust manager initialized');
    } catch (e) {
        log.warn('Host trust manager not available:', e.message);
    }
}

// Call initialization after app is ready
app.whenReady().then(() => {
    initHostTrustManager();
});

// Report a host as untrusted
ipcMain.handle('report-host', async (event, hostUrl, reason) => {
    if (!hostTrustManager) {
        return { success: false, error: 'Trust manager not available' };
    }

    try {
        // Get machine ID for reporter identification
        const machineId = store.get('machineId') || require('crypto').randomBytes(16).toString('hex');
        if (!store.get('machineId')) {
            store.set('machineId', machineId);
        }

        const result = await hostTrustManager.reportHost(hostUrl, machineId, reason);

        // Notify renderer if host was banned
        if (result.actionTaken === 'banned_and_alerted' && mainWindow) {
            mainWindow.webContents.send('host-banned', {
                hostUrl,
                totalReports: result.totalReports
            });
        }

        log.info(`Host reported: ${hostUrl}, reason: ${reason}`);
        return result;
    } catch (e) {
        log.error('Failed to report host:', e);
        return { success: false, error: e.message };
    }
});

// Check if a host is banned
ipcMain.handle('check-host-ban-status', async (event, hostUrl) => {
    if (!hostTrustManager) {
        return { banned: false, error: 'Trust manager not available' };
    }

    try {
        return await hostTrustManager.checkHostBanStatus(hostUrl);
    } catch (e) {
        return { banned: false, error: e.message };
    }
});

// Get report count for a host
ipcMain.handle('get-host-report-count', async (event, hostUrl) => {
    if (!hostTrustManager) {
        return 0;
    }

    try {
        return await hostTrustManager.getHostReportCount(hostUrl);
    } catch (e) {
        return 0;
    }
});

// ==================== Windows Hotkey Management ====================

// Disable Win+L when remote session starts (Windows client connecting to remote)
ipcMain.handle('disable-win-lock', async () => {
    if (windowsHotkeyManager) {
        return await windowsHotkeyManager.disableWinL();
    }
    return { success: false, error: 'Hotkey manager not available' };
});

// Re-enable Win+L when remote session ends
ipcMain.handle('enable-win-lock', async () => {
    if (windowsHotkeyManager) {
        return await windowsHotkeyManager.enableWinL();
    }
    return { success: false, error: 'Hotkey manager not available' };
});

// Get current Win+L state
ipcMain.handle('get-win-lock-state', () => {
    if (windowsHotkeyManager) {
        return windowsHotkeyManager.getState();
    }
    return { platform: process.platform, isWindows: process.platform === 'win32', winLDisabled: false };
});

// ==================== DVCKeyboard IPC Handlers ====================

// DVCKeyboard open/close/toggle
ipcMain.handle('dvc-keyboard-open', () => {
    if (dvcKeyboard) {
        return dvcKeyboard.open();
    }
    return false;
});

ipcMain.handle('dvc-keyboard-close', () => {
    if (dvcKeyboard) {
        return dvcKeyboard.close();
    }
    return false;
});

ipcMain.handle('dvc-keyboard-toggle', () => {
    if (dvcKeyboard) {
        return dvcKeyboard.toggle();
    }
    return false;
});

// DVCKeyboard state and mode
ipcMain.handle('dvc-keyboard-get-state', () => {
    if (dvcKeyboard) {
        return dvcKeyboard.getState();
    }
    return { isOpen: false, mode: 'text', buffer: '', macroCount: 0 };
});

ipcMain.handle('dvc-keyboard-set-mode', (event, mode) => {
    if (dvcKeyboard) {
        return dvcKeyboard.setMode(mode);
    }
    return false;
});

// DVCKeyboard input methods
ipcMain.handle('dvc-keyboard-send-text', (event, text) => {
    if (dvcKeyboard) {
        return dvcKeyboard.sendText(text);
    }
    return false;
});

ipcMain.handle('dvc-keyboard-send-key', (event, key) => {
    if (dvcKeyboard) {
        return dvcKeyboard.sendSpecialKey(key);
    }
    return false;
});

ipcMain.handle('dvc-keyboard-send-navigation', (event, direction) => {
    if (dvcKeyboard) {
        return dvcKeyboard.sendNavigation(direction);
    }
    return false;
});

// DVCKeyboard macros
ipcMain.handle('dvc-keyboard-get-macros', () => {
    if (dvcKeyboard) {
        return dvcKeyboard.getMacros();
    }
    return [];
});

ipcMain.handle('dvc-keyboard-execute-macro', (event, macroName) => {
    if (dvcKeyboard) {
        return dvcKeyboard.executeMacro(macroName);
    }
    return false;
});

ipcMain.handle('dvc-keyboard-add-macro', (event, { id, name, keys }) => {
    if (dvcKeyboard) {
        return dvcKeyboard.addMacro(id, name, keys);
    }
    return false;
});

// ==================== Incremental Updater ====================

ipcMain.handle('incremental-check-updates', async () => {
    return incrementalUpdater.checkForUpdates();
});

ipcMain.handle('incremental-apply-updates', async () => {
    return incrementalUpdater.applyUpdates();
});

ipcMain.handle('incremental-get-state', () => {
    return incrementalUpdater.getState();
});

ipcMain.handle('incremental-set-hot-reload', (event, enabled) => {
    incrementalUpdater.setHotReload(enabled);
    return true;
});

// Listen for incremental update events and forward to renderer
incrementalUpdater.on('checking', () => {
    if (mainWindow) {
        mainWindow.webContents.send('incremental-checking');
    }
});

incrementalUpdater.on('update-available', (info) => {
    if (mainWindow) {
        mainWindow.webContents.send('incremental-update-available', info);
    }
    log.info(`Incremental update available: ${info.filesCount} files, ${(info.totalBytes / 1024).toFixed(2)} KB`);
});

incrementalUpdater.on('up-to-date', () => {
    if (mainWindow) {
        mainWindow.webContents.send('incremental-up-to-date');
    }
});

incrementalUpdater.on('progress', (progress) => {
    if (mainWindow) {
        mainWindow.webContents.send('incremental-progress', progress);
    }
});

incrementalUpdater.on('update-complete', (result) => {
    if (mainWindow) {
        mainWindow.webContents.send('incremental-update-complete', result);
    }
    log.info(`Incremental update complete: ${result.updatedFiles.length} files updated`);
});

incrementalUpdater.on('error', (error) => {
    if (mainWindow) {
        mainWindow.webContents.send('incremental-error', error.message);
    }
    log.error('Incremental update error:', error);
});

log.info('OpenLink main process loaded');
