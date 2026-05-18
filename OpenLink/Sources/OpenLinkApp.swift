import SwiftUI
import ServiceManagement

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

class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem?
    private var popover: NSPopover?
    private var statusMenu: NSMenu?
    private var escapeMonitor: Any?

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
            button.setAccessibilityElement(true)
            button.setAccessibilityLabel("OpenLink status menu")
            button.setAccessibilityRole(.menuButton)
            button.setAccessibilityHelp("Opens OpenLink connection actions and machine status.")
        }

        let menu = NSMenu(title: "OpenLink status menu")
        menu.delegate = self
        statusMenu = menu
        statusItem?.menu = menu

        popover = NSPopover()
        popover?.contentSize = NSSize(width: 320, height: 400)
        popover?.behavior = .transient
        popover?.contentViewController = NSHostingController(rootView: MenuBarView())
        NotificationCenter.default.addObserver(self, selector: #selector(popoverDidClose), name: NSPopover.didCloseNotification, object: popover)
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        rebuildStatusMenu(menu)
    }

    @objc func togglePopover() {
        guard let button = statusItem?.button else { return }

        if let popover = popover {
            if popover.isShown {
                popover.performClose(nil)
            } else {
                popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
                installEscapeMonitor()
            }
        }
    }

    @objc private func popoverDidClose() {
        removeEscapeMonitor()
    }

    private func installEscapeMonitor() {
        removeEscapeMonitor()
        escapeMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.keyCode == 53 {
                self?.popover?.performClose(nil)
                return nil
            }
            return event
        }
    }

    private func removeEscapeMonitor() {
        if let escapeMonitor {
            NSEvent.removeMonitor(escapeMonitor)
            self.escapeMonitor = nil
        }
    }

    private func rebuildStatusMenu(_ menu: NSMenu) {
        let service = OpenLinkService.shared
        menu.removeAllItems()

        addDisabledItem("OpenLink, \(service.isRunning ? "running" : "stopped")", to: menu)
        addDisabledItem(service.serviceHealthText, to: menu)
        addDisabledItem(service.connectionStrengthText, to: menu)
        if service.hasActiveMachineConnection && UserDefaults.standard.bool(forKey: "showElapsedConnectionTime") {
            addDisabledItem(service.elapsedConnectionText, to: menu)
        }
        menu.addItem(.separator())

        addActionItem(
            service.isRunning ? "Stop OpenLink" : "Start OpenLink",
            action: #selector(toggleServiceFromMenu(_:)),
            to: menu,
            help: service.isRunning ? "Stops OpenLink hosting and active local connections." : "Starts OpenLink hosting and machine monitoring."
        )
        addActionItem(
            "Refresh connection health",
            action: #selector(refreshHealthFromMenu(_:)),
            to: menu,
            help: "Checks OpenLink backend health and signal strength."
        )

        menu.addItem(.separator())
        addDisabledItem("Machines", to: menu)
        if service.machines.isEmpty {
            addDisabledItem("No machines connected yet", to: menu)
        } else {
            for machine in service.machines {
                addMachineMenuItem(machine, to: menu)
            }
        }

        menu.addItem(.separator())
        addActionItem(
            "Disconnect Remote User from This Device",
            action: #selector(disconnectRemoteUserFromMenu(_:)),
            to: menu,
            help: "On this Mac, disconnects the remote user connected to this device."
        )
        addActionItem(
            "Open Settings",
            action: #selector(openSettingsFromMenu(_:)),
            to: menu,
            help: "Opens OpenLink settings."
        )
        addActionItem(
            "Quit OpenLink",
            action: #selector(quitFromMenu(_:)),
            to: menu,
            help: "Quits OpenLink."
        )
    }

    private func addMachineMenuItem(_ machine: OpenLinkMachine, to menu: NSMenu) {
        let title = "\(machine.displayName), \(machine.isOnline ? "online" : "offline")"
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.toolTip = machine.accessibilitySummary
        item.submenu = buildMachineSubmenu(for: machine)
        menu.addItem(item)
    }

    private func buildMachineSubmenu(for machine: OpenLinkMachine) -> NSMenu {
        let service = OpenLinkService.shared
        let submenu = NSMenu(title: "Actions for \(machine.displayName)")
        addDisabledItem(machine.accessibilitySummary, to: submenu)
        submenu.addItem(.separator())

        if machine.isOnline || service.hasActiveMachineConnection {
            addMachineActionItem("Start Using \(machine.displayName)", machine: machine, action: #selector(startUsingMachineFromMenu(_:)), to: submenu, enabled: service.isConnectableMachine(machine), help: "Starts full keyboard control and remote audio for \(machine.displayName).")
        } else {
            addMachineActionItem("Connect", machine: machine, action: #selector(connectMachineFromMenu(_:)), to: submenu, enabled: service.isConnectableMachine(machine), help: "Connects to \(machine.displayName).")
            addMachineActionItem("Drop-In Connect", machine: machine, action: #selector(dropInConnectMachineFromMenu(_:)), to: submenu, enabled: service.isConnectableMachine(machine), help: "Connects to \(machine.displayName) using allowed drop-in access.")
        }

        submenu.addItem(.separator())
        addMachineActionItem("Minimize Remote Connection to Use Local Machine", machine: machine, action: #selector(minimizeRemoteFromMenu(_:)), to: submenu, enabled: machine.isOnline || service.hasActiveMachineConnection, help: "Pauses active remote interaction and returns focus to this Mac.")
        addMachineActionItem("Disconnect from \(machine.displayName)", machine: machine, action: #selector(disconnectFromMachineFromMenu(_:)), to: submenu, enabled: machine.isOnline || service.hasActiveMachineConnection, help: "Disconnects this Mac from \(machine.displayName).")
        addMachineActionItem("Disconnect Remote User from This Device", machine: machine, action: #selector(disconnectMachineFromMenu(_:)), to: submenu, enabled: true, help: "On the controlled computer, disconnects the remote user.")
        addMachineActionItem("Swap Control", machine: machine, action: #selector(swapControlFromMenu(_:)), to: submenu, enabled: service.isConnectableMachine(machine), help: "Allows bidirectional control while both keyboards remain available.")

        submenu.addItem(.separator())
        addMachineActionItem("Microphone Audio", machine: machine, action: #selector(toggleMicrophoneAudioFromMenu(_:)), to: submenu, enabled: true, state: machine.allowMicrophoneAudio ? .on : .off, help: "Toggles microphone audio for \(machine.displayName).")
        addMachineActionItem("System Audio", machine: machine, action: #selector(toggleSystemAudioFromMenu(_:)), to: submenu, enabled: true, state: machine.allowSystemAudio ? .on : .off, help: "Toggles system audio for \(machine.displayName).")
        return submenu
    }

    private func addDisabledItem(_ title: String, to menu: NSMenu) {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        item.toolTip = title
        menu.addItem(item)
    }

    @discardableResult
    private func addActionItem(_ title: String, action: Selector, to menu: NSMenu, help: String? = nil) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        item.toolTip = help ?? title
        menu.addItem(item)
        return item
    }

    @discardableResult
    private func addMachineActionItem(_ title: String, machine: OpenLinkMachine, action: Selector, to menu: NSMenu, enabled: Bool, state: NSControl.StateValue = .off, help: String? = nil) -> NSMenuItem {
        let item = addActionItem(title, action: action, to: menu, help: help)
        item.representedObject = machine.id
        item.isEnabled = enabled
        item.state = state
        return item
    }

    private func machine(from sender: Any?) -> OpenLinkMachine? {
        guard
            let item = sender as? NSMenuItem,
            let id = item.representedObject as? String
        else {
            return nil
        }
        return OpenLinkService.shared.machine(id: id)
    }

    @objc private func toggleServiceFromMenu(_ sender: NSMenuItem) {
        let service = OpenLinkService.shared
        service.isRunning ? service.stop() : service.start()
    }

    @objc private func refreshHealthFromMenu(_ sender: NSMenuItem) {
        OpenLinkService.shared.refreshServiceHealth()
    }

    @objc private func connectMachineFromMenu(_ sender: NSMenuItem) {
        guard let machine = machine(from: sender) else { return }
        OpenLinkService.shared.connectToMachine(machine, dropIn: false)
    }

    @objc private func dropInConnectMachineFromMenu(_ sender: NSMenuItem) {
        guard let machine = machine(from: sender) else { return }
        OpenLinkService.shared.connectToMachine(machine, dropIn: true)
    }

    @objc private func startUsingMachineFromMenu(_ sender: NSMenuItem) {
        guard let machine = machine(from: sender) else { return }
        OpenLinkService.shared.startUsingMachine(machine)
    }

    @objc private func minimizeRemoteFromMenu(_ sender: NSMenuItem) {
        guard let machine = machine(from: sender) else { return }
        OpenLinkService.shared.minimizeRemoteForLocalUse(machine)
    }

    @objc private func disconnectFromMachineFromMenu(_ sender: NSMenuItem) {
        guard let machine = machine(from: sender) else { return }
        OpenLinkService.shared.disconnectFromMachine(machine)
    }

    @objc private func disconnectMachineFromMenu(_ sender: NSMenuItem) {
        guard let machine = machine(from: sender) else { return }
        OpenLinkService.shared.disconnectMachine(machine)
    }

    @objc private func disconnectRemoteUserFromMenu(_ sender: NSMenuItem) {
        let service = OpenLinkService.shared
        if let machine = service.machines.first(where: { $0.isOnline }) ?? service.machines.first {
            service.disconnectMachine(machine)
        } else {
            service.stop()
        }
    }

    @objc private func swapControlFromMenu(_ sender: NSMenuItem) {
        guard let machine = machine(from: sender) else { return }
        OpenLinkService.shared.swapControl(with: machine)
    }

    @objc private func toggleMicrophoneAudioFromMenu(_ sender: NSMenuItem) {
        guard let machine = machine(from: sender) else { return }
        OpenLinkService.shared.setMicrophoneAudio(for: machine, enabled: sender.state != .on)
    }

    @objc private func toggleSystemAudioFromMenu(_ sender: NSMenuItem) {
        guard let machine = machine(from: sender) else { return }
        OpenLinkService.shared.setSystemAudio(for: machine, enabled: sender.state != .on)
    }

    @objc private func openSettingsFromMenu(_ sender: NSMenuItem) {
        NSApplication.shared.activate(ignoringOtherApps: true)
        if !NSApplication.shared.sendAction(Selector(("showSettingsWindow:")), to: nil, from: sender) {
            NSApplication.shared.sendAction(Selector(("showPreferencesWindow:")), to: nil, from: sender)
        }
    }

    @objc private func quitFromMenu(_ sender: NSMenuItem) {
        NSApplication.shared.terminate(nil)
    }
}

// MARK: - Menu Bar View

struct MenuBarView: View {
    @StateObject private var service = OpenLinkService.shared
    @State private var showSettings = false
    private var compactActionsOnly: Bool {
        service.hasActiveMachineConnection
    }

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
                StatusRow(label: "Health", value: service.serviceHealthText.replacingOccurrences(of: "Connection health: ", with: ""), color: service.serviceOnline ? .green : .red)
                StatusRow(label: "Signal", value: service.connectionStrengthText.replacingOccurrences(of: "Signal strength: ", with: ""), color: service.serviceOnline ? .green : .red)
                if service.hasActiveMachineConnection && UserDefaults.standard.bool(forKey: "showElapsedConnectionTime") {
                    StatusRow(label: "Elapsed", value: service.elapsedConnectionText.replacingOccurrences(of: "Connected to ", with: ""), color: .secondary)
                }
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

            // Machines
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Machines")
                        .font(.subheadline)
                        .fontWeight(.semibold)
                        .foregroundColor(.gray)

                    Spacer()

                    if !compactActionsOnly {
                        Button(action: { showSettings = true }) {
                            Image(systemName: "plus.circle")
                                .foregroundColor(.blue)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Add machine")
                        .accessibilityHint("Opens settings to pair or manage machines.")
                    }
                }

                if service.machines.isEmpty {
                    Text("No machines connected yet")
                        .font(.caption)
                        .foregroundColor(.gray)
                        .padding(.vertical, 8)
                } else {
                    ForEach(service.machines) { machine in
                        MachineRow(machine: machine)
                    }
                }
            }
            .padding()

            Divider()

            // Actions
            HStack(spacing: 12) {
                Button(action: {
                    service.refreshServiceHealth()
                }) {
                    Image(systemName: service.serviceOnline ? "checkmark.circle" : "exclamationmark.triangle")
                }
                .buttonStyle(.bordered)
                .help(service.serviceHealthText)
                .accessibilityLabel(service.serviceHealthText)

                if !compactActionsOnly {
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
                }

                Spacer()

                Button(action: {
                    if let machine = service.machines.first(where: { $0.isOnline }) ?? service.machines.first {
                        service.disconnectMachine(machine)
                    } else {
                        service.stop()
                    }
                }) {
                    Image(systemName: "person.crop.circle.badge.xmark")
                }
                .buttonStyle(.bordered)
                .help("Disconnect user")
                .accessibilityLabel("Disconnect user")

                if !compactActionsOnly {
                    Button(action: { showSettings = true }) {
                        Image(systemName: "gear")
                    }
                    .buttonStyle(.bordered)
                    .accessibilityLabel("Settings")
                }

                Button(action: {
                    NSApplication.shared.terminate(nil)
                }) {
                    Image(systemName: "power")
                }
                .buttonStyle(.bordered)
                .tint(.red)
                .accessibilityLabel("Quit OpenLink")
            }
            .padding()
        }
        .frame(width: 320)
        .sheet(isPresented: $showSettings) {
            QuickSettingsView()
        }
        .onChange(of: compactActionsOnly) { isCompact in
            if isCompact {
                showSettings = false
            }
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
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(label): \(value)")
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

struct MachineRow: View {
    let machine: OpenLinkMachine
    @StateObject private var service = OpenLinkService.shared

    var body: some View {
        HStack {
            Circle()
                .fill(machine.isOnline ? Color.green : Color.gray)
                .frame(width: 6, height: 6)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text(machine.displayName)
                    .font(.caption)
                    .fontWeight(.medium)
                Text(machine.machineHostname)
                    .font(.caption2)
                    .foregroundColor(.gray)
                Text("\(machine.lastConnectedText) for \(machine.lastDurationText)")
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }

            Spacer()

            Text(machine.dropInText)
                .font(.caption2)
                .foregroundColor(machine.allowDropIn ? .green : .secondary)

            Menu {
                if machine.isOnline || service.hasActiveMachineConnection {
                    Button("Start Using \(machine.displayName)") {
                        service.startUsingMachine(machine)
                    }
                    .disabled(!service.isConnectableMachine(machine))
                } else {
                    Button("Connect") {
                        service.connectToMachine(machine, dropIn: false)
                    }
                    .disabled(!service.isConnectableMachine(machine))
                    Button("Drop-In Connect") {
                        service.connectToMachine(machine, dropIn: true)
                    }
                    .disabled(!service.isConnectableMachine(machine))
                }
                Divider()
                if machine.isOnline {
                    Button("Minimize Remote Connection to Use Local Machine") {
                        service.minimizeRemoteForLocalUse(machine)
                    }
                    Button("Disconnect from \(machine.displayName)") {
                        service.disconnectFromMachine(machine)
                    }
                    Button("Disconnect Remote User from This Device") {
                        service.disconnectMachine(machine)
                    }
                }
                Button("Swap Control") {
                    service.swapControl(with: machine)
                }
                Divider()
                Toggle("Microphone Audio", isOn: Binding(
                    get: { service.machine(id: machine.id)?.allowMicrophoneAudio ?? machine.allowMicrophoneAudio },
                    set: { service.setMicrophoneAudio(for: machine, enabled: $0) }
                ))
                Toggle("System Audio", isOn: Binding(
                    get: { service.machine(id: machine.id)?.allowSystemAudio ?? machine.allowSystemAudio },
                    set: { service.setSystemAudio(for: machine, enabled: $0) }
                ))
            } label: {
                Image(systemName: "ellipsis.circle")
                    .foregroundColor(.gray)
            }
            .menuStyle(.borderlessButton)
            .frame(width: 20)
            .accessibilityLabel("Actions for \(machine.displayName)")
            .accessibilityHint("Shows connect, drop-in, disconnect, swap control, and audio actions.")
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .onTapGesture {
            service.connectToMachine(machine, dropIn: machine.allowDropIn)
        }
        .contextMenu {
            if machine.isOnline || service.hasActiveMachineConnection {
                Button("Start Using \(machine.displayName)") { service.startUsingMachine(machine) }
                    .disabled(!service.isConnectableMachine(machine))
            } else {
                Button("Connect") { service.connectToMachine(machine, dropIn: false) }
                    .disabled(!service.isConnectableMachine(machine))
                Button("Drop-In Connect") { service.connectToMachine(machine, dropIn: true) }
                    .disabled(!service.isConnectableMachine(machine))
            }
            if machine.isOnline {
                Button("Minimize Remote Connection to Use Local Machine") { service.minimizeRemoteForLocalUse(machine) }
                Button("Disconnect from \(machine.displayName)") { service.disconnectFromMachine(machine) }
                Button("Disconnect Remote User from This Device") { service.disconnectMachine(machine) }
            }
            Button("Swap Control") { service.swapControl(with: machine) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(machine.accessibilitySummary)
        .accessibilityHint(service.isConnectableMachine(machine) ? "Press to connect. Open the actions menu for drop-in, disconnect, swap control, and audio." : "This is the current device and cannot connect to itself.")
    }
}

// MARK: - Quick Settings View

struct QuickSettingsView: View {
    @Environment(\.dismiss) var dismiss
    @StateObject private var service = OpenLinkService.shared
    @State private var pairingCode = ""

    var body: some View {
        if service.hasActiveMachineConnection {
            ActiveSessionActionsView()
        } else {
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
}

// MARK: - Full Settings View (for Settings scene)

struct SettingsView: View {
    @StateObject private var service = OpenLinkService.shared

    var body: some View {
        if service.hasActiveMachineConnection {
            ActiveSessionActionsView()
                .frame(width: 500, height: 320)
        } else {
        TabView {
            GeneralSettingsTab()
                .tabItem {
                    Label("General", systemImage: "gear")
                }

            ConnectionSettingsTab()
                .tabItem {
                    Label("Connection", systemImage: "antenna.radiowaves.left.and.right")
                }

            MachinesSettingsTab()
                .tabItem {
                    Label("Machines", systemImage: "desktopcomputer")
                }

            SecuritySettingsTab()
                .tabItem {
                    Label("Security", systemImage: "lock.shield")
                }
        }
        .frame(width: 500, height: 400)
        }
    }
}

struct ActiveSessionActionsView: View {
    @StateObject private var service = OpenLinkService.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("OpenLink Actions")
                .font(.headline)

            if service.machines.filter({ $0.isOnline }).isEmpty {
                Button {
                    service.stop()
                } label: {
                    Label("Disconnect User", systemImage: "person.crop.circle.badge.xmark")
                }
                .buttonStyle(.borderedProminent)
            } else {
                ForEach(service.machines.filter { $0.isOnline }) { machine in
                    MachineActionPanel(machine: machine)
                }
            }

            Spacer()
        }
        .padding()
        .accessibilityLabel("OpenLink active session actions")
    }
}

struct MachineActionPanel: View {
    let machine: OpenLinkMachine
    @StateObject private var service = OpenLinkService.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(machine.displayName)
                .font(.subheadline)
                .fontWeight(.semibold)
            Text(machine.domainUsed)
                .font(.caption)
                .foregroundColor(.secondary)

            HStack {
                Button {
                    service.disconnectMachine(machine)
                } label: {
                    Label("Disconnect User", systemImage: "person.crop.circle.badge.xmark")
                }
                .buttonStyle(.borderedProminent)

                Button {
                    service.swapControl(with: machine)
                } label: {
                    Label("Swap Control", systemImage: "arrow.left.arrow.right")
                }
                .buttonStyle(.bordered)
            }

            HStack {
                Toggle("Microphone Audio", isOn: Binding(
                    get: { service.machine(id: machine.id)?.allowMicrophoneAudio ?? machine.allowMicrophoneAudio },
                    set: { service.setMicrophoneAudio(for: machine, enabled: $0) }
                ))

                Toggle("System Audio", isOn: Binding(
                    get: { service.machine(id: machine.id)?.allowSystemAudio ?? machine.allowSystemAudio },
                    set: { service.setSystemAudio(for: machine, enabled: $0) }
                ))
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(machine.accessibilitySummary). Actions available: disconnect user, swap control, microphone audio, and system audio.")
    }
}

struct GeneralSettingsTab: View {
    @AppStorage("launchAtLogin") private var launchAtLogin = true
    @AppStorage("startMinimizedStatusMenu") private var startMinimizedStatusMenu = true
    @AppStorage("autoReconnectOnLaunch") private var autoReconnectOnLaunch = true
    @AppStorage("autoStartInteractionOnConnect") private var autoStartInteractionOnConnect = true
    @AppStorage("showInDock") private var showInDock = false
    @AppStorage("showOnlineOfflineNotifications") private var showOnlineOfflineNotifications = true
    @AppStorage("showConnectionNotifications") private var showConnectionNotifications = true
    @AppStorage("showElapsedConnectionTime") private var showElapsedConnectionTime = true
    @AppStorage("announceConnectionStrength") private var announceConnectionStrength = true
    @AppStorage("autoMuteRemoteAudio") private var autoMuteRemoteAudio = false
    @AppStorage("autoMutedProcesses") private var autoMutedProcesses = "VoiceOver, Music"

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            // Startup section
            GroupBox("Startup") {
                VStack(alignment: .leading, spacing: 12) {
                    Toggle("Launch at login", isOn: $launchAtLogin)
                    Toggle("Start minimized to status menu", isOn: $startMinimizedStatusMenu)
                    Toggle("Auto-reconnect trusted machines on launch", isOn: $autoReconnectOnLaunch)
                    Toggle("Start using a device immediately after connecting", isOn: $autoStartInteractionOnConnect)
                    Toggle("Show in Dock", isOn: $showInDock)
                }
                .padding(.vertical, 8)
            }

            GroupBox("Connection Status") {
                VStack(alignment: .leading, spacing: 12) {
                    Toggle("Show online and offline notifications", isOn: $showOnlineOfflineNotifications)
                    Toggle("Show device connection notifications", isOn: $showConnectionNotifications)
                    Toggle("Show elapsed connection time", isOn: $showElapsedConnectionTime)
                    Toggle("Announce connection strength before connecting", isOn: $announceConnectionStrength)
                }
                .padding(.vertical, 8)
            }

            GroupBox("Remote Audio") {
                VStack(alignment: .leading, spacing: 12) {
                    Toggle("Ask controlled computer to auto-mute audio on connect", isOn: $autoMuteRemoteAudio)
                    TextField("Auto-muted process names", text: $autoMutedProcesses)
                        .textFieldStyle(.roundedBorder)
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
        .onAppear {
            configureMacLaunchAtLogin(launchAtLogin)
        }
        .onChange(of: launchAtLogin) { enabled in
            configureMacLaunchAtLogin(enabled)
        }
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

private func configureMacLaunchAtLogin(_ enabled: Bool) {
    if #available(macOS 13.0, *) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            NSLog("OpenLink launch-at-login update failed: \(error.localizedDescription)")
        }
    }
}

struct MachinesSettingsTab: View {
    @StateObject private var service = OpenLinkService.shared
    @State private var showAddServer = false

    var body: some View {
        VStack {
            List {
                ForEach(service.machines) { machine in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Circle()
                                .fill(machine.isOnline ? Color.green : Color.gray)
                                .frame(width: 8, height: 8)
                                .accessibilityHidden(true)

                            VStack(alignment: .leading) {
                                Text(machine.displayName)
                                    .fontWeight(.medium)
                                Text(machine.domainUsed)
                                    .font(.caption)
                                    .foregroundColor(.gray)
                            }

                            Spacer()

                            Menu {
                                Button("Connect") { service.connectToMachine(machine, dropIn: false) }
                                    .disabled(!service.isConnectableMachine(machine))
                                Button("Drop-In Connect") { service.connectToMachine(machine, dropIn: true) }
                                    .disabled(!service.isConnectableMachine(machine))
                                Button("Disconnect User") { service.disconnectMachine(machine) }
                                Button("Swap Control") { service.swapControl(with: machine) }
                                Divider()
                                Toggle("Microphone Audio", isOn: Binding(
                                    get: { service.machine(id: machine.id)?.allowMicrophoneAudio ?? machine.allowMicrophoneAudio },
                                    set: { service.setMicrophoneAudio(for: machine, enabled: $0) }
                                ))
                                Toggle("System Audio", isOn: Binding(
                                    get: { service.machine(id: machine.id)?.allowSystemAudio ?? machine.allowSystemAudio },
                                    set: { service.setSystemAudio(for: machine, enabled: $0) }
                                ))
                            } label: {
                                Image(systemName: "ellipsis.circle")
                            }
                            .menuStyle(.borderlessButton)
                            .accessibilityLabel("Actions for \(machine.displayName)")
                        }

                        Text("\(machine.dropInText). Last connected \(machine.lastConnectedText) for \(machine.lastDurationText). \(machine.audioText).")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(machine.accessibilitySummary)
                }
            }

            HStack {
                Spacer()
                Button("Add Machine...") {
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
