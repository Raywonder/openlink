/**
 * Dynamic Domain Manager for OpenLink
 * Handles on-demand domain creation with permits, temporary and timed URLs
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

class DynamicDomainManager {
    constructor(configManager, options = {}) {
        this.configManager = configManager;
        this.options = {
            maxDomainLife: options.maxDomainLife || 24 * 60 * 60 * 1000, // 24 hours
            defaultPermitDuration: options.defaultPermitDuration || 60 * 60 * 1000, // 1 hour
            maxPermitDuration: options.maxPermitDuration || 7 * 24 * 60 * 60 * 1000, // 7 days
            cleanupInterval: options.cleanupInterval || 15 * 60 * 1000, // 15 minutes
            allowedBaseDomains: options.allowedBaseDomains || ['raywonderis.me', 'openlink.local'],
            requirePermitForPublic: options.requirePermitForPublic !== false,
            ...options
        };

        this.domains = new Map(); // Active domains
        this.permits = new Map(); // Active permits
        this.temporaryUrls = new Map(); // Temporary access URLs
        this.domainChecks = new Map(); // Cache for domain existence checks

        this.startCleanupTimer();
    }

    /**
     * Request a domain - checks existence or creates on-demand
     */
    async requestDomain(request) {
        const {
            subdomain,
            baseDomain = this.options.allowedBaseDomains[0],
            clientId,
            permitToken = null,
            temporary = false,
            duration = null,
            targetHost = 'localhost',
            targetPort,
            sslEnabled = false,
            accessControl = 'public'
        } = request;

        // Validate request
        this.validateDomainRequest(request);

        const fullDomain = `${subdomain}.${baseDomain}`;
        const domainId = this.generateDomainId(fullDomain);

        console.log(`🌐 Domain request: ${fullDomain} (${accessControl})`);

        try {
            // Check if domain already exists
            const existingDomain = await this.checkDomainExists(fullDomain);

            if (existingDomain) {
                return await this.handleExistingDomain(existingDomain, request);
            }

            // Create new domain
            return await this.createNewDomain({
                id: domainId,
                subdomain,
                baseDomain,
                fullDomain,
                clientId,
                permitToken,
                temporary,
                duration,
                targetHost,
                targetPort,
                sslEnabled,
                accessControl
            });

        } catch (error) {
            console.error(`❌ Domain request failed for ${fullDomain}:`, error.message);
            throw error;
        }
    }

    /**
     * Check if domain exists on server or locally
     */
    async checkDomainExists(fullDomain) {
        // Check cache first
        if (this.domainChecks.has(fullDomain)) {
            const cached = this.domainChecks.get(fullDomain);
            if (Date.now() - cached.timestamp < 5 * 60 * 1000) { // 5 minute cache
                return cached.exists ? cached.domain : null;
            }
        }

        try {
            // Check active domains first
            for (const domain of this.domains.values()) {
                if (domain.fullDomain === fullDomain) {
                    this.cachedomainCheck(fullDomain, domain);
                    return domain;
                }
            }

            // Check if domain exists in DNS/nginx
            const dnsExists = await this.checkDNSRecord(fullDomain);
            if (dnsExists) {
                const existingDomain = {
                    fullDomain,
                    exists: true,
                    external: true,
                    foundAt: new Date().toISOString()
                };
                this.cachedomainCheck(fullDomain, existingDomain);
                return existingDomain;
            }

            // Check nginx configurations
            const nginxExists = await this.checkNginxConfig(fullDomain);
            if (nginxExists) {
                const existingDomain = {
                    fullDomain,
                    exists: true,
                    nginx: true,
                    foundAt: new Date().toISOString()
                };
                this.cachedomainCheck(fullDomain, existingDomain);
                return existingDomain;
            }

            // Domain doesn't exist
            this.cachedomainCheck(fullDomain, null);
            return null;

        } catch (error) {
            console.warn(`⚠️  Domain existence check failed for ${fullDomain}:`, error.message);
            return null;
        }
    }

    /**
     * Handle request for existing domain
     */
    async handleExistingDomain(existingDomain, request) {
        const { fullDomain } = existingDomain;

        // If it's an external domain, we can't manage it
        if (existingDomain.external && !existingDomain.nginx) {
            throw new Error(`Domain ${fullDomain} is externally managed and cannot be controlled`);
        }

        // If domain exists in our system, check permissions
        if (existingDomain.id && this.domains.has(existingDomain.id)) {
            const domain = this.domains.get(existingDomain.id);

            // Check if client has access
            if (domain.clientId !== request.clientId) {
                // Check if client has a valid permit
                if (!this.validatePermit(request.permitToken, fullDomain)) {
                    throw new Error(`Access denied to domain ${fullDomain}. Valid permit required.`);
                }
            }

            // Update domain if needed
            return await this.updateExistingDomain(domain, request);
        }

        // Domain exists but not in our system - import it
        return await this.importExistingDomain(existingDomain, request);
    }

    /**
     * Create a new domain
     */
    async createNewDomain(domainSpec) {
        const {
            id,
            fullDomain,
            clientId,
            temporary,
            duration,
            accessControl,
            permitToken
        } = domainSpec;

        // Check access control requirements
        await this.validateAccess(domainSpec);

        // Calculate expiration
        const now = Date.now();
        let expiresAt = now + this.options.maxDomainLife;

        if (temporary && duration) {
            expiresAt = Math.min(now + duration, expiresAt);
        }

        const domain = {
            ...domainSpec,
            status: 'creating',
            createdAt: new Date().toISOString(),
            expiresAt: new Date(expiresAt).toISOString(),
            accessLogs: [],
            permits: permitToken ? [permitToken] : [],
            temporaryUrls: [],
            stats: {
                requests: 0,
                lastAccess: null,
                totalBytes: 0
            }
        };

        try {
            // Create the actual domain configuration
            const configResult = await this.configManager.requestDomain({
                clientId: domain.clientId,
                subdomain: domain.subdomain,
                baseDomain: domain.baseDomain,
                targetHost: domain.targetHost,
                targetPort: domain.targetPort,
                sslEnabled: domain.sslEnabled
            });

            // Update domain with config details
            domain.port = configResult.port;
            domain.nginxConfigured = true;
            domain.status = 'active';

            // Store domain
            this.domains.set(id, domain);

            // Create permits if needed
            if (domain.accessControl !== 'public') {
                await this.createDefaultPermit(domain);
            }

            console.log(`✅ Domain created: ${fullDomain} (expires: ${domain.expiresAt})`);

            return {
                ...domain,
                accessUrl: this.generateAccessUrl(domain),
                permitToken: domain.permits[0] || null
            };

        } catch (error) {
            console.error(`❌ Failed to create domain ${fullDomain}:`, error.message);
            throw error;
        }
    }

    /**
     * Validate access requirements for domain creation
     */
    async validateAccess(domainSpec) {
        const { baseDomain, accessControl, permitToken } = domainSpec;

        // Check if base domain is allowed
        if (!this.options.allowedBaseDomains.includes(baseDomain)) {
            throw new Error(`Base domain ${baseDomain} is not allowed`);
        }

        // Check permit requirements for public domains
        if (this.isPublicDomain(baseDomain) && this.options.requirePermitForPublic) {
            if (accessControl === 'public' && !permitToken) {
                throw new Error('Permit required for public domain access');
            }

            if (permitToken && !this.validatePermit(permitToken, domainSpec.fullDomain)) {
                throw new Error('Invalid or expired permit token');
            }
        }
    }

    /**
     * Create a permit for domain access
     */
    async createPermit(options = {}) {
        const {
            domainPattern = '*',
            duration = this.options.defaultPermitDuration,
            clientId = null,
            permissions = ['read', 'connect'],
            createdBy = 'system'
        } = options;

        const permitId = crypto.randomBytes(32).toString('hex');
        const expiresAt = Date.now() + Math.min(duration, this.options.maxPermitDuration);

        const permit = {
            id: permitId,
            token: permitId, // Simple token for now
            domainPattern,
            clientId,
            permissions,
            createdBy,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(expiresAt).toISOString(),
            usageCount: 0,
            lastUsed: null
        };

        this.permits.set(permitId, permit);

        console.log(`🎫 Permit created: ${permitId} (pattern: ${domainPattern}, expires: ${permit.expiresAt})`);

        return permit;
    }

    /**
     * Create a temporary URL for domain access
     */
    async createTemporaryUrl(domainId, options = {}) {
        const {
            duration = 15 * 60 * 1000, // 15 minutes
            maxUses = 1,
            permissions = ['read'],
            clientId = null
        } = options;

        const domain = this.domains.get(domainId);
        if (!domain) {
            throw new Error('Domain not found');
        }

        const urlId = crypto.randomBytes(16).toString('hex');
        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = Date.now() + duration;

        const tempUrl = {
            id: urlId,
            token,
            domainId,
            fullDomain: domain.fullDomain,
            permissions,
            clientId,
            maxUses,
            currentUses: 0,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(expiresAt).toISOString(),
            accessLogs: []
        };

        this.temporaryUrls.set(urlId, tempUrl);
        domain.temporaryUrls.push(urlId);

        const accessUrl = `${domain.fullDomain}?temp_token=${token}&url_id=${urlId}`;

        console.log(`🔗 Temporary URL created: ${accessUrl} (expires: ${tempUrl.expiresAt})`);

        return {
            ...tempUrl,
            accessUrl
        };
    }

    /**
     * Validate a permit token
     */
    validatePermit(permitToken, domainName = null) {
        if (!permitToken) return false;

        const permit = this.permits.get(permitToken);
        if (!permit) return false;

        // Check expiration
        if (Date.now() > new Date(permit.expiresAt).getTime()) {
            this.permits.delete(permitToken);
            return false;
        }

        // Check domain pattern
        if (domainName && !this.matchesDomainPattern(domainName, permit.domainPattern)) {
            return false;
        }

        // Update usage
        permit.usageCount++;
        permit.lastUsed = new Date().toISOString();

        return true;
    }

    /**
     * Validate a temporary URL token
     */
    validateTemporaryUrl(urlId, token) {
        const tempUrl = this.temporaryUrls.get(urlId);
        if (!tempUrl) return false;

        // Check token
        if (tempUrl.token !== token) return false;

        // Check expiration
        if (Date.now() > new Date(tempUrl.expiresAt).getTime()) {
            this.temporaryUrls.delete(urlId);
            return false;
        }

        // Check usage limit
        if (tempUrl.currentUses >= tempUrl.maxUses) {
            return false;
        }

        // Update usage
        tempUrl.currentUses++;
        tempUrl.accessLogs.push({
            timestamp: new Date().toISOString(),
            ip: 'unknown' // Would be filled by middleware
        });

        return tempUrl;
    }

    /**
     * Check DNS record existence
     */
    async checkDNSRecord(domain) {
        try {
            const result = await this.configManager.executeRemoteSSH(`nslookup ${domain}`);
            return !result.stderr.includes('NXDOMAIN') && result.stdout.includes('Address');
        } catch (error) {
            return false;
        }
    }

    /**
     * Check nginx configuration
     */
    async checkNginxConfig(domain) {
        try {
            // Check local nginx
            const localCheck = await this.configManager.executeLocalSudo(`grep -r "server_name.*${domain}" /usr/local/etc/nginx/ || echo "not found"`);
            if (localCheck.stdout && !localCheck.stdout.includes('not found')) {
                return true;
            }

            // Check remote nginx
            const remoteCheck = await this.configManager.executeRemoteSSH(`grep -r "server_name.*${domain}" /etc/nginx/ || echo "not found"`);
            if (remoteCheck.stdout && !remoteCheck.stdout.includes('not found')) {
                return true;
            }

            return false;
        } catch (error) {
            return false;
        }
    }

    /**
     * Generate access URL for domain
     */
    generateAccessUrl(domain) {
        const protocol = domain.sslEnabled ? 'https' : 'http';
        const port = domain.sslEnabled ? (domain.port === 443 ? '' : `:${domain.port}`) : (domain.port === 80 ? '' : `:${domain.port}`);
        return `${protocol}://${domain.fullDomain}${port}`;
    }

    /**
     * Helper functions
     */
    validateDomainRequest(request) {
        if (!request.subdomain || !request.targetPort || !request.clientId) {
            throw new Error('Missing required domain request parameters');
        }

        if (!request.subdomain.match(/^[a-z0-9-]+$/)) {
            throw new Error('Invalid subdomain format. Use lowercase letters, numbers, and hyphens only.');
        }
    }

    generateDomainId(fullDomain) {
        return crypto.createHash('sha256').update(fullDomain).digest('hex').substring(0, 16);
    }

    isPublicDomain(baseDomain) {
        return !baseDomain.endsWith('.local') && !baseDomain.startsWith('localhost');
    }

    matchesDomainPattern(domain, pattern) {
        if (pattern === '*') return true;
        if (pattern === domain) return true;

        // Simple wildcard matching
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        return regex.test(domain);
    }

    async createDefaultPermit(domain) {
        const permit = await this.createPermit({
            domainPattern: domain.fullDomain,
            clientId: domain.clientId,
            permissions: ['read', 'write', 'connect'],
            createdBy: 'auto-created'
        });

        domain.permits.push(permit.id);
        return permit;
    }

    cachedomainCheck(fullDomain, result) {
        this.domainChecks.set(fullDomain, {
            domain: result,
            exists: !!result,
            timestamp: Date.now()
        });
    }

    /**
     * Cleanup expired domains, permits, and URLs
     */
    startCleanupTimer() {
        setInterval(() => {
            this.cleanupExpiredItems();
        }, this.options.cleanupInterval);
    }

    cleanupExpiredItems() {
        const now = Date.now();

        // Clean up expired domains
        for (const [id, domain] of this.domains.entries()) {
            if (new Date(domain.expiresAt).getTime() < now) {
                console.log(`🗑️  Cleaning up expired domain: ${domain.fullDomain}`);
                this.configManager.releaseDomain(id).catch(console.error);
                this.domains.delete(id);
            }
        }

        // Clean up expired permits
        for (const [id, permit] of this.permits.entries()) {
            if (new Date(permit.expiresAt).getTime() < now) {
                console.log(`🗑️  Cleaning up expired permit: ${id}`);
                this.permits.delete(id);
            }
        }

        // Clean up expired temporary URLs
        for (const [id, tempUrl] of this.temporaryUrls.entries()) {
            if (new Date(tempUrl.expiresAt).getTime() < now) {
                console.log(`🗑️  Cleaning up expired temporary URL: ${id}`);
                this.temporaryUrls.delete(id);
            }
        }

        // Clean up domain check cache
        for (const [domain, check] of this.domainChecks.entries()) {
            if (now - check.timestamp > 30 * 60 * 1000) { // 30 minutes
                this.domainChecks.delete(domain);
            }
        }
    }

    /**
     * Get statistics and status
     */
    getStatus() {
        return {
            domains: {
                active: this.domains.size,
                byType: {
                    temporary: Array.from(this.domains.values()).filter(d => d.temporary).length,
                    permanent: Array.from(this.domains.values()).filter(d => !d.temporary).length,
                    local: Array.from(this.domains.values()).filter(d => d.baseDomain.endsWith('.local')).length,
                    public: Array.from(this.domains.values()).filter(d => !d.baseDomain.endsWith('.local')).length
                }
            },
            permits: {
                active: this.permits.size,
                expiringSoon: Array.from(this.permits.values()).filter(p =>
                    new Date(p.expiresAt).getTime() - Date.now() < 60 * 60 * 1000
                ).length
            },
            temporaryUrls: {
                active: this.temporaryUrls.size,
                unused: Array.from(this.temporaryUrls.values()).filter(u => u.currentUses === 0).length
            },
            cache: {
                domainChecks: this.domainChecks.size
            }
        };
    }
}

module.exports = DynamicDomainManager;