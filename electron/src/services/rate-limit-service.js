/**
 * Rate Limit Service
 * Enforces rate limits for non-wallet users via server validation
 */

const { EventEmitter } = require('events');

class RateLimitService extends EventEmitter {
    constructor(store, ecriptoConnector) {
        super();
        this.store = store;
        this.ecriptoConnector = ecriptoConnector;

        // Local rate limit tracking (backup if server unavailable)
        this.localLimits = new Map();

        // Rate limit configuration
        this.limits = {
            link_generation: { perHour: 5, perDay: 20 },
            session_hosting: { perHour: 2, perDay: 3 },
            device_linking: { perHour: 1, perDay: 1 }
        };
    }

    /**
     * Check if action is allowed
     */
    async check(action, walletAddress = null) {
        const machineId = this.store.get('machineId');

        // Wallet users bypass rate limits
        if (walletAddress) {
            return { allowed: true, unlimited: true };
        }

        // Try server-side check first
        try {
            const response = await this.ecriptoConnector.webRequest('POST', '/api/v1/ratelimit/check', {
                machineId,
                action,
                walletAddress
            });

            if (response.success !== false) {
                return {
                    allowed: response.allowed,
                    remaining: response.remaining,
                    resetAt: response.resetAt,
                    limit: response.limit
                };
            }
        } catch (error) {
            console.error('[RateLimit] Server check failed, using local:', error);
        }

        // Fallback to local rate limiting
        return this.checkLocal(action, machineId);
    }

    /**
     * Record an action
     */
    async record(action, walletAddress = null) {
        const machineId = this.store.get('machineId');

        // Wallet users don't need recording
        if (walletAddress) {
            return { success: true };
        }

        // Try server-side recording
        try {
            const response = await this.ecriptoConnector.webRequest('POST', '/api/v1/ratelimit/record', {
                machineId,
                action
            });

            if (response.success !== false) {
                return {
                    success: true,
                    remaining: response.remaining
                };
            }
        } catch (error) {
            console.error('[RateLimit] Server record failed, using local:', error);
        }

        // Fallback to local recording
        return this.recordLocal(action, machineId);
    }

    /**
     * Local rate limit check
     */
    checkLocal(action, machineId) {
        const key = `${machineId}:${action}`;
        const now = Date.now();
        const hourAgo = now - (60 * 60 * 1000);
        const dayAgo = now - (24 * 60 * 60 * 1000);

        // Get or initialize tracking
        let tracking = this.localLimits.get(key);
        if (!tracking) {
            tracking = { actions: [] };
            this.localLimits.set(key, tracking);
        }

        // Clean up old entries
        tracking.actions = tracking.actions.filter(t => t > dayAgo);

        // Count actions
        const hourCount = tracking.actions.filter(t => t > hourAgo).length;
        const dayCount = tracking.actions.length;

        const limits = this.limits[action] || { perHour: 10, perDay: 50 };

        if (hourCount >= limits.perHour) {
            return {
                allowed: false,
                remaining: 0,
                resetAt: new Date(tracking.actions[0] + 60 * 60 * 1000).toISOString(),
                limit: limits.perHour,
                reason: 'hourly_limit'
            };
        }

        if (dayCount >= limits.perDay) {
            return {
                allowed: false,
                remaining: 0,
                resetAt: new Date(tracking.actions[0] + 24 * 60 * 60 * 1000).toISOString(),
                limit: limits.perDay,
                reason: 'daily_limit'
            };
        }

        return {
            allowed: true,
            remaining: Math.min(limits.perHour - hourCount, limits.perDay - dayCount),
            limit: limits.perHour
        };
    }

    /**
     * Local rate limit recording
     */
    recordLocal(action, machineId) {
        const key = `${machineId}:${action}`;

        let tracking = this.localLimits.get(key);
        if (!tracking) {
            tracking = { actions: [] };
            this.localLimits.set(key, tracking);
        }

        tracking.actions.push(Date.now());

        // Persist to store for app restarts
        this.store.set(`rateLimit:${key}`, tracking);

        const limits = this.limits[action] || { perHour: 10, perDay: 50 };
        const hourAgo = Date.now() - (60 * 60 * 1000);
        const hourCount = tracking.actions.filter(t => t > hourAgo).length;

        return {
            success: true,
            remaining: limits.perHour - hourCount
        };
    }

    /**
     * Load persisted rate limits on startup
     */
    loadFromStore() {
        const machineId = this.store.get('machineId');

        for (const action of Object.keys(this.limits)) {
            const key = `${machineId}:${action}`;
            const stored = this.store.get(`rateLimit:${key}`);
            if (stored) {
                this.localLimits.set(key, stored);
            }
        }
    }

    /**
     * Clear rate limits (for testing or admin)
     */
    clear(action = null) {
        const machineId = this.store.get('machineId');

        if (action) {
            const key = `${machineId}:${action}`;
            this.localLimits.delete(key);
            this.store.delete(`rateLimit:${key}`);
        } else {
            for (const a of Object.keys(this.limits)) {
                const key = `${machineId}:${a}`;
                this.localLimits.delete(key);
                this.store.delete(`rateLimit:${key}`);
            }
        }
    }

    /**
     * Get usage summary
     */
    getUsageSummary() {
        const machineId = this.store.get('machineId');
        const summary = {};

        for (const action of Object.keys(this.limits)) {
            const key = `${machineId}:${action}`;
            const tracking = this.localLimits.get(key) || { actions: [] };

            const now = Date.now();
            const hourAgo = now - (60 * 60 * 1000);
            const dayAgo = now - (24 * 60 * 60 * 1000);

            summary[action] = {
                hourly: tracking.actions.filter(t => t > hourAgo).length,
                daily: tracking.actions.filter(t => t > dayAgo).length,
                limits: this.limits[action]
            };
        }

        return summary;
    }
}

module.exports = RateLimitService;
