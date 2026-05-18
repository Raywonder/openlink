import Foundation
import AppKit
import Network
import SwiftUI
import UserNotifications

// MARK: - Connection Mode

enum ConnectionMode: String, CaseIterable, Codable {
    case auto = "Auto"
    case openLink = "OpenLink"
    case directIP = "Direct IP"
    case hybrid = "Hybrid"

    var description: String {
        switch self {
        case .auto: return "Automatically detect best method"
        case .openLink: return "Use secure OpenLink tunnel"
        case .directIP: return "Connect directly via IP"
        case .hybrid: return "OpenLink with IP fallback"
        }
    }
}

// MARK: - Paired Server Model

struct PairedServer: Identifiable, Codable {
    let id: String
    var name: String
    var url: String
    var accessToken: String
    var pairedAt: Date
    var lastSeen: Date?
    var isOnline: Bool = false

    init(id: String = UUID().uuidString, name: String, url: String, accessToken: String = "", pairedAt: Date = Date()) {
        self.id = id
        self.name = name
        self.url = url
        self.accessToken = accessToken
        self.pairedAt = pairedAt
    }
}

// MARK: - Machine History Model

struct OpenLinkMachine: Identifiable, Codable {
    var id: String
    var displayName: String
    var machineHostname: String
    var domainUsed: String
    var platform: String
    var lastConnectedAt: Date?
    var lastDisconnectedAt: Date?
    var lastDurationSeconds: TimeInterval
    var lastSessionId: String?
    var isOnline: Bool
    var isTrusted: Bool
    var allowDropIn: Bool
    var autoConnect: Bool
    var allowRemoteControl: Bool
    var allowSwapControl: Bool
    var allowKeyboardCoUse: Bool
    var allowMicrophoneAudio: Bool
    var allowSystemAudio: Bool
    var allowClipboardSync: Bool
    var allowFileTransfer: Bool
    var notes: String?

    init(
        id: String = UUID().uuidString,
        displayName: String,
        machineHostname: String,
        domainUsed: String,
        platform: String = "Unknown",
        isTrusted: Bool = false,
        allowDropIn: Bool = false,
        autoConnect: Bool = false
    ) {
        self.id = id
        self.displayName = displayName
        self.machineHostname = machineHostname
        self.domainUsed = domainUsed
        self.platform = platform
        self.lastDurationSeconds = 0
        self.isOnline = false
        self.isTrusted = isTrusted
        self.allowDropIn = allowDropIn
        self.autoConnect = autoConnect
        self.allowRemoteControl = true
        self.allowSwapControl = true
        self.allowKeyboardCoUse = true
        self.allowMicrophoneAudio = true
        self.allowSystemAudio = true
        self.allowClipboardSync = true
        self.allowFileTransfer = true
    }

    var lastConnectedText: String {
        guard let lastConnectedAt else { return "Never" }
        return Self.dateFormatter.string(from: lastConnectedAt)
    }

    var lastDurationText: String {
        guard lastDurationSeconds > 0 else { return "No duration" }
        let duration = Int(lastDurationSeconds)
        if duration >= 3600 {
            return "\(duration / 3600)h \((duration % 3600) / 60)m"
        }
        if duration >= 60 {
            return "\(duration / 60)m \(duration % 60)s"
        }
        return "\(duration)s"
    }

    var dropInText: String {
        allowDropIn ? "Drop-in allowed" : "Approval required"
    }

    var audioText: String {
        "Mic \(allowMicrophoneAudio ? "on" : "off"), system \(allowSystemAudio ? "on" : "off")"
    }

    var accessibilitySummary: String {
        "\(displayName), \(platform), host \(machineHostname), last connected \(lastConnectedText), duration \(lastDurationText), \(dropInText), \(audioText), \(isOnline ? "online" : "offline")"
    }

    private static let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        formatter.timeStyle = .short
        return formatter
    }()
}

// MARK: - OpenLink Service

class OpenLinkService: ObservableObject {
    static let shared = OpenLinkService()
    private static let interactionShortcutHelp = "To interact with the connected device, choose Start Using the device. Use the OpenLink status menu for controller actions, disconnect, swap control, and audio. Choose Minimize Remote Connection to Use Local Machine to return to this Mac."

    // State
    @Published var isRunning = false
    @Published var connectionMode: ConnectionMode = .auto
    @Published var localIP: String?
    @Published var port: Int = 3000
    @Published var connectedDevices: Int = 0
    @Published var pairedServers: [PairedServer] = []
    @Published var machines: [OpenLinkMachine] = []
    @Published var serviceHealthText = "Connection health unknown"
    @Published var connectionStrengthText = "Signal strength unknown"
    @Published var serviceOnline = false
    @Published var lastLatencyMs: Int?
    @Published var connectionStartedAt: Date?
    @Published var activeMachineName: String?

    // Settings
    @Published var discoveryEnabled = true
    @Published var allowRemoteControl = true
    @Published var trustedDevicesOnly = false

    var hasActiveMachineConnection: Bool {
        connectedDevices > 0 || machines.contains(where: { $0.isOnline })
    }

    var elapsedConnectionText: String {
        guard let connectionStartedAt else { return "Connected time unknown" }
        let elapsed = max(0, Int(Date().timeIntervalSince(connectionStartedAt)))
        let machineName = activeMachineName ?? "current machine"
        if elapsed >= 3600 {
            return "Connected to \(machineName) for \(elapsed / 3600)h \((elapsed % 3600) / 60)m"
        }
        return "Connected to \(machineName) for \(elapsed / 60)m \(elapsed % 60)s"
    }

    // Network
    private var listener: NWListener?
    private var connections: [String: NWConnection] = [:]
    private var webSocketTasks: [String: URLSessionWebSocketTask] = [:]
    private var discoveryTimer: Timer?
    private var serviceHealthTimer: Timer?
    private var lastServiceOnline: Bool?

    // Paths
    private let configPath = NSHomeDirectory() + "/.openlink/config.json"
    private let serversPath = NSHomeDirectory() + "/.openlink/servers.json"
    private let machinesPath = NSHomeDirectory() + "/.openlink/machines.json"

    init() {
        UserDefaults.standard.register(defaults: [
            "showOnlineOfflineNotifications": true,
            "showConnectionNotifications": true,
            "showElapsedConnectionTime": true,
            "announceConnectionStrength": true,
            "autoReconnectOnLaunch": true,
            "autoStartInteractionOnConnect": true,
            "autoMuteRemoteAudio": false,
            "muteRemoteAudioWhenInactive": true,
            "autoMutedProcesses": "VoiceOver, Music"
        ])
        loadConfiguration()
        loadServers()
        loadMachines()
        migratePairedServersToMachines()
        seedTrustedMachinePair()
    }

    // MARK: - Service Control

    func start() {
        guard !isRunning else { return }

        // Start local server for incoming connections
        startListener()

        // Start discovery if enabled
        if discoveryEnabled {
            startDiscovery()
        }
        startServiceHealthPolling()

        if UserDefaults.standard.bool(forKey: "autoReconnectOnLaunch") {
            for machine in machines where machine.autoConnect && isConnectableMachine(machine) {
                connectToMachine(machine, dropIn: machine.allowDropIn)
            }
        }

        isRunning = true
        detectLocalIP()

        NotificationCenter.default.post(name: .openLinkServiceStarted, object: nil)
    }

    func stop() {
        guard isRunning else { return }

        // Stop listener
        listener?.cancel()
        listener = nil

        // Close all connections
        for (_, connection) in connections {
            connection.cancel()
        }
        connections.removeAll()

        // Close WebSocket connections
        for (_, task) in webSocketTasks {
            task.cancel(with: .normalClosure, reason: nil)
        }
        webSocketTasks.removeAll()

        // Stop discovery
        discoveryTimer?.invalidate()
        discoveryTimer = nil
        serviceHealthTimer?.invalidate()
        serviceHealthTimer = nil

        isRunning = false
        connectedDevices = 0
        connectionStartedAt = nil
        activeMachineName = nil

        NotificationCenter.default.post(name: .openLinkServiceStopped, object: nil)
    }

    // MARK: - Network Listener

    private func startListener() {
        do {
            let parameters = NWParameters.tcp
            parameters.allowLocalEndpointReuse = true

            listener = try NWListener(using: parameters, on: NWEndpoint.Port(integerLiteral: UInt16(port)))

            listener?.stateUpdateHandler = { [weak self] state in
                switch state {
                case .ready:
                    print("OpenLink listener ready on port \(self?.port ?? 0)")
                case .failed(let error):
                    print("OpenLink listener failed: \(error)")
                    self?.isRunning = false
                default:
                    break
                }
            }

            listener?.newConnectionHandler = { [weak self] connection in
                self?.handleNewConnection(connection)
            }

            listener?.start(queue: .main)

        } catch {
            print("Failed to start OpenLink listener: \(error)")
        }
    }

    private func handleNewConnection(_ connection: NWConnection) {
        let connectionId = UUID().uuidString

        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                self?.connectedDevices += 1
                self?.connections[connectionId] = connection
                self?.receiveData(from: connection, id: connectionId)
            case .failed, .cancelled:
                self?.connections.removeValue(forKey: connectionId)
                self?.connectedDevices = max(0, (self?.connectedDevices ?? 1) - 1)
            default:
                break
            }
        }

        connection.start(queue: .main)
    }

    private func receiveData(from connection: NWConnection, id: String) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            if let data = data, !data.isEmpty {
                self?.handleIncomingData(data, from: id)
            }

            if !isComplete && error == nil {
                self?.receiveData(from: connection, id: id)
            }
        }
    }

    private func handleIncomingData(_ data: Data, from connectionId: String) {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else {
            return
        }

        switch type {
        case "remote_command":
            handleRemoteCommand(json, from: connectionId)
        case "ping":
            sendPong(to: connectionId)
        case "connect":
            handleConnectRequest(json, from: connectionId)
        case "disconnect":
            handleDisconnect(connectionId)
        case "swap_control_request":
            handleSwapControlRequest(json, from: connectionId)
        case "audio_policy_update":
            handleAudioPolicyUpdate(json, from: connectionId)
        case "start_interaction", "pause_interaction", "controller_disconnect", "disconnect_user", "input_event", "key_event":
            handleNativeControlMessage(json, from: connectionId)
        case "audio_frame":
            OpenLinkAudioBridge.shared.play(frame: json)
        default:
            break
        }
    }

    // MARK: - Remote Commands

    private func handleRemoteCommand(_ json: [String: Any], from connectionId: String) {
        guard allowRemoteControl else {
            sendResponse(["success": false, "error": "Remote control disabled"], to: connectionId)
            return
        }

        guard let commandString = json["command"] as? String else {
            sendResponse(["success": false, "error": "Invalid command"], to: connectionId)
            return
        }

        // Process command
        let result = processRemoteCommand(commandString, parameters: json)
        sendResponse(result, to: connectionId)
    }

    private func processRemoteCommand(_ command: String, parameters: [String: Any]) -> [String: Any] {
        switch command {
        case "get_status":
            return [
                "success": true,
                "result": [
                    "isRunning": isRunning,
                    "mode": connectionMode.rawValue,
                    "port": port,
                    "connectedDevices": connectedDevices,
                    "localIP": localIP ?? "Unknown"
                ]
            ]

        case "get_servers":
            let serverData = pairedServers.map { ["id": $0.id, "name": $0.name, "isOnline": $0.isOnline] }
            return ["success": true, "result": serverData]

        case "get_machines":
            let machineData = machines.map {
                [
                    "id": $0.id,
                    "displayName": $0.displayName,
                    "domainUsed": $0.domainUsed,
                    "isOnline": $0.isOnline,
                    "allowDropIn": $0.allowDropIn
                ] as [String : Any]
            }
            return ["success": true, "result": machineData]

        case "stop_server":
            DispatchQueue.main.async { self.stop() }
            return ["success": true, "result": "Stopping"]

        case "restart_server":
            DispatchQueue.main.async {
                self.stop()
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                    self.start()
                }
            }
            return ["success": true, "result": "Restarting"]

        case "set_mode":
            if let modeString = parameters["mode"] as? String,
               let mode = ConnectionMode(rawValue: modeString) {
                DispatchQueue.main.async { self.connectionMode = mode }
                return ["success": true, "result": "Mode set to \(mode.rawValue)"]
            }
            return ["success": false, "error": "Invalid mode"]

        default:
            return ["success": false, "error": "Unknown command: \(command)"]
        }
    }

    private func sendResponse(_ response: [String: Any], to connectionId: String) {
        guard let connection = connections[connectionId],
              let data = try? JSONSerialization.data(withJSONObject: response) else {
            return
        }

        connection.send(content: data, completion: .idempotent)
    }

    private func sendPong(to connectionId: String) {
        sendResponse(["type": "pong", "timestamp": Date().timeIntervalSince1970], to: connectionId)
    }

    private func handleConnectRequest(_ json: [String: Any], from connectionId: String) {
        // Handle new device connection request
        if let deviceId = json["deviceId"] as? String,
           let deviceName = json["deviceName"] as? String {
            print("Device connected: \(deviceName) (\(deviceId))")
            upsertMachineFromIncoming(id: deviceId, name: deviceName, connectionId: connectionId)
            sendResponse(["success": true, "connected": true], to: connectionId)
        }
    }

    private func handleDisconnect(_ connectionId: String) {
        connections[connectionId]?.cancel()
        connections.removeValue(forKey: connectionId)
        connectedDevices = max(0, connectedDevices - 1)
        markMachineDisconnected(id: connectionId)
    }

    private func handleSwapControlRequest(_ json: [String: Any], from connectionId: String) {
        sendResponse([
            "type": "swap_control_state",
            "success": true,
            "keyboardCoUse": json["allowKeyboardCoUse"] as? Bool ?? true,
            "message": "Swap control accepted; local and remote input remain enabled where allowed."
        ], to: connectionId)
    }

    private func handleAudioPolicyUpdate(_ json: [String: Any], from connectionId: String) {
        sendResponse([
            "type": "audio_policy_state",
            "success": true,
            "microphoneAudioAllowed": json["microphoneAudioAllowed"] as? Bool ?? true,
            "systemAudioAllowed": json["systemAudioAllowed"] as? Bool ?? true
        ], to: connectionId)
    }

    private func handleNativeControlMessage(_ json: [String: Any], from connectionId: String) {
        guard messageTargetsLocalMachine(json) else { return }

        if let response = RemoteControlManager.shared.handleSignalingMessage(json) {
            if let type = json["type"] as? String, type == "start_interaction" {
                if let controllerMachineId = controllerMachineId(from: json) {
                    OpenLinkAudioBridge.shared.startCapture(targetMachineId: controllerMachineId) { [weak self] frame in
                        self?.sendResponse(frame, to: connectionId)
                    }
                }
            } else if let type = json["type"] as? String,
                      type == "pause_interaction" || type == "controller_disconnect" || type == "disconnect_user" {
                OpenLinkAudioBridge.shared.stopCapture()
            }

            sendResponse(response, to: connectionId)
        }
    }

    // MARK: - Server Connection

    func connectToServer(_ server: PairedServer) {
        switch connectionMode {
        case .auto:
            autoConnectToServer(server)
        case .openLink:
            connectViaOpenLink(server)
        case .directIP:
            connectViaDirectIP(server)
        case .hybrid:
            connectViaOpenLink(server)
            // Fallback handled in failure case
        }
    }

    func connectToMachine(_ machine: OpenLinkMachine, dropIn: Bool? = nil, startInteraction: Bool? = nil) {
        guard ensureConnectableMachine(machine, action: "connect to") else { return }

        let normalized = signalingEndpoint(for: machine)
        refreshServiceHealth()
        if UserDefaults.standard.bool(forKey: "announceConnectionStrength") {
            postStatusNotification(title: "OpenLink signal", body: connectionStrengthText)
        }
        let server = PairedServer(
            id: machine.id,
            name: machine.displayName,
            url: normalized.replacingOccurrences(of: "/ws", with: ""),
            accessToken: ""
        )
        connectToServer(server)
        markMachineConnected(id: machine.id, sessionId: machine.lastSessionId)
        sendMachinePolicy(machine, type: "machine_connect_request", dropIn: dropIn ?? machine.allowDropIn)
        let shouldStartInteraction = startInteraction ?? UserDefaults.standard.bool(forKey: "autoStartInteractionOnConnect")
        postStatusNotification(title: "OpenLink", body: shouldStartInteraction
            ? "Connect requested for \(machine.displayName). Starting keyboard and audio interaction now. \(Self.interactionShortcutHelp) Press Escape to close the status menu silently."
            : "Connect requested for \(machine.displayName). \(Self.interactionShortcutHelp) Press Escape to close the status menu without opening another window.")

        if shouldStartInteraction {
            startUsingConnectedMachine(machine)
        }
    }

    func disconnectMachine(_ machine: OpenLinkMachine) {
        webSocketTasks[machine.id]?.cancel(with: .normalClosure, reason: nil)
        webSocketTasks.removeValue(forKey: machine.id)
        connections[machine.id]?.cancel()
        connections.removeValue(forKey: machine.id)
        sendMachinePolicy(machine, type: "disconnect_user", dropIn: false)
        markMachineDisconnected(id: machine.id)
    }

    func disconnectFromMachine(_ machine: OpenLinkMachine) {
        sendMachinePolicy(machine, type: "controller_disconnect", dropIn: false)
        markMachineDisconnected(id: machine.id)
    }

    func startUsingMachine(_ machine: OpenLinkMachine) {
        guard ensureConnectableMachine(machine, action: "start using") else { return }

        connectToMachine(machine, dropIn: machine.allowDropIn, startInteraction: false)
        startUsingConnectedMachine(machine)
    }

    private func startUsingConnectedMachine(_ machine: OpenLinkMachine) {
        sendMachineAction(machine, type: "start_interaction", extras: [
            "fullKeyboardControl": true,
            "transmitKeyboard": true,
            "captureKeyboard": true,
            "keyboardCoUseAllowed": machine.allowKeyboardCoUse,
            "microphoneAudioAllowed": true,
            "systemAudioAllowed": true,
            "transmitMicrophoneAudio": true,
            "transmitSystemAudio": true,
            "audioAllowed": true,
            "audioDirection": "bidirectional",
            "interactionMode": "full-keyboard-and-audio"
        ])
        NSApplication.shared.hide(nil)
        postStatusNotification(title: "OpenLink", body: "Start using \(machine.displayName). Full keyboard control and remote audio requested. \(Self.interactionShortcutHelp) Press Escape to close the status menu silently.")
    }

    func minimizeRemoteForLocalUse(_ machine: OpenLinkMachine) {
        sendMachineAction(machine, type: "pause_interaction", extras: [
            "keepSessionAlive": true,
            "muteRemoteAudio": UserDefaults.standard.bool(forKey: "muteRemoteAudioWhenInactive"),
            "reason": "controller-returned-to-local-machine"
        ])
        NSApplication.shared.activate(ignoringOtherApps: true)
        postStatusNotification(title: "OpenLink", body: "Remote control for \(machine.displayName) minimized for local use.")
    }

    func swapControl(with machine: OpenLinkMachine) {
        guard ensureConnectableMachine(machine, action: "swap control with") else { return }

        sendMachinePolicy(machine, type: "swap_control_request", dropIn: machine.allowDropIn)
    }

    func isConnectableMachine(_ machine: OpenLinkMachine) -> Bool {
        !isLocalMachine(machine)
    }

    private func ensureConnectableMachine(_ machine: OpenLinkMachine, action: String) -> Bool {
        if isConnectableMachine(machine) {
            return true
        }

        postStatusNotification(title: "OpenLink", body: "Cannot \(action) \(machine.displayName); this is the current device. Select another machine.")
        return false
    }

    private func isLocalMachine(_ machine: OpenLinkMachine) -> Bool {
        let localNames = localMachineIdentityTokens()

        let machineNames = [
            machine.id,
            machine.displayName,
            machine.machineHostname
        ].map(Self.canonicalMachineToken).filter { !$0.isEmpty }

        return machineNames.contains { machineName in
            localNames.contains(machineName)
        }
    }

    private func localMachineIdentityTokens() -> Set<String> {
        let rawNames = [
            getClientId(),
            Host.current().localizedName ?? "",
            ProcessInfo.processInfo.hostName
        ]

        var tokens = Set<String>()
        for name in rawNames {
            let canonical = Self.canonicalMachineToken(name)
            if !canonical.isEmpty {
                tokens.insert(canonical)
            }

            if let shortName = name.split(separator: ".").first {
                let shortToken = Self.canonicalMachineToken(String(shortName))
                if !shortToken.isEmpty {
                    tokens.insert(shortToken)
                }
            }
        }

        if tokens.contains(where: { $0.contains("adminsmacmini") }) {
            tokens.insert("adminsmacmini")
        }
        if tokens.contains(where: { $0.contains("dompclaptop") }) {
            tokens.insert("dompclaptop")
        }

        return tokens
    }

    private static func canonicalMachineToken(_ value: String) -> String {
        value
            .lowercased()
            .filter { $0.isLetter || $0.isNumber }
    }

    func toggleMicrophoneAudio(for machine: OpenLinkMachine) {
        guard let index = machines.firstIndex(where: { $0.id == machine.id }) else { return }
        machines[index].allowMicrophoneAudio.toggle()
        saveMachines()
        sendMachinePolicy(machines[index], type: "audio_policy_update", dropIn: machines[index].allowDropIn)
    }

    func setMicrophoneAudio(for machine: OpenLinkMachine, enabled: Bool) {
        guard let index = machines.firstIndex(where: { $0.id == machine.id }) else { return }
        machines[index].allowMicrophoneAudio = enabled
        saveMachines()
        sendMachinePolicy(machines[index], type: "audio_policy_update", dropIn: machines[index].allowDropIn)
    }

    func toggleSystemAudio(for machine: OpenLinkMachine) {
        guard let index = machines.firstIndex(where: { $0.id == machine.id }) else { return }
        machines[index].allowSystemAudio.toggle()
        saveMachines()
        sendMachinePolicy(machines[index], type: "audio_policy_update", dropIn: machines[index].allowDropIn)
    }

    func setSystemAudio(for machine: OpenLinkMachine, enabled: Bool) {
        guard let index = machines.firstIndex(where: { $0.id == machine.id }) else { return }
        machines[index].allowSystemAudio = enabled
        saveMachines()
        sendMachinePolicy(machines[index], type: "audio_policy_update", dropIn: machines[index].allowDropIn)
    }

    func machine(id: String) -> OpenLinkMachine? {
        machines.first { $0.id == id }
    }

    private func autoConnectToServer(_ server: PairedServer) {
        // Check if server is on local network
        if isLocalServer(server) {
            connectViaDirectIP(server)
        } else {
            connectViaOpenLink(server)
        }
    }

    private func isLocalServer(_ server: PairedServer) -> Bool {
        guard let url = URL(string: server.url),
              let host = url.host else {
            return false
        }

        return host.hasPrefix("192.168.") ||
               host.hasPrefix("10.") ||
               host.hasPrefix("172.16.") ||
               host == "localhost" ||
               host == "127.0.0.1"
    }

    private func connectViaOpenLink(_ server: PairedServer) {
        // Create WebSocket connection for OpenLink tunnel
        let wsURL = normalizeEndpoint(server.url)
            .replacingOccurrences(of: "http://", with: "ws://")
            .replacingOccurrences(of: "https://", with: "wss://")

        // Native signaling uses /ws; keep health checks backward-compatible below.
        guard let url = URL(string: wsURL.hasSuffix("/ws") ? wsURL : "\(wsURL)/ws") else {
            return
        }

        var request = URLRequest(url: url)
        request.setValue(server.accessToken, forHTTPHeaderField: "Authorization")

        let task = URLSession.shared.webSocketTask(with: request)
        webSocketTasks[server.id] = task

        task.resume()

        // Start receiving messages
        receiveWebSocketMessages(serverId: server.id)

        // Send handshake
        let handshake: [String: Any] = [
            "type": "handshake",
            "clientId": getClientId(),
            "clientName": Host.current().localizedName ?? "Unknown",
            "machineInfo": localMachineInfo(domainUsed: url.host ?? "openlink.raywonderis.me"),
            "connectionPolicy": globalConnectionPolicy()
        ]

        if let data = try? JSONSerialization.data(withJSONObject: handshake),
           let string = String(data: data, encoding: .utf8) {
            task.send(.string(string)) { _ in }
        }

        updateServerOnlineStatus(serverId: server.id, isOnline: true)
        markMachineConnected(id: server.id, sessionId: nil)
    }

    private func connectViaDirectIP(_ server: PairedServer) {
        guard let url = URL(string: server.url),
              let host = url.host else {
            return
        }

        let port = url.port ?? 3000

        let connection = NWConnection(
            host: NWEndpoint.Host(host),
            port: NWEndpoint.Port(integerLiteral: UInt16(port)),
            using: .tcp
        )

        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                self?.updateServerOnlineStatus(serverId: server.id, isOnline: true)
            case .failed, .cancelled:
                self?.updateServerOnlineStatus(serverId: server.id, isOnline: false)
                // Try OpenLink fallback if in hybrid mode
                if self?.connectionMode == .hybrid {
                    self?.connectViaOpenLink(server)
                }
            default:
                break
            }
        }

        connections[server.id] = connection
        connection.start(queue: .main)
    }

    private func receiveWebSocketMessages(serverId: String) {
        guard let task = webSocketTasks[serverId] else { return }

        task.receive { [weak self] result in
            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    if let data = text.data(using: .utf8) {
                        self?.handleWebSocketMessage(data, serverId: serverId)
                    }
                case .data(let data):
                    self?.handleWebSocketMessage(data, serverId: serverId)
                @unknown default:
                    break
                }
                // Continue receiving
                self?.receiveWebSocketMessages(serverId: serverId)

            case .failure:
                self?.updateServerOnlineStatus(serverId: serverId, isOnline: false)
                self?.webSocketTasks.removeValue(forKey: serverId)
            }
        }
    }

    private func handleWebSocketMessage(_ data: Data, serverId: String) {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else {
            return
        }

        switch type {
        case "remote_command":
            let result = processRemoteCommand(json["command"] as? String ?? "", parameters: json)
            sendWebSocketResponse(result, serverId: serverId)
        case "ping":
            sendWebSocketResponse(["type": "pong"], serverId: serverId)
        case "broadcast":
            if let data = json["data"] as? [String: Any] {
                handleWebSocketControlMessage(data, serverId: serverId, respondWithBroadcast: true)
            }
        case "machine_connect_request":
            if messageTargetsLocalMachine(json) {
                RemoteControlManager.shared.isRemoteControlActive = true
                RemoteControlManager.shared.isReceivingControl = false
                sendWebSocketResponse(["type": "machine_connect_ack", "success": true, "targetMachineId": getClientId()], serverId: serverId)
                postStatusNotification(title: "OpenLink", body: "Trusted machine connected. Keyboard and audio interaction can start from the controlling computer.")
            }
        case "start_interaction", "pause_interaction", "controller_disconnect", "disconnect_user", "input_event", "key_event":
            handleWebSocketControlMessage(json, serverId: serverId)
            if type == "disconnect_user" {
                disconnectMachineById(serverId)
            }
        case "audio_frame":
            handleWebSocketControlMessage(json, serverId: serverId)
        case "swap_control_request":
            sendWebSocketResponse(["type": "swap_control_state", "success": true, "keyboardCoUse": true], serverId: serverId)
        default:
            break
        }
    }

    private func handleWebSocketControlMessage(_ json: [String: Any], serverId: String, respondWithBroadcast: Bool = false) {
        guard messageTargetsLocalMachine(json) else { return }

        if let type = json["type"] as? String, type == "audio_frame" {
            OpenLinkAudioBridge.shared.play(frame: json)
            return
        }

        if let response = RemoteControlManager.shared.handleSignalingMessage(json) {
            if let type = json["type"] as? String, type == "start_interaction" {
                startAudioBridgeForController(from: json, serverId: serverId, respondWithBroadcast: respondWithBroadcast)
                sendWebSocketResponse(response, serverId: serverId, broadcast: respondWithBroadcast)
                postStatusNotification(title: "OpenLink", body: "Remote keyboard control is active. Press Escape to close the status menu silently; both keyboards remain available when allowed.")
            } else {
                if let type = json["type"] as? String,
                   type == "pause_interaction" || type == "controller_disconnect" || type == "disconnect_user" {
                    OpenLinkAudioBridge.shared.stopCapture()
                }
                sendWebSocketResponse(response, serverId: serverId, broadcast: respondWithBroadcast)
            }
        }
    }

    private func startAudioBridgeForController(from json: [String: Any], serverId: String, respondWithBroadcast: Bool) {
        guard let controllerMachineId = controllerMachineId(from: json) else { return }

        OpenLinkAudioBridge.shared.startCapture(targetMachineId: controllerMachineId) { [weak self] frame in
            self?.sendWebSocketResponse(frame, serverId: serverId, broadcast: respondWithBroadcast)
        }
    }

    private func controllerMachineId(from json: [String: Any]) -> String? {
        if let sourceMachineId = json["sourceMachineId"] as? String, !sourceMachineId.isEmpty {
            return sourceMachineId
        }
        if let machineInfo = json["machineInfo"] as? [String: Any],
           let machineId = machineInfo["id"] as? String,
           !machineId.isEmpty {
            return machineId
        }
        return nil
    }

    private func messageTargetsLocalMachine(_ json: [String: Any]) -> Bool {
        guard let target = json["targetMachineId"] as? String, !target.isEmpty else {
            return true
        }

        let localTokens = localMachineIdentityTokens()

        let targetToken = Self.canonicalMachineToken(target)
        return !targetToken.isEmpty && localTokens.contains(targetToken)
    }

    private func sendWebSocketResponse(_ response: [String: Any], serverId: String, broadcast: Bool = false) {
        guard let task = webSocketTasks[serverId],
              let data = try? JSONSerialization.data(withJSONObject: broadcast ? ["type": "broadcast", "data": response] : response),
              let string = String(data: data, encoding: .utf8) else {
            return
        }

        task.send(.string(string)) { _ in }
    }

    func testConnection(_ server: PairedServer) {
        // Try current health endpoint first, then legacy fallback for older servers.
        let healthCandidates = ["/health", "/api/health"]

        func checkCandidate(_ index: Int) {
            guard index < healthCandidates.count else {
                DispatchQueue.main.async { [weak self] in
                    self?.updateServerOnlineStatus(serverId: server.id, isOnline: false)
                }
                return
            }

            guard let url = URL(string: "\(server.url)\(healthCandidates[index])") else {
                checkCandidate(index + 1)
                return
            }

            URLSession.shared.dataTask(with: url) { [weak self] _, response, error in
                let ok = (response as? HTTPURLResponse)?.statusCode == 200 && error == nil
                if ok {
                    DispatchQueue.main.async {
                        self?.updateServerOnlineStatus(serverId: server.id, isOnline: true)
                    }
                } else {
                    checkCandidate(index + 1)
                }
            }.resume()
        }

        checkCandidate(0)
    }

    // MARK: - Server Management

    func pairWithCode(_ code: String) {
        // In production, this would call the server API
        // For now, simulate pairing
        guard code.count == 6 else { return }

        let newServer = PairedServer(
            name: "OpenLink Server",
            url: "http://localhost:3000",
            accessToken: UUID().uuidString
        )

        addServer(newServer)
    }

    func addServerManually(url: String) {
        let newServer = PairedServer(
            name: "Manual Server",
            url: normalizeEndpoint(url).replacingOccurrences(of: "/ws", with: ""),
            accessToken: UUID().uuidString
        )

        addServer(newServer)
    }

    private func addServer(_ server: PairedServer) {
        pairedServers.append(server)
        migrateServerToMachine(server)
        saveServers()
        saveMachines()

        if isRunning {
            connectToServer(server)
        }
    }

    func removeServer(_ server: PairedServer) {
        // Disconnect
        webSocketTasks[server.id]?.cancel(with: .normalClosure, reason: nil)
        webSocketTasks.removeValue(forKey: server.id)
        connections[server.id]?.cancel()
        connections.removeValue(forKey: server.id)

        // Remove from list
        pairedServers.removeAll { $0.id == server.id }
        machines.removeAll { $0.id == server.id }
        saveServers()
        saveMachines()
    }

    private func updateServerOnlineStatus(serverId: String, isOnline: Bool) {
        if let index = pairedServers.firstIndex(where: { $0.id == serverId }) {
            pairedServers[index].isOnline = isOnline
            pairedServers[index].lastSeen = isOnline ? Date() : pairedServers[index].lastSeen
        }
        if let index = machines.firstIndex(where: { $0.id == serverId }) {
            machines[index].isOnline = isOnline
            if isOnline {
                machines[index].lastConnectedAt = Date()
            }
            saveMachines()
        }
    }

    // MARK: - Discovery

    private func startDiscovery() {
        discoveryTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            self?.discoverLocalDevices()
        }
        discoverLocalDevices()
    }

    private func startServiceHealthPolling() {
        serviceHealthTimer?.invalidate()
        serviceHealthTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            self?.refreshServiceHealth()
        }
        refreshServiceHealth()
    }

    func refreshServiceHealth() {
        let healthUrl = URL(string: "https://openlink.raywonderis.me/health")!
        let started = Date()
        URLSession.shared.dataTask(with: healthUrl) { [weak self] _, response, error in
            let latency = Int(Date().timeIntervalSince(started) * 1000)
            let ok = (response as? HTTPURLResponse)?.statusCode == 200 && error == nil
            DispatchQueue.main.async {
                guard let self else { return }
                let previous = self.lastServiceOnline
                self.serviceOnline = ok
                self.lastLatencyMs = ok ? latency : nil
                self.serviceHealthText = ok
                    ? "Connection health: online (\(latency) ms)"
                    : "Connection health: down"
                self.connectionStrengthText = self.describeConnectionStrength(online: ok, latencyMs: ok ? latency : nil)
                if let previous, previous != ok, UserDefaults.standard.bool(forKey: "showOnlineOfflineNotifications") {
                    self.postStatusNotification(
                        title: "OpenLink",
                        body: ok ? "OpenLink backend is online." : "OpenLink backend is offline."
                    )
                }
                self.lastServiceOnline = ok
            }
        }.resume()
    }

    private func discoverLocalDevices() {
        // Check all paired servers
        for server in pairedServers {
            testConnection(server)
        }
    }

    private func detectLocalIP() {
        var address: String?

        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let firstAddr = ifaddr else { return }

        for ptr in sequence(first: firstAddr, next: { $0.pointee.ifa_next }) {
            let interface = ptr.pointee
            let addrFamily = interface.ifa_addr.pointee.sa_family

            if addrFamily == UInt8(AF_INET) {
                let name = String(cString: interface.ifa_name)
                if name == "en0" || name == "en1" {
                    var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                    getnameinfo(interface.ifa_addr, socklen_t(interface.ifa_addr.pointee.sa_len),
                               &hostname, socklen_t(hostname.count), nil, 0, NI_NUMERICHOST)
                    address = String(cString: hostname)
                }
            }
        }
        freeifaddrs(ifaddr)

        DispatchQueue.main.async {
            self.localIP = address
        }
    }

    // MARK: - Persistence

    private func loadConfiguration() {
        guard let data = FileManager.default.contents(atPath: configPath),
              let config = try? JSONDecoder().decode(OpenLinkConfig.self, from: data) else {
            return
        }

        connectionMode = ConnectionMode(rawValue: config.connectionMode) ?? .auto
        port = config.serverPort
        discoveryEnabled = config.discoveryEnabled
        allowRemoteControl = config.allowRemoteControl
        trustedDevicesOnly = config.trustedDevicesOnly
    }

    private func loadServers() {
        guard let data = FileManager.default.contents(atPath: serversPath),
              let servers = try? JSONDecoder().decode([PairedServer].self, from: data) else {
            return
        }

        pairedServers = servers
    }

    private func saveServers() {
        guard let data = try? JSONEncoder().encode(pairedServers) else { return }
        try? FileManager.default.createDirectory(at: URL(fileURLWithPath: NSHomeDirectory() + "/.openlink"), withIntermediateDirectories: true)
        try? data.write(to: URL(fileURLWithPath: serversPath))
    }

    private func loadMachines() {
        guard let data = FileManager.default.contents(atPath: machinesPath),
              let savedMachines = try? JSONDecoder().decode([OpenLinkMachine].self, from: data) else {
            return
        }

        machines = savedMachines
    }

    func saveMachines() {
        guard let data = try? JSONEncoder().encode(machines) else { return }
        try? FileManager.default.createDirectory(at: URL(fileURLWithPath: NSHomeDirectory() + "/.openlink"), withIntermediateDirectories: true)
        try? data.write(to: URL(fileURLWithPath: machinesPath))
    }

    private func migratePairedServersToMachines() {
        for server in pairedServers {
            migrateServerToMachine(server)
        }
        saveMachines()
    }

    private func migrateServerToMachine(_ server: PairedServer) {
        guard !machines.contains(where: { $0.id == server.id }) else { return }
        var machine = OpenLinkMachine(
            id: server.id,
            displayName: server.name,
            machineHostname: URL(string: server.url)?.host ?? server.name,
            domainUsed: server.url,
            platform: "Unknown",
            isTrusted: true,
            allowDropIn: false,
            autoConnect: false
        )
        machine.lastConnectedAt = server.lastSeen
        machine.isOnline = server.isOnline
        machines.append(machine)
    }

    private func seedTrustedMachinePair() {
        addSeedMachine(OpenLinkMachine(
            id: "dom-pc-laptop",
            displayName: "Dom PC Laptop",
            machineHostname: "dom-pc-laptop",
            domainUsed: "100.64.0.5",
            platform: "Windows",
            isTrusted: true,
            allowDropIn: true,
            autoConnect: true
        ))
        addSeedMachine(OpenLinkMachine(
            id: "admin-s-mac-mini",
            displayName: "Admin's Mac mini",
            machineHostname: "admin-s-mac-mini",
            domainUsed: "100.64.0.6",
            platform: "macOS",
            isTrusted: true,
            allowDropIn: true,
            autoConnect: true
        ))
        saveMachines()
    }

    private func addSeedMachine(_ machine: OpenLinkMachine) {
        guard !machines.contains(where: { $0.id == machine.id || $0.machineHostname == machine.machineHostname }) else { return }
        var seeded = machine
        seeded.notes = "Approved local profile seed for mutual Windows and Mac mini access."
        machines.append(seeded)
    }

    private func markMachineConnected(id: String, sessionId: String?) {
        guard let index = machines.firstIndex(where: { $0.id == id }) else { return }
        machines[index].isOnline = true
        machines[index].lastConnectedAt = Date()
        if let sessionId, !sessionId.isEmpty {
            machines[index].lastSessionId = sessionId
        }
        activeMachineName = machines[index].displayName
        if connectionStartedAt == nil {
            connectionStartedAt = Date()
        }
        postConnectionNotification(from: getClientId(), to: machines[index].displayName, connected: true)
        saveMachines()
    }

    private func markMachineDisconnected(id: String) {
        guard let index = machines.firstIndex(where: { $0.id == id }) else { return }
        let disconnectedAt = Date()
        machines[index].lastDisconnectedAt = disconnectedAt
        if let connectedAt = machines[index].lastConnectedAt {
            machines[index].lastDurationSeconds = max(1, disconnectedAt.timeIntervalSince(connectedAt))
        }
        machines[index].isOnline = false
        postConnectionNotification(from: getClientId(), to: machines[index].displayName, connected: false)
        if !machines.contains(where: { $0.isOnline }) {
            connectionStartedAt = nil
            activeMachineName = nil
        }
        saveMachines()
    }

    private func disconnectMachineById(_ id: String) {
        if let machine = machines.first(where: { $0.id == id }) {
            disconnectMachine(machine)
        }
    }

    private func upsertMachineFromIncoming(id: String, name: String, connectionId: String) {
        if let index = machines.firstIndex(where: { $0.id == id }) {
            machines[index].isOnline = true
            machines[index].lastConnectedAt = Date()
        } else {
            var machine = OpenLinkMachine(
                id: id,
                displayName: name,
                machineHostname: name,
                domainUsed: connectionId,
                platform: "Unknown",
                isTrusted: false,
                allowDropIn: false,
                autoConnect: false
            )
            machine.isOnline = true
            machine.lastConnectedAt = Date()
            machines.append(machine)
        }
        saveMachines()
    }

    private func sendMachinePolicy(_ machine: OpenLinkMachine, type: String, dropIn: Bool) {
        let payload: [String: Any] = [
            "type": type,
            "targetMachineId": machine.id,
            "dropIn": dropIn,
            "machineInfo": localMachineInfo(domainUsed: machine.domainUsed),
            "connectionPolicy": [
                "dropInAllowed": machine.allowDropIn,
                "autoConnect": machine.autoConnect,
                "autoStartInteractionOnConnect": UserDefaults.standard.bool(forKey: "autoStartInteractionOnConnect"),
                "remoteControlAllowed": machine.allowRemoteControl,
                "swapControlAllowed": machine.allowSwapControl,
                "keyboardCoUseAllowed": machine.allowKeyboardCoUse,
                "microphoneAudioAllowed": machine.allowMicrophoneAudio,
                "systemAudioAllowed": machine.allowSystemAudio,
                "clipboardAllowed": machine.allowClipboardSync,
                "fileTransferAllowed": machine.allowFileTransfer,
                "managedMachineConfirmation": "desktop-built-in",
                "companionConfirmationSupported": true,
                "companionPlatform": "iOS",
                "autoMuteControlledComputerAudio": UserDefaults.standard.bool(forKey: "autoMuteRemoteAudio"),
                "autoMuteProcessesOnConnect": autoMuteProcessList()
            ]
        ]

        sendWebSocketResponse(payload, serverId: machine.id, broadcast: true)
    }

    private func sendMachineAction(_ machine: OpenLinkMachine, type: String, extras: [String: Any]) {
        var payload: [String: Any] = [
            "type": type,
            "targetMachineId": machine.id,
            "machineInfo": localMachineInfo(domainUsed: machine.domainUsed),
            "connectionPolicy": globalConnectionPolicy()
        ]
        for (key, value) in extras {
            payload[key] = value
        }
        sendWebSocketResponse(payload, serverId: machine.id, broadcast: true)
    }

    private func localMachineInfo(domainUsed: String) -> [String: Any] {
        [
            "id": getClientId(),
            "displayName": Host.current().localizedName ?? "Mac",
            "hostname": Host.current().localizedName ?? "mac",
            "domainUsed": domainUsed,
            "platform": "macOS"
        ]
    }

    private func globalConnectionPolicy() -> [String: Any] {
        [
            "trustedOnly": trustedDevicesOnly,
            "autoStartInteractionOnConnect": UserDefaults.standard.bool(forKey: "autoStartInteractionOnConnect"),
            "remoteControlAllowed": allowRemoteControl,
            "swapControlAllowed": true,
            "keyboardCoUseAllowed": true,
            "microphoneAudioAllowed": true,
            "systemAudioAllowed": true,
            "autoMuteControlledComputerAudio": UserDefaults.standard.bool(forKey: "autoMuteRemoteAudio"),
            "autoMuteProcessesOnConnect": autoMuteProcessList(),
            "managedMachineConfirmation": "desktop-built-in",
            "companionConfirmationSupported": true,
            "companionPlatform": "iOS"
        ]
    }

    func normalizeEndpoint(_ rawValue: String) -> String {
        var value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty {
            return "wss://openlink.raywonderis.me/ws"
        }
        if !value.contains("://") {
            value = "wss://\(value)"
        }
        guard var components = URLComponents(string: value) else {
            return "wss://openlink.raywonderis.me/ws"
        }
        if components.host?.lowercased().hasPrefix("dvc.") == true {
            return "wss://openlink.raywonderis.me/ws"
        }
        if components.scheme == "http" {
            components.scheme = "ws"
        } else if components.scheme == "https" {
            components.scheme = "wss"
        }
        if components.path.isEmpty || components.path == "/" {
            components.path = "/ws"
        }
        return components.string ?? "wss://openlink.raywonderis.me/ws"
    }

    private func signalingEndpoint(for machine: OpenLinkMachine) -> String {
        if isOpenLinkBackendHost(machine.domainUsed) {
            return normalizeEndpoint(machine.domainUsed)
        }

        return normalizeEndpoint(UserDefaults.standard.string(forKey: "openLinkBackendUrl") ?? "wss://openlink.raywonderis.me/ws")
    }

    private func isOpenLinkBackendHost(_ value: String) -> Bool {
        var text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty {
            return false
        }
        if !text.contains("://") {
            text = "wss://\(text)"
        }
        guard let host = URL(string: text)?.host?.lowercased() else {
            return false
        }
        if host.split(separator: ".").allSatisfy({ Int($0) != nil }) {
            return false
        }
        return host.contains("openlink.") || host.hasPrefix("ol.") || host.hasPrefix("link.")
    }

    private func getClientId() -> String {
        if let id = UserDefaults.standard.string(forKey: "openLinkClientId") {
            return id
        }
        let newId = UUID().uuidString
        UserDefaults.standard.set(newId, forKey: "openLinkClientId")
        return newId
    }

    private func describeConnectionStrength(online: Bool, latencyMs: Int?) -> String {
        guard online else { return "Signal strength: down" }
        guard let latencyMs else { return "Signal strength: unknown" }
        let rating: String
        switch latencyMs {
        case ..<100:
            rating = "great"
        case ..<250:
            rating = "good"
        case ..<600:
            rating = "fair"
        default:
            rating = "poor"
        }
        return "Signal strength: \(rating) (\(latencyMs) ms)"
    }

    private func autoMuteProcessList() -> [String] {
        let raw = UserDefaults.standard.string(forKey: "autoMutedProcesses") ?? "VoiceOver, Music"
        return raw
            .split { character in character == "," || character == ";" || character.isNewline }
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    private func postStatusNotification(title: String, body: String) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
            center.add(request)
        }
    }

    private func postConnectionNotification(from fromDevice: String, to toDevice: String, connected: Bool) {
        guard UserDefaults.standard.bool(forKey: "showConnectionNotifications") else { return }
        let state = connected ? "connected" : "disconnected"
        postStatusNotification(
            title: "OpenLink",
            body: "Connection from \(fromDevice) to \(toDevice) has \(state)."
        )
    }
}

// MARK: - Config Model

struct OpenLinkConfig: Codable {
    var connectionMode: String = "Auto"
    var serverPort: Int = 3000
    var discoveryEnabled: Bool = true
    var allowRemoteControl: Bool = true
    var trustedDevicesOnly: Bool = false
}

// MARK: - Notifications

extension Notification.Name {
    static let openLinkServiceStarted = Notification.Name("openLinkServiceStarted")
    static let openLinkServiceStopped = Notification.Name("openLinkServiceStopped")
    static let openLinkDeviceConnected = Notification.Name("openLinkDeviceConnected")
    static let openLinkDeviceDisconnected = Notification.Name("openLinkDeviceDisconnected")
}
