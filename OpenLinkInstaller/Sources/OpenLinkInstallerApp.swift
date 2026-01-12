import SwiftUI

@main
struct OpenLinkInstallerApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var installerState = InstallerState.shared

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(installerState)
                .frame(minWidth: 700, minHeight: 500)
        }
        .windowStyle(.hiddenTitleBar)
    }
}

// MARK: - App Delegate

class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // Center window on screen
        if let window = NSApplication.shared.windows.first {
            window.center()
            window.titlebarAppearsTransparent = true
            window.isMovableByWindowBackground = true
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }
}

// MARK: - Installer State

class InstallerState: ObservableObject {
    static let shared = InstallerState()

    // Installation steps
    @Published var currentStep: InstallerStep = .welcome
    @Published var isInstalling = false
    @Published var installProgress: Double = 0
    @Published var installStatus: String = ""

    // Configuration
    @Published var serverURL: String = ""
    @Published var serverPort: Int = 3000
    @Published var enableAutoStart: Bool = true
    @Published var enableMenuBar: Bool = true
    @Published var connectionMode: ConnectionMode = .auto
    @Published var notificationStyle: NotificationStyle = .notificationCenter

    // Server pairing
    @Published var pairingCode: String = ""
    @Published var isPairing = false
    @Published var pairedServer: PairedServer?

    // Installation paths
    let installPath = "/Applications/OpenLink.app"
    let launchAgentPath = "~/Library/LaunchAgents/app.openlink.agent.plist"
    let configPath = "~/.openlink/config.json"

    enum InstallerStep: Int, CaseIterable {
        case welcome = 0
        case license = 1
        case configuration = 2
        case serverPairing = 3
        case installation = 4
        case complete = 5

        var title: String {
            switch self {
            case .welcome: return "Welcome"
            case .license: return "License"
            case .configuration: return "Configuration"
            case .serverPairing: return "Server Pairing"
            case .installation: return "Installation"
            case .complete: return "Complete"
            }
        }

        var icon: String {
            switch self {
            case .welcome: return "hand.wave"
            case .license: return "doc.text"
            case .configuration: return "gear"
            case .serverPairing: return "link"
            case .installation: return "arrow.down.circle"
            case .complete: return "checkmark.circle"
            }
        }
    }

    enum ConnectionMode: String, CaseIterable {
        case auto = "Auto-Detect"
        case openLink = "OpenLink Tunnel"
        case directIP = "Direct IP"
        case hybrid = "Hybrid"

        var description: String {
            switch self {
            case .auto: return "Automatically select the best connection method"
            case .openLink: return "Always use secure OpenLink tunnel"
            case .directIP: return "Connect directly via IP when possible"
            case .hybrid: return "Try OpenLink first, fall back to direct IP"
            }
        }
    }

    enum NotificationStyle: String, CaseIterable {
        case alerts = "System Alerts"
        case notificationCenter = "Notification Center"

        var description: String {
            switch self {
            case .alerts: return "Show modal alerts when user input is required"
            case .notificationCenter: return "Push notifications to Notification Center"
            }
        }

        var icon: String {
            switch self {
            case .alerts: return "exclamationmark.bubble"
            case .notificationCenter: return "bell.badge"
            }
        }
    }

    struct PairedServer: Codable {
        let id: String
        let name: String
        let url: String
        let accessToken: String
        let pairedAt: Date
    }

    func nextStep() {
        if let currentIndex = InstallerStep.allCases.firstIndex(of: currentStep),
           currentIndex < InstallerStep.allCases.count - 1 {
            currentStep = InstallerStep.allCases[currentIndex + 1]
        }
    }

    func previousStep() {
        if let currentIndex = InstallerStep.allCases.firstIndex(of: currentStep),
           currentIndex > 0 {
            currentStep = InstallerStep.allCases[currentIndex - 1]
        }
    }

    func goToStep(_ step: InstallerStep) {
        currentStep = step
    }
}
