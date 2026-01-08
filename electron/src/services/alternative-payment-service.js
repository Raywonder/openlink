/**
 * Alternative Payment Service
 * Handles PayPal, Stripe, and multi-crypto payments for feature unlocks
 */

const { EventEmitter } = require('events');
const { shell } = require('electron');

class AlternativePaymentService extends EventEmitter {
    constructor(store, ecriptoConnector) {
        super();
        this.store = store;
        this.ecriptoConnector = ecriptoConnector;
        this.pendingPayments = new Map();

        // Pricing tiers
        this.pricing = {
            day: { usd: 0.99, ecrp: 1, description: '24 hours of full access' },
            week: { usd: 4.99, ecrp: 5, description: '7 days of full access' },
            month: { usd: 9.99, ecrp: 10, description: '30 days of full access' },
            lifetime: { usd: 19.99, ecrp: 20, description: 'Lifetime access to this version' },
            versions: { usd: 29.99, ecrp: 30, description: 'Access to next 3 major versions' }
        };

        // Supported cryptocurrencies
        this.cryptoCurrencies = {
            ecrp: { name: 'eCripto', chain: 'ecripto', decimals: 18 },
            eth: { name: 'Ethereum', chain: 'ethereum', decimals: 18 },
            btc: { name: 'Bitcoin', chain: 'bitcoin', decimals: 8 },
            matic: { name: 'Polygon', chain: 'polygon', decimals: 18 }
        };
    }

    /**
     * Create PayPal payment session
     */
    async createPayPalSession(duration) {
        const machineId = this.store.get('machineId');
        const price = this.pricing[duration];

        if (!price) {
            throw new Error('Invalid duration');
        }

        try {
            const response = await this.ecriptoConnector.webRequest('POST', '/api/v1/payments/paypal/create', {
                amount: price.usd,
                currency: 'USD',
                duration,
                machineId,
                description: `OpenLink ${price.description}`
            });

            if (response.success !== false && response.approvalUrl) {
                this.pendingPayments.set(response.sessionId, {
                    provider: 'paypal',
                    duration,
                    amount: price.usd,
                    createdAt: Date.now()
                });

                return {
                    sessionId: response.sessionId,
                    approvalUrl: response.approvalUrl
                };
            }

            throw new Error(response.error || 'Failed to create PayPal session');
        } catch (error) {
            console.error('[Payment] PayPal error:', error);
            throw error;
        }
    }

    /**
     * Create Stripe payment session
     */
    async createStripeSession(duration) {
        const machineId = this.store.get('machineId');
        const price = this.pricing[duration];

        if (!price) {
            throw new Error('Invalid duration');
        }

        try {
            const response = await this.ecriptoConnector.webRequest('POST', '/api/v1/payments/stripe/create', {
                amount: Math.round(price.usd * 100), // Stripe uses cents
                currency: 'usd',
                duration,
                machineId,
                description: `OpenLink ${price.description}`,
                successUrl: 'openlink://payment-success',
                cancelUrl: 'openlink://payment-cancel'
            });

            if (response.success !== false && response.checkoutUrl) {
                this.pendingPayments.set(response.sessionId, {
                    provider: 'stripe',
                    duration,
                    amount: price.usd,
                    createdAt: Date.now()
                });

                return {
                    sessionId: response.sessionId,
                    checkoutUrl: response.checkoutUrl
                };
            }

            throw new Error(response.error || 'Failed to create Stripe session');
        } catch (error) {
            console.error('[Payment] Stripe error:', error);
            throw error;
        }
    }

    /**
     * Create crypto payment request
     */
    async createCryptoPayment(duration, currency = 'ecrp') {
        const machineId = this.store.get('machineId');
        const price = this.pricing[duration];
        const cryptoInfo = this.cryptoCurrencies[currency];

        if (!price || !cryptoInfo) {
            throw new Error('Invalid duration or currency');
        }

        try {
            const response = await this.ecriptoConnector.webRequest('POST', '/api/v1/payments/crypto/create', {
                amount: price.ecrp,
                currency: currency.toUpperCase(),
                chain: cryptoInfo.chain,
                duration,
                machineId,
                description: `OpenLink ${price.description}`
            });

            if (response.success !== false && response.paymentAddress) {
                this.pendingPayments.set(response.paymentId, {
                    provider: 'crypto',
                    currency,
                    duration,
                    amount: price.ecrp,
                    paymentAddress: response.paymentAddress,
                    createdAt: Date.now()
                });

                return {
                    paymentId: response.paymentId,
                    paymentAddress: response.paymentAddress,
                    amount: response.amount,
                    currency: response.currency,
                    qrCode: response.qrCode,
                    expiresAt: response.expiresAt
                };
            }

            throw new Error(response.error || 'Failed to create crypto payment');
        } catch (error) {
            console.error('[Payment] Crypto error:', error);
            throw error;
        }
    }

    /**
     * Verify payment status
     */
    async verifyPayment(paymentId, provider) {
        const machineId = this.store.get('machineId');

        try {
            const response = await this.ecriptoConnector.webRequest('POST', '/api/v1/payments/verify', {
                paymentId,
                provider,
                machineId
            });

            if (response.success !== false && response.valid) {
                // Store payment info
                this.store.set('paymentInfo', {
                    paymentId,
                    provider,
                    tier: response.tier,
                    expiresAt: response.expiresAt,
                    features: response.features,
                    verifiedAt: Date.now()
                });

                // Clean up pending payment
                this.pendingPayments.delete(paymentId);

                this.emit('payment-verified', response);

                return {
                    valid: true,
                    tier: response.tier,
                    expiresAt: response.expiresAt,
                    features: response.features
                };
            }

            return {
                valid: false,
                status: response.status || 'pending'
            };
        } catch (error) {
            console.error('[Payment] Verify error:', error);
            return { valid: false, error: error.message };
        }
    }

    /**
     * Open payment in browser
     */
    async openPaymentUrl(url) {
        await shell.openExternal(url);
    }

    /**
     * Get pricing info
     */
    getPricing() {
        return this.pricing;
    }

    /**
     * Get supported currencies
     */
    getSupportedCurrencies() {
        return Object.entries(this.cryptoCurrencies).map(([id, info]) => ({
            id,
            ...info
        }));
    }

    /**
     * Get current payment status
     */
    getPaymentStatus() {
        const paymentInfo = this.store.get('paymentInfo');

        if (!paymentInfo) {
            return { active: false };
        }

        const now = new Date();
        const expiry = new Date(paymentInfo.expiresAt);

        if (expiry <= now) {
            return {
                active: false,
                expired: true,
                expiredAt: paymentInfo.expiresAt
            };
        }

        return {
            active: true,
            tier: paymentInfo.tier,
            expiresAt: paymentInfo.expiresAt,
            daysRemaining: Math.ceil((expiry - now) / (24 * 60 * 60 * 1000))
        };
    }

    /**
     * Check for pending payments and verify them
     */
    async checkPendingPayments() {
        for (const [paymentId, payment] of this.pendingPayments) {
            // Skip very old pending payments (> 1 hour)
            if (Date.now() - payment.createdAt > 60 * 60 * 1000) {
                this.pendingPayments.delete(paymentId);
                continue;
            }

            const result = await this.verifyPayment(paymentId, payment.provider);
            if (result.valid) {
                return result;
            }
        }

        return null;
    }
}

module.exports = AlternativePaymentService;
