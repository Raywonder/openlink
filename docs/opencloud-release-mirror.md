# OpenLink OpenCloud Release Mirror

OpenLink release artifacts should be mirrored into the OpenCloud sync folder before they are copied to any host webroot. The stable mirror folder is:

```text
C:\Users\40493\OpenCloud\O8Link OpenLink\releases\openlink-releases
```

Use the release helper from the repository root:

```powershell
.\scripts\mirror-openlink-cloud-release.ps1
```

The helper mirrors available artifacts into `windows\` and `macos\`, writes SHA256 sidecar files, and generates `update.json` for the updater. Pass explicit artifact paths when a build writes somewhere else:

```powershell
.\scripts\mirror-openlink-cloud-release.ps1 `
  -WindowsInstaller .\dist\openlink\OpenLink-Inno-Setup.exe `
  -WindowsPortable .\dist\openlink\OpenLink-Windows-x64.zip `
  -MacOSZip .\dist\openlink\OpenLink-macOS.zip
```

The updater URLs must use the real non-expiring OpenCloud public share URL generated for this folder. If the share token changes, pass it with `-ShareRoot` and update the client defaults in the Windows and macOS updater settings.

Do not place secrets, signing keys, private logs, client data, or unpublished diagnostics in this release mirror.

## Status URLs and Link Tokens

The signaling server supports OpenCloud-backed status and download links without hardcoded secrets. Configure it from environment variables before running `remote-desktop/signaling-server.js`:

```text
OPENLINK_PUBLIC_BASE_URL=https://openlink.tappedin.fm
OPENLINK_OPENCLOUD_SHARE_ROOT=https://cloud.raywonderis.me/openlink-releases
OPENLINK_SIGNALING_SERVERS=wss://openlink.tappedin.fm/ws,wss://openlink.raywonderis.me/ws,wss://openlink.devinecreations.net/ws,wss://openlink.devine-creations.com/ws
OPENLINK_LINK_TOKEN_SECRET=<stored server-side secret>
OPENLINK_LINK_ADMIN_TOKEN=<stored server-side admin token>
```

Endpoints:

- `GET /api/opencloud/status` reports whether link generation is configured, without exposing secrets.
- `GET /api/opencloud/downloads` returns the current OpenCloud installer and updater URLs.
- `POST /api/link-tokens` generates a signed status URL plus client/application link tokens when called with `Authorization: Bearer <OPENLINK_LINK_ADMIN_TOKEN>`.
- `GET /status/:machineId?token=...` validates the signed status token and returns OpenCloud downloads, approved signaling server URLs, and short-lived client/application tokens.

When a host joins a signaling session, the server also includes an `opencloud` linking payload in the `joined` message so clients can surface the generated status URL and download metadata.

`OPENLINK_ALLOW_EPHEMERAL_LINK_SECRET=true` is for local development only. Production must use a persistent server-side `OPENLINK_LINK_TOKEN_SECRET` so generated URLs survive service restarts.

## Archive Feature Check

No OpenCloud/OpenLink archive feature folder exists in this checkout outside dependency folders. If an archive is restored later, review it against the governance rules before copying code into the live signaling server or OpenCloud mirror.
