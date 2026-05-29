# OpenLink Cloudflare Edge Backend

OpenLink can use a Cloudflare Worker with a Durable Object as an optional edge rendezvous fallback. This does not replace the primary OpenLink signal server. It gives clients another HTTPS/WSS route when the main route is stale, blocked, or slow.

## Role

- Primary signal: `https://openlink.tappedin.fm` and `https://openlink.raywonderis.me`.
- Normal relay: `/relay` on the active public OpenLink server.
- Cloudflare fallback: `https://openlink-edge.tappedin.fm/ws` or `https://openlink-edge.raywonderis.me/ws`.
- Tailnet/direct fallback: hidden from user-visible generated links.

The desktop clients advertise this fallback in `routeHints` as `cloudflare-edge`, but generated user links remain HTTPS-only. The clients should not show raw `wss://` URLs.

## Why Durable Objects

Cloudflare recommends Durable Objects for stateful WebSocket coordination, and their hibernation WebSocket API keeps clients connected while the object can sleep when idle. That fits OpenLink presence, handshake, TTS, braille, and control acknowledgements. High-rate audio/video should stay on the primary relay/direct path unless testing proves the edge path is stable enough.

## Deployment

1. Copy `servers/cloudflare/wrangler.toml.example` to `servers/cloudflare/wrangler.toml`.
2. Configure routes for `openlink-edge.tappedin.fm` and/or `openlink-edge.raywonderis.me`.
3. Set `OPENLINK_EDGE_SHARED_TOKEN` with `wrangler secret put OPENLINK_EDGE_SHARED_TOKEN`.
4. Deploy from `servers/cloudflare` with `wrangler deploy`.
5. Set `OPENLINK_CLOUDFLARE_BACKEND_URL=https://openlink-edge.tappedin.fm` on the Node signal server.
6. Restart the Node signal server and confirm `/health` includes `backends.cloudflare.enabled: true`.

## Test

- `GET https://openlink-edge.tappedin.fm/health` returns `1.7.27-cloudflare-edge`.
- `GET https://openlink.tappedin.fm/health` reports `backends.cloudflare.enabled: true`.
- Both desktop clients keep the primary server connected and include the `cloudflare-edge` route hint in machine registration.
- Only fail over live connection routing to the Cloudflare backend after primary signal and normal relay fail.
