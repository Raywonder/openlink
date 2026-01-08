/**
 * OpenLink API Connector
 * Links all OpenLink features to shared backend API
 */

class OpenLinkAPI {
    constructor() {
        this.baseURL = 'https://openlink.tappedin.fm/api';
        this.sessionToken = localStorage.getItem('openlink_token') || null;
        this.currentUser = JSON.parse(localStorage.getItem('openlink_user') || 'null');
    }

    /**
     * Account Management
     */
    async register(email, username, password) {
        const response = await fetch(`${this.baseURL}/accounts/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, username, password })
        });
        
        const data = await response.json();
        if (data.success) {
            this.sessionToken = data.sessionToken;
            this.currentUser = data.account;
            this.saveSession();
        }
        return data;
    }

    async login(emailOrUsername, password) {
        const response = await fetch(`${this.baseURL}/accounts/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ emailOrUsername, password })
        });
        
        const data = await response.json();
        if (data.success) {
            this.sessionToken = data.sessionToken;
            this.currentUser = data.account;
            this.saveSession();
        }
        return data;
    }

    logout() {
        this.sessionToken = null;
        this.currentUser = null;
        localStorage.removeItem('openlink_token');
        localStorage.removeItem('openlink_user');
    }

    saveSession() {
        localStorage.setItem('openlink_token', this.sessionToken);
        localStorage.setItem('openlink_user', JSON.stringify(this.currentUser));
    }

    /**
     * DynDNS Management
     */
    async createDynDNS(subdomain, domain, externalIP = null) {
        return await this.authRequest('/dyndns/create', 'POST', {
            userId: this.currentUser.userId,
            subdomain,
            domain,
            externalIP
        });
    }

    async updateDynDNS(subdomain, domain, newIP = null) {
        return await this.authRequest('/dyndns/update', 'PUT', {
            userId: this.currentUser.userId,
            subdomain,
            domain,
            newIP
        });
    }

    async deleteDynDNS(subdomain, domain) {
        return await this.authRequest(`/dyndns/${subdomain}/${domain}`, 'DELETE', {
            userId: this.currentUser.userId
        });
    }

    async listDynDNS() {
        return await this.authRequest(`/dyndns/list/${this.currentUser.userId}`);
    }

    async getMyIP() {
        const response = await fetch(`${this.baseURL}/dyndns/myip`);
        return await response.json();
    }

    /**
     * File Sharing (placeholder for future implementation)
     */
    async uploadFile(file, metadata = {}) {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('metadata', JSON.stringify(metadata));
        formData.append('userId', this.currentUser.userId);

        const response = await fetch(`${this.baseURL}/files/upload`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${this.sessionToken}` },
            body: formData
        });

        return await response.json();
    }

    async shareFile(fileId, expiresIn = 86400) {
        return await this.authRequest('/files/share', 'POST', {
            fileId,
            expiresIn,
            userId: this.currentUser.userId
        });
    }

    /**
     * Remote Desktop (placeholder for future WebSocket implementation)
     */
    connectRemoteDesktop(targetUserId) {
        const wsURL = `wss://openlink.tappedin.fm/api/remote?token=${this.sessionToken}&target=${targetUserId}`;
        return new WebSocket(wsURL);
    }

    /**
     * Admin Functions
     */
    async restartService(service = 'both') {
        return await this.authRequest('/admin/restart', 'POST', { service });
    }

    async getServiceStatus() {
        return await this.authRequest('/admin/status');
    }

    async getSystemStats() {
        return await this.authRequest('/admin/stats/system');
    }

    async getAccountStats() {
        return await this.authRequest('/accounts/admin/stats');
    }

    async backupDatabases() {
        return await this.authRequest('/admin/backup', 'POST');
    }

    /**
     * Helper Methods
     */
    async authRequest(endpoint, method = 'GET', body = null) {
        const options = {
            method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.sessionToken}`
            }
        };

        if (body) {
            options.body = JSON.stringify(body);
        }

        const response = await fetch(`${this.baseURL}${endpoint}`, options);
        return await response.json();
    }

    isAuthenticated() {
        return this.sessionToken !== null && this.currentUser !== null;
    }

    getCurrentUser() {
        return this.currentUser;
    }
}

// Global instance
window.OpenLink = new OpenLinkAPI();
