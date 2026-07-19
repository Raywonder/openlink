const crypto = require('crypto');

const DEFAULT_SIGNALING_SERVERS = [
    'wss://openlink.tappedin.fm/ws',
    'wss://openlink.raywonderis.me/ws',
    'wss://openlink.devinecreations.net/ws',
    'wss://openlink.devine-creations.com/ws'
];

class OpenCloudLinkProvider {
    constructor(options = {}) {
        this.publicBaseUrl = this.cleanBaseUrl(options.publicBaseUrl || process.env.OPENLINK_PUBLIC_BASE_URL || 'https://openlink.tappedin.fm');
        this.cloudShareRoot = this.cleanBaseUrl(options.cloudShareRoot || process.env.OPENLINK_OPENCLOUD_SHARE_ROOT || 'https://cloud.raywonderis.me/openlink-releases');
        this.statusTokenTtlSeconds = this.readPositiveInt(options.statusTokenTtlSeconds || process.env.OPENLINK_STATUS_TOKEN_TTL_SECONDS, 86400);
        this.clientTokenTtlSeconds = this.readPositiveInt(options.clientTokenTtlSeconds || process.env.OPENLINK_CLIENT_LINK_TOKEN_TTL_SECONDS, 3600);
        this.applicationTokenTtlSeconds = this.readPositiveInt(options.applicationTokenTtlSeconds || process.env.OPENLINK_APPLICATION_TOKEN_TTL_SECONDS, 86400);
        this.adminToken = options.adminToken || process.env.OPENLINK_LINK_ADMIN_TOKEN || '';
        this.secret = options.secret || process.env.OPENLINK_LINK_TOKEN_SECRET || '';
        this.allowEphemeralSecret = String(process.env.OPENLINK_ALLOW_EPHEMERAL_LINK_SECRET || '').toLowerCase() === 'true';
        this.signalingServers = this.readList(options.signalingServers || process.env.OPENLINK_SIGNALING_SERVERS, DEFAULT_SIGNALING_SERVERS);

        if (!this.secret && this.allowEphemeralSecret) {
            this.secret = crypto.randomBytes(32).toString('hex');
            this.usingEphemeralSecret = true;
        } else {
            this.usingEphemeralSecret = false;
        }
    }

    get enabled() {
        return Boolean(this.secret);
    }

    get adminGenerationEnabled() {
        return this.enabled && Boolean(this.adminToken);
    }

    status() {
        return {
            enabled: this.enabled,
            adminGenerationEnabled: this.adminGenerationEnabled,
            usingEphemeralSecret: this.usingEphemeralSecret,
            provider: 'opencloud',
            publicBaseUrl: this.publicBaseUrl,
            cloudShareRoot: this.cloudShareRoot,
            signalingServers: this.signalingServers,
            downloads: this.downloads()
        };
    }

    downloads() {
        return {
            provider: 'opencloud',
            allDownloads: this.cloudShareRoot,
            updateManifest: `${this.cloudShareRoot}/update.json`,
            windowsInstaller: `${this.cloudShareRoot}/windows/OpenLink-Inno-Setup.exe`,
            windowsPortable: `${this.cloudShareRoot}/windows/OpenLink-Windows-x64.zip`,
            macInstaller: `${this.cloudShareRoot}/macos/OpenLink-macOS.zip`
        };
    }

    assertAdmin(req) {
        if (!this.adminGenerationEnabled) {
            return { ok: false, status: 503, error: 'OpenLink link generation is not configured.' };
        }

        const expected = `Bearer ${this.adminToken}`;
        if (req.headers.authorization !== expected) {
            return { ok: false, status: 401, error: 'Authorization required.' };
        }

        return { ok: true };
    }

    buildSessionLinkPayload(input = {}) {
        const machineInfo = input.machineInfo || {};
        const sessionId = this.safeToken(input.sessionId || machineInfo.sessionId || '');
        const machineId = this.safeToken(input.machineId || machineInfo.id || machineInfo.machineId || sessionId || '');
        const machineName = this.safeText(input.machineName || machineInfo.displayName || machineInfo.machineName || machineInfo.hostname || 'OpenLink device', 128);
        const platform = this.safeText(input.platform || machineInfo.platform || machineInfo.os || 'unknown', 64);
        const statusToken = this.signToken({
            purpose: 'status-url',
            sessionId,
            machineId,
            machineName,
            platform
        }, this.statusTokenTtlSeconds);

        if (!statusToken) {
            return {
                provider: 'opencloud',
                enabled: false,
                reason: 'OPENLINK_LINK_TOKEN_SECRET is not configured.'
            };
        }

        const statusUrl = `${this.publicBaseUrl}/status/${encodeURIComponent(machineId || sessionId)}?token=${encodeURIComponent(statusToken)}`;

        return {
            provider: 'opencloud',
            enabled: true,
            statusUrl,
            tokens: {
                client: this.signToken({
                    purpose: 'client-link',
                    sessionId,
                    machineId,
                    platform
                }, this.clientTokenTtlSeconds),
                application: this.signToken({
                    purpose: 'application-link',
                    sessionId,
                    machineId,
                    platform
                }, this.applicationTokenTtlSeconds)
            },
            downloads: this.downloads(),
            signalingServers: this.signalingServers
        };
    }

    buildStatusPayload(params = {}) {
        const verified = this.verifyToken(params.token, 'status-url');
        if (!verified.ok) {
            return { ok: false, status: 401, error: verified.error };
        }

        const payload = verified.payload;
        const machineId = this.safeToken(params.machineId || payload.machineId || payload.sessionId || '');
        return {
            ok: true,
            body: {
                status: 'ok',
                provider: 'opencloud',
                machine: {
                    id: machineId,
                    name: this.safeText(payload.machineName || params.machineName || 'OpenLink device', 128),
                    platform: this.safeText(payload.platform || 'unknown', 64)
                },
                sessionId: this.safeText(payload.sessionId, 128),
                downloads: this.downloads(),
                signalingServers: this.signalingServers,
                linkTokens: {
                    client: this.signToken({
                        purpose: 'client-link',
                        sessionId: payload.sessionId,
                        machineId,
                        platform: payload.platform
                    }, this.clientTokenTtlSeconds),
                    application: this.signToken({
                        purpose: 'application-link',
                        sessionId: payload.sessionId,
                        machineId,
                        platform: payload.platform
                    }, this.applicationTokenTtlSeconds)
                }
            }
        };
    }

    signToken(payload, ttlSeconds) {
        if (!this.secret) return null;

        const now = Math.floor(Date.now() / 1000);
        const body = {
            ...payload,
            iat: now,
            exp: now + ttlSeconds,
            nonce: crypto.randomBytes(8).toString('hex')
        };
        const encoded = Buffer.from(JSON.stringify(body)).toString('base64url');
        const signature = crypto.createHmac('sha256', this.secret).update(encoded).digest('base64url');
        return `${encoded}.${signature}`;
    }

    verifyToken(token, expectedPurpose) {
        if (!this.secret) return { ok: false, error: 'Link token support is not configured.' };
        if (!token || typeof token !== 'string' || !token.includes('.')) {
            return { ok: false, error: 'Valid link token required.' };
        }

        const [encoded, signature] = token.split('.', 2);
        const expected = crypto.createHmac('sha256', this.secret).update(encoded).digest('base64url');
        const expectedBuffer = Buffer.from(expected);
        const actualBuffer = Buffer.from(signature || '');
        if (expectedBuffer.length !== actualBuffer.length || !crypto.timingSafeEqual(expectedBuffer, actualBuffer)) {
            return { ok: false, error: 'Invalid link token.' };
        }

        try {
            const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
            const now = Math.floor(Date.now() / 1000);
            if (payload.exp && payload.exp < now) return { ok: false, error: 'Link token expired.' };
            if (expectedPurpose && payload.purpose !== expectedPurpose) return { ok: false, error: 'Wrong link token type.' };
            return { ok: true, payload };
        } catch {
            return { ok: false, error: 'Invalid link token payload.' };
        }
    }

    cleanBaseUrl(value) {
        return String(value || '').trim().replace(/\/+$/, '');
    }

    readPositiveInt(value, fallback) {
        const parsed = parseInt(value, 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    }

    readList(value, fallback) {
        if (Array.isArray(value)) return value.filter(Boolean);
        const list = String(value || '')
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);
        return list.length ? list : fallback;
    }

    safeText(value, maxLength = 128) {
        if (value === undefined || value === null) return '';
        return String(value).replace(/[\r\n\t]/g, ' ').slice(0, maxLength);
    }

    safeToken(value) {
        return this.safeText(value, 128).replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
    }
}

module.exports = OpenCloudLinkProvider;
