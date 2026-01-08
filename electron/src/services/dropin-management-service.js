/**
 * Drop-in Management Service
 * Manages drop-in connections, history, and permission types
 */

const Store = require('electron-store');
const { app, Notification } = require('electron');
const log = require('electron-log');

// Connection Types with associated permissions
const CONNECTION_TYPES = {
    personal: {
        id: 'personal',
        name: 'Personal Computer',
        description: 'Full access - your own computer',
        icon: 'computer',
        permissions: {
            viewScreen: true,
            controlInput: true,
            clipboard: true,
            fileTransfer: true,
            audio: true,
            dropIn: true,
            dropInAnytime: true,  // Can drop in without asking
            systemControl: true   // Can control system settings
        }
    },
    family: {
        id: 'family',
        name: 'Family Member',
        description: 'High trust - help family with their computer',
        icon: 'people',
        permissions: {
            viewScreen: true,
            controlInput: true,
            clipboard: true,
            fileTransfer: true,
            audio: true,
            dropIn: true,
            dropInAnytime: false, // Must request first
            systemControl: false
        }
    },
    friend: {
        id: 'friend',
        name: 'Friend',
        description: 'Trusted friend - casual remote access',
        icon: 'person',
        permissions: {
            viewScreen: true,
            controlInput: true,
            clipboard: true,
            fileTransfer: false,
            audio: true,
            dropIn: true,
            dropInAnytime: false,
            systemControl: false
        }
    },
    work: {
        id: 'work',
        name: 'Work Computer',
        description: 'Work device - professional settings',
        icon: 'briefcase',
        permissions: {
            viewScreen: true,
            controlInput: true,
            clipboard: true,
            fileTransfer: true,
            audio: true,
            dropIn: true,
            dropInAnytime: false,
            systemControl: false
        }
    },
    support: {
        id: 'support',
        name: 'Tech Support',
        description: 'Limited access for support sessions',
        icon: 'headset',
        permissions: {
            viewScreen: true,
            controlInput: true,
            clipboard: false,
            fileTransfer: false,
            audio: true,
            dropIn: false,
            dropInAnytime: false,
            systemControl: false
        }
    },
    guest: {
        id: 'guest',
        name: 'Guest',
        description: 'Temporary access - view only',
        icon: 'eye',
        permissions: {
            viewScreen: true,
            controlInput: false,
            clipboard: false,
            fileTransfer: false,
            audio: true,
            dropIn: false,
            dropInAnytime: false,
            systemControl: false
        }
    },
    custom: {
        id: 'custom',
        name: 'Custom',
        description: 'Configure your own permissions',
        icon: 'settings',
        permissions: {
            viewScreen: true,
            controlInput: false,
            clipboard: false,
            fileTransfer: false,
            audio: false,
            dropIn: false,
            dropInAnytime: false,
            systemControl: false
        }
    }
};

class DropinManagementService {
    constructor() {
        this.store = new Store({
            name: 'openlink-dropin',
            defaults: {
                savedContacts: {},      // Saved drop-in contacts
                connectionHistory: [],  // All connections (30 day history)
                pendingRequests: [],    // Pending drop-in requests
                blockedDevices: []      // Blocked device IDs
            }
        });

        this.connectionTypes = CONNECTION_TYPES;
        this.historyRetentionDays = 30;

        // Clean up old history on startup
        this.cleanupOldHistory();
    }

    /**
     * Get all connection types
     */
    getConnectionTypes() {
        return Object.values(this.connectionTypes);
    }

    /**
     * Get connection type by ID
     */
    getConnectionType(typeId) {
        return this.connectionTypes[typeId] || this.connectionTypes.guest;
    }

    /**
     * Add connection to history
     */
    addToHistory(connection) {
        const history = this.store.get('connectionHistory', []);

        const entry = {
            id: connection.deviceId || connection.machineId,
            deviceName: connection.deviceName || 'Unknown Device',
            deviceId: connection.deviceId || connection.machineId,
            platform: connection.platform || 'unknown',
            sessionId: connection.sessionId,
            timestamp: Date.now(),
            duration: connection.duration || 0,
            direction: connection.direction || 'incoming', // 'incoming' or 'outgoing'
            connectionType: connection.connectionType || null,
            wasDropin: connection.wasDropin || false
        };

        // Check if device already in history, update if so
        const existingIndex = history.findIndex(h => h.deviceId === entry.deviceId);
        if (existingIndex >= 0) {
            // Update existing entry
            history[existingIndex] = {
                ...history[existingIndex],
                ...entry,
                connectionCount: (history[existingIndex].connectionCount || 1) + 1,
                lastConnected: Date.now()
            };
        } else {
            entry.connectionCount = 1;
            entry.lastConnected = Date.now();
            entry.firstConnected = Date.now();
            history.unshift(entry);
        }

        this.store.set('connectionHistory', history);
        log.info(`[Dropin] Added to history: ${entry.deviceName}`);

        return entry;
    }

    /**
     * Get connection history
     */
    getHistory(limit = 50) {
        const history = this.store.get('connectionHistory', []);
        return history.slice(0, limit);
    }

    /**
     * Save contact as drop-in enabled
     */
    saveContact(deviceId, options = {}) {
        const contacts = this.store.get('savedContacts', {});
        const history = this.store.get('connectionHistory', []);

        // Find device in history
        const historyEntry = history.find(h => h.deviceId === deviceId);

        const contact = {
            deviceId,
            deviceName: options.deviceName || historyEntry?.deviceName || 'Unknown Device',
            platform: options.platform || historyEntry?.platform || 'unknown',
            connectionType: options.connectionType || 'friend',
            customPermissions: options.customPermissions || null,
            dropInEnabled: options.dropInEnabled !== false,
            savedAt: Date.now(),
            lastConnected: historyEntry?.lastConnected || Date.now(),
            notes: options.notes || ''
        };

        contacts[deviceId] = contact;
        this.store.set('savedContacts', contacts);

        log.info(`[Dropin] Saved contact: ${contact.deviceName} as ${contact.connectionType}`);

        // Notify the user
        this.showNotification(
            'Contact Saved',
            `${contact.deviceName} saved as ${this.getConnectionType(contact.connectionType).name}`
        );

        return contact;
    }

    /**
     * Get saved contact
     */
    getContact(deviceId) {
        const contacts = this.store.get('savedContacts', {});
        return contacts[deviceId] || null;
    }

    /**
     * Get all saved contacts
     */
    getAllContacts() {
        return this.store.get('savedContacts', {});
    }

    /**
     * Update contact connection type
     */
    updateContactType(deviceId, connectionType, customPermissions = null) {
        const contacts = this.store.get('savedContacts', {});

        if (!contacts[deviceId]) {
            return null;
        }

        contacts[deviceId].connectionType = connectionType;
        contacts[deviceId].customPermissions = customPermissions;
        contacts[deviceId].updatedAt = Date.now();

        this.store.set('savedContacts', contacts);

        log.info(`[Dropin] Updated contact type: ${contacts[deviceId].deviceName} -> ${connectionType}`);

        // Notify
        this.showNotification(
            'Connection Type Updated',
            `${contacts[deviceId].deviceName} is now ${this.getConnectionType(connectionType).name}`
        );

        return contacts[deviceId];
    }

    /**
     * Remove saved contact
     */
    removeContact(deviceId) {
        const contacts = this.store.get('savedContacts', {});

        if (contacts[deviceId]) {
            const name = contacts[deviceId].deviceName;
            delete contacts[deviceId];
            this.store.set('savedContacts', contacts);
            log.info(`[Dropin] Removed contact: ${name}`);
            return true;
        }

        return false;
    }

    /**
     * Check if device can drop in
     */
    canDropIn(deviceId) {
        const contact = this.getContact(deviceId);

        if (!contact) {
            return { allowed: false, reason: 'not_saved' };
        }

        if (!contact.dropInEnabled) {
            return { allowed: false, reason: 'dropin_disabled' };
        }

        const type = this.getConnectionType(contact.connectionType);
        const permissions = contact.customPermissions || type.permissions;

        if (!permissions.dropIn) {
            return { allowed: false, reason: 'type_not_allowed' };
        }

        return {
            allowed: true,
            anytime: permissions.dropInAnytime,
            contact,
            permissions
        };
    }

    /**
     * Get permissions for device
     */
    getPermissions(deviceId) {
        const contact = this.getContact(deviceId);

        if (!contact) {
            // Default guest permissions for unknown devices
            return this.connectionTypes.guest.permissions;
        }

        const type = this.getConnectionType(contact.connectionType);
        return contact.customPermissions || type.permissions;
    }

    /**
     * Block device
     */
    blockDevice(deviceId, reason = '') {
        const blocked = this.store.get('blockedDevices', []);

        if (!blocked.find(b => b.deviceId === deviceId)) {
            blocked.push({
                deviceId,
                reason,
                blockedAt: Date.now()
            });
            this.store.set('blockedDevices', blocked);

            // Also remove from saved contacts
            this.removeContact(deviceId);

            log.info(`[Dropin] Blocked device: ${deviceId}`);
        }
    }

    /**
     * Unblock device
     */
    unblockDevice(deviceId) {
        const blocked = this.store.get('blockedDevices', []);
        const filtered = blocked.filter(b => b.deviceId !== deviceId);
        this.store.set('blockedDevices', filtered);
        log.info(`[Dropin] Unblocked device: ${deviceId}`);
    }

    /**
     * Check if device is blocked
     */
    isBlocked(deviceId) {
        const blocked = this.store.get('blockedDevices', []);
        return blocked.some(b => b.deviceId === deviceId);
    }

    /**
     * Request drop-in from another device
     */
    async requestDropIn(deviceId, signalingConnection) {
        if (this.isBlocked(deviceId)) {
            return { success: false, error: 'blocked' };
        }

        // Send request through signaling server
        const request = {
            type: 'dropin-request',
            fromDeviceId: this.getMyDeviceId(),
            toDeviceId: deviceId,
            timestamp: Date.now()
        };

        // This will be sent via WebSocket
        if (signalingConnection && signalingConnection.send) {
            signalingConnection.send(JSON.stringify(request));
        }

        return { success: true, pending: true };
    }

    /**
     * Handle incoming drop-in request
     */
    handleDropInRequest(request, mainWindow) {
        const canDrop = this.canDropIn(request.fromDeviceId);

        if (!canDrop.allowed) {
            return { accept: false, reason: canDrop.reason };
        }

        if (canDrop.anytime) {
            // Auto-accept for anytime drop-in
            log.info(`[Dropin] Auto-accepting drop-in from: ${request.fromDeviceId}`);
            return { accept: true, autoAccepted: true };
        }

        // Show notification and ask user
        this.showNotification(
            'Drop-in Request',
            `${canDrop.contact.deviceName} wants to connect`,
            { requireInteraction: true }
        );

        // Send to renderer for user decision
        if (mainWindow) {
            mainWindow.webContents.send('dropin-request', {
                deviceId: request.fromDeviceId,
                deviceName: canDrop.contact.deviceName,
                connectionType: canDrop.contact.connectionType,
                timestamp: request.timestamp
            });
        }

        return { accept: 'pending', showPrompt: true };
    }

    /**
     * Get my device ID
     */
    getMyDeviceId() {
        const Store = require('electron-store');
        const configStore = new Store({ name: 'openlink-config' });
        return configStore.get('deviceId') || 'unknown';
    }

    /**
     * Clean up old history entries
     */
    cleanupOldHistory() {
        const history = this.store.get('connectionHistory', []);
        const cutoff = Date.now() - (this.historyRetentionDays * 24 * 60 * 60 * 1000);

        const filtered = history.filter(entry => {
            // Keep if: has recent activity, is saved contact, or within retention
            const saved = this.getContact(entry.deviceId);
            return saved || (entry.lastConnected || entry.timestamp) > cutoff;
        });

        if (filtered.length !== history.length) {
            log.info(`[Dropin] Cleaned up ${history.length - filtered.length} old history entries`);
            this.store.set('connectionHistory', filtered);
        }
    }

    /**
     * Show notification
     */
    showNotification(title, body, options = {}) {
        if (Notification.isSupported()) {
            const notification = new Notification({
                title,
                body,
                silent: false,
                ...options
            });
            notification.show();
        }
    }

    /**
     * Export data for sync
     */
    exportData() {
        return {
            savedContacts: this.store.get('savedContacts', {}),
            blockedDevices: this.store.get('blockedDevices', []),
            exportedAt: Date.now()
        };
    }

    /**
     * Import data from sync
     */
    importData(data, merge = true) {
        if (merge) {
            const currentContacts = this.store.get('savedContacts', {});
            const mergedContacts = { ...currentContacts, ...data.savedContacts };
            this.store.set('savedContacts', mergedContacts);

            const currentBlocked = this.store.get('blockedDevices', []);
            const mergedBlocked = [...new Set([...currentBlocked, ...data.blockedDevices])];
            this.store.set('blockedDevices', mergedBlocked);
        } else {
            this.store.set('savedContacts', data.savedContacts || {});
            this.store.set('blockedDevices', data.blockedDevices || []);
        }

        log.info('[Dropin] Data imported');
    }
}

module.exports = { DropinManagementService, CONNECTION_TYPES };
