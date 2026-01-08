/**
 * OpenLink Remote Desktop - Screen Reader Controller
 * Controls NVDA, JAWS, VoiceOver, and Orca on host machine
 *
 * For Windows NVDA support:
 * - Requires nvdaControllerClient.dll (32-bit or 64-bit depending on Node architecture)
 * - Download from: https://github.com/nvaccess/nvda/tree/master/extras/controllerClient
 * - Place in: /native/win32/ or /native/win64/
 *
 * For Windows JAWS support:
 * - Requires JAWS Scripting SDK or COM automation
 *
 * For macOS VoiceOver:
 * - Uses AppleScript via osascript
 *
 * For Linux Orca:
 * - Uses D-Bus interface
 */

const path = require('path');
const { exec, execSync } = require('child_process');
const os = require('os');

class ScreenReaderController {
    constructor(options = {}) {
        this.options = {
            nvdaDllPath: options.nvdaDllPath || null,
            preferredScreenReader: options.preferredScreenReader || 'auto',
            ...options
        };

        this.platform = os.platform();
        this.arch = os.arch();
        this.nvdaController = null;
        this.detectedScreenReader = null;
        this.isEnabled = true;

        this.init();
    }

    async init() {
        // Detect which screen reader is running
        this.detectedScreenReader = await this.detectScreenReader();
        console.log(`[ScreenReader] Detected: ${this.detectedScreenReader || 'none'}`);

        // Initialize platform-specific controller
        if (this.platform === 'win32') {
            await this.initWindows();
        } else if (this.platform === 'darwin') {
            await this.initMacOS();
        } else if (this.platform === 'linux') {
            await this.initLinux();
        }
    }

    async detectScreenReader() {
        try {
            if (this.platform === 'win32') {
                return await this.detectWindowsScreenReader();
            } else if (this.platform === 'darwin') {
                return await this.detectMacOSScreenReader();
            } else if (this.platform === 'linux') {
                return await this.detectLinuxScreenReader();
            }
        } catch (e) {
            console.warn('[ScreenReader] Detection failed:', e.message);
        }
        return null;
    }

    async detectWindowsScreenReader() {
        // Check for running screen readers
        try {
            const result = execSync('tasklist /FI "IMAGENAME eq nvda.exe" 2>NUL', { encoding: 'utf8' });
            if (result.includes('nvda.exe')) {
                return 'nvda';
            }
        } catch (e) { /* ignore */ }

        try {
            const result = execSync('tasklist /FI "IMAGENAME eq jfw.exe" 2>NUL', { encoding: 'utf8' });
            if (result.includes('jfw.exe')) {
                return 'jaws';
            }
        } catch (e) { /* ignore */ }

        try {
            const result = execSync('tasklist /FI "IMAGENAME eq narrator.exe" 2>NUL', { encoding: 'utf8' });
            if (result.includes('narrator.exe')) {
                return 'narrator';
            }
        } catch (e) { /* ignore */ }

        return null;
    }

    async detectMacOSScreenReader() {
        try {
            const result = execSync('defaults read com.apple.VoiceOver4/default SCREnableVoiceOver 2>/dev/null', { encoding: 'utf8' });
            if (result.trim() === '1') {
                return 'voiceover';
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    async detectLinuxScreenReader() {
        try {
            const result = execSync('pgrep -x orca', { encoding: 'utf8' });
            if (result.trim()) {
                return 'orca';
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    async initWindows() {
        if (this.detectedScreenReader === 'nvda') {
            await this.initNVDA();
        }
        // JAWS uses COM automation, which requires win32ole or similar
    }

    async initNVDA() {
        // Try to load NVDA controller DLL using ffi-napi or edge-js
        try {
            const ffi = require('ffi-napi');
            const ref = require('ref-napi');

            // Determine DLL path
            let dllPath = this.options.nvdaDllPath;
            if (!dllPath) {
                const dllName = this.arch === 'x64' ? 'nvdaControllerClient64.dll' : 'nvdaControllerClient32.dll';
                dllPath = path.join(__dirname, 'native', this.arch === 'x64' ? 'win64' : 'win32', dllName);
            }

            // Load the DLL
            this.nvdaController = ffi.Library(dllPath, {
                'nvdaController_speakText': ['long', ['string']],
                'nvdaController_cancelSpeech': ['long', []],
                'nvdaController_brailleMessage': ['long', ['string']],
                'nvdaController_testIfRunning': ['long', []]
            });

            // Test if NVDA is running
            const result = this.nvdaController.nvdaController_testIfRunning();
            if (result === 0) {
                console.log('[NVDA] Controller initialized successfully');
            } else {
                console.warn('[NVDA] NVDA not running or controller failed');
                this.nvdaController = null;
            }
        } catch (e) {
            console.warn('[NVDA] Failed to load controller DLL:', e.message);
            console.warn('[NVDA] Install ffi-napi and ref-napi for NVDA control support');
            this.nvdaController = null;
        }
    }

    async initMacOS() {
        // VoiceOver is controlled via AppleScript
        // No special initialization needed
    }

    async initLinux() {
        // Orca uses D-Bus, check if it's available
        try {
            execSync('which dbus-send', { encoding: 'utf8' });
        } catch (e) {
            console.warn('[Orca] dbus-send not available');
        }
    }

    // ==================== Speak Text ====================

    async speak(text, interrupt = false) {
        if (!this.isEnabled || !text) return false;

        const sr = this.options.preferredScreenReader === 'auto'
            ? this.detectedScreenReader
            : this.options.preferredScreenReader;

        switch (sr) {
            case 'nvda':
                return this.speakNVDA(text, interrupt);
            case 'jaws':
                return this.speakJAWS(text, interrupt);
            case 'voiceover':
                return this.speakVoiceOver(text, interrupt);
            case 'orca':
                return this.speakOrca(text, interrupt);
            case 'narrator':
                return this.speakNarrator(text, interrupt);
            default:
                console.warn('[ScreenReader] No screen reader detected');
                return false;
        }
    }

    speakNVDA(text, interrupt = false) {
        if (!this.nvdaController) return false;

        try {
            if (interrupt) {
                this.nvdaController.nvdaController_cancelSpeech();
            }
            const result = this.nvdaController.nvdaController_speakText(text);
            return result === 0;
        } catch (e) {
            console.error('[NVDA] Speak failed:', e.message);
            return false;
        }
    }

    speakJAWS(text, interrupt = false) {
        // JAWS COM automation
        try {
            const script = `
                var jaws = new ActiveXObject("FreedomSci.JawsApi");
                ${interrupt ? 'jaws.StopSpeech();' : ''}
                jaws.SayString("${text.replace(/"/g, '\\"')}", false);
            `;
            exec(`cscript //nologo //E:jscript - <<< "${script}"`, { shell: 'cmd.exe' });
            return true;
        } catch (e) {
            console.error('[JAWS] Speak failed:', e.message);
            return false;
        }
    }

    speakVoiceOver(text, interrupt = false) {
        try {
            const escapedText = text.replace(/"/g, '\\"').replace(/\n/g, ' ');
            const script = interrupt
                ? `tell application "VoiceOver" to output "${escapedText}"`
                : `tell application "VoiceOver" to output "${escapedText}"`;

            exec(`osascript -e '${script}'`, (error) => {
                if (error) {
                    console.error('[VoiceOver] Speak failed:', error.message);
                }
            });
            return true;
        } catch (e) {
            console.error('[VoiceOver] Speak failed:', e.message);
            return false;
        }
    }

    speakOrca(text, interrupt = false) {
        try {
            // Use spd-say (speech-dispatcher) which Orca uses
            const args = interrupt ? '-C' : '';
            exec(`spd-say ${args} "${text.replace(/"/g, '\\"')}"`, (error) => {
                if (error) {
                    console.error('[Orca] Speak failed:', error.message);
                }
            });
            return true;
        } catch (e) {
            console.error('[Orca] Speak failed:', e.message);
            return false;
        }
    }

    speakNarrator(text, interrupt = false) {
        // Narrator doesn't have a direct API, but we can use UIA
        // For now, use SAPI as fallback
        try {
            const script = `
                Add-Type -AssemblyName System.speech
                $speak = New-Object System.Speech.Synthesis.SpeechSynthesizer
                ${interrupt ? '$speak.SpeakAsyncCancelAll()' : ''}
                $speak.Speak("${text.replace(/"/g, '`"')}")
            `;
            exec(`powershell -Command "${script}"`, (error) => {
                if (error) {
                    console.error('[Narrator] Speak failed:', error.message);
                }
            });
            return true;
        } catch (e) {
            console.error('[Narrator] Speak failed:', e.message);
            return false;
        }
    }

    // ==================== Stop Speaking ====================

    async stopSpeaking() {
        const sr = this.options.preferredScreenReader === 'auto'
            ? this.detectedScreenReader
            : this.options.preferredScreenReader;

        switch (sr) {
            case 'nvda':
                if (this.nvdaController) {
                    this.nvdaController.nvdaController_cancelSpeech();
                }
                break;
            case 'jaws':
                exec('cscript //nologo //E:jscript - <<< "var jaws = new ActiveXObject(\\"FreedomSci.JawsApi\\"); jaws.StopSpeech();"', { shell: 'cmd.exe' });
                break;
            case 'voiceover':
                exec("osascript -e 'tell application \"VoiceOver\" to stop speaking'");
                break;
            case 'orca':
                exec('spd-say -C');
                break;
        }
    }

    // ==================== Braille ====================

    async braille(text) {
        if (!this.isEnabled || !text) return false;

        const sr = this.options.preferredScreenReader === 'auto'
            ? this.detectedScreenReader
            : this.options.preferredScreenReader;

        switch (sr) {
            case 'nvda':
                if (this.nvdaController) {
                    this.nvdaController.nvdaController_brailleMessage(text);
                    return true;
                }
                break;
            case 'brltty':
                return this.brailleBRLTTY(text);
        }

        // Try BRLTTY as fallback if enabled
        if (this.brlttyEnabled) {
            return this.brailleBRLTTY(text);
        }

        return false;
    }

    // ==================== BRLTTY Support ====================

    async initBRLTTY() {
        // Check if BRLTTY is available
        try {
            if (this.platform === 'linux' || this.platform === 'darwin') {
                // Check for brltty or BrlAPI
                const result = execSync('which brltty 2>/dev/null || which brlapi-config 2>/dev/null', { encoding: 'utf8' });
                if (result.trim()) {
                    this.brlttyAvailable = true;
                    console.log('[BRLTTY] Found BRLTTY installation');
                    return true;
                }
            } else if (this.platform === 'win32') {
                // Check for BRLTTY on Windows
                try {
                    execSync('where brltty.exe 2>NUL', { encoding: 'utf8' });
                    this.brlttyAvailable = true;
                    return true;
                } catch (e) { /* not found */ }
            }
        } catch (e) {
            console.warn('[BRLTTY] Not found:', e.message);
        }
        this.brlttyAvailable = false;
        return false;
    }

    async enableBRLTTY() {
        if (!this.brlttyAvailable) {
            await this.initBRLTTY();
        }

        if (this.brlttyAvailable) {
            this.brlttyEnabled = true;
            console.log('[BRLTTY] Braille display support enabled');
            return true;
        }
        return false;
    }

    disableBRLTTY() {
        this.brlttyEnabled = false;
        console.log('[BRLTTY] Braille display support disabled');
    }

    async brailleBRLTTY(text) {
        if (!this.brlttyEnabled || !text) return false;

        try {
            if (this.platform === 'linux' || this.platform === 'darwin') {
                // Use brltty-write or brlapi to send text to braille display
                // Method 1: Try xdotool-style approach with brltty
                const escapedText = text.replace(/"/g, '\\"').replace(/\n/g, ' ');

                // Use brlapi Python bindings if available
                const pythonScript = `
import brlapi
try:
    b = brlapi.Connection()
    b.writeText("${escapedText}")
except:
    pass
`;
                exec(`python3 -c "${pythonScript.replace(/\n/g, ';')}" 2>/dev/null`, (error) => {
                    if (error) {
                        // Fallback: try brltty-clip or brltty-message
                        exec(`brltty-message "${escapedText}" 2>/dev/null`);
                    }
                });
                return true;
            } else if (this.platform === 'win32') {
                // Windows BRLTTY support via command line
                const escapedText = text.replace(/"/g, '\\"');
                exec(`brltty.exe -m "${escapedText}"`, { shell: 'cmd.exe' });
                return true;
            }
        } catch (e) {
            console.error('[BRLTTY] Braille output failed:', e.message);
        }
        return false;
    }

    getBRLTTYStatus() {
        return {
            available: this.brlttyAvailable || false,
            enabled: this.brlttyEnabled || false
        };
    }

    // ==================== Enable/Disable Screen Reader ====================

    async enableScreenReader() {
        const sr = this.detectedScreenReader;

        switch (sr) {
            case 'nvda':
                // Start NVDA if not running
                exec('start nvda', { shell: 'cmd.exe' });
                break;
            case 'voiceover':
                exec("osascript -e 'tell application \"System Events\" to key code 96 using {command down, option down}'");
                break;
            case 'orca':
                exec('orca &');
                break;
            case 'narrator':
                exec('start narrator', { shell: 'cmd.exe' });
                break;
        }

        this.isEnabled = true;
        return true;
    }

    async disableScreenReader() {
        const sr = this.detectedScreenReader;

        switch (sr) {
            case 'nvda':
                // Send quit command to NVDA
                if (this.nvdaController) {
                    // NVDA quit via Insert+Q, but we'll use taskkill
                    exec('taskkill /IM nvda.exe', { shell: 'cmd.exe' });
                }
                break;
            case 'voiceover':
                exec("osascript -e 'tell application \"System Events\" to key code 96 using {command down, option down}'");
                break;
            case 'orca':
                exec('pkill orca');
                break;
            case 'narrator':
                exec('taskkill /IM narrator.exe', { shell: 'cmd.exe' });
                break;
        }

        this.isEnabled = false;
        return true;
    }

    // ==================== Status ====================

    getStatus() {
        return {
            platform: this.platform,
            arch: this.arch,
            detectedScreenReader: this.detectedScreenReader,
            isEnabled: this.isEnabled,
            hasNVDAController: this.nvdaController !== null,
            brltty: {
                available: this.brlttyAvailable || false,
                enabled: this.brlttyEnabled || false
            }
        };
    }

    // ==================== Cleanup ====================

    destroy() {
        this.nvdaController = null;
        this.isEnabled = false;
    }
}

// Export
module.exports = ScreenReaderController;
