#!/usr/bin/env node

/**
 * SSL Certificate Manager for OpenLink Domains
 * Automatically requests and manages SSL certificates for all OpenLink domains
 */

const { exec } = require('child_process');
const path = require('path');
const fs = require('fs').promises;

class SSLManager {
    constructor() {
        this.domains = [
            'raywonderis.me',
            'tappedin.fm',
            'devinecreations.net',
            'devine-creations.com',
            'walterharper.com',
            'tetoeehoward.com'
        ];

        this.serverConfig = {
            host: '64.20.46.178',
            port: 450,
            user: 'root',
            keyPath: path.join(process.env.HOME, '.ssh/raywonder')
        };

        this.email = 'webmaster@devine-creations.com';
    }

    /**
     * Execute SSH command on server
     */
    async executeSSH(command) {
        return new Promise((resolve, reject) => {
            const sshCmd = `ssh -p ${this.serverConfig.port} -i ${this.serverConfig.keyPath} -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${this.serverConfig.user}@${this.serverConfig.host} "${command.replace(/"/g, '\\"')}"`;

            exec(sshCmd, { timeout: 60000 }, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(`SSH Error: ${stderr || error.message}`));
                } else {
                    resolve(stdout.trim());
                }
            });
        });
    }

    /**
     * Check if domain points to our server
     */
    async checkDNS(domain) {
        try {
            const result = await this.executeSSH(`nslookup ${domain}`);
            return result.includes(this.serverConfig.host);
        } catch (error) {
            console.warn(`⚠️ DNS check failed for ${domain}: ${error.message}`);
            return false;
        }
    }

    /**
     * Check current certificate status
     */
    async checkCertificate(domain) {
        try {
            const result = await this.executeSSH(`openssl x509 -in /etc/letsencrypt/live/openlink.${domain}/fullchain.pem -noout -dates 2>/dev/null || echo "No certificate found"`);

            if (result.includes('No certificate found')) {
                return { exists: false, valid: false, message: 'No certificate found' };
            }

            const expiryMatch = result.match(/notAfter=(.+)/);
            if (expiryMatch) {
                const expiryDate = new Date(expiryMatch[1]);
                const now = new Date();
                const daysLeft = Math.floor((expiryDate - now) / (1000 * 60 * 60 * 24));

                return {
                    exists: true,
                    valid: daysLeft > 0,
                    daysLeft,
                    expiryDate,
                    message: daysLeft > 30 ? `Valid (${daysLeft} days left)` : `Expires soon (${daysLeft} days)`
                };
            }

            return { exists: true, valid: false, message: 'Could not parse certificate' };
        } catch (error) {
            return { exists: false, valid: false, message: `Check failed: ${error.message}` };
        }
    }

    /**
     * Request SSL certificate for a domain using certbot
     */
    async requestCertificate(domain) {
        console.log(`🔒 Requesting SSL certificate for openlink.${domain}...`);

        try {
            // Check DNS first
            console.log(`🔍 Checking DNS for openlink.${domain}...`);
            const dnsOk = await this.checkDNS(`openlink.${domain}`);
            if (!dnsOk) {
                throw new Error(`DNS check failed: openlink.${domain} does not point to server`);
            }
            console.log(`✅ DNS check passed for openlink.${domain}`);

            // Ensure webroot directory exists
            await this.executeSSH(`mkdir -p /home/dom/public_html/.well-known/acme-challenge`);
            await this.executeSSH(`chown -R dom:dom /home/dom/public_html/.well-known`);

            // Stop any existing nginx to free up port 80 temporarily
            console.log(`⏸️ Temporarily stopping nginx...`);
            await this.executeSSH('systemctl stop nginx');

            try {
                // Use certbot standalone mode for reliability
                const certbotCmd = `certbot certonly --standalone --preferred-challenges http -d openlink.${domain} --non-interactive --agree-tos --email ${this.email} --expand`;
                console.log(`📋 Running: ${certbotCmd}`);

                const result = await this.executeSSH(certbotCmd);
                console.log(`📄 Certbot output: ${result}`);

                if (result.includes('Successfully received certificate') || result.includes('Certificate not yet due for renewal')) {
                    console.log(`✅ SSL certificate obtained for openlink.${domain}`);
                    return { success: true, domain, message: 'Certificate obtained successfully' };
                } else {
                    throw new Error(`Certbot failed: ${result}`);
                }
            } finally {
                // Always restart nginx
                console.log(`▶️ Restarting nginx...`);
                await this.executeSSH('systemctl start nginx');
            }

        } catch (error) {
            console.error(`❌ SSL request failed for openlink.${domain}: ${error.message}`);

            // Ensure nginx is running
            try {
                await this.executeSSH('systemctl start nginx');
            } catch (nginxError) {
                console.error(`❌ Failed to restart nginx: ${nginxError.message}`);
            }

            return { success: false, domain, error: error.message };
        }
    }

    /**
     * Update nginx configuration for SSL domain
     */
    async updateNginxConfig(domain) {
        console.log(`🔧 Updating nginx configuration for openlink.${domain}...`);

        // Get the SSL certificate path
        const sslCertPath = `/etc/letsencrypt/live/openlink.${domain}`;

        // Check if certificates exist
        try {
            await this.executeSSH(`test -f ${sslCertPath}/fullchain.pem && test -f ${sslCertPath}/privkey.pem`);
        } catch (error) {
            throw new Error(`SSL certificates not found at ${sslCertPath}`);
        }

        // Update the main nginx config to include this domain
        const nginxConfigUpdate = `
# Update SSL configuration for openlink.${domain}
# Add to existing server block for domain ${domain}

# Find and update the server block for openlink.${domain}
sed -i '/server_name.*openlink\\.${domain}/,/}/ {
    /ssl_certificate[^_]/c\\    ssl_certificate ${sslCertPath}/fullchain.pem;
    /ssl_certificate_key/c\\    ssl_certificate_key ${sslCertPath}/privkey.pem;
}' /etc/nginx/conf.d/openlink.raywonderis.me.conf
`;

        await this.executeSSH(nginxConfigUpdate);

        // Test nginx configuration
        await this.executeSSH('nginx -t');

        // Reload nginx
        await this.executeSSH('systemctl reload nginx');

        console.log(`✅ Nginx configuration updated for openlink.${domain}`);
    }

    /**
     * Renew all certificates
     */
    async renewCertificates() {
        console.log('🔄 Renewing SSL certificates...');

        try {
            // Stop nginx temporarily
            await this.executeSSH('systemctl stop nginx');

            // Run certbot renewal
            const result = await this.executeSSH('certbot renew --standalone --preferred-challenges http');
            console.log(`📄 Renewal result: ${result}`);

            // Restart nginx
            await this.executeSSH('systemctl start nginx');

            console.log('✅ Certificate renewal completed');
            return { success: true, message: 'Certificates renewed successfully' };
        } catch (error) {
            // Ensure nginx is started
            try {
                await this.executeSSH('systemctl start nginx');
            } catch (nginxError) {
                console.error(`❌ Failed to restart nginx: ${nginxError.message}`);
            }

            console.error(`❌ Certificate renewal failed: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    /**
     * Check status of all SSL certificates
     */
    async checkAllCertificates() {
        console.log('🔍 Checking SSL certificate status for all domains...\n');

        const results = [];

        for (const domain of this.domains) {
            console.log(`🔍 Checking openlink.${domain}...`);

            const status = await this.checkCertificate(domain);
            results.push({ domain, ...status });

            const statusIcon = status.valid ? '✅' : '❌';
            console.log(`${statusIcon} openlink.${domain}: ${status.message}`);
        }

        return results;
    }

    /**
     * Request certificates for all domains that need them
     */
    async setupAllCertificates() {
        console.log('🚀 Setting up SSL certificates for all OpenLink domains...\n');

        const statuses = await this.checkAllCertificates();
        const needsCerts = statuses.filter(s => !s.valid);

        if (needsCerts.length === 0) {
            console.log('✅ All certificates are valid!');
            return;
        }

        console.log(`\n🔧 ${needsCerts.length} domains need new certificates...\n`);

        for (const { domain } of needsCerts) {
            const result = await this.requestCertificate(domain);

            if (result.success) {
                try {
                    await this.updateNginxConfig(domain);
                    console.log(`✅ Complete setup for openlink.${domain}\n`);
                } catch (error) {
                    console.error(`⚠️ Certificate obtained but nginx update failed for ${domain}: ${error.message}\n`);
                }
            } else {
                console.error(`❌ Failed to obtain certificate for openlink.${domain}\n`);
            }

            // Wait a bit between requests to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        console.log('🎉 SSL certificate setup completed!');
        console.log('🔄 Run certificate check again to verify all are working.');
    }

    /**
     * Setup automatic renewal
     */
    async setupAutoRenewal() {
        console.log('⏰ Setting up automatic SSL certificate renewal...');

        const cronJob = '0 3 * * 0 /usr/bin/certbot renew --standalone --preferred-challenges http --pre-hook "systemctl stop nginx" --post-hook "systemctl start nginx" >> /var/log/certbot-renewal.log 2>&1';

        try {
            // Add cron job for automatic renewal
            await this.executeSSH(`(crontab -l 2>/dev/null; echo "${cronJob}") | crontab -`);
            console.log('✅ Automatic renewal cron job installed');
            console.log('📅 Certificates will auto-renew weekly on Sundays at 3 AM');

            return { success: true, message: 'Auto-renewal configured' };
        } catch (error) {
            console.error(`❌ Failed to setup auto-renewal: ${error.message}`);
            return { success: false, error: error.message };
        }
    }
}

// CLI Interface
async function main() {
    const sslManager = new SSLManager();
    const args = process.argv.slice(2);
    const command = args[0];
    const param = args[1];

    switch (command) {
        case 'check':
            await sslManager.checkAllCertificates();
            break;

        case 'request':
            if (!param) {
                console.error('❌ Usage: node ssl-manager.js request <domain>');
                console.log('Available domains:', sslManager.domains.join(', '));
                process.exit(1);
            }
            if (!sslManager.domains.includes(param)) {
                console.error(`❌ Unknown domain: ${param}`);
                console.log('Available domains:', sslManager.domains.join(', '));
                process.exit(1);
            }
            await sslManager.requestCertificate(param);
            break;

        case 'setup':
            await sslManager.setupAllCertificates();
            break;

        case 'renew':
            await sslManager.renewCertificates();
            break;

        case 'auto':
            await sslManager.setupAutoRenewal();
            break;

        default:
            console.log(`
🔒 SSL Certificate Manager for OpenLink

Usage:
  node ssl-manager.js check                    - Check all certificate status
  node ssl-manager.js request <domain>         - Request certificate for specific domain
  node ssl-manager.js setup                    - Setup certificates for all domains
  node ssl-manager.js renew                    - Renew all certificates
  node ssl-manager.js auto                     - Setup automatic renewal

Examples:
  node ssl-manager.js check                    - Check all certificates
  node ssl-manager.js request devine-creations.com
  node ssl-manager.js setup                    - Fix all SSL issues automatically

Available domains: ${sslManager.domains.join(', ')}
            `);
            break;
    }
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = SSLManager;