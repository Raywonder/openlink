/**
 * OpenLink - Main UI Application
 * Handles all UI interactions, WebRTC connections, and feature controls
 */

// State
const state = {
    settings: null,
    isConnected: false,
    isHosting: false,
    sessionId: null,
    connectedTo: null,  // Session ID when connected as client
    peerConnection: null,
    dataChannel: null,
    localStream: null,
    remoteStream: null,
    ws: null,
    currentPanel: 'connect',
    controlMenuOpen: false,
    menuSelectedIndex: 0,
    remoteSystemInfo: null,
    isControlSwapped: false,
    eCriptoAvailable: false,
    eCriptoCapabilities: [],
    eCriptoMode: null,
    // Dialog management - only one at a time
    activeDialog: null,
    dialogQueue: [],
    useNativeDialogs: true,  // Preference for native OS dialogs
    // Connected clients tracking (when hosting)
    connectedClients: [],  // Array of { id, name, device, platform, connectedAt, walletAddress }
    // Connection tracking
    connectionStats: {
        sessionStartTime: null,
        totalSessions: 0,
        activeConnections: 0,
        lastConnectedIP: null,
        lastActivityTime: null,
        connectionHistory: []
    },
    connectionStatsInterval: null
};

// DOM Elements
const elements = {};

// Global error handler - report all errors to telemetry server
window.onerror = function(message, source, lineno, colno, error) {
    const errorInfo = {
        message: message,
        source: source,
        line: lineno,
        column: colno,
        stack: error?.stack || null
    };
    console.error('[GlobalError]', errorInfo);

    // Report to telemetry (if available)
    if (window.telemetry?.error) {
        window.telemetry.error(
            `${message} at ${source}:${lineno}`,
            error?.stack,
            state.sessionId
        ).catch(() => {}); // Silently fail if telemetry unavailable
    }
    return false; // Don't suppress the error
};

// Unhandled promise rejection handler
window.onunhandledrejection = function(event) {
    const error = event.reason;
    const message = error?.message || String(error);
    console.error('[UnhandledRejection]', message, error?.stack);

    // Report to telemetry
    if (window.telemetry?.error) {
        window.telemetry.error(
            `Unhandled Promise: ${message}`,
            error?.stack,
            state.sessionId
        ).catch(() => {});
    }
};

// ==================== Initialization ====================

document.addEventListener('DOMContentLoaded', async () => {
    cacheElements();
    await loadSettings();
    setupEventListeners();

    // Initialize accessible dropdowns for VoiceOver support
    // This replaces native <select> elements with custom accessible listboxes
    if (typeof initAccessibleDropdowns === 'function') {
        state.accessibleDropdowns = initAccessibleDropdowns('select');
        console.log('Accessible dropdowns initialized for VoiceOver compatibility');
    } else {
        // Fallback to basic accessibility setup if component not loaded
        setupDropdownAccessibility();
    }

    checkEcriptoAvailability();
    await detectAndConfigureScreenReader();
    await initializeServers();
    await generateKeyId();
    await detectNetworkInfo();

    // Fetch available domains from API (with fallback to static list)
    await fetchDomainsFromAPI();

    // Initialize verification status
    initializeVerificationStatus();

    announce('OpenLink ready');

    // Start auto-refresh for network info and servers (every 5 minutes)
    startAutoRefresh(5);

    // Start wallet auto-sync if enabled (every 10 minutes)
    if (state.settings?.autoConnectWallet || state.savedWallets?.length > 0) {
        startWalletAutoSync(10);
    }

    // Check for pending reconnection after restart
    checkPendingReconnect();

    // Check macOS permissions on startup
    await checkMacOSPermissionsOnStartup();

    // Auto-host on startup if enabled
    if (state.settings?.autoHostStartup) {
        console.log('[AutoHost] Auto-host on startup is enabled, starting hosting...');
        setTimeout(() => {
            // Use remote server for auto-hosting (not local)
            if (elements.serverSelect && elements.serverSelect.value === 'local') {
                // Set to primary remote server for remote access - use proper wss:// URL format
                const remoteServer = 'wss://openlink.devinecreations.net/ws';
                elements.serverSelect.value = remoteServer;
                // If that option doesn't exist, try adding it
                if (elements.serverSelect.value !== remoteServer) {
                    const option = document.createElement('option');
                    option.value = remoteServer;
                    option.textContent = 'Devine Creations (Primary)';
                    elements.serverSelect.appendChild(option);
                    elements.serverSelect.value = remoteServer;
                }
                console.log('[AutoHost] Switched to remote server:', remoteServer);
            }
            startHosting().catch(e => {
                console.error('[AutoHost] Failed to auto-start hosting:', e);
                announce('Auto-host failed: ' + e.message);
            });
        }, 2000); // Delay to allow full initialization
    }
});

/**
 * Setup accessibility for all dropdown/select elements
 * For VoiceOver compatibility, we DO NOT add custom roles to native select elements
 * Native selects work best with VoiceOver when left alone
 */
function setupDropdownAccessibility() {
    const allSelects = document.querySelectorAll('select');

    allSelects.forEach(select => {
        // IMPORTANT: Do NOT add role="listbox" - this breaks VoiceOver
        // Native <select> elements have implicit semantics that work with screen readers
        // Remove any conflicting roles that may have been added
        if (select.getAttribute('role')) {
            select.removeAttribute('role');
        }

        // Ensure the select has an accessible name via label association
        if (!select.getAttribute('aria-label') && !select.getAttribute('aria-labelledby')) {
            const label = select.previousElementSibling;
            if (label && label.tagName === 'LABEL') {
                // Associate label with select if not already done
                if (!label.getAttribute('for') && select.id) {
                    label.setAttribute('for', select.id);
                }
            }
        }

        // Only add change listener for non-VoiceOver announcements
        // VoiceOver will announce changes natively
        select.addEventListener('change', (e) => {
            const selectedOption = e.target.options[e.target.selectedIndex];
            // Only announce if not using a screen reader (screen readers announce natively)
            if (!state.screenReaderDetected) {
                const label = select.previousElementSibling?.textContent || select.getAttribute('aria-label') || 'Option';
                announce(`${label}: ${selectedOption.text} selected`);
            }
        });
    });

    console.log(`Accessibility setup for ${allSelects.length} dropdown elements (VoiceOver compatible)`);
}

// Check if we need to auto-reconnect after a restart
async function checkPendingReconnect() {
    const reconnectData = localStorage.getItem('openlink-reconnect');
    if (reconnectData) {
        try {
            const data = JSON.parse(reconnectData);

            if (data.waitingForReboot || data.waitingForPeer) {
                // Still waiting for remote - start polling
                announce('Waiting for remote to come back online...');
                showStatus('Waiting for remote to reconnect...', 'info');
                startReconnectPolling();
            } else if (data.reconnect && data.sessionId) {
                // Auto-reconnect after our own restart
                announce('Reconnecting to previous session...');
                showStatus('Reconnecting...', 'info');

                // Small delay to let everything initialize
                setTimeout(() => {
                    initiateConnection(data.sessionId);
                    localStorage.removeItem('openlink-reconnect');
                }, 1000);
            }
        } catch (e) {
            console.error('Failed to parse reconnect data:', e);
            localStorage.removeItem('openlink-reconnect');
        }
    }
}

// Detect screen reader and auto-configure settings
async function detectAndConfigureScreenReader() {
    try {
        const srStatus = await window.openlink.detectScreenReader();
        const statusEl = document.getElementById('sr-detection-status');

        if (srStatus.detected) {
            statusEl.textContent = `Screen reader detected: ${srStatus.screenReader}`;
            // Auto-enable local TTS if screen reader is running
            if (srStatus.isEnabled) {
                elements.useLocalTts.checked = true;
                elements.enableRemoteSr.checked = true;
            }
            state.screenReaderDetected = true;
            state.detectedScreenReader = srStatus.screenReader;
        } else {
            statusEl.textContent = 'No screen reader detected';
            state.screenReaderDetected = false;
        }
    } catch (e) {
        console.warn('Screen reader detection failed:', e);
        document.getElementById('sr-detection-status').textContent = 'Screen reader detection unavailable';
    }
}

function cacheElements() {
    // Toolbar tabs
    elements.tabs = document.querySelectorAll('.toolbar-tab');
    elements.panels = document.querySelectorAll('.panel');

    // Connect panel
    elements.sessionIdInput = document.getElementById('session-id-input');
    elements.serverSelect = document.getElementById('server-select');
    elements.connectBtn = document.getElementById('connect-btn');
    elements.pasteLinkBtn = document.getElementById('paste-link-btn');
    elements.recentConnections = document.getElementById('recent-connections');
    elements.yourKeyId = document.getElementById('your-key-id');
    elements.copyKeyId = document.getElementById('copy-key-id');

    // Host panel
    elements.hostSessionId = document.getElementById('host-session-id');
    elements.copySessionId = document.getElementById('copy-session-id');
    elements.createLinkBtn = document.getElementById('create-link-btn');
    elements.startHostingBtn = document.getElementById('start-hosting-btn');
    elements.stopHostingBtn = document.getElementById('stop-hosting-btn');
    elements.removeLinkBtn = document.getElementById('remove-link-btn');
    elements.connectionPermission = document.getElementById('connection-permission');
    elements.requirePayment = document.getElementById('require-payment');
    elements.paymentSettings = document.getElementById('payment-settings');
    elements.paymentAmount = document.getElementById('payment-amount');

    // Remote view
    elements.remoteView = document.getElementById('remote-view');
    elements.remoteVideo = document.getElementById('remote-video');
    elements.remoteAudio = document.getElementById('remote-audio');
    elements.remoteStatus = document.getElementById('remote-status');

    // Control menu
    elements.controlMenu = document.getElementById('control-menu');
    elements.menuItems = document.querySelectorAll('.menu-items li');
    elements.restartSubmenu = document.getElementById('restart-submenu');
    elements.submenuItems = document.querySelectorAll('.submenu li');

    // Host panel elements
    elements.shareAudio = document.getElementById('share-audio');
    elements.allowInput = document.getElementById('allow-input');
    elements.allowClipboard = document.getElementById('allow-clipboard');
    elements.allowFiles = document.getElementById('allow-files');
    elements.hostRecentConnections = document.getElementById('host-recent-connections');
    elements.persistSessionId = document.getElementById('persist-session-id');
    elements.autoHostStartup = document.getElementById('auto-host-startup');
    elements.customSessionId = document.getElementById('custom-session-id');
    elements.deviceNickname = document.getElementById('device-nickname');
    elements.sessionPassword = document.getElementById('session-password');
    elements.regeneratePasswordBtn = document.getElementById('regenerate-password-btn');
    elements.sessionIdWords = document.getElementById('session-id-words');

    // Audio controls (in Settings tab)
    elements.remoteVolume = document.getElementById('remote-volume');
    elements.localVolume = document.getElementById('local-volume');
    elements.remoteVolumeValue = document.getElementById('remote-volume-value');
    elements.localVolumeValue = document.getElementById('local-volume-value');
    elements.autoEnableMic = document.getElementById('auto-enable-mic');
    elements.alwaysEnableMedia = document.getElementById('always-enable-media');

    // App behavior settings (in Settings tab)
    elements.startupVisible = document.getElementById('startup-visible');
    elements.startupMinimized = document.getElementById('startup-minimized');
    elements.closeToTray = document.getElementById('close-to-tray');
    elements.closeQuit = document.getElementById('close-quit');
    elements.autoCopyUrl = document.getElementById('auto-copy-url');
    elements.allowDropin = document.getElementById('allow-dropin');

    // Screen reader settings (in Settings tab)
    elements.useLocalTts = document.getElementById('use-local-tts');
    elements.enableRemoteSr = document.getElementById('enable-remote-sr');
    elements.srRate = document.getElementById('sr-rate');
    elements.srRateValue = document.getElementById('sr-rate-value');

    // Settings
    elements.runAtLogin = document.getElementById('run-at-login');
    elements.startMinimized = document.getElementById('start-minimized');
    elements.keepWindowVisible = document.getElementById('keep-window-visible');
    elements.enableClipboard = document.getElementById('enable-clipboard');
    elements.doubleCopyTransfer = document.getElementById('double-copy-transfer');
    elements.sharedFolderPath = document.getElementById('shared-folder-path');
    elements.ecriptoEnabled = document.getElementById('ecripto-enabled');
    elements.walletAddress = document.getElementById('wallet-address');
    elements.currentVersion = document.getElementById('current-version');

    // Modals
    elements.fileDialog = document.getElementById('file-dialog');
    elements.connectionRequest = document.getElementById('connection-request');
    elements.paymentRequest = document.getElementById('payment-request');

    // Announcer
    elements.announcer = document.getElementById('sr-announcer');

    // Server settings panel elements
    elements.preferRandomServer = document.getElementById('prefer-random-server');
    elements.defaultServer = document.getElementById('default-server');
    elements.activeServerDisplay = document.getElementById('active-server-display');
    elements.serverList = document.getElementById('server-list');
    elements.refreshServersBtn = document.getElementById('refresh-servers-btn');
    elements.testAllServersBtn = document.getElementById('test-all-servers-btn');
    elements.customServerUrl = document.getElementById('custom-server-url');
    elements.customServerName = document.getElementById('custom-server-name');
    elements.addCustomServerBtn = document.getElementById('add-custom-server-btn');

    // Custom link domain elements
    elements.linkDomain = document.getElementById('link-domain');
    elements.customDomainInput = document.getElementById('custom-domain-input');
    elements.addCustomDomainBtn = document.getElementById('add-custom-domain-btn');
    elements.removeCustomDomainBtn = document.getElementById('remove-custom-domain-btn');

    // Wallet elements
    elements.walletNetwork = document.getElementById('wallet-network');
    elements.detectWalletsBtn = document.getElementById('detect-wallets-btn');
    elements.scanNetworkBtn = document.getElementById('scan-network-btn');
    elements.connectBrowserWalletBtn = document.getElementById('connect-browser-wallet-btn');
    elements.detectedWalletsSection = document.getElementById('detected-wallets-section');
    elements.detectedWalletsList = document.getElementById('detected-wallets-list');
    elements.savedWalletsList = document.getElementById('saved-wallets-list');
    elements.newWalletAddress = document.getElementById('new-wallet-address');
    elements.newWalletLabel = document.getElementById('new-wallet-label');
    elements.addWalletBtn = document.getElementById('add-wallet-btn');
    elements.autoConnectWallet = document.getElementById('auto-connect-wallet');
    elements.ecriptoNetworkStatus = document.getElementById('ecripto-network-status');
}

async function loadSettings() {
    try {
        state.settings = await window.openlink.getSettings();
        applySettings();

        const appInfo = await window.openlink.getAppInfo();
        elements.currentVersion.textContent = appInfo.version;
        document.getElementById('app-version').textContent = `v${appInfo.version}`;
        const helpVersion = document.getElementById('help-version');
        if (helpVersion) helpVersion.textContent = appInfo.version;

        // Initialize server list and key ID
        await initializeServers();
        await generateKeyId();

        // Check for first-time setup
        if (!state.settings.setupComplete) {
            showOnboarding();
        }
    } catch (e) {
        console.error('Failed to load settings:', e);
    }
}

/**
 * Show the first-time onboarding dialog
 */
function showOnboarding() {
    const modal = document.getElementById('onboarding-modal');
    if (!modal) return;

    // Show modal
    modal.hidden = false;
    modal.removeAttribute('aria-hidden');
    modal.removeAttribute('inert');

    // Setup complete button handler
    const completeBtn = document.getElementById('complete-onboarding');
    completeBtn.onclick = async () => {
        // Gather settings from onboarding form
        const settings = {
            shareAudio: document.getElementById('onboard-share-audio').checked,
            allowInput: document.getElementById('onboard-allow-input').checked,
            allowClipboard: document.getElementById('onboard-allow-clipboard').checked,
            allowFiles: document.getElementById('onboard-allow-files').checked,
            allowRemoteConnections: document.getElementById('onboard-connection-permission').value,
            setupComplete: true,
            onboardingVersion: 1
        };

        // Save settings
        await window.openlink.saveSettings(settings);

        // Update local state
        state.settings = { ...state.settings, ...settings };
        applySettings();

        // Hide modal
        modal.hidden = true;
        modal.setAttribute('aria-hidden', 'true');
        modal.setAttribute('inert', '');

        // Announce completion
        announce('Setup complete. Welcome to OpenLink!');
    };

    // Focus the first checkbox
    document.getElementById('onboard-share-audio').focus();
    announce('Welcome to OpenLink. Please configure your sharing preferences.');
}

/**
 * Initialize server list dropdown
 */
async function initializeServers() {
    try {
        const servers = await window.servers.getServers();
        const select = elements.serverSelect;

        // Clear existing custom options (keep local and random)
        while (select.options.length > 2) {
            select.remove(2);
        }

        // Add servers from discovery
        servers.forEach(server => {
            const option = document.createElement('option');
            option.value = server.url;
            option.textContent = `${server.name || server.url} ${server.status === 'online' ? '' : '(offline)'}`;
            select.appendChild(option);
        });

        state.servers = servers;
    } catch (e) {
        console.warn('Server discovery not available:', e);
    }
}

/**
 * Generate and display OpenLink key ID
 */
async function generateKeyId() {
    try {
        const systemInfo = await window.openlink.getSystemInfo();
        // Generate a simple key ID based on hostname and a hash
        const hostname = systemInfo.hostname || 'unknown';
        const keyId = `openlink.${hostname.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
        state.keyId = keyId;

        if (elements.yourKeyId) {
            elements.yourKeyId.textContent = keyId;
        }
    } catch (e) {
        console.warn('Failed to generate key ID:', e);
        if (elements.yourKeyId) {
            elements.yourKeyId.textContent = 'Unable to generate';
        }
    }
}

/**
 * Fetch public IP with multiple fallback services
 */
async function fetchPublicIpWithFallbacks() {
    const ipServices = [
        { url: 'https://openlink.tappedin.fm/api/ip', parse: (data) => data.ip },
        { url: 'https://api.ipify.org?format=json', parse: (data) => data.ip },
        { url: 'https://ipinfo.io/json', parse: (data) => data.ip },
        { url: 'https://api.myip.com', parse: (data) => data.ip }
    ];

    for (const service of ipServices) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            const response = await fetch(service.url, { signal: controller.signal });
            clearTimeout(timeout);
            const data = await response.json();
            const ip = service.parse(data);
            if (ip && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
                return ip;
            }
        } catch {
            continue;
        }
    }
    return null;
}

/**
 * Detect and display network information
 */
async function detectNetworkInfo() {
    try {
        const systemInfo = await window.openlink.getSystemInfo();

        // Display local IP
        const localIpEl = document.getElementById('local-ip');
        if (localIpEl && systemInfo.localIp) {
            localIpEl.textContent = systemInfo.localIp;
            state.localIp = systemInfo.localIp;
        }

        // Save Tailscale IP if available
        if (systemInfo.tailscaleIp) {
            state.tailscaleIp = systemInfo.tailscaleIp;
        }

        // Display public IP if available
        const publicIpEl = document.getElementById('public-ip');
        if (publicIpEl) {
            if (systemInfo.publicIp) {
                publicIpEl.textContent = systemInfo.publicIp;
                state.publicIp = systemInfo.publicIp;
            } else {
                // Try to fetch public IP using multiple fallback services
                const ip = await fetchPublicIpWithFallbacks();
                if (ip) {
                    publicIpEl.textContent = ip;
                    state.publicIp = ip;
                } else {
                    publicIpEl.textContent = 'Unable to detect';
                }
            }
        }

        // Server detected IP (what our relay server sees)
        const serverDetectedEl = document.getElementById('server-detected-ip');
        if (serverDetectedEl) {
            try {
                const servers = await window.servers.getServers();
                const onlineServer = servers.find(s => s.status === 'online');
                if (onlineServer) {
                    // Ping the server to get detected IP
                    const healthCheck = await window.servers.checkServerHealth(onlineServer.url);
                    if (healthCheck && healthCheck.clientIp) {
                        serverDetectedEl.textContent = healthCheck.clientIp;
                        state.serverDetectedIp = healthCheck.clientIp;
                    } else {
                        serverDetectedEl.textContent = state.publicIp || 'Unknown';
                    }
                } else {
                    serverDetectedEl.textContent = 'No server available';
                }
            } catch (e) {
                serverDetectedEl.textContent = 'Unable to check';
            }
        }

        // Setup copy button for public IP
        const copyPublicIpBtn = document.getElementById('copy-public-ip');
        if (copyPublicIpBtn && !copyPublicIpBtn.dataset.listenerAdded) {
            copyPublicIpBtn.dataset.listenerAdded = 'true';
            copyPublicIpBtn.addEventListener('click', () => {
                if (state.publicIp) {
                    window.openlink.setClipboard(state.publicIp);
                    announce('Public IP copied to clipboard');
                }
            });
        }
    } catch (e) {
        console.warn('Network detection failed:', e);
    }
}

/**
 * Auto-refresh network info and servers periodically
 * Keeps IP addresses in sync for non-static IPs
 */
let autoRefreshInterval = null;

function startAutoRefresh(intervalMinutes = 5) {
    if (autoRefreshInterval) {
        clearInterval(autoRefreshInterval);
    }

    const intervalMs = intervalMinutes * 60 * 1000;

    autoRefreshInterval = setInterval(async () => {
        console.log('Auto-refreshing network info and servers...');

        // Refresh network info
        const oldPublicIp = state.publicIp;
        await detectNetworkInfo();

        // Check if IP changed and update hosting URL if needed
        if (state.publicIp !== oldPublicIp && state.isHosting) {
            console.log('Public IP changed, updating hosting URL...');
            updateHostingUrlDisplay();
        }

        // Refresh servers
        await initializeServers();

        // Update server list in Servers panel if visible
        if (state.currentPanel === 'servers') {
            await renderServerList();
        }
    }, intervalMs);

    console.log(`Auto-refresh started: every ${intervalMinutes} minutes`);
}

function stopAutoRefresh() {
    if (autoRefreshInterval) {
        clearInterval(autoRefreshInterval);
        autoRefreshInterval = null;
        console.log('Auto-refresh stopped');
    }
}

/**
 * Update the hosting URL display with current server info
 */
function updateHostingUrlDisplay() {
    if (!state.sessionId) return;

    const serverUrl = getSignalingServerUrl();
    const isLocalServer = serverUrl === 'ws://localhost:8765';

    // Update the current OpenLink URL display
    const container = document.getElementById('current-link-info');
    const urlEl = document.getElementById('current-openlink-url');
    const typeEl = document.getElementById('current-link-type');

    if (container && urlEl) {
        container.hidden = false;

        if (isLocalServer) {
            // For local server, show direct connection info
            const directUrl = `ws://${state.localIp || 'localhost'}:8765/${state.sessionId}`;
            urlEl.textContent = directUrl;
            if (typeEl) typeEl.textContent = 'Local';
        } else {
            // For remote server, show the relay URL
            const serverHost = serverUrl.replace(/^wss?:\/\//, '').replace(/:\d+$/, '');
            const remoteUrl = `https://${serverHost}/${state.sessionId}`;
            urlEl.textContent = remoteUrl;
            if (typeEl) typeEl.textContent = 'Remote Relay';
        }
    }
}

/**
 * Display full system information in the Host tab
 */
async function displaySystemInfo() {
    try {
        const systemInfo = await window.openlink.getSystemInfo();

        // Platform display with friendly names
        const platformNames = {
            'darwin': 'macOS',
            'win32': 'Windows',
            'linux': 'Linux'
        };
        const platformEl = document.getElementById('sys-platform');
        if (platformEl) {
            platformEl.textContent = platformNames[systemInfo.platform] || systemInfo.platform;
        }

        const releaseEl = document.getElementById('sys-release');
        if (releaseEl) {
            releaseEl.textContent = systemInfo.release || 'Unknown';
        }

        const archEl = document.getElementById('sys-arch');
        if (archEl) {
            const archNames = { 'x64': 'x64 (64-bit)', 'arm64': 'ARM64 (Apple Silicon)', 'x86': 'x86 (32-bit)' };
            archEl.textContent = archNames[systemInfo.arch] || systemInfo.arch;
        }

        const hostnameEl = document.getElementById('sys-hostname');
        if (hostnameEl) {
            hostnameEl.textContent = systemInfo.hostname || 'Unknown';
        }

        const hostLocalIpEl = document.getElementById('host-local-ip');
        if (hostLocalIpEl) {
            hostLocalIpEl.textContent = systemInfo.localIp || 'Unknown';
        }

        const hostPublicIpEl = document.getElementById('host-public-ip');
        if (hostPublicIpEl) {
            hostPublicIpEl.textContent = systemInfo.publicIp || 'Detecting...';
            // Try to get public IP if not available using fallback services
            if (!systemInfo.publicIp) {
                const ip = await fetchPublicIpWithFallbacks();
                if (ip) {
                    hostPublicIpEl.textContent = ip;
                    state.publicIp = ip;
                } else {
                    hostPublicIpEl.textContent = 'Unable to detect';
                }
            }
        }

        // Tailscale IP display with status indicator
        const hostTailscaleIpEl = document.getElementById('host-tailscale-ip');
        const directIpSelectEl = document.getElementById('direct-ip-select');
        const tailscaleOption = directIpSelectEl?.querySelector('option[value="tailscale"]');

        if (hostTailscaleIpEl) {
            if (systemInfo.tailscaleIp) {
                hostTailscaleIpEl.textContent = systemInfo.tailscaleIp;
                hostTailscaleIpEl.classList.remove('warning', 'disabled');
                hostTailscaleIpEl.classList.add('connected');
                state.tailscaleIp = systemInfo.tailscaleIp;
                state.tailscaleStatus = 'connected';
                // Enable Tailscale option in dropdown
                if (tailscaleOption) {
                    tailscaleOption.disabled = false;
                    tailscaleOption.textContent = 'Tailscale';
                }
            } else if (systemInfo.tailscaleStatus === 'stopped') {
                hostTailscaleIpEl.textContent = 'Stopped (start Tailscale)';
                hostTailscaleIpEl.classList.remove('connected', 'disabled');
                hostTailscaleIpEl.classList.add('warning');
                state.tailscaleStatus = 'stopped';
                // Disable Tailscale option with helpful message
                if (tailscaleOption) {
                    tailscaleOption.disabled = true;
                    tailscaleOption.textContent = 'Tailscale (stopped)';
                }
            } else {
                hostTailscaleIpEl.textContent = 'Not installed';
                hostTailscaleIpEl.classList.remove('connected', 'warning');
                hostTailscaleIpEl.classList.add('disabled');
                state.tailscaleStatus = 'not_installed';
                // Disable Tailscale option
                if (tailscaleOption) {
                    tailscaleOption.disabled = true;
                    tailscaleOption.textContent = 'Tailscale (not installed)';
                }
            }
        }

        const screenEl = document.getElementById('sys-screen');
        if (screenEl) {
            screenEl.textContent = systemInfo.screenResolution || 'Unknown';
        }

        // Check eCripto status
        const ecriptoStatusEl = document.getElementById('ecripto-status');
        if (ecriptoStatusEl) {
            if (state.settings && state.settings.eCriptoEnabled) {
                ecriptoStatusEl.textContent = 'Connected';
                ecriptoStatusEl.classList.add('connected');
            } else {
                ecriptoStatusEl.textContent = 'Not Connected';
                ecriptoStatusEl.classList.remove('connected');
            }
        }

        // Copy current link button
        const copyCurrentLinkBtn = document.getElementById('copy-current-link');
        if (copyCurrentLinkBtn) {
            copyCurrentLinkBtn.addEventListener('click', () => {
                const urlEl = document.getElementById('current-openlink-url');
                if (urlEl && urlEl.textContent !== 'None') {
                    window.openlink.setClipboard(urlEl.textContent);
                    announce('OpenLink URL copied to clipboard');
                }
            });
        }

    } catch (e) {
        console.warn('System info display failed:', e);
    }
}

/**
 * Update the current OpenLink URL display when hosting
 */
function updateCurrentLinkDisplay(url, type, expiry) {
    const container = document.getElementById('current-link-info');
    const urlEl = document.getElementById('current-openlink-url');
    const typeEl = document.getElementById('current-link-type');
    const expiryEl = document.getElementById('current-link-expiry');

    if (url && container) {
        container.hidden = false;
        if (urlEl) urlEl.textContent = url;
        if (typeEl) {
            typeEl.textContent = type || 'Temporary';
            typeEl.className = 'badge badge-' + (type || 'temporary').toLowerCase();
        }
        if (expiryEl) {
            expiryEl.textContent = expiry || 'When session ends';
        }
        state.currentOpenLinkUrl = url;
        state.currentLinkType = type;
    } else if (container) {
        container.hidden = true;
        if (urlEl) urlEl.textContent = 'None';
        if (typeEl) typeEl.textContent = '--';
        if (expiryEl) expiryEl.textContent = '--';
    }
}

/**
 * OpenLink domains for shareable URLs
 * This list is a fallback - domains should be fetched from API
 */
const openlinkDomainsFallback = [
    'openlink.tappedin.fm',
    'openlink.raywonderis.me',
    'openlink.devinecreations.net'
];

// API-fetched domains will be stored here
let openlinkDomains = [...openlinkDomainsFallback];
let openlinkDomainConfig = {
    domains: [],
    primary: 'openlink.tappedin.fm',
    fallbackToPublicIp: true,
    lastFetched: null
};

/**
 * Fetch available domains from API
 * Returns validated domains for link generation
 */
async function fetchDomainsFromAPI() {
    const apiEndpoints = [
        'https://openlink.tappedin.fm:8765/api/domains',
        'https://openlink.raywonderis.me:8765/api/domains',
        'https://openlink.devinecreations.net:8765/api/domains'
    ];

    for (const endpoint of apiEndpoints) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);

            const response = await fetch(endpoint, {
                signal: controller.signal,
                headers: { 'Accept': 'application/json' }
            });
            clearTimeout(timeout);

            if (response.ok) {
                const data = await response.json();
                if (data.success && data.domains && data.domains.length > 0) {
                    // Update global config
                    openlinkDomainConfig = {
                        domains: data.domains,
                        primary: data.primary || data.domains[0]?.domain,
                        fallbackToPublicIp: data.fallbackToPublicIp !== false,
                        lastFetched: new Date().toISOString()
                    };

                    // Update domains list (just the domain strings)
                    openlinkDomains = data.domains.map(d => d.domain);

                    console.log('[Domains] Fetched', openlinkDomains.length, 'domains from API:', openlinkDomains);

                    // Update the dropdown
                    updateLinkDomainDropdown();

                    return openlinkDomainConfig;
                }
            }
        } catch (e) {
            console.warn('[Domains] Failed to fetch from', endpoint, ':', e.message);
        }
    }

    // If all API endpoints fail, use fallback
    console.warn('[Domains] All API endpoints failed, using fallback domains');
    openlinkDomains = [...openlinkDomainsFallback];
    return openlinkDomainConfig;
}

/**
 * Get the primary domain for link generation
 */
function getPrimaryDomain() {
    return openlinkDomainConfig.primary || openlinkDomains[0] || 'openlink.tappedin.fm';
}

/**
 * Check if we should fall back to public IP
 */
function shouldFallbackToPublicIp() {
    return openlinkDomainConfig.fallbackToPublicIp && state.publicIp;
}

/**
 * Get custom link domains from localStorage
 */
function getCustomLinkDomains() {
    try {
        const saved = localStorage.getItem('openlink-custom-domains');
        return saved ? JSON.parse(saved) : [];
    } catch {
        return [];
    }
}

/**
 * Save custom link domains to localStorage
 */
function saveCustomLinkDomains(domains) {
    localStorage.setItem('openlink-custom-domains', JSON.stringify(domains));
}

/**
 * Add a custom link domain
 */
function addCustomLinkDomain(domain) {
    if (!domain || typeof domain !== 'string') return false;

    // Normalize domain
    domain = domain.trim().toLowerCase();
    if (domain.startsWith('https://')) {
        domain = domain.replace('https://', '');
    }
    if (domain.startsWith('http://')) {
        domain = domain.replace('http://', '');
    }
    // Remove trailing slash
    domain = domain.replace(/\/+$/, '');

    if (!domain) return false;

    const customDomains = getCustomLinkDomains();
    if (customDomains.includes(domain) || openlinkDomains.includes(domain)) {
        return false; // Already exists
    }

    customDomains.push(domain);
    saveCustomLinkDomains(customDomains);
    updateLinkDomainDropdown();
    return true;
}

/**
 * Remove a custom link domain
 */
function removeCustomLinkDomain(domain) {
    const customDomains = getCustomLinkDomains();
    const index = customDomains.indexOf(domain);
    if (index > -1) {
        customDomains.splice(index, 1);
        saveCustomLinkDomains(customDomains);
        updateLinkDomainDropdown();
        return true;
    }
    return false;
}

/**
 * Get all available link domains (built-in + custom)
 */
function getAllLinkDomains() {
    return [...openlinkDomains, ...getCustomLinkDomains()];
}

/**
 * Update the link domain dropdown with all available domains
 */
function updateLinkDomainDropdown() {
    const select = document.getElementById('link-domain');
    if (!select) return;

    const currentValue = select.value;
    const customDomains = getCustomLinkDomains();
    const primaryDomain = getPrimaryDomain();

    // Clear existing options
    select.innerHTML = '';

    // Add API-fetched domains first (with primary marked)
    openlinkDomains.forEach((domain) => {
        const option = document.createElement('option');
        option.value = domain;
        const isPrimary = domain === primaryDomain;
        option.textContent = isPrimary ? `${domain} (Primary)` : domain;
        if (isPrimary) {
            option.dataset.primary = 'true';
        }
        select.appendChild(option);
    });

    // Add custom domains with remove option
    if (customDomains.length > 0) {
        const separator = document.createElement('option');
        separator.disabled = true;
        separator.textContent = '--- Custom Domains ---';
        select.appendChild(separator);

        customDomains.forEach(domain => {
            const option = document.createElement('option');
            option.value = domain;
            option.textContent = `${domain} (Custom)`;
            option.dataset.custom = 'true';
            select.appendChild(option);
        });
    }

    // Add public IP fallback option if available
    if (shouldFallbackToPublicIp()) {
        const separator = document.createElement('option');
        separator.disabled = true;
        separator.textContent = '--- Direct IP ---';
        select.appendChild(separator);

        const ipOption = document.createElement('option');
        ipOption.value = `direct:${state.publicIp}`;
        ipOption.textContent = `${state.publicIp} (Public IP Fallback)`;
        ipOption.dataset.directIp = 'true';
        select.appendChild(ipOption);
    }

    // Restore selection if possible
    if (currentValue) {
        const allOptions = Array.from(select.options).map(o => o.value);
        if (allOptions.includes(currentValue)) {
            select.value = currentValue;
        }
    }
}

/**
 * Setup custom domain event handlers
 */
function setupCustomDomainHandlers() {
    // Initialize the dropdown with all domains on load
    updateLinkDomainDropdown();

    // Add custom domain button
    if (elements.addCustomDomainBtn) {
        elements.addCustomDomainBtn.addEventListener('click', () => {
            const domain = elements.customDomainInput?.value?.trim();
            if (domain) {
                const added = addCustomLinkDomain(domain);
                if (added) {
                    elements.customDomainInput.value = '';
                    announce(`Custom domain "${domain}" added`);
                    // Select the newly added domain
                    if (elements.linkDomain) {
                        elements.linkDomain.value = domain.toLowerCase();
                    }
                } else {
                    announce('Domain already exists or is invalid');
                }
            } else {
                announce('Please enter a domain');
            }
        });
    }

    // Allow Enter key to add domain
    if (elements.customDomainInput) {
        elements.customDomainInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                elements.addCustomDomainBtn?.click();
            }
        });
    }

    // Remove custom domain button
    if (elements.removeCustomDomainBtn) {
        elements.removeCustomDomainBtn.addEventListener('click', () => {
            const select = elements.linkDomain;
            if (!select) return;

            const selectedOption = select.options[select.selectedIndex];
            if (selectedOption && selectedOption.dataset.custom === 'true') {
                const domain = selectedOption.value;
                const removed = removeCustomLinkDomain(domain);
                if (removed) {
                    announce(`Custom domain "${domain}" removed`);
                }
            }
        });
    }

    // Show/hide remove button based on selection
    if (elements.linkDomain) {
        elements.linkDomain.addEventListener('change', () => {
            updateRemoveButtonVisibility();
            // Update the active connection URL when domain changes
            if (state.isHosting) {
                updateActiveConnectionUrl();
            }
        });
    }

    // Initial state for remove button
    updateRemoveButtonVisibility();
}

/**
 * Update visibility of the remove custom domain button
 */
function updateRemoveButtonVisibility() {
    const select = elements.linkDomain;
    const removeBtn = elements.removeCustomDomainBtn;
    if (!select || !removeBtn) return;

    const selectedOption = select.options[select.selectedIndex];
    if (selectedOption && selectedOption.dataset.custom === 'true') {
        removeBtn.hidden = false;
    } else {
        removeBtn.hidden = true;
    }
}

/**
 * Generate complex session ID for shareable URLs
 */
function generateComplexSessionId() {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const specialChars = '-_';
    let result = '';

    // Generate 20-24 character complex ID with occasional special chars
    const length = 20 + Math.floor(Math.random() * 5);

    for (let i = 0; i < length; i++) {
        // Add special char every 5-7 characters (but not at start/end)
        if (i > 0 && i < length - 1 && i % (5 + Math.floor(Math.random() * 3)) === 0) {
            result += specialChars[Math.floor(Math.random() * specialChars.length)];
        } else {
            result += chars[Math.floor(Math.random() * chars.length)];
        }
    }

    return result;
}

/**
 * Generate shareable URL with selected domain
 * Now uses subdomain-based URLs: https://sessionId.openlink.domain.com
 * Also supports direct IP fallback when domain is 'direct:IP'
 */
function generateShareableUrl(sessionId, preferredDomain = null) {
    if (!sessionId) {
        sessionId = generateComplexSessionId();
    }

    // Clean session ID for subdomain use (lowercase, no special chars except hyphen)
    const subdomainSafeId = sessionId.toLowerCase().replace(/[^a-z0-9-]/g, '-');

    // Check for direct IP fallback
    if (preferredDomain && preferredDomain.startsWith('direct:')) {
        const ip = preferredDomain.replace('direct:', '');
        const port = 8765; // Default WebSocket port
        const directUrl = `ws://${ip}:${port}/${sessionId}`;

        return {
            url: directUrl,
            pathUrl: directUrl,
            sessionId: sessionId,
            subdomainId: subdomainSafeId,
            domain: ip,
            shortUrl: `${ip}:${port}/${sessionId}`,
            isDirect: true
        };
    }

    // Get all available domains (built-in + custom)
    const allDomains = getAllLinkDomains();

    let domain;
    if (preferredDomain && preferredDomain !== 'random' && allDomains.includes(preferredDomain)) {
        domain = preferredDomain;
    } else if (preferredDomain === 'random' || !preferredDomain) {
        // Use primary domain or random selection
        const primaryDomain = getPrimaryDomain();
        if (primaryDomain && allDomains.includes(primaryDomain)) {
            domain = primaryDomain;
        } else {
            // Random selection from all domains
            domain = allDomains[Math.floor(Math.random() * allDomains.length)];
        }
    } else {
        // Fallback to first available domain
        domain = allDomains[0] || 'openlink.tappedin.fm';
    }

    // Generate subdomain-based URL
    const subdomainUrl = `https://${subdomainSafeId}.${domain}`;
    // Also keep path-based URL as fallback
    const pathUrl = `https://${domain}/${sessionId}`;

    return {
        url: subdomainUrl,
        pathUrl: pathUrl,
        sessionId: sessionId,
        subdomainId: subdomainSafeId,
        domain: domain,
        shortUrl: `${subdomainSafeId}.${domain}`,
        isDirect: false
    };
}

/**
 * Get the signaling server URL based on selected option
 */
function getSignalingServerUrl() {
    const selected = elements.serverSelect?.value;

    // Default remote server for fallback
    const defaultRemoteServer = 'wss://openlink.devinecreations.net/ws';

    if (!selected || selected === '') {
        console.log('[Signaling] No server selected, using default:', defaultRemoteServer);
        return defaultRemoteServer;
    }

    if (selected === 'local') {
        return 'ws://localhost:8765';
    } else if (selected === 'random') {
        // Pick a random online server
        const onlineServers = (state.servers || []).filter(s => s.status === 'online');
        if (onlineServers.length > 0) {
            const randomServer = onlineServers[Math.floor(Math.random() * onlineServers.length)];
            return normalizeServerUrl(randomServer.url);
        }
        // Fallback to default remote server if no online servers
        console.log('[Signaling] No online servers found, using default:', defaultRemoteServer);
        return defaultRemoteServer;
    }

    // Normalize and return the selected server URL
    return normalizeServerUrl(selected);
}

/**
 * Normalize server URL - auto-add wss:// if user just enters domain
 */
function normalizeServerUrl(url) {
    if (!url) return 'ws://localhost:8765';

    // Already has protocol
    if (url.startsWith('ws://') || url.startsWith('wss://')) {
        return url;
    }

    // Has http/https - convert to ws/wss
    if (url.startsWith('https://')) {
        return url.replace('https://', 'wss://');
    }
    if (url.startsWith('http://')) {
        return url.replace('http://', 'ws://');
    }

    // Just a domain - add wss:// by default (secure)
    // Remove any trailing slashes
    url = url.replace(/\/+$/, '');

    // Check if it's localhost or local IP
    if (url.startsWith('localhost') || url.startsWith('127.') || url.startsWith('192.168.') || url.startsWith('10.')) {
        return `ws://${url}`;
    }

    // Default to secure wss:// for remote domains
    return `wss://${url}`;
}

function applySettings() {
    const s = state.settings;
    if (!s) return;

    // Audio
    if (s.audioSettings) {
        elements.remoteVolume.value = s.audioSettings.remoteVolume;
        elements.remoteVolumeValue.textContent = `${s.audioSettings.remoteVolume}%`;
        elements.localVolume.value = s.audioSettings.localVolume;
        elements.localVolumeValue.textContent = `${s.audioSettings.localVolume}%`;
        elements.autoEnableMic.checked = s.audioSettings.autoEnableMic;
        elements.alwaysEnableMedia.checked = s.audioSettings.alwaysEnableMedia;
    }

    // Clipboard
    if (s.clipboardSettings) {
        elements.enableClipboard.checked = s.clipboardSettings.enableSharing;
        elements.doubleCopyTransfer.checked = s.clipboardSettings.doubleCopyTransfer;
    }

    // General
    elements.runAtLogin.checked = s.runAtLogin;
    elements.startMinimized.checked = s.startMinimized;
    if (elements.keepWindowVisible) elements.keepWindowVisible.checked = s.keepWindowVisible || false;
    elements.sharedFolderPath.value = s.sharedFilesPath;
    elements.connectionPermission.value = s.allowRemoteConnections;

    // Host settings - what remote users can access
    if (elements.shareAudio) elements.shareAudio.checked = s.shareAudio !== false;
    if (elements.allowInput) elements.allowInput.checked = s.allowInput !== false;
    if (elements.allowClipboard) elements.allowClipboard.checked = s.allowClipboard !== false;
    if (elements.allowFiles) elements.allowFiles.checked = s.allowFiles !== false;

    // Session persistence settings
    if (elements.persistSessionId) elements.persistSessionId.checked = s.persistSessionId !== false;
    if (elements.autoHostStartup) elements.autoHostStartup.checked = s.autoHostStartup === true;
    if (elements.customSessionId) elements.customSessionId.value = s.customSessionId || '';
    if (elements.sessionPassword) elements.sessionPassword.value = s.sessionPassword || '';
    if (elements.sessionIdWords) elements.sessionIdWords.value = s.sessionIdWords || '';

    // Store persisted session password
    if (s.sessionPassword) {
        state.sessionPassword = s.sessionPassword;
    }

    // Store persisted session ID if enabled
    if (s.persistSessionId !== false && s.lastSessionId) {
        state.persistedSessionId = s.lastSessionId;
    }

    // App behavior settings
    if (elements.startupVisible && elements.startupMinimized) {
        if (s.startMinimized) {
            elements.startupMinimized.checked = true;
        } else {
            elements.startupVisible.checked = true;
        }
    }
    if (elements.closeToTray && elements.closeQuit) {
        if (s.closeBehavior === 'quit') {
            elements.closeQuit.checked = true;
        } else {
            elements.closeToTray.checked = true;
        }
    }
    if (elements.autoCopyUrl) elements.autoCopyUrl.checked = s.autoCopyUrl === true;
    if (elements.allowDropin) elements.allowDropin.checked = s.allowDropin !== false;

    // Restore saved server selection
    if (s.selectedServer && elements.serverSelect) {
        // Check if the saved server exists in the dropdown
        const serverExists = Array.from(elements.serverSelect.options).some(opt => opt.value === s.selectedServer);
        if (serverExists) {
            elements.serverSelect.value = s.selectedServer;
            console.log('[Settings] Restored server selection:', s.selectedServer);
        } else if (s.selectedServer !== 'local') {
            // Add the server as an option if it doesn't exist
            const option = document.createElement('option');
            option.value = s.selectedServer;
            option.textContent = s.selectedServer.replace('wss://', '').replace('/ws', '');
            elements.serverSelect.appendChild(option);
            elements.serverSelect.value = s.selectedServer;
            console.log('[Settings] Added and selected server:', s.selectedServer);
        }
    }

    // eCripto integration
    if (elements.eCriptoEnabled) elements.eCriptoEnabled.checked = s.eCriptoEnabled === true;

    // Wallet settings
    if (s.walletAddress) {
        elements.walletAddress.value = s.walletAddress;
    }
    if (s.walletNetwork && elements.walletNetwork) {
        elements.walletNetwork.value = s.walletNetwork;
    }
    if (elements.autoConnectWallet) {
        elements.autoConnectWallet.checked = s.autoConnectWallet === true;
    }

    // Load saved wallets list
    state.savedWallets = s.savedWallets || [];
    renderSavedWallets();

    // Recent connections
    updateRecentConnections(s.recentConnections || []);

    // Update all setting value displays
    updateSettingValueDisplays();
}

// ==================== Setting Value Displays ====================

/**
 * Updates the current value display for a checkbox setting
 */
function updateCheckboxValueDisplay(checkboxId, valueId) {
    const checkbox = document.getElementById(checkboxId);
    const valueEl = document.getElementById(valueId);
    if (!checkbox || !valueEl) return;

    const isChecked = checkbox.checked;
    valueEl.textContent = isChecked ? 'Enabled' : 'Disabled';
    valueEl.className = 'setting-value ' + (isChecked ? 'enabled' : 'disabled');
}

/**
 * Updates the current value display for a dropdown/select setting
 */
function updateSelectValueDisplay(selectId, valueId) {
    const select = document.getElementById(selectId);
    const valueEl = document.getElementById(valueId);
    if (!select || !valueEl) return;

    const selectedOption = select.options[select.selectedIndex];
    valueEl.textContent = selectedOption ? selectedOption.text : 'Not set';
    valueEl.className = 'setting-value';
}

/**
 * Updates the current value display for a text input setting
 */
function updateTextValueDisplay(inputId, valueId) {
    const input = document.getElementById(inputId);
    const valueEl = document.getElementById(valueId);
    if (!input || !valueEl) return;

    const value = input.value.trim();
    if (value) {
        // Truncate long values
        valueEl.textContent = value.length > 20 ? value.substring(0, 17) + '...' : value;
        valueEl.className = 'setting-value';
    } else {
        valueEl.textContent = 'Not set';
        valueEl.className = 'setting-value not-set';
    }
}

/**
 * Updates the current value display for a range/slider setting
 */
function updateRangeValueDisplay(rangeId, valueId, suffix = '%') {
    const range = document.getElementById(rangeId);
    const valueEl = document.getElementById(valueId);
    if (!range || !valueEl) return;

    valueEl.textContent = range.value + suffix;
    valueEl.className = 'setting-value';
}

/**
 * Updates all setting value displays based on current control states
 */
function updateSettingValueDisplays() {
    // Wallet & Payments
    updateSelectValueDisplay('wallet-network', 'wallet-network-value');
    updateTextValueDisplay('wallet-address', 'wallet-address-value');
    updateCheckboxValueDisplay('ecripto-enabled', 'ecripto-enabled-value');
    updateCheckboxValueDisplay('auto-connect-wallet', 'auto-connect-wallet-value');

    // Hosting Options - Session
    updateCheckboxValueDisplay('persist-session-id', 'persist-session-id-value');
    updateCheckboxValueDisplay('auto-host-startup', 'auto-host-startup-value');

    // Custom session ID display
    const customSessionId = document.getElementById('custom-session-id');
    const customSessionIdValue = document.getElementById('custom-session-id-value');
    if (customSessionId && customSessionIdValue) {
        const value = customSessionId.value.trim();
        customSessionIdValue.textContent = value || 'Auto-generated';
        customSessionIdValue.className = value ? 'setting-value' : 'setting-value not-set';
    }

    // Session ID words display
    const sessionIdWords = document.getElementById('session-id-words');
    const sessionIdWordsValue = document.getElementById('session-id-words-value');
    if (sessionIdWords && sessionIdWordsValue) {
        const value = sessionIdWords.value.trim();
        if (value) {
            const wordCount = value.split(',').filter(w => w.trim()).length;
            sessionIdWordsValue.textContent = `${wordCount} word${wordCount !== 1 ? 's' : ''}`;
            sessionIdWordsValue.className = 'setting-value';
        } else {
            sessionIdWordsValue.textContent = 'Not set';
            sessionIdWordsValue.className = 'setting-value not-set';
        }
    }

    // Hosting Options - Permissions
    updateCheckboxValueDisplay('share-audio', 'share-audio-value');
    updateCheckboxValueDisplay('allow-input', 'allow-input-value');
    updateCheckboxValueDisplay('allow-clipboard', 'allow-clipboard-value');
    updateCheckboxValueDisplay('allow-files', 'allow-files-value');
    updateSelectValueDisplay('connection-permission', 'connection-permission-value');

    // Payment Options
    updateCheckboxValueDisplay('require-payment', 'require-payment-value');
    const paymentAmountEl = document.getElementById('payment-amount-value');
    const paymentAmountInput = document.getElementById('payment-amount');
    if (paymentAmountEl && paymentAmountInput) {
        paymentAmountEl.textContent = paymentAmountInput.value;
    }

    // Audio
    updateRangeValueDisplay('remote-volume', 'remote-volume-value', '%');
    updateRangeValueDisplay('local-volume', 'local-volume-value', '%');
    updateCheckboxValueDisplay('auto-enable-mic', 'auto-enable-mic-value');
    updateCheckboxValueDisplay('always-enable-media', 'always-enable-media-value');

    // Screen Reader
    updateCheckboxValueDisplay('use-local-tts', 'use-local-tts-value');
    updateCheckboxValueDisplay('enable-remote-sr', 'enable-remote-sr-value');
    updateRangeValueDisplay('sr-rate', 'sr-rate-value', ' words/min');
    updateCheckboxValueDisplay('enable-braille', 'enable-braille-value');

    // Clipboard
    updateCheckboxValueDisplay('enable-clipboard', 'enable-clipboard-value');
    updateCheckboxValueDisplay('double-copy-transfer', 'double-copy-transfer-value');

    // Files
    const sharedFolderPath = document.getElementById('shared-folder-path');
    const sharedFolderValue = document.getElementById('shared-folder-path-value');
    if (sharedFolderPath && sharedFolderValue) {
        const path = sharedFolderPath.value.trim();
        if (path) {
            sharedFolderValue.textContent = path.length > 30 ? '...' + path.slice(-27) : path;
            sharedFolderValue.className = 'setting-value';
        } else {
            sharedFolderValue.textContent = 'Not set';
            sharedFolderValue.className = 'setting-value not-set';
        }
    }

    // Application
    updateCheckboxValueDisplay('run-at-login', 'run-at-login-value');
    updateCheckboxValueDisplay('start-minimized', 'start-minimized-value');
    updateCheckboxValueDisplay('use-native-dialogs', 'use-native-dialogs-value');

    // Network Auto-Refresh
    updateCheckboxValueDisplay('auto-refresh-enabled', 'auto-refresh-enabled-value');
    updateSelectValueDisplay('auto-refresh-interval', 'auto-refresh-interval-value');
}

/**
 * Setup change listeners for all settings to update value displays
 */
function setupSettingValueChangeListeners() {
    // Checkboxes
    const checkboxMappings = [
        ['persist-session-id', 'persist-session-id-value'],
        ['auto-host-startup', 'auto-host-startup-value'],
        ['share-audio', 'share-audio-value'],
        ['allow-input', 'allow-input-value'],
        ['allow-clipboard', 'allow-clipboard-value'],
        ['allow-files', 'allow-files-value'],
        ['require-payment', 'require-payment-value'],
        ['auto-enable-mic', 'auto-enable-mic-value'],
        ['always-enable-media', 'always-enable-media-value'],
        ['use-local-tts', 'use-local-tts-value'],
        ['enable-remote-sr', 'enable-remote-sr-value'],
        ['enable-braille', 'enable-braille-value'],
        ['enable-clipboard', 'enable-clipboard-value'],
        ['double-copy-transfer', 'double-copy-transfer-value'],
        ['run-at-login', 'run-at-login-value'],
        ['start-minimized', 'start-minimized-value'],
        ['use-native-dialogs', 'use-native-dialogs-value'],
        ['auto-refresh-enabled', 'auto-refresh-enabled-value'],
        ['ecripto-enabled', 'ecripto-enabled-value'],
        ['auto-connect-wallet', 'auto-connect-wallet-value']
    ];

    checkboxMappings.forEach(([checkboxId, valueId]) => {
        const checkbox = document.getElementById(checkboxId);
        if (checkbox) {
            checkbox.addEventListener('change', () => updateCheckboxValueDisplay(checkboxId, valueId));
        }
    });

    // Dropdowns
    const selectMappings = [
        ['wallet-network', 'wallet-network-value'],
        ['connection-permission', 'connection-permission-value'],
        ['auto-refresh-interval', 'auto-refresh-interval-value']
    ];

    selectMappings.forEach(([selectId, valueId]) => {
        const select = document.getElementById(selectId);
        if (select) {
            select.addEventListener('change', () => updateSelectValueDisplay(selectId, valueId));
        }
    });

    // Text inputs
    const textMappings = [
        ['wallet-address', 'wallet-address-value']
    ];

    textMappings.forEach(([inputId, valueId]) => {
        const input = document.getElementById(inputId);
        if (input) {
            input.addEventListener('input', () => updateTextValueDisplay(inputId, valueId));
            input.addEventListener('change', () => updateTextValueDisplay(inputId, valueId));
        }
    });

    // Custom session ID - special handler for "Auto-generated" display
    const customSessionId = document.getElementById('custom-session-id');
    const customSessionIdValue = document.getElementById('custom-session-id-value');
    if (customSessionId && customSessionIdValue) {
        const updateCustomSessionDisplay = () => {
            const value = customSessionId.value.trim();
            customSessionIdValue.textContent = value || 'Auto-generated';
            customSessionIdValue.className = value ? 'setting-value' : 'setting-value not-set';
        };
        customSessionId.addEventListener('input', updateCustomSessionDisplay);
        customSessionId.addEventListener('change', () => {
            updateCustomSessionDisplay();
            saveSettings();
        });
    }

    // Device nickname - for friendly device identification
    const deviceNickname = document.getElementById('device-nickname');
    const deviceNicknameValue = document.getElementById('device-nickname-value');
    if (deviceNickname && deviceNicknameValue) {
        const updateNicknameDisplay = () => {
            const value = deviceNickname.value.trim();
            deviceNicknameValue.textContent = value || 'Not set';
            deviceNicknameValue.className = value ? 'setting-value' : 'setting-value not-set';
            // Update state for use in connections
            state.deviceNickname = value;
        };
        deviceNickname.addEventListener('input', updateNicknameDisplay);
        deviceNickname.addEventListener('change', () => {
            updateNicknameDisplay();
            saveSettings();
            // If hosting, update the nickname on the server
            if (state.isHosting && state.sessionId) {
                updateDeviceNicknameOnServer(state.sessionId, deviceNickname.value.trim());
            }
        });
    }

    // Session password - with sync to connected clients
    const sessionPassword = document.getElementById('session-password');
    const sessionPasswordValue = document.getElementById('session-password-value');
    const regeneratePasswordBtn = document.getElementById('regenerate-password-btn');
    if (sessionPassword && sessionPasswordValue) {
        const updatePasswordDisplay = () => {
            const value = sessionPassword.value.trim();
            sessionPasswordValue.textContent = value || 'Auto-generated';
            sessionPasswordValue.className = value ? 'setting-value' : 'setting-value not-set';
        };
        sessionPassword.addEventListener('input', updatePasswordDisplay);
        sessionPassword.addEventListener('change', () => {
            updatePasswordDisplay();
            const newPassword = sessionPassword.value.trim();
            if (newPassword) {
                state.sessionPassword = newPassword;
                // Sync password to signaling server and connected clients
                syncPasswordChange(newPassword);
            }
            saveSettings();
        });
    }
    if (regeneratePasswordBtn) {
        regeneratePasswordBtn.addEventListener('click', () => {
            const newPassword = generateSessionPassword();
            if (sessionPassword) {
                sessionPassword.value = newPassword;
                sessionPassword.dispatchEvent(new Event('change'));
            }
            announce('New password generated: ' + newPassword);
        });
    }

    // Session ID words - for anagram generation
    const sessionIdWords = document.getElementById('session-id-words');
    const sessionIdWordsValue = document.getElementById('session-id-words-value');
    if (sessionIdWords && sessionIdWordsValue) {
        const updateWordsDisplay = () => {
            const value = sessionIdWords.value.trim();
            if (value) {
                const wordCount = value.split(',').filter(w => w.trim()).length;
                sessionIdWordsValue.textContent = `${wordCount} word${wordCount !== 1 ? 's' : ''}`;
                sessionIdWordsValue.className = 'setting-value';
            } else {
                sessionIdWordsValue.textContent = 'Not set';
                sessionIdWordsValue.className = 'setting-value not-set';
            }
        };
        sessionIdWords.addEventListener('input', updateWordsDisplay);
        sessionIdWords.addEventListener('change', () => {
            updateWordsDisplay();
            saveSettings();
        });
    }

    // Range sliders
    const rangeMappings = [
        ['remote-volume', 'remote-volume-value', '%'],
        ['local-volume', 'local-volume-value', '%'],
        ['sr-rate', 'sr-rate-value', ' words/min']
    ];

    rangeMappings.forEach(([rangeId, valueId, suffix]) => {
        const range = document.getElementById(rangeId);
        if (range) {
            range.addEventListener('input', () => updateRangeValueDisplay(rangeId, valueId, suffix));
        }
    });

    // Payment amount
    const paymentAmount = document.getElementById('payment-amount');
    const paymentAmountValue = document.getElementById('payment-amount-value');
    if (paymentAmount && paymentAmountValue) {
        paymentAmount.addEventListener('input', () => {
            paymentAmountValue.textContent = paymentAmount.value;
        });
    }
}

// ==================== Event Listeners ====================

function setupEventListeners() {
    // Setup setting value change listeners for accessibility
    setupSettingValueChangeListeners();

    // Tabs
    elements.tabs.forEach(tab => {
        tab.addEventListener('click', () => switchTab(tab.id.replace('tab-', '')));
    });

    // Connect
    elements.connectBtn.addEventListener('click', connect);
    elements.pasteLinkBtn.addEventListener('click', pasteAndConnect);
    elements.sessionIdInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') connect();
    });

    // Copy Key ID
    if (elements.copyKeyId) {
        elements.copyKeyId.addEventListener('click', copyKeyId);
    }

    // Host
    elements.startHostingBtn.addEventListener('click', startHosting);
    elements.stopHostingBtn.addEventListener('click', stopHosting);
    elements.copySessionId.addEventListener('click', copySessionId);
    elements.createLinkBtn.addEventListener('click', createOpenLink);
    elements.requirePayment.addEventListener('change', togglePaymentSettings);

    // Remove link button
    if (elements.removeLinkBtn) {
        elements.removeLinkBtn.addEventListener('click', async () => {
            if (state.sessionId) {
                await removeDeviceLink(state.sessionId);
            } else {
                announce('No active session to remove');
            }
        });
    }

    // Direct IP copy dropdown
    const directIpSelect = document.getElementById('direct-ip-select');
    if (directIpSelect) {
        directIpSelect.addEventListener('change', (e) => {
            if (e.target.value) {
                copyDirectIp(e.target.value);
                e.target.value = ''; // Reset to placeholder
            }
        });
    }

    // Setup link type handlers
    setupLinkTypeHandlers();

    // Custom domain handlers
    setupCustomDomainHandlers();

    // Remote controls
    document.getElementById('toggle-fullscreen').addEventListener('click', toggleFullscreen);
    document.getElementById('open-control-menu').addEventListener('click', openControlMenu);

    // Control menu
    elements.menuItems.forEach((item, index) => {
        item.addEventListener('click', () => handleMenuAction(item.dataset.action));
        item.addEventListener('keydown', (e) => handleMenuKeydown(e, index));
    });

    // Restart submenu
    elements.submenuItems.forEach((item, index) => {
        item.addEventListener('click', () => handleMenuAction(item.dataset.action));
        item.addEventListener('keydown', (e) => handleSubmenuKeydown(e, index));
    });

    // Volume sliders
    elements.remoteVolume.addEventListener('input', (e) => {
        const value = e.target.value;
        elements.remoteVolumeValue.textContent = `${value}%`;
        window.openlink.setRemoteVolume(parseInt(value));
        if (elements.remoteAudio) {
            elements.remoteAudio.volume = value / 100;
        }
    });

    elements.localVolume.addEventListener('input', (e) => {
        const value = e.target.value;
        elements.localVolumeValue.textContent = `${value}%`;
        window.openlink.setLocalVolume(parseInt(value));
    });

    // Audio options
    elements.autoEnableMic.addEventListener('change', (e) => {
        window.openlink.setAutoEnableMic(e.target.checked);
    });

    elements.alwaysEnableMedia.addEventListener('change', (e) => {
        window.openlink.setAlwaysEnableMedia(e.target.checked);
    });

    // Settings change handlers
    elements.runAtLogin.addEventListener('change', saveSettings);
    elements.startMinimized.addEventListener('change', saveSettings);
    if (elements.keepWindowVisible) elements.keepWindowVisible.addEventListener('change', saveSettings);
    elements.enableClipboard.addEventListener('change', saveSettings);
    elements.doubleCopyTransfer.addEventListener('change', saveSettings);
    elements.walletAddress.addEventListener('change', saveSettings);

    // Server selection - auto-save when changed
    if (elements.serverSelect) {
        elements.serverSelect.addEventListener('change', () => {
            console.log('[Settings] Server selection changed to:', elements.serverSelect.value);
            saveSettings();
        });
    }

    // Connection permission dropdown - critical for permission flow
    if (elements.connectionPermission) {
        elements.connectionPermission.addEventListener('change', (e) => {
            console.log('Connection permission changed to:', e.target.value);
            saveSettings();
            announce(`Connection permission set to: ${e.target.value}`);
        });
    }

    // Host settings (what remote users can access)
    const hostSettingCheckboxes = ['persist-session-id', 'auto-host-startup', 'share-audio', 'allow-input', 'allow-clipboard', 'allow-files'];
    hostSettingCheckboxes.forEach(id => {
        const checkbox = document.getElementById(id);
        if (checkbox) {
            checkbox.addEventListener('change', saveSettings);
        }
    });

    // App behavior radio buttons
    const startupRadios = document.querySelectorAll('input[name="startup-behavior"]');
    startupRadios.forEach(radio => radio.addEventListener('change', saveSettings));

    const closeRadios = document.querySelectorAll('input[name="close-behavior"]');
    closeRadios.forEach(radio => radio.addEventListener('change', saveSettings));

    // App behavior checkboxes
    if (elements.autoCopyUrl) elements.autoCopyUrl.addEventListener('change', saveSettings);
    if (elements.allowDropin) elements.allowDropin.addEventListener('change', saveSettings);

    // Wallet settings event listeners
    if (elements.walletNetwork) {
        elements.walletNetwork.addEventListener('change', saveSettings);
    }
    if (elements.autoConnectWallet) {
        elements.autoConnectWallet.addEventListener('change', saveSettings);
    }
    if (elements.detectWalletsBtn) {
        elements.detectWalletsBtn.addEventListener('click', detectWallets);
    }
    if (elements.scanNetworkBtn) {
        elements.scanNetworkBtn.addEventListener('click', scanNetworkForWallets);
    }
    if (elements.connectBrowserWalletBtn) {
        elements.connectBrowserWalletBtn.addEventListener('click', connectBrowserWallet);
    }
    if (elements.addWalletBtn) {
        elements.addWalletBtn.addEventListener('click', addSavedWallet);
    }

    // Screen reader settings - mutually exclusive
    elements.useLocalTts.addEventListener('change', (e) => {
        if (e.target.checked) {
            // Disable remote screen reader when local TTS is enabled
            elements.enableRemoteSr.checked = false;
        }
        saveSettings();
    });

    elements.enableRemoteSr.addEventListener('change', (e) => {
        if (e.target.checked) {
            // Disable local TTS when remote screen reader is enabled
            elements.useLocalTts.checked = false;
        }
        saveSettings();
    });

    // Native dialogs setting
    const nativeDialogsCheckbox = document.getElementById('use-native-dialogs');
    nativeDialogsCheckbox.addEventListener('change', (e) => {
        state.useNativeDialogs = e.target.checked;
        saveSettings();
    });

    // Auto-refresh settings
    const autoRefreshEnabled = document.getElementById('auto-refresh-enabled');
    const autoRefreshInterval = document.getElementById('auto-refresh-interval');
    const refreshNowBtn = document.getElementById('refresh-now-btn');

    if (autoRefreshEnabled) {
        autoRefreshEnabled.addEventListener('change', (e) => {
            if (e.target.checked) {
                const interval = parseInt(autoRefreshInterval?.value || '5');
                startAutoRefresh(interval);
                announce(`Auto-refresh enabled: every ${interval} minutes`);
            } else {
                stopAutoRefresh();
                announce('Auto-refresh disabled');
            }
            saveSettings();
        });
    }

    if (autoRefreshInterval) {
        autoRefreshInterval.addEventListener('change', (e) => {
            const interval = parseInt(e.target.value);
            if (autoRefreshEnabled?.checked) {
                startAutoRefresh(interval);
                announce(`Auto-refresh interval changed to ${interval} minutes`);
            }
            saveSettings();
        });
    }

    if (refreshNowBtn) {
        refreshNowBtn.addEventListener('click', async () => {
            announce('Refreshing network info and servers...');
            await detectNetworkInfo();
            await initializeServers();
            if (state.currentPanel === 'servers') {
                await renderServerList();
            }
            announce('Network info and servers refreshed');
        });
    }

    document.getElementById('open-shared-folder').addEventListener('click', () => {
        window.openlink.openSharedFolder();
    });

    // File transfer
    document.getElementById('file-input').addEventListener('change', (e) => {
        document.getElementById('send-file-btn').disabled = !e.target.files.length;
    });
    document.getElementById('send-file-btn').addEventListener('click', sendFile);
    document.getElementById('cancel-file-btn').addEventListener('click', () => closeModal('file-dialog'));

    // Connection request dialog buttons
    document.getElementById('allow-connection').addEventListener('click', () => {
        handleConnectionResponse('allow', false);
    });
    document.getElementById('deny-connection').addEventListener('click', () => {
        handleConnectionResponse('deny', false);
    });
    document.getElementById('always-allow').addEventListener('click', () => {
        handleConnectionResponse('allow', true);
    });
    document.getElementById('always-deny').addEventListener('click', () => {
        handleConnectionResponse('deny', true);
    });

    // Minimize
    document.getElementById('minimize-btn').addEventListener('click', () => {
        announce('OpenLink minimized to tray');
        window.openlink.showNotification({
            title: 'OpenLink',
            body: 'Minimized to tray. Use Option+Shift+\\ to restore.'
        });
        window.openlink.minimizeToTray();
    });

    // Global keyboard handler
    document.addEventListener('keydown', handleGlobalKeydown);

    // IPC listeners
    window.openlink.onSettingsLoaded((data) => {
        Object.assign(state.settings, data);
        applySettings();
    });

    window.openlink.onOpenControlMenu(() => {
        if (state.isConnected) {
            openControlMenu();
        }
    });

    window.openlink.onClipboardTransfer((data) => {
        if (state.isConnected && state.dataChannel) {
            sendDataMessage({ type: 'clipboard', text: data.text });
            announce('Clipboard transferred to remote');
        }
    });

    window.openlink.onSendToRemote((data) => {
        if (state.dataChannel && state.dataChannel.readyState === 'open') {
            state.dataChannel.send(JSON.stringify(data));
        }
    });

    window.openlink.onUpdateAvailable((info) => {
        announce(`Update available: version ${info.version}`);
    });

    // Track update countdown state
    let updateCountdown = null;
    let updateInfo = null;

    window.openlink.onUpdateDownloaded((info) => {
        console.log('[Update] Downloaded:', info.version);
        updateInfo = info;
        updateCountdown = info.countdownSeconds || 10;

        // Build release notes message
        const releaseNotes = info.releaseNotes || getDefaultReleaseNotes(info.version);
        const notesText = typeof releaseNotes === 'string' ? releaseNotes :
            (Array.isArray(releaseNotes) ? releaseNotes.join('\n') : 'Bug fixes and improvements');

        announce(`Update ${info.version} ready. ${notesText}. Restarting in ${updateCountdown} seconds. Press delay to postpone.`);

        // Show update notification with release notes
        showUpdateNotification(info.version, notesText, updateCountdown);
    });

    window.openlink.onUpdateCountdown((seconds) => {
        updateCountdown = seconds;
        const countdownEl = document.getElementById('update-countdown');
        if (countdownEl) {
            countdownEl.textContent = seconds;
        }
        if (seconds <= 3) {
            announce(`Restarting in ${seconds}`);
        }
    });

    // Handle reconnection after update restart
    window.openlink.onUpdateReconnect(async (info) => {
        console.log('[Update] Reconnection requested:', info);

        // Show update completed notification
        announce(`OpenLink updated to version ${info.toVersion}. Restoring your session...`);

        // Wait a moment for the UI to fully initialize
        await new Promise(resolve => setTimeout(resolve, 1000));

        if (info.wasHosting && info.sessionId) {
            console.log('[Update] Restoring hosting session:', info.sessionId);
            announce(`Restoring hosting session: ${info.sessionId}`);

            // Set the session ID and start hosting
            if (elements.customSessionId) {
                elements.customSessionId.value = info.sessionId;
            }

            // Switch to Host tab
            switchToTab('host');

            // Start hosting with the saved session ID
            try {
                await startHosting();
                announce(`Hosting session restored successfully. Session ID: ${info.sessionId}`);
            } catch (e) {
                console.error('[Update] Failed to restore hosting:', e);
                announce(`Failed to restore hosting session: ${e.message}`);
            }
        } else if (info.wasConnected && info.connectedTo) {
            console.log('[Update] Restoring connection to:', info.connectedTo);
            announce(`Restoring connection to ${info.connectedTo}`);

            // Switch to Connect tab
            switchToTab('connect');

            // Set the session ID and connect
            if (elements.sessionIdInput) {
                elements.sessionIdInput.value = info.connectedTo;
            }

            // Attempt to reconnect
            try {
                await connectToRemote();
                announce(`Connection restored to ${info.connectedTo}`);
            } catch (e) {
                console.error('[Update] Failed to restore connection:', e);
                announce(`Failed to restore connection: ${e.message}. Please connect manually.`);
            }
        } else {
            // No session to restore, just announce the update
            announce(`OpenLink updated successfully to version ${info.toVersion}`);
        }
    });

    // Handle protocol URL connections (openlink://server/sessionId or openlink://host)
    window.openlink.onProtocolConnect(async (data) => {
        console.log('[Protocol] Received connect request:', data);
        const { server, sessionId } = data;

        // Check if this is a host request (openlink://host or openlink://host/sessionId)
        if (server === 'host') {
            console.log('[Protocol] Auto-start hosting requested');
            announce('Starting hosting session...');

            // Switch to Host tab
            switchTab('host');

            // If a specific session ID was provided, use it
            if (sessionId && elements.hostSessionId) {
                // Will be set during startHosting
            }

            // Auto-start hosting after a short delay to ensure UI is ready
            setTimeout(async () => {
                try {
                    await startHosting();
                    console.log('[Protocol] Auto-hosting started successfully');
                } catch (e) {
                    console.error('[Protocol] Failed to auto-start hosting:', e);
                    announce(`Failed to start hosting: ${e.message}`);
                }
            }, 500);
            return;
        }

        if (!sessionId) {
            announce('Invalid OpenLink URL - no session ID found');
            return;
        }

        // Set the server if provided
        if (server && elements.serverSelect) {
            const serverUrl = `wss://${server}/ws`;
            // Check if this server is in the list
            const exists = Array.from(elements.serverSelect.options).some(opt =>
                opt.value.includes(server)
            );
            if (!exists) {
                const option = document.createElement('option');
                option.value = serverUrl;
                option.textContent = server;
                elements.serverSelect.appendChild(option);
            }
            // Select the server
            for (let opt of elements.serverSelect.options) {
                if (opt.value.includes(server)) {
                    elements.serverSelect.value = opt.value;
                    break;
                }
            }
        }

        // Set the session ID and connect
        elements.sessionIdInput.value = sessionId;
        announce(`Connecting to session ${sessionId}...`);

        // Switch to Connect tab if not already there
        switchTab('connect');

        // Auto-connect
        setTimeout(() => connect(), 500);
    });

    function getDefaultReleaseNotes(version) {
        // Default release notes for versions
        const notes = {
            '1.2.5': 'Auto-restart after updates with countdown timer. Improved dropdown accessibility. Auto-generated session IDs.',
            '1.2.4': 'Fixed dropdown boxes. Auto-generate session IDs when hosting.',
            '1.2.3': 'Bug fixes and stability improvements.',
            '1.2.2': 'Server relay hosting and authentication features.',
            '1.2.1': 'eCripto payment integration. Native dialog support.',
            '1.2.0': 'Multi-server support. Trust and reporting system.'
        };
        return notes[version] || 'Bug fixes and improvements.';
    }

    function showUpdateNotification(version, releaseNotes, countdown) {
        // Remove any existing update notification
        const existing = document.getElementById('update-notification');
        if (existing) existing.remove();

        const notification = document.createElement('div');
        notification.id = 'update-notification';
        notification.setAttribute('role', 'alertdialog');
        notification.setAttribute('aria-labelledby', 'update-title');
        notification.setAttribute('aria-describedby', 'update-desc');
        notification.innerHTML = `
            <style>
                #update-notification {
                    position: fixed;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    background: var(--card-bg, #1e1e2e);
                    border: 2px solid var(--primary, #89b4fa);
                    border-radius: 12px;
                    padding: 24px;
                    max-width: 400px;
                    z-index: 10000;
                    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
                }
                #update-notification h2 {
                    margin: 0 0 12px;
                    color: var(--primary, #89b4fa);
                }
                #update-notification .release-notes {
                    background: var(--surface, #313244);
                    padding: 12px;
                    border-radius: 8px;
                    margin: 12px 0;
                    font-size: 14px;
                    line-height: 1.5;
                }
                #update-notification .countdown {
                    text-align: center;
                    font-size: 24px;
                    font-weight: bold;
                    color: var(--warning, #f9e2af);
                    margin: 16px 0;
                }
                #update-notification .buttons {
                    display: flex;
                    gap: 12px;
                    justify-content: center;
                }
                #update-notification button {
                    padding: 10px 20px;
                    border-radius: 8px;
                    border: none;
                    cursor: pointer;
                    font-weight: 600;
                }
                #update-notification .install-btn {
                    background: var(--primary, #89b4fa);
                    color: var(--base, #1e1e2e);
                }
                #update-notification .delay-btn {
                    background: var(--surface, #313244);
                    color: var(--text, #cdd6f4);
                }
            </style>
            <h2 id="update-title">Update Ready: v${version}</h2>
            <div id="update-desc" class="release-notes">
                <strong>What's New:</strong><br>
                ${releaseNotes}
            </div>
            <div class="countdown">
                Restarting in <span id="update-countdown">${countdown}</span> seconds
            </div>
            <div class="buttons">
                <button class="install-btn" onclick="window.openlink.installUpdate()">Install Now</button>
                <button class="delay-btn" onclick="delayUpdate()">Delay</button>
            </div>
        `;
        document.body.appendChild(notification);
    }

    window.delayUpdate = async function() {
        const result = await window.openlink.delayUpdate();
        announce(result.message || 'Update delayed until next restart');
        const notification = document.getElementById('update-notification');
        if (notification) notification.remove();
    };

    // Server settings tab event listeners
    setupServerSettingsListeners();
}

// ==================== Tab Navigation ====================

function switchTab(tabName) {
    state.currentPanel = tabName;

    elements.tabs.forEach(tab => {
        const isActive = tab.id === `tab-${tabName}`;
        tab.classList.toggle('active', isActive);
        tab.setAttribute('aria-selected', isActive);
    });

    elements.panels.forEach(panel => {
        const isActive = panel.id === `panel-${tabName}`;
        panel.classList.toggle('active', isActive);
        panel.hidden = !isActive;
    });

    // Display system info when switching to Host tab
    if (tabName === 'host') {
        displaySystemInfo();
    }

    announce(`${tabName} tab selected`);
}

// ==================== Connection ====================

async function connect() {
    const sessionId = elements.sessionIdInput.value.trim();
    if (!sessionId) {
        announce('Please enter a session ID or link');
        return;
    }

    // Parse OpenLink URL if provided
    let targetSession = sessionId;
    let serverFromUrl = null;

    // Check if it's a URL (contains :// or openlink domain)
    if (sessionId.includes('://') || sessionId.includes('openlink.') || sessionId.includes('.me/') || sessionId.includes('.com/') || sessionId.includes('.net/')) {
        try {
            // Normalize URL for parsing
            let urlToParse = sessionId;
            if (!urlToParse.includes('://')) {
                urlToParse = 'https://' + urlToParse;
            }
            const url = new URL(urlToParse);

            // Extract server domain
            serverFromUrl = url.hostname;
            console.log('[Connect] Parsed server from URL:', serverFromUrl);

            // Extract session ID from path (e.g., /macmini-fl)
            const pathSession = url.pathname.replace(/^\/+/, '').split('/')[0];
            if (pathSession && pathSession.length > 0) {
                targetSession = pathSession;
                console.log('[Connect] Parsed session from path:', targetSession);
            }

            // Also check query param format (?session=xxx)
            const querySession = url.searchParams.get('session');
            if (querySession) {
                targetSession = querySession;
                console.log('[Connect] Parsed session from query:', targetSession);
            }
        } catch (e) {
            console.warn('[Connect] URL parse failed, using as session ID:', e.message);
        }
    }

    // Set server from URL if found
    if (serverFromUrl && elements.serverSelect) {
        elements.serverSelect.value = serverFromUrl;
        console.log('[Connect] Set server to:', serverFromUrl);
    }

    // Prevent connecting to own session (self-loop)
    if (state.isHosting && targetSession === state.sessionId) {
        announce('Cannot connect to your own session');
        return;
    }

    announce('Connecting...');
    elements.connectBtn.disabled = true;

    // Track which session we're connecting to (for tray status)
    state.connectedTo = targetSession;

    try {
        await initWebRTC();
        await connectToSignaling(targetSession, false);
    } catch (e) {
        console.error('Connection failed:', e);
        announce(`Connection failed: ${e.message}`);
        elements.connectBtn.disabled = false;
        state.connectedTo = null;  // Clear on failure
    }
}

async function pasteAndConnect() {
    try {
        const text = await window.openlink.getClipboard();
        if (text) {
            elements.sessionIdInput.value = text;
            announce('Pasted from clipboard');
        }
    } catch (e) {
        console.error('Paste failed:', e);
    }
}

async function startHosting() {
    announce('Starting hosting session...');
    elements.startHostingBtn.disabled = true;

    try {
        // Check macOS permissions first
        if (window.openlink?.checkMacPermissions) {
            const permissions = await window.openlink.checkMacPermissions();
            console.log('[Hosting] Initial permission check:', permissions);

            let screenGranted = permissions.screen?.granted;
            let accessibilityGranted = permissions.accessibility?.granted;

            // Update UI with current permission status
            updatePermissionIndicators(permissions);

            // If screen permission is missing, try to prompt
            if (!screenGranted) {
                console.log('[Hosting] Screen Recording permission not granted, prompting...');
                const result = await window.openlink.triggerMacPermissionPrompt('screen');
                console.log('[Hosting] Screen prompt result:', result);

                // Re-check after prompt
                const recheckPerms = await window.openlink.checkMacPermissions();
                screenGranted = recheckPerms.screen?.granted;
                console.log('[Hosting] Screen permission after re-check:', screenGranted);

                if (!screenGranted) {
                    // Permission still not granted - open System Settings
                    await window.openlink.openPermissionSettings('screen');
                    throw new Error('Screen Recording permission required. Please enable OpenLink in System Settings > Privacy & Security > Screen Recording, then try again.');
                }
            }

            // Check accessibility (warn but don't block)
            if (!accessibilityGranted) {
                console.log('[Hosting] Accessibility permission not granted');
                await window.openlink.triggerMacPermissionPrompt('accessibility');
                announce('Note: Accessibility permission is needed for remote control. You can grant it in System Settings.');
            }
        }

        // Get available screen sources using Electron's desktopCapturer
        const sources = await window.openlink.getScreenSources();

        // Check if we got an error object instead of an array
        if (sources && sources.error) {
            if (sources.error === 'permission_denied') {
                throw new Error('Screen Recording permission is required. Please grant permission in System Settings > Privacy & Security > Screen Recording, then restart OpenLink.');
            } else if (sources.error === 'permission_pending') {
                throw new Error(sources.message || 'Permission settings opened. Please grant Screen Recording permission and try hosting again.');
            }
            throw new Error(sources.message || 'Failed to get screen sources');
        }

        // Ensure sources is an array
        if (!Array.isArray(sources) || sources.length === 0) {
            throw new Error('No screens available for sharing. Please check Screen Recording permissions.');
        }

        // Use the first screen by default (primary display)
        const source = sources.find(s => s.id && s.id.includes('screen')) || sources[0];

        // Create stream using the source ID
        const constraints = {
            audio: document.getElementById('share-audio').checked ? {
                mandatory: {
                    chromeMediaSource: 'desktop'
                }
            } : false,
            video: {
                mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: source.id,
                    minWidth: 1280,
                    maxWidth: 1920,
                    minHeight: 720,
                    maxHeight: 1080
                }
            }
        };

        state.localStream = await navigator.mediaDevices.getUserMedia(constraints);

        // Add microphone if auto-enable is on
        if (state.settings?.audioSettings?.autoEnableMic) {
            try {
                const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                micStream.getAudioTracks().forEach(track => {
                    state.localStream.addTrack(track);
                });
            } catch (e) {
                console.warn('Microphone not available:', e);
            }
        }

        await initWebRTC();

        // Determine session ID: custom > persisted > generated
        const customId = elements.customSessionId?.value?.trim();
        const persistEnabled = elements.persistSessionId?.checked !== false;

        if (customId) {
            // Use custom session ID if set
            state.sessionId = customId;
            console.log('[Session] Using custom session ID:', state.sessionId);
        } else if (persistEnabled && state.persistedSessionId) {
            // Use previously persisted session ID
            state.sessionId = state.persistedSessionId;
            console.log('[Session] Using persisted session ID:', state.sessionId);
        } else {
            // Generate new session ID
            state.sessionId = generateSessionId();
            console.log('[Session] Generated new session ID:', state.sessionId);
        }

        // Save the session ID for persistence
        if (persistEnabled) {
            state.persistedSessionId = state.sessionId;
            await window.openlink.saveSettings({ lastSessionId: state.sessionId });
        }

        elements.hostSessionId.textContent = state.sessionId;

        // Connect to signaling server as host
        await connectToSignaling(state.sessionId, true);

        state.isHosting = true;
        elements.startHostingBtn.disabled = true;
        elements.stopHostingBtn.disabled = false;
        if (elements.removeLinkBtn) elements.removeLinkBtn.disabled = false;
        elements.copySessionId.disabled = false;
        elements.createLinkBtn.disabled = false;

        // Update tray status immediately
        updateConnectionStatusUI();

        // Show shareable link section and enable direct IP select
        const shareableLinkSection = document.getElementById('shareable-link-section');
        if (shareableLinkSection) shareableLinkSection.hidden = false;
        const directIpSelect = document.getElementById('direct-ip-select');
        if (directIpSelect) directIpSelect.disabled = false;

        // Update eCripto status in the link section
        updateEcriptoStatus();

        // Auto-generate a temporary shareable link
        autoGenerateShareableLink();

        // Auto-copy URL to clipboard if enabled
        if (state.settings?.autoCopyUrl && state.currentLink?.url) {
            window.openlink.setClipboard(state.currentLink.url);
            announce('Shareable URL copied to clipboard');
        }

        // Show the current connection URL (local or remote server)
        updateHostingUrlDisplay();

        // Generate and display the shareable HTTPS URL
        updateActiveConnectionUrl();

        // Track hosting session start
        startHostingSession();

        announce(`Hosting started. Session ID: ${state.sessionId}`);
        window.openlink.showNotification({
            title: 'OpenLink - Hosting',
            body: `Session started. Share your ID: ${state.sessionId}`
        });

        // Send notification through all enabled channels (Pushover, email, SMS)
        if (window.openlink?.notifications?.send) {
            window.openlink.notifications.send({
                title: 'OpenLink - Session Ready',
                message: `Your session is ready. ID: ${state.sessionId}`,
                priority: 'normal',
                url: state.activeConnectionUrl || null
            }).catch(e => console.log('[Notification] Push failed:', e));
        }

        // Report successful hosting start to telemetry
        if (window.telemetry?.success) {
            window.telemetry.success('Hosting started successfully', {
                sessionId: state.sessionId
            }).catch(() => {});
        }
    } catch (e) {
        console.error('Failed to start hosting:', e);
        announce(`Failed to start hosting: ${e.message}`);
        elements.startHostingBtn.disabled = false;

        // Report hosting failure to telemetry
        if (window.telemetry?.error) {
            window.telemetry.error(`Failed to start hosting: ${e.message}`, e.stack, state.sessionId).catch(() => {});
        }
    }
}

function stopHosting() {
    // Unregister session from signaling server before closing
    if (state.ws && state.ws.readyState === WebSocket.OPEN && state.sessionId) {
        state.ws.send(JSON.stringify({
            type: 'leave',
            sessionId: state.sessionId
        }));
        console.log('[WebSocket] Session unregistered:', state.sessionId);
    }

    if (state.localStream) {
        state.localStream.getTracks().forEach(track => track.stop());
        state.localStream = null;
    }

    disconnectWebRTC();

    state.isHosting = false;
    state.sessionId = null;
    state.connectedClients = [];  // Clear connected clients
    state.currentLink = null;     // Clear current link
    elements.hostSessionId.textContent = 'Not started';
    elements.startHostingBtn.disabled = false;
    elements.stopHostingBtn.disabled = true;
    if (elements.removeLinkBtn) elements.removeLinkBtn.disabled = true;
    elements.copySessionId.disabled = true;
    elements.createLinkBtn.disabled = true;

    // Update tray status
    updateConnectionStatusUI();

    // Hide shareable link section and disable direct IP select
    const shareableLinkSection = document.getElementById('shareable-link-section');
    if (shareableLinkSection) shareableLinkSection.hidden = true;
    const directIpSelect = document.getElementById('direct-ip-select');
    if (directIpSelect) directIpSelect.disabled = true;

    // Clear any generated link display
    const generatedLink = document.getElementById('generated-link');
    if (generatedLink) generatedLink.textContent = '';

    // Track hosting session end
    endHostingSession();

    announce('Hosting stopped');
    window.openlink.showNotification({
        title: 'OpenLink - Hosting Stopped',
        body: 'Your hosting session has ended'
    });
}

function copySessionId() {
    if (state.sessionId) {
        window.openlink.setClipboard(state.sessionId);
        announce('Session ID copied to clipboard');
    }
}

function copyKeyId() {
    if (state.keyId) {
        window.openlink.setClipboard(state.keyId);
        announce('Key ID copied to clipboard');
    }
}

async function createOpenLink() {
    // Check if verification is required before creating links
    const verificationCheck = await checkVerificationForLink();
    if (verificationCheck.required) {
        announce('Please verify your identity (phone or email) in Settings before creating shareable links.');
        // Switch to settings tab
        switchToTab('settings');
        // Scroll to verification section
        const verifySection = document.getElementById('phone-verification-group');
        if (verifySection) verifySection.scrollIntoView({ behavior: 'smooth' });
        return;
    }

    const linkType = document.getElementById('link-type').value;
    const linkDomain = document.getElementById('link-domain').value;
    const linkExpiry = document.getElementById('link-expiry').value;

    // For permanent links, check eCripto wallet first
    if (linkType === 'permanent') {
        if (!state.eCriptoAvailable) {
            announce('eCripto wallet required for permanent links. Please connect eCripto.');
            return;
        }

        // Check balance
        try {
            const balance = await window.ecripto.getBalance();
            const cost = 0.50; // ECR cost for permanent link

            if (balance < cost) {
                announce(`Insufficient balance. Need ${cost} ECR, you have ${balance} ECR`);
                return;
            }

            // Process payment for permanent link
            const paymentResult = await window.ecripto.sendPayment({
                amount: cost,
                recipient: 'openlink-permanent-links',
                memo: `Permanent link: ${state.sessionId}`
            });

            if (!paymentResult.success) {
                announce('Payment failed. Could not create permanent link.');
                return;
            }
        } catch (e) {
            announce('eCripto error: ' + e.message);
            return;
        }
    }

    // Generate the shareable URL
    const urlData = generateShareableUrl(state.sessionId, linkDomain);

    // Store link info for tracking
    state.currentLink = {
        ...urlData,
        type: linkType,
        expiry: linkType === 'expiring' ? linkExpiry : null,
        createdAt: Date.now()
    };

    // Display the link
    const container = document.getElementById('generated-link-container');
    document.getElementById('generated-link').value = urlData.url;
    container.hidden = false;

    // Update link info text
    const linkInfoEl = document.getElementById('link-info');
    if (linkInfoEl) {
        let infoText = '';
        switch (linkType) {
            case 'temporary':
                infoText = 'This link expires when your session ends.';
                break;
            case 'expiring':
                infoText = `This link expires in ${linkExpiry}.`;
                break;
            case 'changeable':
                infoText = 'You can regenerate this link anytime. Old links will stop working.';
                break;
            case 'permanent':
                infoText = 'This is a permanent link. Paid with eCripto.';
                break;
        }
        linkInfoEl.textContent = infoText;
    }

    announce(`OpenLink created: ${urlData.shortUrl}`);
}

/**
 * Copy direct IP address for connections (local, Tailscale, or public)
 * @param {string} type - 'local', 'tailscale', or 'public'
 */
function copyDirectIp(type) {
    const port = 8765; // Default WebSocket port
    let ip = null;
    let label = '';

    switch (type) {
        case 'local':
            ip = state.localIp;
            label = 'Local network';
            break;
        case 'tailscale':
            ip = state.tailscaleIp;
            label = 'Tailscale';
            break;
        case 'public':
            ip = state.publicIp;
            label = 'Public';
            break;
        default:
            ip = state.localIp || state.tailscaleIp || state.publicIp;
            label = 'Direct';
    }

    if (ip) {
        const connectionString = `ws://${ip}:${port}/${state.sessionId || ''}`;
        window.openlink.setClipboard(connectionString);
        announce(`${label} IP copied: ${ip}:${port}`);
    } else {
        announce(`${label} IP not available`);
    }
}

/**
 * Auto-generate a temporary shareable link when hosting starts
 * Creates a link with default settings (temporary, random domain)
 */
function autoGenerateShareableLink() {
    if (!state.sessionId) return;

    // Generate the shareable URL with random domain
    const urlData = generateShareableUrl(state.sessionId, 'random');

    // Store link info for tracking
    state.currentLink = {
        ...urlData,
        type: 'temporary',
        expiry: null,
        createdAt: Date.now()
    };

    // Display the link
    const container = document.getElementById('generated-link-container');
    const generatedLinkInput = document.getElementById('generated-link');
    if (container && generatedLinkInput) {
        generatedLinkInput.value = urlData.url;
        container.hidden = false;
    }

    // Update link info text
    const linkInfoEl = document.getElementById('link-info');
    if (linkInfoEl) {
        linkInfoEl.textContent = 'This link expires when your session ends.';
    }

    // Set the dropdown defaults to match the auto-generated link
    const linkTypeSelect = document.getElementById('link-type');
    if (linkTypeSelect) linkTypeSelect.value = 'temporary';
}

/**
 * Setup link type change handlers
 */
function setupLinkTypeHandlers() {
    const linkTypeSelect = document.getElementById('link-type');
    const expirySettings = document.getElementById('expiry-settings');
    const permanentLinkInfo = document.getElementById('permanent-link-info');

    if (linkTypeSelect) {
        linkTypeSelect.addEventListener('change', async (e) => {
            const type = e.target.value;

            // Show/hide expiry settings
            if (expirySettings) {
                expirySettings.hidden = type !== 'expiring';
            }

            // Show/hide permanent link info
            if (permanentLinkInfo) {
                permanentLinkInfo.hidden = type !== 'permanent';

                if (type === 'permanent') {
                    // Check eCripto wallet status
                    await updateEcriptoStatus();
                }
            }
        });
    }

    // Generate wallet button
    const generateWalletBtn = document.getElementById('generate-ecripto-wallet');
    if (generateWalletBtn) {
        generateWalletBtn.addEventListener('click', async () => {
            try {
                announce('Generating eCripto wallet...');
                // This would call the eCripto API to generate a new wallet
                const result = await window.ecripto.generateReceiveAddress({
                    label: 'OpenLink Wallet'
                });

                if (result.success) {
                    announce('Wallet generated! Address: ' + result.address);
                    await updateEcriptoStatus();
                }
            } catch (e) {
                announce('Failed to generate wallet: ' + e.message);
            }
        });
    }

    // Copy link button
    const copyLinkBtn = document.getElementById('copy-link-btn');
    if (copyLinkBtn) {
        copyLinkBtn.addEventListener('click', () => {
            const linkInput = document.getElementById('generated-link');
            if (linkInput && linkInput.value) {
                window.openlink.setClipboard(linkInput.value);
                announce('Link copied to clipboard');
            }
        });
    }
}

/**
 * Update eCripto wallet status display
 */
async function updateEcriptoStatus() {
    const walletStatusEl = document.getElementById('ecripto-wallet-status');
    const generateWalletBtn = document.getElementById('generate-ecripto-wallet');

    if (!walletStatusEl) return;

    try {
        if (state.eCriptoAvailable) {
            const balance = await window.ecripto.getBalance();
            walletStatusEl.textContent = `Wallet connected. Balance: ${balance.toFixed(3)} ECR`;
            if (generateWalletBtn) generateWalletBtn.hidden = true;
        } else {
            walletStatusEl.textContent = 'No eCripto wallet detected.';
            if (generateWalletBtn) generateWalletBtn.hidden = false;
        }
    } catch (e) {
        walletStatusEl.textContent = 'Unable to check eCripto status.';
        if (generateWalletBtn) generateWalletBtn.hidden = false;
    }
}

// ==================== WebRTC ====================

async function initWebRTC() {
    const config = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ]
    };

    state.peerConnection = new RTCPeerConnection(config);

    state.peerConnection.onicecandidate = (event) => {
        if (event.candidate && state.ws) {
            state.ws.send(JSON.stringify({
                type: 'ice-candidate',
                candidate: event.candidate
            }));
        }
    };

    state.peerConnection.ontrack = (event) => {
        console.log('Received track:', event.track.kind);
        if (event.track.kind === 'video') {
            elements.remoteVideo.srcObject = event.streams[0];
        } else if (event.track.kind === 'audio') {
            elements.remoteAudio.srcObject = event.streams[0];
            elements.remoteAudio.volume = (state.settings?.audioSettings?.remoteVolume || 100) / 100;
        }
    };

    state.peerConnection.ondatachannel = (event) => {
        setupDataChannel(event.channel);
    };

    state.peerConnection.onconnectionstatechange = () => {
        const connState = state.peerConnection.connectionState;
        console.log('Connection state:', connState);

        if (connState === 'connected') {
            state.isConnected = true;
            showRemoteView();
            announce('Connected to remote computer');
            window.openlink.showNotification({
                title: 'OpenLink - Connected',
                body: 'Successfully connected to remote computer'
            });

            // Update tray status immediately
            updateConnectionStatusUI();

            // Track this connection
            const serverUrl = getSignalingServerUrl();
            const remoteIp = state.remoteSystemInfo?.publicIp || state.remoteSystemInfo?.localIp || 'Unknown';
            recordConnection(remoteIp, serverUrl);

            // Sync capslock state - turn off on both sides
            syncCapsLock();

            // Request system info
            if (state.dataChannel) {
                sendDataMessage({ type: 'request-info' });
            }
        } else if (connState === 'disconnected' || connState === 'failed') {
            handleDisconnect();
        }
    };

    // Add local tracks if hosting
    if (state.localStream) {
        state.localStream.getTracks().forEach(track => {
            state.peerConnection.addTrack(track, state.localStream);
        });
    }

    // Create data channel if initiating
    if (!state.isHosting) {
        const dataChannel = state.peerConnection.createDataChannel('openlink', {
            ordered: true
        });
        setupDataChannel(dataChannel);
    }
}

function setupDataChannel(channel) {
    state.dataChannel = channel;

    channel.onopen = () => {
        console.log('Data channel open');
    };

    channel.onmessage = (event) => {
        handleDataMessage(JSON.parse(event.data));
    };

    channel.onerror = (error) => {
        console.error('Data channel error:', error);
    };
}

function sendDataMessage(data) {
    if (state.dataChannel && state.dataChannel.readyState === 'open') {
        state.dataChannel.send(JSON.stringify(data));
    }
}

/**
 * Sync capslock state on connection - turns off capslock on both sides
 */
function syncCapsLock() {
    // Turn off capslock locally
    window.openlink.setCapsLock(false);

    // Send message to remote to turn off capslock
    sendDataMessage({
        type: 'sync-capslock',
        capsLockState: false
    });
}

async function connectToSignaling(sessionId, isHost, retryCount = 0) {
    const serverUrl = getSignalingServerUrl();
    const maxRetries = 3;
    const retryDelay = 2000; // 2 seconds

    return new Promise((resolve, reject) => {
        console.log(`[WebSocket] Connecting to ${serverUrl} (attempt ${retryCount + 1}/${maxRetries + 1})`);

        try {
            state.ws = new WebSocket(serverUrl);
        } catch (err) {
            console.error('[WebSocket] Failed to create WebSocket:', err.message);
            handleWebSocketRetry(sessionId, isHost, retryCount, maxRetries, retryDelay, resolve, reject);
            return;
        }

        state.ws.onopen = () => {
            console.log('[WebSocket] Connection opened successfully');
            if (isHost) {
                // First create the session, then join as host
                state.ws.send(JSON.stringify({
                    type: 'create_session',
                    sessionId: sessionId,
                    password: state.sessionPassword || generateSessionPassword()
                }));
            } else {
                // Join existing session
                state.ws.send(JSON.stringify({
                    type: 'join',
                    sessionId: sessionId
                }));
            }
        };

        state.ws.onmessage = async (event) => {
            const message = JSON.parse(event.data);
            await handleSignalingMessage(message, resolve, reject);
        };

        state.ws.onerror = (error) => {
            console.error('[WebSocket] Connection error:', error);
            // Don't reject immediately, let onclose handle retry
        };

        state.ws.onclose = (event) => {
            console.log('[WebSocket] Connection closed:', event.code, event.reason || 'No reason provided');

            // Check if we were in the middle of connecting
            if (!state.wsConnected) {
                handleWebSocketRetry(sessionId, isHost, retryCount, maxRetries, retryDelay, resolve, reject);
            } else {
                // Connection was established then lost - try to reconnect
                state.wsConnected = false;
                announce('Connection to server lost. Reconnecting...');
                setTimeout(() => {
                    connectToSignaling(sessionId, isHost, 0).catch(err => {
                        console.error('[WebSocket] Reconnection failed:', err.message);
                    });
                }, retryDelay);
            }
        };
    });
}

function handleWebSocketRetry(sessionId, isHost, retryCount, maxRetries, retryDelay, resolve, reject) {
    if (retryCount < maxRetries) {
        console.log(`[WebSocket] Retrying connection in ${retryDelay}ms...`);
        announce(`Connection failed. Retrying (${retryCount + 1}/${maxRetries})...`);
        setTimeout(() => {
            connectToSignaling(sessionId, isHost, retryCount + 1)
                .then(resolve)
                .catch(reject);
        }, retryDelay);
    } else {
        const errorMsg = 'WebSocket connection failed after multiple attempts. Please check your network connection.';
        console.error('[WebSocket]', errorMsg);
        announce(errorMsg);

        // Report WebSocket failure to telemetry
        if (window.telemetry?.error) {
            const serverUrl = getSignalingServerUrl();
            window.telemetry.error(`WebSocket connection failed to ${serverUrl}`, null, sessionId).catch(() => {});
        }

        reject(new Error(errorMsg));
    }
}

// Get or generate a persistent machine ID for this device
function getMachineId() {
    let machineId = localStorage.getItem('openlink-machine-id');
    if (!machineId) {
        // Generate a unique ID for this machine
        machineId = 'machine-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 9);
        localStorage.setItem('openlink-machine-id', machineId);
    }
    return machineId;
}

// Get detailed client information
function getClientInfo() {
    return {
        version: '1.7.3',
        machineId: getMachineId(),
        platform: window.navigator.platform,
        os: getOperatingSystem(),
        architecture: getArchitecture(),
        userAgent: window.navigator.userAgent,
        hostname: state.settings?.deviceName || window.location.hostname || getOperatingSystem(),
        appVersion: window.navigator.appVersion,
        language: window.navigator.language,
        locale: window.navigator.language,
        screenResolution: `${screen.width}x${screen.height}`,
        walletAddress: state.settings?.walletAddress || null,
        timestamp: Date.now()
    };
}

function getOperatingSystem() {
    const platform = window.navigator.platform.toLowerCase();
    const userAgent = window.navigator.userAgent.toLowerCase();

    if (platform.includes('win') || userAgent.includes('windows')) {
        return 'Windows';
    } else if (platform.includes('mac') || userAgent.includes('mac')) {
        return 'macOS';
    } else if (platform.includes('linux') || userAgent.includes('linux')) {
        return 'Linux';
    } else if (userAgent.includes('electron')) {
        return 'Electron';
    }
    return 'Unknown';
}

function getArchitecture() {
    const platform = window.navigator.platform.toLowerCase();
    if (platform.includes('x86_64') || platform.includes('win64') || platform.includes('amd64')) {
        return 'x64';
    } else if (platform.includes('arm') || platform.includes('aarch64')) {
        return 'ARM64';
    } else if (platform.includes('i386') || platform.includes('x86')) {
        return 'x86';
    }
    return 'Unknown';
}

// Generate a random session password
function generateSessionPassword() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let password = '';
    for (let i = 0; i < 8; i++) {
        password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    state.sessionPassword = password;
    return password;
}

/**
 * Sync password change to signaling server and connected clients
 * This ensures clients can reconnect with the new password
 */
function syncPasswordChange(newPassword) {
    console.log('[Password] Syncing new password to server and clients');

    // 1. Update password on signaling server
    if (state.ws && state.ws.readyState === WebSocket.OPEN && state.sessionId) {
        state.ws.send(JSON.stringify({
            type: 'update_password',
            sessionId: state.sessionId,
            password: newPassword
        }));
        console.log('[Password] Sent password update to signaling server');
    }

    // 2. Notify connected clients via data channel
    if (state.dataChannel && state.dataChannel.readyState === 'open') {
        state.dataChannel.send(JSON.stringify({
            type: 'password-changed',
            password: newPassword,
            sessionId: state.sessionId
        }));
        console.log('[Password] Sent password update to connected client');
        announce('Password synced to connected client');
    }

    // 3. Update connection URL display if showing password
    updateActiveConnectionUrl();
}

/**
 * Handle incoming password change notification (client side)
 * Called when host changes password - client updates stored password for reconnection
 */
function handlePasswordChange(newPassword, sessionId) {
    console.log('[Password] Received password update from host');
    state.sessionPassword = newPassword;

    // Store in recent connections for auto-reconnect
    if (state.settings?.recentConnections) {
        const recent = state.settings.recentConnections.find(c => c.sessionId === sessionId);
        if (recent) {
            recent.password = newPassword;
            saveSettings();
        }
    }

    announce('Session password updated by host');
}

/**
 * Update device nickname on the signaling server
 * This allows other users to see a friendly name instead of hostname
 */
async function updateDeviceNicknameOnServer(sessionId, nickname) {
    if (!sessionId) return;

    try {
        // Try all available domains for the API
        const apiEndpoints = openlinkDomains.map(d => `https://${d}:8765/api/devices/${sessionId}/nickname`);

        for (const endpoint of apiEndpoints) {
            try {
                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ nickname })
                });

                if (response.ok) {
                    console.log('[Nickname] Updated device nickname on server:', nickname);
                    return true;
                }
            } catch (e) {
                continue;
            }
        }

        // Also update via WebSocket if connected
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({
                type: 'update_device_info',
                sessionId,
                nickname
            }));
        }
    } catch (e) {
        console.error('[Nickname] Failed to update nickname:', e.message);
    }
}

/**
 * Remove a device link/session from the server
 * This terminates the session and removes the device from the device list
 */
async function removeDeviceLink(sessionId) {
    if (!sessionId) {
        announce('No session to remove');
        return false;
    }

    // Confirm with user
    const confirmed = await showConfirmDialog(
        'Remove Device Link',
        `Are you sure you want to remove this device link? Session ID: ${sessionId}`,
        'Remove',
        'Cancel'
    );

    if (!confirmed) {
        return false;
    }

    try {
        // Stop hosting if this is our own session
        if (state.isHosting && state.sessionId === sessionId) {
            stopHosting();
        }

        // Try to remove via API
        const apiEndpoints = openlinkDomains.map(d => `https://${d}:8765/api/devices/${sessionId}`);

        for (const endpoint of apiEndpoints) {
            try {
                const response = await fetch(endpoint, { method: 'DELETE' });
                if (response.ok) {
                    console.log('[Device] Removed device link:', sessionId);
                    announce('Device link removed');
                    return true;
                }
            } catch (e) {
                continue;
            }
        }

        // If API fails, just disconnect locally
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({
                type: 'leave_session',
                sessionId
            }));
        }

        announce('Device link removed locally');
        return true;
    } catch (e) {
        console.error('[Device] Failed to remove link:', e.message);
        announce('Failed to remove device link');
        return false;
    }
}

/**
 * Show a confirmation dialog
 */
async function showConfirmDialog(title, message, confirmText = 'OK', cancelText = 'Cancel') {
    if (state.useNativeDialogs && window.openlink?.showConfirmDialog) {
        return await window.openlink.showConfirmDialog({ title, message, confirmText, cancelText });
    }
    return confirm(message);
}

async function handleSignalingMessage(message, resolve, reject) {
    switch (message.type) {
        case 'welcome':
            // Server welcome - may include subdomain session from URL
            state.wsConnected = true; // Mark as connected for retry logic
            console.log('[WebSocket] Connected to signaling server:', message.clientId);

            // If connected via subdomain URL, the server tells us which session to join
            if (message.subdomainSession) {
                console.log('[WebSocket] Subdomain session detected:', message.subdomainSession);
                // Auto-join the session from subdomain
                if (!state.isHosting) {
                    state.targetSessionId = message.subdomainSession;
                    announce(`Connecting to session: ${message.subdomainSession}`);
                }
            }
            break;

        case 'session_created':
            // Session was created, now join as host
            console.log('[WebSocket] Session created:', message.sessionId);
            if (state.ws) {
                state.ws.send(JSON.stringify({
                    type: 'host',
                    sessionId: message.sessionId
                }));
            }
            break;

        case 'connected':
            // Server is requesting client info, send it
            if (message.requestClientInfo && state.ws) {
                const clientInfo = getClientInfo();
                console.log('[WebSocket] Sending client info to server:', clientInfo);

                state.ws.send(JSON.stringify({
                    type: 'client-info',
                    payload: clientInfo
                }));
            }
            break;

        case 'client-info-received':
            console.log('[WebSocket] Server received client info');
            break;

        case 'host-ready':
        case 'joined':
            // For host: session is ready
            if (message.isHost) {
                console.log('[WebSocket] Hosting session ready');
                resolve();
                return;
            }
            // For viewer joining - check permission settings before starting offer
            if (state.isHosting) {
                const permissionSetting = state.settings?.allowRemoteConnections || 'ask';

                if (permissionSetting === 'never') {
                    // Always deny - send rejection
                    state.ws.send(JSON.stringify({
                        type: 'connection-denied',
                        reason: 'Host has disabled remote connections'
                    }));
                    return;
                } else if (permissionSetting === 'always') {
                    // Always allow - proceed with offer
                    await startWebRTCOffer();
                } else {
                    // Ask for permission
                    showConnectionRequest(message.machineId || 'unknown', message.machineName || 'Remote User');
                    // Store the resolve function to call after permission is granted
                    state.pendingOfferResolve = async () => {
                        await startWebRTCOffer();
                    };
                }
            }
            break;

        case 'connection-request':
            // Someone wants to connect - show permission dialog
            if (state.isHosting) {
                const permissionSetting = state.settings?.allowRemoteConnections || 'ask';

                if (permissionSetting === 'never') {
                    state.ws.send(JSON.stringify({
                        type: 'connection-denied',
                        machineId: message.machineId,
                        reason: 'Host has disabled remote connections'
                    }));
                } else if (permissionSetting === 'always') {
                    state.ws.send(JSON.stringify({
                        type: 'connection-allowed',
                        machineId: message.machineId
                    }));
                } else {
                    showConnectionRequest(message.machineId, message.machineName);
                }
            }
            break;

        case 'connection-allowed':
            // Host allowed our connection - proceed with WebRTC
            announce('Connection allowed by host');
            resolve();
            break;

        case 'connection-denied':
            // Host denied our connection
            announce(`Connection denied: ${message.reason || 'Host rejected the connection'}`);
            reject(new Error(message.reason || 'Connection denied by host'));
            break;

        case 'offer':
            await state.peerConnection.setRemoteDescription(message.offer);
            const answer = await state.peerConnection.createAnswer();
            await state.peerConnection.setLocalDescription(answer);
            state.ws.send(JSON.stringify({
                type: 'answer',
                answer: answer
            }));
            break;

        case 'answer':
            await state.peerConnection.setRemoteDescription(message.answer);
            break;

        case 'ice-candidate':
            if (message.candidate) {
                await state.peerConnection.addIceCandidate(message.candidate);
            }
            break;

        case 'payment-required':
            showPaymentRequest(message.amount);
            break;

        case 'error':
            reject(new Error(message.message));
            break;

        case 'session_id_changed':
            // Host changed the session ID - auto-reconnect with new ID
            handleSessionIdChanged(message);
            break;

        case 'session_id_change_confirmed':
            // Our session ID change was accepted
            announce(`Session ID changed to: ${message.newSessionId}`);
            state.sessionId = message.newSessionId;
            if (elements.sessionIdDisplay) {
                elements.sessionIdDisplay.textContent = message.newSessionId;
            }
            break;

        case 'settings_updated':
            // Host updated session settings
            console.log('[Settings] Session settings updated:', message.settings);
            break;

        case 'settings_update_confirmed':
            // Our settings update was accepted
            console.log('[Settings] Settings update confirmed');
            break;

        case 'password_updated':
            // Host updated session password - store for reconnection
            console.log('[Password] Password updated by host');
            handlePasswordChange(message.password, message.sessionId);
            break;

        case 'password_update_confirmed':
            // Our password update was accepted
            console.log('[Password] Password update confirmed');
            announce('Session password updated');
            break;

        // Remote host setup messages
        case 'remote-host-request':
            // Someone wants us to start hosting so they can connect
            handleRemoteHostSetupRequest(message.fromMachineId);
            break;

        case 'remote-host-session-ready':
            // Remote machine started hosting, connect to their session
            handleRemoteHostReady(message);
            break;

        case 'remote-host-error':
            // Remote host setup failed
            announce(message.error || 'Remote host setup failed');
            break;

        case 'remote-host-declined':
            // Remote machine declined to host
            announce('Remote machine declined to start hosting');
            break;

        // Wallet-based quick connect
        case 'wallet-registered':
            console.log('[Wallet] Wallet registered:', message.walletAddress);
            break;

        case 'wallet-devices':
            // Received list of devices with same wallet
            handleWalletDevices(message.devices);
            break;
    }
}

/**
 * Handle session ID change notification from host
 * Auto-reconnect with the new session ID
 */
function handleSessionIdChanged(message) {
    const { oldSessionId, newSessionId, reconnectDelay } = message;

    announce(`Session ID changing from ${oldSessionId} to ${newSessionId}. Reconnecting...`);

    // Store reconnect info
    const wasConnected = state.isConnected;
    const signalingUrl = state.signalingUrl;

    // Close current connection gracefully
    if (state.ws) {
        state.ws.close();
        state.ws = null;
    }

    // Reconnect after delay
    setTimeout(async () => {
        try {
            state.sessionId = newSessionId;
            await connectToSignaling(signalingUrl, newSessionId);
            announce(`Reconnected to new session: ${newSessionId}`);
        } catch (error) {
            console.error('[Reconnect] Failed to reconnect after session ID change:', error);
            announce(`Failed to reconnect: ${error.message}`);
        }
    }, reconnectDelay || 1000);
}

/**
 * Start WebRTC offer exchange after permission is granted
 */
async function startWebRTCOffer() {
    if (!state.peerConnection) {
        console.error('No peer connection available');
        return;
    }
    const offer = await state.peerConnection.createOffer();
    await state.peerConnection.setLocalDescription(offer);
    state.ws.send(JSON.stringify({
        type: 'offer',
        offer: offer
    }));
}

function disconnectWebRTC() {
    if (state.dataChannel) {
        state.dataChannel.close();
        state.dataChannel = null;
    }

    if (state.peerConnection) {
        state.peerConnection.close();
        state.peerConnection = null;
    }

    if (state.ws) {
        state.ws.close();
        state.ws = null;
    }

    state.isConnected = false;
    state.connectedTo = null;  // Clear connected session

    // Update tray status immediately
    updateConnectionStatusUI();
}

function handleDisconnect() {
    disconnectWebRTC();
    hideRemoteView();

    // Track disconnection
    recordDisconnection();

    announce('Disconnected from remote computer');
    window.openlink.showNotification({
        title: 'OpenLink - Disconnected',
        body: 'Remote session has ended'
    });
    elements.connectBtn.disabled = false;
}

// ==================== Remote View ====================

function showRemoteView() {
    elements.remoteView.hidden = false;
    document.body.style.overflow = 'hidden';

    // Add recent connection
    if (!state.isHosting) {
        window.openlink.addRecentConnection({
            sessionId: state.sessionId,
            name: state.remoteSystemInfo?.hostname || 'Remote Computer',
            timestamp: Date.now()
        });
    }
}

function hideRemoteView() {
    elements.remoteView.hidden = true;
    document.body.style.overflow = '';
    closeControlMenu();
}

function toggleFullscreen() {
    if (document.fullscreenElement) {
        document.exitFullscreen();
    } else {
        elements.remoteView.requestFullscreen();
    }
}

// ==================== Control Menu ====================

function openControlMenu() {
    // Only open if in an active remote session
    if (!state.isConnected) {
        announce('No active session');
        return;
    }
    state.controlMenuOpen = true;
    state.menuSelectedIndex = 0;
    elements.controlMenu.hidden = false;
    elements.controlMenu.removeAttribute('aria-hidden');
    elements.controlMenu.removeAttribute('inert');
    // Make first item tabbable and focus it
    elements.menuItems[0].setAttribute('tabindex', '0');
    elements.menuItems[0].focus();
    announce('Control menu opened');
}

function closeControlMenu() {
    state.controlMenuOpen = false;
    elements.controlMenu.hidden = true;
    elements.controlMenu.setAttribute('aria-hidden', 'true');
    elements.controlMenu.setAttribute('inert', '');
    // Reset all menu items to not be tabbable when hidden
    elements.menuItems.forEach(item => {
        item.setAttribute('tabindex', '-1');
    });
    announce('Control menu closed');
}

function handleMenuKeydown(event, index) {
    switch (event.key) {
        case 'ArrowDown':
            event.preventDefault();
            const nextIndex = (index + 1) % elements.menuItems.length;
            elements.menuItems[nextIndex].focus();
            break;

        case 'ArrowUp':
            event.preventDefault();
            const prevIndex = (index - 1 + elements.menuItems.length) % elements.menuItems.length;
            elements.menuItems[prevIndex].focus();
            break;

        case 'Enter':
        case ' ':
            event.preventDefault();
            handleMenuAction(elements.menuItems[index].dataset.action);
            break;

        case 'Escape':
            closeControlMenu();
            break;
    }
}

function handleSubmenuKeydown(event, index) {
    switch (event.key) {
        case 'ArrowDown':
            event.preventDefault();
            const nextIndex = (index + 1) % elements.submenuItems.length;
            elements.submenuItems[nextIndex].focus();
            break;

        case 'ArrowUp':
            event.preventDefault();
            const prevIndex = (index - 1 + elements.submenuItems.length) % elements.submenuItems.length;
            elements.submenuItems[prevIndex].focus();
            break;

        case 'Enter':
        case ' ':
            event.preventDefault();
            handleMenuAction(elements.submenuItems[index].dataset.action);
            break;

        case 'Escape':
            hideRestartSubmenu();
            break;
    }
}

function handleMenuAction(action) {
    switch (action) {
        case 'disconnect':
            closeControlMenu();
            disconnect();
            break;

        case 'minimize-session':
            closeControlMenu();
            minimizeSession();
            break;

        case 'send-file':
            closeControlMenu();
            openModal('file-dialog');
            break;

        case 'machine-details':
            closeControlMenu();
            showMachineDetails();
            break;

        case 'audio-settings':
            closeControlMenu();
            hideRemoteView();
            switchTab('settings');
            // Focus on audio section
            setTimeout(() => document.getElementById('remote-volume')?.focus(), 100);
            break;

        case 'screen-reader':
            closeControlMenu();
            hideRemoteView();
            switchTab('settings');
            // Focus on screen reader section
            setTimeout(() => document.getElementById('use-local-tts')?.focus(), 100);
            break;

        case 'swap-control':
            closeControlMenu();
            swapControl();
            break;

        case 'flip-session':
            closeControlMenu();
            flipSession();
            break;

        case 'find-linked-devices':
            closeControlMenu();
            findWalletLinkedDevices();
            break;

        case 'permissions':
            closeControlMenu();
            showPermissions();
            break;

        case 'restart-submenu':
            showRestartSubmenu();
            break;

        case 'restart-remote-app':
            closeControlMenu();
            restartRemoteApp();
            break;

        case 'restart-local-app':
            closeControlMenu();
            restartLocalApp();
            break;

        case 'restart-remote-service':
            closeControlMenu();
            restartRemoteService();
            break;

        case 'restart-both-apps':
            closeControlMenu();
            restartBothApps();
            break;

        case 'reboot-remote':
            closeControlMenu();
            rebootRemoteSystem();
            break;

        case 'back-to-main':
            hideRestartSubmenu();
            break;

        case 'restart-remote':
            closeControlMenu();
            restartRemote();
            break;
    }
}

function disconnect() {
    if (state.isHosting) {
        stopHosting();
    } else {
        handleDisconnect();
    }
}

// ==================== Minimize Session ====================

function minimizeSession() {
    // Save current session info for reconnection
    state.minimizedSession = {
        sessionId: state.sessionId,
        isHosting: state.isHosting,
        remoteId: state.remoteId
    };

    // Minimize window to tray while keeping connection alive
    window.openlink.minimizeToTray();
    announce('Session minimized to tray. Connection remains active.');
}

// ==================== Restart Submenu ====================

function showRestartSubmenu() {
    const mainMenu = document.querySelector('#control-menu .menu-items');
    const submenu = document.getElementById('restart-submenu');

    if (mainMenu && submenu) {
        mainMenu.hidden = true;
        submenu.hidden = false;
        // Focus first item in submenu
        submenu.querySelector('[role="menuitem"]')?.focus();
    }
}

function hideRestartSubmenu() {
    const mainMenu = document.querySelector('#control-menu .menu-items');
    const submenu = document.getElementById('restart-submenu');

    if (mainMenu && submenu) {
        submenu.hidden = true;
        mainMenu.hidden = false;
        // Focus restart options item in main menu
        document.querySelector('[data-action="restart-submenu"]')?.focus();
    }
}

// ==================== Restart Functions ====================

async function restartRemoteApp() {
    // Send restart command to remote OpenLink
    const confirmed = await window.openlink.confirmDialog({
        title: 'Restart Remote OpenLink',
        message: 'This will restart OpenLink on the remote computer. The session will automatically reconnect.',
        buttons: ['Cancel', 'Restart']
    });

    if (confirmed) {
        announce('Sending restart command to remote...');
        sendDataMessage({
            type: 'system-command',
            command: 'restart-app',
            reconnect: true,
            sessionId: state.sessionId
        });
    }
}

async function restartLocalApp() {
    const confirmed = await window.openlink.confirmDialog({
        title: 'Restart Local OpenLink',
        message: 'This will restart OpenLink on this computer. The session will automatically reconnect after restart.',
        buttons: ['Cancel', 'Restart']
    });

    if (confirmed) {
        // Notify remote we're restarting
        sendDataMessage({
            type: 'system-command',
            command: 'peer-restarting',
            reconnect: true,
            sessionId: state.sessionId
        });

        // Restart local app
        announce('Restarting local OpenLink...');
        window.openlink.systemCommand({
            command: 'restart-app',
            reconnect: true,
            sessionId: state.sessionId
        });
    }
}

async function restartRemoteService() {
    const confirmed = await window.openlink.confirmDialog({
        title: 'Restart Remote Background Service',
        message: 'This will restart the OpenLink background service on the remote computer. This is useful if streaming or input is not working properly.',
        buttons: ['Cancel', 'Restart Service']
    });

    if (confirmed) {
        announce('Sending service restart command to remote...');
        sendDataMessage({
            type: 'system-command',
            command: 'restart-service'
        });
    }
}

async function restartBothApps() {
    const confirmed = await window.openlink.confirmDialog({
        title: 'Restart Both & Reconnect',
        message: 'This will restart OpenLink on both computers and automatically reconnect the session.',
        buttons: ['Cancel', 'Restart Both']
    });

    if (confirmed) {
        // Store reconnection info
        const reconnectInfo = {
            sessionId: state.sessionId,
            remoteId: state.remoteId,
            isHosting: state.isHosting
        };

        // Save for auto-reconnect after restart
        localStorage.setItem('openlink-reconnect', JSON.stringify(reconnectInfo));

        // Tell remote to restart with reconnect
        sendDataMessage({
            type: 'system-command',
            command: 'restart-app',
            reconnect: true,
            sessionId: state.sessionId
        });

        announce('Restarting both apps...');

        // Delay local restart to give remote time to receive message
        setTimeout(() => {
            window.openlink.systemCommand({
                command: 'restart-app',
                reconnect: true,
                sessionId: state.sessionId
            });
        }, 500);
    }
}

async function rebootRemoteSystem() {
    const confirmed = await window.openlink.confirmDialog({
        title: 'Reboot Remote System',
        message: 'WARNING: This will perform a full system reboot on the remote computer. The session will attempt to reconnect once the remote system comes back online.',
        buttons: ['Cancel', 'Reboot Remote']
    });

    if (confirmed) {
        // Double confirm for system reboot
        const doubleConfirm = await window.openlink.confirmDialog({
            title: 'Confirm System Reboot',
            message: 'Are you sure? The remote computer will fully restart. Any unsaved work on the remote system may be lost.',
            buttons: ['Cancel', 'Yes, Reboot Now']
        });

        if (doubleConfirm) {
            // Save reconnection info
            const reconnectInfo = {
                sessionId: state.sessionId,
                remoteId: state.remoteId,
                isHosting: state.isHosting,
                waitingForReboot: true
            };
            localStorage.setItem('openlink-reconnect', JSON.stringify(reconnectInfo));

            announce('Sending reboot command to remote system...');
            sendDataMessage({
                type: 'system-command',
                command: 'system-reboot',
                reconnect: true,
                sessionId: state.sessionId
            });

            // Show waiting status
            showStatus('Waiting for remote system to reboot and reconnect...', 'info');
            startReconnectPolling();
        }
    }
}

function startReconnectPolling() {
    // Poll for reconnection after reboot
    state.reconnectPollInterval = setInterval(async () => {
        const reconnectInfo = JSON.parse(localStorage.getItem('openlink-reconnect') || '{}');
        if (reconnectInfo.waitingForReboot) {
            // Try to reconnect
            try {
                const available = await checkRemoteAvailable(reconnectInfo.remoteId);
                if (available) {
                    clearInterval(state.reconnectPollInterval);
                    localStorage.removeItem('openlink-reconnect');
                    announce('Remote system is back online. Reconnecting...');
                    initiateConnection(reconnectInfo.sessionId);
                }
            } catch (e) {
                // Still waiting
            }
        } else {
            clearInterval(state.reconnectPollInterval);
        }
    }, 5000); // Check every 5 seconds
}

async function checkRemoteAvailable(remoteId) {
    // Ping signaling server to check if remote is available
    return new Promise((resolve) => {
        if (state.signalingSocket && state.signalingSocket.readyState === WebSocket.OPEN) {
            const checkTimeout = setTimeout(() => resolve(false), 3000);

            const handler = (event) => {
                const data = JSON.parse(event.data);
                if (data.type === 'ping-response' && data.from === remoteId) {
                    clearTimeout(checkTimeout);
                    state.signalingSocket.removeEventListener('message', handler);
                    resolve(true);
                }
            };

            state.signalingSocket.addEventListener('message', handler);
            state.signalingSocket.send(JSON.stringify({
                type: 'ping',
                target: remoteId
            }));
        } else {
            resolve(false);
        }
    });
}

// ==================== Data Channel Messages ====================

function handleDataMessage(data) {
    switch (data.type) {
        case 'input':
            // Handle remote input on host
            if (state.isHosting && document.getElementById('allow-input').checked) {
                window.openlink.executeRemoteInput(data);
            }
            break;

        case 'clipboard':
            if (document.getElementById('allow-clipboard')?.checked !== false) {
                window.openlink.setClipboard(data.text);
                announce('Received clipboard from remote');
            }
            break;

        case 'file':
            handleReceivedFile(data);
            break;

        case 'system-info':
            state.remoteSystemInfo = data.info;

            // If we're hosting, track this as a connected client
            if (state.isHosting && data.info) {
                const clientInfo = {
                    id: data.info.machineId || data.info.hostname || `client-${Date.now()}`,
                    name: data.info.hostname || 'Remote User',
                    device: data.info.platform || 'Unknown',
                    platform: data.info.platform || 'Unknown',
                    connectedAt: Date.now(),
                    walletAddress: data.info.walletAddress || null,
                    version: data.info.version || 'Unknown'
                };

                // Add to connected clients if not already there
                const existingIndex = state.connectedClients.findIndex(c => c.id === clientInfo.id);
                if (existingIndex === -1) {
                    state.connectedClients.push(clientInfo);
                } else {
                    state.connectedClients[existingIndex] = clientInfo;
                }

                // Record connection in history
                if (window.openlink?.recordClientConnection) {
                    window.openlink.recordClientConnection(clientInfo);
                }

                // Update tray with new client info
                updateConnectionStatusUI();
            }
            break;

        case 'request-info':
            // Send our system info
            window.openlink.getSystemInfo().then(info => {
                sendDataMessage({ type: 'system-info', info });
            });
            break;

        case 'swap-request':
            handleSwapRequest();
            break;

        case 'swap-accept':
            handleSwapAccept();
            break;

        case 'flip-session-request':
            handleFlipSessionRequest(data);
            break;

        case 'flip-session-accept':
            handleFlipSessionAccept();
            break;

        case 'flip-session-new-host':
            handleFlipSessionNewHost(data);
            break;

        case 'flip-session-reject':
            handleFlipSessionReject();
            break;

        case 'speak':
            // Local TTS for accessibility
            const utterance = new SpeechSynthesisUtterance(data.text);
            speechSynthesis.speak(utterance);
            break;

        case 'sync-capslock':
            // Sync capslock state from remote - turn off if requested
            window.openlink.setCapsLock(data.capsLockState);
            break;

        case 'system-command':
            handleRemoteSystemCommand(data);
            break;

        case 'peer-restarting':
            // Remote peer is restarting, prepare to reconnect
            handlePeerRestarting(data);
            break;

        case 'password-changed':
            // Host changed the session password - update our stored password
            handlePasswordChange(data.password, data.sessionId);
            break;
    }
}

async function handleRemoteSystemCommand(data) {
    switch (data.command) {
        case 'restart-app':
            // Remote wants us to restart
            announce('Received restart command from remote. Restarting...');
            if (data.reconnect && data.sessionId) {
                localStorage.setItem('openlink-reconnect', JSON.stringify({
                    sessionId: data.sessionId,
                    reconnect: true
                }));
            }
            window.openlink.systemCommand({ command: 'restart-app', reconnect: true });
            break;

        case 'restart-service':
            // Restart background service only
            announce('Restarting background service...');
            await window.openlink.systemCommand({ command: 'restart-service' });
            announce('Background service restarted');
            break;

        case 'system-reboot':
            // Full system reboot
            announce('System reboot initiated by remote...');
            if (data.reconnect && data.sessionId) {
                localStorage.setItem('openlink-reconnect', JSON.stringify({
                    sessionId: data.sessionId,
                    reconnect: true
                }));
            }
            window.openlink.systemCommand({ command: 'system-reboot' });
            break;
    }
}

function handlePeerRestarting(data) {
    announce('Remote peer is restarting. Waiting for reconnection...');
    showStatus('Remote is restarting. Waiting for reconnection...', 'info');

    // Save reconnect info
    if (data.reconnect && data.sessionId) {
        localStorage.setItem('openlink-reconnect', JSON.stringify({
            sessionId: data.sessionId,
            waitingForPeer: true,
            isHosting: state.isHosting
        }));
    }

    // Start polling for reconnection
    startReconnectPolling();
}

// ==================== File Transfer ====================

async function sendFile() {
    const fileInput = document.getElementById('file-input');
    const file = fileInput.files[0];
    if (!file) return;

    const progressContainer = document.getElementById('file-progress');
    const progressBar = document.getElementById('transfer-progress');
    const statusText = document.getElementById('transfer-status');

    progressContainer.hidden = false;
    document.getElementById('send-file-btn').disabled = true;

    try {
        const reader = new FileReader();
        reader.onload = () => {
            const base64 = reader.result.split(',')[1];

            // Send in chunks
            const chunkSize = 16384; // 16KB chunks
            const totalChunks = Math.ceil(base64.length / chunkSize);

            for (let i = 0; i < totalChunks; i++) {
                const chunk = base64.slice(i * chunkSize, (i + 1) * chunkSize);
                sendDataMessage({
                    type: 'file',
                    fileName: file.name,
                    chunk: chunk,
                    chunkIndex: i,
                    totalChunks: totalChunks,
                    isBase64: true
                });

                const progress = Math.round(((i + 1) / totalChunks) * 100);
                progressBar.value = progress;
                statusText.textContent = `Sending... ${progress}%`;
            }

            announce(`File ${file.name} sent`);
            closeModal('file-dialog');
        };

        reader.readAsDataURL(file);
    } catch (e) {
        console.error('File transfer failed:', e);
        statusText.textContent = `Error: ${e.message}`;
    }
}

const fileChunks = {};

async function handleReceivedFile(data) {
    const { fileName, chunk, chunkIndex, totalChunks, isBase64 } = data;

    if (!fileChunks[fileName]) {
        fileChunks[fileName] = new Array(totalChunks);
    }

    fileChunks[fileName][chunkIndex] = chunk;

    // Check if complete
    const received = fileChunks[fileName].filter(c => c !== undefined).length;
    if (received === totalChunks) {
        const fullData = fileChunks[fileName].join('');
        delete fileChunks[fileName];

        const result = await window.openlink.saveReceivedFile({
            fileName,
            data: fullData,
            isBase64
        });

        if (result.success) {
            announce(`File ${fileName} received and saved`);
        } else {
            announce(`Failed to save file: ${result.error}`);
        }
    }
}

// ==================== Machine Details ====================

async function showMachineDetails() {
    let info = state.remoteSystemInfo;
    if (!info) {
        // Request from remote
        sendDataMessage({ type: 'request-info' });
        info = { hostname: 'Loading...' };
    }

    const fields = [
        ['Hostname', info.hostname],
        ['Platform', info.platform],
        ['Architecture', info.arch],
        ['OS Version', info.release],
        ['IP Address', info.ip],
        ['Total Memory', info.totalMemory],
        ['Free Memory', info.freeMemory],
        ['CPU Cores', info.cpus],
        ['CPU Model', info.cpuModel],
        ['Screen Resolution', info.screenResolution]
    ];

    // Format as readable text
    const detailText = fields
        .filter(([label, value]) => value)
        .map(([label, value]) => `${label}: ${value}`)
        .join('\n');

    // Show in native dialog
    await window.openlink.showNativeDialog({
        type: 'info',
        title: 'Remote Machine Details',
        message: info.hostname || 'Remote Computer',
        detail: detailText
    });
}

// ==================== Swap Control ====================

async function swapControl() {
    const confirmed = state.useNativeDialogs
        ? await window.openlink.confirmDialog({
            title: 'Swap Control',
            message: 'Request to swap control with the remote user?'
        })
        : confirm('Request to swap control with the remote user?');

    if (confirmed) {
        sendDataMessage({ type: 'swap-request' });
        announce('Swap request sent');
    }
}

async function handleSwapRequest() {
    // Use notification if in remote session, native dialog otherwise
    if (state.isConnected && !state.isHosting) {
        window.openlink.showNotification({
            title: 'Swap Control Request',
            body: 'Remote user wants to swap control. Check the control menu to respond.'
        });
        return;
    }

    const confirmed = state.useNativeDialogs
        ? await window.openlink.confirmDialog({
            title: 'Swap Control',
            message: 'Remote user wants to swap control. Accept?'
        })
        : confirm('Remote user wants to swap control. Accept?');

    if (confirmed) {
        sendDataMessage({ type: 'swap-accept' });
        state.isControlSwapped = !state.isControlSwapped;
        announce('Control swapped');
    }
}

function handleSwapAccept() {
    state.isControlSwapped = !state.isControlSwapped;
    announce('Control swapped');

    // Notify user
    if (state.useNativeDialogs) {
        window.openlink.showNotification({
            title: 'Control Swapped',
            body: 'You now have control of the remote computer.'
        });
    }
}

// ==================== Flip Session (Role Reversal) ====================

/**
 * Flip session - reverse host/client roles
 * If hosting alone: request remote machine to become host so we can connect to it
 * If connected: both machines swap roles - host becomes client, client becomes host
 */
async function flipSession() {
    // Check if we're connected or hosting alone
    if (!state.isConnected && !state.isHosting) {
        announce('Not in an active session');
        return;
    }

    const message = state.isHosting && !state.isConnected
        ? 'Start hosting on the remote machine and connect to it? This will set up the other machine as host.'
        : 'Flip the session? You will control the other machine instead of them controlling yours.';

    const confirmed = state.useNativeDialogs
        ? await window.openlink.confirmDialog({
            title: 'Flip Session',
            message: message
        })
        : confirm(message);

    if (confirmed) {
        if (state.isHosting && !state.isConnected) {
            // We're hosting alone - need to contact the remote machine via signaling
            announce('Sending flip request to remote machine...');
            // This will be handled by the signaling server or a direct connection
            initiateRemoteHostSetup();
        } else if (state.dataChannel && state.dataChannel.readyState === 'open') {
            // We're connected - send flip request via data channel
            sendDataMessage({
                type: 'flip-session-request',
                currentSessionId: state.currentSessionId,
                sessionPassword: state.sessionPassword
            });
            announce('Flip session request sent');
        }
    }
}

/**
 * Handle incoming flip session request
 * The remote side wants to reverse roles
 */
async function handleFlipSessionRequest(data) {
    const confirmed = state.useNativeDialogs
        ? await window.openlink.confirmDialog({
            title: 'Flip Session Request',
            message: 'Remote user wants to flip the session. You will become the host and they will connect to you. Accept?'
        })
        : confirm('Remote user wants to flip the session. Accept?');

    if (confirmed) {
        sendDataMessage({ type: 'flip-session-accept' });

        // Stop current session
        const wasHosting = state.isHosting;
        const oldSessionId = state.currentSessionId;
        const oldPassword = state.sessionPassword;

        // If we were the client, we become the host
        if (!wasHosting) {
            // Stop viewing remote, start hosting
            await stopViewing();

            // Generate new session or use provided one
            const newSessionId = generateSessionId();
            elements.sessionId.value = newSessionId;

            // Start hosting
            await startHosting();

            // Send new session details to the other side
            sendDataMessage({
                type: 'flip-session-new-host',
                newSessionId: newSessionId,
                newPassword: state.sessionPassword
            });

            announce('Session flipped. You are now hosting.');
        } else {
            // We were hosting, now become client - wait for remote to set up and send session info
            announce('Waiting for remote to set up hosting...');
        }
    } else {
        sendDataMessage({ type: 'flip-session-reject' });
    }
}

/**
 * Handle flip session accepted
 */
async function handleFlipSessionAccept() {
    announce('Flip session accepted. Switching roles...');

    if (state.isHosting) {
        // We were hosting, now become client
        // Stop hosting and wait for new session info
        const oldSessionId = state.currentSessionId;
        await stopHosting();
        announce('Waiting for new session details...');
    } else {
        // We were client, now become host
        await stopViewing();

        // Generate new session and start hosting
        const newSessionId = generateSessionId();
        elements.sessionId.value = newSessionId;

        await startHosting();

        // The other side will connect to us
        announce('You are now hosting. Waiting for remote to connect...');
    }
}

/**
 * Handle new host session info after flip
 */
async function handleFlipSessionNewHost(data) {
    // Other side is now hosting, connect to their new session
    announce('Connecting to flipped session...');

    // Small delay to let the other side fully initialize hosting
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Connect to the new session
    elements.sessionId.value = data.newSessionId;
    if (data.newPassword) {
        // Store the password for this session
        state.sessionPassword = data.newPassword;
    }

    await joinSession();
}

/**
 * Handle flip session rejected
 */
function handleFlipSessionReject() {
    announce('Flip session request was declined');
    if (state.useNativeDialogs) {
        window.openlink.showNotification({
            title: 'Flip Session Declined',
            body: 'The remote user declined to flip the session.'
        });
    }
}

/**
 * Initiate remote host setup when hosting alone
 * This contacts the target machine to start hosting
 */
async function initiateRemoteHostSetup() {
    // Get the machine ID we want to connect to
    const targetMachineId = prompt('Enter the machine ID to connect to:');
    if (!targetMachineId) return;

    // Send setup request via signaling server
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({
            type: 'remote-host-setup',
            targetMachineId: targetMachineId.trim(),
            fromMachineId: state.machineId
        }));
        announce('Remote host setup request sent to ' + targetMachineId);
    } else {
        announce('Not connected to signaling server');
    }
}

/**
 * Handle incoming remote host setup request
 * Someone wants us to start hosting so they can connect
 */
async function handleRemoteHostSetupRequest(fromMachineId) {
    const confirmed = state.useNativeDialogs
        ? await window.openlink.confirmDialog({
            title: 'Remote Host Request',
            message: `Machine ${fromMachineId} wants you to start hosting so they can control your computer. Accept?`
        })
        : confirm(`Machine ${fromMachineId} wants you to start hosting so they can control your computer. Accept?`);

    if (confirmed) {
        // Start hosting
        const newSessionId = generateSessionId();
        elements.sessionId.value = newSessionId;

        await startHosting();

        // Send session info back via signaling
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({
                type: 'remote-host-ready',
                targetMachineId: fromMachineId,
                sessionId: newSessionId,
                password: state.sessionPassword
            }));
        }

        announce('Started hosting for remote connection');
    } else {
        // Decline
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({
                type: 'remote-host-declined',
                targetMachineId: fromMachineId
            }));
        }
    }
}

/**
 * Handle remote host ready response
 * The target machine started hosting, now connect
 */
async function handleRemoteHostReady(data) {
    announce('Remote machine is now hosting. Connecting...');

    // Stop our current hosting if any
    if (state.isHosting) {
        await stopHosting();
    }

    // Connect to the new session
    elements.sessionId.value = data.sessionId;
    state.sessionPassword = data.password;

    await joinSession();
}

// ==================== Wallet-Based Quick Connect ====================

/**
 * Register our wallet address with the signaling server
 * This allows other devices with the same wallet to find us
 */
function registerWalletWithSignaling() {
    const walletAddress = state.settings?.walletAddress || localStorage.getItem('ecripto-wallet');
    if (!walletAddress || !state.ws) return;

    state.ws.send(JSON.stringify({
        type: 'register-wallet',
        walletAddress: walletAddress,
        machineId: state.machineId,
        machineName: state.machineName || window.openlink?.getHostname?.() || 'This Computer'
    }));
}

/**
 * Find other devices linked to the same wallet
 */
function findWalletLinkedDevices() {
    const walletAddress = state.settings?.walletAddress || localStorage.getItem('ecripto-wallet');
    if (!walletAddress) {
        announce('No wallet configured. Set up eCripto wallet in Settings.');
        return;
    }

    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
        announce('Not connected to signaling server');
        return;
    }

    state.ws.send(JSON.stringify({
        type: 'wallet-connect',
        walletAddress: walletAddress
    }));

    announce('Searching for linked devices...');
}

/**
 * Handle list of devices with same wallet
 */
async function handleWalletDevices(devices) {
    if (!devices || devices.length === 0) {
        announce('No other devices found with your wallet');
        return;
    }

    // Store for UI display
    state.linkedDevices = devices;

    // Show device selection dialog
    const deviceList = devices.map((d, i) => `${i + 1}. ${d.machineName} (${d.platform})`).join('\n');

    const message = `Found ${devices.length} linked device(s):\n\n${deviceList}\n\nConnect to one of these devices?`;

    if (state.useNativeDialogs) {
        // Use native dialog with device selection
        const result = await window.openlink.confirmDialog({
            title: 'Wallet-Linked Devices',
            message: message
        });

        if (result && devices.length === 1) {
            // Auto-connect to single device
            connectToWalletDevice(devices[0]);
        } else if (result && devices.length > 1) {
            // Show device picker
            showWalletDevicePicker(devices);
        }
    } else {
        // Simple confirm for web
        if (confirm(message)) {
            if (devices.length === 1) {
                connectToWalletDevice(devices[0]);
            } else {
                const choice = prompt(`Enter device number (1-${devices.length}):`);
                const idx = parseInt(choice) - 1;
                if (idx >= 0 && idx < devices.length) {
                    connectToWalletDevice(devices[idx]);
                }
            }
        }
    }
}

/**
 * Show device picker for wallet-linked devices
 */
function showWalletDevicePicker(devices) {
    // Create modal or use existing mechanism
    const content = devices.map((device, idx) => `
        <button class="wallet-device-btn" data-idx="${idx}">
            ${device.machineName}
            <small>${device.platform} - ${device.os}</small>
        </button>
    `).join('');

    announce(`Select a device to connect to. ${devices.length} devices available.`);
    // For now, just connect to first device
    connectToWalletDevice(devices[0]);
}

/**
 * Connect to a wallet-linked device
 * Request that device to start hosting so we can connect
 */
function connectToWalletDevice(device) {
    announce(`Requesting ${device.machineName} to start hosting...`);

    state.ws.send(JSON.stringify({
        type: 'remote-host-setup',
        targetMachineId: device.machineId,
        fromMachineId: state.machineId
    }));
}

// ==================== macOS Permission Management ====================

/**
 * Check macOS permissions on startup and prompt if needed
 */
async function checkMacOSPermissionsOnStartup() {
    // Only applies to macOS
    if (!window.openlink?.checkMacPermissions) {
        console.log('[Permissions] Not on macOS or API not available');
        return;
    }

    try {
        const permissions = await window.openlink.checkMacPermissions();
        console.log('[Permissions] Current status:', permissions);

        const screenGranted = permissions.screen?.granted;
        const accessibilityGranted = permissions.accessibility?.granted;

        // Store permission state for later reference
        state.macPermissions = permissions;

        // Update UI indicators
        updatePermissionIndicators(permissions);

        // If both permissions are granted, we're good
        if (screenGranted && accessibilityGranted) {
            console.log('[Permissions] All required permissions granted');
            return;
        }

        // Check if this is first launch (setup not complete)
        const hasCompletedSetup = state.settings?.setupComplete;

        // Only auto-prompt on first launch or if user hasn't dismissed recently
        if (!hasCompletedSetup) {
            console.log('[Permissions] First launch - triggering permission prompts');

            // Trigger screen recording prompt first
            if (!screenGranted) {
                console.log('[Permissions] Triggering screen recording prompt...');
                const screenResult = await window.openlink.triggerMacPermissionPrompt('screen');
                console.log('[Permissions] Screen recording prompt result:', screenResult);
            }

            // Then trigger accessibility prompt
            if (!accessibilityGranted) {
                console.log('[Permissions] Triggering accessibility prompt...');
                const accessResult = await window.openlink.triggerMacPermissionPrompt('accessibility');
                console.log('[Permissions] Accessibility prompt result:', accessResult);
            }

            // Re-check permissions after prompts
            await new Promise(resolve => setTimeout(resolve, 1000));
            const updatedPermissions = await window.openlink.checkMacPermissions();
            updatePermissionIndicators(updatedPermissions);
            state.macPermissions = updatedPermissions;
        }
    } catch (error) {
        console.error('[Permissions] Error checking permissions:', error);
    }
}

/**
 * Update permission status indicators in the UI
 */
function updatePermissionIndicators(permissions) {
    // Update Host tab with permission status
    const hostTab = document.getElementById('host-tab');
    if (!hostTab) return;

    // Create or update permission status banner
    let permBanner = document.getElementById('permission-status-banner');
    if (!permBanner) {
        permBanner = document.createElement('div');
        permBanner.id = 'permission-status-banner';
        permBanner.className = 'permission-banner';
        permBanner.setAttribute('role', 'alert');
        hostTab.insertBefore(permBanner, hostTab.firstChild);
    }

    const screenGranted = permissions.screen?.granted;
    const accessibilityGranted = permissions.accessibility?.granted;

    if (screenGranted && accessibilityGranted) {
        permBanner.className = 'permission-banner permission-granted';
        permBanner.innerHTML = `
            <span class="permission-icon">✓</span>
            <span>All permissions granted - ready to host</span>
        `;
    } else {
        const missing = [];
        if (!screenGranted) missing.push('Screen Recording');
        if (!accessibilityGranted) missing.push('Accessibility');

        permBanner.className = 'permission-banner permission-missing';
        permBanner.innerHTML = `
            <span class="permission-icon">⚠</span>
            <span>Missing: ${missing.join(', ')}</span>
            <button onclick="openPermissionSetup()" class="btn btn-sm">Grant Permissions</button>
        `;
    }
}

/**
 * Open permission setup dialog
 */
async function openPermissionSetup() {
    try {
        // Try the sudo method first (will prompt for admin password)
        const result = await window.openlink.grantPermissionsWithSudo();

        if (result.success) {
            announce(result.message);
            // Refresh permission status
            const permissions = await window.openlink.checkMacPermissions();
            updatePermissionIndicators(permissions);
        } else if (result.sipEnabled) {
            // SIP is enabled, show manual setup dialog
            announce('Opening permission settings...');
            await window.openlink.showPermissionSetup();
        } else {
            // Other error - show manual setup
            await window.openlink.showPermissionSetup();
        }
    } catch (error) {
        console.error('[Permissions] Error opening setup:', error);
        // Fallback to opening System Settings directly
        await window.openlink.openPermissionSettings('privacy');
    }
}

/**
 * Refresh permission status
 */
async function refreshPermissionStatus() {
    if (!window.openlink?.checkMacPermissions) return;

    try {
        const permissions = await window.openlink.checkMacPermissions();
        state.macPermissions = permissions;
        updatePermissionIndicators(permissions);
        return permissions;
    } catch (error) {
        console.error('[Permissions] Error refreshing status:', error);
        return null;
    }
}

// ==================== Permissions ====================

// Current pending connection request
let pendingConnectionRequest = null;

function showPermissions() {
    hideRemoteView();
    switchTab('settings');
    // Focus on connection permission dropdown
    setTimeout(() => {
        elements.connectionPermission?.focus();
    }, 100);
    announce('Connection permissions settings');
}

// Show connection request dialog (called when someone wants to connect)
async function showConnectionRequest(machineId, machineName) {
    pendingConnectionRequest = { machineId, machineName };

    // Check if we should use native dialog
    if (state.useNativeDialogs && !state.isConnected) {
        const result = await window.openlink.showConnectionRequest({
            machineId,
            machineName
        });

        if (result) {
            handleConnectionResponse(result.allow ? 'allow' : 'deny', result.remember);
        }
        return;
    }

    // Use in-app dialog
    document.getElementById('request-message').textContent =
        `${machineName || machineId} wants to connect to your computer.`;

    openModal('connection-request');
}

// Handle connection request response
function handleConnectionResponse(action, remember) {
    closeModal('connection-request');

    if (!pendingConnectionRequest) {
        console.warn('No pending connection request');
        return;
    }

    const { machineId, machineName } = pendingConnectionRequest;
    const allowed = action === 'allow';

    // Save permission if "remember" was selected
    if (remember) {
        window.openlink.setMachinePermission(machineId, allowed ? 'always' : 'never');
        announce(`${allowed ? 'Always allowing' : 'Always denying'} connections from ${machineName || machineId}`);
    }

    // Send response back via signaling
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({
            type: 'connection-response',
            machineId: machineId,
            allowed: allowed
        }));
    }

    if (allowed) {
        announce(`Connection from ${machineName || machineId} allowed`);

        // Start WebRTC offer if we have a pending offer function
        if (state.pendingOfferResolve) {
            state.pendingOfferResolve();
            state.pendingOfferResolve = null;
        }
    } else {
        announce(`Connection from ${machineName || machineId} denied`);
    }

    pendingConnectionRequest = null;
}

// ==================== Restart Remote ====================

async function restartRemote() {
    const confirmed = state.useNativeDialogs
        ? await window.openlink.confirmDialog({
            title: 'Restart Remote Computer',
            message: 'Are you sure you want to restart the remote computer? This will end the current session.'
        })
        : confirm('Are you sure you want to restart the remote computer?');

    if (confirmed) {
        sendDataMessage({ type: 'system-command', command: 'restart' });
        announce('Restart command sent');

        // Show notification
        if (state.useNativeDialogs) {
            window.openlink.showNotification({
                title: 'Restart Command Sent',
                body: 'The remote computer will restart shortly.'
            });
        }
    }
}

// ==================== Dialog Manager ====================
// Only one dialog at a time, with queue support and native dialog option

const DialogManager = {
    // Show a dialog - queues if one is already open
    async show(options) {
        const { id, type, title, message, buttons, useNative } = options;

        // If in remote session, use system notification instead
        if (state.isConnected && !state.isHosting) {
            this.showNotification(title, message);
            return null;
        }

        // Use native dialog if preferred and available
        if ((useNative !== false) && state.useNativeDialogs && window.openlink?.showNativeDialog) {
            return await this.showNativeDialog(options);
        }

        // Queue if another dialog is open
        if (state.activeDialog) {
            return new Promise((resolve) => {
                state.dialogQueue.push({ options, resolve });
            });
        }

        return await this.showInAppDialog(options);
    },

    // Show native OS dialog
    async showNativeDialog(options) {
        const { type, title, message, buttons } = options;
        try {
            const result = await window.openlink.showNativeDialog({
                type: type || 'question',
                title: title || 'OpenLink',
                message: message,
                buttons: buttons || ['OK']
            });
            return result;
        } catch (e) {
            // Fall back to in-app dialog
            return await this.showInAppDialog(options);
        }
    },

    // Show in-app modal dialog
    showInAppDialog(options) {
        return new Promise((resolve) => {
            const { id, title, message, buttons } = options;

            state.activeDialog = { id, resolve };

            const modal = document.getElementById(id);
            if (modal) {
                // Update message if provided
                const msgEl = modal.querySelector('.modal-message, #request-message');
                if (msgEl && message) {
                    msgEl.textContent = message;
                }

                modal.hidden = false;
                modal.querySelector('button')?.focus();
            }
        });
    },

    // Close current dialog and process queue
    close(result) {
        if (state.activeDialog) {
            const { id, resolve } = state.activeDialog;
            const modal = document.getElementById(id);
            if (modal) {
                modal.hidden = true;
            }
            resolve(result);
            state.activeDialog = null;

            // Process queue
            if (state.dialogQueue.length > 0) {
                const next = state.dialogQueue.shift();
                this.show(next.options).then(next.resolve);
            }
        }
    },

    // Show system notification (for remote sessions)
    showNotification(title, message) {
        if ('Notification' in window && Notification.permission === 'granted') {
            new Notification(title, { body: message });
        } else {
            announce(`${title}: ${message}`);
        }
    },

    // Dismiss without result
    dismiss() {
        this.close(null);
    }
};

function openModal(modalId) {
    // Use dialog manager for proper queuing
    if (state.activeDialog && state.activeDialog.id !== modalId) {
        // Already have a dialog, queue this one
        state.dialogQueue.push({
            options: { id: modalId },
            resolve: () => {}
        });
        return;
    }

    const modal = document.getElementById(modalId);
    if (modal) {
        state.activeDialog = { id: modalId, resolve: () => {} };
        modal.hidden = false;
        modal.removeAttribute('aria-hidden');
        modal.removeAttribute('inert');
        modal.querySelector('input, button')?.focus();
    }
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.hidden = true;
        modal.setAttribute('aria-hidden', 'true');
        modal.setAttribute('inert', '');
    }

    if (state.activeDialog && state.activeDialog.id === modalId) {
        state.activeDialog = null;

        // Process queue
        if (state.dialogQueue.length > 0) {
            const next = state.dialogQueue.shift();
            setTimeout(() => {
                openModal(next.options.id);
                if (next.resolve) next.resolve();
            }, 100);
        }
    }
}

// Close all dialogs
function closeAllDialogs() {
    document.querySelectorAll('.modal, .control-menu').forEach(modal => {
        modal.hidden = true;
        modal.setAttribute('aria-hidden', 'true');
        modal.setAttribute('inert', '');
    });
    state.activeDialog = null;
    state.dialogQueue = [];
    state.controlMenuOpen = false;
}

// ==================== Payment Integration ====================

function togglePaymentSettings() {
    elements.paymentSettings.hidden = !elements.requirePayment.checked;
}

async function showPaymentRequest(amount) {
    // Always use native dialog for payment requests - better screen reader support
    const walletStatus = state.eCriptoAvailable
        ? 'eCripto wallet detected.'
        : 'Payment will be processed through available wallet provider.';

    const result = await window.openlink.showNativeDialog({
        type: 'question',
        buttons: ['Accept & Help', 'Decline'],
        defaultId: 0,
        title: 'Support Payment Offered',
        message: `The person requesting help is offering payment for your assistance.`,
        detail: `Amount offered: ${amount}\n\n${walletStatus}`
    });

    if (result.response === 0) {
        // Accept & Help - proceed with connection
        processPayment(amount);
    } else {
        // Decline
        handleDisconnect();
    }
}

async function processPayment(amount) {
    announce('Processing payment...');

    try {
        // Get host info for payment
        const hostInfo = {
            sessionId: state.sessionId,
            walletAddress: state.remoteSystemInfo?.walletAddress,
            hostId: state.remoteSystemInfo?.hostname
        };

        // Use eCripto API which checks available methods
        const result = await window.ecripto.processAccessPayment(hostInfo, amount);

        if (result.error) {
            throw new Error(result.error);
        }

        if (result.method === 'direct') {
            // Direct payment successful
            sendDataMessage({ type: 'payment-complete', transactionId: result.transactionId });
            closeModal('payment-request');
            announce('Payment successful');
        } else if (result.method === 'web') {
            // Open web payment link
            announce('Opening web payment...');
            window.open(result.paymentUrl, '_blank');
            // Will need callback to confirm payment
        }
    } catch (e) {
        announce(`Payment failed: ${e.message}`);
    }
}

async function checkEcriptoAvailability() {
    try {
        // Check if eCripto API is available and get status
        if (typeof window.ecripto !== 'undefined') {
            const status = await window.ecripto.getStatus();
            state.eCriptoAvailable = status.connected;
            state.eCriptoCapabilities = status.capabilities || [];
            state.eCriptoMode = status.mode;
            console.log(`[eCripto] Status: ${status.mode || 'not connected'}, Capabilities: ${state.eCriptoCapabilities.join(', ')}`);
        } else {
            state.eCriptoAvailable = false;
            state.eCriptoCapabilities = [];
        }
    } catch (e) {
        console.error('[eCripto] Error checking availability:', e);
        state.eCriptoAvailable = false;
        state.eCriptoCapabilities = [];
    }
}

// ==================== Recent Connections ====================

function updateRecentConnections(connections) {
    const list = elements.recentConnections;
    list.innerHTML = '';

    if (connections.length === 0) {
        const li = document.createElement('li');
        li.className = 'empty-state';
        li.textContent = 'No recent connections';
        list.appendChild(li);
        return;
    }

    connections.forEach(conn => {
        const li = document.createElement('li');
        li.innerHTML = `
            <div>
                <span class="connection-name">${conn.name || conn.sessionId}</span>
                <span class="connection-time">${formatTime(conn.lastConnected)}</span>
            </div>
            <button class="btn secondary" data-session="${conn.sessionId}">Connect</button>
        `;

        li.querySelector('button').addEventListener('click', () => {
            elements.sessionIdInput.value = conn.sessionId;
            connect();
        });

        list.appendChild(li);
    });
}

// ==================== Settings ====================

async function saveSettings() {
    // Determine startup behavior from radio buttons
    const startMinimized = elements.startupMinimized?.checked || elements.startMinimized?.checked || false;
    const closeBehavior = elements.closeQuit?.checked ? 'quit' : 'tray';

    const settings = {
        runAtLogin: elements.runAtLogin.checked,
        startMinimized: startMinimized,
        keepWindowVisible: elements.keepWindowVisible?.checked || false,
        closeBehavior: closeBehavior,
        autoCopyUrl: elements.autoCopyUrl?.checked || false,
        allowDropin: elements.allowDropin?.checked ?? true,
        clipboardSettings: {
            enableSharing: elements.enableClipboard.checked,
            doubleCopyTransfer: elements.doubleCopyTransfer.checked
        },
        walletAddress: elements.walletAddress.value.trim(),
        walletNetwork: elements.walletNetwork?.value || 'ecripto',
        savedWallets: state.savedWallets || [],
        autoConnectWallet: elements.autoConnectWallet?.checked || false,
        eCriptoEnabled: elements.ecriptoEnabled?.checked || false,
        // Connection permission settings
        allowRemoteConnections: elements.connectionPermission?.value || 'ask',
        // Host settings
        shareAudio: document.getElementById('share-audio')?.checked ?? true,
        allowInput: document.getElementById('allow-input')?.checked ?? true,
        allowClipboard: document.getElementById('allow-clipboard')?.checked ?? true,
        allowFiles: document.getElementById('allow-files')?.checked ?? true,
        // Native dialogs
        useNativeDialogs: document.getElementById('use-native-dialogs')?.checked ?? true,
        // Session persistence
        persistSessionId: document.getElementById('persist-session-id')?.checked ?? true,
        autoHostStartup: document.getElementById('auto-host-startup')?.checked ?? false,
        customSessionId: document.getElementById('custom-session-id')?.value?.trim() || '',
        deviceNickname: document.getElementById('device-nickname')?.value?.trim() || '',
        sessionPassword: document.getElementById('session-password')?.value?.trim() || '',
        sessionIdWords: document.getElementById('session-id-words')?.value?.trim() || '',
        // Server selection
        selectedServer: elements.serverSelect?.value || ''
    };

    // Update local state immediately
    state.settings = { ...state.settings, ...settings };

    await window.openlink.saveSettings(settings);
    announce('Settings saved');
}

// ==================== Wallet Management ====================

/**
 * Render the saved wallets list
 */
function renderSavedWallets() {
    const container = elements.savedWalletsList;
    if (!container) return;

    const wallets = state.savedWallets || [];

    if (wallets.length === 0) {
        container.innerHTML = '<p class="help-text">No saved wallets yet</p>';
        return;
    }

    container.innerHTML = wallets.map((wallet, index) => `
        <div class="wallet-item" data-index="${index}">
            <div class="wallet-info">
                <span class="wallet-label">${wallet.label || 'Wallet ' + (index + 1)}</span>
                <code class="wallet-address">${truncateAddress(wallet.address)}</code>
                <span class="wallet-network">${wallet.network || 'unknown'}</span>
            </div>
            <div class="wallet-actions">
                <button class="btn secondary small" onclick="setAsPrimaryWallet(${index})" aria-label="Set as primary">Use</button>
                <button class="btn secondary small" onclick="copyWalletAddress(${index})" aria-label="Copy address">Copy</button>
                <button class="btn danger small" onclick="removeSavedWallet(${index})" aria-label="Remove wallet">Remove</button>
            </div>
        </div>
    `).join('');
}

/**
 * Truncate wallet address for display
 */
function truncateAddress(address) {
    if (!address || address.length < 15) return address;
    return address.substring(0, 8) + '...' + address.substring(address.length - 6);
}

/**
 * Add a wallet to saved wallets
 */
async function addSavedWallet() {
    const address = elements.newWalletAddress?.value.trim();
    const label = elements.newWalletLabel?.value.trim();
    const network = elements.walletNetwork?.value || 'ecripto';

    if (!address) {
        announce('Please enter a wallet address');
        return;
    }

    // Validate address format (basic check)
    if (address.length < 26) {
        announce('Invalid wallet address');
        return;
    }

    if (!state.savedWallets) {
        state.savedWallets = [];
    }

    // Check for duplicate
    if (state.savedWallets.some(w => w.address.toLowerCase() === address.toLowerCase())) {
        announce('This wallet is already saved');
        return;
    }

    state.savedWallets.push({
        address,
        label: label || `Wallet ${state.savedWallets.length + 1}`,
        network,
        addedAt: new Date().toISOString()
    });

    // Clear inputs
    if (elements.newWalletAddress) elements.newWalletAddress.value = '';
    if (elements.newWalletLabel) elements.newWalletLabel.value = '';

    renderSavedWallets();
    await saveSettings();
    announce(`Wallet ${label || 'added'} successfully`);
}

/**
 * Remove a saved wallet
 */
async function removeSavedWallet(index) {
    if (!state.savedWallets || index < 0 || index >= state.savedWallets.length) return;

    const wallet = state.savedWallets[index];
    state.savedWallets.splice(index, 1);

    renderSavedWallets();
    await saveSettings();
    announce(`Wallet ${wallet.label || 'removed'}`);
}

/**
 * Set a saved wallet as the primary wallet
 */
async function setAsPrimaryWallet(index) {
    if (!state.savedWallets || index < 0 || index >= state.savedWallets.length) return;

    const wallet = state.savedWallets[index];
    if (elements.walletAddress) {
        elements.walletAddress.value = wallet.address;
    }
    if (elements.walletNetwork && wallet.network) {
        elements.walletNetwork.value = wallet.network;
    }

    await saveSettings();
    announce(`${wallet.label || 'Wallet'} set as primary`);
}

/**
 * Copy a wallet address to clipboard
 */
function copyWalletAddress(index) {
    if (!state.savedWallets || index < 0 || index >= state.savedWallets.length) return;

    const wallet = state.savedWallets[index];
    if (window.openlink && window.openlink.setClipboard) {
        window.openlink.setClipboard(wallet.address);
    } else {
        navigator.clipboard.writeText(wallet.address);
    }
    announce('Wallet address copied to clipboard');
}

/**
 * Detect wallets on the current device
 */
async function detectWallets() {
    announce('Detecting wallets...');

    try {
        // Try to detect local wallet applications
        const detectedWallets = [];

        // Check for browser wallet providers
        if (typeof window.ethereum !== 'undefined') {
            try {
                const accounts = await window.ethereum.request({ method: 'eth_accounts' });
                if (accounts && accounts.length > 0) {
                    accounts.forEach(addr => {
                        detectedWallets.push({
                            address: addr,
                            type: 'browser',
                            network: 'ethereum',
                            label: 'Browser Wallet'
                        });
                    });
                }
            } catch (e) {
                console.warn('Failed to get browser wallet accounts:', e);
            }
        }

        // Show detected wallets
        if (detectedWallets.length > 0) {
            showDetectedWallets(detectedWallets);
            announce(`Found ${detectedWallets.length} wallet(s)`);
        } else {
            announce('No wallets detected. Try connecting a browser wallet.');
        }
    } catch (e) {
        console.error('Wallet detection failed:', e);
        announce('Wallet detection failed');
    }
}

/**
 * Show detected wallets in the UI
 */
function showDetectedWallets(wallets) {
    if (!elements.detectedWalletsSection || !elements.detectedWalletsList) return;

    elements.detectedWalletsSection.hidden = false;
    elements.detectedWalletsList.innerHTML = wallets.map((wallet, index) => `
        <div class="wallet-item detected" data-index="${index}">
            <div class="wallet-info">
                <span class="wallet-label">${wallet.label || wallet.type}</span>
                <code class="wallet-address">${truncateAddress(wallet.address)}</code>
                <span class="wallet-network">${wallet.network}</span>
            </div>
            <button class="btn primary small" onclick="addDetectedWallet('${wallet.address}', '${wallet.network}', '${wallet.label || ''}')">
                Add
            </button>
        </div>
    `).join('');
}

/**
 * Add a detected wallet to saved wallets
 */
async function addDetectedWallet(address, network, label) {
    if (elements.newWalletAddress) elements.newWalletAddress.value = address;
    if (elements.newWalletLabel) elements.newWalletLabel.value = label;
    if (elements.walletNetwork) elements.walletNetwork.value = network;

    await addSavedWallet();
}

/**
 * Scan network for wallets (eCripto network discovery)
 */
async function scanNetworkForWallets() {
    announce('Scanning network for wallets...');

    // This would connect to eCripto network and discover wallets
    // For now, show a placeholder message
    const network = elements.walletNetwork?.value || 'ecripto';

    if (network === 'ecripto') {
        try {
            // Try to connect to eCripto node
            updateEcriptoStatus('scanning');
            announce('Scanning eCripto network...');

            // Simulated scan - in production would connect to eCripto nodes
            setTimeout(() => {
                updateEcriptoStatus('connected');
                announce('Network scan complete. No new wallets found.');
            }, 2000);
        } catch (e) {
            updateEcriptoStatus('error');
            announce('Network scan failed');
        }
    } else {
        announce(`Network scanning not yet available for ${network}`);
    }
}

/**
 * Connect to browser wallet (MetaMask, etc.)
 */
async function connectBrowserWallet() {
    announce('Connecting to browser wallet...');

    if (typeof window.ethereum === 'undefined') {
        announce('No browser wallet detected. Please install MetaMask or another wallet extension.');
        return;
    }

    try {
        const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });

        if (accounts && accounts.length > 0) {
            // Set the first account as primary
            if (elements.walletAddress) {
                elements.walletAddress.value = accounts[0];
            }

            // Add to saved wallets
            if (!state.savedWallets) state.savedWallets = [];
            if (!state.savedWallets.some(w => w.address.toLowerCase() === accounts[0].toLowerCase())) {
                state.savedWallets.push({
                    address: accounts[0],
                    label: 'Browser Wallet',
                    network: 'ethereum',
                    addedAt: new Date().toISOString()
                });
                renderSavedWallets();
            }

            await saveSettings();
            announce(`Connected to browser wallet: ${truncateAddress(accounts[0])}`);
        }
    } catch (e) {
        console.error('Failed to connect browser wallet:', e);
        if (e.code === 4001) {
            announce('Connection rejected by user');
        } else {
            announce('Failed to connect to browser wallet');
        }
    }
}

/**
 * Update eCripto connection status display
 */
function updateEcriptoStatus(status) {
    const statusEl = elements.ecriptoNetworkStatus;
    const containerEl = document.getElementById('ecripto-connection-status');

    if (!statusEl) return;

    switch (status) {
        case 'connected':
            statusEl.textContent = 'Connected to eCripto Network';
            if (containerEl) containerEl.className = 'connection-status connected';
            break;
        case 'scanning':
            statusEl.textContent = 'Scanning...';
            if (containerEl) containerEl.className = 'connection-status scanning';
            break;
        case 'error':
            statusEl.textContent = 'Connection Error';
            if (containerEl) containerEl.className = 'connection-status error';
            break;
        default:
            statusEl.textContent = 'Not connected';
            if (containerEl) containerEl.className = 'connection-status';
    }
}

/**
 * Sync wallets with server nodes for backup/recovery
 */
async function syncWalletsToServer() {
    if (!state.savedWallets || state.savedWallets.length === 0) {
        return;
    }

    const syncStatusEl = document.getElementById('wallet-sync-status');
    if (syncStatusEl) {
        syncStatusEl.className = 'sync-status syncing';
        syncStatusEl.textContent = 'Syncing wallets...';
    }

    try {
        // Get available servers
        const servers = await window.servers.getServers();
        const onlineServer = servers.find(s => s.status === 'online');

        if (!onlineServer) {
            throw new Error('No online server available');
        }

        // Get device identifier for wallet association
        const systemInfo = await window.openlink.getSystemInfo();
        const deviceId = state.keyId || `openlink.${systemInfo.hostname}`;

        // Encrypt wallet data for transmission (public addresses only, not private keys)
        const walletData = {
            deviceId,
            wallets: state.savedWallets.map(w => ({
                address: w.address,
                network: w.network,
                label: w.label,
                addedAt: w.addedAt
            })),
            lastSync: new Date().toISOString()
        };

        // Send to server
        const response = await fetch(`${onlineServer.url}/api/wallets/sync`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(walletData)
        });

        if (response.ok) {
            const result = await response.json();
            state.lastWalletSync = new Date().toISOString();

            if (syncStatusEl) {
                syncStatusEl.className = 'sync-status synced';
                syncStatusEl.textContent = `Synced to ${result.serverCount || 1} node(s)`;
            }

            console.log('Wallets synced successfully:', result);
        } else {
            throw new Error(`Server returned ${response.status}`);
        }
    } catch (e) {
        console.warn('Wallet sync failed:', e);
        if (syncStatusEl) {
            syncStatusEl.className = 'sync-status error';
            syncStatusEl.textContent = 'Sync failed - will retry';
        }
    }
}

/**
 * Restore wallets from server backup
 */
async function restoreWalletsFromServer() {
    announce('Restoring wallets from server...');

    try {
        const servers = await window.servers.getServers();
        const onlineServer = servers.find(s => s.status === 'online');

        if (!onlineServer) {
            announce('No online server available for wallet restore');
            return;
        }

        const systemInfo = await window.openlink.getSystemInfo();
        const deviceId = state.keyId || `openlink.${systemInfo.hostname}`;

        const response = await fetch(`${onlineServer.url}/api/wallets/restore?deviceId=${encodeURIComponent(deviceId)}`);

        if (response.ok) {
            const data = await response.json();

            if (data.wallets && data.wallets.length > 0) {
                // Merge with existing wallets (avoid duplicates)
                const existingAddresses = new Set(state.savedWallets.map(w => w.address.toLowerCase()));

                data.wallets.forEach(wallet => {
                    if (!existingAddresses.has(wallet.address.toLowerCase())) {
                        state.savedWallets.push(wallet);
                    }
                });

                renderSavedWallets();
                await saveSettings();
                announce(`Restored ${data.wallets.length} wallet(s) from server`);
            } else {
                announce('No wallets found on server');
            }
        } else {
            announce('Failed to restore wallets from server');
        }
    } catch (e) {
        console.error('Wallet restore failed:', e);
        announce('Wallet restore failed');
    }
}

// ==================== Phone/Email Verification ====================

// Store pending verification info
let pendingVerification = {
    phone: { codeId: null },
    email: { codeId: null }
};

/**
 * Initialize verification status on load
 */
async function initializeVerificationStatus() {
    if (!window.openlink?.verification) return;

    try {
        const status = await window.openlink.verification.getStatus();
        updateVerificationUI(status);
    } catch (e) {
        console.error('[Verification] Failed to get status:', e);
    }
}

/**
 * Update verification UI based on status
 */
function updateVerificationUI(status) {
    // Phone status
    const phoneStatus = document.getElementById('verify-phone-status');
    const phoneInputSection = document.getElementById('phone-input-section');
    if (phoneStatus && status.methods.phone?.verified) {
        phoneStatus.textContent = `Verified: ${status.methods.phone.number}`;
        phoneStatus.classList.add('verified');
        if (phoneInputSection) phoneInputSection.hidden = true;
    }

    // Email status
    const emailStatus = document.getElementById('verify-email-status');
    const emailInputSection = document.getElementById('email-input-section');
    if (emailStatus && status.methods.email?.verified) {
        emailStatus.textContent = `Verified: ${status.methods.email.address}`;
        emailStatus.classList.add('verified');
        if (emailInputSection) emailInputSection.hidden = true;
    }

    // Update trust score display
    updateTrustScoreDisplay();
}

/**
 * Send phone verification code
 */
async function sendPhoneVerificationCode() {
    const phoneInput = document.getElementById('verify-phone');
    const carrierSelect = document.getElementById('phone-carrier');
    const phone = phoneInput?.value?.trim();
    const carrier = carrierSelect?.value;

    if (!phone) {
        announce('Please enter your phone number');
        return;
    }

    if (!carrier) {
        announce('Please select your mobile carrier');
        return;
    }

    announce('Sending verification code...');

    try {
        const result = await window.openlink.verification.sendPhoneCode(phone, carrier);

        if (result.success) {
            pendingVerification.phone.codeId = result.codeId;

            // Show code input section
            document.getElementById('phone-input-section').hidden = true;
            document.getElementById('phone-code-section').hidden = false;
            document.getElementById('phone-code-input').focus();

            announce(`Verification code sent to ${result.maskedNumber}. Check your messages.`);
        } else {
            announce('Failed to send code: ' + (result.error || 'Unknown error'));
        }
    } catch (e) {
        console.error('[Verification] Phone code send failed:', e);
        announce('Failed to send verification code: ' + e.message);
    }
}

/**
 * Verify phone code
 */
async function verifyPhoneCode() {
    const codeInput = document.getElementById('phone-code-input');
    const code = codeInput?.value?.trim();

    if (!code || code.length !== 6) {
        announce('Please enter the 6-digit code');
        return;
    }

    if (!pendingVerification.phone.codeId) {
        announce('No pending verification. Please request a new code.');
        cancelPhoneVerification();
        return;
    }

    announce('Verifying code...');

    try {
        const result = await window.openlink.verification.verifyCode(
            pendingVerification.phone.codeId,
            code
        );

        if (result.success) {
            announce('Phone verified successfully!');
            pendingVerification.phone.codeId = null;

            // Update UI
            const status = await window.openlink.verification.getStatus();
            updateVerificationUI(status);

            // Hide code section, show verified status
            document.getElementById('phone-code-section').hidden = true;
        } else {
            announce(result.error || 'Invalid code');
            if (result.attemptsRemaining !== undefined) {
                announce(`${result.attemptsRemaining} attempts remaining`);
            }
        }
    } catch (e) {
        console.error('[Verification] Phone verify failed:', e);
        announce('Verification failed: ' + e.message);
    }
}

/**
 * Cancel phone verification
 */
function cancelPhoneVerification() {
    pendingVerification.phone.codeId = null;
    document.getElementById('phone-input-section').hidden = false;
    document.getElementById('phone-code-section').hidden = true;
    document.getElementById('phone-code-input').value = '';
}

/**
 * Send email verification code
 */
async function sendEmailVerificationCode() {
    const emailInput = document.getElementById('verify-email');
    const email = emailInput?.value?.trim();

    if (!email) {
        announce('Please enter your email address');
        return;
    }

    announce('Sending verification code to email...');

    try {
        const result = await window.openlink.verification.sendEmailCode(email);

        if (result.success) {
            pendingVerification.email.codeId = result.codeId;

            document.getElementById('email-input-section').hidden = true;
            document.getElementById('email-code-section').hidden = false;
            document.getElementById('email-code-input').focus();

            announce(`Verification code sent to ${result.maskedEmail}. Check your inbox.`);
        } else {
            announce('Failed to send code: ' + (result.error || 'Unknown error'));
        }
    } catch (e) {
        console.error('[Verification] Email code send failed:', e);
        announce('Failed to send verification code: ' + e.message);
    }
}

/**
 * Verify email code
 */
async function verifyEmailCode() {
    const codeInput = document.getElementById('email-code-input');
    const code = codeInput?.value?.trim();

    if (!code || code.length !== 6) {
        announce('Please enter the 6-digit code');
        return;
    }

    if (!pendingVerification.email.codeId) {
        announce('No pending verification. Please request a new code.');
        cancelEmailVerification();
        return;
    }

    announce('Verifying code...');

    try {
        const result = await window.openlink.verification.verifyCode(
            pendingVerification.email.codeId,
            code
        );

        if (result.success) {
            announce('Email verified successfully!');
            pendingVerification.email.codeId = null;

            const status = await window.openlink.verification.getStatus();
            updateVerificationUI(status);

            document.getElementById('email-code-section').hidden = true;
        } else {
            announce(result.error || 'Invalid code');
        }
    } catch (e) {
        console.error('[Verification] Email verify failed:', e);
        announce('Verification failed: ' + e.message);
    }
}

/**
 * Cancel email verification
 */
function cancelEmailVerification() {
    pendingVerification.email.codeId = null;
    document.getElementById('email-input-section').hidden = false;
    document.getElementById('email-code-section').hidden = true;
    document.getElementById('email-code-input').value = '';
}

/**
 * Check if user is verified before creating a link
 */
async function checkVerificationForLink() {
    if (!window.openlink?.verification) {
        return { required: false }; // Skip if service unavailable
    }

    try {
        return await window.openlink.verification.checkForLink();
    } catch (e) {
        console.error('[Verification] Check failed:', e);
        return { required: false };
    }
}

/**
 * Verify Mastodon profile for trust score
 */
async function verifyMastodonProfile() {
    const handleInput = document.getElementById('mastodon-handle');
    const handle = handleInput?.value?.trim();

    if (!handle) {
        announce('Please enter your Mastodon handle (e.g., @user@instance.social)');
        return;
    }

    // Parse the handle
    const match = handle.match(/@?([^@]+)@(.+)/);
    if (!match) {
        announce('Invalid Mastodon handle format. Use @username@instance.social');
        return;
    }

    const [, username, instance] = match;
    announce('Verifying Mastodon profile...');

    try {
        // Try to fetch the profile from the instance
        const response = await fetch(`https://${instance}/@${username}.json`, {
            headers: { 'Accept': 'application/activity+json' }
        });

        if (response.ok) {
            const profile = await response.json();

            // Store the verified profile
            const mastodonProfile = {
                handle: `@${username}@${instance}`,
                displayName: profile.name || username,
                verified: true,
                verifiedAt: Date.now(),
                url: profile.url || `https://${instance}/@${username}`
            };

            await window.openlink.setSetting('mastodonProfile', mastodonProfile);

            // Update UI
            const valueEl = document.getElementById('mastodon-handle-value');
            if (valueEl) valueEl.textContent = mastodonProfile.handle;

            announce(`Mastodon profile verified: ${mastodonProfile.displayName}`);
            updateTrustScoreDisplay();
        } else {
            announce('Could not verify Mastodon profile. Please check the handle.');
        }
    } catch (e) {
        console.error('Mastodon verification failed:', e);
        announce('Failed to verify Mastodon profile. Check your internet connection.');
    }
}

/**
 * Link WHMCS client portal for trust score and domain management
 */
async function linkWhmcsClient() {
    announce('Opening client portal login...');

    // Open the WHMCS client portal in a popup window
    const portalUrl = 'https://devine-creations.com/clientarea.php?action=services';

    try {
        // Try to open via shell
        await window.openlink.openExternal(portalUrl);

        // Prompt user to paste their client ID after logging in
        const clientId = prompt('After logging in, enter your Client ID from the client portal (found in your profile):');

        if (clientId && clientId.trim()) {
            const whmcsClient = {
                clientId: clientId.trim(),
                linkedAt: Date.now(),
                portalUrl: 'https://devine-creations.com/clientarea.php'
            };

            await window.openlink.setSetting('whmcsClient', whmcsClient);

            // Update UI
            const valueEl = document.getElementById('whmcs-client-value');
            if (valueEl) valueEl.textContent = `Client #${clientId}`;

            announce('Client portal linked successfully');
            updateTrustScoreDisplay();
        } else {
            announce('Client portal linking cancelled');
        }
    } catch (e) {
        console.error('WHMCS linking failed:', e);
        announce('Failed to open client portal');
    }
}

/**
 * Update the trust score display in the UI
 */
async function updateTrustScoreDisplay() {
    try {
        const scoreInfo = await window.openlink.invoke('get-trust-score-display');

        if (scoreInfo) {
            const tierEl = document.getElementById('trust-tier');
            const scoreEl = document.getElementById('trust-score-value');

            if (tierEl) {
                tierEl.textContent = scoreInfo.tier.charAt(0).toUpperCase() + scoreInfo.tier.slice(1);
                tierEl.style.backgroundColor = scoreInfo.color;
            }
            if (scoreEl) {
                scoreEl.textContent = scoreInfo.score;
            }
        }
    } catch (e) {
        console.error('Failed to update trust score display:', e);
    }
}

/**
 * Start automatic wallet sync interval
 */
let walletSyncInterval = null;

function startWalletAutoSync(intervalMinutes = 10) {
    if (walletSyncInterval) {
        clearInterval(walletSyncInterval);
    }

    // Initial sync
    syncWalletsToServer();

    // Set up periodic sync
    walletSyncInterval = setInterval(() => {
        if (state.savedWallets && state.savedWallets.length > 0) {
            syncWalletsToServer();
        }
    }, intervalMinutes * 60 * 1000);

    console.log(`Wallet auto-sync started: every ${intervalMinutes} minutes`);
}

function stopWalletAutoSync() {
    if (walletSyncInterval) {
        clearInterval(walletSyncInterval);
        walletSyncInterval = null;
    }
}

// Make wallet functions globally accessible for onclick handlers
window.setAsPrimaryWallet = setAsPrimaryWallet;
window.copyWalletAddress = copyWalletAddress;
window.removeSavedWallet = removeSavedWallet;
window.addDetectedWallet = addDetectedWallet;
window.syncWalletsToServer = syncWalletsToServer;
window.restoreWalletsFromServer = restoreWalletsFromServer;

// ==================== Keyboard Handler ====================

function handleGlobalKeydown(event) {
    // Alt+Shift+\ - Control menu (avoids conflict with RIM)
    if (event.altKey && event.shiftKey && event.key === '\\') {
        event.preventDefault();
        if (state.isConnected) {
            // In session - toggle control menu
            if (state.controlMenuOpen) {
                closeControlMenu();
            } else {
                openControlMenu();
            }
        } else {
            // Not in session - bring window to foreground and focus main tab
            window.openlink.bringToFront();
            switchTab('connect');
            announce('OpenLink brought to foreground');
        }
        return;
    }

    // Escape - Close control menu
    if (event.key === 'Escape') {
        if (state.controlMenuOpen) {
            closeControlMenu();
        }
        return;
    }

    // When connected and not in a menu, send input to remote
    if (state.isConnected && !state.controlMenuOpen && !state.isHosting) {
        // Don't capture if focused on local input
        if (document.activeElement.tagName === 'INPUT' ||
            document.activeElement.tagName === 'TEXTAREA' ||
            document.activeElement.tagName === 'SELECT') {
            return;
        }

        sendDataMessage({
            type: 'input',
            inputType: 'key',
            key: event.key,
            code: event.code,
            ctrlKey: event.ctrlKey,
            altKey: event.altKey,
            shiftKey: event.shiftKey,
            metaKey: event.metaKey
        });

        event.preventDefault();
    }
}

// ==================== Mouse Handler ====================

elements.remoteVideo?.addEventListener('click', (event) => {
    if (!state.isConnected || state.isHosting) return;

    const rect = elements.remoteVideo.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;

    sendDataMessage({
        type: 'input',
        inputType: 'click',
        x: x,
        y: y,
        button: event.button
    });
});

elements.remoteVideo?.addEventListener('mousemove', (event) => {
    if (!state.isConnected || state.isHosting) return;

    const rect = elements.remoteVideo.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;

    sendDataMessage({
        type: 'input',
        inputType: 'move',
        x: x,
        y: y
    });
});

// ==================== Utilities ====================

/**
 * Generate a random anagram from a word
 */
function generateAnagram(word) {
    const letters = word.toUpperCase().replace(/[^A-Z0-9]/g, '').split('');
    // Fisher-Yates shuffle
    for (let i = letters.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [letters[i], letters[j]] = [letters[j], letters[i]];
    }
    return letters.join('');
}

/**
 * Generate session ID from custom words (anagram-based)
 */
function generateAnagramSessionId(wordsStr) {
    const words = wordsStr.split(',').map(w => w.trim()).filter(w => w.length > 0);
    if (words.length === 0) return null;

    // Pick a random word
    const word = words[Math.floor(Math.random() * words.length)];

    // Generate anagram
    let anagram = generateAnagram(word);

    // Ensure minimum length of 6, pad with random chars if needed
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    while (anagram.length < 6) {
        anagram += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    // Cap at 12 characters
    return anagram.substring(0, 12);
}

/**
 * Generate a session ID - uses custom words if available, otherwise random
 */
function generateSessionId() {
    // Check for custom words for anagram generation
    const wordsInput = document.getElementById('session-id-words');
    const wordsStr = wordsInput?.value?.trim();

    if (wordsStr) {
        const anagramId = generateAnagramSessionId(wordsStr);
        if (anagramId) {
            console.log('[Session] Generated anagram-based ID from custom words');
            return anagramId;
        }
    }

    // Default: random alphanumeric
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let id = '';
    for (let i = 0; i < 8; i++) {
        id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return id;
}

function formatTime(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;

    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return date.toLocaleDateString();
}

function announce(message) {
    elements.announcer.textContent = message;
    console.log('[Announce]', message);
}

// Make announce available globally for debugging
window.announce = announce;

// ==================== Server Settings Tab ====================

/**
 * Set up event listeners for the server settings tab
 */
function setupServerSettingsListeners() {
    // Refresh servers button
    elements.refreshServersBtn?.addEventListener('click', async () => {
        await refreshServerList();
        announce('Server list refreshed');
    });

    // Test all servers button
    elements.testAllServersBtn?.addEventListener('click', async () => {
        await testAllServers();
    });

    // Add custom server button
    elements.addCustomServerBtn?.addEventListener('click', async () => {
        await addCustomServer();
    });

    // Random server preference checkbox
    elements.preferRandomServer?.addEventListener('change', (e) => {
        const useRandom = e.target.checked;
        if (elements.defaultServer) {
            elements.defaultServer.disabled = useRandom;
        }
        // Save preference
        localStorage.setItem('openlink-prefer-random-server', useRandom);
    });

    // Default server selection
    elements.defaultServer?.addEventListener('change', (e) => {
        localStorage.setItem('openlink-default-server', e.target.value);
    });

    // Load saved preferences
    loadServerPreferences();

    // Initial server list render
    renderServerList();
}

/**
 * Load saved server preferences from localStorage
 */
function loadServerPreferences() {
    const preferRandom = localStorage.getItem('openlink-prefer-random-server');
    const defaultServer = localStorage.getItem('openlink-default-server');

    if (elements.preferRandomServer) {
        elements.preferRandomServer.checked = preferRandom !== 'false';
    }

    if (elements.defaultServer && defaultServer) {
        elements.defaultServer.value = defaultServer;
        elements.defaultServer.disabled = preferRandom !== 'false';
    }
}

/**
 * Render the server list with status indicators
 */
async function renderServerList() {
    const container = elements.serverList;
    if (!container) return;

    container.innerHTML = '<p class="loading-text">Loading servers...</p>';

    try {
        const servers = await window.servers.getServers();

        if (!servers || servers.length === 0) {
            container.innerHTML = '<p class="empty-text">No servers available</p>';
            return;
        }

        container.innerHTML = '';

        // Also update the default server dropdown
        updateDefaultServerDropdown(servers);

        servers.forEach(server => {
            const item = document.createElement('div');
            item.className = 'server-item';
            item.setAttribute('role', 'listitem');

            const statusClass = server.status === 'online' ? 'online' : 'offline';
            const statusText = server.status === 'online' ? 'Online' : 'Offline';

            item.innerHTML = `
                <div class="server-info">
                    <span class="server-name">${server.name || 'Unknown Server'}</span>
                    <span class="server-url">${server.url}</span>
                </div>
                <div class="server-status ${statusClass}" aria-label="${statusText}">
                    <span class="status-indicator"></span>
                    <span class="status-text">${statusText}</span>
                </div>
                <div class="server-actions">
                    <button class="btn small test-server" data-url="${server.url}" aria-label="Test ${server.name || server.url}">Test</button>
                    ${server.isCustom ? `<button class="btn small danger remove-server" data-url="${server.url}" aria-label="Remove ${server.name || server.url}">Remove</button>` : ''}
                </div>
            `;

            container.appendChild(item);
        });

        // Add event listeners for test and remove buttons
        container.querySelectorAll('.test-server').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const url = e.target.dataset.url;
                await testServer(url);
            });
        });

        container.querySelectorAll('.remove-server').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const url = e.target.dataset.url;
                await removeServer(url);
            });
        });

        // Update active server display
        updateActiveServerDisplay();

    } catch (e) {
        console.error('Failed to render server list:', e);
        container.innerHTML = '<p class="error-text">Failed to load servers</p>';
    }
}

/**
 * Update the default server dropdown with available servers
 */
function updateDefaultServerDropdown(servers) {
    const select = elements.defaultServer;
    if (!select) return;

    // Keep first two options (Random, Local)
    while (select.options.length > 2) {
        select.remove(2);
    }

    // Separate online and offline servers
    const onlineServers = servers.filter(s => s.status === 'online');
    const offlineServers = servers.filter(s => s.status !== 'online');

    // Add online server options first
    onlineServers.forEach(server => {
        const option = document.createElement('option');
        option.value = server.url;
        option.textContent = `${server.name || server.url} (Online)`;
        select.appendChild(option);
    });

    // Add offline servers with indication (user may want to select them anyway)
    if (offlineServers.length > 0) {
        const separator = document.createElement('option');
        separator.disabled = true;
        separator.textContent = '--- Offline/Unchecked Servers ---';
        select.appendChild(separator);

        offlineServers.forEach(server => {
            const option = document.createElement('option');
            option.value = server.url;
            option.textContent = `${server.name || server.url} (Offline)`;
            option.className = 'offline-server';
            select.appendChild(option);
        });
    }

    // Restore saved selection
    const savedServer = localStorage.getItem('openlink-default-server');
    if (savedServer) {
        // Check if the saved server is still in the list
        const serverExists = [...select.options].some(opt => opt.value === savedServer);
        if (serverExists) {
            select.value = savedServer;
        }
    }
}

/**
 * Update the active server display
 */
function updateActiveServerDisplay() {
    if (!elements.activeServerDisplay) return;

    if (state.signalingUrl) {
        elements.activeServerDisplay.textContent = state.signalingUrl;
    } else {
        elements.activeServerDisplay.textContent = 'Not connected';
    }
}

/**
 * Refresh the server list
 */
async function refreshServerList() {
    try {
        // Re-discover servers
        await window.servers.discoverServers?.();
        await renderServerList();
    } catch (e) {
        console.error('Failed to refresh servers:', e);
        announce('Failed to refresh server list');
    }
}

/**
 * Test a specific server
 */
async function testServer(url) {
    try {
        announce(`Testing server ${url}...`);
        const result = await window.servers.checkServerHealth(url);

        if (result && result.online) {
            announce(`Server ${url} is online. Latency: ${result.latency || 'unknown'}ms`);
        } else {
            announce(`Server ${url} is offline or unreachable`);
        }

        // Refresh the list to update status
        await renderServerList();
    } catch (e) {
        console.error('Failed to test server:', e);
        announce(`Failed to test server: ${e.message}`);
    }
}

/**
 * Test all servers
 */
async function testAllServers() {
    try {
        announce('Testing all servers...');
        const servers = await window.servers.getServers();

        let onlineCount = 0;
        let offlineCount = 0;

        for (const server of servers) {
            try {
                const result = await window.servers.checkServerHealth(server.url);
                if (result && result.online) {
                    onlineCount++;
                } else {
                    offlineCount++;
                }
            } catch {
                offlineCount++;
            }
        }

        announce(`Server test complete: ${onlineCount} online, ${offlineCount} offline`);
        await renderServerList();
    } catch (e) {
        console.error('Failed to test servers:', e);
        announce('Failed to test servers');
    }
}

/**
 * Add a custom server
 */
async function addCustomServer() {
    const url = elements.customServerUrl?.value?.trim();
    const name = elements.customServerName?.value?.trim();

    if (!url) {
        announce('Please enter a server URL');
        return;
    }

    // Validate URL format
    if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
        announce('Server URL must start with ws:// or wss://');
        return;
    }

    try {
        announce(`Adding server ${name || url}...`);

        await window.servers.addServer({
            url: url,
            name: name || url,
            isCustom: true
        });

        // Clear inputs
        if (elements.customServerUrl) elements.customServerUrl.value = '';
        if (elements.customServerName) elements.customServerName.value = '';

        announce(`Server ${name || url} added successfully`);
        await renderServerList();

        // Also update the main server dropdown
        await initializeServers();
    } catch (e) {
        console.error('Failed to add server:', e);
        announce(`Failed to add server: ${e.message}`);
    }
}

/**
 * Remove a custom server
 */
async function removeServer(url) {
    try {
        announce(`Removing server ${url}...`);
        await window.servers.removeServer(url);
        announce('Server removed');
        await renderServerList();

        // Also update the main server dropdown
        await initializeServers();
    } catch (e) {
        console.error('Failed to remove server:', e);
        announce(`Failed to remove server: ${e.message}`);
    }
}

// ==================== Active Connection URL ====================

// Note: openlinkHttpsDomains is now provided by getAllLinkDomains() function
// which combines openlinkDomains with any user-added custom domains

/**
 * Extract domain from a WebSocket URL
 */
function extractDomainFromWsUrl(wsUrl) {
    try {
        const url = new URL(wsUrl);
        return url.hostname;
    } catch {
        return null;
    }
}

/**
 * Get list of online OpenLink domains from server status
 */
function getOnlineOpenLinkDomains() {
    const onlineDomains = [];

    if (state.servers && state.servers.length > 0) {
        for (const server of state.servers) {
            if (server.status === 'online') {
                const domain = extractDomainFromWsUrl(server.url);
                if (domain && domain.startsWith('openlink.')) {
                    onlineDomains.push(domain);
                }
            }
        }
    }

    return onlineDomains;
}

/**
 * Update the active connection URL display with shareable HTTPS URL
 * Uses selected domain from dropdown and validates/regenerates automatically
 */
async function updateActiveConnectionUrl() {
    const urlInput = document.getElementById('active-connection-url');
    if (!urlInput) return;

    if (!state.sessionId) {
        urlInput.value = '';
        urlInput.placeholder = 'Start hosting to generate URL';
        updateLinkStatusIndicator('none');
        return;
    }

    // Get selected domain or use default
    const domainSelect = document.getElementById('link-domain');
    const selectedDomain = domainSelect?.value || 'openlink.tappedin.fm';

    // Generate subdomain-based HTTPS URL
    const subdomainSafeId = state.sessionId.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const httpsUrl = `https://${subdomainSafeId}.${selectedDomain}`;
    urlInput.value = httpsUrl;
    state.activeConnectionUrl = httpsUrl;
    state.activeLinkDomain = selectedDomain;

    // Auto-select for easy copying
    urlInput.select();

    console.log('[URL] Active connection URL:', httpsUrl);

    // Validate link in background and auto-regenerate if needed
    validateAndEnsureActiveLink(subdomainSafeId, selectedDomain);
}

/**
 * Validate link and auto-regenerate if inactive
 */
async function validateAndEnsureActiveLink(linkId, domain) {
    updateLinkStatusIndicator('checking');

    try {
        if (window.links && window.links.ensureActive) {
            const result = await window.links.ensureActive(linkId, domain, { autoRegenerate: true });

            if (result.success && result.active) {
                updateLinkStatusIndicator('active');
                console.log('[URL] Link validated as active');
            } else if (result.regenerated) {
                updateLinkStatusIndicator('regenerated');
                console.log('[URL] Link was regenerated');
                announce('Connection link regenerated');

                // Send notification through all enabled channels with new URL
                if (window.openlink?.notifications?.send) {
                    window.openlink.notifications.send({
                        title: 'OpenLink - New Link',
                        message: `Your connection link has been regenerated. ID: ${state.sessionId}`,
                        priority: 'high',
                        url: state.activeConnectionUrl || null
                    }).catch(e => console.log('[Notification] Push failed:', e));
                }
            } else if (result.validation?.status === 'no_host') {
                // No host yet - this is normal when just starting to host
                updateLinkStatusIndicator('waiting');
                console.log('[URL] Waiting for host connection');
            } else {
                updateLinkStatusIndicator('error');
                console.warn('[URL] Link validation failed:', result);
            }
        } else {
            // Fallback: assume link is active (API not available)
            updateLinkStatusIndicator('active');
        }
    } catch (e) {
        console.error('[URL] Link validation error:', e);
        updateLinkStatusIndicator('error');
    }
}

/**
 * Update link status indicator UI
 */
function updateLinkStatusIndicator(status) {
    const statusEl = document.getElementById('link-status-indicator');
    if (!statusEl) return;

    const statusMap = {
        'none': { text: '', class: '' },
        'checking': { text: 'Validating...', class: 'status-checking' },
        'active': { text: 'Active', class: 'status-active' },
        'waiting': { text: 'Waiting for connection', class: 'status-waiting' },
        'regenerated': { text: 'Regenerated', class: 'status-regenerated' },
        'error': { text: 'Error', class: 'status-error' }
    };

    const statusInfo = statusMap[status] || statusMap['none'];
    statusEl.textContent = statusInfo.text;
    statusEl.className = `link-status ${statusInfo.class}`;
}

/**
 * Setup copy button for active connection URL
 */
function setupActiveUrlCopyButton() {
    const copyBtn = document.getElementById('copy-connection-url');
    const urlInput = document.getElementById('active-connection-url');

    if (copyBtn && urlInput) {
        copyBtn.addEventListener('click', () => {
            if (urlInput.value) {
                window.openlink.setClipboard(urlInput.value);
                announce('Connection URL copied to clipboard');
                // Visual feedback
                copyBtn.textContent = 'Copied!';
                setTimeout(() => {
                    copyBtn.textContent = 'Copy';
                }, 2000);
            }
        });
    }
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(setupActiveUrlCopyButton, 100);
});

// ==================== Connection Status Tracking ====================

/**
 * Initialize connection status tracking
 * Call this when the app starts
 */
function initConnectionTracking() {
    // Load saved connection history
    loadConnectionHistory();

    // Start the UI update interval
    startConnectionStatsRefresh();

    console.log('[ConnectionStats] Initialized');
}

/**
 * Start the connection stats refresh interval
 */
function startConnectionStatsRefresh() {
    // Update immediately
    updateConnectionStatusUI();

    // Clear any existing interval
    if (state.connectionStatsInterval) {
        clearInterval(state.connectionStatsInterval);
    }

    // Update every second for live uptime
    state.connectionStatsInterval = setInterval(() => {
        updateConnectionStatusUI();
    }, 1000);
}

/**
 * Stop the connection stats refresh
 */
function stopConnectionStatsRefresh() {
    if (state.connectionStatsInterval) {
        clearInterval(state.connectionStatsInterval);
        state.connectionStatsInterval = null;
    }
}

/**
 * Update the connection status UI elements
 */
function updateConnectionStatusUI() {
    const stats = state.connectionStats;

    // Update session uptime
    const uptimeEl = document.getElementById('session-uptime');
    if (uptimeEl) {
        if (stats.sessionStartTime) {
            uptimeEl.textContent = formatUptime(Date.now() - stats.sessionStartTime);
        } else {
            uptimeEl.textContent = '--:--:--';
        }
    }

    // Update active connections count
    const activeConnEl = document.getElementById('active-connections-count');
    if (activeConnEl) {
        activeConnEl.textContent = stats.activeConnections.toString();
    }

    // Update total sessions count
    const totalSessionsEl = document.getElementById('total-sessions');
    if (totalSessionsEl) {
        totalSessionsEl.textContent = stats.totalSessions.toString();
    }

    // Update active server display
    const activeServerEl = document.getElementById('active-server-display');
    if (activeServerEl) {
        if (state.signalingUrl) {
            activeServerEl.textContent = state.signalingUrl;
        } else if (state.isConnected || state.isHosting) {
            activeServerEl.textContent = getSignalingServerUrl();
        } else {
            activeServerEl.textContent = 'Not connected';
        }
    }

    // Update last connected IP
    const lastIpEl = document.getElementById('last-connected-ip');
    if (lastIpEl) {
        lastIpEl.textContent = stats.lastConnectedIP || 'None';
    }

    // Update last activity time
    const lastActivityEl = document.getElementById('last-activity-time');
    if (lastActivityEl) {
        if (stats.lastActivityTime) {
            const ago = formatTimeAgo(stats.lastActivityTime);
            lastActivityEl.textContent = ago;
        } else {
            lastActivityEl.textContent = '-';
        }
    }

    // Update tray/status menu connection state with full info
    if (window.openlink?.updateTrayStatus) {
        const trayState = {
            isHosting: state.isHosting,
            isConnected: state.isConnected,
            sessionId: state.sessionId || null,
            connectedTo: state.connectedTo || null,
            currentUrl: state.currentLink?.url || null,
            connectedClients: state.connectedClients || [],
            clientCount: state.connectedClients?.length || 0
        };
        window.openlink.updateTrayStatus(trayState);
    }
}

/**
 * Format uptime in HH:MM:SS format
 */
function formatUptime(ms) {
    const seconds = Math.floor(ms / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Format time ago string
 */
function formatTimeAgo(timestamp) {
    const now = Date.now();
    const diff = now - timestamp;

    if (diff < 60000) {
        return 'Just now';
    } else if (diff < 3600000) {
        const mins = Math.floor(diff / 60000);
        return `${mins} minute${mins !== 1 ? 's' : ''} ago`;
    } else if (diff < 86400000) {
        const hours = Math.floor(diff / 3600000);
        return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
    } else {
        const days = Math.floor(diff / 86400000);
        return `${days} day${days !== 1 ? 's' : ''} ago`;
    }
}

/**
 * Record a new connection
 */
function recordConnection(ip, serverUrl) {
    const stats = state.connectionStats;

    // Update stats
    stats.activeConnections++;
    stats.totalSessions++;
    stats.lastConnectedIP = ip || 'Unknown';
    stats.lastActivityTime = Date.now();
    stats.sessionStartTime = stats.sessionStartTime || Date.now();

    // Add to history
    const historyEntry = {
        ip: ip || 'Unknown',
        server: serverUrl || 'Unknown',
        startTime: Date.now(),
        endTime: null,
        duration: null
    };
    stats.connectionHistory.unshift(historyEntry);

    // Keep only last 50 entries
    if (stats.connectionHistory.length > 50) {
        stats.connectionHistory = stats.connectionHistory.slice(0, 50);
    }

    // Save to localStorage
    saveConnectionHistory();

    // Update UI
    updateConnectionStatusUI();
    renderConnectionHistory();
}

/**
 * Record connection end
 */
function recordDisconnection() {
    const stats = state.connectionStats;

    // Update active connections
    stats.activeConnections = Math.max(0, stats.activeConnections - 1);
    stats.lastActivityTime = Date.now();

    // Update the most recent history entry with end time
    if (stats.connectionHistory.length > 0 && !stats.connectionHistory[0].endTime) {
        stats.connectionHistory[0].endTime = Date.now();
        stats.connectionHistory[0].duration = stats.connectionHistory[0].endTime - stats.connectionHistory[0].startTime;
    }

    // If no more active connections, clear session start time
    if (stats.activeConnections === 0 && !state.isHosting) {
        stats.sessionStartTime = null;
    }

    // Save to localStorage
    saveConnectionHistory();

    // Update UI
    updateConnectionStatusUI();
    renderConnectionHistory();
}

/**
 * Start a hosting session (for tracking)
 */
function startHostingSession() {
    state.connectionStats.sessionStartTime = Date.now();
    state.connectionStats.lastActivityTime = Date.now();
    updateConnectionStatusUI();
}

/**
 * End a hosting session (for tracking)
 */
function endHostingSession() {
    state.connectionStats.sessionStartTime = null;
    state.connectionStats.activeConnections = 0;
    updateConnectionStatusUI();
}

/**
 * Save connection history to localStorage
 */
function saveConnectionHistory() {
    try {
        const data = {
            totalSessions: state.connectionStats.totalSessions,
            lastConnectedIP: state.connectionStats.lastConnectedIP,
            connectionHistory: state.connectionStats.connectionHistory.slice(0, 50)
        };
        localStorage.setItem('openlink-connection-history', JSON.stringify(data));
    } catch (e) {
        console.warn('[ConnectionStats] Failed to save history:', e);
    }
}

/**
 * Load connection history from localStorage
 */
function loadConnectionHistory() {
    try {
        const saved = localStorage.getItem('openlink-connection-history');
        if (saved) {
            const data = JSON.parse(saved);
            state.connectionStats.totalSessions = data.totalSessions || 0;
            state.connectionStats.lastConnectedIP = data.lastConnectedIP || null;
            state.connectionStats.connectionHistory = data.connectionHistory || [];
        }
    } catch (e) {
        console.warn('[ConnectionStats] Failed to load history:', e);
    }
}

/**
 * Render the connection history list
 */
function renderConnectionHistory() {
    const container = document.getElementById('connection-history-list');
    if (!container) return;

    const history = state.connectionStats.connectionHistory;

    if (!history || history.length === 0) {
        container.innerHTML = '<p class="empty-state">No connection history</p>';
        return;
    }

    container.innerHTML = '';

    history.slice(0, 20).forEach(entry => {
        const item = document.createElement('div');
        item.className = 'connection-history-item';
        item.setAttribute('role', 'listitem');

        const startDate = new Date(entry.startTime);
        const timeStr = startDate.toLocaleTimeString();
        const dateStr = startDate.toLocaleDateString();

        let durationStr = '--';
        if (entry.duration) {
            durationStr = formatUptime(entry.duration);
        } else if (entry.startTime && !entry.endTime) {
            // Still active
            durationStr = 'Active';
        }

        item.innerHTML = `
            <div class="history-info">
                <span class="history-ip">${entry.ip}</span>
                <span class="history-time">${dateStr} ${timeStr}</span>
            </div>
            <span class="history-duration">${durationStr}</span>
        `;

        container.appendChild(item);
    });
}

// Initialize connection tracking when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    // Delay to let main init run first
    setTimeout(initConnectionTracking, 500);
});
