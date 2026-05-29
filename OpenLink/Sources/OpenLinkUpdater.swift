import AppKit
import CryptoKit
import Foundation

struct OpenLinkUpdateManifest: Decodable {
    struct Platform: Decodable {
        let installerURL: String?
        let url: String?
        let sha256: String?
        let mirrors: [String]?

        enum CodingKeys: String, CodingKey {
            case installerURL = "installer_url"
            case url
            case sha256
            case mirrors
        }

        var resolvedURL: String {
            if let installerURL, !installerURL.isEmpty { return installerURL }
            return url ?? ""
        }

        var resolvedURLs: [String] {
            var values: [String] = []
            if !resolvedURL.isEmpty {
                values.append(resolvedURL)
            }
            values.append(contentsOf: mirrors?.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } ?? [])
            return values
        }
    }

    let version: String
    let notes: String?
    let releaseNotes: String?
    let downloadURL: String?
    let sha256: String?
    let platforms: [String: Platform]?

    enum CodingKeys: String, CodingKey {
        case version
        case notes
        case releaseNotes = "release_notes"
        case downloadURL = "download_url"
        case sha256
        case platforms
    }

    var macDownloadURL: String {
        if let platform = platforms?["macos-x64"], !platform.resolvedURL.isEmpty {
            return platform.resolvedURL
        }
        if let platform = platforms?["macos"], !platform.resolvedURL.isEmpty {
            return platform.resolvedURL
        }
        if let platform = platforms?["mac"], !platform.resolvedURL.isEmpty {
            return platform.resolvedURL
        }
        return downloadURL ?? ""
    }

    var macDownloadURLs: [String] {
        var values: [String] = []
        if let platform = platforms?["macos-x64"] {
            values.append(contentsOf: platform.resolvedURLs)
        }
        if let platform = platforms?["macos"] {
            values.append(contentsOf: platform.resolvedURLs)
        }
        if let platform = platforms?["mac"] {
            values.append(contentsOf: platform.resolvedURLs)
        }
        if let downloadURL, !downloadURL.isEmpty {
            values.append(downloadURL)
        }
        var seen = Set<String>()
        return values.filter { seen.insert($0).inserted }
    }

    var macSha256: String? {
        platforms?["macos-x64"]?.sha256 ?? platforms?["macos"]?.sha256 ?? platforms?["mac"]?.sha256 ?? sha256
    }

    var resolvedReleaseNotes: String {
        if let releaseNotes, !releaseNotes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return releaseNotes
        }
        return notes ?? ""
    }
}

final class OpenLinkUpdater {
    static let shared = OpenLinkUpdater()
    static let cloudUpdateManifestURL = "https://devinecreations.net/openlink-downloads/update.json"
    static let tappedInUpdateManifestURL = "https://files.tappedin.fm/Public/openlink/update.json"

    private let session = URLSession(configuration: .ephemeral)
    private let updatesDirectory = URL(fileURLWithPath: NSHomeDirectory())
        .appendingPathComponent(".openlink", isDirectory: true)
        .appendingPathComponent("updates", isDirectory: true)

    func checkAutomatically() {
        guard UserDefaults.standard.bool(forKey: "checkForUpdatesAutomatically") else { return }
        Task.detached(priority: .background) { [weak self] in
            await self?.check(interactive: false)
        }
    }

    func check(interactive: Bool) async {
        guard !manifestURLs().isEmpty else {
            await announce("OpenLink update manifest URL is invalid.", interactive: interactive)
            return
        }

        do {
            let manifest = try await fetchManifest()
            guard isNewerVersion(manifest.version, than: currentVersion()) else {
                await announce("OpenLink is up to date.", interactive: interactive)
                return
            }

            await announce("OpenLink \(manifest.version) is available.", interactive: true)
            if interactive {
                let shouldInstall = await confirmUpdate(manifest)
                guard shouldInstall else {
                    await announce("OpenLink update postponed.", interactive: true)
                    return
                }
            }
            guard interactive || UserDefaults.standard.bool(forKey: "installUpdatesAutomatically") else { return }
            try await downloadAndInstall(manifest)
        } catch {
            await announce("OpenLink update check failed: \(error.localizedDescription)", interactive: interactive)
        }
    }

    private func fetchManifest() async throws -> OpenLinkUpdateManifest {
        var lastError: Error?
        for manifestURL in manifestURLs() {
            do {
                let (data, _) = try await session.data(from: manifestURL)
                return try JSONDecoder().decode(OpenLinkUpdateManifest.self, from: data)
            } catch {
                lastError = error
            }
        }

        throw lastError ?? NSError(domain: "OpenLinkUpdater", code: 5, userInfo: [NSLocalizedDescriptionKey: "OpenLink update manifest could not be loaded."])
    }

    private func manifestURLs() -> [URL] {
        let configured = UserDefaults.standard.string(forKey: "updateManifestUrl") ?? ""
        let candidates = [
            configured,
            Self.cloudUpdateManifestURL,
            Self.tappedInUpdateManifestURL
        ]

        var seen = Set<String>()
        return candidates.compactMap { value in
            guard let url = URL(string: value), !seen.contains(url.absoluteString) else { return nil }
            seen.insert(url.absoluteString)
            return url
        }
    }

    private func downloadAndInstall(_ manifest: OpenLinkUpdateManifest) async throws {
        let downloadURLs = manifest.macDownloadURLs
        guard let firstDownloadURLString = downloadURLs.first,
              let downloadURL = URL(string: firstDownloadURLString),
              !firstDownloadURLString.isEmpty else {
            throw NSError(domain: "OpenLinkUpdater", code: 1, userInfo: [NSLocalizedDescriptionKey: "No macOS update download URL was found."])
        }

        try FileManager.default.createDirectory(at: updatesDirectory, withIntermediateDirectories: true)
        let target = updatesDirectory
            .appendingPathComponent("OpenLink-\(safeVersion(manifest.version))")
            .appendingPathExtension(downloadURL.pathExtension.isEmpty ? "zip" : downloadURL.pathExtension)
        let tempURL = try await downloadFromFirstAvailableURL(downloadURLs)
        if FileManager.default.fileExists(atPath: target.path) {
            try FileManager.default.removeItem(at: target)
        }
        try FileManager.default.moveItem(at: tempURL, to: target)
        try verifyChecksumIfNeeded(fileURL: target, expected: manifest.macSha256)
        try writePendingWhatIsNew(version: manifest.version, notes: manifest.resolvedReleaseNotes)
        try stageAndRunInstaller(downloadURL: target, version: manifest.version)
    }

    private func downloadFromFirstAvailableURL(_ values: [String]) async throws -> URL {
        var lastError: Error?
        for value in values {
            guard let url = URL(string: value) else { continue }
            do {
                let (tempURL, _) = try await session.download(from: url)
                return tempURL
            } catch {
                lastError = error
            }
        }

        throw lastError ?? NSError(domain: "OpenLinkUpdater", code: 6, userInfo: [NSLocalizedDescriptionKey: "OpenLink update download failed from every mirror."])
    }

    private func stageAndRunInstaller(downloadURL: URL, version: String) throws {
        guard Bundle.main.bundlePath.hasSuffix(".app") else {
            throw NSError(domain: "OpenLinkUpdater", code: 2, userInfo: [NSLocalizedDescriptionKey: "Automatic install requires OpenLink to be running from an app bundle."])
        }

        let scriptURL = updatesDirectory.appendingPathComponent("install-openlink-update.sh")
        let appPath = Bundle.main.bundlePath
        let script = """
#!/bin/bash
set -euo pipefail
APP_PATH="$1"
DOWNLOAD_PATH="$2"
VERSION="$3"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
sleep 1
/usr/bin/ditto -x -k "$DOWNLOAD_PATH" "$WORK_DIR"
NEW_APP="$(/usr/bin/find "$WORK_DIR" -maxdepth 3 -name 'OpenLink.app' -type d | /usr/bin/head -1)"
if [ -z "$NEW_APP" ]; then
  exit 12
fi
/usr/bin/osascript -e 'tell application "OpenLink" to quit' >/dev/null 2>&1 || true
sleep 2
/bin/rm -rf "$APP_PATH"
/bin/cp -R "$NEW_APP" "$APP_PATH"
/bin/mkdir -p "$HOME/.openlink"
/bin/echo "$VERSION" > "$HOME/.openlink/pending-update-success.txt"
/usr/bin/open -n "$APP_PATH"
"""
        try script.write(to: scriptURL, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: scriptURL.path)

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = [scriptURL.path, appPath, downloadURL.path, version]
        try process.run()
        NSApplication.shared.terminate(nil)
    }

    private func verifyChecksumIfNeeded(fileURL: URL, expected: String?) throws {
        guard let expected, !expected.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let normalized = expected.filter { $0.isHexDigit }.lowercased()
        guard normalized.count == 64 else {
            throw NSError(domain: "OpenLinkUpdater", code: 3, userInfo: [NSLocalizedDescriptionKey: "OpenLink update manifest has an invalid SHA256 value."])
        }

        let digest = try SHA256.hash(data: Data(contentsOf: fileURL))
            .map { String(format: "%02x", $0) }
            .joined()
        guard digest == normalized else {
            try? FileManager.default.removeItem(at: fileURL)
            throw NSError(domain: "OpenLinkUpdater", code: 4, userInfo: [NSLocalizedDescriptionKey: "OpenLink update download failed checksum verification."])
        }
    }

    private func currentVersion() -> String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
    }

    private func isNewerVersion(_ candidate: String, than current: String) -> Bool {
        candidate.compare(current, options: .numeric) == .orderedDescending
    }

    private func safeVersion(_ version: String) -> String {
        version.map { $0.isLetter || $0.isNumber || $0 == "." || $0 == "_" || $0 == "-" ? $0 : "-" }.reduce("") { $0 + String($1) }
    }

    @MainActor
    private func announce(_ message: String, interactive: Bool) {
        guard interactive else { return }
        let alert = NSAlert()
        alert.messageText = message
        alert.runModal()
    }

    @MainActor
    private func confirmUpdate(_ manifest: OpenLinkUpdateManifest) -> Bool {
        let dialog = WhatIsNewWindowController(
            version: manifest.version,
            releaseNotes: manifest.resolvedReleaseNotes,
            updatePrompt: true
        )
        return dialog.runModal() == .alertFirstButtonReturn
    }

    private func writePendingWhatIsNew(version: String, notes: String) throws {
        let directory = updatesDirectory.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try version.write(to: directory.appendingPathComponent("last-whats-new-version.txt"), atomically: true, encoding: .utf8)
        try notes.write(to: directory.appendingPathComponent("last-whats-new-notes.txt"), atomically: true, encoding: .utf8)
    }
}
