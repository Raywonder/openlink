import Foundation
import Network
import SwiftUI

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

// MARK: - OpenLink Service

class OpenLinkService: ObservableObject {
    static let shared = OpenLinkService()

    // State
    @Published var isRunning = false
    @Published var connectionMode: ConnectionMode = .auto
    @Published var localIP: String?
    @Published var port: Int = 3000
    @Published var connectedDevices: Int = 0
    @Published var pairedServers: [PairedServer] = []

    // Settings
    @Published var discoveryEnabled = true
    @Published var allowRemoteControl = true
    @Published var trustedDevicesOnly = false

    // Network
    private var listener: NWListener?
    private var connections: [String: NWConnection] = [:]
    private var webSocketTasks: [String: URLSessionWebSocketTask] = [:]
    private var discoveryTimer: Timer?

    // Paths
    private let configPath = NSHomeDirectory() + "/.openlink/config.json"
    private let serversPath = NSHomeDirectory() + "/.openlink/servers.json"

    init() {
        loadConfiguration()
        loadServers()
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

        // Connect to paired servers
        for server in pairedServers {
            connectToServer(server)
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

        isRunning = false
        connectedDevices = 0

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
            sendResponse(["success": true, "connected": true], to: connectionId)
        }
    }

    private func handleDisconnect(_ connectionId: String) {
        connections[connectionId]?.cancel()
        connections.removeValue(forKey: connectionId)
        connectedDevices = max(0, connectedDevices - 1)
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
        let wsURL = server.url
            .replacingOccurrences(of: "http://", with: "ws://")
            .replacingOccurrences(of: "https://", with: "wss://")

        guard let url = URL(string: "\(wsURL)/openlink/connect") else {
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
            "clientName": Host.current().localizedName ?? "Unknown"
        ]

        if let data = try? JSONSerialization.data(withJSONObject: handshake),
           let string = String(data: data, encoding: .utf8) {
            task.send(.string(string)) { _ in }
        }

        updateServerOnlineStatus(serverId: server.id, isOnline: true)
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
        default:
            break
        }
    }

    private func sendWebSocketResponse(_ response: [String: Any], serverId: String) {
        guard let task = webSocketTasks[serverId],
              let data = try? JSONSerialization.data(withJSONObject: response),
              let string = String(data: data, encoding: .utf8) else {
            return
        }

        task.send(.string(string)) { _ in }
    }

    func testConnection(_ server: PairedServer) {
        guard let url = URL(string: "\(server.url)/api/health") else { return }

        URLSession.shared.dataTask(with: url) { [weak self] _, response, _ in
            let isOnline = (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async {
                self?.updateServerOnlineStatus(serverId: server.id, isOnline: isOnline)
            }
        }.resume()
    }

    // MARK: - Server Management

    func pairWithCode(_ code: String) {
        // In production, this would call the server API
        // For now, simulate pairing
        guard code.count == 6 else { return }

        let newServer = PairedServer(
            name: "VoiceLink Server",
            url: "http://localhost:3000",
            accessToken: UUID().uuidString
        )

        addServer(newServer)
    }

    func addServerManually(url: String) {
        let newServer = PairedServer(
            name: "Manual Server",
            url: url,
            accessToken: UUID().uuidString
        )

        addServer(newServer)
    }

    private func addServer(_ server: PairedServer) {
        pairedServers.append(server)
        saveServers()

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
        saveServers()
    }

    private func updateServerOnlineStatus(serverId: String, isOnline: Bool) {
        if let index = pairedServers.firstIndex(where: { $0.id == serverId }) {
            pairedServers[index].isOnline = isOnline
            pairedServers[index].lastSeen = isOnline ? Date() : pairedServers[index].lastSeen
        }
    }

    // MARK: - Discovery

    private func startDiscovery() {
        discoveryTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            self?.discoverLocalDevices()
        }
        discoverLocalDevices()
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
        try? data.write(to: URL(fileURLWithPath: serversPath))
    }

    private func getClientId() -> String {
        if let id = UserDefaults.standard.string(forKey: "openLinkClientId") {
            return id
        }
        let newId = UUID().uuidString
        UserDefaults.standard.set(newId, forKey: "openLinkClientId")
        return newId
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
