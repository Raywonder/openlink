/**
 * Persistent Link Manager for OpenLink
 * Manages links that can be regenerated, kept alive, and tied to eCripto wallets
 *
 * Features:
 * - Links can be regenerated with same ID
 * - Links can be kept alive based on conditions (activity, wallet balance)
 * - eCripto wallet holders with balance get non-expiring links
 * - NFT-based permanent links that never expire
 */

const crypto = require('crypto');
const { ethers } = require('ethers');
const Store = require('electron-store');

// eCripto network configuration
const ECRIPTO_NETWORK = {
    chainId: 47828,
    rpcUrl: 'https://rpc.ecripto.app',
    explorerUrl: 'https://explorer.ecripto.app'
};

// Minimum balance for persistent link benefits (in ECRP)
const MIN_BALANCE_FOR_PERSISTENCE = 1; // 1 ECRP minimum
const PREMIUM_BALANCE = 10; // 10 ECRP for premium features
const NFT_LINK_COST = 5; // 5 ECRP to mint a permanent NFT link

class PersistentLinkManager {
    constructor(options = {}) {
        this.options = {
            apiUrl: options.apiUrl || 'https://ecripto.app/api/v2',
            defaultLinkDuration: options.defaultLinkDuration || 24 * 60 * 60 * 1000, // 24 hours for free
            walletLinkedDuration: options.walletLinkedDuration || 7 * 24 * 60 * 60 * 1000, // 7 days with wallet
            premiumDuration: options.premiumDuration || 30 * 24 * 60 * 60 * 1000, // 30 days with 10+ ECRP
            nftLinkDuration: null, // Never expires (null = infinite)
            cleanupInterval: options.cleanupInterval || 5 * 60 * 1000, // 5 minutes
            ...options
        };

        this.store = new Store({
            name: 'openlink-persistent-links',
            encryptionKey: 'openlink-persistent-links-2024'
        });

        this.provider = new ethers.JsonRpcProvider(ECRIPTO_NETWORK.rpcUrl);
        this.links = new Map();
        this.walletCache = new Map(); // Cache wallet balances
        this.nftLinks = new Map(); // NFT-backed permanent links

        this.loadStoredLinks();
        this.startBackgroundTasks();
    }

    /**
     * Load stored links from persistent storage
     */
    loadStoredLinks() {
        const stored = this.store.get('links', {});
        for (const [id, link] of Object.entries(stored)) {
            this.links.set(id, {
                ...link,
                lastLoadedAt: new Date().toISOString()
            });
        }

        const nftStored = this.store.get('nftLinks', {});
        for (const [id, link] of Object.entries(nftStored)) {
            this.nftLinks.set(id, link);
        }

        console.log(`[PersistentLinks] Loaded ${this.links.size} links, ${this.nftLinks.size} NFT links`);
    }

    /**
     * Save links to persistent storage
     */
    saveLinks() {
        const linksObj = Object.fromEntries(this.links);
        const nftLinksObj = Object.fromEntries(this.nftLinks);
        this.store.set('links', linksObj);
        this.store.set('nftLinks', nftLinksObj);
    }

    /**
     * Create or regenerate a persistent link
     * @param {Object} options Link options
     * @returns {Object} Link details
     */
    async createLink(options = {}) {
        const {
            sessionId,
            customId = null,
            walletAddress = null,
            baseDomain = 'openlink.raywonderis.me',
            targetHost = 'localhost',
            targetPort,
            metadata = {}
        } = options;

        // Generate or use custom link ID
        const linkId = customId || this.generateLinkId();

        // Check if this is a regeneration
        const existingLink = this.links.get(linkId) || this.nftLinks.get(linkId);
        const isRegeneration = !!existingLink;

        // Determine link tier based on wallet
        const tier = await this.determineLinkTier(walletAddress);

        // Calculate expiration
        const now = Date.now();
        let expiresAt = null;
        let duration = null;

        switch (tier.type) {
            case 'nft':
                expiresAt = null; // Never expires
                duration = null;
                break;
            case 'premium':
                duration = this.options.premiumDuration;
                expiresAt = new Date(now + duration).toISOString();
                break;
            case 'wallet':
                duration = this.options.walletLinkedDuration;
                expiresAt = new Date(now + duration).toISOString();
                break;
            default:
                duration = this.options.defaultLinkDuration;
                expiresAt = new Date(now + duration).toISOString();
        }

        const link = {
            id: linkId,
            sessionId,
            subdomain: linkId,
            baseDomain,
            fullDomain: `${linkId}.${baseDomain}`,
            targetHost,
            targetPort,
            walletAddress,
            tier: tier.type,
            balance: tier.balance,
            createdAt: existingLink?.createdAt || new Date().toISOString(),
            regeneratedAt: isRegeneration ? new Date().toISOString() : null,
            regenerationCount: isRegeneration ? (existingLink.regenerationCount || 0) + 1 : 0,
            expiresAt,
            duration,
            status: 'active',
            lastActivity: new Date().toISOString(),
            activityCount: 0,
            keepAlive: {
                enabled: tier.type !== 'free',
                lastCheck: new Date().toISOString(),
                conditions: this.getKeepAliveConditions(tier.type)
            },
            metadata: {
                ...existingLink?.metadata,
                ...metadata
            }
        };

        // Store in appropriate map
        if (tier.type === 'nft') {
            this.nftLinks.set(linkId, link);
        } else {
            this.links.set(linkId, link);
        }

        this.saveLinks();

        console.log(`[PersistentLinks] ${isRegeneration ? 'Regenerated' : 'Created'} ${tier.type} link: ${link.fullDomain}`);

        return {
            success: true,
            link,
            isRegeneration,
            accessUrl: `https://${link.fullDomain}`,
            tier: tier.type,
            expiresAt: link.expiresAt,
            keepAlive: link.keepAlive.enabled
        };
    }

    /**
     * Regenerate an existing link (mark as usable again)
     */
    async regenerateLink(linkId, options = {}) {
        const existingLink = this.links.get(linkId) || this.nftLinks.get(linkId);

        if (!existingLink) {
            // Create new link with this ID
            return this.createLink({
                ...options,
                customId: linkId
            });
        }

        // Regenerate with updated properties
        return this.createLink({
            sessionId: options.sessionId || existingLink.sessionId,
            customId: linkId,
            walletAddress: options.walletAddress || existingLink.walletAddress,
            baseDomain: existingLink.baseDomain,
            targetHost: options.targetHost || existingLink.targetHost,
            targetPort: options.targetPort || existingLink.targetPort,
            metadata: {
                ...existingLink.metadata,
                ...options.metadata
            }
        });
    }

    /**
     * Keep a link alive (reset expiration based on conditions)
     */
    async keepLinkAlive(linkId, reason = 'manual') {
        const link = this.links.get(linkId);
        if (!link) {
            // NFT links don't need keep-alive
            const nftLink = this.nftLinks.get(linkId);
            if (nftLink) {
                return { success: true, reason: 'nft_permanent', link: nftLink };
            }
            throw new Error('Link not found');
        }

        if (!link.keepAlive.enabled) {
            throw new Error('Keep-alive not enabled for this link tier');
        }

        // Check conditions
        const tier = await this.determineLinkTier(link.walletAddress);

        // Update expiration
        const now = Date.now();
        let newDuration;

        switch (tier.type) {
            case 'premium':
                newDuration = this.options.premiumDuration;
                break;
            case 'wallet':
                newDuration = this.options.walletLinkedDuration;
                break;
            default:
                throw new Error('Wallet balance insufficient for keep-alive');
        }

        link.expiresAt = new Date(now + newDuration).toISOString();
        link.keepAlive.lastCheck = new Date().toISOString();
        link.keepAlive.reason = reason;
        link.tier = tier.type;
        link.balance = tier.balance;

        this.links.set(linkId, link);
        this.saveLinks();

        console.log(`[PersistentLinks] Kept alive: ${linkId} (reason: ${reason}, tier: ${tier.type})`);

        return {
            success: true,
            link,
            newExpiration: link.expiresAt,
            reason
        };
    }

    /**
     * Record activity on a link (extends life for active links)
     */
    async recordActivity(linkId) {
        const link = this.links.get(linkId) || this.nftLinks.get(linkId);
        if (!link) {
            throw new Error('Link not found');
        }

        link.lastActivity = new Date().toISOString();
        link.activityCount = (link.activityCount || 0) + 1;

        // Check if activity-based keep-alive should trigger
        if (link.keepAlive?.enabled && link.keepAlive.conditions.includes('activity')) {
            const conditions = this.checkKeepAliveConditions(link);
            if (conditions.shouldExtend) {
                await this.keepLinkAlive(linkId, 'activity');
            }
        }

        if (this.nftLinks.has(linkId)) {
            this.nftLinks.set(linkId, link);
        } else {
            this.links.set(linkId, link);
        }

        return { success: true, activityCount: link.activityCount };
    }

    /**
     * Get link status and remaining time
     */
    async getLinkStatus(linkId) {
        const link = this.links.get(linkId) || this.nftLinks.get(linkId);
        if (!link) {
            return { exists: false, active: false };
        }

        const isNFT = this.nftLinks.has(linkId);
        const now = Date.now();
        const expiresAt = link.expiresAt ? new Date(link.expiresAt).getTime() : null;
        const isExpired = expiresAt && now > expiresAt;

        // Check current wallet balance
        let currentTier = null;
        if (link.walletAddress) {
            currentTier = await this.determineLinkTier(link.walletAddress);
        }

        return {
            exists: true,
            active: !isExpired,
            isNFT,
            link: {
                id: link.id,
                fullDomain: link.fullDomain,
                accessUrl: `https://${link.fullDomain}`,
                tier: isNFT ? 'nft' : link.tier,
                status: isExpired ? 'expired' : 'active',
                createdAt: link.createdAt,
                expiresAt: link.expiresAt,
                remainingTime: expiresAt ? Math.max(0, expiresAt - now) : null,
                regenerationCount: link.regenerationCount,
                lastActivity: link.lastActivity,
                activityCount: link.activityCount,
                walletAddress: link.walletAddress,
                currentBalance: currentTier?.balance || null,
                keepAlive: link.keepAlive
            }
        };
    }

    /**
     * Mint an NFT for a permanent link
     */
    async mintNFTLink(linkId, walletAddress, signer = null) {
        const link = this.links.get(linkId);
        if (!link) {
            throw new Error('Link not found');
        }

        // Verify wallet has enough balance
        const balance = await this.getWalletBalance(walletAddress);
        if (balance < NFT_LINK_COST) {
            throw new Error(`Insufficient balance. Need ${NFT_LINK_COST} ECRP, have ${balance} ECRP`);
        }

        // For now, simulate NFT minting (actual implementation would use smart contract)
        const nftId = crypto.randomBytes(16).toString('hex');
        const nftData = {
            id: nftId,
            linkId,
            owner: walletAddress,
            mintedAt: new Date().toISOString(),
            txHash: null, // Would be real tx hash
            metadata: {
                name: `OpenLink Permanent Session: ${linkId}`,
                description: `Permanent access link for OpenLink session`,
                domain: link.fullDomain,
                cost: NFT_LINK_COST
            }
        };

        // Convert to NFT link (remove expiration)
        const nftLink = {
            ...link,
            tier: 'nft',
            expiresAt: null,
            duration: null,
            nft: nftData,
            keepAlive: {
                enabled: false,
                reason: 'nft_permanent'
            }
        };

        // Move from regular links to NFT links
        this.links.delete(linkId);
        this.nftLinks.set(linkId, nftLink);
        this.saveLinks();

        console.log(`[PersistentLinks] NFT minted for link: ${linkId} (NFT ID: ${nftId})`);

        return {
            success: true,
            nftId,
            linkId,
            link: nftLink,
            cost: NFT_LINK_COST,
            accessUrl: `https://${link.fullDomain}`
        };
    }

    /**
     * Get all links for a wallet
     */
    async getLinksForWallet(walletAddress) {
        const normalizedAddress = walletAddress.toLowerCase();
        const links = [];

        for (const link of this.links.values()) {
            if (link.walletAddress?.toLowerCase() === normalizedAddress) {
                links.push(await this.getLinkStatus(link.id));
            }
        }

        for (const link of this.nftLinks.values()) {
            if (link.walletAddress?.toLowerCase() === normalizedAddress) {
                links.push(await this.getLinkStatus(link.id));
            }
        }

        return {
            walletAddress,
            totalLinks: links.length,
            activeLinks: links.filter(l => l.active).length,
            nftLinks: links.filter(l => l.isNFT).length,
            links
        };
    }

    /**
     * Determine link tier based on wallet balance
     */
    async determineLinkTier(walletAddress) {
        if (!walletAddress) {
            return { type: 'free', balance: 0 };
        }

        // Check if wallet has NFT links
        for (const link of this.nftLinks.values()) {
            if (link.walletAddress?.toLowerCase() === walletAddress.toLowerCase()) {
                return { type: 'nft', balance: await this.getWalletBalance(walletAddress) };
            }
        }

        const balance = await this.getWalletBalance(walletAddress);

        if (balance >= PREMIUM_BALANCE) {
            return { type: 'premium', balance };
        } else if (balance >= MIN_BALANCE_FOR_PERSISTENCE) {
            return { type: 'wallet', balance };
        }

        return { type: 'free', balance };
    }

    /**
     * Get wallet balance from eCripto network
     */
    async getWalletBalance(walletAddress) {
        // Check cache first (5 minute cache)
        const cached = this.walletCache.get(walletAddress);
        if (cached && Date.now() - cached.timestamp < 5 * 60 * 1000) {
            return cached.balance;
        }

        try {
            const balanceWei = await this.provider.getBalance(walletAddress);
            const balance = parseFloat(ethers.formatEther(balanceWei));

            this.walletCache.set(walletAddress, {
                balance,
                timestamp: Date.now()
            });

            return balance;
        } catch (error) {
            console.error(`[PersistentLinks] Failed to get balance for ${walletAddress}:`, error.message);
            return cached?.balance || 0;
        }
    }

    /**
     * Get keep-alive conditions for a tier
     */
    getKeepAliveConditions(tier) {
        switch (tier) {
            case 'premium':
                return ['wallet_balance', 'activity', 'manual'];
            case 'wallet':
                return ['wallet_balance', 'activity'];
            case 'nft':
                return []; // NFTs don't need keep-alive
            default:
                return [];
        }
    }

    /**
     * Check if keep-alive conditions are met
     */
    checkKeepAliveConditions(link) {
        const conditions = link.keepAlive?.conditions || [];

        // Activity check: active in last hour = extend
        if (conditions.includes('activity')) {
            const lastActivity = new Date(link.lastActivity).getTime();
            const hourAgo = Date.now() - 60 * 60 * 1000;
            if (lastActivity > hourAgo) {
                return { shouldExtend: true, reason: 'recent_activity' };
            }
        }

        return { shouldExtend: false };
    }

    /**
     * Generate a unique link ID
     */
    generateLinkId() {
        return crypto.randomBytes(4).toString('hex');
    }

    /**
     * Start background tasks
     */
    startBackgroundTasks() {
        // Cleanup expired links
        setInterval(() => this.cleanupExpiredLinks(), this.options.cleanupInterval);

        // Check keep-alive conditions
        setInterval(() => this.processKeepAlive(), 15 * 60 * 1000); // Every 15 minutes
    }

    /**
     * Cleanup expired links
     */
    cleanupExpiredLinks() {
        const now = Date.now();
        let cleanedCount = 0;

        for (const [id, link] of this.links.entries()) {
            if (link.expiresAt && new Date(link.expiresAt).getTime() < now) {
                // Check if keep-alive should trigger
                if (link.keepAlive?.enabled) {
                    this.checkKeepAliveConditions(link);
                    // Will be handled by processKeepAlive
                    continue;
                }

                console.log(`[PersistentLinks] Expiring link: ${id}`);
                link.status = 'expired';
                // Keep for 24 hours after expiration for potential regeneration
                if (now - new Date(link.expiresAt).getTime() > 24 * 60 * 60 * 1000) {
                    this.links.delete(id);
                    cleanedCount++;
                }
            }
        }

        if (cleanedCount > 0) {
            this.saveLinks();
            console.log(`[PersistentLinks] Cleaned up ${cleanedCount} expired links`);
        }
    }

    /**
     * Process keep-alive for eligible links
     */
    async processKeepAlive() {
        const now = Date.now();

        for (const [id, link] of this.links.entries()) {
            if (!link.keepAlive?.enabled) continue;
            if (!link.walletAddress) continue;

            // Check if expiring soon (within 1 hour)
            const expiresAt = new Date(link.expiresAt).getTime();
            if (expiresAt - now > 60 * 60 * 1000) continue;

            try {
                const tier = await this.determineLinkTier(link.walletAddress);
                if (tier.type !== 'free') {
                    await this.keepLinkAlive(id, 'auto_extend');
                }
            } catch (error) {
                console.error(`[PersistentLinks] Keep-alive failed for ${id}:`, error.message);
            }
        }
    }

    /**
     * Get statistics
     */
    getStats() {
        return {
            totalLinks: this.links.size + this.nftLinks.size,
            regularLinks: this.links.size,
            nftLinks: this.nftLinks.size,
            activeLinks: Array.from(this.links.values()).filter(l => l.status === 'active').length,
            expiredLinks: Array.from(this.links.values()).filter(l => l.status === 'expired').length,
            byTier: {
                free: Array.from(this.links.values()).filter(l => l.tier === 'free').length,
                wallet: Array.from(this.links.values()).filter(l => l.tier === 'wallet').length,
                premium: Array.from(this.links.values()).filter(l => l.tier === 'premium').length,
                nft: this.nftLinks.size
            },
            walletCacheSize: this.walletCache.size
        };
    }

    // =====================================================
    // AUTO-REGENERATION AND NOTIFICATION SYSTEM
    // =====================================================

    /**
     * Check if a link is active on the signaling server
     */
    async checkLinkActive(linkId) {
        try {
            const signalingUrl = this.options.signalingServer || 'https://raywonderis.me';
            const response = await fetch(`${signalingUrl}/api/session/${linkId}`);
            const data = await response.json();
            return {
                exists: data.exists === true,
                hasHost: data.hasHost === true,
                clientCount: data.clientCount || 0
            };
        } catch (error) {
            console.error(`[PersistentLinks] Failed to check link status:`, error.message);
            return { exists: false, hasHost: false, clientCount: 0 };
        }
    }

    /**
     * Auto-regenerate link if expired or inactive
     * Returns the active link (existing or newly regenerated)
     */
    async ensureLinkActive(linkId, options = {}) {
        const { autoRegenerate = true, sendNotification = true } = options;

        // Check current status
        const link = this.links.get(linkId) || this.nftLinks.get(linkId);
        if (!link) {
            throw new Error('Link not found');
        }

        // Check if link is active on signaling server
        const serverStatus = await this.checkLinkActive(linkId);

        // Check expiration
        const now = Date.now();
        const isExpired = link.expiresAt && new Date(link.expiresAt).getTime() < now;
        const isInactive = !serverStatus.exists || !serverStatus.hasHost;

        // If link is active, update and return
        if (!isExpired && serverStatus.exists) {
            link.lastCheck = new Date().toISOString();
            link.serverStatus = serverStatus;
            this.saveLinks();

            return {
                active: true,
                regenerated: false,
                link,
                serverStatus
            };
        }

        // Link needs regeneration
        if (!autoRegenerate) {
            return {
                active: false,
                regenerated: false,
                reason: isExpired ? 'expired' : 'inactive',
                link,
                serverStatus
            };
        }

        console.log(`[PersistentLinks] Auto-regenerating link: ${linkId} (reason: ${isExpired ? 'expired' : 'inactive'})`);

        // Regenerate the link
        const regenerated = await this.regenerateLink(linkId, {
            sessionId: link.sessionId,
            walletAddress: link.walletAddress,
            targetHost: link.targetHost,
            targetPort: link.targetPort
        });

        // Send notification
        if (sendNotification) {
            await this.sendLinkNotification(link, 'regenerated', {
                reason: isExpired ? 'expired' : 'inactive',
                newExpiration: regenerated.link.expiresAt
            });
        }

        return {
            active: true,
            regenerated: true,
            reason: isExpired ? 'expired' : 'inactive',
            link: regenerated.link,
            serverStatus: await this.checkLinkActive(linkId)
        };
    }

    /**
     * Send notification about link status changes
     */
    async sendLinkNotification(link, type, details = {}) {
        const notification = {
            type,
            linkId: link.id,
            domain: link.fullDomain,
            timestamp: new Date().toISOString(),
            walletAddress: link.walletAddress,
            ...details
        };

        console.log(`[PersistentLinks] Notification: ${type} for ${link.id}`);

        // Emit event for app to handle
        if (this.notificationCallback) {
            this.notificationCallback(notification);
        }

        // Store notification
        const notifications = this.store.get('notifications', []);
        notifications.unshift(notification);
        if (notifications.length > 100) notifications.pop(); // Keep last 100
        this.store.set('notifications', notifications);

        // If wallet is linked, could also send push notification via API
        if (link.walletAddress) {
            try {
                await this.sendPushNotification(link.walletAddress, notification);
            } catch (e) {
                console.error('[PersistentLinks] Failed to send push notification:', e.message);
            }
        }

        return notification;
    }

    /**
     * Send push notification via eCripto API
     */
    async sendPushNotification(walletAddress, notification) {
        const titles = {
            regenerated: 'Link Regenerated',
            expired: 'Link Expired',
            expiring_soon: 'Link Expiring Soon',
            activity: 'New Activity on Link'
        };

        const messages = {
            regenerated: `Your OpenLink session ${notification.linkId} was regenerated automatically.`,
            expired: `Your OpenLink session ${notification.linkId} has expired.`,
            expiring_soon: `Your OpenLink session ${notification.linkId} will expire in ${notification.timeRemaining}.`,
            activity: `Someone accessed your OpenLink session ${notification.linkId}.`
        };

        const payload = {
            walletAddress,
            title: titles[notification.type] || 'OpenLink Update',
            message: messages[notification.type] || `Link ${notification.linkId} status: ${notification.type}`,
            data: notification
        };

        // Send via eCripto push API
        const response = await fetch(`${this.options.apiUrl}/push/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        return response.json();
    }

    /**
     * Set notification callback
     */
    onNotification(callback) {
        this.notificationCallback = callback;
    }

    /**
     * Get notifications for a wallet
     */
    getNotifications(walletAddress = null) {
        const all = this.store.get('notifications', []);
        if (!walletAddress) return all;
        return all.filter(n => n.walletAddress === walletAddress);
    }

    /**
     * Monitor all links and auto-regenerate as needed
     */
    async monitorLinks() {
        const results = [];

        for (const [id, link] of this.links.entries()) {
            // Skip if not owned by a wallet (free links)
            if (!link.walletAddress) continue;

            const result = await this.ensureLinkActive(id, {
                autoRegenerate: link.tier !== 'free', // Only auto-regen for wallet-linked
                sendNotification: true
            });

            results.push({ linkId: id, ...result });
        }

        // NFT links never expire but check if they're active
        for (const [id, link] of this.nftLinks.entries()) {
            const serverStatus = await this.checkLinkActive(id);
            link.lastCheck = new Date().toISOString();
            link.serverStatus = serverStatus;
            results.push({ linkId: id, active: true, isNFT: true, serverStatus });
        }

        this.saveLinks();
        return results;
    }

    /**
     * Start auto-monitoring for all wallet-linked sessions
     */
    startAutoMonitor(intervalMs = 5 * 60 * 1000) { // Default: every 5 minutes
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
        }

        console.log(`[PersistentLinks] Starting auto-monitor (interval: ${intervalMs / 1000}s)`);

        this.monitorInterval = setInterval(async () => {
            const results = await this.monitorLinks();
            const regenerated = results.filter(r => r.regenerated).length;
            if (regenerated > 0) {
                console.log(`[PersistentLinks] Auto-monitored ${results.length} links, regenerated ${regenerated}`);
            }
        }, intervalMs);

        // Run immediately
        this.monitorLinks();
    }

    /**
     * Stop auto-monitoring
     */
    stopAutoMonitor() {
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
            this.monitorInterval = null;
            console.log('[PersistentLinks] Auto-monitor stopped');
        }
    }
}

module.exports = PersistentLinkManager;
