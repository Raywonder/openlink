/**
 * Preload script for splash screen
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('splash', {
    onStatus: (callback) => ipcRenderer.on('status', (e, data) => callback(data)),
    onUpdateAvailable: (callback) => ipcRenderer.on('update-available', (e, data) => callback(data)),
    onDownloadProgress: (callback) => ipcRenderer.on('download-progress', (e, data) => callback(data)),
    onUpdateReady: (callback) => ipcRenderer.on('update-ready', (e, data) => callback(data))
});

console.log('Splash preload loaded');
