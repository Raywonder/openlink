/**
 * OpenLink Ollama Service
 * AI-powered notification message generation for updates and events
 */

const http = require('http');
const log = require('electron-log');

class OllamaService {
    constructor(options = {}) {
        this.host = options.host || 'localhost';
        this.port = options.port || 11434;
        this.model = options.model || 'llama3.2:3b';
        this.available = false;
        this.lastCheck = 0;
        this.checkInterval = 60000; // Check availability every minute
    }

    /**
     * Check if Ollama is running and accessible
     */
    async checkAvailability() {
        const now = Date.now();
        if (now - this.lastCheck < this.checkInterval && this.available !== undefined) {
            return this.available;
        }

        try {
            const response = await this.makeRequest('/api/tags', 'GET');
            this.available = response && response.models && response.models.length > 0;
            this.lastCheck = now;

            if (this.available) {
                // Check if our preferred model is available
                const hasModel = response.models.some(m => m.name === this.model || m.name.startsWith(this.model.split(':')[0]));
                if (!hasModel && response.models.length > 0) {
                    // Use first available model
                    this.model = response.models[0].name;
                    log.info(`Ollama: Using model ${this.model}`);
                }
            }

            return this.available;
        } catch (e) {
            this.available = false;
            this.lastCheck = now;
            log.debug('Ollama not available:', e.message);
            return false;
        }
    }

    /**
     * Generate AI-powered update notification message
     */
    async generateUpdateNotification(appName, version, features = []) {
        if (!await this.checkAvailability()) {
            // Return a default message if Ollama is not available
            return this.getDefaultUpdateMessage(appName, version, features);
        }

        const prompt = this.buildUpdatePrompt(appName, version, features);

        try {
            const response = await this.generate(prompt);
            if (response && response.trim()) {
                return response.trim();
            }
        } catch (e) {
            log.warn('Ollama generation failed:', e.message);
        }

        return this.getDefaultUpdateMessage(appName, version, features);
    }

    /**
     * Generate a notification for various events
     */
    async generateEventNotification(eventType, context = {}) {
        if (!await this.checkAvailability()) {
            return this.getDefaultEventMessage(eventType, context);
        }

        const prompt = this.buildEventPrompt(eventType, context);

        try {
            const response = await this.generate(prompt);
            if (response && response.trim()) {
                return response.trim();
            }
        } catch (e) {
            log.warn('Ollama event generation failed:', e.message);
        }

        return this.getDefaultEventMessage(eventType, context);
    }

    /**
     * Build prompt for update notifications
     */
    buildUpdatePrompt(appName, version, features) {
        const featureList = features.length > 0
            ? `Key features in this update:\n${features.map(f => `- ${f}`).join('\n')}`
            : '';

        return `You are a friendly notification assistant for ${appName}. Write a short, warm notification message (2-3 sentences max) announcing version ${version} is available. Be conversational and screen reader friendly. ${featureList}

Important: Keep it brief and accessible. No emojis. No markdown. Just plain text.`;
    }

    /**
     * Build prompt for event notifications
     */
    buildEventPrompt(eventType, context) {
        const prompts = {
            'connection': `Write a brief, friendly notification (1-2 sentences) that ${context.name || 'someone'} has connected to the computer. Keep it accessible for screen readers. No emojis.`,
            'disconnection': `Write a brief notification (1 sentence) that ${context.name || 'the remote user'} has disconnected. No emojis.`,
            'hosting-started': `Write a brief notification (1-2 sentences) that hosting has started with session ID ${context.sessionId || 'unknown'}. Mention they can share this to allow connections. No emojis.`,
            'update-downloaded': `Write a brief notification (1-2 sentences) that an update for ${context.appName || 'the app'} version ${context.version || 'new'} has downloaded and is ready to install. No emojis.`,
            'error': `Write a brief, helpful error notification about: ${context.message || 'an issue occurred'}. Keep it friendly and suggest trying again. No emojis.`
        };

        return prompts[eventType] || `Write a brief notification about: ${eventType}. No emojis.`;
    }

    /**
     * Default update message when Ollama is unavailable
     */
    getDefaultUpdateMessage(appName, version, features) {
        let message = `${appName} version ${version} is now available.`;
        if (features.length > 0) {
            message += ` New features include: ${features.slice(0, 3).join(', ')}.`;
        }
        message += ' Update now for the latest improvements.';
        return message;
    }

    /**
     * Default event messages when Ollama is unavailable
     */
    getDefaultEventMessage(eventType, context) {
        const messages = {
            'connection': `${context.name || 'A user'} has connected to your computer.`,
            'disconnection': `${context.name || 'Remote user'} has disconnected.`,
            'hosting-started': `Hosting started. Session ID: ${context.sessionId || 'unknown'}. Share this to allow connections.`,
            'update-downloaded': `Update ready. Version ${context.version || 'new'} has been downloaded. Restart to install.`,
            'error': context.message || 'An error occurred. Please try again.'
        };

        return messages[eventType] || `Event: ${eventType}`;
    }

    /**
     * Send text generation request to Ollama
     */
    async generate(prompt, options = {}) {
        const payload = {
            model: options.model || this.model,
            prompt: prompt,
            stream: false,
            options: {
                temperature: options.temperature || 0.7,
                num_predict: options.maxTokens || 150
            }
        };

        const response = await this.makeRequest('/api/generate', 'POST', payload);
        return response?.response || '';
    }

    /**
     * Make HTTP request to Ollama API
     */
    makeRequest(path, method = 'GET', body = null) {
        return new Promise((resolve, reject) => {
            const options = {
                hostname: this.host,
                port: this.port,
                path: path,
                method: method,
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            };

            const req = http.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        resolve(data);
                    }
                });
            });

            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });

            if (body) {
                req.write(JSON.stringify(body));
            }

            req.end();
        });
    }

    /**
     * Get available models
     */
    async getModels() {
        try {
            const response = await this.makeRequest('/api/tags', 'GET');
            return response?.models || [];
        } catch (e) {
            return [];
        }
    }

    /**
     * Set the model to use
     */
    setModel(model) {
        this.model = model;
        log.info(`Ollama model set to: ${model}`);
    }

    /**
     * Get current status
     */
    getStatus() {
        return {
            available: this.available,
            model: this.model,
            host: this.host,
            port: this.port,
            lastCheck: this.lastCheck
        };
    }
}

module.exports = OllamaService;
