/**
 * User Verification Service
 * Handles SMS/email verification codes for user identity confirmation
 * Ties link generation to verified users
 */

const crypto = require('crypto');
const log = require('electron-log');

class UserVerificationService {
    constructor(store, notificationService, ecriptoConnector) {
        this.store = store;
        this.notificationService = notificationService;
        this.ecriptoConnector = ecriptoConnector;

        // Pending verification codes (in memory, expire after 10 minutes)
        this.pendingCodes = new Map();
        this.CODE_EXPIRY = 10 * 60 * 1000; // 10 minutes
        this.MAX_ATTEMPTS = 3;

        // Clean up expired codes periodically
        setInterval(() => this.cleanupExpiredCodes(), 60 * 1000);
    }

    /**
     * Get current verification status
     */
    getVerificationStatus() {
        const phoneVerified = this.store.get('verification.phone');
        const emailVerified = this.store.get('verification.email');
        const mastodonVerified = this.store.get('mastodonProfile');
        const whmcsLinked = this.store.get('whmcsClient');

        return {
            isVerified: !!(phoneVerified?.verified || emailVerified?.verified || mastodonVerified?.verified),
            methods: {
                phone: phoneVerified ? {
                    verified: phoneVerified.verified,
                    number: this.maskPhoneNumber(phoneVerified.number),
                    verifiedAt: phoneVerified.verifiedAt
                } : null,
                email: emailVerified ? {
                    verified: emailVerified.verified,
                    address: this.maskEmail(emailVerified.address),
                    verifiedAt: emailVerified.verifiedAt
                } : null,
                mastodon: mastodonVerified ? {
                    verified: mastodonVerified.verified,
                    handle: mastodonVerified.handle,
                    verifiedAt: mastodonVerified.verifiedAt
                } : null,
                whmcs: whmcsLinked ? {
                    linked: true,
                    clientId: whmcsLinked.clientId,
                    linkedAt: whmcsLinked.linkedAt
                } : null
            },
            primaryMethod: phoneVerified?.verified ? 'phone' :
                          emailVerified?.verified ? 'email' :
                          mastodonVerified?.verified ? 'mastodon' : null
        };
    }

    /**
     * Send verification code via SMS
     */
    async sendPhoneVerificationCode(phoneNumber, carrier = null) {
        const cleanNumber = phoneNumber.replace(/\D/g, '');

        if (cleanNumber.length < 10) {
            throw new Error('Invalid phone number');
        }

        // Generate 6-digit code
        const code = this.generateVerificationCode();
        const codeId = crypto.randomUUID();

        // Store pending verification
        this.pendingCodes.set(codeId, {
            type: 'phone',
            target: cleanNumber,
            carrier,
            code,
            attempts: 0,
            createdAt: Date.now(),
            expiresAt: Date.now() + this.CODE_EXPIRY
        });

        // Send via SMS
        const message = `OpenLink verification code: ${code}. Valid for 10 minutes.`;

        try {
            // Try configured SMS provider first
            const smsSettings = this.store.get('notifications.sms', {});
            const provider = smsSettings.provider || 'carrier_gateway';

            await this.notificationService.sendSMS({
                phoneNumber: cleanNumber,
                carrier: carrier || smsSettings.carrier,
                message,
                provider
            });

            log.info(`[Verification] SMS code sent to ${this.maskPhoneNumber(cleanNumber)}`);

            return {
                success: true,
                codeId,
                expiresIn: this.CODE_EXPIRY / 1000,
                maskedNumber: this.maskPhoneNumber(cleanNumber)
            };
        } catch (error) {
            // Remove pending code on failure
            this.pendingCodes.delete(codeId);
            log.error('[Verification] Failed to send SMS:', error);
            throw new Error(`Failed to send verification code: ${error.message}`);
        }
    }

    /**
     * Send verification code via email
     */
    async sendEmailVerificationCode(email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            throw new Error('Invalid email address');
        }

        const code = this.generateVerificationCode();
        const codeId = crypto.randomUUID();

        this.pendingCodes.set(codeId, {
            type: 'email',
            target: email.toLowerCase(),
            code,
            attempts: 0,
            createdAt: Date.now(),
            expiresAt: Date.now() + this.CODE_EXPIRY
        });

        try {
            await this.notificationService.sendEmail({
                to: email,
                subject: 'OpenLink Verification Code',
                text: `Your OpenLink verification code is: ${code}\n\nThis code is valid for 10 minutes.`,
                html: this.notificationService.formatEmailHtml(
                    'Verification Code',
                    `Your OpenLink verification code is: <strong>${code}</strong><br><br>This code is valid for 10 minutes.`
                )
            });

            log.info(`[Verification] Email code sent to ${this.maskEmail(email)}`);

            return {
                success: true,
                codeId,
                expiresIn: this.CODE_EXPIRY / 1000,
                maskedEmail: this.maskEmail(email)
            };
        } catch (error) {
            this.pendingCodes.delete(codeId);
            log.error('[Verification] Failed to send email:', error);
            throw new Error(`Failed to send verification code: ${error.message}`);
        }
    }

    /**
     * Verify a code
     */
    verifyCode(codeId, inputCode) {
        const pending = this.pendingCodes.get(codeId);

        if (!pending) {
            return { success: false, error: 'Verification expired or not found' };
        }

        if (Date.now() > pending.expiresAt) {
            this.pendingCodes.delete(codeId);
            return { success: false, error: 'Verification code expired' };
        }

        pending.attempts++;

        if (pending.attempts > this.MAX_ATTEMPTS) {
            this.pendingCodes.delete(codeId);
            return { success: false, error: 'Too many attempts. Please request a new code.' };
        }

        if (pending.code !== inputCode.toString().trim()) {
            return {
                success: false,
                error: 'Invalid code',
                attemptsRemaining: this.MAX_ATTEMPTS - pending.attempts
            };
        }

        // Code verified! Store the verification
        const verificationData = {
            verified: true,
            verifiedAt: Date.now(),
            machineId: this.store.get('machineId')
        };

        if (pending.type === 'phone') {
            verificationData.number = pending.target;
            verificationData.carrier = pending.carrier;
            this.store.set('verification.phone', verificationData);
            log.info(`[Verification] Phone verified: ${this.maskPhoneNumber(pending.target)}`);
        } else if (pending.type === 'email') {
            verificationData.address = pending.target;
            this.store.set('verification.email', verificationData);
            log.info(`[Verification] Email verified: ${this.maskEmail(pending.target)}`);
        }

        // Clean up
        this.pendingCodes.delete(codeId);

        // Report to trust score
        if (this.ecriptoConnector) {
            this.ecriptoConnector.emit('verification-completed', {
                type: pending.type,
                target: pending.target
            });
        }

        return {
            success: true,
            type: pending.type,
            verified: true
        };
    }

    /**
     * Check if user needs verification before creating a link
     */
    requiresVerificationForLink() {
        const status = this.getVerificationStatus();
        const requireVerification = this.store.get('settings.requireVerificationForLinks', true);

        if (!requireVerification) {
            return { required: false };
        }

        if (status.isVerified) {
            return { required: false, verifiedVia: status.primaryMethod };
        }

        return {
            required: true,
            message: 'Please verify your identity before creating shareable links',
            availableMethods: ['phone', 'email', 'mastodon']
        };
    }

    /**
     * Pre-link verification - sends code and returns pending link info
     */
    async initiateLinkCreation(linkConfig, verificationMethod = 'phone', verificationTarget = null) {
        const verificationCheck = this.requiresVerificationForLink();

        if (!verificationCheck.required) {
            // Already verified, proceed directly
            return {
                verified: true,
                canProceed: true,
                verifiedVia: verificationCheck.verifiedVia
            };
        }

        // Need to verify first
        if (!verificationTarget) {
            return {
                verified: false,
                canProceed: false,
                needsInput: true,
                method: verificationMethod,
                message: verificationMethod === 'phone'
                    ? 'Enter your phone number to receive a verification code'
                    : 'Enter your email to receive a verification code'
            };
        }

        // Send verification code
        let result;
        if (verificationMethod === 'phone') {
            result = await this.sendPhoneVerificationCode(verificationTarget, linkConfig.carrier);
        } else if (verificationMethod === 'email') {
            result = await this.sendEmailVerificationCode(verificationTarget);
        } else {
            throw new Error('Invalid verification method');
        }

        // Store pending link config
        this.pendingCodes.get(result.codeId).pendingLinkConfig = linkConfig;

        return {
            verified: false,
            canProceed: false,
            waitingForCode: true,
            codeId: result.codeId,
            expiresIn: result.expiresIn,
            maskedTarget: result.maskedNumber || result.maskedEmail
        };
    }

    /**
     * Complete link creation after verification
     */
    completeLinkCreation(codeId, inputCode) {
        const verifyResult = this.verifyCode(codeId, inputCode);

        if (!verifyResult.success) {
            return verifyResult;
        }

        // Verification successful, link can now be created
        return {
            success: true,
            verified: true,
            canCreateLink: true,
            verifiedVia: verifyResult.type
        };
    }

    /**
     * Remove verification (for user to re-verify with different number/email)
     */
    removeVerification(type) {
        if (type === 'phone') {
            this.store.delete('verification.phone');
        } else if (type === 'email') {
            this.store.delete('verification.email');
        }
        log.info(`[Verification] Removed ${type} verification`);
        return { success: true };
    }

    /**
     * Generate a 6-digit verification code
     */
    generateVerificationCode() {
        return Math.floor(100000 + Math.random() * 900000).toString();
    }

    /**
     * Mask phone number for display (show last 4 digits)
     */
    maskPhoneNumber(number) {
        if (!number || number.length < 4) return '****';
        return '***-***-' + number.slice(-4);
    }

    /**
     * Mask email for display
     */
    maskEmail(email) {
        if (!email) return '***@***.***';
        const [local, domain] = email.split('@');
        const maskedLocal = local.length > 2
            ? local[0] + '***' + local.slice(-1)
            : '***';
        return `${maskedLocal}@${domain}`;
    }

    /**
     * Clean up expired pending codes
     */
    cleanupExpiredCodes() {
        const now = Date.now();
        for (const [codeId, pending] of this.pendingCodes) {
            if (now > pending.expiresAt) {
                this.pendingCodes.delete(codeId);
            }
        }
    }

    /**
     * Get SMS carriers list
     */
    getSMSCarriers() {
        return this.notificationService.getSupportedCarriers();
    }
}

module.exports = UserVerificationService;
