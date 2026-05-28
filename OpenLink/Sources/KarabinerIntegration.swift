import Foundation
import AppKit

struct KarabinerStatus {
    let cliPath: String?
    let virtualHIDClientPath: String?
    let version: String?
    let virtualHIDExtensionSeen: Bool
    let virtualHIDExtensionEnabled: Bool
    let homebrewPath: String?
    let installCommand: String
    let summary: String

    var isInstalled: Bool { cliPath != nil || virtualHIDClientPath != nil || virtualHIDExtensionSeen }
    var isReady: Bool { virtualHIDExtensionEnabled && (cliPath != nil || virtualHIDClientPath != nil) }
    var canInstallWithHomebrew: Bool { homebrewPath != nil }

    var dictionary: [String: Any] {
        [
            "installed": isInstalled,
            "ready": isReady,
            "canInstallWithHomebrew": canInstallWithHomebrew,
            "cliPath": cliPath ?? "",
            "virtualHIDClientPath": virtualHIDClientPath ?? "",
            "version": version ?? "",
            "virtualHIDExtensionSeen": virtualHIDExtensionSeen,
            "virtualHIDExtensionEnabled": virtualHIDExtensionEnabled,
            "homebrewPath": homebrewPath ?? "",
            "installCommand": installCommand,
            "summary": summary
        ]
    }
}

final class KarabinerIntegration {
    static let shared = KarabinerIntegration()

    private let cliCandidates = [
        "/Library/Application Support/org.pqrs/Karabiner-Elements/bin/karabiner_cli",
        "/Applications/Karabiner-Elements.app/Contents/Library/bin/karabiner_cli"
    ]
    private let virtualHIDClientCandidates = [
        "/Library/Application Support/org.pqrs/Karabiner-DriverKit-VirtualHIDDevice/Applications/Karabiner-DriverKit-VirtualHIDDeviceClient.app/Contents/MacOS/Karabiner-DriverKit-VirtualHIDDeviceClient"
    ]
    private let homebrewCandidates = [
        "/opt/homebrew/bin/brew",
        "/usr/local/bin/brew"
    ]
    private let officialDownloadURL = URL(string: "https://karabiner-elements.pqrs.org/")!

    private init() {}

    func status() -> KarabinerStatus {
        let cliPath = cliCandidates.first { FileManager.default.isExecutableFile(atPath: $0) }
        let virtualHIDClientPath = virtualHIDClientCandidates.first { FileManager.default.isExecutableFile(atPath: $0) }
        let homebrewPath = homebrewCandidates.first { FileManager.default.isExecutableFile(atPath: $0) }
        let version = cliPath.flatMap { run($0, arguments: ["--version"], timeout: 2).trimmedNonEmpty }
        let extensions = run("/usr/bin/systemextensionsctl", arguments: ["list"], timeout: 3)
        let lowerExtensions = extensions.lowercased()
        let extensionSeen = lowerExtensions.contains("org.pqrs.karabiner-driverkit-virtualhiddevice")
        let extensionEnabled = extensionSeen &&
            (lowerExtensions.contains("[activated enabled]") ||
             lowerExtensions.contains("activated enabled") ||
             lowerExtensions.contains("enabled active"))

        let summary: String
        if cliPath == nil && !extensionSeen && virtualHIDClientPath == nil {
            summary = homebrewPath == nil
                ? "Karabiner-Elements is not installed. OpenLink can open the official Karabiner download page, and will use the built-in macOS CGEvent input path until Karabiner is installed."
                : "Karabiner-Elements is not installed. OpenLink can install it with Homebrew, then macOS will ask to approve the virtual HID driver extension."
        } else if extensionEnabled && cliPath != nil {
            summary = "Karabiner virtual HID driver and CLI are installed and enabled. OpenLink will advertise Karabiner readiness during remote keyboard handshakes; macOS Accessibility trust is still required for the current input path."
        } else if extensionEnabled && virtualHIDClientPath != nil {
            summary = "Karabiner virtual HID driver is enabled and the legacy virtual HID client is installed, but the Karabiner-Elements CLI was not found. Install Karabiner-Elements so OpenLink can manage and report the full driver stack."
        } else if extensionEnabled {
            summary = "Karabiner virtual HID driver is enabled, but OpenLink did not find the Karabiner CLI or legacy virtual HID client needed to report the assist path as ready."
        } else if extensionSeen {
            summary = "Karabiner is installed, but its virtual HID driver is not enabled yet in macOS System Settings."
        } else {
            summary = "Karabiner is installed, but OpenLink did not see its virtual HID driver extension loaded."
        }

        return KarabinerStatus(
            cliPath: cliPath,
            virtualHIDClientPath: virtualHIDClientPath,
            version: version,
            virtualHIDExtensionSeen: extensionSeen,
            virtualHIDExtensionEnabled: extensionEnabled,
            homebrewPath: homebrewPath,
            installCommand: "brew install --cask karabiner-elements",
            summary: summary
        )
    }

    func openKarabinerApp() {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "org.pqrs.Karabiner-Elements") else {
            NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications"))
            return
        }
        NSWorkspace.shared.open(url)
    }

    func installOrOpenKarabiner() {
        let current = status()
        if current.cliPath != nil {
            openKarabinerApp()
            return
        }

        if let homebrewPath = current.homebrewPath {
            openTerminalInstallCommand(homebrewPath: homebrewPath)
            return
        }

        NSWorkspace.shared.open(officialDownloadURL)
    }

    private func openTerminalInstallCommand(homebrewPath: String) {
        let command = """
\"\(homebrewPath)\" install --cask karabiner-elements; echo; echo \"Karabiner install finished. If macOS asks for Driver Extension approval, approve Karabiner in Privacy & Security, then return to OpenLink.\"; read -n 1 -s -r -p \"Press any key to close this window.\"
"""
        let escaped = command.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        let script = "tell application \"Terminal\" to do script \"\(escaped)\""
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", script]
        try? process.run()
    }

    private func run(_ launchPath: String, arguments: [String], timeout: TimeInterval) -> String {
        guard FileManager.default.isExecutableFile(atPath: launchPath) else { return "" }

        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: launchPath)
        process.arguments = arguments
        process.standardOutput = pipe
        process.standardError = pipe

        do {
            try process.run()
        } catch {
            return ""
        }

        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if process.isRunning {
            process.terminate()
        }

        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        return String(data: data, encoding: .utf8) ?? ""
    }
}

private extension String {
    var trimmedNonEmpty: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
