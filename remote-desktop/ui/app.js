/**
 * OpenLink Remote Desktop - Application Logic
 * Control Menu: Option+Shift+Backspace
 */

class OpenLinkApp {
    constructor() {
        this.remoteDesktop = null;
        this.isHost = false;
        this.sessionCode = null;
        this.menuIndex = 0;
        this.menuStack = [];
        this.currentMenu = null;

        this.screens = {
            connect: document.getElementById('connect-screen'),
            host: document.getElementById('host-screen'),
            remote: document.getElementById('remote-screen')
        };

        this.elements = {
            // Connect screen
            btnHost: document.getElementById('btn-host'),
            btnConnect: document.getElementById('btn-connect'),
            sessionCodeInput: document.getElementById('session-code'),

            // Settings
            enableMic: document.getElementById('enable-mic'),
            enableSystemAudio: document.getElementById('enable-system-audio'),
            keyboardMode: document.getElementById('keyboard-mode'),
            announceFocus: document.getElementById('announce-focus'),
            captureRemoteSR: document.getElementById('capture-remote-sr'),
            quality: document.getElementById('quality'),
            fitToWindow: document.getElementById('fit-to-window'),
            signalingServer: document.getElementById('signaling-server'),

            // Host screen
            displaySessionCode: document.getElementById('display-session-code'),
            btnCopyCode: document.getElementById('btn-copy-code'),
            hostStatus: document.getElementById('host-status'),
            connectedClients: document.getElementById('connected-clients'),
            btnStopHosting: document.getElementById('btn-stop-hosting'),

            // Remote screen
            connectionStatus: document.getElementById('connection-status'),
            btnFullscreen: document.getElementById('btn-fullscreen'),
            btnFit: document.getElementById('btn-fit'),
            btnKeyboardMode: document.getElementById('btn-keyboard-mode'),
            btnToggleMic: document.getElementById('btn-toggle-mic'),
            btnToggleAudio: document.getElementById('btn-toggle-audio'),
            btnDisconnect: document.getElementById('btn-disconnect'),
            remoteVideo: document.getElementById('remote-video'),
            remoteAudio: document.getElementById('remote-audio'),
            videoContainer: document.getElementById('video-container'),
            videoOverlay: document.getElementById('video-overlay'),
            overlayMessage: document.getElementById('overlay-message'),

            // Modal
            modal: document.getElementById('modal'),
            modalTitle: document.getElementById('modal-title'),
            modalMessage: document.getElementById('modal-message'),
            modalClose: document.getElementById('modal-close'),

            // Control Menu
            controlMenu: document.getElementById('control-menu'),
            menuList: document.getElementById('menu-list'),

            // File picker
            fileInput: document.getElementById('file-input'),

            // Machine details
            machineDetails: document.getElementById('machine-details'),
            detailsContent: document.getElementById('details-content'),
            closeDetails: document.getElementById('close-details'),

            // Accessibility
            srAnnouncements: document.getElementById('sr-announcements'),
            srAlerts: document.getElementById('sr-alerts')
        };

        this.init();
    }

    init() {
        this.createDynamicElements();
        this.bindEvents();
        this.loadSettings();
        this.announce('OpenLink Remote Desktop ready. Press Tab to navigate.');
    }

    createDynamicElements() {
        // Create control menu if it doesn't exist
        if (!this.elements.controlMenu) {
            const menu = document.createElement('div');
            menu.id = 'control-menu';
            menu.className = 'control-menu';
            menu.setAttribute('role', 'menu');
            menu.setAttribute('aria-label', 'OpenLink Control Menu');
            menu.hidden = true;
            menu.innerHTML = `
                <div class="menu-header">
                    <h2>OpenLink Control Menu</h2>
                    <p>Use arrow keys to navigate, Enter to select, Escape to close</p>
                </div>
                <ul id="menu-list" class="menu-list" role="menubar"></ul>
            `;
            document.body.appendChild(menu);
            this.elements.controlMenu = menu;
            this.elements.menuList = document.getElementById('menu-list');
        }

        // Create file input
        if (!this.elements.fileInput) {
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.id = 'file-input';
            fileInput.style.display = 'none';
            document.body.appendChild(fileInput);
            this.elements.fileInput = fileInput;
        }

        // Create machine details panel
        if (!this.elements.machineDetails) {
            const details = document.createElement('div');
            details.id = 'machine-details';
            details.className = 'machine-details';
            details.setAttribute('role', 'dialog');
            details.setAttribute('aria-label', 'Machine Details');
            details.hidden = true;
            details.innerHTML = `
                <div class="details-panel">
                    <h2>Remote Machine Details</h2>
                    <div id="details-content"></div>
                    <button id="close-details" class="btn btn-primary">Close</button>
                </div>
            `;
            document.body.appendChild(details);
            this.elements.machineDetails = details;
            this.elements.detailsContent = document.getElementById('details-content');
            this.elements.closeDetails = document.getElementById('close-details');
        }

        // Add CSS for new elements
        this.injectStyles();
    }

    injectStyles() {
        if (document.getElementById('openlink-menu-styles')) return;

        const styles = document.createElement('style');
        styles.id = 'openlink-menu-styles';
        styles.textContent = `
            .control-menu {
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0, 0, 0, 0.9);
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                z-index: 10000;
            }

            .control-menu[hidden] {
                display: none;
            }

            .menu-header {
                text-align: center;
                margin-bottom: 2rem;
                color: #fff;
            }

            .menu-header h2 {
                font-size: 1.5rem;
                margin-bottom: 0.5rem;
            }

            .menu-header p {
                font-size: 0.875rem;
                color: #aaa;
            }

            .menu-list {
                list-style: none;
                padding: 0;
                margin: 0;
                min-width: 300px;
                max-width: 500px;
                background: #1a1a2e;
                border-radius: 8px;
                overflow: hidden;
            }

            .menu-item {
                padding: 1rem 1.5rem;
                cursor: pointer;
                display: flex;
                justify-content: space-between;
                align-items: center;
                color: #e0e0e0;
                border-bottom: 1px solid #333;
            }

            .menu-item:last-child {
                border-bottom: none;
            }

            .menu-item:hover,
            .menu-item.focused {
                background: #0066cc;
                color: #fff;
            }

            .menu-item .label {
                font-weight: 500;
            }

            .menu-item .description {
                font-size: 0.75rem;
                color: #aaa;
                margin-top: 0.25rem;
            }

            .menu-item.focused .description {
                color: #ccc;
            }

            .menu-item .submenu-indicator {
                font-size: 1.25rem;
            }

            .machine-details {
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0, 0, 0, 0.9);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 10001;
            }

            .machine-details[hidden] {
                display: none;
            }

            .details-panel {
                background: #1a1a2e;
                padding: 2rem;
                border-radius: 12px;
                min-width: 400px;
                max-width: 600px;
                color: #e0e0e0;
            }

            .details-panel h2 {
                margin: 0 0 1.5rem;
                color: #fff;
            }

            #details-content {
                margin-bottom: 1.5rem;
            }

            .detail-row {
                display: flex;
                justify-content: space-between;
                padding: 0.75rem 0;
                border-bottom: 1px solid #333;
            }

            .detail-row:last-child {
                border-bottom: none;
            }

            .detail-label {
                font-weight: 500;
                color: #aaa;
            }

            .detail-value {
                color: #fff;
            }

            .file-progress {
                position: fixed;
                bottom: 2rem;
                right: 2rem;
                background: #1a1a2e;
                padding: 1rem;
                border-radius: 8px;
                color: #e0e0e0;
                z-index: 9999;
            }

            .progress-bar {
                width: 200px;
                height: 8px;
                background: #333;
                border-radius: 4px;
                overflow: hidden;
                margin-top: 0.5rem;
            }

            .progress-bar-fill {
                height: 100%;
                background: #0066cc;
                transition: width 0.2s ease;
            }
        `;
        document.head.appendChild(styles);
    }

    bindEvents() {
        // Connect screen
        this.elements.btnHost.addEventListener('click', () => this.startHosting());
        this.elements.btnConnect.addEventListener('click', () => this.connectToRemote());
        this.elements.sessionCodeInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.connectToRemote();
        });

        // Host screen
        this.elements.btnCopyCode.addEventListener('click', () => this.copySessionCode());
        this.elements.btnStopHosting.addEventListener('click', () => this.stopHosting());

        // Remote screen toolbar
        this.elements.btnFullscreen?.addEventListener('click', () => this.toggleFullscreen());
        this.elements.btnFit?.addEventListener('click', () => this.toggleFitToWindow());
        this.elements.btnKeyboardMode?.addEventListener('click', () => this.cycleKeyboardMode());
        this.elements.btnToggleMic?.addEventListener('click', () => this.toggleMicrophone());
        this.elements.btnToggleAudio?.addEventListener('click', () => this.toggleAudio());
        this.elements.btnDisconnect?.addEventListener('click', () => this.disconnect());

        // Modal
        this.elements.modalClose?.addEventListener('click', () => this.hideModal());
        this.elements.modal?.addEventListener('click', (e) => {
            if (e.target === this.elements.modal) this.hideModal();
        });

        // Machine details
        this.elements.closeDetails?.addEventListener('click', () => this.hideMachineDetails());

        // File input
        this.elements.fileInput?.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                this.sendFile(e.target.files[0]);
                e.target.value = '';
            }
        });
    }

    setupRemoteDesktopEvents() {
        // Menu events
        this.remoteDesktop.on('show_menu', (items) => this.showControlMenu(items));
        this.remoteDesktop.on('hide_menu', () => this.hideControlMenu());
        this.remoteDesktop.on('menu_navigate', (data) => this.handleMenuNavigation(data.key));

        // File events
        this.remoteDesktop.on('open_file_picker', () => this.openFilePicker());
        this.remoteDesktop.on('file_progress', (data) => this.showFileProgress(data));
        this.remoteDesktop.on('file_received', (data) => this.handleFileReceived(data));

        // Machine details
        this.remoteDesktop.on('show_machine_details', (info) => this.showMachineDetails(info));
        this.remoteDesktop.on('machine_info_received', (info) => this.showMachineDetails(info));

        // Confirm dialogs
        this.remoteDesktop.on('confirm_restart', (data) => this.showConfirmDialog(data));

        // Connection events
        this.remoteDesktop.on('connected', () => {
            this.updateConnectionStatus('connected');
            this.announce('Connected to remote desktop. Press Option+Shift+Backspace for control menu.');
        });

        this.remoteDesktop.on('disconnected', (reason) => {
            this.updateConnectionStatus('disconnected');
            this.announce(`Disconnected: ${reason || 'Connection closed'}`, 'assertive');
            if (!this.isHost) {
                this.showScreen('connect');
            }
        });

        this.remoteDesktop.on('error', (error) => {
            console.error('Remote desktop error:', error);
            this.announce(`Error: ${error.message}`, 'assertive');
        });

        this.remoteDesktop.on('remote_video', (stream) => {
            this.elements.remoteVideo.srcObject = stream;
            this.elements.videoOverlay.hidden = true;
        });

        this.remoteDesktop.on('remote_audio', (stream) => {
            this.elements.remoteAudio.srcObject = stream;
        });

        this.remoteDesktop.on('peer_joined', (data) => {
            if (this.isHost) {
                this.addClientToList(data.peerId);
                this.elements.hostStatus.textContent = 'Client connected';
                this.announce('A client has connected');
            }
        });

        this.remoteDesktop.on('peer_disconnected', (data) => {
            if (this.isHost) {
                this.removeClientFromList(data?.peerId);
                this.announce('Client disconnected');
            }
        });

        // Control swap
        this.remoteDesktop.on('control_swapped', (data) => {
            if (data.swapped) {
                this.announce('Control swapped. The remote user is now controlling your machine.');
            } else {
                this.announce('Control restored. You are now controlling the remote machine.');
            }
        });
    }

    // ==================== Control Menu ====================

    showControlMenu(items) {
        this.currentMenu = items;
        this.menuIndex = 0;
        this.menuStack = [];
        this.renderMenu(items);
        this.elements.controlMenu.hidden = false;
        this.focusMenuItem(0);
    }

    hideControlMenu() {
        this.elements.controlMenu.hidden = true;
        this.currentMenu = null;
        this.menuStack = [];
    }

    renderMenu(items) {
        const list = this.elements.menuList;
        list.innerHTML = '';

        items.forEach((item, index) => {
            const li = document.createElement('li');
            li.className = 'menu-item';
            li.setAttribute('role', 'menuitem');
            li.setAttribute('tabindex', index === 0 ? '0' : '-1');
            li.dataset.index = index;

            const hasSubmenu = item.submenu && item.submenu.length > 0;

            li.innerHTML = `
                <div>
                    <div class="label">${item.label}</div>
                    ${item.description ? `<div class="description">${item.description}</div>` : ''}
                </div>
                ${hasSubmenu ? '<span class="submenu-indicator" aria-hidden="true">›</span>' : ''}
            `;

            li.addEventListener('click', () => this.selectMenuItem(index));
            list.appendChild(li);
        });
    }

    focusMenuItem(index) {
        const items = this.elements.menuList.querySelectorAll('.menu-item');
        items.forEach((item, i) => {
            item.classList.toggle('focused', i === index);
            item.setAttribute('tabindex', i === index ? '0' : '-1');
            if (i === index) {
                item.focus();
                // Announce the item
                const label = this.currentMenu[i].label;
                const desc = this.currentMenu[i].description || '';
                const hasSubmenu = this.currentMenu[i].submenu ? ', submenu' : '';
                this.announce(`${label}${hasSubmenu}. ${desc}`);
            }
        });
        this.menuIndex = index;
    }

    handleMenuNavigation(key) {
        const itemCount = this.currentMenu.length;

        switch (key) {
            case 'ArrowUp':
                this.focusMenuItem((this.menuIndex - 1 + itemCount) % itemCount);
                break;
            case 'ArrowDown':
                this.focusMenuItem((this.menuIndex + 1) % itemCount);
                break;
            case 'ArrowRight':
            case 'Enter':
            case ' ':
                this.selectMenuItem(this.menuIndex);
                break;
            case 'ArrowLeft':
                this.goBackInMenu();
                break;
        }
    }

    selectMenuItem(index) {
        const item = this.currentMenu[index];
        if (!item) return;

        if (item.submenu && item.submenu.length > 0) {
            // Enter submenu
            this.menuStack.push(this.currentMenu);
            this.currentMenu = item.submenu;
            this.menuIndex = 0;
            this.renderMenu(this.currentMenu);
            this.focusMenuItem(0);
            this.announce(`${item.label} submenu`);
        } else if (item.action) {
            // Execute action
            this.hideControlMenu();
            if (this.remoteDesktop) {
                this.remoteDesktop.menuOpen = false;
            }
            item.action();
        }
    }

    goBackInMenu() {
        if (this.menuStack.length > 0) {
            this.currentMenu = this.menuStack.pop();
            this.menuIndex = 0;
            this.renderMenu(this.currentMenu);
            this.focusMenuItem(0);
            this.announce('Back to main menu');
        }
    }

    // ==================== File Transfer ====================

    openFilePicker() {
        this.hideControlMenu();
        this.elements.fileInput.click();
    }

    sendFile(file) {
        if (this.remoteDesktop) {
            this.remoteDesktop.sendFile(file);
        }
    }

    showFileProgress(data) {
        let progressEl = document.getElementById('file-progress-' + data.fileId);

        if (!progressEl) {
            progressEl = document.createElement('div');
            progressEl.id = 'file-progress-' + data.fileId;
            progressEl.className = 'file-progress';
            progressEl.innerHTML = `
                <div class="file-name">${data.fileName}</div>
                <div class="progress-bar">
                    <div class="progress-bar-fill" style="width: 0%"></div>
                </div>
                <div class="progress-text">0%</div>
            `;
            document.body.appendChild(progressEl);
        }

        const fill = progressEl.querySelector('.progress-bar-fill');
        const text = progressEl.querySelector('.progress-text');
        fill.style.width = data.progress + '%';
        text.textContent = data.progress + '%';

        if (data.progress >= 100) {
            setTimeout(() => progressEl.remove(), 2000);
        }
    }

    handleFileReceived(data) {
        // Save file to disk (in Electron) or offer download (in browser)
        const url = URL.createObjectURL(data.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = data.fileName;
        a.click();
        URL.revokeObjectURL(url);
        this.announce(`File received: ${data.fileName}`);
    }

    // ==================== Machine Details ====================

    showMachineDetails(info) {
        this.hideControlMenu();

        const content = this.elements.detailsContent;
        content.innerHTML = '';

        const fields = [
            { label: 'Machine ID', value: info.id },
            { label: 'Hostname', value: info.hostname },
            { label: 'IP Address', value: info.ip || 'Not available' },
            { label: 'Platform', value: info.platform },
            { label: 'Operating System', value: info.os || info.userAgent },
            { label: 'Screen Resolution', value: info.screenResolution },
            { label: 'Color Depth', value: info.colorDepth ? `${info.colorDepth}-bit` : 'Unknown' },
            { label: 'Language', value: info.language },
            { label: 'Timezone', value: info.timezone }
        ];

        fields.forEach(field => {
            if (field.value) {
                const row = document.createElement('div');
                row.className = 'detail-row';
                row.innerHTML = `
                    <span class="detail-label">${field.label}</span>
                    <span class="detail-value">${field.value}</span>
                `;
                content.appendChild(row);
            }
        });

        this.elements.machineDetails.hidden = false;
        this.elements.closeDetails.focus();

        // Announce details
        const announcement = fields
            .filter(f => f.value)
            .map(f => `${f.label}: ${f.value}`)
            .join('. ');
        this.announce(announcement);
    }

    hideMachineDetails() {
        this.elements.machineDetails.hidden = true;
    }

    // ==================== Confirm Dialog ====================

    showConfirmDialog(data) {
        this.hideControlMenu();
        this.showModal('Confirm', data.message, [
            { label: 'Yes', action: data.onConfirm },
            { label: 'No', action: data.onCancel }
        ]);
    }

    // ==================== Connection ====================

    loadSettings() {
        const settings = JSON.parse(localStorage.getItem('openlink-settings') || '{}');

        if (settings.signalingServer) {
            this.elements.signalingServer.value = settings.signalingServer;
        }
        if (settings.keyboardMode) {
            this.elements.keyboardMode.value = settings.keyboardMode;
        }
        if (typeof settings.enableMic === 'boolean') {
            this.elements.enableMic.checked = settings.enableMic;
        }
        if (typeof settings.enableSystemAudio === 'boolean') {
            this.elements.enableSystemAudio.checked = settings.enableSystemAudio;
        }
    }

    saveSettings() {
        const settings = {
            signalingServer: this.elements.signalingServer.value,
            keyboardMode: this.elements.keyboardMode.value,
            enableMic: this.elements.enableMic.checked,
            enableSystemAudio: this.elements.enableSystemAudio.checked
        };
        localStorage.setItem('openlink-settings', JSON.stringify(settings));
    }

    getOptions() {
        return {
            signalingServer: this.elements.signalingServer.value,
            enableAudio: this.elements.enableMic.checked,
            captureSystemAudio: this.elements.enableSystemAudio.checked,
            quality: this.elements.quality.value,
            keyboardMode: 'remote',  // Always remote by default
            announceOnFocus: this.elements.announceFocus.checked,
            captureRemoteScreenReader: this.elements.captureRemoteSR.checked
        };
    }

    async startHosting() {
        try {
            this.announce('Starting screen sharing. You may see a permission dialog.', 'assertive');
            this.elements.btnHost.disabled = true;
            this.elements.btnHost.textContent = 'Starting...';

            const options = this.getOptions();

            this.remoteDesktop = new OpenLinkRemoteDesktop(options);
            this.setupRemoteDesktopEvents();

            this.sessionCode = this.generateSessionCode();

            await this.remoteDesktop.connect(this.sessionCode, true);

            this.isHost = true;
            this.showScreen('host');
            this.elements.displaySessionCode.textContent = this.sessionCode;
            this.announce(`Hosting started. Your session code is ${this.formatCodeForSpeech(this.sessionCode)}`, 'assertive');

        } catch (error) {
            console.error('Failed to start hosting:', error);
            this.showModal('Error', `Failed to start hosting: ${error.message}`);
            this.announce(`Error: ${error.message}`, 'assertive');
        } finally {
            this.elements.btnHost.disabled = false;
            this.elements.btnHost.textContent = 'Start Hosting';
        }
    }

    async connectToRemote() {
        const code = this.elements.sessionCodeInput.value.trim().toUpperCase();

        if (!code) {
            this.showModal('Error', 'Please enter a session code');
            this.announce('Please enter a session code', 'assertive');
            this.elements.sessionCodeInput.focus();
            return;
        }

        try {
            this.announce('Connecting to remote desktop...', 'assertive');
            this.elements.btnConnect.disabled = true;
            this.elements.btnConnect.textContent = 'Connecting...';

            const options = this.getOptions();

            this.remoteDesktop = new OpenLinkRemoteDesktop(options);
            this.setupRemoteDesktopEvents();

            this.sessionCode = code;
            await this.remoteDesktop.connect(code, false);

            this.isHost = false;
            this.showScreen('remote');
            this.updateConnectionStatus('connecting');

        } catch (error) {
            console.error('Failed to connect:', error);
            this.showModal('Connection Failed', error.message);
            this.announce(`Connection failed: ${error.message}`, 'assertive');
        } finally {
            this.elements.btnConnect.disabled = false;
            this.elements.btnConnect.textContent = 'Connect';
        }
    }

    showScreen(screenName) {
        Object.entries(this.screens).forEach(([name, el]) => {
            if (name === screenName) {
                el.classList.add('active');
                el.hidden = false;
            } else {
                el.classList.remove('active');
                el.hidden = true;
            }
        });

        setTimeout(() => {
            const screen = this.screens[screenName];
            const focusable = screen.querySelector('button, input, select, [tabindex="0"]');
            if (focusable) focusable.focus();
        }, 100);
    }

    updateConnectionStatus(status) {
        const indicator = this.elements.connectionStatus;
        if (indicator) {
            indicator.className = 'status-indicator ' + status;
            const text = indicator.querySelector('.text');
            if (text) {
                text.textContent = status.charAt(0).toUpperCase() + status.slice(1);
            }
        }
    }

    addClientToList(clientId) {
        const item = document.createElement('div');
        item.className = 'client-item';
        item.dataset.clientId = clientId;
        item.setAttribute('role', 'listitem');
        item.innerHTML = `
            <span class="dot" aria-hidden="true"></span>
            <span>Client ${clientId.slice(-4)}</span>
        `;
        this.elements.connectedClients.appendChild(item);
    }

    removeClientFromList(clientId) {
        if (!clientId) return;
        const item = this.elements.connectedClients.querySelector(`[data-client-id="${clientId}"]`);
        if (item) item.remove();
    }

    async copySessionCode() {
        try {
            await navigator.clipboard.writeText(this.sessionCode);
            this.announce('Session code copied to clipboard');
        } catch (error) {
            const input = document.createElement('input');
            input.value = this.sessionCode;
            document.body.appendChild(input);
            input.select();
            document.execCommand('copy');
            document.body.removeChild(input);
            this.announce('Session code copied');
        }
    }

    stopHosting() {
        if (this.remoteDesktop) {
            this.remoteDesktop.disconnect();
        }
        this.showScreen('connect');
        this.announce('Hosting stopped', 'assertive');
    }

    disconnect() {
        if (this.remoteDesktop) {
            this.remoteDesktop.disconnect();
        }
        this.showScreen('connect');
        this.announce('Disconnected from remote desktop', 'assertive');
    }

    toggleFullscreen() {
        if (document.fullscreenElement) {
            document.exitFullscreen();
            this.announce('Exited fullscreen');
        } else {
            this.elements.videoContainer.requestFullscreen();
            this.announce('Entered fullscreen. Press Escape to exit.');
        }
    }

    toggleFitToWindow() {
        const container = this.elements.videoContainer;
        const btn = this.elements.btnFit;

        container.classList.toggle('fit-to-window');
        const isFit = container.classList.contains('fit-to-window');
        btn?.setAttribute('aria-pressed', isFit);
        this.announce(isFit ? 'Video fit to window' : 'Video actual size');
    }

    cycleKeyboardMode() {
        if (this.remoteDesktop) {
            // Open control menu to change keyboard settings
            this.remoteDesktop.toggleMenu();
        }
    }

    toggleMicrophone() {
        if (this.remoteDesktop) {
            this.remoteDesktop.toggleMicrophone();
        }
    }

    toggleAudio() {
        const audio = this.elements.remoteAudio;
        if (audio) {
            audio.muted = !audio.muted;
            const btn = this.elements.btnToggleAudio;
            btn?.setAttribute('aria-pressed', !audio.muted);
            this.announce(audio.muted ? 'Audio muted' : 'Audio unmuted');
        }
    }

    showModal(title, message, buttons = null) {
        this.elements.modalTitle.textContent = title;
        this.elements.modalMessage.textContent = message;

        // Handle custom buttons if provided
        const actionsContainer = this.elements.modal.querySelector('.modal-actions');
        if (buttons && buttons.length > 0) {
            actionsContainer.innerHTML = '';
            buttons.forEach(btn => {
                const button = document.createElement('button');
                button.className = 'btn btn-primary';
                button.textContent = btn.label;
                button.addEventListener('click', () => {
                    this.hideModal();
                    if (btn.action) btn.action();
                });
                actionsContainer.appendChild(button);
            });
        } else {
            actionsContainer.innerHTML = '<button id="modal-close" class="btn btn-primary">OK</button>';
            document.getElementById('modal-close').addEventListener('click', () => this.hideModal());
        }

        this.elements.modal.hidden = false;
        const firstButton = actionsContainer.querySelector('button');
        if (firstButton) firstButton.focus();
    }

    hideModal() {
        this.elements.modal.hidden = true;
    }

    announce(text, priority = 'polite') {
        const el = priority === 'assertive' ? this.elements.srAlerts : this.elements.srAnnouncements;
        if (!el) return;

        el.textContent = '';
        requestAnimationFrame(() => {
            el.textContent = text;
        });
    }

    generateSessionCode() {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let code = '';
        for (let i = 0; i < 6; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return code;
    }

    formatCodeForSpeech(code) {
        return code.split('').join(' ');
    }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.app = new OpenLinkApp();
});
