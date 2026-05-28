import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

final class OpenLinkAudioBridge {
    static let shared = OpenLinkAudioBridge()
    private static let transportChannels = 2

    let virtualDeviceName = "OpenLink VoiceLink Virtual Audio"

    private let captureEngine = AVAudioEngine()
    private let playbackEngine = AVAudioEngine()
    private let playerNode = AVAudioPlayerNode()
    private let systemAudioCapture = MacSystemAudioCapture()
    private var isPlayerAttached = false
    private var isCapturing = false
    private var lastFrameTime = Date.distantPast
    private let lock = NSLock()
    private var captureBufferSamples = 512
    private var playbackBufferSamples = 512
    private var requestedCodec = "pcm_s16le"
    private var currentCaptureTargetMachineId: String?
    private var currentFrameSink: (([String: Any]) -> Void)?

    private init() {}

    func configure(directBufferSamples: Int? = nil, playbackBufferSamples: Int? = nil, requestedCodec: String? = nil) {
        lock.lock()
        defer { lock.unlock() }

        if let directBufferSamples {
            self.captureBufferSamples = Self.clampBufferSamples(directBufferSamples)
            UserDefaults.standard.set(self.captureBufferSamples, forKey: "directAudioBufferSamples")
        }
        if let playbackBufferSamples {
            self.playbackBufferSamples = Self.clampBufferSamples(playbackBufferSamples)
            UserDefaults.standard.set(self.playbackBufferSamples, forKey: "macAudioPlaybackBufferSamples")
        }
        if let requestedCodec, !requestedCodec.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            self.requestedCodec = Self.normalizeCodec(requestedCodec)
            UserDefaults.standard.set(self.requestedCodec, forKey: "audioStreamingCodec")
        }
    }

    @discardableResult
    func startCapture(targetMachineId: String, directBufferSamples: Int? = nil, requestedCodec: String? = nil, frameSink: @escaping ([String: Any]) -> Void) -> Bool {
        lock.lock()
        defer { lock.unlock() }

        currentCaptureTargetMachineId = targetMachineId
        currentFrameSink = frameSink
        if isCapturing {
            return true
        }

        if let directBufferSamples {
            captureBufferSamples = Self.clampBufferSamples(directBufferSamples)
        } else {
            captureBufferSamples = Self.clampBufferSamples(UserDefaults.standard.integer(forKey: "directAudioBufferSamples"))
        }
        if let requestedCodec {
            self.requestedCodec = Self.normalizeCodec(requestedCodec)
        } else if let savedCodec = UserDefaults.standard.string(forKey: "audioStreamingCodec") {
            self.requestedCodec = Self.normalizeCodec(savedCodec)
        }

        let input = captureEngine.inputNode
        let format = input.inputFormat(forBus: 0)
        let allowMicrophoneAudio = UserDefaults.standard.object(forKey: "allowMicrophoneAudio") as? Bool ?? true
        if allowMicrophoneAudio {
            input.removeTap(onBus: 0)
            input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(captureBufferSamples), format: format) { [weak self] buffer, _ in
                guard let self else { return }
                self.lock.lock()
                let captureSamples = self.captureBufferSamples
                self.lock.unlock()

                let now = Date()
                if now.timeIntervalSince(self.lastFrameTime) < Self.frameIntervalSeconds(samples: captureSamples, sampleRate: format.sampleRate) {
                    return
                }
                self.lastFrameTime = now

                guard let data = Self.stereoInt16PCMData(from: buffer) else { return }
                self.sendAudioFrame(
                    source: "microphone",
                    sampleRate: Int(format.sampleRate),
                    bitsPerSample: 16,
                    channels: Self.transportChannels,
                    data: data
                )
            }
        }

        do {
            if allowMicrophoneAudio {
                try captureEngine.start()
            }
            isCapturing = true
            startSystemAudioCaptureIfAllowed()
            sendAudioRouteStatus(message: "Mac audio routing started.", microphoneStarted: allowMicrophoneAudio, systemAudioRequested: systemAudioAllowed(), systemAudioStarted: systemAudioCapture.isRunning)
            return true
        } catch {
            input.removeTap(onBus: 0)
            isCapturing = false
            currentCaptureTargetMachineId = nil
            currentFrameSink = nil
            systemAudioCapture.stop()
            return false
        }
    }

    func stopCapture() {
        lock.lock()
        defer { lock.unlock() }

        captureEngine.inputNode.removeTap(onBus: 0)
        captureEngine.stop()
        systemAudioCapture.stop()
        isCapturing = false
        currentCaptureTargetMachineId = nil
        currentFrameSink = nil
    }

    private func startSystemAudioCaptureIfAllowed() {
        guard systemAudioAllowed() else {
            sendAudioRouteStatus(message: "Mac system audio routing is disabled in OpenLink settings.", microphoneStarted: true, systemAudioRequested: false, systemAudioStarted: false)
            return
        }

        if #available(macOS 13.0, *) {
            systemAudioCapture.start { [weak self] event in
                switch event {
                case .status(let started, let message):
                    self?.sendAudioRouteStatus(message: message, microphoneStarted: true, systemAudioRequested: true, systemAudioStarted: started)
                case .frame(let sampleRate, let channels, let data):
                    self?.sendAudioFrame(
                        source: "system",
                        sampleRate: sampleRate,
                        bitsPerSample: 16,
                        channels: channels,
                        data: data
                    )
                }
            }
        } else {
            sendAudioRouteStatus(message: "Mac system audio routing needs macOS 13 or later.", microphoneStarted: true, systemAudioRequested: true, systemAudioStarted: false)
        }
    }

    private func systemAudioAllowed() -> Bool {
        UserDefaults.standard.object(forKey: "allowSystemAudio") as? Bool ?? true
    }

    private func sendAudioFrame(source: String, sampleRate: Int, bitsPerSample: Int, channels: Int, data: Data) {
        lock.lock()
        let targetMachineId = currentCaptureTargetMachineId
        let frameSink = currentFrameSink
        let captureSamples = captureBufferSamples
        let activeRequestedCodec = requestedCodec
        let playbackSamples = playbackBufferSamples
        lock.unlock()

        guard let targetMachineId, let frameSink else { return }
        let activeCodec = Self.activeTransportCodec(for: activeRequestedCodec)
        frameSink([
            "type": "audio_frame",
            "targetMachineId": targetMachineId,
            "sourceMachineId": localMachineId(),
            "source": source,
            "sampleRate": sampleRate,
            "bitsPerSample": bitsPerSample,
            "channels": channels,
            "codec": activeCodec,
            "requestedCodec": activeRequestedCodec,
            "directAudioBufferSamples": captureSamples,
            "playbackBufferSamples": playbackSamples,
            "transport": "voicelink-pcm-ws",
            "virtualDeviceName": virtualDeviceName,
            "data": data.base64EncodedString()
        ])
    }

    private func sendAudioRouteStatus(message: String, microphoneStarted: Bool, systemAudioRequested: Bool, systemAudioStarted: Bool) {
        lock.lock()
        let targetMachineId = currentCaptureTargetMachineId
        let frameSink = currentFrameSink
        lock.unlock()

        guard let targetMachineId, let frameSink else { return }
        frameSink([
            "type": "audio_route_status",
            "targetMachineId": targetMachineId,
            "sourceMachineId": localMachineId(),
            "sourcePlatform": "macOS",
            "microphoneCaptureStarted": microphoneStarted,
            "systemAudioRequested": systemAudioRequested,
            "systemAudioCaptureStarted": systemAudioStarted,
            "systemAudioProvider": "ScreenCaptureKit",
            "message": message
        ])
    }

    func play(frame json: [String: Any]) {
        guard
            let base64 = json["data"] as? String,
            let data = Data(base64Encoded: base64)
        else {
            return
        }

        let codec = (json["codec"] as? String) ?? "pcm_s16le"
        guard Self.activeTransportCodec(for: codec) == "pcm_s16le" else {
            return
        }
        if let playbackSamples = (json["windowsAudioBufferSamples"] as? Int) ?? (json["playbackBufferSamples"] as? Int) {
            configure(playbackBufferSamples: playbackSamples)
        }

        let sampleRate = Double(json["sampleRate"] as? Int ?? 48_000)
        let sourceChannels = max(1, json["channels"] as? Int ?? Self.transportChannels)
        let playbackData = sourceChannels == Self.transportChannels ? data : Self.stereoInt16PCMData(from: data, channels: sourceChannels)
        let channels = AVAudioChannelCount(Self.transportChannels)
        guard
            let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: channels),
            let buffer = Self.floatBuffer(fromInt16PCM: playbackData, format: format)
        else {
            return
        }

        lock.lock()
        defer { lock.unlock() }

        if !isPlayerAttached {
            playbackEngine.attach(playerNode)
            playbackEngine.connect(playerNode, to: playbackEngine.mainMixerNode, format: format)
            isPlayerAttached = true
        }

        if !playbackEngine.isRunning {
            try? playbackEngine.start()
        }
        if !playerNode.isPlaying {
            playerNode.play()
        }
        playerNode.scheduleBuffer(buffer, completionHandler: nil)
    }

    private static func clampBufferSamples(_ samples: Int) -> Int {
        if samples <= 0 { return 512 }
        return min(2048, max(16, samples))
    }

    private static func frameIntervalSeconds(samples: Int, sampleRate: Double) -> TimeInterval {
        let rate = sampleRate > 0 ? sampleRate : 48_000
        let seconds = Double(clampBufferSamples(samples)) / rate
        return min(0.08, max(0.005, seconds))
    }

    private static func normalizeCodec(_ codec: String) -> String {
        let normalized = codec.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch normalized {
        case "pcm_s16le", "flac", "ogg_opus", "mp3":
            return normalized
        default:
            return "pcm_s16le"
        }
    }

    private static func activeTransportCodec(for requestedCodec: String) -> String {
        // The current native stream is always PCM stereo 16-bit. Compressed codecs are
        // retained in policy/settings until both endpoints have matching encoders.
        return "pcm_s16le"
    }

    private func localMachineId() -> String {
        let host = Host.current().localizedName ?? ProcessInfo.processInfo.hostName
        return host
            .lowercased()
            .replacingOccurrences(of: "'", with: "")
            .replacingOccurrences(of: "’", with: "")
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }
            .joined(separator: "-")
    }

    private static func stereoInt16PCMData(from buffer: AVAudioPCMBuffer) -> Data? {
        guard let channelData = buffer.floatChannelData else { return nil }
        let channels = Int(buffer.format.channelCount)
        let frames = Int(buffer.frameLength)
        var data = Data(capacity: frames * transportChannels * MemoryLayout<Int16>.size)

        for frame in 0..<frames {
            let leftSample = max(-1.0, min(1.0, channelData[0][frame]))
            let rightSample = channels > 1 ? max(-1.0, min(1.0, channelData[1][frame])) : leftSample
            for sample in [leftSample, rightSample] {
                var intSample = Int16(sample * Float(Int16.max)).littleEndian
                withUnsafeBytes(of: &intSample) { bytes in
                    data.append(contentsOf: bytes)
                }
            }
        }

        return data
    }

    fileprivate static func stereoInt16PCMData(from sampleBuffer: CMSampleBuffer) -> (data: Data, sampleRate: Int, channels: Int)? {
        guard
            let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer),
            let streamDescriptionPointer = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription)
        else {
            return nil
        }

        let streamDescription = streamDescriptionPointer.pointee
        let sampleRate = Int(streamDescription.mSampleRate > 0 ? streamDescription.mSampleRate : 48_000)
        let sourceChannels = max(1, Int(streamDescription.mChannelsPerFrame))
        let frameCount = CMSampleBufferGetNumSamples(sampleBuffer)
        if frameCount <= 0 {
            return nil
        }

        let maximumBuffers = max(1, sourceChannels)
        let bufferList = AudioBufferList.allocate(maximumBuffers: maximumBuffers)
        defer { free(bufferList.unsafeMutablePointer) }
        let bufferListSize = MemoryLayout<AudioBufferList>.size + ((maximumBuffers - 1) * MemoryLayout<AudioBuffer>.size)
        var blockBuffer: CMBlockBuffer?
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: bufferList.unsafeMutablePointer,
            bufferListSize: bufferListSize,
            blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: 0,
            blockBufferOut: &blockBuffer
        )
        guard status == noErr else {
            return nil
        }

        let buffers = UnsafeMutableAudioBufferListPointer(bufferList.unsafeMutablePointer)
        guard !buffers.isEmpty else {
            return nil
        }

        let formatFlags = streamDescription.mFormatFlags
        let isFloat = (formatFlags & kAudioFormatFlagIsFloat) != 0
        let isSignedInteger = (formatFlags & kAudioFormatFlagIsSignedInteger) != 0
        let bitsPerChannel = Int(streamDescription.mBitsPerChannel)
        let bytesPerFrame = max(1, Int(streamDescription.mBytesPerFrame))
        let isNonInterleaved = (formatFlags & kAudioFormatFlagIsNonInterleaved) != 0 || buffers.count > 1
        var data = Data(capacity: frameCount * transportChannels * MemoryLayout<Int16>.size)

        for frame in 0..<frameCount {
            let left = sampleValue(
                buffers: buffers,
                frame: frame,
                channel: 0,
                sourceChannels: sourceChannels,
                isNonInterleaved: isNonInterleaved,
                isFloat: isFloat,
                isSignedInteger: isSignedInteger,
                bitsPerChannel: bitsPerChannel,
                bytesPerFrame: bytesPerFrame
            )
            let right = sampleValue(
                buffers: buffers,
                frame: frame,
                channel: min(1, sourceChannels - 1),
                sourceChannels: sourceChannels,
                isNonInterleaved: isNonInterleaved,
                isFloat: isFloat,
                isSignedInteger: isSignedInteger,
                bitsPerChannel: bitsPerChannel,
                bytesPerFrame: bytesPerFrame
            )
            for sample in [left, right] {
                var intSample = Int16(max(-1.0, min(1.0, sample)) * Float(Int16.max)).littleEndian
                withUnsafeBytes(of: &intSample) { bytes in
                    data.append(contentsOf: bytes)
                }
            }
        }

        return (data, sampleRate, transportChannels)
    }

    private static func sampleValue(
        buffers: UnsafeMutableAudioBufferListPointer,
        frame: Int,
        channel: Int,
        sourceChannels: Int,
        isNonInterleaved: Bool,
        isFloat: Bool,
        isSignedInteger: Bool,
        bitsPerChannel: Int,
        bytesPerFrame: Int
    ) -> Float {
        let bufferIndex = isNonInterleaved ? min(channel, buffers.count - 1) : 0
        guard
            buffers.indices.contains(bufferIndex),
            let data = buffers[bufferIndex].mData
        else {
            return 0
        }

        if isFloat, bitsPerChannel == 32 {
            let values = data.assumingMemoryBound(to: Float.self)
            let index = isNonInterleaved ? frame : (frame * sourceChannels) + channel
            return values[index]
        }

        if isSignedInteger, bitsPerChannel == 16 {
            let values = data.assumingMemoryBound(to: Int16.self)
            let index = isNonInterleaved ? frame : (frame * sourceChannels) + channel
            return Float(Int16(littleEndian: values[index])) / Float(Int16.max)
        }

        if isSignedInteger, bitsPerChannel == 32 {
            let values = data.assumingMemoryBound(to: Int32.self)
            let index = isNonInterleaved ? frame : (frame * sourceChannels) + channel
            return Float(Int32(littleEndian: values[index])) / Float(Int32.max)
        }

        let byteOffset = isNonInterleaved ? frame * max(1, bitsPerChannel / 8) : (frame * bytesPerFrame) + (channel * max(1, bitsPerChannel / 8))
        let bytes = data.advanced(by: byteOffset).assumingMemoryBound(to: UInt8.self)
        return (Float(bytes.pointee) - 128.0) / 128.0
    }

    private static func stereoInt16PCMData(from data: Data, channels: Int) -> Data {
        if channels == transportChannels {
            return data
        }

        let sampleCount = data.count / MemoryLayout<Int16>.size
        let frames = sampleCount / channels
        var stereo = Data(capacity: frames * transportChannels * MemoryLayout<Int16>.size)
        data.withUnsafeBytes { rawBuffer in
            guard let samples = rawBuffer.bindMemory(to: Int16.self).baseAddress else { return }
            for frame in 0..<frames {
                let left = Int16(littleEndian: samples[frame * channels])
                let right = channels > 1 ? Int16(littleEndian: samples[(frame * channels) + 1]) : left
                for sample in [left, right] {
                    var littleEndianSample = sample.littleEndian
                    withUnsafeBytes(of: &littleEndianSample) { bytes in
                        stereo.append(contentsOf: bytes)
                    }
                }
            }
        }

        return stereo
    }

    private static func floatBuffer(fromInt16PCM data: Data, format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let channels = Int(format.channelCount)
        guard channels > 0 else { return nil }

        let sampleCount = data.count / MemoryLayout<Int16>.size
        let frames = sampleCount / channels
        guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)) else {
            return nil
        }

        buffer.frameLength = AVAudioFrameCount(frames)
        data.withUnsafeBytes { rawBuffer in
            guard let samples = rawBuffer.bindMemory(to: Int16.self).baseAddress,
                  let floatChannels = buffer.floatChannelData else {
                return
            }

            for frame in 0..<frames {
                for channel in 0..<channels {
                    let sample = Int16(littleEndian: samples[(frame * channels) + channel])
                    floatChannels[channel][frame] = Float(sample) / Float(Int16.max)
                }
            }
        }

        return buffer
    }
}

@available(macOS 13.0, *)
private final class MacSystemAudioCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    enum Event {
        case status(started: Bool, message: String)
        case frame(sampleRate: Int, channels: Int, data: Data)
    }

    private var stream: SCStream?
    private let queue = DispatchQueue(label: "fm.tappedin.openlink.system-audio")
    private var eventSink: ((Event) -> Void)?
    private(set) var isRunning = false

    func start(eventSink: @escaping (Event) -> Void) {
        self.eventSink = eventSink
        if isRunning {
            eventSink(.status(started: true, message: "Mac system audio capture is already running."))
            return
        }

        Task {
            await startAsync()
        }
    }

    func stop() {
        let activeStream = stream
        stream = nil
        isRunning = false
        Task {
            try? await activeStream?.stopCapture()
        }
    }

    private func startAsync() async {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let display = content.displays.first else {
                isRunning = false
                eventSink?(.status(started: false, message: "Mac system audio capture could not find a display to attach to."))
                return
            }

            let filter = SCContentFilter(display: display, excludingWindows: [])
            let configuration = SCStreamConfiguration()
            configuration.capturesAudio = true
            configuration.excludesCurrentProcessAudio = true
            configuration.sampleRate = 48_000
            configuration.channelCount = 2
            configuration.width = 2
            configuration.height = 2
            configuration.minimumFrameInterval = CMTime(value: 1, timescale: 2)
            configuration.showsCursor = false

            let newStream = SCStream(filter: filter, configuration: configuration, delegate: self)
            try newStream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
            try await newStream.startCapture()
            stream = newStream
            isRunning = true
            eventSink?(.status(started: true, message: "Mac system audio capture started with ScreenCaptureKit."))
        } catch {
            stream = nil
            isRunning = false
            eventSink?(.status(started: false, message: "Mac system audio capture failed: \(error.localizedDescription)"))
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        isRunning = false
        eventSink?(.status(started: false, message: "Mac system audio capture stopped: \(error.localizedDescription)"))
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio,
              sampleBuffer.isValid,
              CMSampleBufferDataIsReady(sampleBuffer),
              let converted = OpenLinkAudioBridge.stereoInt16PCMData(from: sampleBuffer)
        else {
            return
        }

        eventSink?(.frame(sampleRate: converted.sampleRate, channels: converted.channels, data: converted.data))
    }
}
