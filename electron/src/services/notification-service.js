/**
 * OpenLink Notification Service
 * Supports native, Pushover, and email notifications
 */

const { Notification } = require('electron');
const https = require('https');
const nodemailer = require('nodemailer');
const log = require('electron-log');

class NotificationService {
    constructor(store) {
        this.store = store;
        this.emailTransporter = null;
        this.initEmailTransporter();

        // SMS carrier gateways for SMTP-based SMS
        this.carrierGateways = {
            'att': 'txt.att.net',
            'verizon': 'vtext.com',
            'tmobile': 'tmomail.net',
            'sprint': 'messaging.sprintpcs.com',
            'uscellular': 'email.uscc.net',
            'cricket': 'sms.cricketwireless.net',
            'boost': 'sms.myboostmobile.com',
            'metro': 'mymetropcs.com',
            'virgin': 'vmobl.com',
            'googlevoice': 'txt.voice.google.com'
        };
    }

    /**
     * Initialize email transporter if configured
     */
    initEmailTransporter() {
        const emailConfig = this.store.get('notifications.email', {});
        if (emailConfig.enabled && emailConfig.smtp) {
            try {
                this.emailTransporter = nodemailer.createTransport({
                    host: emailConfig.smtp.host,
                    port: emailConfig.smtp.port || 587,
                    secure: emailConfig.smtp.secure || false,
                    auth: {
                        user: emailConfig.smtp.user,
                        pass: emailConfig.smtp.pass
                    }
                });
                log.info('Email transporter initialized');
            } catch (e) {
                log.error('Failed to initialize email transporter:', e);
            }
        }
    }

    /**
     * Get notification settings
     */
    getSettings() {
        return {
            native: this.store.get('notifications.native', { enabled: true }),
            pushover: this.store.get('notifications.pushover', { enabled: false }),
            email: this.store.get('notifications.email', { enabled: false }),
            sms: this.store.get('notifications.sms', { enabled: false })
        };
    }

    /**
     * Save notification settings
     */
    saveSettings(settings) {
        if (settings.native !== undefined) {
            this.store.set('notifications.native', settings.native);
        }
        if (settings.pushover !== undefined) {
            this.store.set('notifications.pushover', settings.pushover);
        }
        if (settings.email !== undefined) {
            this.store.set('notifications.email', settings.email);
            this.initEmailTransporter();
        }
        if (settings.sms !== undefined) {
            this.store.set('notifications.sms', settings.sms);
        }
        return this.getSettings();
    }

    /**
     * Send notification through all enabled channels
     */
    async send(options) {
        const { title, message, priority = 'normal', sound = true, url = null } = options;
        const results = { native: null, pushover: null, email: null, sms: null };
        const settings = this.getSettings();

        // Native notification
        if (settings.native.enabled) {
            try {
                results.native = await this.sendNative(title, message, sound);
            } catch (e) {
                log.error('Native notification failed:', e);
                results.native = { error: e.message };
            }
        }

        // Pushover notification
        if (settings.pushover.enabled && settings.pushover.userKey && settings.pushover.apiToken) {
            try {
                results.pushover = await this.sendPushover({
                    title,
                    message,
                    priority: this.mapPriority(priority),
                    sound: sound ? settings.pushover.sound || 'pushover' : 'none',
                    url
                });
            } catch (e) {
                log.error('Pushover notification failed:', e);
                results.pushover = { error: e.message };
            }
        }

        // Email notification
        if (settings.email.enabled && settings.email.to) {
            try {
                results.email = await this.sendEmail({
                    to: settings.email.to,
                    subject: title,
                    text: message,
                    html: this.formatEmailHtml(title, message, url)
                });
            } catch (e) {
                log.error('Email notification failed:', e);
                results.email = { error: e.message };
            }
        }

        // SMS notification
        if (settings.sms.enabled && settings.sms.phoneNumber) {
            try {
                results.sms = await this.sendSMS({
                    phoneNumber: settings.sms.phoneNumber,
                    carrier: settings.sms.carrier,
                    message: `${title}: ${message}`,
                    provider: settings.sms.provider || 'carrier_gateway'
                });
            } catch (e) {
                log.error('SMS notification failed:', e);
                results.sms = { error: e.message };
            }
        }

        return results;
    }

    /**
     * Session-specific event notifications
     * @param {string} eventType - Type of session event
     * @param {object} data - Event data
     * @returns {object} Results from enabled channels
     */
    async sendSessionEvent(eventType, data = {}) {
        const eventConfig = {
            'client_connected': {
                title: 'Client Connected',
                message: `${data.clientName || 'A user'} connected to your session`,
                priority: 'normal',
                sound: 'connected'
            },
            'client_disconnected': {
                title: 'Client Disconnected',
                message: `${data.clientName || 'A user'} left your session`,
                priority: 'low',
                sound: 'disconnect'
            },
            'client_kicked': {
                title: 'Client Removed',
                message: `${data.clientName || 'A client'} was removed from the session${data.reason ? `: ${data.reason}` : ''}`,
                priority: 'normal',
                sound: 'disconnect'
            },
            'password_changed': {
                title: 'Password Updated',
                message: data.passwordSet
                    ? 'Session password has been changed'
                    : 'Session password protection removed',
                priority: 'high',
                sound: 'notification'
            },
            'link_regenerated': {
                title: 'Session Link Changed',
                message: `New session ID: ${data.newSessionId || 'Unknown'}. Old link no longer works.`,
                priority: 'high',
                sound: 'notification'
            },
            'session_started': {
                title: 'Hosting Started',
                message: `Session ID: ${data.sessionId}. Share this to allow connections.`,
                priority: 'normal',
                sound: 'hosting-started'
            },
            'session_ended': {
                title: 'Hosting Stopped',
                message: 'Your hosting session has ended',
                priority: 'normal',
                sound: 'hosting-stopped'
            },
            'unknown_device': {
                title: 'Unknown Device Alert',
                message: `Unknown device "${data.deviceName || 'Unknown'}" from ${data.location || 'unknown location'} is trying to connect`,
                priority: 'emergency',
                sound: 'alert'
            },
            'kicked_by_host': {
                title: 'Disconnected by Host',
                message: `You were disconnected from the session${data.reason ? `: ${data.reason}` : ''}`,
                priority: 'high',
                sound: 'disconnect'
            }
        };

        const config = eventConfig[eventType];
        if (!config) {
            log.warn(`Unknown session event type: ${eventType}`);
            return null;
        }

        return this.send({
            title: config.title,
            message: config.message,
            priority: config.priority || 'normal',
            sound: config.sound !== undefined,
            url: data.url || null
        });
    }

    /**
     * Send native desktop notification
     */
    sendNative(title, body, sound = true) {
        return new Promise((resolve, reject) => {
            if (!Notification.isSupported()) {
                reject(new Error('Native notifications not supported'));
                return;
            }

            const notification = new Notification({
                title,
                body,
                silent: !sound,
                icon: null // Uses app icon
            });

            notification.on('click', () => {
                resolve({ clicked: true });
            });

            notification.on('close', () => {
                resolve({ shown: true });
            });

            notification.show();
        });
    }

    /**
     * Send Pushover notification
     */
    sendPushover(options) {
        return new Promise((resolve, reject) => {
            const settings = this.store.get('notifications.pushover', {});

            const postData = JSON.stringify({
                token: settings.apiToken,
                user: settings.userKey,
                title: options.title,
                message: options.message,
                priority: options.priority || 0,
                sound: options.sound || 'pushover',
                url: options.url || '',
                device: settings.device || ''
            });

            const req = https.request({
                hostname: 'api.pushover.net',
                port: 443,
                path: '/1/messages.json',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const response = JSON.parse(data);
                        if (response.status === 1) {
                            resolve({ success: true, request: response.request });
                        } else {
                            reject(new Error(response.errors?.join(', ') || 'Pushover error'));
                        }
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            req.on('error', reject);
            req.write(postData);
            req.end();
        });
    }

    /**
     * Send email notification
     */
    async sendEmail(options) {
        if (!this.emailTransporter) {
            throw new Error('Email transporter not configured');
        }

        const settings = this.store.get('notifications.email', {});

        const result = await this.emailTransporter.sendMail({
            from: settings.from || settings.smtp?.user,
            to: options.to,
            subject: options.subject,
            text: options.text,
            html: options.html
        });

        return { success: true, messageId: result.messageId };
    }

    /**
     * Map priority string to Pushover priority number
     */
    mapPriority(priority) {
        const map = {
            lowest: -2,
            low: -1,
            normal: 0,
            high: 1,
            emergency: 2
        };
        return map[priority] || 0;
    }

    /**
     * Format HTML email body
     */
    formatEmailHtml(title, message, url) {
        return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 20px; background: #f5f5f5; }
        .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 8px; padding: 30px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        h1 { color: #333; margin-top: 0; }
        p { color: #666; line-height: 1.6; }
        .button { display: inline-block; background: #007bff; color: white; padding: 12px 24px; border-radius: 4px; text-decoration: none; margin-top: 15px; }
        .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; color: #999; font-size: 12px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>${this.escapeHtml(title)}</h1>
        <p>${this.escapeHtml(message).replace(/\n/g, '<br>')}</p>
        ${url ? `<a href="${this.escapeHtml(url)}" class="button">View Details</a>` : ''}
        <div class="footer">
            Sent from OpenLink - Accessible Remote Desktop
        </div>
    </div>
</body>
</html>`;
    }

    /**
     * Escape HTML special characters
     */
    escapeHtml(text) {
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return String(text).replace(/[&<>"']/g, m => map[m]);
    }

    /**
     * Test Pushover configuration
     */
    async testPushover() {
        return this.sendPushover({
            title: 'OpenLink Test',
            message: 'Pushover notifications are working correctly!',
            priority: 0,
            sound: 'pushover'
        });
    }

    /**
     * Test email configuration
     */
    async testEmail() {
        const settings = this.store.get('notifications.email', {});
        if (!settings.to) {
            throw new Error('No recipient email configured');
        }

        return this.sendEmail({
            to: settings.to,
            subject: 'OpenLink Test Notification',
            text: 'Email notifications are working correctly!',
            html: this.formatEmailHtml('OpenLink Test', 'Email notifications are working correctly!')
        });
    }

    /**
     * Send SMS notification
     * Supports multiple providers:
     * - carrier_gateway: Uses email-to-SMS gateways (free, requires carrier selection)
     * - twilio: Uses Twilio API (requires account)
     * - flexpbx: Uses FlexPBX API (enterprise feature)
     */
    async sendSMS(options) {
        const { phoneNumber, carrier, message, provider } = options;
        const settings = this.store.get('notifications.sms', {});

        // Clean phone number - remove all non-digits
        const cleanNumber = phoneNumber.replace(/\D/g, '');

        switch (provider) {
            case 'carrier_gateway':
                return this.sendSMSViaCarrier(cleanNumber, carrier, message);
            case 'twilio':
                return this.sendSMSViaTwilio(cleanNumber, message, settings);
            case 'flexpbx':
                return this.sendSMSViaFlexPBX(cleanNumber, message, settings);
            default:
                throw new Error(`Unknown SMS provider: ${provider}`);
        }
    }

    /**
     * Send SMS via carrier email gateway (free method)
     */
    async sendSMSViaCarrier(phoneNumber, carrier, message) {
        if (!this.emailTransporter) {
            throw new Error('Email transporter not configured - required for carrier gateway SMS');
        }

        const gateway = this.carrierGateways[carrier?.toLowerCase()];
        if (!gateway) {
            throw new Error(`Unknown carrier: ${carrier}. Supported: ${Object.keys(this.carrierGateways).join(', ')}`);
        }

        const smsEmail = `${phoneNumber}@${gateway}`;

        // SMS has 160 char limit per segment, keep message short
        const truncatedMessage = message.length > 160 ? message.substring(0, 157) + '...' : message;

        const result = await this.emailTransporter.sendMail({
            from: this.store.get('notifications.email.smtp.user'),
            to: smsEmail,
            subject: '', // No subject for SMS
            text: truncatedMessage
        });

        log.info(`SMS sent via carrier gateway to ${smsEmail}`);
        return { success: true, messageId: result.messageId, method: 'carrier_gateway' };
    }

    /**
     * Send SMS via Twilio API
     */
    async sendSMSViaTwilio(phoneNumber, message, settings) {
        if (!settings.twilio?.accountSid || !settings.twilio?.authToken || !settings.twilio?.fromNumber) {
            throw new Error('Twilio credentials not configured');
        }

        return new Promise((resolve, reject) => {
            const auth = Buffer.from(`${settings.twilio.accountSid}:${settings.twilio.authToken}`).toString('base64');
            const postData = new URLSearchParams({
                To: `+1${phoneNumber}`,
                From: settings.twilio.fromNumber,
                Body: message
            }).toString();

            const req = https.request({
                hostname: 'api.twilio.com',
                port: 443,
                path: `/2010-04-01/Accounts/${settings.twilio.accountSid}/Messages.json`,
                method: 'POST',
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(postData)
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const response = JSON.parse(data);
                        if (response.sid) {
                            log.info(`SMS sent via Twilio, SID: ${response.sid}`);
                            resolve({ success: true, sid: response.sid, method: 'twilio' });
                        } else {
                            reject(new Error(response.message || 'Twilio error'));
                        }
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            req.on('error', reject);
            req.write(postData);
            req.end();
        });
    }

    /**
     * Send SMS via FlexPBX API
     */
    async sendSMSViaFlexPBX(phoneNumber, message, settings) {
        if (!settings.flexpbx?.apiUrl || !settings.flexpbx?.apiKey) {
            throw new Error('FlexPBX credentials not configured');
        }

        return new Promise((resolve, reject) => {
            const postData = JSON.stringify({
                to: phoneNumber,
                message: message,
                from: settings.flexpbx.fromNumber || 'OpenLink'
            });

            const url = new URL(settings.flexpbx.apiUrl);
            const req = https.request({
                hostname: url.hostname,
                port: url.port || 443,
                path: url.pathname + '/sms/send',
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${settings.flexpbx.apiKey}`,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const response = JSON.parse(data);
                        if (response.success || response.id) {
                            log.info(`SMS sent via FlexPBX: ${response.id || 'success'}`);
                            resolve({ success: true, id: response.id, method: 'flexpbx' });
                        } else {
                            reject(new Error(response.error || response.message || 'FlexPBX error'));
                        }
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            req.on('error', reject);
            req.write(postData);
            req.end();
        });
    }

    /**
     * Test SMS configuration
     */
    async testSMS() {
        const settings = this.store.get('notifications.sms', {});
        if (!settings.phoneNumber) {
            throw new Error('No phone number configured');
        }

        return this.sendSMS({
            phoneNumber: settings.phoneNumber,
            carrier: settings.carrier,
            message: 'OpenLink: SMS notifications working!',
            provider: settings.provider || 'carrier_gateway'
        });
    }

    /**
     * Get supported carriers for SMS gateway
     */
    getSupportedCarriers() {
        return Object.keys(this.carrierGateways).map(key => ({
            value: key,
            label: key.charAt(0).toUpperCase() + key.slice(1)
        }));
    }
}

module.exports = NotificationService;
