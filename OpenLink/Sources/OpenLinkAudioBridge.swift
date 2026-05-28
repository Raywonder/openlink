import AVFoundation
import Foundation

final class OpenLinkAudioBridge {
    static let shared = OpenLinkAudioBridge()
    private static let transportChannels = 2

    let virtualDeviceName = "OpenLink VoiceLink Virtual Audio"

    private let captureEngine = AVAudioEngine()
    private let playbackEngine = AVAudioEngine()
    private let playerNode = AVAudioPlayerNode()
    private var isPlayerAttached = false
    private var isCapturing = false
    private var lastFrameTime = Date.distantPast
    private let lock = NSLock()
    private var captureBufferSamples = 512
    private var playbackBufferSamples = 512
    private var requestedCodec = "pcm_s16le"

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

    func startCapture(targetMachineId: String, directBufferSamples: Int? = nil, requestedCodec: String? = nil, frameSink: @escaping ([String: Any]) -> Void) {
        lock.lock()
        defer { lock.unlock() }

        if isCapturing {
            return
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
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(captureBufferSamples), format: format) { [weak self] buffer, _ in
            guard let self else { return }
            let now = Date()
            if now.timeIntervalSince(self.lastFrameTime) < Self.frameIntervalSeconds(samples: self.captureBufferSamples, sampleRate: format.sampleRate) {
                return
            }
            self.lastFrameTime = now

            guard let data = Self.stereoInt16PCMData(from: buffer) else { return }
            let activeCodec = Self.activeTransportCodec(for: self.requestedCodec)
            frameSink([
                "type": "audio_frame",
                "targetMachineId": targetMachineId,
                "sourceMachineId": self.localMachineId(),
                "source": "microphone",
                "sampleRate": Int(format.sampleRate),
                "bitsPerSample": 16,
                "channels": Self.transportChannels,
                "codec": activeCodec,
                "requestedCodec": self.requestedCodec,
                "directAudioBufferSamples": self.captureBufferSamples,
                "playbackBufferSamples": self.playbackBufferSamples,
                "transport": "voicelink-pcm-ws",
                "virtualDeviceName": self.virtualDeviceName,
                "data": data.base64EncodedString()
            ])
        }

        do {
            try captureEngine.start()
            isCapturing = true
        } catch {
            input.removeTap(onBus: 0)
            isCapturing = false
        }
    }

    func stopCapture() {
        lock.lock()
        defer { lock.unlock() }

        captureEngine.inputNode.removeTap(onBus: 0)
        captureEngine.stop()
        isCapturing = false
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
