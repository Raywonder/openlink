/**
 * Feature Gate Service
 * Manages feature access based on wallet status, payments, and trust score
 */

const { EventEmitter } = require('events');

class FeatureGateService extends EventEmitter {
    constructor(store, ecriptoConnector) {
        super();
        this.store = store;
        this.ecriptoConnector = ecriptoConnector;
        this.cachedAccess = null;
        this.cacheExpiry = null;
        this.CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
    }

    /**
     * Get current feature access level
     */
    async getAccess(forceRefresh = false) {
        // Check cache
        if (!forceRefresh && this.cachedAccess && this.cacheExpiry > Date.now()) {
            return this.cachedAccess;
        }

        const walletAddress = this.ecriptoConnector?.walletAddress;
        const machineId = this.store.get('machineId');
        const paymentInfo = this.store.get('paymentInfo');

        // Determine tier
        let tier = 'free';
        let features = this.getFreeTierFeatures();

        // Check for active payment first
        if (paymentInfo && new Date(paymentInfo.expiresAt) > new Date()) {
            tier = paymentInfo.tier || 'paid';
            features = this.getPaidTierFeatures(tier);
        }
        // Check for wallet connection
        else if (walletAddress) {
            try {
                // Validate with server
                const serverAccess = await this.validateWithServer(walletAddress, machineId);
                if (serverAccess) {
                    tier = serverAccess.tier;
                    features = serverAccess.features;
                } else {
                    // Wallet connected but no server validation
                    tier = 'wallet';
                    features = this.getWalletTierFeatures();
                }
            } catch (error) {
                console.error('[FeatureGate] Server validation failed:', error);
                // Fallback to local wallet tier
                tier = 'wallet';
                features = this.getWalletTierFeatures();
            }
        }

        this.cachedAccess = {
            tier,
            features,
            walletConnected: !!walletAddress,
            machineId,
            expiresAt: paymentInfo?.expiresAt || null,
            cachedAt: Date.now()
        };

        this.cacheExpiry = Date.now() + this.CACHE_DURATION;

        return this.cachedAccess;
    }

    /**
     * Validate access with eCripto server
     */
    async validateWithServer(walletAddress, machineId) {
        try {
            const response = await this.ecriptoConnector.webRequest('POST', '/api/v1/features/access', {
                walletAddress,
                machineId
            });

            return response;
        } catch (error) {
            console.error('[FeatureGate] Server validation error:', error);
            return null;
        }
    }

    /**
     * Check if a specific feature is allowed
     */
    async checkFeature(featureName) {
        const access = await this.getAccess();
        const feature = access.features[featureName];

        if (!feature) {
            return { allowed: false, reason: 'Feature not found' };
        }

        if (typeof feature === 'boolean') {
            return { allowed: feature };
        }

        if (typeof feature === 'object') {
            return {
                allowed: feature.allowed !== false,
                limit: feature.limit,
                remaining: feature.remaining,
                unlimited: feature.unlimited
            };
        }

        return { allowed: false };
    }

    /**
     * Free tier features (no wallet)
     */
    getFreeTierFeatures() {
        return {
            linkGeneration: {
                allowed: true,
                limit: 5,
                perHour: 5,
                perDay: 20,
                randomOnly: true
            },
            sessionHosting: {
                allowed: true,
                limit: 3,
                perDay: 3
            },
            deviceLinking: {
                allowed: true,
                limit: 1
            },
            minting: false,
            priorityConnections: false,
            announcements: true, // Show upgrade prompts
            permanentLinks: false,
            customLinks: false,
            walletPayments: false
        };
    }

    /**
     * Wallet tier features (wallet connected, any balance)
     */
    getWalletTierFeatures() {
        return {
            linkGeneration: {
                allowed: true,
                unlimited: true,
                randomOnly: false
            },
            sessionHosting: {
                allowed: true,
                unlimited: true
            },
            deviceLinking: {
                allowed: true,
                limit: 5
            },
            minting: false,
            priorityConnections: false,
            announcements: false, // No upgrade prompts
            permanentLinks: true,
            customLinks: true,
            walletPayments: true
        };
    }

    /**
     * Premium tier features (high balance or payment)
     */
    getPremiumTierFeatures() {
        return {
            linkGeneration: {
                allowed: true,
                unlimited: true,
                randomOnly: false
            },
            sessionHosting: {
                allowed: true,
                unlimited: true
            },
            deviceLinking: {
                allowed: true,
                unlimited: true
            },
            minting: true,
            priorityConnections: true,
            announcements: false,
            permanentLinks: true,
            customLinks: true,
            walletPayments: true,
            nftLinks: true
        };
    }

    /**
     * Paid tier features (PayPal/Stripe payment)
     */
    getPaidTierFeatures(tier) {
        // All paid tiers get premium features
        return this.getPremiumTierFeatures();
    }

    /**
     * Record a paid subscription
     */
    recordPayment(paymentInfo) {
        this.store.set('paymentInfo', {
            ...paymentInfo,
            recordedAt: Date.now()
        });

        // Clear cache to force refresh
        this.cachedAccess = null;
        this.cacheExpiry = null;

        this.emit('payment-recorded', paymentInfo);
    }

    /**
     * Check if announcements should be shown
     */
    async shouldShowAnnouncements() {
        const access = await this.getAccess();
        return access.features.announcements === true;
    }

    /**
     * Get upgrade options for current tier
     */
    getUpgradeOptions(currentTier) {
        const options = [];

        if (currentTier === 'free') {
            options.push({
                id: 'connect-wallet',
                title: 'Connect Wallet',
                description: 'Connect any eCripto wallet (even 0 balance) to unlock more features',
                price: 'Free',
                action: 'connect-wallet'
            });
        }

        options.push(
            {
                id: 'day-pass',
                title: '24-Hour Access',
                description: 'Full access for 24 hours',
                price: '$0.99 or 1 ECRP',
                duration: 'day',
                action: 'purchase'
            },
            {
                id: 'week-pass',
                title: 'Weekly Access',
                description: 'Full access for 7 days',
                price: '$4.99 or 5 ECRP',
                duration: 'week',
                action: 'purchase'
            },
            {
                id: 'lifetime',
                title: 'Lifetime Access',
                description: 'Lifetime access to this version',
                price: '$19.99 or 20 ECRP',
                duration: 'lifetime',
                action: 'purchase'
            },
            {
                id: 'multi-version',
                title: 'Multi-Version Access',
                description: 'Access to next 3 major versions',
                price: '$29.99 or 30 ECRP',
                duration: 'versions',
                action: 'purchase'
            }
        );

        return options;
    }
}

module.exports = FeatureGateService;
