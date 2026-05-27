/**
 * OpenLink local TTS helper client.
 * Talks only to the loopback helper exposed by the native desktop app.
 */
class LocalTTSClient {
    constructor(options = {}) {
        this.options = {
            enabled: options.enabled !== false,
            endpoint: options.endpoint || 'http://127.0.0.1:8766',
            fallbackMode: options.fallbackMode || 'screen-reader',
            timeoutMs: options.timeoutMs || 1200,
            voiceId: options.voiceId || '',
            rate: options.rate || 1.0,
            volume: options.volume || 1.0,
            ...options
        };
    }

    async status() {
        return this.request('/status');
    }

    async voices() {
        return this.request('/voices');
    }

    async speak(text, options = {}) {
        if (!this.options.enabled || !text) return false;

        try {
            await this.request('/speak', {
                method: 'POST',
                body: {
                    text,
                    priority: options.priority || 'polite',
                    interrupt: options.interrupt === true || options.priority === 'assertive',
                    voiceId: options.voiceId || this.options.voiceId,
                    rate: options.rate || this.options.rate,
                    volume: options.volume || this.options.volume,
                    sessionId: options.sessionId || null,
                    machineId: options.machineId || null
                }
            });
            return true;
        } catch (error) {
            console.warn('[LocalTTS] helper unavailable:', error.message);
            return false;
        }
    }

    async stop() {
        try {
            await this.request('/stop', { method: 'POST', body: {} });
            return true;
        } catch {
            return false;
        }
    }

    async request(path, options = {}) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);

        try {
            const response = await fetch(`${this.options.endpoint}${path}`, {
                method: options.method || 'GET',
                headers: { 'Content-Type': 'application/json' },
                body: options.body ? JSON.stringify(options.body) : undefined,
                signal: controller.signal
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            return await response.json();
        } finally {
            clearTimeout(timeout);
        }
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = LocalTTSClient;
}

if (typeof window !== 'undefined') {
    window.LocalTTSClient = LocalTTSClient;
}
