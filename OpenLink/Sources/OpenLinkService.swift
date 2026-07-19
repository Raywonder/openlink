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
    private static let interactionShortcutHelp = "To interact with the connected device, choose Start Using the device. Use the OpenLink status menu for controller actions, disconnect, swap control, and audio. Hold Control Option Shift Backslash to force disconnect and return keyboard control locally."
    static let canonicalWebSocketURL = "wss://openlink.tappedin.fm/ws"
    static let canonicalPublicURL = "https://openlink.tappedin.fm"
    static let canonicalShareHost = "openlink.tappedin.fm"
    static let approvedWebSocketURLs = [
        "wss://openlink.tappedin.fm/ws",
        "wss://openlink.raywonderis.me/ws",
        "wss://openlink.devinecreations.net/ws",
        "wss://openlink.devine-creations.com/ws"
    ]
    static let approvedPublicURLs = [
        "https://openlink.tappedin.fm",
        "https://openlink.raywonderis.me",
        "https://openlink.devinecreations.net",
        "https://openlink.devine-creations.com"
    ]

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
    @Published var runtimeLogMessages: [String] = []

    // Settings
    @Published var discoveryEnabled = true
    @Published var allowRemoteControl = true
    @Published var trustedDevicesOnly = false

    var hasActiveMachineConnection: Bool {
        connectedDevices > 0 || machines.contains { $0.isOnline && !isLocalMachine($0) }
    }

    func hasConnectedRemoteSession(with machine: OpenLinkMachine) -> Bool {
        guard isConnectableMachine(machine), machine.isOnline else { return false }
        guard let activeMachineName, !activeMachineName.isEmpty else { return false }
        return activeMachineName.caseInsensitiveCompare(machine.displayName) == .orderedSame ||
               activeMachineName.caseInsensitiveCompare(machine.id) == .orderedSame ||
               activeMachineName.caseInsensitiveCompare(machine.machineHostname) == .orderedSame
    }

    func recentConnectableMachines(limit: Int = 6) -> [OpenLinkMachine] {
        Array(machines
            .filter(isConnectableMachine)
            .sorted { first, second in
                if first.isOnline != second.isOnline {
                    return first.isOnline && !second.isOnline
                }

                let firstDate = first.lastConnectedAt ?? first.lastDisconnectedAt ?? .distantPast
                let secondDate = second.lastConnectedAt ?? second.lastDisconnectedAt ?? .distantPast
                if firstDate != secondDate {
                    return firstDate > secondDate
                }

                return first.displayName.localizedCaseInsensitiveCompare(second.displayName) == .orderedAscending
            }
            .prefix(limit))
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
    private let webSocketSendQueue = DispatchQueue(label: "fm.tappedin.openlink.websocket-send")
    private var webSocketHeartbeatTimers: [String: Timer] = [:]
    private var lastWebSocketPongAt: [String: Date] = [:]
    private var reconnectingWebSocketIds: Set<String> = []
    private var discoveryTimer: Timer?
    private var serviceHealthTimer: Timer?
    private var lastServiceOnline: Bool?
    private var localSignalSessionId: String = ""

    // Paths
    private let configPath = NSHomeDirectory() + "/.openlink/config.json"
    private let serversPath = NSHomeDirectory() + "/.openlink/servers.json"
    private let machinesPath = NSHomeDirectory() + "/.openlink/machines.json"
    private let runtimeLogPath = NSHomeDirectory() + "/.openlink/logs/openlink-macos.log"
    private let runtimeLogMaxBytes: UInt64 = 1024 * 1024

    init() {
        UserDefaults.standard.register(defaults: [
            "showOnlineOfflineNotifications": true,
            "showConnectionNotifications": true,
            "showElapsedConnectionTime": true,
            "announceConnectionStrength": true,
            "enableDiagnosticSending": true,
            "customSignalingServerAccessEnabled": false,
            "openLinkBackendUrl": Self.canonicalWebSocketURL,
            "checkForUpdatesAutomatically": true,
            "installUpdatesAutomatically": true,
            "updateManifestUrl": OpenLinkUpdater.cloudUpdateManifestURL,
            "launchAtLogin": true,
            "startMinimizedStatusMenu": true,
            "tamperProtectionEnabled": false,
            "autoReconnectOnLaunch": true,
            "autoStartInteractionOnConnect": true,
            "sessionPrefix": "mac",
            "startHostingOnLaunch": false,
            "copyLinkWhenHostingStarts": true,
            "minimizeToTrayOnClose": true,
            "allowClipboardSync": true,
            "allowFileTransfer": true,
            "allowAudio": true,
            "allowDropInAccess": false,
            "allowSwapControl": true,
            "allowKeyboardCoUse": true,
            "autoConnectTrustedMachines": true,
            "allowRemoteApplicationLaunch": true,
            "requireApprovalForNewDevices": true,
            "autoMuteRemoteAudio": false,
            "muteRemoteAudioWhenInactive": true,
            "autoMutedProcesses": "VoiceOver, Music",
            "allowMicrophoneAudio": true,
            "allowSystemAudio": true,
            "remoteAudioVolumePercent": 100.0,
            "localAudioCaptureVolumePercent": 100.0,
            "useVoiceLinkAudioFallback": true,
            "voiceLinkAudioFallbackUrl": "wss://voicelink.tappedin.fm/openlink/audio",
            "announceStatusChanges": true,
            "detailedScreenReaderMessages": true,
            "soundAlerts": true,
            "reduceMotion": false,
            "enableLocalTtsHelper": false,
            "localTtsVoiceId": "",
            "localTtsRate": 1.0,
            "localTtsVolumePercent": 100.0,
            "ttsFallbackMode": "screen-reader",
            "enableBrailleDisplaySupport": false,
            "routeBrailleToRemoteWhenConnected": true,
            "brailleProvider": "auto",
            "brlttyExecutablePath": "",
            "showActivityLog": false,
            "updateChannel": "Stable",
            "localServerEnabled": false,
            "localServerPort": "8765"
        ])
        enforceDefaultSignalingEndpoint()
        loadConfiguration()
        loadServers()
        loadMachines()
        migratePairedServersToMachines()
        seedTrustedMachinePair()
        normalizeManagedMachineRouting()
        refreshLocalMachinePresence()
    }

    // MARK: - Service Control

    private func enforceDefaultSignalingEndpoint() {
        let defaults = UserDefaults.standard
        let allowCustomServer = defaults.bool(forKey: "customSignalingServerAccessEnabled")
        let current = defaults.string(forKey: "openLinkBackendUrl") ?? Self.canonicalWebSocketURL
        let normalized = normalizeEndpoint(current, allowCustomServer: allowCustomServer)
        defaults.set(normalized, forKey: "openLinkBackendUrl")
    }

    func start() {
        guard !isRunning else { return }

        // Start local server for incoming connections
        startListener()

        // Start discovery if enabled
        if discoveryEnabled {
            startDiscovery()
        }
        startServiceHealthPolling()
        ensureLocalSignalingConnection()

        if UserDefaults.standard.bool(forKey: "autoReconnectOnLaunch") {
            for machine in machines where machine.autoConnect && isConnectableMachine(machine) {
                connectToMachine(machine, dropIn: machine.allowDropIn)
            }
        }

        isRunning = true
        detectLocalIP()
        refreshLocalMachinePresence()

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
        lastWebSocketPongAt.removeAll()
        for (_, timer) in webSocketHeartbeatTimers {
            timer.invalidate()
        }
        webSocketHeartbeatTimers.removeAll()
        reconnectingWebSocketIds.removeAll()

        // Stop discovery
        discoveryTimer?.invalidate()
        discoveryTimer = nil
        serviceHealthTimer?.invalidate()
        serviceHealthTimer = nil

        isRunning = false
        connectedDevices = 0
        connectionStartedAt = nil
        activeMachineName = nil
        refreshLocalMachinePresence()

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
                let success = (response["success"] as? Bool) ?? true
                if success, let controllerMachineId = controllerMachineId(from: json) {
                    OpenLinkAudioBridge.shared.startCapture(
                        targetMachineId: controllerMachineId,
                        directBufferSamples: json["directAudioBufferSamples"] as? Int,
                        requestedCodec: (json["audioCodec"] as? String) ?? (json["requestedAudioCodec"] as? String)
                    ) { [weak self] frame in
                        self?.sendResponse(frame, to: connectionId)
                    }
                } else if !success {
                    OpenLinkAudioBridge.shared.stopCapture()
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
        if isLocalServer(server) {
            connectToServer(server)
        } else {
            ensureLocalSignalingConnection()
        }
        markMachineConnected(id: machine.id, sessionId: machine.lastSessionId)
        sendMachinePolicy(machine, type: "machine_connect_request", dropIn: dropIn ?? machine.allowDropIn)
        sendDiagnosticEvent("machine_connect_request", machine: machine, outcome: "sent", metadata: [
            "dropIn": dropIn ?? machine.allowDropIn,
            "endpoint": normalized,
            "autoStartInteraction": startInteraction ?? UserDefaults.standard.bool(forKey: "autoStartInteractionOnConnect")
        ])
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
        sendDiagnosticEvent("disconnect_user", machine: machine, outcome: "sent")
        markMachineDisconnected(id: machine.id)
    }

    func disconnectFromMachine(_ machine: OpenLinkMachine) {
        sendMachinePolicy(machine, type: "controller_disconnect", dropIn: false)
        sendDiagnosticEvent("controller_disconnect", machine: machine, outcome: "sent")
        markMachineDisconnected(id: machine.id)
    }

    func forceDisconnectActiveSession(reason: String = "Control Option Shift Backslash emergency disconnect") {
        OpenLinkAudioBridge.shared.stopCapture()
        RemoteControlManager.shared.disconnect()

        let candidate = machines
            .filter { !isLocalMachine($0) && ($0.isOnline || $0.lastConnectedAt != nil) }
            .sorted {
                ($0.lastConnectedAt ?? .distantPast) > ($1.lastConnectedAt ?? .distantPast)
            }
            .first

        if let machine = candidate {
            sendMachinePolicy(machine, type: "controller_disconnect", dropIn: false)
            sendMachinePolicy(machine, type: "disconnect_user", dropIn: false)
            sendDiagnosticEvent("emergency_disconnect", machine: machine, outcome: "sent", metadata: ["reason": reason])
            markMachineDisconnected(id: machine.id)
            postStatusNotification(title: "OpenLink emergency disconnect", body: "Disconnected \(machine.displayName). Keyboard and audio returned locally.")
        } else {
            sendDiagnosticEvent("emergency_disconnect", outcome: "local_only", metadata: ["reason": reason])
            postStatusNotification(title: "OpenLink emergency disconnect", body: "Keyboard and audio returned locally. No active remote machine was found.")
        }
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
        sendDiagnosticEvent("start_interaction", machine: machine, outcome: "sent", metadata: [
            "audioDirection": "bidirectional",
            "audioTransport": "native-coreaudio",
            "keyboardControl": true
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
        sendDiagnosticEvent("pause_interaction", machine: machine, outcome: "sent", metadata: [
            "muteRemoteAudio": UserDefaults.standard.bool(forKey: "muteRemoteAudioWhenInactive")
        ])
        NSApplication.shared.activate(ignoringOtherApps: true)
        postStatusNotification(title: "OpenLink", body: "Remote control for \(machine.displayName) minimized for local use.")
    }

    func swapControl(with machine: OpenLinkMachine) {
        guard ensureConnectableMachine(machine, action: "swap control with") else { return }

        sendMachinePolicy(machine, type: "swap_control_request", dropIn: machine.allowDropIn)
        sendDiagnosticEvent("swap_control_request", machine: machine, outcome: "sent", metadata: [
            "keyboardCoUse": machine.allowKeyboardCoUse,
            "microphoneAudio": machine.allowMicrophoneAudio,
            "systemAudio": machine.allowSystemAudio
        ])
    }

    func openRemoteSettings(for machine: OpenLinkMachine) {
        guard ensureConnectableMachine(machine, action: "open remote settings on") else { return }

        let trustedOwner = machine.isTrusted || machine.allowDropIn || machine.autoConnect
        sendMachineAction(machine, type: "machine_management_action", extras: [
            "action": "open_settings",
            "trustedOwner": trustedOwner,
            "settingsScope": "full",
            "requiresApprovalIfGuest": UserDefaults.standard.bool(forKey: "requireApprovalForGuestRemoteSettingsChanges")
        ])
        sendDiagnosticEvent("remote_settings_open", machine: machine, outcome: "sent", metadata: [
            "trustedOwner": trustedOwner
        ])
        postStatusNotification(title: "OpenLink", body: "Requested OpenLink settings on \(machine.displayName). Trusted owner devices can open settings directly; guest requests require local approval.")
    }

    func isConnectableMachine(_ machine: OpenLinkMachine) -> Bool {
        !isLocalMachine(machine)
    }

    func isCurrentMachine(_ machine: OpenLinkMachine) -> Bool {
        isLocalMachine(machine)
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
        var rawNames = [
            localStableMachineId(),
            getClientId(),
            Host.current().localizedName ?? "",
            ProcessInfo.processInfo.hostName
        ]

        #if os(macOS)
        rawNames.append(contentsOf: [
            "admin-s-mac-mini",
            "admins-mac-mini",
            "Admin's Mac mini"
        ])
        #endif

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

    private func localStableMachineId() -> String {
        #if os(macOS)
        return "admin-s-mac-mini"
        #else
        return ProcessInfo.processInfo.hostName
        #endif
    }

    private func localStableMachineName() -> String {
        #if os(macOS)
        return "Admin's Mac mini"
        #else
        return Host.current().localizedName ?? ProcessInfo.processInfo.hostName
        #endif
    }

    private func stableLocalSignalSessionId() -> String {
        if !localSignalSessionId.isEmpty {
            return localSignalSessionId
        }

        let key = "localSignalSessionId"
        if let existing = UserDefaults.standard.string(forKey: key), !existing.isEmpty {
            localSignalSessionId = existing
            return existing
        }

        let generated = "mac-\(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(8))"
        UserDefaults.standard.set(generated, forKey: key)
        localSignalSessionId = generated
        return generated
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

    private func ensureLocalSignalingConnection() {
        let localId = localStableMachineId()
        if webSocketTasks[localId] != nil {
            return
        }

        let server = PairedServer(
            id: localId,
            name: localStableMachineName(),
            url: UserDefaults.standard.string(forKey: "openLinkBackendUrl") ?? Self.canonicalWebSocketURL,
            accessToken: ""
        )
        connectViaOpenLink(server)
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
            runtimeLog("invalid signaling URL for \(server.id): \(server.url)")
            return
        }

        var request = URLRequest(url: url)
        request.setValue(server.accessToken, forHTTPHeaderField: "Authorization")
        let isLocalRegistration = server.id == localStableMachineId()
        runtimeLog("connecting websocket for \(server.id) to \(url.host ?? "unknown-host") localRegistration=\(isLocalRegistration)")

        let task = URLSession.shared.webSocketTask(with: request)
        webSocketTasks[server.id] = task
        lastWebSocketPongAt[server.id] = Date()

        task.resume()

        // Start receiving messages
        receiveWebSocketMessages(serverId: server.id)

        // Register the local Mac exactly like the Windows host path. The signal
        // server keeps routed target presence for create_session; a legacy
        // handshake alone can leave this Mac visible locally but offline to peers.
        let machineInfo = localMachineInfo(domainUsed: url.host ?? "openlink.tappedin.fm")
        let handshake: [String: Any]
        if isLocalRegistration {
            handshake = [
                "type": "create_session",
                "sessionId": stableLocalSignalSessionId(),
                "password": "",
                "machineInfo": machineInfo,
                "connectionPolicy": globalConnectionPolicy(),
                "hostInfo": [
                    "machineId": localStableMachineId(),
                    "machineName": localStableMachineName(),
                    "os": "macOS",
                    "app": "OpenLink",
                    "version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.7.34",
                    "permissions": [
                        "remoteControl": allowRemoteControl,
                        "clipboard": UserDefaults.standard.bool(forKey: "allowClipboardSync"),
                        "fileTransfer": UserDefaults.standard.bool(forKey: "allowFileTransfer"),
                        "audio": UserDefaults.standard.object(forKey: "allowAudio") as? Bool ?? true,
                        "dropIn": UserDefaults.standard.bool(forKey: "allowDropInAccess"),
                        "swapControl": UserDefaults.standard.bool(forKey: "allowSwapControl"),
                        "keyboardCoUse": false,
                        "microphoneAudio": UserDefaults.standard.object(forKey: "allowMicrophoneAudio") as? Bool ?? true,
                        "systemAudio": UserDefaults.standard.object(forKey: "allowSystemAudio") as? Bool ?? true
                    ]
                ]
            ]
        } else {
            handshake = [
                "type": "handshake",
                "clientId": getClientId(),
                "clientName": localStableMachineName(),
                "machineInfo": machineInfo,
                "connectionPolicy": globalConnectionPolicy()
            ]
        }

        if let data = try? JSONSerialization.data(withJSONObject: handshake),
           let string = String(data: data, encoding: .utf8) {
            task.send(.string(string)) { [weak self] error in
                if let error {
                    self?.runtimeLog("failed to send signaling registration for \(server.id): \(error.localizedDescription)")
                }
            }
        }
        runtimeLog("sent \(handshake["type"] as? String ?? "handshake") for \(server.id) localMachineId=\(localStableMachineId()) aliases=\(Array(localMachineIdentityTokens()).joined(separator: ","))")
        sendDiagnosticEvent("signaling_connected", serverId: server.id, outcome: "success", metadata: [
            "endpoint": url.host ?? "openlink.tappedin.fm",
            "transport": "websocket"
        ])

        updateServerOnlineStatus(serverId: server.id, isOnline: true)
        if isLocalRegistration {
            startWebSocketHeartbeat(for: server, machineInfo: machineInfo)
            refreshLocalMachinePresence()
        } else {
            markMachineConnected(id: server.id, sessionId: nil)
        }
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

            case .failure(let error):
                self?.runtimeLog("websocket receive failed for \(serverId): \(error.localizedDescription)")
                self?.updateServerOnlineStatus(serverId: serverId, isOnline: false)
                self?.webSocketTasks.removeValue(forKey: serverId)
                self?.lastWebSocketPongAt.removeValue(forKey: serverId)
                self?.stopWebSocketHeartbeat(for: serverId)
                self?.scheduleLocalSignalingReconnectIfNeeded(serverId: serverId, reason: error.localizedDescription)
                self?.sendDiagnosticEvent("signaling_receive_failed", serverId: serverId, outcome: "error", metadata: [
                    "error": error.localizedDescription
                ])
            }
        }
    }

    private func handleWebSocketMessage(_ data: Data, serverId: String) {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else {
            return
        }

        switch type {
        case "connected":
            lastWebSocketPongAt[serverId] = Date()
            runtimeLog("signaling connected serverId=\(serverId) connectionId=\(json["connectionId"] as? String ?? "unknown") version=\(json["version"] as? String ?? "unknown")")
        case "session_created", "host_session_ok", "host-session-ok", "handshake_ack", "pong":
            lastWebSocketPongAt[serverId] = Date()
            updateServerOnlineStatus(serverId: serverId, isOnline: true)
            if type != "pong" {
                runtimeLog("received \(type) for \(serverId)")
            }
        case "remote_command":
            let result = processRemoteCommand(json["command"] as? String ?? "", parameters: json)
            sendWebSocketResponse(result, serverId: serverId)
        case "ping":
            sendWebSocketResponse(["type": "pong"], serverId: serverId)
        case "broadcast":
            if let data = json["data"] as? [String: Any] {
                var payload = data
                for key in ["fromId", "fromConnectionId", "sourceMachineId", "sourceMachineName", "sourcePlatform"] {
                    if payload[key] == nil, let value = json[key] {
                        payload[key] = value
                    }
                }
                handleWebSocketControlMessage(payload, serverId: serverId, respondWithBroadcast: true)
            }
        case "diagnostic_event_ack":
            break
        case "machine_connect_request":
            if messageTargetsLocalMachine(json) {
                runtimeLog("received machine_connect_request from \(controllerMachineId(from: json) ?? "unknown-controller")")
                RemoteControlManager.shared.isRemoteControlActive = true
                RemoteControlManager.shared.isReceivingControl = false
                sendWebSocketResponse(["type": "machine_connect_ack", "success": true, "targetMachineId": controllerMachineId(from: json) ?? getClientId(), "sourceMachineId": localStableMachineId()], serverId: serverId)
                runtimeLog("sent machine_connect_ack to \(controllerMachineId(from: json) ?? "unknown-controller")")
                sendDiagnosticEvent("machine_connect_ack", serverId: serverId, outcome: "success")
                postStatusNotification(title: "OpenLink", body: "Trusted machine connected. Keyboard and audio interaction can start from the controlling computer.")
            }
        case "machine_management_action":
            handleMachineManagementAction(json, serverId: serverId)
        case "start_interaction", "pause_interaction", "controller_disconnect", "disconnect_user", "input_event", "key_event":
            runtimeLog("received \(type) target=\(json["targetMachineId"] as? String ?? "none") controller=\(controllerMachineId(from: json) ?? "unknown-controller")")
            handleWebSocketControlMessage(json, serverId: serverId)
            if type == "disconnect_user" {
                disconnectMachineById(serverId)
            }
        case "audio_frame":
            handleWebSocketControlMessage(json, serverId: serverId)
        case "tts_announcement", "screen_reader_announcement", "braille_announcement":
            handleRemoteAccessibilityAnnouncement(json)
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

        let incomingType = json["type"] as? String
        if incomingType == "start_interaction" {
            installRemoteAccessibilitySink(originalMessage: json, serverId: serverId, broadcast: respondWithBroadcast)
        }

        if let response = RemoteControlManager.shared.handleSignalingMessage(json) {
            let routedResponse = responseForController(response, originalMessage: json, serverId: serverId)
            if let type = incomingType, type == "start_interaction" {
                sendWebSocketResponse(routedResponse, serverId: serverId, broadcast: respondWithBroadcast)
                let success = routedResponse["success"] as? Bool ?? true
                let message = routedResponse["message"] as? String ?? (success
                    ? "Remote control active. Audio is starting."
                    : "OpenLink needs macOS Accessibility and Input Monitoring permissions before keyboard control can start.")
                runtimeLog("sent start_interaction_ack success=\(success) target=\(routedResponse["targetMachineId"] as? String ?? "unknown-controller") accessibilityTrusted=\(routedResponse["accessibilityTrusted"] as? Bool ?? false) accessibilityTrustedBeforePrompt=\(routedResponse["accessibilityTrustedBeforePrompt"] as? Bool ?? false) bundleId=\(routedResponse["diagnosticBundleIdentifier"] as? String ?? "unknown") bundlePath=\(routedResponse["diagnosticBundlePath"] as? String ?? "unknown") executablePath=\(routedResponse["diagnosticExecutablePath"] as? String ?? "unknown") processName=\(routedResponse["diagnosticProcessName"] as? String ?? "unknown")")
                postStatusNotification(title: "OpenLink", body: message)
                sendControllerAnnouncement(message, originalMessage: json, serverId: serverId, broadcast: respondWithBroadcast)
                if success {
                    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                        self?.startAudioBridgeForController(from: json, serverId: serverId, respondWithBroadcast: respondWithBroadcast)
                    }
                } else {
                    RemoteControlManager.shared.remoteAccessibilitySink = nil
                    OpenLinkAudioBridge.shared.stopCapture()
                    runtimeLog("did not start audio bridge because start_interaction was rejected")
                }
            } else {
                if let type = incomingType,
                   type == "pause_interaction" || type == "controller_disconnect" || type == "disconnect_user" {
                    RemoteControlManager.shared.remoteAccessibilitySink = nil
                    OpenLinkAudioBridge.shared.stopCapture()
                    runtimeLog("stopped audio capture after \(type)")
                }
                sendWebSocketResponse(routedResponse, serverId: serverId, broadcast: respondWithBroadcast)
                runtimeLog("sent \(routedResponse["type"] as? String ?? "control_ack") target=\(routedResponse["targetMachineId"] as? String ?? "unknown-controller")")
            }
        }
    }

    private func handleMachineManagementAction(_ json: [String: Any], serverId: String) {
        guard messageTargetsLocalMachine(json),
              let action = json["action"] as? String else { return }

        switch action {
        case "list_applications":
            let applications = NSWorkspace.shared.runningApplications.compactMap { app -> [String: Any]? in
                guard let name = app.localizedName else { return nil }
                return [
                    "processId": Int(app.processIdentifier),
                    "pid": Int(app.processIdentifier),
                    "name": name,
                    "path": app.bundleURL?.path ?? app.bundleIdentifier ?? "",
                    "bundleId": app.bundleIdentifier ?? "",
                    "windowTitle": "",
                    "memoryMb": 0,
                    "status": app.isActive ? "active" : (app.isHidden ? "hidden" : "running"),
                    "isActive": app.isActive,
                    "isHidden": app.isHidden
                ]
            }
            let response: [String: Any] = [
                "type": "application_list",
                "targetMachineId": controllerMachineId(from: json) ?? getClientId(),
                "sourceMachineId": localStableMachineId(),
                "applications": applications
            ]
            sendWebSocketResponse(response, serverId: serverId, broadcast: true)
            runtimeLog("sent application_list count=\(applications.count) target=\(controllerMachineId(from: json) ?? "unknown-controller")")
        case "open_settings":
            let trustedOwner = json["trustedOwner"] as? Bool ?? false
            let allowRemoteSettings = UserDefaults.standard.object(forKey: "allowRemoteSettingsManagement") as? Bool ?? true
            let allowTrustedOwner = UserDefaults.standard.object(forKey: "allowTrustedOwnerRemoteSettingsChanges") as? Bool ?? true
            let requireGuestApproval = UserDefaults.standard.object(forKey: "requireApprovalForGuestRemoteSettingsChanges") as? Bool ?? true
            let accepted = allowRemoteSettings && ((trustedOwner && allowTrustedOwner) || !requireGuestApproval)
            let message = accepted
                ? "OpenLink settings opened on \(localStableMachineName())."
                : "OpenLink settings request needs local approval on \(localStableMachineName())."

            let response = responseForController([
                "type": "machine_management_action_ack",
                "action": "open_settings",
                "success": accepted,
                "message": message,
                "requiresLocalApproval": !accepted && requireGuestApproval,
                "trustedOwner": trustedOwner
            ], originalMessage: json, serverId: serverId)
            sendWebSocketResponse(response, serverId: serverId, broadcast: true)
            runtimeLog("remote settings request accepted=\(accepted) trustedOwner=\(trustedOwner) target=\(response["targetMachineId"] as? String ?? "unknown-controller")")

            if accepted {
                DispatchQueue.main.async {
                    NotificationCenter.default.post(name: .openOpenLinkSettingsWindow, object: nil)
                }
            } else {
                postStatusNotification(title: "OpenLink settings request", body: "A remote device requested settings access. Approve the device as trusted or disable guest approval before allowing remote settings changes.")
            }
        case "set_audio_settings":
            let trustedOwner = json["trustedOwner"] as? Bool ?? false
            let accepted = trustedOwner
            if accepted, let audioSettings = json["audioSettings"] as? [String: Any] {
                if let allowMicrophoneAudio = audioSettings["allowMicrophoneAudio"] as? Bool {
                    UserDefaults.standard.set(allowMicrophoneAudio, forKey: "allowMicrophoneAudio")
                }
                if let allowSystemAudio = audioSettings["allowSystemAudio"] as? Bool {
                    UserDefaults.standard.set(allowSystemAudio, forKey: "allowSystemAudio")
                }
                if let remoteAudioVolumePercent = audioSettings["remoteAudioVolumePercent"] as? Int {
                    UserDefaults.standard.set(max(0, min(150, remoteAudioVolumePercent)), forKey: "remoteAudioVolumePercent")
                }
                if let directAudioBufferSamples = audioSettings["directAudioBufferSamples"] as? Int {
                    UserDefaults.standard.set(max(16, min(2048, directAudioBufferSamples)), forKey: "directAudioBufferSamples")
                }
                if let windowsAudioBufferSamples = audioSettings["windowsAudioBufferSamples"] as? Int {
                    UserDefaults.standard.set(max(16, min(2048, windowsAudioBufferSamples)), forKey: "macAudioPlaybackBufferSamples")
                }
                if let audioStreamingCodec = audioSettings["audioStreamingCodec"] as? String {
                    UserDefaults.standard.set(audioStreamingCodec, forKey: "audioStreamingCodec")
                }
                OpenLinkAudioBridge.shared.configure(
                    directBufferSamples: audioSettings["directAudioBufferSamples"] as? Int,
                    playbackBufferSamples: audioSettings["windowsAudioBufferSamples"] as? Int,
                    requestedCodec: audioSettings["audioStreamingCodec"] as? String
                )
            }
            let message = accepted
                ? "Audio settings updated on \(localStableMachineName())."
                : "Audio settings request is not allowed on \(localStableMachineName())."
            let response = responseForController([
                "type": "machine_management_action_ack",
                "action": "set_audio_settings",
                "success": accepted,
                "message": message,
                "trustedOwner": trustedOwner
            ], originalMessage: json, serverId: serverId)
            sendWebSocketResponse(response, serverId: serverId, broadcast: true)
            runtimeLog("remote audio settings request accepted=\(accepted) target=\(response["targetMachineId"] as? String ?? "unknown-controller")")
        case "lock_machine", "restart_machine", "shutdown_machine", "logout_machine":
            let trustedOwner = json["trustedOwner"] as? Bool ?? false
            let accepted = trustedOwner
            let message = accepted
                ? "Remote \(action.replacingOccurrences(of: "_", with: " ")) accepted on \(localStableMachineName())."
                : "Remote \(action.replacingOccurrences(of: "_", with: " ")) is not allowed on \(localStableMachineName())."
            let response = responseForController([
                "type": "machine_management_action_ack",
                "action": action,
                "success": accepted,
                "message": message,
                "trustedOwner": trustedOwner
            ], originalMessage: json, serverId: serverId)
            sendWebSocketResponse(response, serverId: serverId, broadcast: true)
            runtimeLog("remote machine action \(action) accepted=\(accepted) target=\(response["targetMachineId"] as? String ?? "unknown-controller")")

            if accepted {
                runLocalMachineAction(action)
            }
        default:
            break
        }
    }

    private func runLocalMachineAction(_ action: String) {
        switch action {
        case "lock_machine":
            launchProcess("/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession", arguments: ["-suspend"])
        case "restart_machine":
            launchProcess("/usr/bin/osascript", arguments: ["-e", "tell application \"System Events\" to restart"])
        case "shutdown_machine":
            launchProcess("/usr/bin/osascript", arguments: ["-e", "tell application \"System Events\" to shut down"])
        case "logout_machine":
            launchProcess("/usr/bin/osascript", arguments: ["-e", "tell application \"System Events\" to log out"])
        default:
            break
        }
    }

    private func launchProcess(_ launchPath: String, arguments: [String]) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: launchPath)
        process.arguments = arguments
        do {
            try process.run()
        } catch {
            runtimeLog("failed to run \(launchPath): \(error.localizedDescription)")
        }
    }

    private func responseForController(_ response: [String: Any], originalMessage json: [String: Any], serverId: String) -> [String: Any] {
        var routed = response
        if routed["requestId"] == nil, let requestId = json["requestId"] {
            routed["requestId"] = requestId
        }
        if routed["targetMachineId"] == nil {
            routed["targetMachineId"] = controllerMachineId(from: json) ?? serverId
        }
        if routed["sourceMachineId"] == nil {
            routed["sourceMachineId"] = localStableMachineId()
        }
        if routed["sourceMachineName"] == nil {
            routed["sourceMachineName"] = localStableMachineName()
        }
        if routed["sourcePlatform"] == nil {
            routed["sourcePlatform"] = "macOS"
        }
        return routed
    }

    private func startAudioBridgeForController(from json: [String: Any], serverId: String, respondWithBroadcast: Bool) {
        let controllerMachineId = controllerMachineId(from: json) ?? serverId

        runtimeLog("starting audio bridge for controller \(controllerMachineId) broadcast=\(respondWithBroadcast)")
        let audioStarted = OpenLinkAudioBridge.shared.startCapture(
            targetMachineId: controllerMachineId,
            directBufferSamples: json["directAudioBufferSamples"] as? Int,
            requestedCodec: (json["audioCodec"] as? String) ?? (json["requestedAudioCodec"] as? String)
        ) { [weak self] frame in
            self?.sendWebSocketResponse(frame, serverId: serverId, broadcast: respondWithBroadcast)
        }
        runtimeLog("audio bridge capture \(audioStarted ? "started" : "failed") for controller \(controllerMachineId)")
        if !audioStarted {
            sendControllerAnnouncement(
                "OpenLink could not start Mac audio capture. Check microphone or system audio recording permission on this Mac.",
                originalMessage: json,
                serverId: serverId,
                broadcast: respondWithBroadcast
            )
        }
    }

    private func sendControllerAnnouncement(_ text: String, originalMessage: [String: Any], serverId: String, broadcast: Bool) {
        guard !text.isEmpty else { return }
        let controllerMachineId = controllerMachineId(from: originalMessage) ?? serverId
        let basePayload: [String: Any] = [
            "targetMachineId": controllerMachineId,
            "sourceMachineId": localStableMachineId(),
            "sourcePlatform": "macOS",
            "priority": "assertive",
            "interrupt": true,
            "text": text
        ]
        var speechPayload = basePayload
        speechPayload["type"] = "tts_announcement"
        sendWebSocketResponse(speechPayload, serverId: serverId, broadcast: broadcast)

        if originalMessage["routeBrailleToRemoteWhenConnected"] as? Bool ?? true {
            var braillePayload = basePayload
            braillePayload["type"] = "braille_announcement"
            sendWebSocketResponse(braillePayload, serverId: serverId, broadcast: broadcast)
        }
    }

    private func installRemoteAccessibilitySink(originalMessage json: [String: Any], serverId: String, broadcast: Bool) {
        let controllerMachineId = controllerMachineId(from: json) ?? serverId
        RemoteControlManager.shared.remoteAccessibilitySink = { [weak self] text in
            guard let self else { return }
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return }
            let payload: [String: Any] = [
                "type": "tts_announcement",
                "targetMachineId": controllerMachineId,
                "sourceMachineId": self.localStableMachineId(),
                "sourcePlatform": "macOS",
                "priority": "polite",
                "interrupt": false,
                "text": trimmed
            ]
            self.sendWebSocketResponse(payload, serverId: serverId, broadcast: broadcast)
        }
    }

    private func handleRemoteAccessibilityAnnouncement(_ json: [String: Any]) {
        guard messageTargetsLocalMachine(json) else { return }
        let text = (json["text"] as? String) ?? (json["message"] as? String) ?? ""
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }

        if json["type"] as? String != "braille_announcement" {
            postAccessibilityAnnouncement(title: "", body: text, allowBrailleDuringRemoteSession: true)
        } else {
            BrlttyBridge.shared.send(text)
        }
    }

    private func controllerMachineId(from json: [String: Any]) -> String? {
        if let sourceMachineId = json["sourceMachineId"] as? String, !sourceMachineId.isEmpty {
            return sourceMachineId
        }
        if let fromMachineId = json["fromMachineId"] as? String, !fromMachineId.isEmpty {
            return fromMachineId
        }
        if let fromId = json["fromId"] as? String, !fromId.isEmpty {
            return fromId
        }
        if let fromConnectionId = json["fromConnectionId"] as? String, !fromConnectionId.isEmpty {
            return fromConnectionId
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
        let taskId = broadcast ? preferredBroadcastWebSocketTaskId(for: serverId) : preferredWebSocketTaskId(for: serverId)
        guard let task = webSocketTasks[taskId],
              let data = try? JSONSerialization.data(withJSONObject: broadcast ? ["type": "broadcast", "data": response] : response),
              let string = String(data: data, encoding: .utf8) else {
            runtimeLog("failed to send websocket response type=\(response["type"] as? String ?? "unknown") serverId=\(serverId); no signaling task")
            return
        }

        webSocketSendQueue.async {
            task.send(.string(string)) { _ in }
        }
    }

    private func preferredWebSocketTaskId(for serverId: String) -> String {
        if webSocketTasks[serverId] != nil {
            return serverId
        }

        let localId = localStableMachineId()
        if webSocketTasks[localId] != nil {
            return localId
        }

        return webSocketTasks.keys.first ?? serverId
    }

    private func preferredBroadcastWebSocketTaskId(for serverId: String) -> String {
        let localId = localStableMachineId()
        if webSocketTasks[localId] != nil {
            return localId
        }

        return preferredWebSocketTaskId(for: serverId)
    }

    private func startWebSocketHeartbeat(for server: PairedServer, machineInfo: [String: Any]) {
        stopWebSocketHeartbeat(for: server.id)
        let timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            self?.sendWebSocketHeartbeat(server: server, machineInfo: machineInfo)
        }
        webSocketHeartbeatTimers[server.id] = timer
        RunLoop.main.add(timer, forMode: .common)
        sendWebSocketHeartbeat(server: server, machineInfo: machineInfo)
    }

    private func stopWebSocketHeartbeat(for serverId: String) {
        webSocketHeartbeatTimers[serverId]?.invalidate()
        webSocketHeartbeatTimers.removeValue(forKey: serverId)
    }

    private func sendWebSocketHeartbeat(server: PairedServer, machineInfo: [String: Any]) {
        guard let task = webSocketTasks[server.id] else {
            stopWebSocketHeartbeat(for: server.id)
            scheduleLocalSignalingReconnectIfNeeded(serverId: server.id, reason: "missing websocket task")
            return
        }

        if let lastPong = lastWebSocketPongAt[server.id],
           Date().timeIntervalSince(lastPong) > 45 {
            runtimeLog("websocket heartbeat timed out for \(server.id); reconnecting to refresh machine presence")
            task.cancel(with: .goingAway, reason: nil)
            webSocketTasks.removeValue(forKey: server.id)
            lastWebSocketPongAt.removeValue(forKey: server.id)
            stopWebSocketHeartbeat(for: server.id)
            scheduleLocalSignalingReconnectIfNeeded(serverId: server.id, reason: "heartbeat timeout")
            return
        }

        let payload: [String: Any] = [
            "type": "ping",
            "machineInfo": machineInfo,
            "connectionPolicy": globalConnectionPolicy(),
            "timestamp": Int(Date().timeIntervalSince1970 * 1000)
        ]

        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let string = String(data: data, encoding: .utf8) else {
            return
        }

        task.send(.string(string)) { [weak self] error in
            guard let error else { return }
            DispatchQueue.main.async {
                self?.runtimeLog("websocket heartbeat failed for \(server.id): \(error.localizedDescription)")
                self?.webSocketTasks.removeValue(forKey: server.id)
                self?.stopWebSocketHeartbeat(for: server.id)
                self?.scheduleLocalSignalingReconnectIfNeeded(serverId: server.id, reason: error.localizedDescription)
            }
        }

        task.sendPing { [weak self] error in
            DispatchQueue.main.async {
                if let error {
                    self?.runtimeLog("websocket native ping failed for \(server.id): \(error.localizedDescription)")
                    return
                }
                self?.lastWebSocketPongAt[server.id] = Date()
            }
        }
    }

    private func scheduleLocalSignalingReconnectIfNeeded(serverId: String, reason: String) {
        let localId = localStableMachineId()
        guard serverId == localId, isRunning, !reconnectingWebSocketIds.contains(serverId) else {
            return
        }

        reconnectingWebSocketIds.insert(serverId)
        runtimeLog("scheduling local signaling reconnect for \(serverId): \(reason)")
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self else { return }
            self.reconnectingWebSocketIds.remove(serverId)
            if self.isRunning && self.webSocketTasks[serverId] == nil {
                self.ensureLocalSignalingConnection()
            }
        }
    }

    private func sendDiagnosticEvent(_ eventName: String, machine: OpenLinkMachine? = nil, serverId: String? = nil, outcome: String = "info", metadata: [String: Any] = [:]) {
        guard UserDefaults.standard.bool(forKey: "enableDiagnosticSending") else { return }

        let targetServerId = serverId ?? machine?.id
        guard let targetServerId,
              let task = webSocketTasks[preferredWebSocketTaskId(for: targetServerId)] else {
            return
        }

        var safeMetadata: [String: Any] = [:]
        for (key, value) in metadata {
            if let string = value as? String {
                safeMetadata[key] = String(string.prefix(240))
            } else if let number = value as? NSNumber {
                safeMetadata[key] = number
            } else if let bool = value as? Bool {
                safeMetadata[key] = bool
            }
        }

        let payload: [String: Any] = [
            "type": "diagnostic_event",
            "eventName": eventName,
            "sessionId": machine?.lastSessionId ?? targetServerId,
            "sourceMachineId": localStableMachineId(),
            "sourceMachineName": localStableMachineName(),
            "sourcePlatform": "macOS",
            "targetMachineId": machine?.id ?? targetServerId,
            "targetMachineName": machine?.displayName ?? targetServerId,
            "targetPlatform": machine?.platform ?? "Unknown",
            "outcome": outcome,
            "metadata": safeMetadata
        ]

        guard let data = try? JSONSerialization.data(withJSONObject: payload),
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
        let healthUrl = URL(string: "https://openlink.tappedin.fm/health")!
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
        runtimeLog("loaded \(machines.count) machine records")
    }

    func saveMachines() {
        guard let data = try? JSONEncoder().encode(machines) else { return }
        try? FileManager.default.createDirectory(at: URL(fileURLWithPath: NSHomeDirectory() + "/.openlink"), withIntermediateDirectories: true)
        try? data.write(to: URL(fileURLWithPath: machinesPath))
    }

    private func runtimeLog(_ message: String) {
        let safeMessage = message
            .replacingOccurrences(of: "\r", with: " ")
            .replacingOccurrences(of: "\n", with: " ")
        let redacted = Self.redactLogSecrets(safeMessage)
        DispatchQueue.main.async {
            self.runtimeLogMessages.insert(redacted, at: 0)
            if self.runtimeLogMessages.count > 80 {
                self.runtimeLogMessages.removeLast(self.runtimeLogMessages.count - 80)
            }
            self.postAccessibilityAnnouncement(title: "", body: redacted)
        }
        let logURL = URL(fileURLWithPath: runtimeLogPath)
        do {
            try FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            if let size = try? FileManager.default.attributesOfItem(atPath: runtimeLogPath)[.size] as? UInt64,
               size > runtimeLogMaxBytes {
                let formatter = DateFormatter()
                formatter.dateFormat = "yyyyMMdd-HHmmss"
                let rotated = logURL.deletingLastPathComponent().appendingPathComponent("openlink-macos-\(formatter.string(from: Date())).log")
                try? FileManager.default.moveItem(at: logURL, to: rotated)
            }

            let line = "\(ISO8601DateFormatter().string(from: Date())) \(redacted.prefix(4000))\n"
            if let data = line.data(using: .utf8) {
                if FileManager.default.fileExists(atPath: runtimeLogPath),
                   let handle = try? FileHandle(forWritingTo: logURL) {
                    try? handle.seekToEnd()
                    handle.write(data)
                    try? handle.close()
                } else {
                    try data.write(to: logURL)
                }
            }
        } catch {
            // Runtime logging must never interrupt remote control.
        }
    }

    private static func redactLogSecrets(_ value: String) -> String {
        var output = value
        for key in ["token", "accessToken", "authorization", "password", "secret"] {
            output = output.replacingOccurrences(
                of: "(\"\(key)\"\\s*:\\s*\")[^\"]+(\")",
                with: "$1[redacted]$2",
                options: [.regularExpression, .caseInsensitive]
            )
        }
        return output
    }

    private func migratePairedServersToMachines() {
        for server in pairedServers {
            migrateServerToMachine(server)
        }
        saveMachines()
    }

    private func normalizeManagedMachineRouting() {
        let allowCustomServer = UserDefaults.standard.bool(forKey: "customSignalingServerAccessEnabled")
        guard !allowCustomServer else { return }

        var changed = false
        for index in machines.indices {
            if shouldUseCanonicalRouting(machines[index].domainUsed) {
                runtimeLog("normalized machine routing for \(machines[index].id) from \(machines[index].domainUsed) to \(Self.canonicalWebSocketURL)")
                machines[index].domainUsed = Self.canonicalShareHost
                machines[index].isOnline = false
                changed = true
            }
        }

        if changed {
            saveMachines()
        }
    }

    private func refreshLocalMachinePresence() {
        var changed = false
        for index in machines.indices where isLocalMachine(machines[index]) {
            let shouldBeOnline = isRunning
            if machines[index].isOnline != shouldBeOnline {
                machines[index].isOnline = shouldBeOnline
                changed = true
            }
            if machines[index].domainUsed != Self.canonicalShareHost {
                machines[index].domainUsed = Self.canonicalShareHost
                changed = true
            }
            if machines[index].platform.caseInsensitiveCompare("macOS") != .orderedSame {
                machines[index].platform = "macOS"
                changed = true
            }
        }
        if changed {
            saveMachines()
        }
    }

    private func shouldUseCanonicalRouting(_ value: String) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return true }
        if trimmed.hasPrefix("100.64.") || trimmed.hasPrefix("192.168.") || trimmed.hasPrefix("10.") || trimmed == "127.0.0.1" || trimmed == "localhost" {
            return true
        }
        if let host = URL(string: trimmed.contains("://") ? trimmed : "wss://\(trimmed)")?.host,
           host.hasPrefix("100.64.") || host.hasPrefix("192.168.") || host.hasPrefix("10.") || host == "127.0.0.1" || host == "localhost" {
            return true
        }
        return false
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
            domainUsed: Self.canonicalShareHost,
            platform: "Windows",
            isTrusted: true,
            allowDropIn: true,
            autoConnect: true
        ))
        addSeedMachine(OpenLinkMachine(
            id: "admin-s-mac-mini",
            displayName: "Admin's Mac mini",
            machineHostname: "admin-s-mac-mini",
            domainUsed: Self.canonicalShareHost,
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
                "diagnosticsEnabled": UserDefaults.standard.bool(forKey: "enableDiagnosticSending"),
                "brailleEnabled": UserDefaults.standard.bool(forKey: "enableBrailleDisplaySupport"),
                "brailleProvider": UserDefaults.standard.string(forKey: "brailleProvider") ?? "auto",
                "routeBrailleToRemoteWhenConnected": UserDefaults.standard.bool(forKey: "routeBrailleToRemoteWhenConnected"),
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
            "id": localStableMachineId(),
            "clientId": getClientId(),
            "displayName": localStableMachineName(),
            "hostname": localStableMachineId(),
            "aliases": Array(localMachineIdentityTokens()),
            "domainUsed": domainUsed,
            "platform": "macOS",
            "routeHints": defaultRouteHints(domainUsed: domainUsed),
            "transportPolicy": transportPolicy(),
            "audio": [
                "sampleRates": [44_100, 48_000],
                "sampleRate": 48_000,
                "codec": activeAudioCodec(),
                "requestedCodec": UserDefaults.standard.string(forKey: "audioStreamingCodec") ?? "pcm_s16le",
                "supportedCodecs": ["pcm_s16le", "pcm_s32le", "wav_pcm_s16le", "wav_pcm_s32le"],
                "directAudioBufferSamples": max(16, min(2048, UserDefaults.standard.integer(forKey: "directAudioBufferSamples") == 0 ? 512 : UserDefaults.standard.integer(forKey: "directAudioBufferSamples"))),
                "windowsAudioBufferSamples": max(16, min(2048, UserDefaults.standard.integer(forKey: "macAudioPlaybackBufferSamples") == 0 ? 512 : UserDefaults.standard.integer(forKey: "macAudioPlaybackBufferSamples")))
            ],
            "braille": [
                "enabled": UserDefaults.standard.bool(forKey: "enableBrailleDisplaySupport"),
                "provider": UserDefaults.standard.string(forKey: "brailleProvider") ?? "auto",
                "routeToRemoteWhenConnected": UserDefaults.standard.bool(forKey: "routeBrailleToRemoteWhenConnected")
            ]
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
            "audioTransport": "native-coreaudio",
            "audioCodec": activeAudioCodec(),
            "requestedAudioCodec": UserDefaults.standard.string(forKey: "audioStreamingCodec") ?? "pcm_s16le",
            "supportedAudioCodecs": ["pcm_s16le", "pcm_s32le", "wav_pcm_s16le", "wav_pcm_s32le"],
            "audioSampleRates": [44_100, 48_000],
            "directAudioBufferSamples": max(16, min(2048, UserDefaults.standard.integer(forKey: "directAudioBufferSamples") == 0 ? 512 : UserDefaults.standard.integer(forKey: "directAudioBufferSamples"))),
            "windowsAudioBufferSamples": max(16, min(2048, UserDefaults.standard.integer(forKey: "macAudioPlaybackBufferSamples") == 0 ? 512 : UserDefaults.standard.integer(forKey: "macAudioPlaybackBufferSamples"))),
            "diagnosticsEnabled": UserDefaults.standard.bool(forKey: "enableDiagnosticSending"),
            "brailleEnabled": UserDefaults.standard.bool(forKey: "enableBrailleDisplaySupport"),
            "brailleProvider": UserDefaults.standard.string(forKey: "brailleProvider") ?? "auto",
            "routeBrailleToRemoteWhenConnected": UserDefaults.standard.bool(forKey: "routeBrailleToRemoteWhenConnected"),
            "autoMuteControlledComputerAudio": UserDefaults.standard.bool(forKey: "autoMuteRemoteAudio"),
            "autoMuteProcessesOnConnect": autoMuteProcessList(),
            "managedMachineConfirmation": "desktop-built-in",
            "transportStrategy": "rendezvous-direct-then-relay",
            "userVisibleLinks": "https-only",
            "hideWebSocketUrls": true,
            "companionConfirmationSupported": true,
            "companionPlatform": "iOS"
        ]
    }

    private func activeAudioCodec() -> String {
        let requested = (UserDefaults.standard.string(forKey: "audioStreamingCodec") ?? "pcm_s16le")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        return ["pcm_s16le", "pcm_s32le", "wav_pcm_s16le", "wav_pcm_s32le"].contains(requested) ? requested : "pcm_s16le"
    }

    private func defaultRouteHints(domainUsed: String) -> [[String: Any]] {
        let publicURL = Self.publicServerURL(for: domainUsed)
        return [
            ["mode": "rendezvous", "priority": 10, "url": publicURL],
            ["mode": "relay", "priority": 20, "url": "\(publicURL)/relay"],
            ["mode": "cloudflare-edge", "priority": 30, "url": Self.cloudflareEdgeURL(for: publicURL), "role": "optional-rendezvous-fallback"],
            ["mode": "tailnet-direct", "priority": 90, "url": "hidden-direct-candidate"]
        ]
    }

    private func transportPolicy() -> [String: Any] {
        [
            "strategy": "rendezvous-direct-then-relay",
            "preferredDesktopTransport": "rfb-over-webrtc",
            "desktopTransports": ["rfb-over-webrtc", "openlink-native"],
            "vncExposure": "session-tunnel-only",
            "userVisibleLinks": "https-only",
            "hideWebSocketUrls": true,
            "fallbackOrder": ["public-signal", "relay", "cloudflare-edge", "tailnet-direct"],
            "inspiredBy": "rendezvous-plus-relay-edge"
        ]
    }

    private static func cloudflareEdgeURL(for publicURL: String) -> String {
        guard let host = URL(string: publicURL)?.host else {
            return "https://openlink-edge.tappedin.fm"
        }
        if host.caseInsensitiveCompare("openlink.raywonderis.me") == .orderedSame {
            return "https://openlink-edge.raywonderis.me"
        }
        return "https://openlink-edge.tappedin.fm"
    }

    func normalizeEndpoint(_ rawValue: String, allowCustomServer: Bool = false) -> String {
        var value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty {
            return Self.canonicalWebSocketURL
        }
        if !value.contains("://") {
            value = "wss://\(value)"
        }
        guard var components = URLComponents(string: value) else {
            return Self.canonicalWebSocketURL
        }
        if components.host?.lowercased().hasPrefix("dvc.") == true {
            return Self.canonicalWebSocketURL
        }
        if components.scheme == "http" {
            components.scheme = "ws"
        } else if components.scheme == "https" {
            components.scheme = "wss"
        }
        if components.path.isEmpty || components.path == "/" {
            components.path = "/ws"
        }
        let normalized = components.string ?? Self.canonicalWebSocketURL
        return allowCustomServer || Self.isApprovedDefaultWebSocketURL(normalized)
            ? normalized
            : Self.canonicalWebSocketURL
    }

    private func signalingEndpoint(for machine: OpenLinkMachine) -> String {
        let allowCustomServer = UserDefaults.standard.bool(forKey: "customSignalingServerAccessEnabled")
        if isOpenLinkBackendHost(machine.domainUsed, allowCustomServer: allowCustomServer) {
            return normalizeEndpoint(machine.domainUsed, allowCustomServer: allowCustomServer)
        }

        return normalizeEndpoint(UserDefaults.standard.string(forKey: "openLinkBackendUrl") ?? Self.canonicalWebSocketURL, allowCustomServer: allowCustomServer)
    }

    static func isApprovedDefaultWebSocketURL(_ value: String) -> Bool {
        let normalized = normalizedEndpointForComparison(value)
        return approvedWebSocketURLs.contains { $0.caseInsensitiveCompare(normalized) == .orderedSame }
    }

    static func publicServerURL(for value: String) -> String {
        let normalized = normalizedEndpointForComparison(value)
        guard var components = URLComponents(string: normalized) else {
            return canonicalPublicURL
        }
        components.scheme = components.scheme == "ws" ? "http" : "https"
        components.path = ""
        components.query = nil
        return components.string?.trimmingCharacters(in: CharacterSet(charactersIn: "/")) ?? canonicalPublicURL
    }

    private static func normalizedEndpointForComparison(_ value: String) -> String {
        var text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty {
            return canonicalWebSocketURL
        }
        if !text.contains("://") {
            text = "wss://\(text)"
        }
        guard var components = URLComponents(string: text) else {
            return canonicalWebSocketURL
        }
        if components.scheme == "http" {
            components.scheme = "ws"
        } else if components.scheme == "https" {
            components.scheme = "wss"
        }
        if components.path.isEmpty || components.path == "/" {
            components.path = "/ws"
        }
        return components.string ?? canonicalWebSocketURL
    }

    private func isOpenLinkBackendHost(_ value: String, allowCustomServer: Bool = false) -> Bool {
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
            return allowCustomServer
        }
        return allowCustomServer || Self.approvedWebSocketURLs.contains {
            URL(string: $0)?.host?.caseInsensitiveCompare(host) == .orderedSame
        }
    }

    private func getClientId() -> String {
        #if os(macOS)
        let stableId = localStableMachineId()
        if UserDefaults.standard.string(forKey: "openLinkClientId") != stableId {
            UserDefaults.standard.set(stableId, forKey: "openLinkClientId")
        }
        return stableId
        #else
        if let id = UserDefaults.standard.string(forKey: "openLinkClientId") {
            return id
        }
        let newId = UUID().uuidString
        UserDefaults.standard.set(newId, forKey: "openLinkClientId")
        return newId
        #endif
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
        postAccessibilityAnnouncement(title: title, body: body)

        guard Bundle.main.bundleIdentifier != nil,
              Bundle.main.bundleURL.pathExtension.caseInsensitiveCompare("app") == .orderedSame else {
            runtimeLog("skipped notification outside app bundle: \(title)")
            return
        }

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

    private func postAccessibilityAnnouncement(title: String, body: String, allowBrailleDuringRemoteSession: Bool = false) {
        guard UserDefaults.standard.object(forKey: "announceStatusChanges") as? Bool ?? true else { return }
        let announcement = title.isEmpty ? body : "\(title). \(body)"
        guard !announcement.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }

        DispatchQueue.main.async {
            let remoteOwnsBraille = UserDefaults.standard.bool(forKey: "routeBrailleToRemoteWhenConnected") &&
                (RemoteControlManager.shared.isRemoteControlActive || RemoteControlManager.shared.isReceivingControl)
            if allowBrailleDuringRemoteSession || !remoteOwnsBraille {
                BrlttyBridge.shared.send(announcement)
            }
            let element: Any
            if let mainWindow = NSApp.mainWindow {
                element = mainWindow
            } else {
                element = NSApplication.shared
            }
            NSAccessibility.post(
                element: element,
                notification: .announcementRequested,
                userInfo: [
                    .announcement: announcement,
                    .priority: NSAccessibilityPriorityLevel.high.rawValue
                ]
            )
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
