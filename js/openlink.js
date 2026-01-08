/**
 * OpenLink Web Application
 * Composr v10 Compatible JavaScript
 */

class OpenLinkApp {
    constructor() {
        this.apiBase = '/apps/OpenLink/api';
        this.currentUser = null;
        this.currentSection = 'shorten';
        this.links = [];
        
        this.init();
    }

    init() {
        this.setupEventListeners();
        this.loadStoredAuth();
        this.updateUI();
    }

    setupEventListeners() {
        // Navigation
        document.querySelectorAll('.nav-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const section = e.target.getAttribute('href').substring(1);
                this.switchSection(section);
            });
        });

        // Auth buttons
        document.getElementById('login-btn')?.addEventListener('click', () => {
            this.showModal('login');
        });

        document.getElementById('register-btn')?.addEventListener('click', () => {
            this.showModal('register');
        });

        // Modal controls
        document.querySelectorAll('.close-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const modal = e.target.getAttribute('data-modal');
                this.hideModal(modal);
            });
        });

        document.getElementById('switch-to-register')?.addEventListener('click', (e) => {
            e.preventDefault();
            this.hideModal('login');
            this.showModal('register');
        });

        document.getElementById('switch-to-login')?.addEventListener('click', (e) => {
            e.preventDefault();
            this.hideModal('register');
            this.showModal('login');
        });

        // Forms
        document.getElementById('shorten-form')?.addEventListener('submit', (e) => {
            e.preventDefault();
            this.shortenUrl();
        });

        document.getElementById('login-form')?.addEventListener('submit', (e) => {
            e.preventDefault();
            this.login();
        });

        document.getElementById('register-form')?.addEventListener('submit', (e) => {
            e.preventDefault();
            this.register();
        });

        // Advanced options toggle
        document.getElementById('toggle-advanced')?.addEventListener('click', () => {
            const options = document.getElementById('advanced-options');
            options.classList.toggle('show');
        });

        // Copy button
        document.getElementById('copy-btn')?.addEventListener('click', () => {
            this.copyToClipboard();
        });

        // Search and filters
        document.getElementById('search-links')?.addEventListener('input', (e) => {
            this.filterLinks(e.target.value);
        });

        document.getElementById('domain-filter')?.addEventListener('change', (e) => {
            this.filterLinksByDomain(e.target.value);
        });

        // Click outside modal to close
        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    modal.classList.remove('show');
                }
            });
        });
    }

    switchSection(section) {
        // Update nav
        document.querySelectorAll('.nav-link').forEach(link => {
            link.classList.remove('active');
        });
        document.querySelector(`[href="#${section}"]`).classList.add('active');

        // Update sections
        document.querySelectorAll('.section').forEach(sec => {
            sec.classList.remove('active');
        });
        document.getElementById(section).classList.add('active');

        this.currentSection = section;

        // Load section-specific data
        if (section === 'manage') {
            this.loadLinks();
        } else if (section === 'analytics') {
            this.loadAnalytics();
        }
    }

    showModal(modalId) {
        document.getElementById(`${modalId}-modal`).classList.add('show');
    }

    hideModal(modalId) {
        document.getElementById(`${modalId}-modal`).classList.remove('show');
    }

    async shortenUrl() {
        const form = document.getElementById('shorten-form');
        const originalUrl = document.getElementById('original-url').value;
        const customCode = document.getElementById('custom-code').value;
        const domain = document.getElementById('domain-select').value;
        const title = document.getElementById('link-title').value;
        const expiryDate = document.getElementById('expiry-date').value;

        if (!originalUrl) {
            this.showAlert('Please enter a URL to shorten', 'error');
            return;
        }

        const submitBtn = form.querySelector('button[type="submit"]');
        const originalText = submitBtn.innerHTML;
        submitBtn.innerHTML = '<span class="spinner"></span> Shortening...';
        submitBtn.disabled = true;

        try {
            const response = await this.apiCall('/links', 'POST', {
                originalUrl,
                customCode: customCode || undefined,
                domain,
                title: title || undefined,
                expiresAt: expiryDate || undefined
            });

            if (response.error) {
                throw new Error(response.error);
            }

            // Show result
            const resultSection = document.getElementById('result-section');
            const shortUrlInput = document.getElementById('short-url');
            shortUrlInput.value = `https://${response.domain}/${response.shortCode}`;
            resultSection.style.display = 'block';

            // Reset form
            form.reset();
            document.getElementById('advanced-options').classList.remove('show');

            this.showAlert('URL shortened successfully!', 'success');

        } catch (error) {
            this.showAlert(error.message || 'Failed to shorten URL', 'error');
        } finally {
            submitBtn.innerHTML = originalText;
            submitBtn.disabled = false;
        }
    }

    async login() {
        const username = document.getElementById('login-username').value;
        const password = document.getElementById('login-password').value;

        if (!username || !password) {
            this.showAlert('Please enter username and password', 'error');
            return;
        }

        const submitBtn = document.querySelector('#login-form button[type="submit"]');
        const originalText = submitBtn.innerHTML;
        submitBtn.innerHTML = '<span class="spinner"></span> Logging in...';
        submitBtn.disabled = true;

        try {
            const response = await this.apiCall('/auth/login', 'POST', {
                username,
                password
            });

            if (response.error) {
                throw new Error(response.error);
            }

            this.currentUser = response.user;
            localStorage.setItem('openlink_token', response.token);
            localStorage.setItem('openlink_user', JSON.stringify(response.user));

            this.hideModal('login');
            this.updateUI();
            this.showAlert('Logged in successfully!', 'success');

        } catch (error) {
            this.showAlert(error.message || 'Login failed', 'error');
        } finally {
            submitBtn.innerHTML = originalText;
            submitBtn.disabled = false;
        }
    }

    async register() {
        const username = document.getElementById('reg-username').value;
        const email = document.getElementById('reg-email').value;
        const password = document.getElementById('reg-password').value;
        const domain = document.getElementById('reg-domain').value;

        if (!username || !email || !password) {
            this.showAlert('Please fill in all required fields', 'error');
            return;
        }

        const submitBtn = document.querySelector('#register-form button[type="submit"]');
        const originalText = submitBtn.innerHTML;
        submitBtn.innerHTML = '<span class="spinner"></span> Creating account...';
        submitBtn.disabled = true;

        try {
            const response = await this.apiCall('/auth/register', 'POST', {
                username,
                email,
                password,
                domain
            });

            if (response.error) {
                throw new Error(response.error);
            }

            this.hideModal('register');
            this.showModal('login');
            this.showAlert('Account created successfully! Please log in.', 'success');

            // Pre-fill login form
            document.getElementById('login-username').value = username;

        } catch (error) {
            this.showAlert(error.message || 'Registration failed', 'error');
        } finally {
            submitBtn.innerHTML = originalText;
            submitBtn.disabled = false;
        }
    }

    async loadLinks() {
        if (!this.currentUser) {
            document.getElementById('links-list').innerHTML = '<p>Please log in to manage your links.</p>';
            return;
        }

        try {
            const response = await this.apiCall('/links', 'GET');
            
            if (response.error) {
                throw new Error(response.error);
            }

            this.links = Array.isArray(response) ? response : response.links || [];
            this.renderLinks();

        } catch (error) {
            document.getElementById('links-list').innerHTML = `<p>Error loading links: ${error.message}</p>`;
        }
    }

    renderLinks(filteredLinks = null) {
        const linksList = document.getElementById('links-list');
        const linksToRender = filteredLinks || this.links;

        if (linksToRender.length === 0) {
            linksList.innerHTML = '<p>No links found.</p>';
            return;
        }

        linksList.innerHTML = linksToRender.map(link => `
            <div class="link-row">
                <div class="col-short">
                    <a href="https://${link.domain}/${link.shortCode}" target="_blank">
                        ${link.domain}/${link.shortCode}
                    </a>
                </div>
                <div class="col-original">
                    <a href="${link.originalUrl}" target="_blank" title="${link.originalUrl}">
                        ${this.truncateUrl(link.originalUrl, 50)}
                    </a>
                </div>
                <div class="col-clicks">${link.clickCount || 0}</div>
                <div class="col-created">${this.formatDate(link.createdAt)}</div>
                <div class="col-actions">
                    <div class="link-actions">
                        <button class="btn btn-outline btn-sm" onclick="openLinkApp.editLink('${link.id}')">
                            <i class="fas fa-edit"></i>
                        </button>
                        <button class="btn btn-outline btn-sm" onclick="openLinkApp.viewStats('${link.id}')">
                            <i class="fas fa-chart-bar"></i>
                        </button>
                        <button class="btn btn-outline btn-sm" onclick="openLinkApp.deleteLink('${link.id}')">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </div>
            </div>
        `).join('');
    }

    async loadAnalytics() {
        if (!this.currentUser) {
            return;
        }

        try {
            const response = await this.apiCall('/links', 'GET');
            
            if (!response.error && Array.isArray(response)) {
                const links = response;
                
                // Calculate stats
                const totalLinks = links.length;
                const totalClicks = links.reduce((sum, link) => sum + (link.clickCount || 0), 0);
                const avgClicks = totalLinks > 0 ? Math.round(totalClicks / totalLinks) : 0;
                const todayClicks = 0; // Would need additional API endpoint

                // Update stats display
                document.getElementById('total-links').textContent = totalLinks;
                document.getElementById('total-clicks').textContent = totalClicks;
                document.getElementById('avg-clicks').textContent = avgClicks;
                document.getElementById('today-clicks').textContent = todayClicks;
            }

        } catch (error) {
            console.error('Error loading analytics:', error);
        }
    }

    filterLinks(searchTerm) {
        if (!searchTerm) {
            this.renderLinks();
            return;
        }

        const filtered = this.links.filter(link => 
            link.shortCode.toLowerCase().includes(searchTerm.toLowerCase()) ||
            link.originalUrl.toLowerCase().includes(searchTerm.toLowerCase()) ||
            (link.title && link.title.toLowerCase().includes(searchTerm.toLowerCase()))
        );

        this.renderLinks(filtered);
    }

    filterLinksByDomain(domain) {
        if (!domain) {
            this.renderLinks();
            return;
        }

        const filtered = this.links.filter(link => link.domain === domain);
        this.renderLinks(filtered);
    }

    async deleteLink(linkId) {
        if (!confirm('Are you sure you want to delete this link?')) {
            return;
        }

        try {
            const response = await this.apiCall(`/links/${linkId}`, 'DELETE');
            
            if (response.error) {
                throw new Error(response.error);
            }

            this.showAlert('Link deleted successfully!', 'success');
            this.loadLinks(); // Reload links

        } catch (error) {
            this.showAlert(error.message || 'Failed to delete link', 'error');
        }
    }

    copyToClipboard() {
        const shortUrlInput = document.getElementById('short-url');
        shortUrlInput.select();
        document.execCommand('copy');
        
        const copyBtn = document.getElementById('copy-btn');
        const originalText = copyBtn.innerHTML;
        copyBtn.innerHTML = '<i class="fas fa-check"></i> Copied!';
        
        setTimeout(() => {
            copyBtn.innerHTML = originalText;
        }, 2000);
    }

    loadStoredAuth() {
        const token = localStorage.getItem('openlink_token');
        const user = localStorage.getItem('openlink_user');
        
        if (token && user) {
            this.currentUser = JSON.parse(user);
            this.updateUI();
        }
    }

    updateUI() {
        const loginBtn = document.getElementById('login-btn');
        const registerBtn = document.getElementById('register-btn');
        const authButtons = document.querySelector('.auth-buttons');

        if (this.currentUser) {
            authButtons.innerHTML = `
                <span>Welcome, ${this.currentUser.username}!</span>
                <button id="logout-btn" class="btn btn-outline">Logout</button>
            `;
            
            document.getElementById('logout-btn').addEventListener('click', () => {
                this.logout();
            });
        } else {
            authButtons.innerHTML = `
                <button id="login-btn" class="btn btn-outline">Login</button>
                <button id="register-btn" class="btn btn-primary">Sign Up</button>
            `;
            
            // Re-attach event listeners
            document.getElementById('login-btn').addEventListener('click', () => {
                this.showModal('login');
            });

            document.getElementById('register-btn').addEventListener('click', () => {
                this.showModal('register');
            });
        }
    }

    logout() {
        this.currentUser = null;
        localStorage.removeItem('openlink_token');
        localStorage.removeItem('openlink_user');
        this.updateUI();
        this.showAlert('Logged out successfully!', 'success');
        
        // Switch to shorten section
        this.switchSection('shorten');
    }

    async apiCall(endpoint, method = 'GET', data = null) {
        const token = localStorage.getItem('openlink_token');
        
        const options = {
            method,
            headers: {
                'Content-Type': 'application/json',
            }
        };

        if (token) {
            options.headers.Authorization = `Bearer ${token}`;
        }

        if (data) {
            options.body = JSON.stringify(data);
        }

        try {
            const response = await fetch(`${this.apiBase}${endpoint}`, options);
            return await response.json();
        } catch (error) {
            console.error('API call failed:', error);
            throw error;
        }
    }

    showAlert(message, type = 'info') {
        // Remove existing alerts
        document.querySelectorAll('.alert').forEach(alert => alert.remove());

        const alert = document.createElement('div');
        alert.className = `alert alert-${type}`;
        alert.textContent = message;

        // Insert at the top of the main content
        const mainContent = document.querySelector('.main-content');
        mainContent.insertBefore(alert, mainContent.firstChild);

        // Auto remove after 5 seconds
        setTimeout(() => {
            alert.remove();
        }, 5000);
    }

    truncateUrl(url, maxLength) {
        if (url.length <= maxLength) return url;
        return url.substring(0, maxLength) + '...';
    }

    formatDate(dateString) {
        const date = new Date(dateString);
        return date.toLocaleDateString();
    }

    // Placeholder methods for future implementation
    async editLink(linkId) {
        console.log('Edit link:', linkId);
        // TODO: Implement edit link functionality
    }

    async viewStats(linkId) {
        console.log('View stats:', linkId);
        // TODO: Implement stats view
    }
}

// Initialize the application when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.openLinkApp = new OpenLinkApp();
});