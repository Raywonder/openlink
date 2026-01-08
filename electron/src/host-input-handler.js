/**
 * OpenLink Remote Desktop - Host Input Handler
 * Executes mouse and keyboard events received from remote clients
 * Requires native module (robotjs or nut.js) for input simulation
 */

class HostInputHandler {
    constructor(options = {}) {
        this.options = {
            enableKeyboard: true,
            enableMouse: true,
            enableClipboard: true,
            restrictedKeys: ['Meta', 'Super'],  // Keys that won't be forwarded
            allowedModifiers: ['Control', 'Alt', 'Shift'],
            ...options
        };

        this.inputModule = null;
        this.screenSize = { width: 1920, height: 1080 };
        this.isEnabled = true;
        this.pressedKeys = new Set();

        this.init();
    }

    async init() {
        // Try to load input simulation module
        try {
            // Try robotjs first (more common)
            this.inputModule = require('robotjs');
            this.inputType = 'robotjs';
            console.log('[HostInput] Using robotjs for input simulation');
        } catch (e1) {
            try {
                // Fall back to nut.js
                const { keyboard, mouse, screen } = require('@nut-tree/nut-js');
                this.inputModule = { keyboard, mouse, screen };
                this.inputType = 'nutjs';
                console.log('[HostInput] Using nut.js for input simulation');
            } catch (e2) {
                console.warn('[HostInput] No input simulation module available');
                console.warn('[HostInput] Install robotjs or @nut-tree/nut-js for input control');
                this.inputModule = null;
            }
        }

        // Get screen size
        this.updateScreenSize();
    }

    updateScreenSize() {
        if (this.inputType === 'robotjs' && this.inputModule) {
            const size = this.inputModule.getScreenSize();
            this.screenSize = { width: size.width, height: size.height };
        } else if (this.inputType === 'nutjs' && this.inputModule) {
            // nut.js handles screen size internally
            this.inputModule.screen.width().then(w => {
                this.inputModule.screen.height().then(h => {
                    this.screenSize = { width: w, height: h };
                });
            });
        }
    }

    handleInput(data) {
        if (!this.isEnabled || !this.inputModule) return;

        switch (data.type) {
            case 'mouse_move':
                this.handleMouseMove(data);
                break;
            case 'mouse_down':
            case 'mouse_up':
                this.handleMouseButton(data);
                break;
            case 'mouse_scroll':
                this.handleMouseScroll(data);
                break;
            case 'key_down':
            case 'key_up':
                this.handleKeyboard(data);
                break;
            case 'clipboard':
                this.handleClipboard(data);
                break;
        }
    }

    handleMouseMove(data) {
        if (!this.options.enableMouse) return;

        // Convert relative coordinates (0-1) to absolute screen coordinates
        const x = Math.round(data.x * this.screenSize.width);
        const y = Math.round(data.y * this.screenSize.height);

        if (this.inputType === 'robotjs') {
            this.inputModule.moveMouse(x, y);
        } else if (this.inputType === 'nutjs') {
            this.inputModule.mouse.setPosition({ x, y });
        }
    }

    handleMouseButton(data) {
        if (!this.options.enableMouse) return;

        const button = this.mapMouseButton(data.button);
        const isDown = data.type === 'mouse_down';

        if (this.inputType === 'robotjs') {
            this.inputModule.mouseToggle(isDown ? 'down' : 'up', button);
        } else if (this.inputType === 'nutjs') {
            const Button = require('@nut-tree/nut-js').Button;
            const btnMap = { left: Button.LEFT, right: Button.RIGHT, middle: Button.MIDDLE };
            if (isDown) {
                this.inputModule.mouse.pressButton(btnMap[button]);
            } else {
                this.inputModule.mouse.releaseButton(btnMap[button]);
            }
        }
    }

    handleMouseScroll(data) {
        if (!this.options.enableMouse) return;

        const { deltaX, deltaY } = data;

        if (this.inputType === 'robotjs') {
            // robotjs uses positive = up
            if (deltaY !== 0) {
                this.inputModule.scrollMouse(0, -deltaY);
            }
            if (deltaX !== 0) {
                this.inputModule.scrollMouse(-deltaX, 0);
            }
        } else if (this.inputType === 'nutjs') {
            if (deltaY !== 0) {
                this.inputModule.mouse.scrollDown(deltaY > 0 ? deltaY : 0);
                this.inputModule.mouse.scrollUp(deltaY < 0 ? -deltaY : 0);
            }
        }
    }

    handleKeyboard(data) {
        if (!this.options.enableKeyboard) return;

        const { key, code, modifiers, isDown } = data;

        // Check restricted keys
        if (this.options.restrictedKeys.includes(key)) {
            return;
        }

        const keyCode = this.mapKeyCode(key, code);
        if (!keyCode) return;

        if (this.inputType === 'robotjs') {
            // Build modifier array
            const mods = [];
            if (modifiers.ctrl && this.options.allowedModifiers.includes('Control')) mods.push('control');
            if (modifiers.alt && this.options.allowedModifiers.includes('Alt')) mods.push('alt');
            if (modifiers.shift && this.options.allowedModifiers.includes('Shift')) mods.push('shift');

            if (isDown) {
                this.pressedKeys.add(keyCode);
                this.inputModule.keyToggle(keyCode, 'down', mods);
            } else {
                this.pressedKeys.delete(keyCode);
                this.inputModule.keyToggle(keyCode, 'up', mods);
            }
        } else if (this.inputType === 'nutjs') {
            const Key = require('@nut-tree/nut-js').Key;
            const nutKey = this.mapToNutKey(key, code);

            if (nutKey) {
                if (isDown) {
                    this.inputModule.keyboard.pressKey(nutKey);
                } else {
                    this.inputModule.keyboard.releaseKey(nutKey);
                }
            }
        }
    }

    handleClipboard(data) {
        if (!this.options.enableClipboard) return;

        const { action, text } = data;

        if (action === 'paste' && text) {
            if (this.inputType === 'robotjs') {
                this.inputModule.typeString(text);
            } else if (this.inputType === 'nutjs') {
                this.inputModule.keyboard.type(text);
            }
        }
    }

    mapMouseButton(button) {
        const map = {
            0: 'left',
            1: 'middle',
            2: 'right',
            'left': 'left',
            'middle': 'middle',
            'right': 'right'
        };
        return map[button] || 'left';
    }

    mapKeyCode(key, code) {
        // Map browser key codes to robotjs key names
        const keyMap = {
            // Letters
            'a': 'a', 'b': 'b', 'c': 'c', 'd': 'd', 'e': 'e', 'f': 'f',
            'g': 'g', 'h': 'h', 'i': 'i', 'j': 'j', 'k': 'k', 'l': 'l',
            'm': 'm', 'n': 'n', 'o': 'o', 'p': 'p', 'q': 'q', 'r': 'r',
            's': 's', 't': 't', 'u': 'u', 'v': 'v', 'w': 'w', 'x': 'x',
            'y': 'y', 'z': 'z',

            // Numbers
            '0': '0', '1': '1', '2': '2', '3': '3', '4': '4',
            '5': '5', '6': '6', '7': '7', '8': '8', '9': '9',

            // Function keys
            'F1': 'f1', 'F2': 'f2', 'F3': 'f3', 'F4': 'f4',
            'F5': 'f5', 'F6': 'f6', 'F7': 'f7', 'F8': 'f8',
            'F9': 'f9', 'F10': 'f10', 'F11': 'f11', 'F12': 'f12',

            // Navigation
            'ArrowUp': 'up', 'ArrowDown': 'down',
            'ArrowLeft': 'left', 'ArrowRight': 'right',
            'Home': 'home', 'End': 'end',
            'PageUp': 'pageup', 'PageDown': 'pagedown',

            // Editing
            'Backspace': 'backspace', 'Delete': 'delete',
            'Insert': 'insert', 'Enter': 'enter',
            'Tab': 'tab', 'Escape': 'escape',

            // Modifiers
            'Shift': 'shift', 'Control': 'control', 'Alt': 'alt',
            'CapsLock': 'capslock',

            // Punctuation
            ' ': 'space', 'Space': 'space',
            '-': '-', '=': '=', '[': '[', ']': ']',
            '\\': '\\', ';': ';', "'": "'", ',': ',',
            '.': '.', '/': '/', '`': '`',

            // Special
            'PrintScreen': 'printscreen',
            'ScrollLock': 'scrolllock',
            'Pause': 'pause'
        };

        // Try key first, then lowercase key
        return keyMap[key] || keyMap[key.toLowerCase()] || null;
    }

    mapToNutKey(key, code) {
        // Map to nut.js Key enum
        try {
            const Key = require('@nut-tree/nut-js').Key;

            const nutKeyMap = {
                'a': Key.A, 'b': Key.B, 'c': Key.C, 'd': Key.D, 'e': Key.E,
                'f': Key.F, 'g': Key.G, 'h': Key.H, 'i': Key.I, 'j': Key.J,
                'k': Key.K, 'l': Key.L, 'm': Key.M, 'n': Key.N, 'o': Key.O,
                'p': Key.P, 'q': Key.Q, 'r': Key.R, 's': Key.S, 't': Key.T,
                'u': Key.U, 'v': Key.V, 'w': Key.W, 'x': Key.X, 'y': Key.Y,
                'z': Key.Z,
                '0': Key.Num0, '1': Key.Num1, '2': Key.Num2, '3': Key.Num3,
                '4': Key.Num4, '5': Key.Num5, '6': Key.Num6, '7': Key.Num7,
                '8': Key.Num8, '9': Key.Num9,
                'Enter': Key.Enter, 'Tab': Key.Tab, 'Escape': Key.Escape,
                'Backspace': Key.Backspace, 'Delete': Key.Delete,
                'ArrowUp': Key.Up, 'ArrowDown': Key.Down,
                'ArrowLeft': Key.Left, 'ArrowRight': Key.Right,
                ' ': Key.Space, 'Space': Key.Space,
                'Shift': Key.LeftShift, 'Control': Key.LeftControl,
                'Alt': Key.LeftAlt
            };

            return nutKeyMap[key] || nutKeyMap[key.toLowerCase()] || null;
        } catch (e) {
            return null;
        }
    }

    enable() {
        this.isEnabled = true;
    }

    disable() {
        this.isEnabled = false;
        this.releaseAllKeys();
    }

    releaseAllKeys() {
        // Release any stuck keys
        if (this.inputType === 'robotjs') {
            for (const key of this.pressedKeys) {
                try {
                    this.inputModule.keyToggle(key, 'up');
                } catch (e) {
                    // Ignore errors
                }
            }
        }
        this.pressedKeys.clear();
    }

    setOptions(options) {
        Object.assign(this.options, options);
    }

    getStatus() {
        return {
            enabled: this.isEnabled,
            hasInputModule: this.inputModule !== null,
            inputType: this.inputType || 'none',
            screenSize: this.screenSize,
            pressedKeys: Array.from(this.pressedKeys)
        };
    }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
    module.exports = HostInputHandler;
}

if (typeof window !== 'undefined') {
    window.HostInputHandler = HostInputHandler;
}
