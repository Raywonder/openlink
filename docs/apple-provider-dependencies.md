# Apple Provider Dependencies

## OpenLink macOS Distribution

- Provider: Apple Developer / App Store Connect.
- Team: Dominique Stansberry, team identifier `G5232LU4Z7`.
- Purpose: sign and notarize OpenLink macOS release artifacts.
- Signing identity: `Developer ID Application: Dominique Stansberry (G5232LU4Z7)`.
- Signing keychain: Mac mini local signing keychain.
- Notarization path: App Store Connect API key stored locally on the Mac mini.
- Related bundle id: `com.openlink.app`.
- Related public download: `https://devinecreations.net/openlink-downloads/OpenLink-macOS.zip`.
- Secrets needed: signing keychain password and App Store Connect API key material, stored locally only.
- Current status: OpenLink `1.7.21` macOS zip is signed, notarized, stapled, and published.

## OpenLink iOS Companion TestFlight

- Provider: Apple Developer / App Store Connect.
- Purpose: TestFlight distribution for the OpenLink companion app.
- Ownership: platform-owned and managed by Devine Creations/TappedIn for OpenLink users.
- Intended capability: managed-machine monitoring and actions, not direct iOS remote desktop control in V1.
- Required provider items: bundle identifier, Apple Distribution profile, App Store Connect app record, TestFlight build upload credentials.
- Secrets needed: App Store Connect API key or app-specific upload credentials, stored locally/keychain only.
- User-visible scope: managed machines, local discovery, generated connection/status URLs, alerts, lock/unlock, drop-in, disconnect, policy toggles, and listen-only audio monitoring when enabled.

Do not commit raw private keys, `.p8` files, `.p12` files, provisioning profiles, app-specific passwords, or keychain passwords.
