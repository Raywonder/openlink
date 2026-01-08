/**
 * OpenLink Server - Web Admin UI
 *
 * Provides a web-based dashboard for managing OpenLink relay server
 */

const http = require('http');
const url = require('url');
const path = require('path');

class ServerWebUI {
    constructor(relayHost, port = 8080) {
        this.relayHost = relayHost;
        this.port = port;
        this.server = null;
    }

    start() {
        this.server = http.createServer((req, res) => {
            this.handleRequest(req, res);
        });

        this.server.listen(this.port, () => {
            console.log(`OpenLink Server Web UI running at http://localhost:${this.port}`);
        });

        return this;
    }

    stop() {
        if (this.server) {
            this.server.close();
            this.server = null;
        }
    }

    handleRequest(req, res) {
        const parsedUrl = url.parse(req.url, true);
        const pathname = parsedUrl.pathname;

        // Set CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }

        // API Routes
        if (pathname.startsWith('/api/')) {
            return this.handleAPI(req, res, pathname, parsedUrl.query);
        }

        // Static routes
        switch (pathname) {
            case '/':
            case '/index.html':
                return this.sendDashboard(res);
            case '/style.css':
                return this.sendCSS(res);
            case '/script.js':
                return this.sendJS(res);
            default:
                res.writeHead(404);
                res.end('Not Found');
        }
    }

    handleAPI(req, res, pathname, query) {
        res.setHeader('Content-Type', 'application/json');

        try {
            switch (pathname) {
                case '/api/status':
                    return this.sendJSON(res, this.getStatus());

                case '/api/sessions':
                    return this.sendJSON(res, this.getSessions());

                case '/api/config':
                    if (req.method === 'GET') {
                        return this.sendJSON(res, this.getConfig());
                    } else if (req.method === 'POST') {
                        return this.updateConfig(req, res);
                    }
                    break;

                case '/api/clients':
                    return this.sendJSON(res, this.getClients());

                case '/api/ban':
                    if (req.method === 'POST') {
                        return this.banClient(req, res);
                    }
                    break;

                case '/api/kick':
                    if (req.method === 'POST') {
                        return this.kickClient(req, res);
                    }
                    break;

                case '/api/reports':
                    return this.sendJSON(res, this.getReports());

                default:
                    res.writeHead(404);
                    return res.end(JSON.stringify({ error: 'API endpoint not found' }));
            }
        } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: err.message }));
        }
    }

    sendJSON(res, data) {
        res.writeHead(200);
        res.end(JSON.stringify(data, null, 2));
    }

    getStatus() {
        if (!this.relayHost) {
            return { running: false, error: 'Relay host not initialized' };
        }

        return {
            running: this.relayHost.running,
            port: this.relayHost.port,
            isPublic: this.relayHost.config.isPublic,
            accessMode: this.relayHost.config.accessMode,
            hostname: this.relayHost.config.hostname,
            uptime: this.relayHost.startTime ? Date.now() - this.relayHost.startTime : 0,
            sessionCount: this.relayHost.sessions ? this.relayHost.sessions.size : 0,
            clientCount: this.relayHost.clients ? this.relayHost.clients.size : 0,
            verification: this.relayHost.config.verification
        };
    }

    getSessions() {
        if (!this.relayHost || !this.relayHost.sessions) {
            return [];
        }

        return Array.from(this.relayHost.sessions.entries()).map(([id, session]) => ({
            id,
            hostId: session.hostId,
            clientId: session.clientId,
            created: session.created,
            lastActivity: session.lastActivity
        }));
    }

    getConfig() {
        if (!this.relayHost) {
            return {};
        }

        return {
            isPublic: this.relayHost.config.isPublic,
            requireAuth: this.relayHost.config.requireAuth,
            accessMode: this.relayHost.config.accessMode,
            twoFactorEnabled: this.relayHost.config.twoFactorEnabled,
            requireConnectionPin: this.relayHost.config.requireConnectionPin,
            hostname: this.relayHost.config.hostname,
            verification: this.relayHost.config.verification
        };
    }

    async updateConfig(req, res) {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const config = JSON.parse(body);

                // Update allowed config options
                if (config.isPublic !== undefined) {
                    this.relayHost.config.isPublic = config.isPublic;
                }
                if (config.accessMode !== undefined) {
                    this.relayHost.config.accessMode = config.accessMode;
                }
                if (config.hostname !== undefined) {
                    this.relayHost.config.hostname = config.hostname;
                }
                if (config.requireConnectionPin !== undefined) {
                    this.relayHost.config.requireConnectionPin = config.requireConnectionPin;
                }

                this.sendJSON(res, { success: true, config: this.getConfig() });
            } catch (err) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
    }

    getClients() {
        if (!this.relayHost || !this.relayHost.clients) {
            return [];
        }

        return Array.from(this.relayHost.clients.entries()).map(([id, client]) => ({
            id,
            type: client.type,
            connected: client.connected,
            ip: client.ip,
            authenticated: client.authenticated
        }));
    }

    async banClient(req, res) {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { clientId, reason } = JSON.parse(body);
                // Add to banned list
                if (this.relayHost.bannedClients) {
                    this.relayHost.bannedClients.add(clientId);
                }
                this.sendJSON(res, { success: true, banned: clientId });
            } catch (err) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Invalid request' }));
            }
        });
    }

    async kickClient(req, res) {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { clientId } = JSON.parse(body);
                // Find and disconnect client
                if (this.relayHost.clients && this.relayHost.clients.has(clientId)) {
                    const client = this.relayHost.clients.get(clientId);
                    if (client.ws) {
                        client.ws.close();
                    }
                    this.relayHost.clients.delete(clientId);
                }
                this.sendJSON(res, { success: true, kicked: clientId });
            } catch (err) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Invalid request' }));
            }
        });
    }

    getReports() {
        // This would integrate with HostTrustManager
        return {
            totalReports: 0,
            bannedHosts: [],
            recentReports: []
        };
    }

    sendDashboard(res) {
        res.setHeader('Content-Type', 'text/html');
        res.writeHead(200);
        res.end(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>OpenLink Server Admin</title>
    <link rel="stylesheet" href="/style.css">
</head>
<body>
    <header>
        <h1>OpenLink Server Admin</h1>
        <span id="status-indicator" class="status offline">Offline</span>
    </header>

    <main>
        <section id="status-panel" class="panel">
            <h2>Server Status</h2>
            <div class="status-grid">
                <div class="stat">
                    <label>Running</label>
                    <span id="stat-running">-</span>
                </div>
                <div class="stat">
                    <label>Port</label>
                    <span id="stat-port">-</span>
                </div>
                <div class="stat">
                    <label>Public</label>
                    <span id="stat-public">-</span>
                </div>
                <div class="stat">
                    <label>Access Mode</label>
                    <span id="stat-access-mode">-</span>
                </div>
                <div class="stat">
                    <label>Sessions</label>
                    <span id="stat-sessions">0</span>
                </div>
                <div class="stat">
                    <label>Clients</label>
                    <span id="stat-clients">0</span>
                </div>
                <div class="stat">
                    <label>Uptime</label>
                    <span id="stat-uptime">-</span>
                </div>
            </div>
        </section>

        <section id="config-panel" class="panel">
            <h2>Configuration</h2>
            <form id="config-form">
                <div class="form-group">
                    <label for="hostname">Hostname</label>
                    <input type="text" id="hostname" name="hostname" placeholder="my-openlink-server">
                </div>
                <div class="form-group">
                    <label for="access-mode">Access Mode</label>
                    <select id="access-mode" name="accessMode">
                        <option value="public">Public</option>
                        <option value="pin">PIN Code</option>
                        <option value="password">Password</option>
                        <option value="2fa">Two-Factor Auth</option>
                        <option value="whitelist">Whitelist Only</option>
                    </select>
                </div>
                <div class="form-group checkbox">
                    <input type="checkbox" id="is-public" name="isPublic">
                    <label for="is-public">Allow public discovery</label>
                </div>
                <div class="form-group checkbox">
                    <input type="checkbox" id="require-pin" name="requireConnectionPin">
                    <label for="require-pin">Require connection PIN</label>
                </div>
                <button type="submit" class="btn primary">Save Changes</button>
            </form>
        </section>

        <section id="clients-panel" class="panel">
            <h2>Connected Clients</h2>
            <table id="clients-table">
                <thead>
                    <tr>
                        <th>ID</th>
                        <th>Type</th>
                        <th>IP</th>
                        <th>Auth</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody id="clients-body">
                    <tr><td colspan="5">No clients connected</td></tr>
                </tbody>
            </table>
        </section>

        <section id="sessions-panel" class="panel">
            <h2>Active Sessions</h2>
            <table id="sessions-table">
                <thead>
                    <tr>
                        <th>Session ID</th>
                        <th>Host</th>
                        <th>Client</th>
                        <th>Created</th>
                        <th>Activity</th>
                    </tr>
                </thead>
                <tbody id="sessions-body">
                    <tr><td colspan="5">No active sessions</td></tr>
                </tbody>
            </table>
        </section>

        <section id="verification-panel" class="panel">
            <h2>Host Verification</h2>
            <div id="verification-info">
                <p>Verification helps users know they can trust your server.</p>
                <div id="trust-score"></div>
                <div id="verification-links"></div>
            </div>
        </section>
    </main>

    <footer>
        <p>OpenLink Server Admin v1.0.0</p>
    </footer>

    <script src="/script.js"></script>
</body>
</html>`);
    }

    sendCSS(res) {
        res.setHeader('Content-Type', 'text/css');
        res.writeHead(200);
        res.end(`
:root {
    --bg-color: #1a1a2e;
    --panel-bg: #16213e;
    --accent: #0f3460;
    --primary: #e94560;
    --text: #eee;
    --text-secondary: #aaa;
    --success: #00d26a;
    --warning: #f9c846;
    --danger: #e94560;
}

* {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
}

body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
    background: var(--bg-color);
    color: var(--text);
    line-height: 1.6;
}

header {
    background: var(--panel-bg);
    padding: 1rem 2rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 2px solid var(--accent);
}

header h1 {
    font-size: 1.5rem;
}

.status {
    padding: 0.5rem 1rem;
    border-radius: 20px;
    font-size: 0.875rem;
    font-weight: 600;
}

.status.online {
    background: var(--success);
    color: #000;
}

.status.offline {
    background: var(--danger);
    color: #fff;
}

main {
    padding: 2rem;
    max-width: 1400px;
    margin: 0 auto;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
    gap: 1.5rem;
}

.panel {
    background: var(--panel-bg);
    border-radius: 8px;
    padding: 1.5rem;
    border: 1px solid var(--accent);
}

.panel h2 {
    margin-bottom: 1rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--accent);
    font-size: 1.1rem;
}

.status-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
    gap: 1rem;
}

.stat {
    text-align: center;
}

.stat label {
    display: block;
    font-size: 0.75rem;
    color: var(--text-secondary);
    margin-bottom: 0.25rem;
}

.stat span {
    font-size: 1.25rem;
    font-weight: 600;
}

.form-group {
    margin-bottom: 1rem;
}

.form-group label {
    display: block;
    margin-bottom: 0.5rem;
    color: var(--text-secondary);
    font-size: 0.875rem;
}

.form-group input[type="text"],
.form-group select {
    width: 100%;
    padding: 0.75rem;
    background: var(--bg-color);
    border: 1px solid var(--accent);
    border-radius: 4px;
    color: var(--text);
    font-size: 1rem;
}

.form-group.checkbox {
    display: flex;
    align-items: center;
    gap: 0.5rem;
}

.form-group.checkbox label {
    margin-bottom: 0;
}

.btn {
    padding: 0.75rem 1.5rem;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 1rem;
    font-weight: 500;
    transition: opacity 0.2s;
}

.btn:hover {
    opacity: 0.9;
}

.btn.primary {
    background: var(--primary);
    color: white;
}

.btn.danger {
    background: var(--danger);
    color: white;
}

.btn.small {
    padding: 0.4rem 0.8rem;
    font-size: 0.875rem;
}

table {
    width: 100%;
    border-collapse: collapse;
}

th, td {
    padding: 0.75rem;
    text-align: left;
    border-bottom: 1px solid var(--accent);
}

th {
    color: var(--text-secondary);
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.5px;
}

tbody tr:hover {
    background: rgba(255,255,255,0.05);
}

footer {
    text-align: center;
    padding: 2rem;
    color: var(--text-secondary);
    font-size: 0.875rem;
}

#trust-score {
    font-size: 2rem;
    font-weight: bold;
    margin: 1rem 0;
}

@media (max-width: 768px) {
    main {
        grid-template-columns: 1fr;
        padding: 1rem;
    }

    header {
        flex-direction: column;
        gap: 1rem;
        text-align: center;
    }
}`);
    }

    sendJS(res) {
        res.setHeader('Content-Type', 'application/javascript');
        res.writeHead(200);
        res.end(`
// OpenLink Server Admin UI Script

const API_BASE = '';

async function fetchJSON(endpoint, options = {}) {
    const response = await fetch(API_BASE + endpoint, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...options.headers
        }
    });
    return response.json();
}

async function refreshStatus() {
    try {
        const status = await fetchJSON('/api/status');

        document.getElementById('stat-running').textContent = status.running ? 'Yes' : 'No';
        document.getElementById('stat-port').textContent = status.port || '-';
        document.getElementById('stat-public').textContent = status.isPublic ? 'Yes' : 'No';
        document.getElementById('stat-access-mode').textContent = status.accessMode || '-';
        document.getElementById('stat-sessions').textContent = status.sessionCount || 0;
        document.getElementById('stat-clients').textContent = status.clientCount || 0;
        document.getElementById('stat-uptime').textContent = formatUptime(status.uptime);

        const indicator = document.getElementById('status-indicator');
        indicator.textContent = status.running ? 'Online' : 'Offline';
        indicator.className = 'status ' + (status.running ? 'online' : 'offline');

        // Update verification panel
        if (status.verification) {
            updateVerificationPanel(status.verification);
        }
    } catch (err) {
        console.error('Failed to refresh status:', err);
    }
}

async function refreshConfig() {
    try {
        const config = await fetchJSON('/api/config');

        document.getElementById('hostname').value = config.hostname || '';
        document.getElementById('access-mode').value = config.accessMode || 'public';
        document.getElementById('is-public').checked = config.isPublic;
        document.getElementById('require-pin').checked = config.requireConnectionPin;
    } catch (err) {
        console.error('Failed to refresh config:', err);
    }
}

async function refreshClients() {
    try {
        const clients = await fetchJSON('/api/clients');
        const tbody = document.getElementById('clients-body');

        if (clients.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5">No clients connected</td></tr>';
            return;
        }

        tbody.innerHTML = clients.map(client => \`
            <tr>
                <td>\${client.id.substring(0, 8)}...</td>
                <td>\${client.type || 'unknown'}</td>
                <td>\${client.ip || '-'}</td>
                <td>\${client.authenticated ? 'Yes' : 'No'}</td>
                <td>
                    <button class="btn small danger" onclick="kickClient('\${client.id}')">Kick</button>
                </td>
            </tr>
        \`).join('');
    } catch (err) {
        console.error('Failed to refresh clients:', err);
    }
}

async function refreshSessions() {
    try {
        const sessions = await fetchJSON('/api/sessions');
        const tbody = document.getElementById('sessions-body');

        if (sessions.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5">No active sessions</td></tr>';
            return;
        }

        tbody.innerHTML = sessions.map(session => \`
            <tr>
                <td>\${session.id.substring(0, 8)}...</td>
                <td>\${session.hostId ? session.hostId.substring(0, 8) + '...' : '-'}</td>
                <td>\${session.clientId ? session.clientId.substring(0, 8) + '...' : '-'}</td>
                <td>\${formatDate(session.created)}</td>
                <td>\${formatDate(session.lastActivity)}</td>
            </tr>
        \`).join('');
    } catch (err) {
        console.error('Failed to refresh sessions:', err);
    }
}

async function saveConfig(e) {
    e.preventDefault();

    const config = {
        hostname: document.getElementById('hostname').value,
        accessMode: document.getElementById('access-mode').value,
        isPublic: document.getElementById('is-public').checked,
        requireConnectionPin: document.getElementById('require-pin').checked
    };

    try {
        await fetchJSON('/api/config', {
            method: 'POST',
            body: JSON.stringify(config)
        });
        alert('Configuration saved!');
        refreshStatus();
    } catch (err) {
        alert('Failed to save configuration');
    }
}

async function kickClient(clientId) {
    if (!confirm('Are you sure you want to disconnect this client?')) return;

    try {
        await fetchJSON('/api/kick', {
            method: 'POST',
            body: JSON.stringify({ clientId })
        });
        refreshClients();
    } catch (err) {
        alert('Failed to kick client');
    }
}

function updateVerificationPanel(verification) {
    const scoreEl = document.getElementById('trust-score');
    const linksEl = document.getElementById('verification-links');

    // Calculate trust score
    let score = 0;
    if (verification.mastodon) score += 20;
    if (verification.twitter) score += 15;
    if (verification.github) score += 20;
    if (verification.website) score += 15;
    if (verification.email) score += 10;
    if (verification.pgpKeyId) score += 20;
    if (verification.organization) score += verification.orgVerified ? 25 : 10;
    score = Math.min(score, 100);

    scoreEl.innerHTML = \`Trust Score: <span style="color: \${score >= 70 ? '#00d26a' : score >= 40 ? '#f9c846' : '#e94560'}">\${score}/100</span>\`;

    const links = [];
    if (verification.mastodon) links.push(\`Mastodon: \${verification.mastodon}\`);
    if (verification.twitter) links.push(\`Twitter: @\${verification.twitter}\`);
    if (verification.github) links.push(\`GitHub: \${verification.github}\`);
    if (verification.website) links.push(\`Website: \${verification.website}\`);
    if (verification.email) links.push(\`Email: \${verification.email}\`);
    if (verification.organization) links.push(\`Org: \${verification.organization}\${verification.orgVerified ? ' (Verified)' : ''}\`);

    linksEl.innerHTML = links.length > 0
        ? links.map(l => \`<div style="margin: 0.5rem 0; color: var(--text-secondary)">\${l}</div>\`).join('')
        : '<p style="color: var(--text-secondary)">No verification links set</p>';
}

function formatUptime(ms) {
    if (!ms) return '-';
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return \`\${days}d \${hours % 24}h\`;
    if (hours > 0) return \`\${hours}h \${minutes % 60}m\`;
    if (minutes > 0) return \`\${minutes}m \${seconds % 60}s\`;
    return \`\${seconds}s\`;
}

function formatDate(timestamp) {
    if (!timestamp) return '-';
    return new Date(timestamp).toLocaleString();
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    refreshStatus();
    refreshConfig();
    refreshClients();
    refreshSessions();

    // Auto-refresh every 5 seconds
    setInterval(() => {
        refreshStatus();
        refreshClients();
        refreshSessions();
    }, 5000);

    // Form handler
    document.getElementById('config-form').addEventListener('submit', saveConfig);
});
`);
    }
}

module.exports = { ServerWebUI };
