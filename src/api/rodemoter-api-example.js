/**
 * API Integration Example for Rodemoter
 * This shows how to use the Universal API system
 */

const { createAPIClient } = require('./api-client');

// Create API client for this app
const api = createAPIClient('Rodemoter');

async function initializeAPI() {
  try {
    console.log('[Rodemoter] Initializing API connection...');
    
    // Check API health
    const health = await api.checkHealth();
    console.log('[Rodemoter] API Health:', health);
    
    // Register the application
    const registration = await api.register({
      features: ['basic'], // Add your app's features here
      description: 'Rodemoter application'
    });
    console.log('[Rodemoter] Registered:', registration);
    
    // Send periodic heartbeat (every 5 minutes)
    setInterval(async () => {
      try {
        await api.heartbeat();
        console.log('[Rodemoter] Heartbeat sent');
      } catch (error) {
        console.warn('[Rodemoter] Heartbeat failed:', error.message);
      }
    }, 300000); // 5 minutes
    
  } catch (error) {
    console.error('[Rodemoter] API initialization failed:', error.message);
  }
}

// Export for use in your application
module.exports = {
  api,
  initializeAPI
};

// Auto-initialize if run directly
if (require.main === module) {
  initializeAPI();
}
