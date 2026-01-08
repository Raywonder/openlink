/**
 * OpenLink - DVCKeyboard (Devine Creations Keyboard)
 * Accessible remote keyboard input module for screen reader users
 * Provides a virtual keyboard panel that sends keystrokes to the remote machine
 */

class DVCKeyboard {
    constructor(options = {}) {
        this.options = {
            mode: 'text',  // 'text', 'hotkey', 'navigation'
            sendOnEnter: true,
            clearAfterSend: true,
            announceKeys: true,
            enableMacros: true,
            ...options
        };

        this.isOpen = false;
        this.buffer = '';
        this.lastKey = null;
        this.modifiers = {
            ctrl: false,
            alt: false,
            shift: false,
            meta: false
        };

        // Common macros for accessibility
        this.macros = {
            // Screen reader commands
            'sr-stop': { keys: ['Control'], name: 'Stop Speaking' },
            'sr-read-all': { keys: ['Insert', 'ArrowDown'], name: 'Read All (JAWS/NVDA)' },
            'sr-read-line': { keys: ['Insert', 'l'], name: 'Read Line' },

            // System shortcuts
            'win-start': { keys: ['Meta'], name: 'Windows Start Menu' },
            'win-run': { keys: ['Meta', 'r'], name: 'Run Dialog' },
            'win-explorer': { keys: ['Meta', 'e'], name: 'File Explorer' },
            'win-settings': { keys: ['Meta', 'i'], name: 'Settings' },
            'win-lock': { keys: ['Meta', 'l'], name: 'Lock Screen' },
            'win-desktop': { keys: ['Meta', 'd'], name: 'Show Desktop' },

            // Mac shortcuts
            'mac-spotlight': { keys: ['Meta', 'Space'], name: 'Spotlight Search' },
            'mac-force-quit': { keys: ['Alt', 'Meta', 'Escape'], name: 'Force Quit' },
            'mac-screenshot': { keys: ['Meta', 'Shift', '3'], name: 'Screenshot' },

            // Common actions
            'ctrl-c': { keys: ['Control', 'c'], name: 'Copy' },
            'ctrl-v': { keys: ['Control', 'v'], name: 'Paste' },
            'ctrl-x': { keys: ['Control', 'x'], name: 'Cut' },
            'ctrl-z': { keys: ['Control', 'z'], name: 'Undo' },
            'ctrl-y': { keys: ['Control', 'y'], name: 'Redo' },
            'ctrl-a': { keys: ['Control', 'a'], name: 'Select All' },
            'ctrl-s': { keys: ['Control', 's'], name: 'Save' },
            'ctrl-f': { keys: ['Control', 'f'], name: 'Find' },
            'ctrl-p': { keys: ['Control', 'p'], name: 'Print' },
            'ctrl-n': { keys: ['Control', 'n'], name: 'New' },
            'ctrl-o': { keys: ['Control', 'o'], name: 'Open' },
            'ctrl-w': { keys: ['Control', 'w'], name: 'Close Tab/Window' },

            // Tab navigation
            'alt-tab': { keys: ['Alt', 'Tab'], name: 'Switch Windows' },
            'alt-f4': { keys: ['Alt', 'F4'], name: 'Close Window' },
            'ctrl-tab': { keys: ['Control', 'Tab'], name: 'Next Tab' },
            'ctrl-shift-tab': { keys: ['Control', 'Shift', 'Tab'], name: 'Previous Tab' },

            // Text navigation
            'ctrl-home': { keys: ['Control', 'Home'], name: 'Go to Beginning' },
            'ctrl-end': { keys: ['Control', 'End'], name: 'Go to End' },
            'ctrl-left': { keys: ['Control', 'ArrowLeft'], name: 'Previous Word' },
            'ctrl-right': { keys: ['Control', 'ArrowRight'], name: 'Next Word' }
        };

        this.onSend = options.onSend || null;
        this.onAnnounce = options.onAnnounce || null;
    }

    /**
     * Open the keyboard panel
     */
    open() {
        this.isOpen = true;
        this.buffer = '';
        this.resetModifiers();
        if (this.onAnnounce) {
            this.onAnnounce('DVCKeyboard opened. Type to send keystrokes to remote machine.');
        }
        return true;
    }

    /**
     * Close the keyboard panel
     */
    close() {
        this.isOpen = false;
        this.buffer = '';
        this.resetModifiers();
        if (this.onAnnounce) {
            this.onAnnounce('DVCKeyboard closed.');
        }
        return true;
    }

    /**
     * Toggle the keyboard panel
     */
    toggle() {
        return this.isOpen ? this.close() : this.open();
    }

    /**
     * Reset all modifier keys
     */
    resetModifiers() {
        this.modifiers = {
            ctrl: false,
            alt: false,
            shift: false,
            meta: false
        };
    }

    /**
     * Set keyboard mode
     * @param {string} mode - 'text', 'hotkey', or 'navigation'
     */
    setMode(mode) {
        if (['text', 'hotkey', 'navigation'].includes(mode)) {
            this.options.mode = mode;
            if (this.onAnnounce) {
                const modeNames = {
                    'text': 'Text input mode - type normally',
                    'hotkey': 'Hotkey mode - send keyboard shortcuts',
                    'navigation': 'Navigation mode - arrow keys and navigation'
                };
                this.onAnnounce(modeNames[mode]);
            }
            return true;
        }
        return false;
    }

    /**
     * Handle a key event from the local keyboard
     * @param {KeyboardEvent} event - The keyboard event
     * @returns {Object} - Data to send to remote
     */
    handleKeyEvent(event) {
        if (!this.isOpen) return null;

        const { key, code, ctrlKey, altKey, shiftKey, metaKey, type } = event;
        const isDown = type === 'keydown';

        // Update modifier state
        this.modifiers.ctrl = ctrlKey;
        this.modifiers.alt = altKey;
        this.modifiers.shift = shiftKey;
        this.modifiers.meta = metaKey;

        // Build the key data to send
        const keyData = {
            type: isDown ? 'key_down' : 'key_up',
            key: key,
            code: code,
            modifiers: { ...this.modifiers },
            isDown: isDown,
            timestamp: Date.now()
        };

        // Announce key if enabled
        if (this.options.announceKeys && isDown) {
            this.announceKey(key, this.modifiers);
        }

        // In text mode, buffer printable characters
        if (this.options.mode === 'text' && isDown) {
            if (key.length === 1 && !ctrlKey && !altKey && !metaKey) {
                this.buffer += key;
            } else if (key === 'Backspace' && this.buffer.length > 0) {
                this.buffer = this.buffer.slice(0, -1);
            } else if (key === 'Enter' && this.options.sendOnEnter) {
                // Send the buffered text
                const text = this.buffer;
                if (this.options.clearAfterSend) {
                    this.buffer = '';
                }
                return {
                    type: 'text',
                    text: text,
                    timestamp: Date.now()
                };
            }
        }

        // Send key event
        if (this.onSend) {
            this.onSend(keyData);
        }

        return keyData;
    }

    /**
     * Send a text string to the remote machine
     * @param {string} text - Text to send
     */
    sendText(text) {
        if (!text) return false;

        const data = {
            type: 'text_input',
            text: text,
            timestamp: Date.now()
        };

        if (this.onSend) {
            this.onSend(data);
        }

        if (this.onAnnounce) {
            this.onAnnounce(`Sent: ${text.length} characters`);
        }

        return data;
    }

    /**
     * Execute a macro by name
     * @param {string} macroName - Name of the macro to execute
     */
    executeMacro(macroName) {
        const macro = this.macros[macroName];
        if (!macro) {
            if (this.onAnnounce) {
                this.onAnnounce(`Unknown macro: ${macroName}`);
            }
            return false;
        }

        if (this.onAnnounce) {
            this.onAnnounce(`Executing: ${macro.name}`);
        }

        // Send key down for all keys in sequence
        const keyEvents = [];
        for (const key of macro.keys) {
            keyEvents.push({
                type: 'key_down',
                key: key,
                code: this.keyToCode(key),
                modifiers: this.getModifiersForKey(key),
                isDown: true,
                timestamp: Date.now()
            });
        }

        // Send key up for all keys in reverse order
        for (const key of [...macro.keys].reverse()) {
            keyEvents.push({
                type: 'key_up',
                key: key,
                code: this.keyToCode(key),
                modifiers: {},
                isDown: false,
                timestamp: Date.now()
            });
        }

        // Send all events
        for (const event of keyEvents) {
            if (this.onSend) {
                this.onSend(event);
            }
        }

        return { macro: macroName, keys: macro.keys, events: keyEvents.length };
    }

    /**
     * Get list of available macros
     */
    getMacros() {
        return Object.entries(this.macros).map(([id, macro]) => ({
            id,
            name: macro.name,
            keys: macro.keys.join(' + ')
        }));
    }

    /**
     * Add a custom macro
     */
    addMacro(id, name, keys) {
        this.macros[id] = { keys, name };
        return true;
    }

    /**
     * Send a special key (F1-F12, Escape, Tab, etc.)
     */
    sendSpecialKey(key) {
        const keyData = {
            type: 'key_down',
            key: key,
            code: this.keyToCode(key),
            modifiers: { ...this.modifiers },
            isDown: true,
            timestamp: Date.now()
        };

        if (this.onSend) {
            this.onSend(keyData);
        }

        // Also send key up
        setTimeout(() => {
            if (this.onSend) {
                this.onSend({
                    ...keyData,
                    type: 'key_up',
                    isDown: false
                });
            }
        }, 50);

        if (this.onAnnounce) {
            this.announceKey(key, this.modifiers);
        }

        return keyData;
    }

    /**
     * Send navigation keys
     */
    sendNavigation(direction) {
        const keyMap = {
            'up': 'ArrowUp',
            'down': 'ArrowDown',
            'left': 'ArrowLeft',
            'right': 'ArrowRight',
            'home': 'Home',
            'end': 'End',
            'pageup': 'PageUp',
            'pagedown': 'PageDown',
            'tab': 'Tab',
            'enter': 'Enter',
            'escape': 'Escape',
            'backspace': 'Backspace',
            'delete': 'Delete',
            'space': ' '
        };

        const key = keyMap[direction.toLowerCase()] || direction;
        return this.sendSpecialKey(key);
    }

    /**
     * Announce a key press for screen readers
     */
    announceKey(key, modifiers) {
        if (!this.onAnnounce) return;

        let announcement = '';

        // Add modifier prefix
        if (modifiers.ctrl) announcement += 'Control ';
        if (modifiers.alt) announcement += 'Alt ';
        if (modifiers.shift) announcement += 'Shift ';
        if (modifiers.meta) announcement += 'Command ';

        // Announce the key name
        const keyNames = {
            ' ': 'Space',
            'ArrowUp': 'Up Arrow',
            'ArrowDown': 'Down Arrow',
            'ArrowLeft': 'Left Arrow',
            'ArrowRight': 'Right Arrow',
            'Backspace': 'Backspace',
            'Delete': 'Delete',
            'Enter': 'Enter',
            'Tab': 'Tab',
            'Escape': 'Escape',
            'CapsLock': 'Caps Lock',
            'PageUp': 'Page Up',
            'PageDown': 'Page Down'
        };

        announcement += keyNames[key] || key;
        this.onAnnounce(announcement);
    }

    /**
     * Convert key name to key code
     */
    keyToCode(key) {
        const codeMap = {
            'Control': 'ControlLeft',
            'Alt': 'AltLeft',
            'Shift': 'ShiftLeft',
            'Meta': 'MetaLeft',
            'Enter': 'Enter',
            'Tab': 'Tab',
            'Escape': 'Escape',
            'ArrowUp': 'ArrowUp',
            'ArrowDown': 'ArrowDown',
            'ArrowLeft': 'ArrowLeft',
            'ArrowRight': 'ArrowRight',
            'Home': 'Home',
            'End': 'End',
            'PageUp': 'PageUp',
            'PageDown': 'PageDown',
            'Insert': 'Insert',
            'Delete': 'Delete',
            'Backspace': 'Backspace',
            ' ': 'Space',
            'F1': 'F1', 'F2': 'F2', 'F3': 'F3', 'F4': 'F4',
            'F5': 'F5', 'F6': 'F6', 'F7': 'F7', 'F8': 'F8',
            'F9': 'F9', 'F10': 'F10', 'F11': 'F11', 'F12': 'F12'
        };

        // For letters and numbers
        if (key.length === 1) {
            const upper = key.toUpperCase();
            if (upper >= 'A' && upper <= 'Z') {
                return `Key${upper}`;
            }
            if (upper >= '0' && upper <= '9') {
                return `Digit${upper}`;
            }
        }

        return codeMap[key] || key;
    }

    /**
     * Get modifiers for a given key
     */
    getModifiersForKey(key) {
        return {
            ctrl: key === 'Control',
            alt: key === 'Alt',
            shift: key === 'Shift',
            meta: key === 'Meta'
        };
    }

    /**
     * Get current state
     */
    getState() {
        return {
            isOpen: this.isOpen,
            mode: this.options.mode,
            buffer: this.buffer,
            modifiers: { ...this.modifiers },
            macroCount: Object.keys(this.macros).length
        };
    }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
    module.exports = DVCKeyboard;
}

if (typeof window !== 'undefined') {
    window.DVCKeyboard = DVCKeyboard;
}
