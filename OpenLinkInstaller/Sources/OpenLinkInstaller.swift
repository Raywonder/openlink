import Foundation
import SwiftUI

// MARK: - OpenLink Installer Logic

class OpenLinkInstaller: ObservableObject {
    static let shared = OpenLinkInstaller()

    private let fileManager = FileManager.default

    // Installation paths
    let appBundlePath = "/Applications/OpenLink.app"
    let configDirectory = NSHomeDirectory() + "/.openlink"
    let configPath = NSHomeDirectory() + "/.openlink/config.json"
    let launchAgentPath = NSHomeDirectory() + "/Library/LaunchAgents/app.openlink.agent.plist"

    func install(state: InstallerState) {
        Task { @MainActor in
            do {
                // Step 1: Create directories
                state.installStatus = "Creating directories..."
                state.installProgress = 0.1
                try await Task.sleep(nanoseconds: 300_000_000)

                try createDirectories()

                // Step 2: Write configuration
                state.installStatus = "Writing configuration..."
                state.installProgress = 0.3
                try await Task.sleep(nanoseconds: 300_000_000)

                try writeConfiguration(state: state)

                // Step 3: Install app bundle
                state.installStatus = "Installing OpenLink app..."
                state.installProgress = 0.5
                try await Task.sleep(nanoseconds: 500_000_000)

                try installAppBundle()

                // Step 4: Setup launch agent (if auto-start enabled)
                if state.enableAutoStart {
                    state.installStatus = "Configuring auto-start..."
                    state.installProgress = 0.7
                    try await Task.sleep(nanoseconds: 300_000_000)

                    try setupLaunchAgent()
                }

                // Step 5: Save paired server (if any)
                if let server = state.pairedServer {
                    state.installStatus = "Saving server configuration..."
                    state.installProgress = 0.85
                    try await Task.sleep(nanoseconds: 200_000_000)

                    try savePairedServer(server)
                }

                // Step 6: Complete
                state.installStatus = "Finalizing installation..."
                state.installProgress = 0.95
                try await Task.sleep(nanoseconds: 300_000_000)

                state.installProgress = 1.0
                state.installStatus = "Installation complete!"
                state.isInstalling = false

                // Move to complete step
                state.nextStep()

            } catch {
                state.installStatus = "Error: \(error.localizedDescription)"
                state.isInstalling = false
            }
        }
    }

    // MARK: - Installation Steps

    private func createDirectories() throws {
        // Create config directory
        if !fileManager.fileExists(atPath: configDirectory) {
            try fileManager.createDirectory(atPath: configDirectory, withIntermediateDirectories: true)
        }

        // Create launch agents directory if needed
        let launchAgentsDir = NSHomeDirectory() + "/Library/LaunchAgents"
        if !fileManager.fileExists(atPath: launchAgentsDir) {
            try fileManager.createDirectory(atPath: launchAgentsDir, withIntermediateDirectories: true)
        }
    }

    private func writeConfiguration(state: InstallerState) throws {
        let config = OpenLinkConfig(
            version: "1.0.0",
            connectionMode: state.connectionMode.rawValue,
            serverPort: state.serverPort,
            enableAutoStart: state.enableAutoStart,
            enableMenuBar: state.enableMenuBar,
            notificationStyle: state.notificationStyle.rawValue,
            installedAt: Date()
        )

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601

        let data = try encoder.encode(config)
        try data.write(to: URL(fileURLWithPath: configPath))
    }

    private func installAppBundle() throws {
        // In a real installer, this would copy the app bundle
        // For now, we'll create a placeholder structure
        let contentsPath = appBundlePath + "/Contents"
        let macOSPath = contentsPath + "/MacOS"
        let resourcesPath = contentsPath + "/Resources"

        // Remove existing installation
        if fileManager.fileExists(atPath: appBundlePath) {
            try fileManager.removeItem(atPath: appBundlePath)
        }

        // Create app bundle structure
        try fileManager.createDirectory(atPath: macOSPath, withIntermediateDirectories: true)
        try fileManager.createDirectory(atPath: resourcesPath, withIntermediateDirectories: true)

        // Write Info.plist
        let infoPlist = createInfoPlist()
        try infoPlist.write(toFile: contentsPath + "/Info.plist", atomically: true, encoding: .utf8)

        // Write PkgInfo
        try "APPL????".write(toFile: contentsPath + "/PkgInfo", atomically: true, encoding: .utf8)

        // The actual executable would be copied here in a real installer
        // For now, create a shell script placeholder
        let launchScript = """
        #!/bin/bash
        # OpenLink Menu Bar App
        # This is a placeholder - real binary would be here
        echo "OpenLink Service Running"
        """
        try launchScript.write(toFile: macOSPath + "/OpenLink", atomically: true, encoding: .utf8)

        // Make executable
        try fileManager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: macOSPath + "/OpenLink")
    }

    private func createInfoPlist() -> String {
        return """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
            <key>CFBundleDevelopmentRegion</key>
            <string>en</string>
            <key>CFBundleExecutable</key>
            <string>OpenLink</string>
            <key>CFBundleIconFile</key>
            <string>AppIcon</string>
            <key>CFBundleIdentifier</key>
            <string>app.openlink.service</string>
            <key>CFBundleInfoDictionaryVersion</key>
            <string>6.0</string>
            <key>CFBundleName</key>
            <string>OpenLink</string>
            <key>CFBundlePackageType</key>
            <string>APPL</string>
            <key>CFBundleShortVersionString</key>
            <string>1.0.0</string>
            <key>CFBundleVersion</key>
            <string>1</string>
            <key>LSApplicationCategoryType</key>
            <string>public.app-category.utilities</string>
            <key>LSMinimumSystemVersion</key>
            <string>12.0</string>
            <key>LSUIElement</key>
            <true/>
            <key>NSHighResolutionCapable</key>
            <true/>
            <key>NSHumanReadableCopyright</key>
            <string>Copyright 2026 VoiceLink. All rights reserved.</string>
        </dict>
        </plist>
        """
    }

    private func setupLaunchAgent() throws {
        let plist = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
            <key>Label</key>
            <string>app.openlink.agent</string>
            <key>ProgramArguments</key>
            <array>
                <string>/Applications/OpenLink.app/Contents/MacOS/OpenLink</string>
            </array>
            <key>RunAtLoad</key>
            <true/>
            <key>KeepAlive</key>
            <false/>
            <key>StandardErrorPath</key>
            <string>/tmp/openlink.err</string>
            <key>StandardOutPath</key>
            <string>/tmp/openlink.out</string>
        </dict>
        </plist>
        """

        try plist.write(toFile: launchAgentPath, atomically: true, encoding: .utf8)

        // Load the launch agent
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        task.arguments = ["load", launchAgentPath]
        try task.run()
    }

    private func savePairedServer(_ server: InstallerState.PairedServer) throws {
        let serversPath = configDirectory + "/servers.json"

        var servers: [InstallerState.PairedServer] = []

        // Load existing servers
        if let data = fileManager.contents(atPath: serversPath),
           let existing = try? JSONDecoder().decode([InstallerState.PairedServer].self, from: data) {
            servers = existing
        }

        // Add new server (or update existing)
        if let index = servers.firstIndex(where: { $0.id == server.id }) {
            servers[index] = server
        } else {
            servers.append(server)
        }

        // Save
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted]
        encoder.dateEncodingStrategy = .iso8601

        let data = try encoder.encode(servers)
        try data.write(to: URL(fileURLWithPath: serversPath))
    }

    // MARK: - Uninstall

    func uninstall() throws {
        // Remove app bundle
        if fileManager.fileExists(atPath: appBundlePath) {
            try fileManager.removeItem(atPath: appBundlePath)
        }

        // Unload and remove launch agent
        if fileManager.fileExists(atPath: launchAgentPath) {
            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
            task.arguments = ["unload", launchAgentPath]
            try? task.run()
            task.waitUntilExit()

            try fileManager.removeItem(atPath: launchAgentPath)
        }

        // Optionally remove config (ask user first in real implementation)
        // try fileManager.removeItem(atPath: configDirectory)
    }
}

// MARK: - Configuration Model

struct OpenLinkConfig: Codable {
    var version: String
    var connectionMode: String
    var serverPort: Int
    var enableAutoStart: Bool
    var enableMenuBar: Bool
    var notificationStyle: String
    var installedAt: Date

    // Settings that can be modified after installation
    var discoveryEnabled: Bool = true
    var discoveryTimeout: TimeInterval = 10.0
    var localNetworkProbe: Bool = true
    var webSocketKeepAlive: TimeInterval = 30.0
    var reconnectAttempts: Int = 3
    var reconnectDelay: TimeInterval = 5.0

    // Security settings
    var requireAuthentication: Bool = true
    var allowRemoteControl: Bool = true
    var trustedDevicesOnly: Bool = false
}

// MARK: - Settings Manager (Swift-native approach)

class OpenLinkSettings: ObservableObject {
    static let shared = OpenLinkSettings()

    private let configPath = NSHomeDirectory() + "/.openlink/config.json"
    private let userDefaults = UserDefaults(suiteName: "app.openlink.settings")

    @Published var config: OpenLinkConfig?

    init() {
        loadConfig()
    }

    func loadConfig() {
        guard let data = FileManager.default.contents(atPath: configPath) else { return }

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601

        config = try? decoder.decode(OpenLinkConfig.self, from: data)
    }

    func saveConfig() {
        guard let config = config else { return }

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601

        guard let data = try? encoder.encode(config) else { return }
        try? data.write(to: URL(fileURLWithPath: configPath))
    }

    // MARK: - Swift UserDefaults-based settings (for quick access)

    var connectionMode: String {
        get { userDefaults?.string(forKey: "connectionMode") ?? "Auto-Detect" }
        set {
            userDefaults?.set(newValue, forKey: "connectionMode")
            config?.connectionMode = newValue
            saveConfig()
        }
    }

    var serverPort: Int {
        get { userDefaults?.integer(forKey: "serverPort") ?? 3000 }
        set {
            userDefaults?.set(newValue, forKey: "serverPort")
            saveConfig()
        }
    }

    var discoveryEnabled: Bool {
        get { userDefaults?.bool(forKey: "discoveryEnabled") ?? true }
        set {
            userDefaults?.set(newValue, forKey: "discoveryEnabled")
            config?.discoveryEnabled = newValue
            saveConfig()
        }
    }

    var allowRemoteControl: Bool {
        get { userDefaults?.bool(forKey: "allowRemoteControl") ?? true }
        set {
            userDefaults?.set(newValue, forKey: "allowRemoteControl")
            config?.allowRemoteControl = newValue
            saveConfig()
        }
    }

    var trustedDevicesOnly: Bool {
        get { userDefaults?.bool(forKey: "trustedDevicesOnly") ?? false }
        set {
            userDefaults?.set(newValue, forKey: "trustedDevicesOnly")
            config?.trustedDevicesOnly = newValue
            saveConfig()
        }
    }

    // MARK: - Keychain for sensitive data

    func saveAccessToken(_ token: String, for serverId: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: "openlink-\(serverId)",
            kSecAttrService as String: "app.openlink.tokens",
            kSecValueData as String: token.data(using: .utf8)!
        ]

        SecItemDelete(query as CFDictionary)
        SecItemAdd(query as CFDictionary, nil)
    }

    func getAccessToken(for serverId: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: "openlink-\(serverId)",
            kSecAttrService as String: "app.openlink.tokens",
            kSecReturnData as String: true
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess,
              let data = result as? Data,
              let token = String(data: data, encoding: .utf8) else {
            return nil
        }

        return token
    }

    func deleteAccessToken(for serverId: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: "openlink-\(serverId)",
            kSecAttrService as String: "app.openlink.tokens"
        ]

        SecItemDelete(query as CFDictionary)
    }
}
