# OpenLink Web Application

A comprehensive URL shortening and management system built for Composr CMS v10, featuring cross-platform desktop clients and advanced analytics.

## Features

- **URL Shortening**: Create short links with custom codes across multiple domains
- **Multi-Domain Support**: raywonderis.me, devinecreations.net, tappedin.fm
- **User Management**: Registration, authentication, and role-based access
- **Analytics Dashboard**: Detailed click tracking and user engagement metrics
- **Admin Panel**: System administration and user management
- **Relay Panel**: URL redirection monitoring and performance tracking
- **Download Manager**: Desktop client distribution with Composr CMS integration
- **API Integration**: RESTful API with OpenLink backend service

## Directory Structure

```
/home/dom/public_html/apps/OpenLink/
├── api/                    # API proxy layer
│   └── index.php          # Routes requests to Node.js backend
├── css/                   # Stylesheets
│   └── openlink.css       # Main application styles
├── js/                    # JavaScript files
│   └── openlink.js        # Main application logic
├── assets/                # Static assets (images, fonts, etc.)
├── downloads.php          # Download management and Composr integration
├── .htaccess             # URL routing and security rules
└── README.md             # This file

/home/dom/public_html/apps/pages/html_custom/EN/
├── openlink.htm          # Main application interface
└── openlink/
    ├── relay.htm         # Relay monitoring panel
    └── admin.htm         # Administration dashboard
```

## Composr CMS Integration

### Page Structure
- **Main App**: `{$BASE_URL}:pg:openlink`
- **Relay Panel**: `{$BASE_URL}:pg:openlink/relay`  
- **Admin Dashboard**: `{$BASE_URL}:pg:openlink/admin`

### Download Integration
The application integrates with Composr's download system:

- Downloads are stored in `/uploads/website_specific/apps/OpenLink/clients/`
- Platform-specific downloads: `windows/`, `mac/`, `linux/`
- Composr URL scheme: `{$BASE_URL}:downloads:type=misc:id=openlink-{platform}`
- Direct access via `downloads.php` with API endpoints

### API Proxy
All API calls are proxied through `/apps/OpenLink/api/index.php` which forwards requests to the Node.js backend at `localhost:3002`.

## Backend Connection

The web application connects to the OpenLink Node.js backend:
- **Location**: `/home/devinecr/apps/hubnode/backend/Openlink`
- **Port**: 3002
- **API Base**: `http://localhost:3002/api`

### API Endpoints
- `POST /auth/login` - User authentication
- `POST /auth/register` - User registration
- `GET /auth/profile` - User profile
- `POST /links` - Create short link
- `GET /links` - List user links
- `GET /links/:id` - Get specific link
- `PUT /links/:id` - Update link
- `DELETE /links/:id` - Delete link
- `GET /links/:id/stats` - Link analytics
- `GET /relay/:shortCode` - URL redirection
- `GET /downloads/clients/:platform` - Download client

## Security Features

- **CORS Protection**: Domain-specific access control
- **Security Headers**: XSS, clickjacking, and content-type protection
- **Input Validation**: Server-side validation for all inputs
- **Authentication**: JWT-based user authentication
- **Rate Limiting**: Configurable rate limits for API endpoints
- **File Access Control**: Restricted access to sensitive files

## Performance Optimization

- **Compression**: Gzip compression for text resources
- **Caching**: Browser caching for static assets
- **CDN Integration**: FontAwesome and external resources via CDN
- **Minification**: CSS and JavaScript optimization
- **Database Optimization**: SQLite with proper indexing

## Administration

### System Requirements
- PHP 7.4+ with Composr CMS v10
- Node.js 16+ for backend service
- SQLite3 database
- Apache/Nginx with mod_rewrite

### Installation
1. Deploy files to Composr apps directory
2. Configure backend service (see backend README)
3. Set proper file permissions
4. Update domain configurations
5. Test download integrations

### Monitoring
- **Live Logs**: Real-time request monitoring
- **Analytics**: User engagement and link performance
- **System Health**: Backend service status
- **Error Tracking**: Comprehensive error logging

## URL Schemes

### Composr URLs
- Main App: `/apps:pg:openlink`
- Admin: `/apps:pg:openlink/admin`
- Relay: `/apps:pg:openlink/relay`
- Downloads: `/apps/OpenLink/downloads.php`

### API URLs  
- Authentication: `/apps/OpenLink/api/auth/*`
- Links: `/apps/OpenLink/api/links/*`
- Relay: `/apps/OpenLink/api/relay/*`
- Downloads: `/apps/OpenLink/api/downloads/*`

### Short URLs
- Format: `https://{domain}/{shortCode}`
- Domains: raywonderis.me, devinecreations.net, tappedin.fm
- Preview: `https://{domain}/{shortCode}?preview=true`

## Desktop Client (Electron)

The OpenLink desktop client provides remote desktop connectivity with cross-platform keyboard support.

### Cross-Platform Keyboard Mapping

When controlling a remote machine from a different operating system, keyboard shortcuts are automatically mapped:

| Client (You) | Remote (Host) | Behavior |
|--------------|---------------|----------|
| Windows      | macOS         | Windows key sends Option, Alt sends Command, Ctrl sends Ctrl |
| macOS        | Windows       | Command sends Ctrl, Option sends Alt |

### Windows Client: Win+L Behavior

**Important for Windows Users:** When using a Windows computer to control a remote Mac:

- Pressing `Win+L` normally locks your Windows computer immediately
- OpenLink automatically **disables Win+L** during active remote sessions
- This allows you to use `Win+L` to send `Option+L` (jump to address bar) to the Mac
- When the remote session ends, Win+L is automatically re-enabled

**Technical Note:** This feature modifies the Windows registry key:
`HKCU\Software\Microsoft\Windows\CurrentVersion\Policies\System\DisableLockWorkstation`

The original setting is restored when:
- The remote session ends
- OpenLink is closed
- The app exits for any reason

### Keyboard Shortcut Reference

| Action (on Mac host) | Press on Windows client |
|---------------------|------------------------|
| Cmd+L (Address bar) | Win+L |
| Cmd+C (Copy)        | Ctrl+C |
| Cmd+V (Paste)       | Ctrl+V |
| Option+key          | Alt+key |

## License

MIT License - Built for the Composr CMS ecosystem

## Support

For issues and support:
- Backend issues: Check Node.js service logs
- Frontend issues: Check browser console and network requests
- Composr integration: Verify page creation and URL routing
- Downloads: Check file permissions and directory structure