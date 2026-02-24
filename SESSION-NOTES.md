# OpenLink Development Session Notes
**Date:** January 8, 2026
**Version:** 1.7.15

## IMPORTANT: Release Checklist
**When uploading apps and updates, ALWAYS ensure proper download links are on pages for use:**
1. Update download page HTML with latest version links
2. Update version numbers displayed on page
3. Verify all platform links work (Mac, Windows, Linux)
4. Update auto-updater manifest files (latest-mac.yml, latest.yml, latest-linux.yml)

## Trust Score System

Trust scores determine user privileges and access levels. Higher scores unlock more features.

### Trust Score Factors
| Factor | Points | Description |
|--------|--------|-------------|
| eCripto Wallet Connected | 10 | Base points for wallet connection |
| Payment Method Active | 20 | Linked payment method on file |
| WHMCS Client Login | 15 | Signed into client portal |
| Mastodon Profile Linked | 10 | Verified Mastodon identity |
| Connection History | 2/each (max 20) | Previous successful connections |
| Account Tenure | 1/day (max 30) | Days since first use |

### Trust Tiers
| Tier | Score | Benefits |
|------|-------|----------|
| None | 0 | Connect a wallet to start |
| New | 1-19 | Basic hosting |
| Basic | 20-49 | Extended sessions |
| Trusted | 50-79 | Priority connections |
| Veteran | 80-100 | All features + NFT minting |

## Domain Architecture

### OpenLink Subdomains (All Domains)
- `*.openlink.tappedin.fm`
- `*.openlink.raywonderis.me`
- `*.openlink.devinecreations.net`
- `*.openlink.devine-creations.com`

### User-Specific Domains
| User Home | Domain | Requirements |
|-----------|--------|--------------|
| `/home/wharper` | `*.openlink.walterharper.com` | WHMCS + Payment + Wallet |
| `/home/tetoeehoward` | `*.openlink.tetoeehoward.com` | WHMCS + Payment + Wallet |

### Guest vs Authenticated Users
- **Guests**: Use public URLs available in app dropdown
- **Authenticated Users**: Can create custom domains via API, nginx auto-configured through signaling server

## Session - January 8, 2026

### Version 1.7.15 Changes
1. **Phone/SMS Verification** - Users can verify identity via SMS code
2. **Email Verification** - Alternative to phone verification
3. **Link Verification Required** - Users must verify before creating shareable links
4. **Wallet Persistence** - Wallet addresses now persist across app restarts
5. **Push Notifications** - Session URLs sent via Pushover/email/SMS when hosting starts
6. **Status Page Fixed** - Browser now shows HTML status page, API returns JSON
7. **Download Page** - Platform detection shows appropriate download first

### New Files
- `src/services/user-verification-service.js` - SMS/email verification logic

### Fixes Applied
1. **Signaling Server Crash Bug** - Fixed `cleanupConnection` TypeError at line 1807
2. **WebSocket Path Issue** - Server now accepts both `/` and `/ws` paths
3. **Download Page Updated** - Updated to version 1.7.15 with platform detection
4. **Status Page Fixed** - Now serves HTML for browsers, JSON for API clients

### Server Status
- Signaling server: `wss://openlink.raywonderis.me` - Running on port 8767
- All domains route to same backend via nginx
- WebSocket connections working

---

## Completed in Previous Sessions

### Version 1.4.8
- **Subdomain-based Session URLs** - URLs now use `https://session-id.openlink.raywonderis.me` format
- DNS wildcard records added for all OpenLink domains
- Nginx wildcard config for subdomain routing
- Signaling server extracts session from subdomain
- Auto-reconnect after updates (saves connection state, restores after restart)

### Version 1.4.7
- Silent update with reconnection on Windows
- Connection state preservation during updates

### Version 1.4.6
- Server names cleaned up (OpenLink Official → OpenLink, etc.)
- Clearer naming for all servers

### Version 1.4.2
- Auto session registration (`create_session` -> `host` flow)
- Auto session unregistration on stop (`leave` message)
- URL normalization - auto-add `wss://` for domains, `ws://` for local IPs

### Version 1.4.3
- **Session Password Management**
  - Added "Session Password" field in Settings UI
  - "Generate" button for random passwords
  - `syncPasswordChange()` - syncs to signaling server + connected clients
  - `handlePasswordChange()` - client receives and stores new password
  - Password syncs via both WebSocket (`password_updated`) and data channel (`password-changed`)

### Version 1.4.4
- Auto-host uses remote server (`openlink.raywonderis.me`) instead of local

### Version 1.4.5
- **URL Parsing Fix** - Now correctly parses:
  - Path format: `https://openlink.raywonderis.me/macmini-fl`
  - Query format: `?session=xxx`
  - Extracts server from URL hostname
  - Sets server dropdown automatically

## Files Modified
- `src/ui/index.html` - Session password field
- `src/ui/app.js` - Password management, URL parsing, auto-host server
- `src/signaling-server.js` - `handleUpdatePassword()` handler
- `src/signaling-server-v2.js` - Version bumps

## Current Session Setup (Mac Mini FL)
- **Session ID:** `macmini-fl`
- **Password:** `connect123`
- **Server:** `openlink.raywonderis.me`
- **Host script:** `/Users/admin/dev/apps/openlink/electron/openlink-host.js`

## Known Issues - SOLVED

### PC Connection Failure - ROOT CAUSE FOUND
**Issue:** PC was connecting but immediately disconnecting (50ms)

**Root Cause:** The `openlink-host.js` script only maintains the session on the signaling server - it does NOT implement WebRTC signaling. When a peer connects:
1. PC sends `join` → receives `joined` ✓
2. Host script receives `peer_joined` → logs it, does nothing
3. **No WebRTC offer is ever sent** (script doesn't handle WebRTC)
4. PC waits for offer, times out after 50ms, disconnects

**Solution:** Run the **full OpenLink app** instead of the host script. The app implements complete WebRTC signaling.

**Host log proof:**
```
[2026-01-03T08:11:01.439Z] peer_joined
[2026-01-03T08:11:01.489Z] peer_disconnected  (50ms later - no WebRTC response)
```

### ICE Candidate Message Type Fix (Server-side)
**Issue:** After WebRTC started, got "Unknown message type: ice-candidate"

**Root Cause:** Client sends `ice-candidate` (hyphen), server expected `ice_candidate` (underscore)

**Fix:** Updated `signaling-server.js` to accept both:
```javascript
case 'ice_candidate':
case 'ice-candidate':
    this.handleWebRTCSignaling(ws, clientId, message);
```

**Deployed:** Uploaded to server and restarted signaling-server.js

### Other Issues
- Auto-updater not prompting (users downloading manually)

## Server Discovery (src/server-discovery.js)
Default servers:
- Local Server: `ws://localhost:8765`
- VPS1 TappedIn: `ws://vps1.tappedin.fm:8765`
- **OpenLink Official**: `wss://openlink.raywonderis.me`
- OpenLink TappedIn: `wss://openlink.tappedin.fm`
- OpenLink Devine: `wss://openlink.devinecreations.net`
- OpenLink DC: `wss://openlink.devine-creations.com`
- OpenLink WH: `wss://openlink.walterharper.com`
- OpenLink TH: `wss://openlink.tetoeehoward.com`

## UI Improvements Needed
1. **Rename "Official OpenLink"** to just "OpenLink" in server dropdown
2. **Random server option** - When selected, show "Generate Random Link" button
3. **Session options**:
   - Permanent options (saved to settings)
   - Current session only options (temporary)
4. **Server list cleanup** - Clearer naming, less confusing

## Development Notes

### Wallet-to-Domain Authorization (Needs Implementation)
Currently, user-specific domains (walterharper.com, tetoeehoward.com) are hardcoded in the signaling server. Full implementation requires:

1. **Client-side** (DONE):
   - WHMCS client ID stored via `linkWhmcsClient()` in app.js
   - Wallet address persisted in ecripto-connector.js
   - Trust score includes WHMCS and wallet factors

2. **Server-side** (TODO):
   - API endpoint to verify wallet-to-WHMCS client mapping
   - Domain authorization check: verify user's wallet/clientId before allowing custom domain use
   - Signaling server should validate domain requests against user's linked accounts
   - Example: `*.openlink.walterharper.com` should only work for wharper's wallet/clientId

3. **Verification Flow** (TODO):
   - User links WHMCS client → stores clientId locally
   - When hosting on custom domain → server checks wallet address
   - Server verifies wallet is associated with that WHMCS client
   - If verified, allows domain use; otherwise falls back to public domains

## Future Features (Noted)

### High Priority
1. **Auto-register sessions** - Always register on signaling server when hosting starts
2. **Register on both IPs** - Private and public IP registration
3. **VNC Integration** - Add VNC as fallback/alternative:
   - noVNC - HTML5 VNC client
   - peer-vnc - VNC over WebRTC
   - simplevnc - Node.js embeddable

### Medium Priority
4. **OpenLink Monitor** - Background service:
   - Auto-reconnect sessions if app dies
   - Start app when connection requested
   - System service option for login
5. **URL Protocol Handler** - `openlink://` URLs auto-launch app
6. **Browser Integration** - Prompt to open app or show download page
7. **Detect other remote apps** - Alert if TeamViewer/AnyDesk running

### Accessibility
8. **AccessKit Integration** - accesskit.dev
   - Cross-platform accessibility infrastructure
   - Better screen reader support
9. **Keychain access** - Login with local password between devices

### Other
10. **License recovery** - "Lost your license?" option
11. **API Monitor integration** - Process listing via hubnode API
12. **Chatbot phone integration** - Bot can dial users into call queue (302-313-9555)

## Server Locations
- **Downloads:** `root@64.20.46.178:/home/dom/public_html/uploads/website_specific/apps/openlink/`
- **Signaling:** `wss://openlink.raywonderis.me`

## Build Commands
```bash
cd /Users/admin/dev/apps/openlink/electron
npm run build:all  # Mac, Windows, Linux
```

## eCripto Website Issues
- Website shows version 1.3.0 - needs update to current version
- Chatbot connection error - `/api/chat` endpoint missing
- API server at port 3456 needs chat proxy to Ollama
