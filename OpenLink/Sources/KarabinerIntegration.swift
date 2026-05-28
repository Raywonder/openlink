import Foundation
import AppKit

struct KarabinerStatus {
    let cliPath: String?
    let virtualHIDClientPath: String?
    let version: String?
    let virtualHIDExtensionSeen: Bool
    let virtualHIDExtensionEnabled: Bool
    let summary: String

    var isInstalled: Bool { cliPath != nil || virtualHIDClientPath != nil || virtualHIDExtensionSeen }
    var isReady: Bool { virtualHIDExtensionEnabled && virtualHIDClientPath != nil }

    var dictionary: [String: Any] {
        [
            "installed": isInstalled,
            "ready": isReady,
            "cliPath": cliPath ?? "",
            "virtualHIDClientPath": virtualHIDClientPath ?? "",
            "version": version ?? "",
            "virtualHIDExtensionSeen": virtualHIDExtensionSeen,
            "virtualHIDExtensionEnabled": virtualHIDExtensionEnabled,
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

    private init() {}

    func status() -> KarabinerStatus {
        let cliPath = cliCandidates.first { FileManager.default.isExecutableFile(atPath: $0) }
        let virtualHIDClientPath = virtualHIDClientCandidates.first { FileManager.default.isExecutableFile(atPath: $0) }
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
            summary = "Karabiner-Elements is not installed. OpenLink will use the built-in macOS CGEvent input path."
        } else if extensionEnabled && virtualHIDClientPath != nil && cliPath != nil {
            summary = "Karabiner virtual HID driver is enabled. OpenLink can use this as a future low-level input assist path, while current control still requires OpenLink Accessibility trust."
        } else if extensionEnabled && virtualHIDClientPath != nil {
            summary = "Karabiner virtual HID driver is enabled, but the Karabiner-Elements CLI was not found. OpenLink can detect the low-level driver and can use it after a dedicated virtual-HID bridge is added; current control still uses CGEvent and requires OpenLink Accessibility trust."
        } else if extensionEnabled {
            summary = "Karabiner virtual HID driver is enabled, but OpenLink did not find the virtual HID client binary needed for a direct assist path. Current control still uses CGEvent."
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
