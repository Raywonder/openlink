import Foundation
import AppKit
import CoreGraphics
import Carbon.HIToolbox

// MARK: - Remote Control Manager
// Handles cross-platform remote control (PC <-> Mac)

class RemoteControlManager: ObservableObject {
    static let shared = RemoteControlManager()

    // State
    @Published var isRemoteControlActive = false
    @Published var isReceivingControl = false
    @Published var isSendingControl = false
    @Published var connectedPeer: RemotePeer?
    @Published var clipboardSyncEnabled = true
    @Published var inputForwardingEnabled = true
    @Published var screenSharingEnabled = false
    @Published var fileSharingEnabled = true

    // Screen sharing
    @Published var isScreenSharing = false
    @Published var screenShareQuality: ScreenShareQuality = .medium
    @Published var screenShareFPS: Int = 15

    // Input state
    private var lastMousePosition: CGPoint = .zero
    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?

    // Clipboard monitoring
    private var clipboardTimer: Timer?
    private var lastClipboardContent: String = ""

    // File transfer
    @Published var pendingTransfers: [FileTransfer] = []
    @Published var activeTransfers: [FileTransfer] = []

    // WebSocket connection for remote control
    private var controlSocket: URLSessionWebSocketTask?
    private let session = URLSession.shared

    init() {
        loadSettings()
    }

    // MARK: - Remote Control Commands

    enum RemoteCommand: String, Codable, CaseIterable {
        // System commands
        case shutdown = "shutdown"
        case restart = "restart"
        case sleep = "sleep"
        case wake = "wake"
        case lock = "lock"
        case logout = "logout"

        // Input commands
        case mouseMove = "mouse_move"
        case mouseClick = "mouse_click"
        case mouseDoubleClick = "mouse_double_click"
        case mouseRightClick = "mouse_right_click"
        case mouseScroll = "mouse_scroll"
        case mouseDrag = "mouse_drag"
        case keyPress = "key_press"
        case keyRelease = "key_release"
        case keyType = "key_type"
        case keyCombo = "key_combo"

        // Clipboard commands
        case clipboardGet = "clipboard_get"
        case clipboardSet = "clipboard_set"
        case clipboardSync = "clipboard_sync"

        // Screen commands
        case screenCapture = "screen_capture"
        case screenStream = "screen_stream"
        case screenStreamStop = "screen_stream_stop"
        case getDisplays = "get_displays"
        case setDisplay = "set_display"

        // File commands
        case fileList = "file_list"
        case fileDownload = "file_download"
        case fileUpload = "file_upload"
        case fileDelete = "file_delete"
        case fileOpen = "file_open"

        // App commands
        case appList = "app_list"
        case appLaunch = "app_launch"
        case appClose = "app_close"
        case appFocus = "app_focus"

        // System info
        case systemInfo = "system_info"
        case processInfo = "process_info"
        case batteryInfo = "battery_info"
        case networkInfo = "network_info"

        // Volume control
        case volumeGet = "volume_get"
        case volumeSet = "volume_set"
        case volumeMute = "volume_mute"
        case volumeUnmute = "volume_unmute"

        var category: CommandCategory {
            switch self {
            case .shutdown, .restart, .sleep, .wake, .lock, .logout:
                return .system
            case .mouseMove, .mouseClick, .mouseDoubleClick, .mouseRightClick, .mouseScroll, .mouseDrag,
                 .keyPress, .keyRelease, .keyType, .keyCombo:
                return .input
            case .clipboardGet, .clipboardSet, .clipboardSync:
                return .clipboard
            case .screenCapture, .screenStream, .screenStreamStop, .getDisplays, .setDisplay:
                return .screen
            case .fileList, .fileDownload, .fileUpload, .fileDelete, .fileOpen:
                return .file
            case .appList, .appLaunch, .appClose, .appFocus:
                return .application
            case .systemInfo, .processInfo, .batteryInfo, .networkInfo:
                return .info
            case .volumeGet, .volumeSet, .volumeMute, .volumeUnmute:
                return .audio
            }
        }

        enum CommandCategory: String {
            case system = "System"
            case input = "Input"
            case clipboard = "Clipboard"
            case screen = "Screen"
            case file = "File"
            case application = "Application"
            case info = "Information"
            case audio = "Audio"
        }
    }

    // MARK: - Remote Peer Model

    struct RemotePeer: Codable, Identifiable {
        let id: String
        var name: String
        var platform: Platform
        var ip: String
        var port: Int
        var isOnline: Bool
        var lastSeen: Date?
        var capabilities: [String]

        enum Platform: String, Codable {
            case mac = "macOS"
            case windows = "Windows"
            case linux = "Linux"
            case unknown = "Unknown"
        }
    }

    // MARK: - Screen Share Quality

    enum ScreenShareQuality: String, CaseIterable {
        case low = "Low"
        case medium = "Medium"
        case high = "High"
        case lossless = "Lossless"

        var compressionQuality: CGFloat {
            switch self {
            case .low: return 0.3
            case .medium: return 0.5
            case .high: return 0.8
            case .lossless: return 1.0
            }
        }

        var scaleFactor: CGFloat {
            switch self {
            case .low: return 0.5
            case .medium: return 0.75
            case .high: return 1.0
            case .lossless: return 1.0
            }
        }
    }

    // MARK: - File Transfer Model

    struct FileTransfer: Identifiable, Codable {
        let id: String
        var fileName: String
        var filePath: String
        var fileSize: Int64
        var transferredBytes: Int64 = 0
        var direction: TransferDirection
        var status: TransferStatus
        var startTime: Date?
        var endTime: Date?

        var progress: Double {
            guard fileSize > 0 else { return 0 }
            return Double(transferredBytes) / Double(fileSize)
        }

        enum TransferDirection: String, Codable {
            case upload = "Upload"
            case download = "Download"
        }

        enum TransferStatus: String, Codable {
            case pending = "Pending"
            case inProgress = "In Progress"
            case completed = "Completed"
            case failed = "Failed"
            case cancelled = "Cancelled"
        }
    }

    // MARK: - Connect to Remote Peer

    func connectToPeer(_ peer: RemotePeer, completion: @escaping (Bool, String?) -> Void) {
        let wsURL = "ws://\(peer.ip):\(peer.port)/openlink/control"

        guard let url = URL(string: wsURL) else {
            completion(false, "Invalid peer URL")
            return
        }

        var request = URLRequest(url: url)
        request.setValue(getClientId(), forHTTPHeaderField: "X-Client-ID")
        request.setValue(Host.current().localizedName ?? "Unknown", forHTTPHeaderField: "X-Client-Name")
        request.setValue("macOS", forHTTPHeaderField: "X-Platform")

        controlSocket = session.webSocketTask(with: request)
        controlSocket?.resume()

        // Send handshake
        let handshake: [String: Any] = [
            "type": "handshake",
            "clientId": getClientId(),
            "clientName": Host.current().localizedName ?? "Unknown",
            "platform": "macOS",
            "capabilities": getCapabilities()
        ]

        sendMessage(handshake) { [weak self] success in
            if success {
                self?.connectedPeer = peer
                self?.isRemoteControlActive = true
                self?.startReceivingMessages()
                self?.startClipboardMonitoring()
                completion(true, nil)
            } else {
                completion(false, "Failed to establish connection")
            }
        }
    }

    func disconnect() {
        controlSocket?.cancel(with: .normalClosure, reason: nil)
        controlSocket = nil
        connectedPeer = nil
        isRemoteControlActive = false
        isReceivingControl = false
        isSendingControl = false
        stopClipboardMonitoring()
        stopInputCapture()
    }

    // MARK: - Execute Remote Command

    func executeCommand(_ command: RemoteCommand, parameters: [String: Any] = [:]) -> [String: Any] {
        switch command {
        // System commands
        case .shutdown:
            return executeSystemCommand("shutdown")
        case .restart:
            return executeSystemCommand("restart")
        case .sleep:
            return executeSystemCommand("sleep")
        case .wake:
            return ["success": true, "result": "Wake not applicable on this device"]
        case .lock:
            return executeSystemCommand("lock")
        case .logout:
            return executeSystemCommand("logout")

        // Input commands
        case .mouseMove:
            return executeMouseMove(parameters)
        case .mouseClick:
            return executeMouseClick(parameters, clickType: .left)
        case .mouseDoubleClick:
            return executeMouseClick(parameters, clickType: .double)
        case .mouseRightClick:
            return executeMouseClick(parameters, clickType: .right)
        case .mouseScroll:
            return executeMouseScroll(parameters)
        case .mouseDrag:
            return executeMouseDrag(parameters)
        case .keyPress:
            return executeKeyPress(parameters)
        case .keyRelease:
            return executeKeyRelease(parameters)
        case .keyType:
            return executeKeyType(parameters)
        case .keyCombo:
            return executeKeyCombo(parameters)

        // Clipboard commands
        case .clipboardGet:
            return getClipboardContent()
        case .clipboardSet:
            return setClipboardContent(parameters)
        case .clipboardSync:
            return syncClipboard(parameters)

        // Screen commands
        case .screenCapture:
            return captureScreen(parameters)
        case .screenStream:
            return startScreenStream(parameters)
        case .screenStreamStop:
            return stopScreenStream()
        case .getDisplays:
            return getDisplays()
        case .setDisplay:
            return ["success": true, "result": "Display set"]

        // File commands
        case .fileList:
            return listFiles(parameters)
        case .fileDownload:
            return initiateFileDownload(parameters)
        case .fileUpload:
            return initiateFileUpload(parameters)
        case .fileDelete:
            return deleteFile(parameters)
        case .fileOpen:
            return openFile(parameters)

        // App commands
        case .appList:
            return getRunningApps()
        case .appLaunch:
            return launchApp(parameters)
        case .appClose:
            return closeApp(parameters)
        case .appFocus:
            return focusApp(parameters)

        // System info
        case .systemInfo:
            return getSystemInfo()
        case .processInfo:
            return getProcessInfo()
        case .batteryInfo:
            return getBatteryInfo()
        case .networkInfo:
            return getNetworkInfo()

        // Volume
        case .volumeGet:
            return getVolume()
        case .volumeSet:
            return setVolume(parameters)
        case .volumeMute:
            return muteVolume(true)
        case .volumeUnmute:
            return muteVolume(false)
        }
    }

    // MARK: - System Commands

    private func executeSystemCommand(_ command: String) -> [String: Any] {
        let script: String
        switch command {
        case "shutdown":
            script = "tell application \"System Events\" to shut down"
        case "restart":
            script = "tell application \"System Events\" to restart"
        case "sleep":
            script = "tell application \"System Events\" to sleep"
        case "lock":
            script = "tell application \"System Events\" to keystroke \"q\" using {control down, command down}"
        case "logout":
            script = "tell application \"System Events\" to log out"
        default:
            return ["success": false, "error": "Unknown system command"]
        }

        return runAppleScript(script)
    }

    private func runAppleScript(_ script: String) -> [String: Any] {
        var error: NSDictionary?
        if let scriptObject = NSAppleScript(source: script) {
            scriptObject.executeAndReturnError(&error)
            if let error = error {
                return ["success": false, "error": error.description]
            }
            return ["success": true, "result": "Command executed"]
        }
        return ["success": false, "error": "Failed to create script"]
    }

    // MARK: - Mouse Commands

    private func executeMouseMove(_ params: [String: Any]) -> [String: Any] {
        guard let x = params["x"] as? CGFloat,
              let y = params["y"] as? CGFloat else {
            return ["success": false, "error": "Invalid coordinates"]
        }

        let point = CGPoint(x: x, y: y)
        CGWarpMouseCursorPosition(point)
        lastMousePosition = point

        return ["success": true, "result": "Mouse moved to (\(x), \(y))"]
    }

    enum ClickType { case left, right, double }

    private func executeMouseClick(_ params: [String: Any], clickType: ClickType) -> [String: Any] {
        let x = params["x"] as? CGFloat ?? lastMousePosition.x
        let y = params["y"] as? CGFloat ?? lastMousePosition.y
        let point = CGPoint(x: x, y: y)

        let mouseDown: CGEventType
        let mouseUp: CGEventType
        let button: CGMouseButton

        switch clickType {
        case .left, .double:
            mouseDown = .leftMouseDown
            mouseUp = .leftMouseUp
            button = .left
        case .right:
            mouseDown = .rightMouseDown
            mouseUp = .rightMouseUp
            button = .right
        }

        let clickCount = clickType == .double ? 2 : 1

        for _ in 0..<clickCount {
            if let downEvent = CGEvent(mouseEventSource: nil, mouseType: mouseDown, mouseCursorPosition: point, mouseButton: button) {
                downEvent.post(tap: .cghidEventTap)
            }
            if let upEvent = CGEvent(mouseEventSource: nil, mouseType: mouseUp, mouseCursorPosition: point, mouseButton: button) {
                upEvent.post(tap: .cghidEventTap)
            }
        }

        return ["success": true, "result": "Mouse \(clickType) click at (\(x), \(y))"]
    }

    private func executeMouseScroll(_ params: [String: Any]) -> [String: Any] {
        let deltaX = params["deltaX"] as? Int32 ?? 0
        let deltaY = params["deltaY"] as? Int32 ?? 0

        if let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: deltaY, wheel2: deltaX, wheel3: 0) {
            event.post(tap: .cghidEventTap)
        }

        return ["success": true, "result": "Scrolled (\(deltaX), \(deltaY))"]
    }

    private func executeMouseDrag(_ params: [String: Any]) -> [String: Any] {
        guard let startX = params["startX"] as? CGFloat,
              let startY = params["startY"] as? CGFloat,
              let endX = params["endX"] as? CGFloat,
              let endY = params["endY"] as? CGFloat else {
            return ["success": false, "error": "Invalid drag coordinates"]
        }

        let startPoint = CGPoint(x: startX, y: startY)
        let endPoint = CGPoint(x: endX, y: endY)

        // Mouse down at start
        if let downEvent = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: startPoint, mouseButton: .left) {
            downEvent.post(tap: .cghidEventTap)
        }

        // Drag to end
        if let dragEvent = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: endPoint, mouseButton: .left) {
            dragEvent.post(tap: .cghidEventTap)
        }

        // Mouse up at end
        if let upEvent = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: endPoint, mouseButton: .left) {
            upEvent.post(tap: .cghidEventTap)
        }

        return ["success": true, "result": "Dragged from (\(startX), \(startY)) to (\(endX), \(endY))"]
    }

    // MARK: - Keyboard Commands

    private func executeKeyPress(_ params: [String: Any]) -> [String: Any] {
        guard let keyCode = params["keyCode"] as? CGKeyCode else {
            return ["success": false, "error": "Invalid key code"]
        }

        if let event = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true) {
            event.post(tap: .cghidEventTap)
        }

        return ["success": true, "result": "Key \(keyCode) pressed"]
    }

    private func executeKeyRelease(_ params: [String: Any]) -> [String: Any] {
        guard let keyCode = params["keyCode"] as? CGKeyCode else {
            return ["success": false, "error": "Invalid key code"]
        }

        if let event = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false) {
            event.post(tap: .cghidEventTap)
        }

        return ["success": true, "result": "Key \(keyCode) released"]
    }

    private func executeKeyType(_ params: [String: Any]) -> [String: Any] {
        guard let text = params["text"] as? String else {
            return ["success": false, "error": "No text provided"]
        }

        for char in text {
            if let keyCode = keyCodeForCharacter(char) {
                // Key down
                if let downEvent = CGEvent(keyboardEventSource: nil, virtualKey: keyCode.code, keyDown: true) {
                    if keyCode.shift {
                        downEvent.flags = .maskShift
                    }
                    downEvent.post(tap: .cghidEventTap)
                }
                // Key up
                if let upEvent = CGEvent(keyboardEventSource: nil, virtualKey: keyCode.code, keyDown: false) {
                    upEvent.post(tap: .cghidEventTap)
                }
            }
        }

        return ["success": true, "result": "Typed \(text.count) characters"]
    }

    private func executeKeyCombo(_ params: [String: Any]) -> [String: Any] {
        guard let keys = params["keys"] as? [String] else {
            return ["success": false, "error": "No keys provided"]
        }

        var flags: CGEventFlags = []
        var mainKey: CGKeyCode = 0

        for key in keys {
            switch key.lowercased() {
            case "cmd", "command": flags.insert(.maskCommand)
            case "ctrl", "control": flags.insert(.maskControl)
            case "alt", "option": flags.insert(.maskAlternate)
            case "shift": flags.insert(.maskShift)
            default:
                if let code = keyCodeForName(key) {
                    mainKey = code
                }
            }
        }

        // Execute key combo
        if let downEvent = CGEvent(keyboardEventSource: nil, virtualKey: mainKey, keyDown: true) {
            downEvent.flags = flags
            downEvent.post(tap: .cghidEventTap)
        }
        if let upEvent = CGEvent(keyboardEventSource: nil, virtualKey: mainKey, keyDown: false) {
            upEvent.post(tap: .cghidEventTap)
        }

        return ["success": true, "result": "Key combo executed: \(keys.joined(separator: "+"))"]
    }

    // MARK: - Clipboard Commands

    private func getClipboardContent() -> [String: Any] {
        let pasteboard = NSPasteboard.general

        if let string = pasteboard.string(forType: .string) {
            return ["success": true, "result": string, "type": "text"]
        }

        if let image = pasteboard.data(forType: .tiff) {
            let base64 = image.base64EncodedString()
            return ["success": true, "result": base64, "type": "image"]
        }

        return ["success": true, "result": "", "type": "empty"]
    }

    private func setClipboardContent(_ params: [String: Any]) -> [String: Any] {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()

        if let text = params["text"] as? String {
            pasteboard.setString(text, forType: .string)
            return ["success": true, "result": "Clipboard set with text"]
        }

        if let imageBase64 = params["image"] as? String,
           let imageData = Data(base64Encoded: imageBase64) {
            pasteboard.setData(imageData, forType: .tiff)
            return ["success": true, "result": "Clipboard set with image"]
        }

        return ["success": false, "error": "No content provided"]
    }

    private func syncClipboard(_ params: [String: Any]) -> [String: Any] {
        // Sync clipboard with remote peer
        if let content = params["content"] as? String {
            let pasteboard = NSPasteboard.general
            pasteboard.clearContents()
            pasteboard.setString(content, forType: .string)
            return ["success": true, "result": "Clipboard synced"]
        }
        return ["success": false, "error": "No content to sync"]
    }

    private func startClipboardMonitoring() {
        guard clipboardSyncEnabled else { return }

        clipboardTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            self?.checkClipboardChanges()
        }
    }

    private func stopClipboardMonitoring() {
        clipboardTimer?.invalidate()
        clipboardTimer = nil
    }

    private func checkClipboardChanges() {
        guard let content = NSPasteboard.general.string(forType: .string),
              content != lastClipboardContent else { return }

        lastClipboardContent = content

        // Send to remote peer
        let message: [String: Any] = [
            "type": "clipboard_update",
            "content": content
        ]
        sendMessage(message) { _ in }
    }

    // MARK: - Screen Commands

    private func captureScreen(_ params: [String: Any]) -> [String: Any] {
        let displayID = params["displayId"] as? CGDirectDisplayID ?? CGMainDisplayID()

        guard let image = CGDisplayCreateImage(displayID) else {
            return ["success": false, "error": "Failed to capture screen"]
        }

        let bitmapRep = NSBitmapImageRep(cgImage: image)
        guard let jpegData = bitmapRep.representation(using: .jpeg, properties: [.compressionFactor: screenShareQuality.compressionQuality]) else {
            return ["success": false, "error": "Failed to compress image"]
        }

        let base64 = jpegData.base64EncodedString()
        return [
            "success": true,
            "result": base64,
            "width": image.width,
            "height": image.height
        ]
    }

    private func startScreenStream(_ params: [String: Any]) -> [String: Any] {
        isScreenSharing = true
        screenShareFPS = params["fps"] as? Int ?? 15

        if let qualityString = params["quality"] as? String,
           let quality = ScreenShareQuality(rawValue: qualityString) {
            screenShareQuality = quality
        }

        // Start streaming in background
        DispatchQueue.global(qos: .userInteractive).async { [weak self] in
            self?.screenStreamLoop()
        }

        return ["success": true, "result": "Screen streaming started"]
    }

    private func screenStreamLoop() {
        while isScreenSharing {
            let frameInterval = 1.0 / Double(screenShareFPS)

            let capture = captureScreen([:])
            if let imageData = capture["result"] as? String {
                let message: [String: Any] = [
                    "type": "screen_frame",
                    "data": imageData,
                    "timestamp": Date().timeIntervalSince1970
                ]
                sendMessage(message) { _ in }
            }

            Thread.sleep(forTimeInterval: frameInterval)
        }
    }

    private func stopScreenStream() -> [String: Any] {
        isScreenSharing = false
        return ["success": true, "result": "Screen streaming stopped"]
    }

    private func getDisplays() -> [String: Any] {
        var displayCount: UInt32 = 0
        CGGetActiveDisplayList(0, nil, &displayCount)

        var displays = [CGDirectDisplayID](repeating: 0, count: Int(displayCount))
        CGGetActiveDisplayList(displayCount, &displays, &displayCount)

        let displayInfo = displays.map { displayID -> [String: Any] in
            let bounds = CGDisplayBounds(displayID)
            return [
                "id": displayID,
                "width": bounds.width,
                "height": bounds.height,
                "x": bounds.origin.x,
                "y": bounds.origin.y,
                "isMain": displayID == CGMainDisplayID()
            ]
        }

        return ["success": true, "result": displayInfo]
    }

    // MARK: - File Commands

    private func listFiles(_ params: [String: Any]) -> [String: Any] {
        let path = params["path"] as? String ?? NSHomeDirectory()

        do {
            let contents = try FileManager.default.contentsOfDirectory(atPath: path)
            let files = contents.compactMap { name -> [String: Any]? in
                let fullPath = (path as NSString).appendingPathComponent(name)
                guard let attrs = try? FileManager.default.attributesOfItem(atPath: fullPath) else { return nil }

                return [
                    "name": name,
                    "path": fullPath,
                    "size": attrs[.size] as? Int64 ?? 0,
                    "isDirectory": (attrs[.type] as? FileAttributeType) == .typeDirectory,
                    "modified": (attrs[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
                ]
            }
            return ["success": true, "result": files, "path": path]
        } catch {
            return ["success": false, "error": error.localizedDescription]
        }
    }

    private func initiateFileDownload(_ params: [String: Any]) -> [String: Any] {
        guard let path = params["path"] as? String else {
            return ["success": false, "error": "No path specified"]
        }

        guard FileManager.default.fileExists(atPath: path) else {
            return ["success": false, "error": "File not found"]
        }

        guard let attrs = try? FileManager.default.attributesOfItem(atPath: path) else {
            return ["success": false, "error": "Cannot read file attributes"]
        }

        let transfer = FileTransfer(
            id: UUID().uuidString,
            fileName: (path as NSString).lastPathComponent,
            filePath: path,
            fileSize: attrs[.size] as? Int64 ?? 0,
            direction: .download,
            status: .pending
        )

        pendingTransfers.append(transfer)

        return ["success": true, "result": transfer.id, "fileSize": transfer.fileSize]
    }

    private func initiateFileUpload(_ params: [String: Any]) -> [String: Any] {
        guard let fileName = params["fileName"] as? String,
              let fileSize = params["fileSize"] as? Int64 else {
            return ["success": false, "error": "Missing file info"]
        }

        let downloadsPath = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first!
        let destinationPath = downloadsPath.appendingPathComponent(fileName).path

        let transfer = FileTransfer(
            id: UUID().uuidString,
            fileName: fileName,
            filePath: destinationPath,
            fileSize: fileSize,
            direction: .upload,
            status: .pending
        )

        pendingTransfers.append(transfer)

        return ["success": true, "result": transfer.id, "destinationPath": destinationPath]
    }

    private func deleteFile(_ params: [String: Any]) -> [String: Any] {
        guard let path = params["path"] as? String else {
            return ["success": false, "error": "No path specified"]
        }

        do {
            try FileManager.default.removeItem(atPath: path)
            return ["success": true, "result": "File deleted"]
        } catch {
            return ["success": false, "error": error.localizedDescription]
        }
    }

    private func openFile(_ params: [String: Any]) -> [String: Any] {
        guard let path = params["path"] as? String else {
            return ["success": false, "error": "No path specified"]
        }

        let url = URL(fileURLWithPath: path)
        NSWorkspace.shared.open(url)

        return ["success": true, "result": "File opened"]
    }

    // MARK: - App Commands

    private func getRunningApps() -> [String: Any] {
        let apps = NSWorkspace.shared.runningApplications.compactMap { app -> [String: Any]? in
            guard let name = app.localizedName else { return nil }
            return [
                "name": name,
                "bundleId": app.bundleIdentifier ?? "",
                "pid": app.processIdentifier,
                "isActive": app.isActive,
                "isHidden": app.isHidden
            ]
        }
        return ["success": true, "result": apps]
    }

    private func launchApp(_ params: [String: Any]) -> [String: Any] {
        if let bundleId = params["bundleId"] as? String {
            let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId)
            if let url = url {
                NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
                return ["success": true, "result": "App launched"]
            }
        }

        if let path = params["path"] as? String {
            let url = URL(fileURLWithPath: path)
            NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
            return ["success": true, "result": "App launched"]
        }

        return ["success": false, "error": "No app identifier provided"]
    }

    private func closeApp(_ params: [String: Any]) -> [String: Any] {
        if let pid = params["pid"] as? Int32 {
            if let app = NSRunningApplication(processIdentifier: pid) {
                app.terminate()
                return ["success": true, "result": "App terminated"]
            }
        }

        if let bundleId = params["bundleId"] as? String {
            let apps = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId)
            for app in apps {
                app.terminate()
            }
            return ["success": true, "result": "App(s) terminated"]
        }

        return ["success": false, "error": "App not found"]
    }

    private func focusApp(_ params: [String: Any]) -> [String: Any] {
        if let pid = params["pid"] as? Int32 {
            if let app = NSRunningApplication(processIdentifier: pid) {
                app.activate(options: .activateIgnoringOtherApps)
                return ["success": true, "result": "App focused"]
            }
        }

        if let bundleId = params["bundleId"] as? String {
            if let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first {
                app.activate(options: .activateIgnoringOtherApps)
                return ["success": true, "result": "App focused"]
            }
        }

        return ["success": false, "error": "App not found"]
    }

    // MARK: - System Info Commands

    private func getSystemInfo() -> [String: Any] {
        let processInfo = ProcessInfo.processInfo

        return [
            "success": true,
            "result": [
                "hostname": Host.current().localizedName ?? "Unknown",
                "osVersion": processInfo.operatingSystemVersionString,
                "platform": "macOS",
                "processorCount": processInfo.processorCount,
                "activeProcessorCount": processInfo.activeProcessorCount,
                "physicalMemory": processInfo.physicalMemory,
                "systemUptime": processInfo.systemUptime
            ]
        ]
    }

    private func getProcessInfo() -> [String: Any] {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/ps")
        task.arguments = ["aux"]

        let pipe = Pipe()
        task.standardOutput = pipe

        do {
            try task.run()
            task.waitUntilExit()

            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let output = String(data: data, encoding: .utf8) ?? ""

            return ["success": true, "result": output]
        } catch {
            return ["success": false, "error": error.localizedDescription]
        }
    }

    private func getBatteryInfo() -> [String: Any] {
        // Get battery info via IOKit (simplified)
        let script = """
        tell application "System Events"
            set batteryInfo to do shell script "pmset -g batt"
            return batteryInfo
        end tell
        """

        var error: NSDictionary?
        if let scriptObject = NSAppleScript(source: script) {
            let result = scriptObject.executeAndReturnError(&error)
            if let output = result.stringValue {
                return ["success": true, "result": output]
            }
        }

        return ["success": true, "result": "Battery info unavailable"]
    }

    private func getNetworkInfo() -> [String: Any] {
        var addresses: [String: String] = [:]

        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let firstAddr = ifaddr else {
            return ["success": false, "error": "Failed to get network info"]
        }

        for ptr in sequence(first: firstAddr, next: { $0.pointee.ifa_next }) {
            let interface = ptr.pointee
            let addrFamily = interface.ifa_addr.pointee.sa_family

            if addrFamily == UInt8(AF_INET) || addrFamily == UInt8(AF_INET6) {
                let name = String(cString: interface.ifa_name)
                var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                getnameinfo(interface.ifa_addr, socklen_t(interface.ifa_addr.pointee.sa_len),
                           &hostname, socklen_t(hostname.count), nil, 0, NI_NUMERICHOST)
                addresses[name] = String(cString: hostname)
            }
        }
        freeifaddrs(ifaddr)

        return ["success": true, "result": addresses]
    }

    // MARK: - Volume Commands

    private func getVolume() -> [String: Any] {
        let script = "output volume of (get volume settings)"
        var error: NSDictionary?
        if let scriptObject = NSAppleScript(source: "tell application \"System Events\" to return \(script)") {
            let result = scriptObject.executeAndReturnError(&error)
            if let volume = result.int32Value as Int32? {
                return ["success": true, "result": volume]
            }
        }
        return ["success": false, "error": "Failed to get volume"]
    }

    private func setVolume(_ params: [String: Any]) -> [String: Any] {
        guard let volume = params["volume"] as? Int else {
            return ["success": false, "error": "No volume specified"]
        }

        let clampedVolume = max(0, min(100, volume))
        let script = "set volume output volume \(clampedVolume)"

        var error: NSDictionary?
        if let scriptObject = NSAppleScript(source: script) {
            scriptObject.executeAndReturnError(&error)
            if error == nil {
                return ["success": true, "result": "Volume set to \(clampedVolume)"]
            }
        }
        return ["success": false, "error": "Failed to set volume"]
    }

    private func muteVolume(_ mute: Bool) -> [String: Any] {
        let script = "set volume output muted \(mute)"
        var error: NSDictionary?
        if let scriptObject = NSAppleScript(source: script) {
            scriptObject.executeAndReturnError(&error)
            if error == nil {
                return ["success": true, "result": mute ? "Muted" : "Unmuted"]
            }
        }
        return ["success": false, "error": "Failed to \(mute ? "mute" : "unmute")"]
    }

    // MARK: - Input Capture (for sending to remote)

    func startInputCapture() {
        guard inputForwardingEnabled else { return }

        let eventMask: CGEventMask =
            (1 << CGEventType.mouseMoved.rawValue) |
            (1 << CGEventType.leftMouseDown.rawValue) |
            (1 << CGEventType.leftMouseUp.rawValue) |
            (1 << CGEventType.rightMouseDown.rawValue) |
            (1 << CGEventType.rightMouseUp.rawValue) |
            (1 << CGEventType.keyDown.rawValue) |
            (1 << CGEventType.keyUp.rawValue) |
            (1 << CGEventType.scrollWheel.rawValue)

        eventTap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: eventMask,
            callback: { _, type, event, refcon in
                let manager = Unmanaged<RemoteControlManager>.fromOpaque(refcon!).takeUnretainedValue()
                manager.handleCapturedEvent(type: type, event: event)
                return Unmanaged.passRetained(event)
            },
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        )

        if let eventTap = eventTap {
            runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, eventTap, 0)
            CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
            CGEvent.tapEnable(tap: eventTap, enable: true)
            isSendingControl = true
        }
    }

    func stopInputCapture() {
        if let eventTap = eventTap {
            CGEvent.tapEnable(tap: eventTap, enable: false)
        }
        if let runLoopSource = runLoopSource {
            CFRunLoopRemoveSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
        }
        eventTap = nil
        runLoopSource = nil
        isSendingControl = false
    }

    private func handleCapturedEvent(type: CGEventType, event: CGEvent) {
        guard isSendingControl else { return }

        var message: [String: Any] = [
            "type": "input_event",
            "eventType": type.rawValue,
            "timestamp": Date().timeIntervalSince1970
        ]

        switch type {
        case .mouseMoved, .leftMouseDragged, .rightMouseDragged:
            let location = event.location
            message["x"] = location.x
            message["y"] = location.y

        case .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp:
            let location = event.location
            message["x"] = location.x
            message["y"] = location.y

        case .keyDown, .keyUp:
            message["keyCode"] = event.getIntegerValueField(.keyboardEventKeycode)
            message["flags"] = event.flags.rawValue

        case .scrollWheel:
            message["deltaY"] = event.getIntegerValueField(.scrollWheelEventDeltaAxis1)
            message["deltaX"] = event.getIntegerValueField(.scrollWheelEventDeltaAxis2)

        default:
            return
        }

        sendMessage(message) { _ in }
    }

    // MARK: - Message Handling

    private func sendMessage(_ message: [String: Any], completion: @escaping (Bool) -> Void) {
        guard let socket = controlSocket,
              let data = try? JSONSerialization.data(withJSONObject: message),
              let string = String(data: data, encoding: .utf8) else {
            completion(false)
            return
        }

        socket.send(.string(string)) { error in
            completion(error == nil)
        }
    }

    private func startReceivingMessages() {
        controlSocket?.receive { [weak self] result in
            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    if let data = text.data(using: .utf8) {
                        self?.handleReceivedMessage(data)
                    }
                case .data(let data):
                    self?.handleReceivedMessage(data)
                @unknown default:
                    break
                }
                self?.startReceivingMessages()

            case .failure:
                self?.disconnect()
            }
        }
    }

    private func handleReceivedMessage(_ data: Data) {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else { return }

        switch type {
        case "command":
            handleRemoteCommand(json)
        case "input_event":
            handleInputEvent(json)
        case "clipboard_update":
            handleClipboardUpdate(json)
        case "file_chunk":
            handleFileChunk(json)
        default:
            break
        }
    }

    private func handleRemoteCommand(_ json: [String: Any]) {
        guard let commandString = json["command"] as? String,
              let command = RemoteCommand(rawValue: commandString) else { return }

        let params = json["parameters"] as? [String: Any] ?? [:]
        let result = executeCommand(command, parameters: params)

        // Send response
        var response = result
        response["commandId"] = json["commandId"]
        response["type"] = "command_response"
        sendMessage(response) { _ in }
    }

    private func handleInputEvent(_ json: [String: Any]) {
        guard isReceivingControl else { return }

        guard let eventTypeRaw = json["eventType"] as? UInt32,
              let eventType = CGEventType(rawValue: eventTypeRaw) else { return }

        switch eventType {
        case .mouseMoved:
            if let x = json["x"] as? CGFloat, let y = json["y"] as? CGFloat {
                _ = executeMouseMove(["x": x, "y": y])
            }

        case .leftMouseDown:
            if let x = json["x"] as? CGFloat, let y = json["y"] as? CGFloat {
                let point = CGPoint(x: x, y: y)
                if let event = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left) {
                    event.post(tap: .cghidEventTap)
                }
            }

        case .leftMouseUp:
            if let x = json["x"] as? CGFloat, let y = json["y"] as? CGFloat {
                let point = CGPoint(x: x, y: y)
                if let event = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) {
                    event.post(tap: .cghidEventTap)
                }
            }

        case .rightMouseDown:
            if let x = json["x"] as? CGFloat, let y = json["y"] as? CGFloat {
                let point = CGPoint(x: x, y: y)
                if let event = CGEvent(mouseEventSource: nil, mouseType: .rightMouseDown, mouseCursorPosition: point, mouseButton: .right) {
                    event.post(tap: .cghidEventTap)
                }
            }

        case .rightMouseUp:
            if let x = json["x"] as? CGFloat, let y = json["y"] as? CGFloat {
                let point = CGPoint(x: x, y: y)
                if let event = CGEvent(mouseEventSource: nil, mouseType: .rightMouseUp, mouseCursorPosition: point, mouseButton: .right) {
                    event.post(tap: .cghidEventTap)
                }
            }

        case .keyDown:
            if let keyCode = json["keyCode"] as? Int64 {
                if let event = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(keyCode), keyDown: true) {
                    if let flags = json["flags"] as? UInt64 {
                        event.flags = CGEventFlags(rawValue: flags)
                    }
                    event.post(tap: .cghidEventTap)
                }
            }

        case .keyUp:
            if let keyCode = json["keyCode"] as? Int64 {
                if let event = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(keyCode), keyDown: false) {
                    event.post(tap: .cghidEventTap)
                }
            }

        case .scrollWheel:
            if let deltaY = json["deltaY"] as? Int64, let deltaX = json["deltaX"] as? Int64 {
                if let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(deltaY), wheel2: Int32(deltaX), wheel3: 0) {
                    event.post(tap: .cghidEventTap)
                }
            }

        default:
            break
        }
    }

    private func handleClipboardUpdate(_ json: [String: Any]) {
        guard clipboardSyncEnabled else { return }

        if let content = json["content"] as? String {
            let pasteboard = NSPasteboard.general
            pasteboard.clearContents()
            pasteboard.setString(content, forType: .string)
            lastClipboardContent = content
        }
    }

    private func handleFileChunk(_ json: [String: Any]) {
        // Handle file transfer chunks
        guard let transferId = json["transferId"] as? String,
              let chunk = json["data"] as? String,
              let data = Data(base64Encoded: chunk) else { return }

        // Find and update transfer
        if let index = activeTransfers.firstIndex(where: { $0.id == transferId }) {
            var transfer = activeTransfers[index]
            transfer.transferredBytes += Int64(data.count)

            // Append data to file
            let fileURL = URL(fileURLWithPath: transfer.filePath)
            if let handle = try? FileHandle(forWritingTo: fileURL) {
                handle.seekToEndOfFile()
                handle.write(data)
                handle.closeFile()
            }

            // Check if complete
            if transfer.transferredBytes >= transfer.fileSize {
                transfer.status = .completed
                transfer.endTime = Date()
            }

            activeTransfers[index] = transfer
        }
    }

    // MARK: - Helper Methods

    private func getClientId() -> String {
        if let id = UserDefaults.standard.string(forKey: "openLinkClientId") {
            return id
        }
        let newId = UUID().uuidString
        UserDefaults.standard.set(newId, forKey: "openLinkClientId")
        return newId
    }

    private func getCapabilities() -> [String] {
        var capabilities = ["system_commands", "clipboard", "info"]

        if inputForwardingEnabled {
            capabilities.append("input_forwarding")
        }
        if screenSharingEnabled {
            capabilities.append("screen_sharing")
        }
        if fileSharingEnabled {
            capabilities.append("file_transfer")
        }

        return capabilities
    }

    private func loadSettings() {
        clipboardSyncEnabled = UserDefaults.standard.bool(forKey: "clipboardSyncEnabled")
        inputForwardingEnabled = UserDefaults.standard.bool(forKey: "inputForwardingEnabled")
        screenSharingEnabled = UserDefaults.standard.bool(forKey: "screenSharingEnabled")
        fileSharingEnabled = UserDefaults.standard.bool(forKey: "fileSharingEnabled")

        // Set defaults if not set
        if !UserDefaults.standard.bool(forKey: "settingsInitialized") {
            clipboardSyncEnabled = true
            inputForwardingEnabled = true
            screenSharingEnabled = false
            fileSharingEnabled = true
            UserDefaults.standard.set(true, forKey: "settingsInitialized")
            saveSettings()
        }
    }

    func saveSettings() {
        UserDefaults.standard.set(clipboardSyncEnabled, forKey: "clipboardSyncEnabled")
        UserDefaults.standard.set(inputForwardingEnabled, forKey: "inputForwardingEnabled")
        UserDefaults.standard.set(screenSharingEnabled, forKey: "screenSharingEnabled")
        UserDefaults.standard.set(fileSharingEnabled, forKey: "fileSharingEnabled")
    }

    // MARK: - Key Code Helpers

    private func keyCodeForCharacter(_ char: Character) -> (code: CGKeyCode, shift: Bool)? {
        let charMap: [Character: (CGKeyCode, Bool)] = [
            "a": (0, false), "b": (11, false), "c": (8, false), "d": (2, false),
            "e": (14, false), "f": (3, false), "g": (5, false), "h": (4, false),
            "i": (34, false), "j": (38, false), "k": (40, false), "l": (37, false),
            "m": (46, false), "n": (45, false), "o": (31, false), "p": (35, false),
            "q": (12, false), "r": (15, false), "s": (1, false), "t": (17, false),
            "u": (32, false), "v": (9, false), "w": (13, false), "x": (7, false),
            "y": (16, false), "z": (6, false),
            "A": (0, true), "B": (11, true), "C": (8, true), "D": (2, true),
            "E": (14, true), "F": (3, true), "G": (5, true), "H": (4, true),
            "I": (34, true), "J": (38, true), "K": (40, true), "L": (37, true),
            "M": (46, true), "N": (45, true), "O": (31, true), "P": (35, true),
            "Q": (12, true), "R": (15, true), "S": (1, true), "T": (17, true),
            "U": (32, true), "V": (9, true), "W": (13, true), "X": (7, true),
            "Y": (16, true), "Z": (6, true),
            "0": (29, false), "1": (18, false), "2": (19, false), "3": (20, false),
            "4": (21, false), "5": (23, false), "6": (22, false), "7": (26, false),
            "8": (28, false), "9": (25, false),
            " ": (49, false), "\n": (36, false), "\t": (48, false)
        ]
        return charMap[char]
    }

    private func keyCodeForName(_ name: String) -> CGKeyCode? {
        let nameMap: [String: CGKeyCode] = [
            "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4,
            "i": 34, "j": 38, "k": 40, "l": 37, "m": 46, "n": 45, "o": 31, "p": 35,
            "q": 12, "r": 15, "s": 1, "t": 17, "u": 32, "v": 9, "w": 13, "x": 7,
            "y": 16, "z": 6,
            "space": 49, "enter": 36, "return": 36, "tab": 48, "escape": 53, "esc": 53,
            "delete": 51, "backspace": 51, "forwarddelete": 117,
            "up": 126, "down": 125, "left": 123, "right": 124,
            "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
            "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
            "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111
        ]
        return nameMap[name.lowercased()]
    }
}
