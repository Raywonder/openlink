/**
 * OpenLink Remote Desktop - WebRTC Client
 * Accessible remote desktop with bidirectional audio support
 * All keys go to remote by default - Option+Shift+Backspace opens control menu
 */

class OpenLinkRemoteDesktop {
    constructor(options = {}) {
        this.options = {
            signalingServer: options.signalingServer || 'wss://api.devine-creations.com/ws/remote',
            stunServers: options.stunServers || [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ],
            turnServers: options.turnServers || [],
            enableAudio: options.enableAudio !== false,
            enableVideo: options.enableVideo !== false,
            keyboardMode: 'remote',  // Default: all keys go to remote
            menuHotkey: { alt: true, shift: true, key: 'Backspace' },  // Option+Shift+Backspace
            sharedFilesPath: 'Documents/OpenLink/shared_files',
            useLocalTTS: options.useLocalTTS || false,
            ...options
        };

        // Connection state
        this.peerConnection = null;
        this.dataChannel = null;
        this.signalingSocket = null;
        this.sessionId = null;
        this.isHost = false;
        this.isConnected = false;
        this.menuOpen = false;

        // Media streams
        this.localStream = null;
        this.remoteStream = null;
        this.screenStream = null;
        this.audioContext = null;
        this.audioMixer = null;

        // Audio state
        this.remoteAudioMuted = false;
        this.localMicMuted = false;

        // Remote machine info
        this.remoteMachineInfo = null;

        // Accessibility
        this.screenReaderOutput = [];
        this.announceQueue = [];
        this.localTTS = null;
        this.remoteScreenReaderEnabled = true;

        // Connection permissions
        this.trustedMachines = this.loadTrustedMachines();
        this.connectionPermission = 'ask';  // 'always', 'never', 'ask'

        // Control swap state
        this.controlSwapped = false;

        // File transfer
        this.pendingFiles = [];
        this.fileTransferProgress = {};

        // Event handlers
        this.eventHandlers = {};

        // Bind methods
        this.handleSignalingMessage = this.handleSignalingMessage.bind(this);
        this.handleDataChannelMessage = this.handleDataChannelMessage.bind(this);
        this.handleKeyDown = this.handleKeyDown.bind(this);

        // Initialize local TTS if enabled
        if (this.options.useLocalTTS) {
            this.initLocalTTS();
        }
    }

    // ==================== Local TTS ====================

    initLocalTTS() {
        if ('speechSynthesis' in window) {
            this.localTTS = window.speechSynthesis;
            console.log('[TTS] Local speech synthesis available');
        } else {
            console.warn('[TTS] Speech synthesis not available');
        }
    }

    speakLocal(text, priority = 'polite') {
        if (!this.localTTS) return;

        if (priority === 'assertive') {
            this.localTTS.cancel();  // Stop current speech
        }

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 1.0;
        utterance.pitch = 1.0;
        utterance.volume = 1.0;

        this.localTTS.speak(utterance);
    }

    // ==================== Control Menu ====================

    isMenuHotkey(e) {
        const hotkey = this.options.menuHotkey;
        return (
            e.altKey === (hotkey.alt || false) &&
            e.shiftKey === (hotkey.shift || false) &&
            e.ctrlKey === (hotkey.ctrl || false) &&
            e.metaKey === (hotkey.meta || false) &&
            e.key === hotkey.key
        );
    }

    handleKeyDown(e) {
        // Check for menu hotkey (Option+Shift+Backspace)
        if (this.isMenuHotkey(e)) {
            e.preventDefault();
            e.stopPropagation();
            this.toggleMenu();
            return false;
        }

        // If menu is open, handle menu navigation
        if (this.menuOpen) {
            e.preventDefault();
            e.stopPropagation();
            this.handleMenuKey(e);
            return false;
        }

        // If not connected or in local mode, don't send to remote
        if (!this.isConnected || this.options.keyboardMode === 'local') {
            return true;
        }

        // Send all other keys to remote
        this.sendKeyEvent(
            e.key,
            e.code,
            {
                ctrl: e.ctrlKey,
                alt: e.altKey,
                shift: e.shiftKey,
                meta: e.metaKey
            },
            true
        );

        e.preventDefault();
        return false;
    }

    toggleMenu() {
        this.menuOpen = !this.menuOpen;
        this.emit('menu_toggle', { open: this.menuOpen });

        if (this.menuOpen) {
            this.announce('OpenLink control menu. Use arrow keys to navigate, Enter to select, Escape to close.', 'assertive');
            this.emit('show_menu', this.getMenuItems());
        } else {
            this.announce('Menu closed. All keys now go to remote machine.', 'assertive');
            this.emit('hide_menu');
        }
    }

    getMenuItems() {
        return [
            {
                id: 'disconnect',
                label: 'Disconnect',
                description: 'End the remote session',
                action: () => this.disconnect()
            },
            {
                id: 'send_file',
                label: 'Send File',
                description: 'Send a file to the remote machine',
                action: () => this.openFilePicker()
            },
            {
                id: 'machine_details',
                label: 'Machine Details',
                description: 'View remote machine information',
                action: () => this.showMachineDetails()
            },
            {
                id: 'audio_settings',
                label: 'Audio Settings',
                submenu: [
                    {
                        id: 'mute_remote',
                        label: this.remoteAudioMuted ? 'Unmute Remote Audio' : 'Mute Remote Audio',
                        description: 'Mute audio from the remote machine',
                        action: () => this.toggleRemoteAudio()
                    },
                    {
                        id: 'mute_mic',
                        label: this.localMicMuted ? 'Unmute Microphone' : 'Mute Microphone',
                        description: 'Mute your microphone',
                        action: () => this.toggleMicrophone()
                    }
                ]
            },
            {
                id: 'screen_reader',
                label: 'Screen Reader Options',
                submenu: [
                    {
                        id: 'toggle_remote_sr',
                        label: this.remoteScreenReaderEnabled ? 'Disable Remote Screen Reader' : 'Enable Remote Screen Reader',
                        description: 'Toggle screen reader on remote machine',
                        action: () => this.toggleRemoteScreenReader()
                    },
                    {
                        id: 'toggle_local_tts',
                        label: this.options.useLocalTTS ? 'Disable Local TTS' : 'Enable Local TTS',
                        description: 'Use local text-to-speech instead of remote screen reader',
                        action: () => this.toggleLocalTTS()
                    }
                ]
            },
            {
                id: 'swap_control',
                label: this.controlSwapped ? 'Take Back Control' : 'Let Remote Control Your Machine',
                description: 'Swap who controls which machine',
                action: () => this.swapControl()
            },
            {
                id: 'connection_permissions',
                label: 'Connection Permissions',
                submenu: [
                    {
                        id: 'always_allow',
                        label: 'Always Allow This Machine',
                        action: () => this.setConnectionPermission('always')
                    },
                    {
                        id: 'always_deny',
                        label: 'Always Deny This Machine',
                        action: () => this.setConnectionPermission('never')
                    },
                    {
                        id: 'ask_each_time',
                        label: 'Ask Each Time',
                        action: () => this.setConnectionPermission('ask')
                    }
                ]
            },
            {
                id: 'restart_remote',
                label: 'Restart Remote Machine',
                description: 'Send restart command to remote',
                action: () => this.confirmRestartRemote()
            }
        ];
    }

    handleMenuKey(e) {
        switch (e.key) {
            case 'Escape':
                this.toggleMenu();
                break;
            case 'ArrowUp':
            case 'ArrowDown':
            case 'ArrowLeft':
            case 'ArrowRight':
            case 'Enter':
            case ' ':
                this.emit('menu_navigate', { key: e.key });
                break;
        }
    }

    // ==================== File Transfer ====================

    openFilePicker() {
        this.emit('open_file_picker');
    }

    async sendFile(file) {
        if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
            this.announce('Cannot send file: not connected');
            return;
        }

        const fileId = Date.now().toString(36);
        const chunkSize = 16384;  // 16KB chunks
        const totalChunks = Math.ceil(file.size / chunkSize);

        this.announce(`Sending ${file.name}...`);

        // Send file header
        this.sendData({
            type: 'file_start',
            fileId,
            fileName: file.name,
            fileSize: file.size,
            fileType: file.type,
            totalChunks,
            savePath: this.options.sharedFilesPath
        });

        // Read and send file in chunks
        const reader = new FileReader();
        let offset = 0;
        let chunkIndex = 0;

        const readNextChunk = () => {
            const slice = file.slice(offset, offset + chunkSize);
            reader.readAsArrayBuffer(slice);
        };

        reader.onload = (e) => {
            const chunk = e.target.result;
            const base64 = btoa(String.fromCharCode(...new Uint8Array(chunk)));

            this.sendData({
                type: 'file_chunk',
                fileId,
                chunkIndex,
                data: base64
            });

            offset += chunkSize;
            chunkIndex++;

            const progress = Math.round((chunkIndex / totalChunks) * 100);
            this.fileTransferProgress[fileId] = progress;
            this.emit('file_progress', { fileId, progress, fileName: file.name });

            if (offset < file.size) {
                readNextChunk();
            } else {
                this.sendData({
                    type: 'file_complete',
                    fileId
                });
                this.announce(`${file.name} sent successfully`);
                delete this.fileTransferProgress[fileId];
            }
        };

        reader.onerror = () => {
            this.announce(`Failed to send ${file.name}`);
            this.sendData({
                type: 'file_error',
                fileId,
                error: 'Read error'
            });
        };

        readNextChunk();
    }

    handleFileReceive(message) {
        switch (message.type) {
            case 'file_start':
                this.pendingFiles[message.fileId] = {
                    name: message.fileName,
                    size: message.fileSize,
                    type: message.fileType,
                    chunks: [],
                    totalChunks: message.totalChunks,
                    savePath: message.savePath
                };
                this.announce(`Receiving file: ${message.fileName}`);
                break;

            case 'file_chunk':
                if (this.pendingFiles[message.fileId]) {
                    this.pendingFiles[message.fileId].chunks[message.chunkIndex] = message.data;

                    const received = this.pendingFiles[message.fileId].chunks.filter(c => c).length;
                    const total = this.pendingFiles[message.fileId].totalChunks;
                    const progress = Math.round((received / total) * 100);
                    this.emit('file_progress', {
                        fileId: message.fileId,
                        progress,
                        fileName: this.pendingFiles[message.fileId].name
                    });
                }
                break;

            case 'file_complete':
                this.completeFileReceive(message.fileId);
                break;
        }
    }

    completeFileReceive(fileId) {
        const file = this.pendingFiles[fileId];
        if (!file) return;

        // Combine chunks
        const fullData = file.chunks.join('');
        const binary = atob(fullData);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }

        const blob = new Blob([bytes], { type: file.type });

        this.emit('file_received', {
            fileId,
            fileName: file.name,
            blob,
            savePath: file.savePath
        });

        this.announce(`Received file: ${file.name}`);
        delete this.pendingFiles[fileId];
    }

    // ==================== Machine Details ====================

    showMachineDetails() {
        if (this.remoteMachineInfo) {
            this.emit('show_machine_details', this.remoteMachineInfo);

            const info = this.remoteMachineInfo;
            const details = `
                Machine: ${info.hostname || 'Unknown'}
                IP Address: ${info.ip || 'Unknown'}
                Operating System: ${info.os || 'Unknown'}
                Platform: ${info.platform || 'Unknown'}
                CPU: ${info.cpu || 'Unknown'}
                Memory: ${info.memory || 'Unknown'}
                Screen Resolution: ${info.screenResolution || 'Unknown'}
            `;
            this.announce(details);
        } else {
            this.requestMachineInfo();
        }
    }

    requestMachineInfo() {
        this.sendData({
            type: 'request_machine_info'
        });
    }

    handleMachineInfo(info) {
        this.remoteMachineInfo = info;
        this.emit('machine_info_received', info);
    }

    // ==================== Audio Settings ====================

    toggleRemoteAudio() {
        this.remoteAudioMuted = !this.remoteAudioMuted;

        if (this.audioMixer?.gainNode) {
            this.audioMixer.gainNode.gain.value = this.remoteAudioMuted ? 0 : 1;
        }

        this.announce(this.remoteAudioMuted ? 'Remote audio muted' : 'Remote audio unmuted');
        this.emit('remote_audio_toggle', { muted: this.remoteAudioMuted });
    }

    toggleMicrophone() {
        this.localMicMuted = !this.localMicMuted;

        if (this.localStream) {
            this.localStream.getAudioTracks().forEach(track => {
                track.enabled = !this.localMicMuted;
            });
        }

        this.announce(this.localMicMuted ? 'Microphone muted' : 'Microphone unmuted');
        this.emit('mic_toggle', { muted: this.localMicMuted });
    }

    // ==================== Screen Reader Control ====================

    toggleRemoteScreenReader() {
        this.remoteScreenReaderEnabled = !this.remoteScreenReaderEnabled;

        this.sendData({
            type: 'toggle_screen_reader',
            enabled: this.remoteScreenReaderEnabled
        });

        this.announce(this.remoteScreenReaderEnabled
            ? 'Remote screen reader enabled'
            : 'Remote screen reader disabled');
    }

    toggleLocalTTS() {
        this.options.useLocalTTS = !this.options.useLocalTTS;

        if (this.options.useLocalTTS && !this.localTTS) {
            this.initLocalTTS();
        }

        this.announce(this.options.useLocalTTS
            ? 'Using local text-to-speech'
            : 'Using remote screen reader');

        this.emit('tts_mode_change', { useLocalTTS: this.options.useLocalTTS });
    }

    // ==================== Control Swap ====================

    swapControl() {
        this.controlSwapped = !this.controlSwapped;

        this.sendData({
            type: 'swap_control',
            swapped: this.controlSwapped
        });

        if (this.controlSwapped) {
            this.announce('Control swapped. The remote user can now control your machine. Press Option+Shift+Backspace to take back control.');
        } else {
            this.announce('Control restored. You are now controlling the remote machine.');
        }

        this.emit('control_swapped', { swapped: this.controlSwapped });
    }

    // ==================== Connection Permissions ====================

    loadTrustedMachines() {
        try {
            const stored = localStorage.getItem('openlink-trusted-machines');
            return stored ? JSON.parse(stored) : {};
        } catch {
            return {};
        }
    }

    saveTrustedMachines() {
        try {
            localStorage.setItem('openlink-trusted-machines', JSON.stringify(this.trustedMachines));
        } catch (e) {
            console.warn('[Permissions] Failed to save trusted machines:', e);
        }
    }

    setConnectionPermission(permission) {
        const machineId = this.remoteMachineInfo?.id || this.sessionId;

        this.trustedMachines[machineId] = permission;
        this.saveTrustedMachines();

        const messages = {
            always: 'This machine will always be allowed to connect',
            never: 'This machine will always be denied connection',
            ask: 'You will be asked each time this machine tries to connect'
        };

        this.announce(messages[permission]);
        this.emit('permission_changed', { machineId, permission });
    }

    checkConnectionPermission(machineId) {
        return this.trustedMachines[machineId] || 'ask';
    }

    // ==================== Remote Machine Control ====================

    confirmRestartRemote() {
        this.emit('confirm_restart', {
            message: 'Are you sure you want to restart the remote machine?',
            onConfirm: () => this.restartRemote(),
            onCancel: () => this.announce('Restart cancelled')
        });
    }

    restartRemote() {
        this.sendData({
            type: 'system_command',
            command: 'restart'
        });
        this.announce('Restart command sent to remote machine');
    }

    // ==================== Connection Management ====================

    async connect(sessionId, asHost = false) {
        this.sessionId = sessionId;
        this.isHost = asHost;

        try {
            // Connect to signaling server
            await this.connectSignaling();

            // Create peer connection
            this.createPeerConnection();

            // If host, start sharing screen and audio
            if (asHost) {
                await this.startHostStreams();
            }

            // Set up keyboard handler
            document.addEventListener('keydown', this.handleKeyDown, true);
            document.addEventListener('keyup', (e) => {
                if (this.menuOpen || !this.isConnected) return;
                if (this.options.keyboardMode === 'local') return;

                this.sendKeyEvent(
                    e.key,
                    e.code,
                    {
                        ctrl: e.ctrlKey,
                        alt: e.altKey,
                        shift: e.shiftKey,
                        meta: e.metaKey
                    },
                    false
                );
            }, true);

            // Join the session
            this.sendSignaling({
                type: 'join',
                sessionId: this.sessionId,
                isHost: this.isHost
            });

            this.announce('Connecting to remote session. Press Option+Shift+Backspace to open control menu.');
            return true;
        } catch (error) {
            console.error('[RemoteDesktop] Connection failed:', error);
            this.announce('Connection failed: ' + error.message);
            throw error;
        }
    }

    async disconnect() {
        this.announce('Disconnecting from remote session');
        this.menuOpen = false;

        // Remove keyboard handler
        document.removeEventListener('keydown', this.handleKeyDown, true);

        // Stop all streams
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }
        if (this.screenStream) {
            this.screenStream.getTracks().forEach(track => track.stop());
            this.screenStream = null;
        }

        // Close data channel
        if (this.dataChannel) {
            this.dataChannel.close();
            this.dataChannel = null;
        }

        // Close peer connection
        if (this.peerConnection) {
            this.peerConnection.close();
            this.peerConnection = null;
        }

        // Close signaling
        if (this.signalingSocket) {
            this.signalingSocket.close();
            this.signalingSocket = null;
        }

        // Close audio context
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }

        this.isConnected = false;
        this.emit('disconnected');
    }

    // ==================== Signaling ====================

    async connectSignaling() {
        return new Promise((resolve, reject) => {
            this.signalingSocket = new WebSocket(this.options.signalingServer);

            this.signalingSocket.onopen = () => {
                console.log('[Signaling] Connected');
                resolve();
            };

            this.signalingSocket.onmessage = (event) => {
                const message = JSON.parse(event.data);
                this.handleSignalingMessage(message);
            };

            this.signalingSocket.onerror = (error) => {
                console.error('[Signaling] Error:', error);
                reject(error);
            };

            this.signalingSocket.onclose = () => {
                console.log('[Signaling] Disconnected');
                if (this.isConnected) {
                    this.emit('signaling_disconnected');
                }
            };
        });
    }

    sendSignaling(message) {
        if (this.signalingSocket?.readyState === WebSocket.OPEN) {
            this.signalingSocket.send(JSON.stringify(message));
        }
    }

    async handleSignalingMessage(message) {
        console.log('[Signaling] Received:', message.type);

        switch (message.type) {
            case 'joined':
                this.announce('Joined session. Waiting for peer...');
                break;

            case 'peer_joined':
                this.announce('Peer connected. Establishing connection...');
                this.emit('peer_joined', { peerId: message.fromId });
                if (this.isHost) {
                    await this.createOffer();
                }
                break;

            case 'offer':
                await this.handleOffer(message.sdp);
                break;

            case 'answer':
                await this.handleAnswer(message.sdp);
                break;

            case 'ice_candidate':
                await this.handleIceCandidate(message.candidate);
                break;

            case 'peer_disconnected':
                this.announce('Peer disconnected');
                this.emit('peer_disconnected');
                break;

            case 'error':
                this.announce('Error: ' + message.message);
                this.emit('error', { message: message.message });
                break;
        }
    }

    // ==================== WebRTC Connection ====================

    createPeerConnection() {
        const config = {
            iceServers: [
                ...this.options.stunServers,
                ...this.options.turnServers
            ]
        };

        this.peerConnection = new RTCPeerConnection(config);

        // ICE candidate handling
        this.peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                this.sendSignaling({
                    type: 'ice_candidate',
                    candidate: event.candidate,
                    sessionId: this.sessionId
                });
            }
        };

        // Connection state
        this.peerConnection.onconnectionstatechange = () => {
            const state = this.peerConnection.connectionState;
            console.log('[WebRTC] Connection state:', state);

            if (state === 'connected') {
                this.isConnected = true;
                this.announce('Connected to remote desktop. Press Option+Shift+Backspace for control menu.');
                this.emit('connected');
                // Request machine info on connect
                this.requestMachineInfo();
            } else if (state === 'disconnected' || state === 'failed') {
                this.isConnected = false;
                this.announce('Connection lost');
                this.emit('connection_lost');
            }
        };

        // Remote track handling
        this.peerConnection.ontrack = (event) => {
            console.log('[WebRTC] Remote track received:', event.track.kind);

            if (!this.remoteStream) {
                this.remoteStream = new MediaStream();
            }

            this.remoteStream.addTrack(event.track);

            if (event.track.kind === 'video') {
                this.emit('remote_video', this.remoteStream);
                this.announce('Remote screen received');
            } else if (event.track.kind === 'audio') {
                this.emit('remote_audio', this.remoteStream);
                this.setupRemoteAudio(this.remoteStream);
            }
        };

        // Data channel for input events and accessibility
        this.peerConnection.ondatachannel = (event) => {
            this.setupDataChannel(event.channel);
        };

        // Create data channel if host
        if (this.isHost) {
            const channel = this.peerConnection.createDataChannel('control', {
                ordered: true
            });
            this.setupDataChannel(channel);
        }
    }

    setupDataChannel(channel) {
        this.dataChannel = channel;

        this.dataChannel.onopen = () => {
            console.log('[DataChannel] Open');
            this.emit('data_channel_open');
        };

        this.dataChannel.onclose = () => {
            console.log('[DataChannel] Closed');
        };

        this.dataChannel.onmessage = (event) => {
            this.handleDataChannelMessage(JSON.parse(event.data));
        };
    }

    async createOffer() {
        try {
            const offer = await this.peerConnection.createOffer();
            await this.peerConnection.setLocalDescription(offer);

            this.sendSignaling({
                type: 'offer',
                sdp: offer,
                sessionId: this.sessionId
            });
        } catch (error) {
            console.error('[WebRTC] Create offer failed:', error);
            throw error;
        }
    }

    async handleOffer(sdp) {
        try {
            await this.peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));

            const answer = await this.peerConnection.createAnswer();
            await this.peerConnection.setLocalDescription(answer);

            this.sendSignaling({
                type: 'answer',
                sdp: answer,
                sessionId: this.sessionId
            });
        } catch (error) {
            console.error('[WebRTC] Handle offer failed:', error);
            throw error;
        }
    }

    async handleAnswer(sdp) {
        try {
            await this.peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
        } catch (error) {
            console.error('[WebRTC] Handle answer failed:', error);
            throw error;
        }
    }

    async handleIceCandidate(candidate) {
        try {
            await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (error) {
            console.error('[WebRTC] Add ICE candidate failed:', error);
        }
    }

    // ==================== Media Streams ====================

    async startHostStreams() {
        // Get screen share with system audio
        try {
            this.screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    cursor: 'always',
                    displaySurface: 'monitor'
                },
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false
                }
            });

            // Add screen video track
            const videoTrack = this.screenStream.getVideoTracks()[0];
            if (videoTrack) {
                this.peerConnection.addTrack(videoTrack, this.screenStream);
            }

            // Add system audio if available
            const audioTracks = this.screenStream.getAudioTracks();
            if (audioTracks.length > 0) {
                this.peerConnection.addTrack(audioTracks[0], this.screenStream);
            }

            // Handle screen share ended
            videoTrack.onended = () => {
                this.announce('Screen sharing stopped');
                this.emit('screen_share_ended');
            };

        } catch (error) {
            console.error('[Media] Screen share failed:', error);
            this.announce('Screen sharing failed: ' + error.message);
            throw error;
        }

        // Get microphone for bidirectional audio
        if (this.options.enableAudio) {
            try {
                this.localStream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true
                    }
                });

                const micTrack = this.localStream.getAudioTracks()[0];
                if (micTrack) {
                    this.peerConnection.addTrack(micTrack, this.localStream);
                }
            } catch (error) {
                console.warn('[Media] Microphone access denied:', error);
            }
        }
    }

    async startClientAudio() {
        if (!this.options.enableAudio) return;

        try {
            this.localStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });

            const micTrack = this.localStream.getAudioTracks()[0];
            if (micTrack) {
                this.peerConnection.addTrack(micTrack, this.localStream);
            }

            this.announce('Microphone enabled');
        } catch (error) {
            console.warn('[Media] Microphone access denied:', error);
            this.announce('Microphone access denied');
        }
    }

    setupRemoteAudio(stream) {
        // Create audio context for mixing and playback
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();

        const source = this.audioContext.createMediaStreamSource(stream);
        const gainNode = this.audioContext.createGain();
        gainNode.gain.value = this.remoteAudioMuted ? 0 : 1;

        source.connect(gainNode);
        gainNode.connect(this.audioContext.destination);

        this.audioMixer = { source, gainNode };
    }

    setRemoteVolume(volume) {
        if (this.audioMixer?.gainNode) {
            this.audioMixer.gainNode.gain.value = Math.max(0, Math.min(1, volume));
        }
    }

    // ==================== Input Handling ====================

    handleDataChannelMessage(message) {
        switch (message.type) {
            case 'mouse_move':
                this.emit('remote_mouse_move', message);
                break;

            case 'mouse_click':
                this.emit('remote_mouse_click', message);
                break;

            case 'mouse_scroll':
                this.emit('remote_mouse_scroll', message);
                break;

            case 'key_event':
                this.emit('remote_key_event', message);
                break;

            case 'accessibility_announce':
                this.handleAccessibilityAnnounce(message);
                break;

            case 'screen_reader_output':
                this.handleScreenReaderOutput(message);
                break;

            case 'clipboard':
                this.emit('remote_clipboard', message);
                break;

            case 'machine_info':
                this.handleMachineInfo(message.info);
                break;

            case 'file_start':
            case 'file_chunk':
            case 'file_complete':
            case 'file_error':
                this.handleFileReceive(message);
                break;

            case 'swap_control':
                this.controlSwapped = message.swapped;
                this.emit('control_swapped', { swapped: message.swapped });
                break;

            case 'request_machine_info':
                this.sendMachineInfo();
                break;
        }
    }

    sendMachineInfo() {
        const info = {
            id: this.sessionId,
            hostname: window.location.hostname || 'localhost',
            platform: navigator.platform,
            userAgent: navigator.userAgent,
            language: navigator.language,
            screenResolution: `${screen.width}x${screen.height}`,
            colorDepth: screen.colorDepth,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
        };

        this.sendData({
            type: 'machine_info',
            info
        });
    }

    sendMouseMove(x, y, width, height) {
        this.sendData({
            type: 'mouse_move',
            x: x / width,
            y: y / height,
            timestamp: Date.now()
        });
    }

    sendMouseClick(button, x, y, width, height, isDouble = false) {
        this.sendData({
            type: 'mouse_click',
            button,
            x: x / width,
            y: y / height,
            double: isDouble,
            timestamp: Date.now()
        });
    }

    sendMouseScroll(deltaX, deltaY) {
        this.sendData({
            type: 'mouse_scroll',
            deltaX,
            deltaY,
            timestamp: Date.now()
        });
    }

    sendKeyEvent(key, code, modifiers, isDown) {
        this.sendData({
            type: 'key_event',
            key,
            code,
            modifiers,
            isDown,
            timestamp: Date.now()
        });
    }

    sendClipboard(text) {
        this.sendData({
            type: 'clipboard',
            text,
            timestamp: Date.now()
        });
    }

    sendData(data) {
        if (this.dataChannel?.readyState === 'open') {
            this.dataChannel.send(JSON.stringify(data));
        }
    }

    // ==================== Accessibility ====================

    handleAccessibilityAnnounce(message) {
        this.announce(message.text, message.priority || 'polite');
    }

    handleScreenReaderOutput(message) {
        this.screenReaderOutput.push({
            text: message.text,
            timestamp: Date.now()
        });

        if (this.screenReaderOutput.length > 100) {
            this.screenReaderOutput.shift();
        }

        // Use local TTS if enabled, otherwise ARIA live region
        if (this.options.useLocalTTS) {
            this.speakLocal(message.text, message.priority);
        } else {
            this.announce(message.text, message.priority);
        }

        this.emit('screen_reader_output', message);
    }

    announce(text, priority = 'polite') {
        this.announceQueue.push({ text, priority });
        this.processAnnounceQueue();
    }

    processAnnounceQueue() {
        if (this.announceQueue.length === 0) return;

        const { text, priority } = this.announceQueue.shift();

        // Use local TTS if enabled
        if (this.options.useLocalTTS) {
            this.speakLocal(text, priority);
        }

        // Create ARIA live region announcement
        let liveRegion = document.getElementById('openlink-remote-announcer');
        if (!liveRegion) {
            liveRegion = document.createElement('div');
            liveRegion.id = 'openlink-remote-announcer';
            liveRegion.setAttribute('role', 'status');
            liveRegion.setAttribute('aria-live', priority);
            liveRegion.setAttribute('aria-atomic', 'true');
            liveRegion.className = 'sr-only';
            liveRegion.style.cssText = 'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);border:0;';
            document.body.appendChild(liveRegion);
        }

        liveRegion.setAttribute('aria-live', priority);
        liveRegion.textContent = '';

        setTimeout(() => {
            liveRegion.textContent = text;
        }, 100);

        if (this.announceQueue.length > 0) {
            setTimeout(() => this.processAnnounceQueue(), 500);
        }

        this.emit('announcement', { text, priority });
    }

    getScreenReaderHistory() {
        return [...this.screenReaderOutput];
    }

    // ==================== Event System ====================

    on(event, handler) {
        if (!this.eventHandlers[event]) {
            this.eventHandlers[event] = [];
        }
        this.eventHandlers[event].push(handler);
    }

    off(event, handler) {
        if (this.eventHandlers[event]) {
            this.eventHandlers[event] = this.eventHandlers[event].filter(h => h !== handler);
        }
    }

    emit(event, data) {
        if (this.eventHandlers[event]) {
            this.eventHandlers[event].forEach(handler => handler(data));
        }
    }

    // ==================== Session Management ====================

    generateSessionId() {
        return 'ol-' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
    }

    async createSession() {
        const sessionId = this.generateSessionId();
        await this.connect(sessionId, true);
        return sessionId;
    }

    async joinSession(sessionId) {
        await this.connect(sessionId, false);
        await this.startClientAudio();
    }

    getConnectionState() {
        return {
            isConnected: this.isConnected,
            isHost: this.isHost,
            sessionId: this.sessionId,
            peerState: this.peerConnection?.connectionState,
            dataChannelState: this.dataChannel?.readyState,
            menuOpen: this.menuOpen,
            controlSwapped: this.controlSwapped
        };
    }
}

// Export for module use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = OpenLinkRemoteDesktop;
}

// Global export for browser
if (typeof window !== 'undefined') {
    window.OpenLinkRemoteDesktop = OpenLinkRemoteDesktop;
}
