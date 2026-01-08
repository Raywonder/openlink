/**
 * Trust Score Service
 * Manages user trust scores based on wallet history, activity, and payments
 */

const { EventEmitter } = require('events');

class TrustScoreService extends EventEmitter {
    constructor(store, ecriptoConnector) {
        super();
        this.store = store;
        this.ecriptoConnector = ecriptoConnector;
        this.cachedScore = null;
        this.cacheExpiry = null;
        this.CACHE_DURATION = 10 * 60 * 1000; // 10 minutes
    }

    /**
     * Get current trust score
     */
    async getScore(forceRefresh = false) {
        const walletAddress = this.ecriptoConnector?.walletAddress;

        if (!walletAddress) {
            return {
                score: 0,
                tier: 'none',
                benefits: [],
                message: 'Connect a wallet to build trust'
            };
        }

        // Check cache
        if (!forceRefresh && this.cachedScore && this.cacheExpiry > Date.now()) {
            return this.cachedScore;
        }

        try {
            const machineId = this.store.get('machineId');

            const response = await this.ecriptoConnector.webRequest('POST', '/api/v1/trust/score', {
                walletAddress,
                machineId
            });

            if (response.success !== false) {
                this.cachedScore = response;
                this.cacheExpiry = Date.now() + this.CACHE_DURATION;

                // Store locally for offline access
                this.store.set('trustScore', response);

                return response;
            }
        } catch (error) {
            console.error('[TrustScore] Server fetch failed:', error);
        }

        // Fallback to cached/stored score
        const stored = this.store.get('trustScore');
        if (stored) {
            return stored;
        }

        // Calculate local score as fallback
        return this.calculateLocalScore(walletAddress);
    }

    /**
     * Calculate a local trust score when server is unavailable
     */
    calculateLocalScore(walletAddress) {
        const connectionHistory = this.store.get('connectionHistory') || {};
        const paymentInfo = this.store.get('paymentInfo');
        const whmcsClient = this.store.get('whmcsClient');
        const mastodonProfile = this.store.get('mastodonProfile');

        let score = 10; // Base score for having a wallet

        // Points for connection history (2 per connection, max 20)
        const historyCount = Object.keys(connectionHistory).length;
        score += Math.min(historyCount * 2, 20);

        // Points for payment method (20 points)
        if (paymentInfo) {
            score += 20;
        }

        // Points for WHMCS client login (15 points)
        if (whmcsClient && whmcsClient.clientId) {
            score += 15;
        }

        // Points for Mastodon profile (10 points)
        if (mastodonProfile && mastodonProfile.verified) {
            score += 10;
        }

        // Points for time as user (days since first recorded, max 30)
        const firstUse = this.store.get('firstUseDate');
        if (firstUse) {
            const days = Math.floor((Date.now() - firstUse) / (24 * 60 * 60 * 1000));
            score += Math.min(days, 30);
        }

        // Determine tier
        let tier = 'new';
        if (score >= 80) tier = 'veteran';
        else if (score >= 50) tier = 'trusted';
        else if (score >= 20) tier = 'basic';

        // Determine benefits
        const benefits = this.getBenefitsForTier(tier);

        return {
            score: Math.min(score, 100),
            tier,
            benefits,
            factors: {
                wallet: { points: 10 },
                connections: { count: historyCount, points: Math.min(historyCount * 2, 20) },
                payment: { active: !!paymentInfo, points: paymentInfo ? 20 : 0 },
                whmcs: { active: !!(whmcsClient && whmcsClient.clientId), points: (whmcsClient && whmcsClient.clientId) ? 15 : 0 },
                mastodon: { active: !!(mastodonProfile && mastodonProfile.verified), points: (mastodonProfile && mastodonProfile.verified) ? 10 : 0 },
                tenure: { days: firstUse ? Math.floor((Date.now() - firstUse) / (24 * 60 * 60 * 1000)) : 0 }
            },
            local: true
        };
    }

    /**
     * Get benefits for a trust tier
     */
    getBenefitsForTier(tier) {
        const tierBenefits = {
            none: [],
            new: ['basic_hosting'],
            basic: ['basic_hosting', 'extended_sessions'],
            trusted: ['basic_hosting', 'extended_sessions', 'priority_connections'],
            veteran: ['basic_hosting', 'extended_sessions', 'priority_connections', 'minting', 'nft_links']
        };

        return tierBenefits[tier] || [];
    }

    /**
     * Check if user has a specific benefit
     */
    async hasBenefit(benefit) {
        const score = await this.getScore();
        return score.benefits.includes(benefit);
    }

    /**
     * Report activity to build trust
     */
    async reportActivity(activityType, data = {}) {
        const walletAddress = this.ecriptoConnector?.walletAddress;
        if (!walletAddress) return;

        try {
            const machineId = this.store.get('machineId');

            await this.ecriptoConnector.webRequest('POST', '/api/v1/trust/activity', {
                walletAddress,
                machineId,
                activityType,
                data,
                timestamp: Date.now()
            });

            // Clear cache to force refresh on next fetch
            this.cachedScore = null;
        } catch (error) {
            console.error('[TrustScore] Failed to report activity:', error);
        }
    }

    /**
     * Get trust score display info for UI
     */
    async getDisplayInfo() {
        const score = await this.getScore();

        const tierColors = {
            none: '#808080',
            new: '#6c757d',
            basic: '#28a745',
            trusted: '#007bff',
            veteran: '#ffc107'
        };

        const tierDescriptions = {
            none: 'Connect a wallet to start building trust',
            new: 'Welcome! Keep using OpenLink to build trust',
            basic: 'Building trust - more features unlocking',
            trusted: 'Trusted user - priority access enabled',
            veteran: 'Veteran user - all features unlocked'
        };

        return {
            ...score,
            color: tierColors[score.tier] || '#808080',
            description: tierDescriptions[score.tier] || '',
            nextTier: this.getNextTier(score.tier),
            pointsToNext: this.getPointsToNextTier(score)
        };
    }

    /**
     * Get next tier name
     */
    getNextTier(currentTier) {
        const tiers = ['none', 'new', 'basic', 'trusted', 'veteran'];
        const index = tiers.indexOf(currentTier);
        return index < tiers.length - 1 ? tiers[index + 1] : null;
    }

    /**
     * Get points needed to reach next tier
     */
    getPointsToNextTier(score) {
        const thresholds = {
            none: 1,
            new: 20,
            basic: 50,
            trusted: 80,
            veteran: 100
        };

        const nextTier = this.getNextTier(score.tier);
        if (!nextTier) return 0;

        return Math.max(0, thresholds[nextTier] - score.score);
    }
}

module.exports = TrustScoreService;
