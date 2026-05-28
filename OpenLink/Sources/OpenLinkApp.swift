import SwiftUI
import ServiceManagement

@main
struct OpenLinkApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        Settings {
            SettingsView()
        }
        .commands {
            CommandGroup(replacing: .appSettings) {
                Button("Settings") {
                    openOpenLinkSettings()
                }
                .keyboardShortcut(",", modifiers: [.command])
            }
            CommandMenu("File") {
                Button("What is New") {
                    openWhatIsNew()
                }
            }
        }
    }
}

extension Notification.Name {
    static let openOpenLinkSettingsWindow = Notification.Name("openOpenLinkSettingsWindow")
    static let openOpenLinkWhatIsNewWindow = Notification.Name("openOpenLinkWhatIsNewWindow")
}

private func openOpenLinkSettings() {
    NSApplication.shared.activate(ignoringOtherApps: true)
    NotificationCenter.default.post(name: .openOpenLinkSettingsWindow, object: nil)
}

private func openWhatIsNew() {
    NSApplication.shared.activate(ignoringOtherApps: true)
    NotificationCenter.default.post(name: .openOpenLinkWhatIsNewWindow, object: nil)
}

private func minimizeOpenLinkMainWindow() {
    NSApplication.shared.keyWindow?.orderOut(nil)
    NSApplication.shared.hide(nil)
}

// MARK: - App Delegate

class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, NSWindowDelegate {
    private var statusItem: NSStatusItem?
    private var popover: NSPopover?
    private var statusMenu: NSMenu?
    private var escapeMonitor: Any?
    private var mainWindow: NSWindow?
    private var settingsWindow: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApplication.shared.setActivationPolicy(.regular)
        NotificationCenter.default.addObserver(self, selector: #selector(openSettingsWindowFromNotification(_:)), name: .openOpenLinkSettingsWindow, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(openWhatIsNewWindowFromNotification(_:)), name: .openOpenLinkWhatIsNewWindow, object: nil)
        setupMenuBar()
        OpenLinkService.shared.start()
        configureMacLaunchAtLogin(UserDefaults.standard.bool(forKey: "launchAtLogin"))
        OpenLinkUpdater.shared.checkAutomatically()
        showPendingWhatIsNewIfNeeded()
        if !UserDefaults.standard.bool(forKey: "startMinimizedStatusMenu") {
            showMainWindow()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        NotificationCenter.default.removeObserver(self)
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
            "Open OpenLink",
            action: #selector(openMainWindowFromMenu(_:)),
            to: menu,
            help: "Opens the main OpenLink window with status and connection actions."
        )
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
        addRecentConnectionsMenu(to: menu)

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
            "What is New",
            action: #selector(openWhatIsNewFromMenu(_:)),
            to: menu,
            help: "Opens the latest OpenLink release notes."
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

        let hasRemoteSession = service.hasConnectedRemoteSession(with: machine)
        if hasRemoteSession {
            addMachineActionItem("Start Using \(machine.displayName)", machine: machine, action: #selector(startUsingMachineFromMenu(_:)), to: submenu, enabled: service.isConnectableMachine(machine), help: "Starts full keyboard control and remote audio for \(machine.displayName).")
        } else {
            let autoStartsInteraction = UserDefaults.standard.bool(forKey: "autoStartInteractionOnConnect")
            if !autoStartsInteraction {
                addMachineActionItem("Connect", machine: machine, action: #selector(connectMachineFromMenu(_:)), to: submenu, enabled: service.isConnectableMachine(machine), help: "Connects to \(machine.displayName) in the background without starting keyboard control.")
            }
            addMachineActionItem("Start Using \(machine.displayName)", machine: machine, action: #selector(startUsingMachineFromMenu(_:)), to: submenu, enabled: service.isConnectableMachine(machine), help: "Connects and starts full keyboard control and remote audio for \(machine.displayName).")
            if !autoStartsInteraction {
                addMachineActionItem("Drop-In Connect", machine: machine, action: #selector(dropInConnectMachineFromMenu(_:)), to: submenu, enabled: service.isConnectableMachine(machine), help: "Connects to \(machine.displayName) using allowed drop-in access.")
            }
        }

        if hasRemoteSession {
            submenu.addItem(.separator())
            addMachineActionItem("Minimize Remote Connection to Use Local Machine", machine: machine, action: #selector(minimizeRemoteFromMenu(_:)), to: submenu, enabled: true, help: "Pauses active remote interaction and returns focus to this Mac.")
            addMachineActionItem("Disconnect from \(machine.displayName)", machine: machine, action: #selector(disconnectFromMachineFromMenu(_:)), to: submenu, enabled: true, help: "Disconnects this Mac from \(machine.displayName).")
        }
        submenu.addItem(.separator())
        addMachineActionItem("Disconnect Remote User from This Device", machine: machine, action: #selector(disconnectMachineFromMenu(_:)), to: submenu, enabled: true, help: "On the controlled computer, disconnects the remote user.")
        addMachineActionItem("Swap Control", machine: machine, action: #selector(swapControlFromMenu(_:)), to: submenu, enabled: service.isConnectableMachine(machine), help: "Allows bidirectional control while both keyboards remain available.")
        addMachineActionItem("Open Remote Settings", machine: machine, action: #selector(openRemoteSettingsFromMenu(_:)), to: submenu, enabled: service.isConnectableMachine(machine), help: "Opens OpenLink settings on \(machine.displayName) when this computer is trusted or owned.")

        if hasRemoteSession {
            submenu.addItem(.separator())
            addMachineActionItem("Microphone Audio", machine: machine, action: #selector(toggleMicrophoneAudioFromMenu(_:)), to: submenu, enabled: true, state: machine.allowMicrophoneAudio ? .on : .off, help: "Toggles microphone audio for \(machine.displayName).")
            addMachineActionItem("System Audio", machine: machine, action: #selector(toggleSystemAudioFromMenu(_:)), to: submenu, enabled: true, state: machine.allowSystemAudio ? .on : .off, help: "Toggles system audio for \(machine.displayName).")
        }
        return submenu
    }

    private func addRecentConnectionsMenu(to menu: NSMenu) {
        let recentMachines = OpenLinkService.shared.recentConnectableMachines()
        guard !recentMachines.isEmpty else { return }

        let item = NSMenuItem(title: "Recent Connections", action: nil, keyEquivalent: "")
        item.toolTip = "Recently connected OpenLink machines"
        let submenu = NSMenu(title: "Recent Connections")
        for machine in recentMachines {
            addMachineActionItem("Connect to \(machine.displayName)", machine: machine, action: #selector(connectMachineFromMenu(_:)), to: submenu, enabled: OpenLinkService.shared.isConnectableMachine(machine), help: "Connects to \(machine.displayName).")
        }
        item.submenu = submenu
        menu.addItem(item)
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

    private func showMainWindow() {
        if let mainWindow {
            if mainWindow.isMiniaturized {
                mainWindow.deminiaturize(nil)
            }
            mainWindow.orderFrontRegardless()
            mainWindow.makeKeyAndOrderFront(nil)
            NSApplication.shared.activate(ignoringOtherApps: true)
            return
        }

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 860, height: 620),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "OpenLink"
        window.contentMinSize = NSSize(width: 720, height: 520)
        window.contentViewController = NSHostingController(rootView: OpenLinkMainWindowView())
        window.center()
        window.collectionBehavior.insert(.moveToActiveSpace)
        window.isReleasedWhenClosed = false
        window.delegate = self
        mainWindow = window
        window.orderFrontRegardless()
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    private func showSettingsWindow() {
        if let settingsWindow {
            if settingsWindow.isMiniaturized {
                settingsWindow.deminiaturize(nil)
            }
            settingsWindow.orderFrontRegardless()
            settingsWindow.makeKeyAndOrderFront(nil)
            NSApplication.shared.activate(ignoringOtherApps: true)
            return
        }

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 820, height: 680),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "OpenLink Settings"
        window.contentMinSize = NSSize(width: 720, height: 560)
        window.contentViewController = NSHostingController(rootView: SettingsView())
        window.center()
        window.collectionBehavior.insert(.moveToActiveSpace)
        window.isReleasedWhenClosed = false
        window.delegate = self
        settingsWindow = window
        window.orderFrontRegardless()
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        if sender == mainWindow {
            NSApplication.shared.hide(nil)
        }
        return false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            showMainWindow()
        }
        return true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if tamperProtectionBlocksQuit() {
            showTamperProtectionAlert()
            return .terminateCancel
        }

        return .terminateNow
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

    @objc private func openMainWindowFromMenu(_ sender: NSMenuItem) {
        showMainWindow()
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

    @objc private func openRemoteSettingsFromMenu(_ sender: NSMenuItem) {
        guard let machine = machine(from: sender) else { return }
        OpenLinkService.shared.openRemoteSettings(for: machine)
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
        openOpenLinkSettings()
    }

    @objc private func openWhatIsNewFromMenu(_ sender: NSMenuItem) {
        openWhatIsNew()
    }

    @objc private func openSettingsWindowFromNotification(_ notification: Notification) {
        showSettingsWindow()
    }

    @objc private func openWhatIsNewWindowFromNotification(_ notification: Notification) {
        showWhatIsNewWindow()
    }

    private func showWhatIsNewWindow() {
        WhatIsNewWindowController(
            version: WhatIsNewWindowController.lastVersion(),
            releaseNotes: WhatIsNewWindowController.lastNotes()
        ).showWindow()
    }

    private func showPendingWhatIsNewIfNeeded() {
        guard let pending = WhatIsNewWindowController.consumePendingInstallNotice() else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            WhatIsNewWindowController(version: pending.version, releaseNotes: pending.notes).showWindow()
        }
    }

    @objc private func quitFromMenu(_ sender: NSMenuItem) {
        if tamperProtectionBlocksQuit() {
            showTamperProtectionAlert()
            return
        }

        NSApplication.shared.terminate(nil)
    }

    private func tamperProtectionBlocksQuit() -> Bool {
        UserDefaults.standard.bool(forKey: "tamperProtectionEnabled") &&
            OpenLinkService.shared.hasActiveMachineConnection
    }

    private func showTamperProtectionAlert() {
        NSSound.beep()
        let alert = NSAlert()
        alert.messageText = "OpenLink tamper protection is active"
        alert.informativeText = "Local quitting is locked while an owned remote session is active. Disconnect the session or disable tamper protection from owner settings."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }
}

struct OpenLinkMainWindowView: View {
    @StateObject private var service = OpenLinkService.shared

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Image(systemName: "link.circle.fill")
                    .font(.system(size: 30))
                    .foregroundStyle(service.isRunning ? Color.green : Color.secondary)
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 2) {
                    Text("OpenLink")
                        .font(.title2)
                        .fontWeight(.semibold)
                    Text(windowStatusText)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                Button {
                    openOpenLinkSettings()
                } label: {
                    Label("Settings", systemImage: "gearshape")
                }
                .keyboardShortcut(",", modifiers: [.command])

                Button {
                    minimizeOpenLinkMainWindow()
                } label: {
                    Label("Minimize to Status Menu", systemImage: "menubar.rectangle")
                }
            }
            .padding()
            .background(Color(nsColor: .windowBackgroundColor))

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    statusGrid

                    HStack {
                        Text("Devices")
                            .font(.headline)
                        Spacer()
                        Button {
                            service.refreshServiceHealth()
                        } label: {
                            Label("Refresh", systemImage: "arrow.clockwise")
                        }
                    }

                    if service.machines.isEmpty {
                        VStack(spacing: 12) {
                            Image(systemName: "desktopcomputer")
                                .font(.system(size: 42))
                                .foregroundStyle(.secondary)
                                .accessibilityHidden(true)
                            Text("Waiting for a connection")
                                .font(.headline)
                            Text("OpenLink is online on \(activeDomainText) and ready for trusted devices.")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                                .multilineTextAlignment(.center)
                        }
                        .frame(maxWidth: .infinity, minHeight: 220)
                    } else {
                        Table(service.machines) {
                            TableColumn("Device") { machine in
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(machine.displayName)
                                        .fontWeight(.medium)
                                    Text(machine.machineHostname)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            TableColumn("Status") { machine in
                                Label(machine.isOnline ? "Online" : "Offline", systemImage: machine.isOnline ? "checkmark.circle.fill" : "circle")
                                    .foregroundStyle(machine.isOnline ? .green : .secondary)
                            }
                            TableColumn("Domain") { machine in
                                Text(machine.domainUsed)
                                    .font(.caption)
                            }
                            TableColumn("Last Seen") { machine in
                                Text("\(machine.lastConnectedText), \(machine.lastDurationText)")
                                    .font(.caption)
                            }
                            TableColumn("Actions") { machine in
                                MachineActionsMenu(machine: machine)
                            }
                        }
                        .frame(minHeight: 300)
                    }
                }
                .padding()
            }
        }
        .frame(minWidth: 720, minHeight: 520)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(windowStatusText)
    }

    private var windowStatusText: String {
        if service.hasActiveMachineConnection {
            return service.elapsedConnectionText
        }
        if service.isRunning {
            return "Online and waiting for a connection"
        }
        return "Stopped"
    }

    private var activeDomainText: String {
        let backend = UserDefaults.standard.string(forKey: "openLinkBackendUrl") ?? OpenLinkService.canonicalWebSocketURL
        return backend
            .replacingOccurrences(of: "wss://", with: "")
            .replacingOccurrences(of: "/ws", with: "")
    }

    private var statusGrid: some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                StatusPill(label: "OpenLink", value: service.isRunning ? "Online" : "Stopped", color: service.isRunning ? .green : .secondary)
                StatusPill(label: "Connection", value: service.hasActiveMachineConnection ? "Active" : "Waiting", color: service.hasActiveMachineConnection ? .green : .blue)
                StatusPill(label: "Domain", value: activeDomainText, color: .primary)
            }
            HStack(spacing: 10) {
                StatusPill(label: "Health", value: service.serviceHealthText.replacingOccurrences(of: "Connection health: ", with: ""), color: service.serviceOnline ? .green : .red)
                StatusPill(label: "Signal", value: service.connectionStrengthText.replacingOccurrences(of: "Signal strength: ", with: ""), color: service.serviceOnline ? .green : .red)
                StatusPill(label: "Local", value: "\(service.localIP ?? "No local IP"):\(service.port)", color: .secondary)
            }
        }
    }
}

struct StatusPill: View {
    let label: String
    let value: String
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.callout)
                .fontWeight(.medium)
                .foregroundStyle(color)
                .lineLimit(2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(label): \(value)")
    }
}

struct MachineActionsMenu: View {
    let machine: OpenLinkMachine
    @StateObject private var service = OpenLinkService.shared

    var body: some View {
        Menu {
            if service.isConnectableMachine(machine) {
                Button("Connect") { service.connectToMachine(machine, dropIn: false) }
                Button("Start Using \(machine.displayName)") { service.startUsingMachine(machine) }
                Button("Drop-In Connect") { service.connectToMachine(machine, dropIn: true) }
                Divider()
                if service.hasConnectedRemoteSession(with: machine) {
                    Button("Minimize Remote Connection to Use Local Machine") { service.minimizeRemoteForLocalUse(machine) }
                    Button("Disconnect from \(machine.displayName)") { service.disconnectFromMachine(machine) }
                }
                Button("Swap Control") { service.swapControl(with: machine) }
                Button("Open Remote Settings") { service.openRemoteSettings(for: machine) }
            } else {
                Button("Open Local Machine Settings") { openOpenLinkSettings() }
                Button("Disconnect Remote User from This Device") { service.disconnectMachine(machine) }
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
            Label("Actions", systemImage: "ellipsis.circle")
        }
        .accessibilityLabel("Actions for \(machine.displayName)")
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
                    minimizeOpenLinkMainWindow()
                }) {
                    Image(systemName: "menubar.rectangle")
                }
                .buttonStyle(.bordered)
                .accessibilityLabel("Minimize OpenLink to status menu")
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
                if service.hasConnectedRemoteSession(with: machine) {
                    Button("Start Using \(machine.displayName)") {
                        service.startUsingMachine(machine)
                    }
                    .disabled(!service.isConnectableMachine(machine))
                } else {
                    Button("Connect") {
                        service.connectToMachine(machine, dropIn: false)
                    }
                    .disabled(!service.isConnectableMachine(machine))
                    Button("Start Using \(machine.displayName)") {
                        service.startUsingMachine(machine)
                    }
                    .disabled(!service.isConnectableMachine(machine))
                    Button("Drop-In Connect") {
                        service.connectToMachine(machine, dropIn: true)
                    }
                    .disabled(!service.isConnectableMachine(machine))
                }
                Divider()
                if service.hasConnectedRemoteSession(with: machine) {
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
            if service.hasConnectedRemoteSession(with: machine) {
                Button("Start Using \(machine.displayName)") { service.startUsingMachine(machine) }
                    .disabled(!service.isConnectableMachine(machine))
            } else {
                Button("Connect") { service.connectToMachine(machine, dropIn: false) }
                    .disabled(!service.isConnectableMachine(machine))
                Button("Start Using \(machine.displayName)") { service.startUsingMachine(machine) }
                    .disabled(!service.isConnectableMachine(machine))
                Button("Drop-In Connect") { service.connectToMachine(machine, dropIn: true) }
                    .disabled(!service.isConnectableMachine(machine))
            }
            if service.hasConnectedRemoteSession(with: machine) {
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

enum OpenLinkSettingsSection: String, CaseIterable, Identifiable {
    case general = "General"
    case connection = "Connection"
    case machines = "Devices"
    case audio = "Audio"
    case accessibility = "Accessibility"
    case security = "Security"

    var id: String { rawValue }

    var systemImage: String {
        switch self {
        case .general: "gearshape"
        case .connection: "antenna.radiowaves.left.and.right"
        case .machines: "desktopcomputer"
        case .audio: "speaker.wave.2"
        case .accessibility: "accessibility"
        case .security: "lock.shield"
        }
    }
}

struct SettingsView: View {
    @StateObject private var service = OpenLinkService.shared
    @State private var selectedSection: OpenLinkSettingsSection = .general

    var body: some View {
        if service.hasActiveMachineConnection {
            ActiveSessionActionsView()
                .frame(width: 500, height: 320)
        } else {
            VStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Settings")
                        .font(.largeTitle)
                        .fontWeight(.bold)
                        .accessibilityAddTraits(.isHeader)
                    Text("Configure OpenLink connections, devices, audio, accessibility, and owner controls.")
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding([.top, .horizontal])

                Picker("Settings section", selection: $selectedSection) {
                    ForEach(OpenLinkSettingsSection.allCases) { section in
                        Label(section.rawValue, systemImage: section.systemImage)
                            .tag(section)
                    }
                }
                .pickerStyle(.segmented)
                .padding()

                Divider()

                ScrollView {
                    selectedSettingsView
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                }
            }
            .toolbar {
                ToolbarItem(placement: .automatic) {
                    Button {
                        minimizeOpenLinkMainWindow()
                    } label: {
                        Label("Minimize to Status Menu", systemImage: "menubar.rectangle")
                    }
                }
            }
            .frame(width: 760, height: 620)
        }
    }

    @ViewBuilder
    private var selectedSettingsView: some View {
        switch selectedSection {
        case .general:
            GeneralSettingsTab()
        case .connection:
            ConnectionSettingsTab()
        case .machines:
            MachinesSettingsTab()
        case .audio:
            AudioSettingsTab()
        case .accessibility:
            AccessibilitySettingsTab()
        case .security:
            SecuritySettingsTab()
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
    @AppStorage("enableDiagnosticSending") private var enableDiagnosticSending = true
    @AppStorage("openLinkBackendUrl") private var openLinkBackendUrl = OpenLinkService.canonicalWebSocketURL
    @AppStorage("customSignalingServerAccessEnabled") private var customSignalingServerAccessEnabled = false
    @AppStorage("checkForUpdatesAutomatically") private var checkForUpdatesAutomatically = true
    @AppStorage("installUpdatesAutomatically") private var installUpdatesAutomatically = true
    @AppStorage("updateManifestUrl") private var updateManifestUrl = OpenLinkUpdater.cloudUpdateManifestURL
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
                    Toggle("Send connection diagnostics to the OpenLink backend", isOn: $enableDiagnosticSending)
                }
                .padding(.vertical, 8)
            }

            GroupBox("OpenLink Server") {
                VStack(alignment: .leading, spacing: 12) {
                    Picker("Default signal server", selection: defaultServerBinding) {
                        ForEach(OpenLinkService.approvedWebSocketURLs, id: \.self) { url in
                            Text(url).tag(url)
                        }
                    }
                    .pickerStyle(.menu)

                    if customSignalingServerAccessEnabled {
                        TextField("Custom signal server URL", text: $openLinkBackendUrl)
                            .textFieldStyle(.roundedBorder)
                    }
                }
                .padding(.vertical, 8)
            }

            GroupBox("Updates") {
                VStack(alignment: .leading, spacing: 12) {
                    Toggle("Check for updates automatically", isOn: $checkForUpdatesAutomatically)
                    Toggle("Download and install updates automatically when safe", isOn: $installUpdatesAutomatically)
                    TextField("Update manifest URL", text: $updateManifestUrl)
                        .textFieldStyle(.roundedBorder)
                    Button("Check for Updates Now") {
                        Task {
                            await OpenLinkUpdater.shared.check(interactive: true)
                        }
                    }
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

    private var defaultServerBinding: Binding<String> {
        Binding(
            get: {
                OpenLinkService.isApprovedDefaultWebSocketURL(openLinkBackendUrl)
                    ? openLinkBackendUrl
                    : OpenLinkService.canonicalWebSocketURL
            },
            set: { openLinkBackendUrl = $0 }
        )
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

struct AudioSettingsTab: View {
    @AppStorage("autoMuteRemoteAudio") private var autoMuteRemoteAudio = false
    @AppStorage("muteRemoteAudioWhenInactive") private var muteRemoteAudioWhenInactive = true
    @AppStorage("autoMutedProcesses") private var autoMutedProcesses = "VoiceOver, Music"

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            GroupBox("Remote Audio") {
                VStack(alignment: .leading, spacing: 12) {
                    Toggle("Ask controlled computer to auto-mute audio on connect", isOn: $autoMuteRemoteAudio)
                    Toggle("Mute remote audio when connection is minimized for local use", isOn: $muteRemoteAudioWhenInactive)
                    TextField("Auto-muted process names", text: $autoMutedProcesses)
                        .textFieldStyle(.roundedBorder)
                        .accessibilityLabel("Auto-muted process names")
                }
                .padding(.vertical, 8)
            }

            GroupBox("Speech And Screen Reader Audio") {
                VStack(alignment: .leading, spacing: 12) {
                    Text("VoiceOver audio is routed through the active remote audio path when VoiceOver is running. Remote status text is also sent as local TTS announcements on the controlling device when its local TTS helper is enabled.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                    Text("If a remote user cannot approve keyboard access locally, an admin can run /Applications/OpenLink.app/Contents/Resources/openlink-macos-permission-helper.sh --open over SSH or another approved support channel. macOS still requires user approval or an admin-managed PPPC/MDM profile for silent approval.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Button("Open macOS Accessibility Permissions") {
                        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
                    }
                    Button("Open macOS Input Monitoring Permissions") {
                        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")!)
                    }
                }
                .padding(.vertical, 8)
            }

            Spacer()
        }
        .padding()
    }
}

struct AccessibilitySettingsTab: View {
    @AppStorage("showOnlineOfflineNotifications") private var showOnlineOfflineNotifications = true
    @AppStorage("showConnectionNotifications") private var showConnectionNotifications = true
    @AppStorage("showElapsedConnectionTime") private var showElapsedConnectionTime = true
    @AppStorage("announceConnectionStrength") private var announceConnectionStrength = true
    @AppStorage("enableDiagnosticSending") private var enableDiagnosticSending = true

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            GroupBox("Announcements") {
                VStack(alignment: .leading, spacing: 12) {
                    Toggle("Show online and offline notifications", isOn: $showOnlineOfflineNotifications)
                    Toggle("Show device connection notifications", isOn: $showConnectionNotifications)
                    Toggle("Show elapsed connection time", isOn: $showElapsedConnectionTime)
                    Toggle("Announce connection strength before connecting", isOn: $announceConnectionStrength)
                }
                .padding(.vertical, 8)
            }

            GroupBox("Diagnostics") {
                VStack(alignment: .leading, spacing: 12) {
                    Toggle("Send connection diagnostics to the OpenLink backend", isOn: $enableDiagnosticSending)
                    Text("Diagnostics are metadata-only by default and help confirm keyboard, audio, TTS, and disconnect routing.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 8)
            }

            Spacer()
        }
        .padding()
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
    @AppStorage("tamperProtectionEnabled") private var tamperProtectionEnabled = false
    @AppStorage("allowRemoteSettingsManagement") private var allowRemoteSettingsManagement = true
    @AppStorage("allowTrustedOwnerRemoteSettingsChanges") private var allowTrustedOwnerRemoteSettingsChanges = true
    @AppStorage("requireApprovalForGuestRemoteSettingsChanges") private var requireApprovalForGuestRemoteSettingsChanges = true
    @AppStorage("lockLocalSettingsDuringRemoteOwnerSession") private var lockLocalSettingsDuringRemoteOwnerSession = false

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

            GroupBox("Remote Settings") {
                VStack(alignment: .leading, spacing: 8) {
                    Toggle("Allow remote settings management", isOn: $allowRemoteSettingsManagement)
                    Toggle("Trusted or owned devices can open settings quietly", isOn: $allowTrustedOwnerRemoteSettingsChanges)
                    Toggle("Guest settings requests require local approval", isOn: $requireApprovalForGuestRemoteSettingsChanges)
                    Toggle("Lock local settings while an owner is connected", isOn: $lockLocalSettingsDuringRemoteOwnerSession)
                    Text("Trusted owner requests can manage this machine from the remote connection menu. Guest requests are announced locally and must be approved before secure settings are changed.")
                        .font(.caption)
                        .foregroundColor(.gray)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.vertical, 8)
            }

            GroupBox("Tamper Detection") {
                VStack(alignment: .leading, spacing: 8) {
                    Toggle("Lock local quitting during owned remote sessions", isOn: $tamperProtectionEnabled)
                    Text("When enabled, OpenLink stays active from the local status menu while an owner-controlled session is active. Force-quit protection requires the later service hardening pass.")
                        .font(.caption)
                        .foregroundColor(.gray)
                        .fixedSize(horizontal: false, vertical: true)
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
