const express = require('express');
const router = express.Router();

// Health check endpoint
router.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version || '1.0.0'
    });
});

// System status
router.get('/system/status', (req, res) => {
    res.json({
        system: 'operational',
        database: 'connected',
        sip: 'active',
        accessibility: {
            enabled: process.env.ACCESSIBILITY_ENABLED === 'true',
            features: ['screen-reader', 'voice-announcements', 'keyboard-nav']
        }
    });
});

module.exports = router;