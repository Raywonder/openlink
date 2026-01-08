/**
 * Universal API Configuration for all services
 * Based on the comprehensive server API from api.*.* domains
 * Version: 2.0.0
 */

const path = require('path');
const os = require('os');

module.exports = {
  // Primary API Configuration
  primaryAPI: {
    baseUrl: 'https://api.devine-creations.com',
    apiVersion: 'v1',
    endpoints: {
      // Core endpoints
      status: '/api/v1/status',
      register: '/api/v1/register',
      heartbeat: '/api/v1/heartbeat',

      // Service-specific endpoints
      synthesize: '/api/v1/synthesize',
      voices: '/api/v1/voices',
      stream: '/api/v1/stream',

      // Tracking and analytics
      tracking: '/api/v1/install-tracking',
      analytics: '/api/v1/analytics',

      // Registration endpoints
      sipRegistration: '/api/v1/sip/register',
      flexpbxRegistration: '/api/v1/flexpbx/register',

      // Files integration
      filesIntegration: '/api/v1/files/integration',
      copypartyBackup: '/api/v1/files/copyparty-backup',
      serverLinking: '/api/v1/files/server-linking',
      uploadFile: '/api/v1/files/upload',
      downloadFile: '/api/v1/files/download',
      listFiles: '/api/v1/files/list',

      // User management
      users: '/api/v1/users',
      createUser: '/api/v1/users',
      getUser: '/api/v1/users',
      updateUser: '/api/v1/users',

      // Configuration
      config: '/api/v1/config',

      // Extensions (FlexPhone/PBX)
      requestExtension: '/api/v1/extensions/request',
      releaseExtension: '/api/v1/extensions/release',

      // Service discovery
      discoverServices: '/api/v1/services/discover',
      registerService: '/api/v1/services/register',

      // Admin management
      adminRegistry: '/api/v1/admin/registry',
      adminStatus: '/api/v1/admin/status',
      adminHeartbeat: '/api/v1/admin/heartbeat',
      adminCoordination: '/api/v1/admin/coordination',
      deploymentOverview: '/api/v1/deployment/overview',

      // Deployment and metrics
      statusReport: '/api/v1/deployment/report',
      metricsUpload: '/api/v1/metrics/upload',
      alerting: '/api/v1/alerts/submit'
    },
    authentication: {
      type: 'service',
      apiKey: process.env.API_KEY || null,
      userAgent: 'UniversalAPI/2.0.0'
    },
    features: {
      installTracking: true,
      fallbackMethod: true,
      adminVersionFallback: true,
      filesIntegration: true,
      multiService: true
    }
  },

  // Fallback API Endpoints
  fallbackEndpoints: [
    {
      name: 'Devine Creations Secondary',
      baseUrl: 'https://api.devinecreations.net',
      apiVersion: 'v1',
      endpoints: {
        status: '/api/v1/status',
        register: '/api/v1/register',
        synthesize: '/api/v1/synthesize',
        voices: '/api/v1/voices',
        stream: '/api/v1/stream',
        tracking: '/api/v1/install-tracking',
        analytics: '/api/v1/analytics',
        sipRegistration: '/api/v1/sip/register',
        flexpbxRegistration: '/api/v1/flexpbx/register',
        filesIntegration: '/api/v1/files/integration',
        copypartyBackup: '/api/v1/files/copyparty-backup',
        serverLinking: '/api/v1/files/server-linking'
      },
      features: {
        installTracking: true,
        fallbackMethod: true,
        adminVersionFallback: true
      }
    },
    {
      name: 'TappedIn Legacy',
      baseUrl: 'https://tts.tappedin.fm',
      apiVersion: 'v1',
      endpoints: {
        synthesize: '/api/v1/synthesize',
        voices: '/api/v1/voices',
        status: '/api/v1/status',
        stream: '/api/v1/stream'
      },
      features: {
        legacy: true,
        ttsOnly: true
      }
    }
  ],

  // Install and Usage Tracking
  installTracking: {
    enabled: true,
    primaryMethod: 'api-tracking',
    fallbackMethod: 'local-storage',
    endpoints: {
      primary: 'https://api.devine-creations.com/api/v1/install-tracking',
      secondary: 'https://api.devinecreations.net/api/v1/install-tracking'
    },
    data: {
      version: '2.0.0',
      platform: process.platform,
      arch: process.arch,
      installType: 'standard', // 'standard', 'portable', 'admin'
      timestamp: new Date().toISOString(),
      serviceName: null // Will be set by the implementing app
    },
    retryAttempts: 3,
    retryDelay: 5000,
    timeout: 10000
  },

  // Universal Registration Configuration
  registration: {
    enabled: true,
    multiServiceSupport: true,
    deploymentTracking: true,
    endpoints: {
      primary: 'https://api.devine-creations.com/api/v1/register',
      secondary: 'https://api.devinecreations.net/api/v1/register',
      serviceTracking: 'https://api.devine-creations.com/api/v1/service/tracking',
      deploymentStatus: 'https://api.devine-creations.com/api/v1/deployment/status'
    },
    baseData: {
      version: '2.0.0',
      platform: process.platform,
      arch: process.arch,
      timestamp: new Date().toISOString(),
      installId: null, // Generated on first run
      serviceId: null, // Unique service identifier
      networkInfo: {
        hostname: null,
        macAddress: null,
        ipAddress: null,
        networkSegment: null
      },
      userInfo: {
        username: os.userInfo().username,
        homedir: os.homedir(),
        shell: process.env.SHELL || null
      }
    },
    fallbackBehavior: {
      apiUnavailable: 'store-locally',
      retryInterval: 60000, // 1 minute
      maxRetryAttempts: 10,
      enableOfflineMode: true
    }
  },

  // Files Integration (CopyParty/Remote Storage)
  filesIntegration: {
    enabled: true,
    endpoints: {
      primary: 'https://api.devine-creations.com/api/v1/files',
      copyparty: 'https://files.raywonderis.me:8080',
      backup: 'https://api.devine-creations.com/api/v1/files/copyparty-backup',
      serverLinking: 'https://api.devine-creations.com/api/v1/files/server-linking'
    },
    features: {
      copypartyIntegration: true,
      remoteBackup: true,
      serverLinking: true,
      localCaching: true
    },
    copyparty: {
      server: 'files.raywonderis.me',
      port: 8080,
      ssl: true,
      authentication: {
        required: false,
        type: 'basic' // or 'token'
      },
      directories: {
        apps: '/apps',
        backups: '/backups',
        shared: '/shared'
      }
    }
  },

  // eCripto Blockchain Integration
  ecripto: {
    enabled: true,
    baseUrl: 'https://ecripto.app/api/v1',
    localApiUrl: 'http://localhost:3456',
    chainId: 47828,
    networkName: 'eCripto Network',
    endpoints: {
      // Health and status
      health: '/api/health',
      status: '/api/status',

      // Wallet operations
      wallet: '/api/wallet',
      walletBalance: '/api/wallet/balance',
      walletCreate: '/api/wallet/create',
      walletImport: '/api/wallet/import',

      // Payment operations
      payment: '/api/payment',
      paymentCreate: '/api/payment/create',
      paymentConfirm: '/api/payment/confirm',
      paymentStatus: '/api/payment/status',

      // Faucet
      faucet: '/api/faucet/claim',

      // Staking
      stakingInfo: '/api/staking/info',
      stakingStake: '/api/staking/stake',
      stakingUnstake: '/api/staking/unstake',

      // BTC conversion
      btcGenerate: '/api/btc/generate-address',
      btcDeposit: '/api/btc/deposit-info',
      btcCalculate: '/api/btc/calculate',
      btcExchangeInfo: '/api/btc/exchange-info',

      // Transactions
      transactions: '/api/transactions',
      transactionHistory: '/api/transactions/history',

      // Exchange rates
      exchangeRates: '/api/exchange-rates',

      // Services/Shop
      services: '/api/services/list',
      purchase: '/api/services/purchase'
    },
    authentication: {
      type: 'api-key',
      headerName: 'X-API-Secret'
    },
    exchangeRates: {
      ECRP: 1,
      USD: 0.10,      // 1 ECRP = $0.10
      EUR: 0.09,
      BTC: 0.0000001, // 1 BTC = 1,000,000 ECRP
      ETH: 0.00001
    },
    currencies: {
      ECRP: { name: 'eCripto', symbol: 'ECRP', decimals: 18 },
      USD: { name: 'US Dollar', symbol: '$', decimals: 2 },
      EUR: { name: 'Euro', symbol: '€', decimals: 2 },
      BTC: { name: 'Bitcoin', symbol: 'BTC', decimals: 8 },
      ETH: { name: 'Ethereum', symbol: 'ETH', decimals: 18 }
    }
  },

  // Service-Specific Configurations
  services: {
    // TTS Services
    tts: {
      defaults: {
        voice: 'en-US-AriaNeural',
        rate: 1.0,
        pitch: 0,
        format: 'audio/wav',
        sampleRate: 44100,
        bitRate: 16
      },
      limits: {
        maxTextLength: 5000,
        maxRequestsPerMinute: 60,
        maxConcurrentRequests: 5
      }
    },

    // SIP Client Configuration
    sip: {
      capabilities: ['voice', 'video', 'messaging'],
      codecs: ['g711', 'g722', 'opus'],
      transport: ['udp', 'tcp', 'ws', 'wss'],
      registration: {
        autoRegister: true,
        retryAttempts: 5,
        retryDelay: 3000
      }
    },

    // PBX Services
    pbx: {
      features: ['call-routing', 'voicemail', 'conferencing', 'recording'],
      extensions: {
        ranges: {
          users: '200-999',
          admin: '100-199',
          services: '1000-1999'
        },
        autoAssignment: true,
        preferredStrategy: 'random'
      }
    },

    // File Services
    files: {
      maxUploadSize: '100MB',
      allowedFormats: ['*'],
      compressionEnabled: true,
      encryptionEnabled: false
    }
  },

  // Networking and Connectivity
  networking: {
    timeout: 10000,
    retries: 3,
    retryDelay: 1000,
    userAgent: 'UniversalAPI/2.0.0',
    useSSL: true,
    port: 443,
    enableCaching: true,
    cacheTimeout: 300000, // 5 minutes
    enableMetrics: true,
    healthCheckInterval: 60000 // 1 minute
  },

  // Admin and Management Features
  adminManagement: {
    enabled: false, // Enable only for admin apps
    endpoints: {
      adminRegistry: 'https://api.devine-creations.com/api/v1/admin/registry',
      adminStatus: 'https://api.devine-creations.com/api/v1/admin/status',
      adminHeartbeat: 'https://api.devine-creations.com/api/v1/admin/heartbeat',
      adminCoordination: 'https://api.devine-creations.com/api/v1/admin/coordination',
      deploymentOverview: 'https://api.devine-creations.com/api/v1/deployment/overview'
    },
    tracking: {
      heartbeatInterval: 60000, // 1 minute
      timeoutThreshold: 180000, // 3 minutes
      roles: {
        'super-admin': {
          permissions: ['system-owner', 'admin-management', 'global-oversight', 'full-control'],
          description: 'Master administrator with authority over all services'
        },
        'service-admin': {
          permissions: ['service-control', 'user-management', 'configuration'],
          description: 'Service-specific administrative privileges'
        },
        'read-only': {
          permissions: ['view-status', 'read-config'],
          description: 'Read-only access to service information'
        }
      }
    }
  },

  // Monitoring and Metrics
  monitoring: {
    enabled: true,
    collectMetrics: true,
    reportingInterval: 300000, // 5 minutes
    metrics: {
      performance: true,
      usage: true,
      errors: true,
      resourceUsage: true,
      networkStatus: true,
      serviceStatus: true
    },
    endpoints: {
      statusReport: 'https://api.devine-creations.com/api/v1/deployment/report',
      metricsUpload: 'https://api.devine-creations.com/api/v1/metrics/upload',
      alerting: 'https://api.devine-creations.com/api/v1/alerts/submit'
    },
    dataRetention: {
      localHistory: 30, // days
      remoteBackup: 90, // days
      compressionEnabled: true
    }
  },

  // Security and Authentication
  security: {
    apiKeyRequired: false,
    rateLimiting: {
      enabled: true,
      requestsPerMinute: 100,
      burstLimit: 200
    },
    encryption: {
      enabled: true,
      algorithm: 'AES-256-GCM'
    },
    certificates: {
      validateSSL: true,
      allowSelfSigned: false
    }
  },

  // Development and Debug
  development: {
    enableDebugLogging: process.env.NODE_ENV === 'development',
    mockResponses: process.env.MOCK_API === 'true',
    bypassSSL: process.env.BYPASS_SSL === 'true',
    testEndpoints: {
      enabled: process.env.NODE_ENV === 'development',
      baseUrl: 'http://localhost:3000'
    }
  }
};