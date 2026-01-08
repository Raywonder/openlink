/**
 * OpenLink Remote Desktop
 * Accessible WebRTC-based remote desktop module
 *
 * Features:
 * - WebRTC peer-to-peer screen sharing
 * - Bidirectional audio support
 * - VoiceOver/NVDA/JAWS accessibility
 * - Keyboard mode switching (hybrid/local/remote)
 * - Remote input control
 */

const SignalingServer = require('./signaling-server');
const HostInputHandler = require('./host-input-handler');

// For browser environments
if (typeof window !== 'undefined') {
    // WebRTC client and accessibility bridge are loaded via script tags
    window.OpenLinkRemoteDesktop = window.OpenLinkRemoteDesktop || require('./webrtc-client');
    window.AccessibilityBridge = window.AccessibilityBridge || require('./accessibility-bridge');
}

// Export for Node.js
module.exports = {
    SignalingServer,
    HostInputHandler,
    // These are browser-only
    OpenLinkRemoteDesktop: typeof window !== 'undefined' ? window.OpenLinkRemoteDesktop : null,
    AccessibilityBridge: typeof window !== 'undefined' ? window.AccessibilityBridge : null
};

// CLI - start signaling server
if (require.main === module) {
    const port = parseInt(process.argv[2]) || 8765;

    console.log('╔══════════════════════════════════════════╗');
    console.log('║       OpenLink Remote Desktop            ║');
    console.log('║   Accessible WebRTC Screen Sharing       ║');
    console.log('╚══════════════════════════════════════════╝');
    console.log('');

    const server = new SignalingServer({ port });
    server.start();

    console.log('');
    console.log(`Signaling server: ws://localhost:${port}`);
    console.log('Web UI: Open ui/index.html in a browser');
    console.log('');
    console.log('Press Ctrl+C to stop');

    process.on('SIGINT', () => {
        console.log('\nShutting down...');
        server.stop();
        process.exit(0);
    });
}
