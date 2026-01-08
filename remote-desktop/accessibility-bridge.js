/**
 * OpenLink Remote Desktop - Accessibility Bridge
 * Enables VoiceOver/NVDA/JAWS to work with remote desktop
 * Captures remote screen reader output and relays to local screen reader
 */

class AccessibilityBridge {
    constructor(remoteDesktop, options = {}) {
        this.remoteDesktop = remoteDesktop;
        this.options = {
            captureRemoteScreenReader: true,
            announceOnFocus: true,
            keyboardMode: 'hybrid',  // 'hybrid', 'local', 'remote'
            screenReaderType: this.detectScreenReader(),
            ...options
        };

        this.isEnabled = true;
        this.focusHistory = [];
        this.lastAnnouncement = '';
        this.announcementBuffer = [];
        this.bufferTimeout = null;

        // Screen reader key mappings
        this.screenReaderKeys = this.getScreenReaderKeys();

        this.init();
    }

    init() {
        // Set up keyboard interception
        this.setupKeyboardHandler();

        // Set up remote screen reader output handling
        this.remoteDesktop.on('screen_reader_output', (data) => {
            this.handleRemoteScreenReaderOutput(data);
        });

        // Set up focus announcements
        this.remoteDesktop.on('remote_focus_change', (data) => {
            this.handleRemoteFocusChange(data);
        });

        // Create accessibility container
        this.createAccessibilityContainer();
    }

    detectScreenReader() {
        // Detect based on platform and common indicators
        const platform = navigator.platform.toLowerCase();

        if (platform.includes('mac')) {
            return 'voiceover';
        } else if (platform.includes('win')) {
            // Could be NVDA, JAWS, or Narrator
            // Default to NVDA as most common free option
            return 'nvda';
        } else {
            // Linux - Orca
            return 'orca';
        }
    }

    getScreenReaderKeys() {
        return {
            voiceover: {
                modifier: ['Control', 'Alt'],  // Ctrl+Option on Mac
                commands: {
                    'read_all': ['a'],
                    'stop': ['Control'],
                    'next_item': ['ArrowRight'],
                    'previous_item': ['ArrowLeft'],
                    'interact': ['Shift', 'ArrowDown'],
                    'stop_interact': ['Shift', 'ArrowUp'],
                    'read_current': ['a'],
                    'rotor': ['u']
                }
            },
            nvda: {
                modifier: ['Insert'],  // NVDA key
                commands: {
                    'read_all': ['ArrowDown'],
                    'stop': ['Control'],
                    'next_item': ['Tab'],
                    'previous_item': ['Shift', 'Tab'],
                    'read_current': ['Tab'],
                    'elements_list': ['F7']
                }
            },
            jaws: {
                modifier: ['Insert'],  // JAWS key
                commands: {
                    'read_all': ['ArrowDown'],
                    'stop': ['Control'],
                    'virtual_cursor': ['z']
                }
            },
            orca: {
                modifier: ['Insert', 'CapsLock'],
                commands: {
                    'read_all': ['KP_Add'],
                    'stop': ['Control']
                }
            }
        };
    }

    setupKeyboardHandler() {
        document.addEventListener('keydown', (e) => {
            if (!this.isEnabled) return;

            // Check if this is a screen reader command
            if (this.isScreenReaderCommand(e)) {
                // Let it pass through to local screen reader
                return;
            }

            // In hybrid mode, special handling
            if (this.options.keyboardMode === 'hybrid') {
                // Pass navigation keys to remote, except when screen reader modifier is held
                if (this.hasScreenReaderModifier(e)) {
                    return; // Local screen reader handles it
                }
            }

            if (this.options.keyboardMode === 'local') {
                return; // All keys stay local
            }

            // Send to remote
            this.remoteDesktop.sendKeyEvent(
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

            // Prevent default for remote-bound keys
            if (this.options.keyboardMode === 'remote') {
                e.preventDefault();
            }
        }, true);

        document.addEventListener('keyup', (e) => {
            if (!this.isEnabled) return;

            if (this.isScreenReaderCommand(e)) {
                return;
            }

            if (this.options.keyboardMode !== 'local') {
                this.remoteDesktop.sendKeyEvent(
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
            }
        }, true);
    }

    isScreenReaderCommand(event) {
        const srKeys = this.screenReaderKeys[this.options.screenReaderType];
        if (!srKeys) return false;

        // Check if modifier keys match
        const modifiers = srKeys.modifier;
        let hasModifier = false;

        for (const mod of modifiers) {
            if (mod === 'Control' && event.ctrlKey) hasModifier = true;
            if (mod === 'Alt' && event.altKey) hasModifier = true;
            if (mod === 'Insert' && event.key === 'Insert') hasModifier = true;
            if (mod === 'CapsLock' && event.getModifierState('CapsLock')) hasModifier = true;
        }

        return hasModifier;
    }

    hasScreenReaderModifier(event) {
        const srKeys = this.screenReaderKeys[this.options.screenReaderType];
        if (!srKeys) return false;

        const modifiers = srKeys.modifier;
        for (const mod of modifiers) {
            if (mod === 'Control' && event.ctrlKey) return true;
            if (mod === 'Alt' && event.altKey) return true;
        }
        return false;
    }

    createAccessibilityContainer() {
        // Create hidden container for screen reader announcements
        const container = document.createElement('div');
        container.id = 'openlink-a11y-container';
        container.setAttribute('role', 'application');
        container.setAttribute('aria-label', 'OpenLink Remote Desktop');
        container.innerHTML = `
            <div id="openlink-a11y-status" role="status" aria-live="polite" aria-atomic="true" class="sr-only"></div>
            <div id="openlink-a11y-alert" role="alert" aria-live="assertive" aria-atomic="true" class="sr-only"></div>
            <div id="openlink-a11y-log" role="log" aria-live="polite" aria-relevant="additions" class="sr-only"></div>
        `;
        container.style.cssText = 'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);border:0;';
        document.body.appendChild(container);

        this.statusElement = document.getElementById('openlink-a11y-status');
        this.alertElement = document.getElementById('openlink-a11y-alert');
        this.logElement = document.getElementById('openlink-a11y-log');
    }

    handleRemoteScreenReaderOutput(data) {
        if (!this.options.captureRemoteScreenReader) return;

        const { text, type, priority } = data;

        // Deduplicate rapid announcements
        if (text === this.lastAnnouncement) return;
        this.lastAnnouncement = text;

        // Buffer announcements to prevent overwhelming the screen reader
        this.announcementBuffer.push({ text, type, priority });

        if (!this.bufferTimeout) {
            this.bufferTimeout = setTimeout(() => {
                this.flushAnnouncementBuffer();
            }, 150);
        }
    }

    flushAnnouncementBuffer() {
        if (this.announcementBuffer.length === 0) {
            this.bufferTimeout = null;
            return;
        }

        // Combine buffered announcements
        const combined = this.announcementBuffer
            .map(a => a.text)
            .join('. ');

        const highestPriority = this.announcementBuffer
            .some(a => a.priority === 'assertive') ? 'assertive' : 'polite';

        this.announce(combined, highestPriority);

        this.announcementBuffer = [];
        this.bufferTimeout = null;
    }

    handleRemoteFocusChange(data) {
        if (!this.options.announceOnFocus) return;

        const { element, label, role, value } = data;

        // Build focus announcement
        let announcement = '';

        if (label) {
            announcement += label;
        }

        if (role && role !== 'generic') {
            announcement += `, ${this.getRoleName(role)}`;
        }

        if (value) {
            announcement += `, ${value}`;
        }

        if (announcement) {
            this.announce(announcement, 'polite');
        }

        // Track focus history
        this.focusHistory.push({
            ...data,
            timestamp: Date.now()
        });

        // Keep last 50 focus changes
        if (this.focusHistory.length > 50) {
            this.focusHistory.shift();
        }
    }

    getRoleName(role) {
        const roleNames = {
            'button': 'button',
            'link': 'link',
            'textbox': 'text field',
            'checkbox': 'checkbox',
            'radio': 'radio button',
            'combobox': 'combo box',
            'listbox': 'list box',
            'menu': 'menu',
            'menuitem': 'menu item',
            'tab': 'tab',
            'tabpanel': 'tab panel',
            'dialog': 'dialog',
            'alert': 'alert',
            'alertdialog': 'alert dialog',
            'progressbar': 'progress bar',
            'slider': 'slider',
            'spinbutton': 'spin button',
            'searchbox': 'search field',
            'tree': 'tree',
            'treeitem': 'tree item',
            'grid': 'grid',
            'gridcell': 'cell',
            'row': 'row',
            'heading': 'heading',
            'img': 'image',
            'figure': 'figure',
            'table': 'table',
            'list': 'list',
            'listitem': 'list item'
        };

        return roleNames[role] || role;
    }

    announce(text, priority = 'polite') {
        const element = priority === 'assertive' ? this.alertElement : this.statusElement;

        if (!element) return;

        // Clear and re-set to trigger announcement
        element.textContent = '';

        requestAnimationFrame(() => {
            element.textContent = text;
        });

        // Also add to log for history
        if (this.logElement) {
            const entry = document.createElement('div');
            entry.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
            this.logElement.appendChild(entry);

            // Keep last 20 log entries
            while (this.logElement.children.length > 20) {
                this.logElement.removeChild(this.logElement.firstChild);
            }
        }
    }

    announceConnectionStatus(status) {
        const messages = {
            connecting: 'Connecting to remote desktop...',
            connected: 'Connected to remote desktop. Press Control plus Option plus Shift plus R to read remote screen reader output.',
            disconnected: 'Disconnected from remote desktop.',
            error: 'Connection error occurred.',
            reconnecting: 'Attempting to reconnect...'
        };

        this.announce(messages[status] || status, 'assertive');
    }

    setKeyboardMode(mode) {
        this.options.keyboardMode = mode;

        const modeDescriptions = {
            hybrid: 'Hybrid mode: Screen reader commands stay local, other keys go to remote.',
            local: 'Local mode: All keyboard input stays on this computer.',
            remote: 'Remote mode: All keyboard input goes to remote computer.'
        };

        this.announce(modeDescriptions[mode] || `Keyboard mode set to ${mode}`, 'polite');
    }

    getKeyboardShortcutsHelp() {
        const shortcuts = [
            'Keyboard shortcuts for OpenLink Remote Desktop:',
            'Control plus Shift plus K: Toggle keyboard mode',
            'Control plus Shift plus M: Toggle microphone',
            'Control plus Shift plus A: Read last remote announcement',
            'Control plus Shift plus H: Read screen reader output history',
            'Escape: Exit full screen',
            'Control plus Shift plus D: Disconnect'
        ];

        return shortcuts.join('. ');
    }

    readHistory(count = 5) {
        const history = this.remoteDesktop.getScreenReaderHistory();
        const recent = history.slice(-count);

        if (recent.length === 0) {
            this.announce('No screen reader history available.', 'polite');
            return;
        }

        const combined = recent.map(h => h.text).join('. ');
        this.announce(`Recent announcements: ${combined}`, 'polite');
    }

    enable() {
        this.isEnabled = true;
        this.announce('Accessibility features enabled.', 'polite');
    }

    disable() {
        this.isEnabled = false;
        this.announce('Accessibility features disabled.', 'polite');
    }

    destroy() {
        this.isEnabled = false;

        const container = document.getElementById('openlink-a11y-container');
        if (container) {
            container.remove();
        }
    }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
    module.exports = AccessibilityBridge;
}

if (typeof window !== 'undefined') {
    window.AccessibilityBridge = AccessibilityBridge;
}
