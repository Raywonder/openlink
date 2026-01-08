/**
 * Announcement Service
 * Manages in-app announcements and upgrade prompts for non-wallet users
 */

const { EventEmitter } = require('events');

class AnnouncementService extends EventEmitter {
    constructor(store, ecriptoConnector) {
        super();
        this.store = store;
        this.ecriptoConnector = ecriptoConnector;
        this.announcements = [];
        this.dismissedIds = new Set();
        this.lastFetch = null;
        this.FETCH_INTERVAL = 30 * 60 * 1000; // 30 minutes

        // Load dismissed announcements
        const dismissed = this.store.get('dismissedAnnouncements') || [];
        dismissed.forEach(id => this.dismissedIds.add(id));

        // Built-in upgrade prompts
        this.upgradePrompts = [
            {
                id: 'wallet-connect-1',
                type: 'upgrade',
                title: 'Unlock More Features',
                message: 'Connect an eCripto wallet to unlock unlimited links, priority connections, and more - even with 0 balance!',
                action: { text: 'Connect Wallet', handler: 'connect-wallet' },
                priority: 1,
                dismissible: true,
                showAfter: 5 * 60 * 1000, // After 5 minutes of use
                conditions: ['no-wallet']
            },
            {
                id: 'rate-limit-warning',
                type: 'warning',
                title: 'Rate Limit Reached',
                message: 'You\'ve reached your free tier limit. Connect a wallet or upgrade to continue.',
                action: { text: 'Upgrade', handler: 'show-upgrade' },
                priority: 2,
                dismissible: false,
                conditions: ['rate-limited']
            },
            {
                id: 'random-links-notice',
                type: 'info',
                title: 'Random Links Only',
                message: 'Free tier generates random session links that expire in 24 hours. Upgrade for custom permanent links!',
                priority: 0,
                dismissible: true,
                conditions: ['no-wallet', 'generating-link']
            },
            {
                id: 'trust-score-intro',
                type: 'feature',
                title: 'Build Your Trust Score',
                message: 'Connect a wallet to start building trust. Higher trust unlocks features like minting and instant connections!',
                action: { text: 'Learn More', handler: 'show-trust-info' },
                priority: 0,
                dismissible: true,
                showAfter: 10 * 60 * 1000, // After 10 minutes
                conditions: ['no-wallet']
            },
            {
                id: 'device-limit',
                type: 'warning',
                title: 'Device Limit Reached',
                message: 'Free tier allows 1 linked device. Connect a wallet to link up to 5 devices!',
                priority: 1,
                dismissible: true,
                conditions: ['device-limit-reached']
            },
            {
                id: 'payment-promo',
                type: 'promo',
                title: 'Full Access for Just $0.99',
                message: 'Get 24-hour full access with PayPal, Stripe, or eCripto. All features unlocked instantly!',
                action: { text: 'Get Access', handler: 'show-payment' },
                priority: 0,
                dismissible: true,
                showAfter: 15 * 60 * 1000,
                conditions: ['no-wallet', 'no-payment']
            }
        ];
    }

    /**
     * Fetch announcements from server
     */
    async fetchAnnouncements() {
        const walletAddress = this.ecriptoConnector?.walletAddress;

        // Don't fetch for wallet users
        if (walletAddress) {
            this.announcements = [];
            return [];
        }

        // Check fetch interval
        if (this.lastFetch && Date.now() - this.lastFetch < this.FETCH_INTERVAL) {
            return this.announcements;
        }

        try {
            const machineId = this.store.get('machineId');

            const response = await this.ecriptoConnector.webRequest('GET',
                `/api/v1/announcements?machineId=${machineId}`);

            if (response.success !== false && response.announcements) {
                this.announcements = response.announcements;
                this.lastFetch = Date.now();
            }
        } catch (error) {
            console.error('[Announcements] Fetch failed:', error);
        }

        return this.announcements;
    }

    /**
     * Get relevant announcements for current state
     */
    async getRelevantAnnouncements(conditions = []) {
        const walletAddress = this.ecriptoConnector?.walletAddress;
        const paymentInfo = this.store.get('paymentInfo');

        // Wallet connected or paid - no announcements
        if (walletAddress || (paymentInfo && new Date(paymentInfo.expiresAt) > new Date())) {
            return [];
        }

        // Add implicit conditions
        if (!walletAddress) conditions.push('no-wallet');
        if (!paymentInfo) conditions.push('no-payment');

        const appStartTime = this.store.get('currentSessionStart') || Date.now();
        const sessionDuration = Date.now() - appStartTime;

        // Filter built-in prompts based on conditions
        const relevantPrompts = this.upgradePrompts.filter(prompt => {
            // Check if dismissed
            if (prompt.dismissible && this.dismissedIds.has(prompt.id)) {
                return false;
            }

            // Check showAfter
            if (prompt.showAfter && sessionDuration < prompt.showAfter) {
                return false;
            }

            // Check conditions
            if (prompt.conditions) {
                const hasRequiredCondition = prompt.conditions.some(c => conditions.includes(c));
                if (!hasRequiredCondition) {
                    return false;
                }
            }

            return true;
        });

        // Combine with server announcements
        const serverAnnouncements = this.announcements.filter(a => {
            return !this.dismissedIds.has(a.id);
        });

        // Sort by priority (higher = more important)
        const all = [...relevantPrompts, ...serverAnnouncements];
        all.sort((a, b) => (b.priority || 0) - (a.priority || 0));

        return all;
    }

    /**
     * Get a single announcement to show
     */
    async getNextAnnouncement(conditions = []) {
        const announcements = await this.getRelevantAnnouncements(conditions);
        return announcements[0] || null;
    }

    /**
     * Dismiss an announcement
     */
    dismiss(announcementId) {
        this.dismissedIds.add(announcementId);

        // Persist dismissals
        const dismissed = Array.from(this.dismissedIds);
        this.store.set('dismissedAnnouncements', dismissed);

        // Report to server
        this.reportDismissal(announcementId);

        this.emit('dismissed', announcementId);
    }

    /**
     * Report dismissal to server
     */
    async reportDismissal(announcementId) {
        try {
            const machineId = this.store.get('machineId');
            await this.ecriptoConnector.webRequest('POST', '/api/v1/announcements/dismiss', {
                machineId,
                announcementId
            });
        } catch (error) {
            // Ignore - not critical
        }
    }

    /**
     * Show a specific type of announcement
     */
    showAnnouncementForCondition(condition) {
        const matching = this.upgradePrompts.filter(p =>
            p.conditions && p.conditions.includes(condition) && !this.dismissedIds.has(p.id)
        );

        if (matching.length > 0) {
            this.emit('show-announcement', matching[0]);
            return matching[0];
        }

        return null;
    }

    /**
     * Reset dismissed announcements (for testing)
     */
    resetDismissed() {
        this.dismissedIds.clear();
        this.store.delete('dismissedAnnouncements');
    }

    /**
     * Check if announcements should be shown
     */
    shouldShowAnnouncements() {
        const walletAddress = this.ecriptoConnector?.walletAddress;
        const paymentInfo = this.store.get('paymentInfo');

        // Don't show for wallet users
        if (walletAddress) return false;

        // Don't show for paid users
        if (paymentInfo && new Date(paymentInfo.expiresAt) > new Date()) return false;

        return true;
    }

    /**
     * Record session start for timing announcements
     */
    recordSessionStart() {
        if (!this.store.get('currentSessionStart')) {
            this.store.set('currentSessionStart', Date.now());
        }
    }
}

module.exports = AnnouncementService;
