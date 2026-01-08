/**
 * OpenLink - Preload Script
 * Exposes secure API to renderer process
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('openlink', {
    // Settings
    getSettings: () => ipcRenderer.invoke('get-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

    // Audio
    setRemoteVolume: (volume) => ipcRenderer.invoke('set-remote-volume', volume),
    setLocalVolume: (volume) => ipcRenderer.invoke('set-local-volume', volume),
    setAutoEnableMic: (enabled) => ipcRenderer.invoke('set-auto-enable-mic', enabled),
    setAlwaysEnableMedia: (enabled) => ipcRenderer.invoke('set-always-enable-media', enabled),

    // Clipboard
    setClipboard: (text) => ipcRenderer.invoke('set-clipboard', text),
    getClipboard: () => ipcRenderer.invoke('get-clipboard'),
    transferClipboard: (data) => ipcRenderer.invoke('transfer-clipboard', data),
    onClipboardChanged: (callback) => ipcRenderer.on('clipboard-changed', (e, data) => callback(data)),
    onClipboardTransfer: (callback) => ipcRenderer.on('clipboard-transfer', (e, data) => callback(data)),

    // File transfer
    saveReceivedFile: (data) => ipcRenderer.invoke('save-received-file', data),
    openSharedFolder: () => ipcRenderer.invoke('open-shared-folder'),

    // Remote input
    executeRemoteInput: (data) => ipcRenderer.invoke('execute-remote-input', data),

    // Screen reader
    speakText: (text, interrupt) => ipcRenderer.invoke('speak-text', text, interrupt),
    toggleScreenReader: (enabled) => ipcRenderer.invoke('toggle-screen-reader', enabled),
    detectScreenReader: () => ipcRenderer.invoke('detect-screen-reader'),

    // Keyboard state sync
    setCapsLock: (state) => ipcRenderer.invoke('set-capslock', state),

    // BRLTTY braille display support
    enableBrltty: () => ipcRenderer.invoke('enable-brltty'),
    disableBrltty: () => ipcRenderer.invoke('disable-brltty'),
    sendBraille: (text) => ipcRenderer.invoke('send-braille', text),

    // Desktop capturer for screen sharing
    getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),

    // macOS permissions
    checkMacPermissions: () => ipcRenderer.invoke('check-mac-permissions'),
    checkMacPermission: (type) => ipcRenderer.invoke('check-mac-permission', type),
    requestMacPermission: (type) => ipcRenderer.invoke('request-mac-permission', type),
    triggerMacPermissionPrompt: (type) => ipcRenderer.invoke('trigger-mac-permission-prompt', type),
    showPermissionSetup: () => ipcRenderer.invoke('show-permission-setup'),
    openPermissionSettings: (type) => ipcRenderer.invoke('open-permission-settings', type),
    getPermissionCommands: () => ipcRenderer.invoke('get-permission-commands'),
    grantPermissionsWithSudo: () => ipcRenderer.invoke('grant-permissions-with-sudo'),

    // Connection permissions
    checkConnectionPermission: (machineId) => ipcRenderer.invoke('check-connection-permission', machineId),
    setMachinePermission: (machineId, permission) => ipcRenderer.invoke('set-machine-permission', machineId, permission),
    showConnectionRequest: (data) => ipcRenderer.invoke('show-connection-request', data),

    // Recent connections
    addRecentConnection: (connection) => ipcRenderer.invoke('add-recent-connection', connection),

    // System info
    getSystemInfo: () => ipcRenderer.invoke('get-system-info'),
    systemCommand: (command) => ipcRenderer.invoke('system-command', command),

    // Window management
    minimizeToTray: () => ipcRenderer.invoke('minimize-to-tray'),
    showWindow: () => ipcRenderer.invoke('show-window'),
    bringToFront: () => ipcRenderer.invoke('bring-to-front'),

    // Tray status updates
    updateTrayStatus: (state) => ipcRenderer.invoke('update-tray-status', state),

    // Connection history and trusted devices
    recordClientConnection: (clientInfo) => ipcRenderer.invoke('record-client-connection', clientInfo),
    markDeviceTrusted: (clientId, trusted) => ipcRenderer.invoke('mark-device-trusted', { clientId, trusted }),
    getClientHistory: (clientId) => ipcRenderer.invoke('get-client-history', clientId),
    getAllConnectionHistory: () => ipcRenderer.invoke('get-all-connection-history'),

    // Connection notifications
    notifyConnection: (data) => ipcRenderer.invoke('notify-connection', data),

    // Drop-in contacts
    getDropinContacts: () => ipcRenderer.invoke('get-dropin-contacts'),
    updateDropinSession: (machineId, sessionId) => ipcRenderer.invoke('update-dropin-session', machineId, sessionId),

    // App info
    getAppInfo: () => ipcRenderer.invoke('get-app-info'),
    installUpdate: () => ipcRenderer.invoke('install-update'),

    // Native dialogs
    showNativeDialog: (options) => ipcRenderer.invoke('show-native-dialog', options),
    showNotification: (options) => ipcRenderer.invoke('show-notification', options),
    confirmDialog: (options) => ipcRenderer.invoke('confirm-dialog', options),

    // Notification service (Pushover, email, native, SMS)
    notifications: {
        getSettings: () => ipcRenderer.invoke('notification-get-settings'),
        saveSettings: (settings) => ipcRenderer.invoke('notification-save-settings', settings),
        send: (options) => ipcRenderer.invoke('notification-send', options),
        testPushover: () => ipcRenderer.invoke('notification-test-pushover'),
        testEmail: () => ipcRenderer.invoke('notification-test-email'),
        testSMS: () => ipcRenderer.invoke('notification-test-sms'),
        getSMSCarriers: () => ipcRenderer.invoke('notification-get-sms-carriers')
    },

    // User verification (SMS/email codes for identity confirmation)
    verification: {
        getStatus: () => ipcRenderer.invoke('verification-get-status'),
        sendPhoneCode: (phoneNumber, carrier) => ipcRenderer.invoke('verification-send-phone-code', phoneNumber, carrier),
        sendEmailCode: (email) => ipcRenderer.invoke('verification-send-email-code', email),
        verifyCode: (codeId, code) => ipcRenderer.invoke('verification-verify-code', codeId, code),
        checkForLink: () => ipcRenderer.invoke('verification-check-for-link'),
        initiateLink: (linkConfig, method, target) => ipcRenderer.invoke('verification-initiate-link', linkConfig, method, target),
        completeLink: (codeId, code) => ipcRenderer.invoke('verification-complete-link', codeId, code),
        remove: (type) => ipcRenderer.invoke('verification-remove', type),
        getCarriers: () => ipcRenderer.invoke('verification-get-carriers')
    },

    // v1.7.4+ Feature gating
    features: {
        checkAccess: (feature) => ipcRenderer.invoke('feature-check-access', feature),
        getTier: () => ipcRenderer.invoke('feature-get-tier'),
        getAll: () => ipcRenderer.invoke('feature-get-all')
    },

    // v1.7.4+ Rate limiting
    rateLimit: {
        check: (action) => ipcRenderer.invoke('ratelimit-check', action),
        record: (action) => ipcRenderer.invoke('ratelimit-record', action),
        getRemaining: (action) => ipcRenderer.invoke('ratelimit-get-remaining', action)
    },

    // v1.7.4+ Trust score
    trust: {
        getScore: () => ipcRenderer.invoke('trust-get-score'),
        refresh: () => ipcRenderer.invoke('trust-refresh'),
        getBenefits: () => ipcRenderer.invoke('trust-get-benefits')
    },

    // v1.7.4+ Alternative payments (PayPal, Stripe, crypto)
    payments: {
        getProducts: () => ipcRenderer.invoke('payment-get-products'),
        paypal: {
            create: (productId) => ipcRenderer.invoke('payment-paypal-create', productId),
            capture: (orderId) => ipcRenderer.invoke('payment-paypal-capture', orderId)
        },
        stripe: {
            create: (productId) => ipcRenderer.invoke('payment-stripe-create', productId)
        },
        crypto: {
            create: (productId, currency) => ipcRenderer.invoke('payment-crypto-create', productId, currency)
        },
        checkStatus: (paymentId) => ipcRenderer.invoke('payment-check-status', paymentId),
        verifyAccess: () => ipcRenderer.invoke('payment-verify-access')
    },

    // v1.7.4+ Announcements (upgrade prompts for non-wallet users)
    announcements: {
        get: (conditions) => ipcRenderer.invoke('announcements-get', conditions),
        getNext: (conditions) => ipcRenderer.invoke('announcements-get-next', conditions),
        dismiss: (announcementId) => ipcRenderer.invoke('announcements-dismiss', announcementId),
        shouldShow: () => ipcRenderer.invoke('announcements-should-show')
    },

    // Event listeners
    onSettingsLoaded: (callback) => ipcRenderer.on('settings-loaded', (e, data) => callback(data)),
    onOpenControlMenu: (callback) => ipcRenderer.on('open-control-menu', () => callback()),
    onUpdateAvailable: (callback) => ipcRenderer.on('update-available', (e, info) => callback(info)),
    onUpdateDownloaded: (callback) => ipcRenderer.on('update-downloaded', (e, info) => callback(info)),
    onUpdateCountdown: (callback) => ipcRenderer.on('update-countdown', (e, seconds) => callback(seconds)),
    onUpdateReconnect: (callback) => ipcRenderer.on('update-reconnect', (e, info) => callback(info)),
    delayUpdate: () => ipcRenderer.invoke('delay-update'),
    onSendToRemote: (callback) => ipcRenderer.on('send-to-remote', (e, data) => callback(data)),
    onSettingsUpdated: (callback) => ipcRenderer.on('settings-updated', (e, data) => callback(data)),
    onQuickConnect: (callback) => ipcRenderer.on('quick-connect', (e, data) => callback(data)),
    onProtocolConnect: (callback) => ipcRenderer.on('protocol-connect', (e, data) => callback(data)),

    // Remove listeners
    removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel)
});

// Session control (host only)
contextBridge.exposeInMainWorld('sessionControl', {
    // Actions
    kickClient: (sessionId, clientConnectionId, reason) =>
        ipcRenderer.invoke('session-kick-client', sessionId, clientConnectionId, reason),
    changePassword: (sessionId, password, notifyClients) =>
        ipcRenderer.invoke('session-change-password', sessionId, password, notifyClients),
    regenerateLink: (sessionId) =>
        ipcRenderer.invoke('session-regenerate-link', sessionId),
    getClients: (sessionId) =>
        ipcRenderer.invoke('session-get-clients', sessionId),

    // Events (when hosting)
    onClientKicked: (callback) => ipcRenderer.on('session-client-kicked', (e, data) => callback(data)),
    onPasswordChanged: (callback) => ipcRenderer.on('session-password-changed', (e, data) => callback(data)),
    onLinkRegenerated: (callback) => ipcRenderer.on('session-link-regenerated', (e, data) => callback(data)),
    onClientsUpdated: (callback) => ipcRenderer.on('session-clients-updated', (e, data) => callback(data)),

    // Events (when connected as client)
    onKicked: (callback) => ipcRenderer.on('session-kicked', (e, data) => callback(data)),
    onHostPasswordChanged: (callback) => ipcRenderer.on('session-host-password-changed', (e, data) => callback(data)),
    onSessionLinkChanged: (callback) => ipcRenderer.on('session-link-changed', (e, data) => callback(data)),

    // Remove listeners
    removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel)
});

// eCripto integration
contextBridge.exposeInMainWorld('ecripto', {
    // Status
    getStatus: () => ipcRenderer.invoke('ecripto-status'),

    // Balance
    getBalance: () => ipcRenderer.invoke('ecripto-get-balance'),

    // Payments
    sendPayment: (options) => ipcRenderer.invoke('ecripto-send-payment', options),
    createPaymentLink: (options) => ipcRenderer.invoke('ecripto-create-payment-link', options),
    verifyTransaction: (transactionId) => ipcRenderer.invoke('ecripto-verify-transaction', transactionId),
    processAccessPayment: (hostInfo, amount) => ipcRenderer.invoke('ecripto-process-access-payment', { hostInfo, amount }),

    // Receiving
    generateReceiveAddress: (options) => ipcRenderer.invoke('ecripto-generate-receive-address', options),

    // Payment methods
    getPaymentMethods: () => ipcRenderer.invoke('ecripto-get-payment-methods')
});

// Also expose platform info
contextBridge.exposeInMainWorld('platform', {
    os: process.platform,
    arch: process.arch,
    version: process.versions,

    // Windows hotkey management (for disabling Win+L during remote sessions)
    // Call disableWinLock() when starting a remote session from Windows
    // Call enableWinLock() when ending the session
    disableWinLock: () => ipcRenderer.invoke('disable-win-lock'),
    enableWinLock: () => ipcRenderer.invoke('enable-win-lock'),
    getWinLockState: () => ipcRenderer.invoke('get-win-lock-state')
});

// Link validation and management
contextBridge.exposeInMainWorld('links', {
    // Validate a link on the server
    validate: (linkId, serverDomain) => ipcRenderer.invoke('link-validate', linkId, serverDomain),

    // Regenerate an expired or invalid link
    regenerate: (linkId, serverDomain) => ipcRenderer.invoke('link-regenerate', linkId, serverDomain),

    // Get current link status with auto-regenerate option
    ensureActive: (linkId, serverDomain, options) => ipcRenderer.invoke('link-ensure-active', linkId, serverDomain, options),

    // Get preferred domain for URL display
    getPreferredDomain: () => ipcRenderer.invoke('link-get-preferred-domain'),

    // Set preferred domain
    setPreferredDomain: (domain) => ipcRenderer.invoke('link-set-preferred-domain', domain)
});

// Server discovery and relay
contextBridge.exposeInMainWorld('servers', {
    // Discovery
    getServers: () => ipcRenderer.invoke('get-servers'),
    checkServerHealth: (url) => ipcRenderer.invoke('check-server-health', url),
    getBestServer: () => ipcRenderer.invoke('get-best-server'),

    // Server management
    addServer: (server) => ipcRenderer.invoke('add-server', server),
    removeServer: (url) => ipcRenderer.invoke('remove-server', url),
    setPreferredServer: (url, preference) => ipcRenderer.invoke('set-preferred-server', url, preference),

    // Relay hosting
    startRelayHost: (options) => ipcRenderer.invoke('start-relay-host', options),
    stopRelayHost: () => ipcRenderer.invoke('stop-relay-host'),
    getRelayStatus: () => ipcRenderer.invoke('get-relay-status'),
    getRelayConfig: () => ipcRenderer.invoke('get-relay-config'),

    // Relay authentication configuration
    setRelayPin: (pin) => ipcRenderer.invoke('set-relay-pin', pin),
    setRelayPassword: (password) => ipcRenderer.invoke('set-relay-password', password),
    enableRelay2FA: () => ipcRenderer.invoke('enable-relay-2fa'),
    setRelayPublic: () => ipcRenderer.invoke('set-relay-public'),
    setRelayPrivate: () => ipcRenderer.invoke('set-relay-private'),
    setRelayHostName: (name) => ipcRenderer.invoke('set-relay-hostname', name),

    // Client-side server authentication
    authenticateServer: (url, auth) => ipcRenderer.invoke('authenticate-server', url, auth),

    // Trust & reporting
    reportHost: (hostUrl, reason) => ipcRenderer.invoke('report-host', hostUrl, reason),
    checkHostBanStatus: (hostUrl) => ipcRenderer.invoke('check-host-ban-status', hostUrl),
    getHostReportCount: (hostUrl) => ipcRenderer.invoke('get-host-report-count', hostUrl),

    // Events
    onServersUpdated: (callback) => ipcRenderer.on('servers-updated', (e, servers) => callback(servers)),
    onRelayStatusChanged: (callback) => ipcRenderer.on('relay-status-changed', (e, status) => callback(status)),
    onAuthRequired: (callback) => ipcRenderer.on('server-auth-required', (e, data) => callback(data)),
    onHostBanned: (callback) => ipcRenderer.on('host-banned', (e, data) => callback(data))
});

// Remote management (enable SSH, run commands on remote PC)
contextBridge.exposeInMainWorld('remoteManagement', {
    // Execute remote management command
    execute: (command, context) => ipcRenderer.invoke('remote-management-command', command, context),

    // Handle approval response
    approveCommand: (approvalId, approved) => ipcRenderer.invoke('remote-management-approval', approvalId, approved),

    // Quick access to common commands
    getSSHStatus: () => ipcRenderer.invoke('get-ssh-status'),
    enableSSH: () => ipcRenderer.invoke('enable-ssh'),
    getRemoteSystemInfo: () => ipcRenderer.invoke('get-remote-system-info'),

    // Events
    onApprovalRequest: (callback) => ipcRenderer.on('remote-management-approval', (e, data) => callback(data)),
    onTriggerRestart: (callback) => ipcRenderer.on('trigger-restart', () => callback()),
    onTriggerUpdate: (callback) => ipcRenderer.on('trigger-update-check', () => callback())
});

// Incremental updater for hot file updates
contextBridge.exposeInMainWorld('incrementalUpdater', {
    // Check for updates
    checkForUpdates: () => ipcRenderer.invoke('incremental-check-updates'),

    // Apply pending updates
    applyUpdates: () => ipcRenderer.invoke('incremental-apply-updates'),

    // Get current update state
    getState: () => ipcRenderer.invoke('incremental-get-state'),

    // Enable/disable hot reload
    setHotReload: (enabled) => ipcRenderer.invoke('incremental-set-hot-reload', enabled),

    // Events
    onChecking: (callback) => ipcRenderer.on('incremental-checking', () => callback()),
    onUpdateAvailable: (callback) => ipcRenderer.on('incremental-update-available', (e, info) => callback(info)),
    onUpToDate: (callback) => ipcRenderer.on('incremental-up-to-date', () => callback()),
    onProgress: (callback) => ipcRenderer.on('incremental-progress', (e, progress) => callback(progress)),
    onUpdateComplete: (callback) => ipcRenderer.on('incremental-update-complete', (e, result) => callback(result)),
    onError: (callback) => ipcRenderer.on('incremental-error', (e, error) => callback(error)),
    onHotUpdate: (callback) => ipcRenderer.on('hot-update-available', () => callback())
});

// Monitor service (hub reporting)
contextBridge.exposeInMainWorld('monitor', {
    // Status
    getStatus: () => ipcRenderer.invoke('monitor-get-status'),
    getInstances: () => ipcRenderer.invoke('monitor-get-instances'),
    getAlerts: () => ipcRenderer.invoke('monitor-get-alerts'),
    getRecentEvents: (count) => ipcRenderer.invoke('monitor-get-recent-events', count),

    // Configuration
    setEnabled: (enabled) => ipcRenderer.invoke('monitor-set-enabled', enabled),
    setHubUrl: (url) => ipcRenderer.invoke('monitor-set-hub-url', url),

    // Manual actions
    sendReport: () => ipcRenderer.invoke('monitor-send-report'),
    logEvent: (eventType, data) => ipcRenderer.invoke('monitor-log-event', eventType, data)
});

// Telemetry service - error and event reporting to server
contextBridge.exposeInMainWorld('telemetry', {
    // Report an error
    error: (message, stack, sessionId) => ipcRenderer.invoke('telemetry-error', { message, stack, sessionId }),

    // Report a success event
    success: (message, metadata) => ipcRenderer.invoke('telemetry-success', { message, metadata }),

    // Report a generic event
    event: (message, metadata) => ipcRenderer.invoke('telemetry-event', { message, metadata }),

    // Report with custom type
    report: (type, message, metadata) => ipcRenderer.invoke('telemetry-report', { type, message, metadata })
});

console.log('OpenLink preload script loaded');
