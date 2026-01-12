import SwiftUI

@main
struct OpenLinkApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        // Menu bar only app - no main window
        Settings {
            SettingsView()
        }
    }
}

// MARK: - App Delegate

class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?
    private var popover: NSPopover?

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupMenuBar()
        OpenLinkService.shared.start()
    }

    func applicationWillTerminate(_ notification: Notification) {
        OpenLinkService.shared.stop()
    }

    private func setupMenuBar() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        if let button = statusItem?.button {
            button.image = NSImage(systemSymbolName: "link.circle.fill", accessibilityDescription: "OpenLink")
            button.action = #selector(togglePopover)
        }

        popover = NSPopover()
        popover?.contentSize = NSSize(width: 320, height: 400)
        popover?.behavior = .transient
        popover?.contentViewController = NSHostingController(rootView: MenuBarView())
    }

    @objc func togglePopover() {
        guard let button = statusItem?.button else { return }

        if let popover = popover {
            if popover.isShown {
                popover.performClose(nil)
            } else {
                popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            }
        }
    }
}

// MARK: - Menu Bar View

struct MenuBarView: View {
    @StateObject private var service = OpenLinkService.shared
    @State private var showSettings = false

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Image(systemName: "link.circle.fill")
                    .font(.title2)
                    .foregroundStyle(
                        LinearGradient(
                            colors: [.blue, .purple],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )

                Text("OpenLink")
                    .font(.headline)

                Spacer()

                // Status indicator
                Circle()
                    .fill(service.isRunning ? Color.green : Color.gray)
                    .frame(width: 8, height: 8)
            }
            .padding()
            .background(Color.gray.opacity(0.1))

            // Status Section
            VStack(alignment: .leading, spacing: 12) {
                StatusRow(label: "Status", value: service.isRunning ? "Running" : "Stopped", color: service.isRunning ? .green : .gray)
                StatusRow(label: "Mode", value: service.connectionMode.rawValue, color: .blue)

                if let ip = service.localIP {
                    StatusRow(label: "Local IP", value: ip, color: .secondary)
                }

                StatusRow(label: "Port", value: "\(service.port)", color: .secondary)

                if service.connectedDevices > 0 {
                    StatusRow(label: "Connected", value: "\(service.connectedDevices) device(s)", color: .green)
                }
            }
            .padding()

            Divider()

            // Connected Servers
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Servers")
                        .font(.subheadline)
                        .fontWeight(.semibold)
                        .foregroundColor(.gray)

                    Spacer()

                    Button(action: { showSettings = true }) {
                        Image(systemName: "plus.circle")
                            .foregroundColor(.blue)
                    }
                    .buttonStyle(.plain)
                }

                if service.pairedServers.isEmpty {
                    Text("No servers paired")
                        .font(.caption)
                        .foregroundColor(.gray)
                        .padding(.vertical, 8)
                } else {
                    ForEach(service.pairedServers) { server in
                        ServerRow(server: server)
                    }
                }
            }
            .padding()

            Divider()

            // Actions
            HStack(spacing: 12) {
                Button(action: {
                    if service.isRunning {
                        service.stop()
                    } else {
                        service.start()
                    }
                }) {
                    Label(service.isRunning ? "Stop" : "Start",
                          systemImage: service.isRunning ? "stop.circle" : "play.circle")
                }
                .buttonStyle(.bordered)

                Spacer()

                Button(action: { showSettings = true }) {
                    Image(systemName: "gear")
                }
                .buttonStyle(.bordered)

                Button(action: {
                    NSApplication.shared.terminate(nil)
                }) {
                    Image(systemName: "power")
                }
                .buttonStyle(.bordered)
                .tint(.red)
            }
            .padding()
        }
        .frame(width: 320)
        .sheet(isPresented: $showSettings) {
            QuickSettingsView()
        }
    }
}

struct StatusRow: View {
    let label: String
    let value: String
    let color: Color

    var body: some View {
        HStack {
            Text(label)
                .foregroundColor(.gray)
            Spacer()
            Text(value)
                .fontWeight(.medium)
                .foregroundColor(color)
        }
        .font(.caption)
    }
}

struct ServerRow: View {
    let server: PairedServer
    @StateObject private var service = OpenLinkService.shared

    var body: some View {
        HStack {
            Circle()
                .fill(server.isOnline ? Color.green : Color.gray)
                .frame(width: 6, height: 6)

            VStack(alignment: .leading, spacing: 2) {
                Text(server.name)
                    .font(.caption)
                    .fontWeight(.medium)
                Text(server.url)
                    .font(.caption2)
                    .foregroundColor(.gray)
            }

            Spacer()

            Menu {
                Button("Connect") {
                    service.connectToServer(server)
                }
                Button("Test Connection") {
                    service.testConnection(server)
                }
                Divider()
                Button("Remove", role: .destructive) {
                    service.removeServer(server)
                }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .foregroundColor(.gray)
            }
            .menuStyle(.borderlessButton)
            .frame(width: 20)
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Quick Settings View

struct QuickSettingsView: View {
    @Environment(\.dismiss) var dismiss
    @StateObject private var service = OpenLinkService.shared
    @State private var pairingCode = ""

    var body: some View {
        VStack(spacing: 20) {
            // Header
            HStack {
                Text("Settings")
                    .font(.headline)
                Spacer()
                Button("Done") {
                    dismiss()
                }
                .buttonStyle(.bordered)
            }

            // Pair New Server
            GroupBox("Pair New Server") {
                VStack(alignment: .leading, spacing: 12) {
                    TextField("Pairing Code", text: $pairingCode)
                        .textFieldStyle(.roundedBorder)

                    Button("Pair") {
                        service.pairWithCode(pairingCode)
                        pairingCode = ""
                    }
                    .disabled(pairingCode.count != 6)
                }
                .padding(.vertical, 8)
            }

            // Connection Mode
            GroupBox("Connection Mode") {
                Picker("Mode", selection: $service.connectionMode) {
                    ForEach(ConnectionMode.allCases, id: \.self) { mode in
                        Text(mode.rawValue).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.vertical, 8)
            }

            // Options
            GroupBox("Options") {
                VStack(alignment: .leading, spacing: 8) {
                    Toggle("Auto-discovery", isOn: $service.discoveryEnabled)
                    Toggle("Allow remote control", isOn: $service.allowRemoteControl)
                    Toggle("Trusted devices only", isOn: $service.trustedDevicesOnly)
                }
                .padding(.vertical, 8)
            }

            Spacer()
        }
        .padding()
        .frame(width: 350, height: 400)
    }
}

// MARK: - Full Settings View (for Settings scene)

struct SettingsView: View {
    @StateObject private var service = OpenLinkService.shared

    var body: some View {
        TabView {
            GeneralSettingsTab()
                .tabItem {
                    Label("General", systemImage: "gear")
                }

            ConnectionSettingsTab()
                .tabItem {
                    Label("Connection", systemImage: "antenna.radiowaves.left.and.right")
                }

            ServersSettingsTab()
                .tabItem {
                    Label("Servers", systemImage: "server.rack")
                }

            SecuritySettingsTab()
                .tabItem {
                    Label("Security", systemImage: "lock.shield")
                }
        }
        .frame(width: 500, height: 400)
    }
}

struct GeneralSettingsTab: View {
    @AppStorage("launchAtLogin") private var launchAtLogin = true
    @AppStorage("showInDock") private var showInDock = false

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            // Startup section
            GroupBox("Startup") {
                VStack(alignment: .leading, spacing: 12) {
                    Toggle("Launch at login", isOn: $launchAtLogin)
                    Toggle("Show in Dock", isOn: $showInDock)
                }
                .padding(.vertical, 8)
            }

            // About section
            GroupBox("About") {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("Version")
                            .foregroundColor(.gray)
                        Spacer()
                        Text("1.0.0")
                    }
                    HStack {
                        Text("Build")
                            .foregroundColor(.gray)
                        Spacer()
                        Text("1")
                    }
                }
                .padding(.vertical, 8)
            }

            Spacer()
        }
        .padding()
    }
}

struct ConnectionSettingsTab: View {
    @StateObject private var service = OpenLinkService.shared
    @AppStorage("serverPort") private var serverPort = 3000
    @AppStorage("discoveryTimeout") private var discoveryTimeout = 10.0

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            // Connection Mode section
            GroupBox("Connection Mode") {
                Picker("Mode", selection: $service.connectionMode) {
                    ForEach(ConnectionMode.allCases, id: \.self) { mode in
                        Text(mode.rawValue).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.vertical, 8)

                Text(service.connectionMode.description)
                    .font(.caption)
                    .foregroundColor(.gray)
            }

            // Network section
            GroupBox("Network") {
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Text("Port:")
                        TextField("Port", value: $serverPort, formatter: NumberFormatter())
                            .textFieldStyle(.roundedBorder)
                            .frame(width: 80)
                    }

                    VStack(alignment: .leading, spacing: 4) {
                        Text("Discovery Timeout: \(Int(discoveryTimeout))s")
                        Slider(value: $discoveryTimeout, in: 5...30, step: 5)
                    }
                }
                .padding(.vertical, 8)
            }

            // Discovery section
            GroupBox("Discovery") {
                VStack(alignment: .leading, spacing: 12) {
                    Toggle("Enable auto-discovery", isOn: $service.discoveryEnabled)
                    Toggle("Probe local network", isOn: .constant(true))
                }
                .padding(.vertical, 8)
            }

            Spacer()
        }
        .padding()
    }
}

struct ServersSettingsTab: View {
    @StateObject private var service = OpenLinkService.shared
    @State private var showAddServer = false

    var body: some View {
        VStack {
            List {
                ForEach(service.pairedServers) { server in
                    HStack {
                        Circle()
                            .fill(server.isOnline ? Color.green : Color.gray)
                            .frame(width: 8, height: 8)

                        VStack(alignment: .leading) {
                            Text(server.name)
                                .fontWeight(.medium)
                            Text(server.url)
                                .font(.caption)
                                .foregroundColor(.gray)
                        }

                        Spacer()

                        Button(role: .destructive) {
                            service.removeServer(server)
                        } label: {
                            Image(systemName: "trash")
                        }
                        .buttonStyle(.borderless)
                    }
                }
            }

            HStack {
                Spacer()
                Button("Add Server...") {
                    showAddServer = true
                }
                .buttonStyle(.bordered)
            }
            .padding()
        }
        .sheet(isPresented: $showAddServer) {
            AddServerSheet()
        }
    }
}

struct AddServerSheet: View {
    @Environment(\.dismiss) var dismiss
    @StateObject private var service = OpenLinkService.shared
    @State private var pairingCode = ""
    @State private var manualURL = ""
    @State private var useManual = false

    var body: some View {
        VStack(spacing: 20) {
            Text("Add Server")
                .font(.headline)

            if useManual {
                TextField("Server URL", text: $manualURL)
                    .textFieldStyle(.roundedBorder)
            } else {
                TextField("Pairing Code", text: $pairingCode)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.title2, design: .monospaced))
            }

            Toggle("Enter URL manually", isOn: $useManual)

            HStack {
                Button("Cancel") {
                    dismiss()
                }
                .buttonStyle(.bordered)

                Button("Add") {
                    if useManual {
                        service.addServerManually(url: manualURL)
                    } else {
                        service.pairWithCode(pairingCode)
                    }
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
                .disabled(useManual ? manualURL.isEmpty : pairingCode.count != 6)
            }
        }
        .padding()
        .frame(width: 300)
    }
}

struct SecuritySettingsTab: View {
    @StateObject private var service = OpenLinkService.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            // Access Control section
            GroupBox("Access Control") {
                VStack(alignment: .leading, spacing: 12) {
                    Toggle("Require authentication", isOn: .constant(true))
                    Toggle("Allow remote control", isOn: $service.allowRemoteControl)
                    Toggle("Trusted devices only", isOn: $service.trustedDevicesOnly)
                }
                .padding(.vertical, 8)
            }

            // Encryption section
            GroupBox("Encryption") {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("Protocol")
                            .foregroundColor(.gray)
                        Spacer()
                        Text("TLS 1.3")
                    }
                    HStack {
                        Text("Cipher")
                            .foregroundColor(.gray)
                        Spacer()
                        Text("AES-256-GCM")
                    }
                }
                .padding(.vertical, 8)
            }

            Spacer()
        }
        .padding()
    }
}
