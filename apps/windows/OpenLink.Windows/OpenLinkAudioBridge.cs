using NAudio.CoreAudioApi;
using NAudio.Wave;
using System.Buffers.Binary;
using System.Threading;

namespace OpenLink.Windows;

public sealed record OpenLinkAudioFrame(
    string Source,
    int SampleRate,
    int BitsPerSample,
    int Channels,
    string Codec,
    byte[] Payload);

public sealed record OpenLinkAsioDriverInfo(
    string Name,
    bool IsAsioa,
    bool IsAsio4All,
    string Description);

public sealed class OpenLinkAudioBridge : IDisposable
{
    private const int TransportChannels = 2;
    private WasapiCapture? _microphoneCapture;
    private WasapiLoopbackCapture? _systemCapture;
    private IWavePlayer? _remotePlaybackSession;
    private BufferedWaveProvider? _remotePlaybackBuffer;
    private WaveFormat? _remotePlaybackFormat;
    private bool _remotePlaybackStarted;
    private string _remotePlaybackOutputName = "system default";
    private string _remotePlaybackDriverKey = "waveout";
    private Func<OpenLinkAudioFrame, Task>? _frameSink;
    private long _lastMicrophoneFrameTicks;
    private long _lastSystemFrameTicks;
    private float _localCaptureGain = 1.0f;
    private float _remotePlaybackVolume = 1.0f;
    private string _microphoneFormatText = "microphone format unknown";
    private string _systemFormatText = "system audio format unknown";
    private int _framesInFlight;
    private bool _isStarted;
    private bool _useAsioPlayback;
    private string _asioDriverName = "";
    private int _asioLatencyMilliseconds = 20;
    private int _directAudioBufferSamples = 512;
    private int _windowsAudioBufferSamples = 512;
    private string _audioStreamingCodec = "pcm_s16le";
    private bool _loggedCodecFallback;

    public string StatusText { get; private set; } = "OpenLink audio bridge is stopped.";
    public string VirtualDeviceName { get; } = "OpenLink VoiceLink Virtual Audio";

    public void SetFrameSink(Func<OpenLinkAudioFrame, Task>? frameSink)
    {
        _frameSink = frameSink;
    }

    public void Start(OpenLinkSettings settings, Action<string>? log = null)
    {
        if (!settings.AllowAudio)
        {
            Stop();
            StatusText = "OpenLink audio is disabled in settings.";
            log?.Invoke(StatusText);
            return;
        }

        if (_isStarted)
        {
            Configure(settings, log);
            return;
        }

        Configure(settings, log);
        _isStarted = true;
        StatusText = BuildStatus();
        log?.Invoke(StatusText);
    }

    public void Configure(OpenLinkSettings settings, Action<string>? log = null)
    {
        _localCaptureGain = PercentToGain(settings.LocalAudioCaptureVolumePercent);
        _remotePlaybackVolume = PercentToGain(Math.Clamp(settings.RemoteAudioVolumePercent < 0 ? 100 : settings.RemoteAudioVolumePercent, 0, 150));
        var directBufferSamples = OpenLinkAudioSettings.ClampBufferSamples(settings.DirectAudioBufferSamples);
        var windowsBufferSamples = OpenLinkAudioSettings.ClampBufferSamples(settings.WindowsAudioBufferSamples);
        var codec = OpenLinkAudioSettings.NormalizeCodec(settings.AudioStreamingCodec);
        var playbackDriverChanged =
            _useAsioPlayback != settings.EnableAsioAudioDriver ||
            !string.Equals(_asioDriverName, settings.AsioDriverName, StringComparison.OrdinalIgnoreCase) ||
            _asioLatencyMilliseconds != settings.AsioLatencyMilliseconds ||
            _windowsAudioBufferSamples != windowsBufferSamples;
        _useAsioPlayback = settings.EnableAsioAudioDriver;
        _asioDriverName = settings.AsioDriverName.Trim();
        _asioLatencyMilliseconds = Math.Clamp(settings.AsioLatencyMilliseconds, 5, 200);
        _directAudioBufferSamples = directBufferSamples;
        _windowsAudioBufferSamples = windowsBufferSamples;
        _audioStreamingCodec = codec;
        if (!OpenLinkAudioSettings.IsCodecAvailable(codec) && !_loggedCodecFallback)
        {
            log?.Invoke($"Audio streaming format {codec} is saved for negotiation, but needs FFmpeg on both endpoints. Using PCM or WAV PCM until both endpoints support {codec}.");
            _loggedCodecFallback = true;
        }
        OpenLinkAudioDependencies.EnsureForCodecInBackground(codec, log);

        if (playbackDriverChanged && _remotePlaybackSession is not null)
        {
            _remotePlaybackSession.Stop();
            _remotePlaybackSession.Dispose();
            _remotePlaybackSession = null;
            _remotePlaybackBuffer = null;
            _remotePlaybackFormat = null;
            _remotePlaybackStarted = false;
        }

        if (_remotePlaybackSession is not null)
        {
            _remotePlaybackSession.Volume = _remotePlaybackVolume;
        }

        ConfigureMicrophone(settings.AllowMicrophoneAudio, log);
        ConfigureSystemAudio(settings.AllowSystemAudio, log);
        ConfigurePlaybackSession(settings.AllowAudio, log);
        StatusText = BuildStatus();
    }

    public void Stop()
    {
        StopCapture(ref _microphoneCapture);
        StopCapture(ref _systemCapture);

        if (_remotePlaybackSession is not null)
        {
            try
            {
                _remotePlaybackSession.Stop();
            }
            catch
            {
                // Best-effort shutdown; audio cleanup should not block app close.
            }

            _remotePlaybackSession.Dispose();
            _remotePlaybackSession = null;
            _remotePlaybackBuffer = null;
            _remotePlaybackFormat = null;
        }

        _isStarted = false;
        StatusText = "OpenLink audio bridge is stopped.";
    }

    private void ConfigureMicrophone(bool enabled, Action<string>? log)
    {
        if (!enabled)
        {
            StopCapture(ref _microphoneCapture);
            return;
        }

        if (_microphoneCapture is not null)
        {
            return;
        }

        try
        {
            _microphoneCapture = new WasapiCapture();
            var format = _microphoneCapture.WaveFormat;
            _microphoneFormatText = FormatDescription(format);
            log?.Invoke($"Microphone audio capture format: {_microphoneFormatText}.");
            _microphoneCapture.DataAvailable += (_, args) =>
            {
                ForwardCaptureFrame("microphone", format, args.Buffer, args.BytesRecorded, ref _lastMicrophoneFrameTicks);
            };
            _microphoneCapture.StartRecording();
        }
        catch (Exception ex)
        {
            StopCapture(ref _microphoneCapture);
            log?.Invoke($"Microphone audio bridge failed: {ex.Message}");
        }
    }

    private void ConfigureSystemAudio(bool enabled, Action<string>? log)
    {
        if (!enabled)
        {
            StopCapture(ref _systemCapture);
            return;
        }

        if (_systemCapture is not null)
        {
            return;
        }

        try
        {
            _systemCapture = new WasapiLoopbackCapture();
            var format = _systemCapture.WaveFormat;
            _systemFormatText = FormatDescription(format);
            log?.Invoke($"System audio capture format: {_systemFormatText}.");
            _systemCapture.DataAvailable += (_, args) =>
            {
                ForwardCaptureFrame("system", format, args.Buffer, args.BytesRecorded, ref _lastSystemFrameTicks);
            };
            _systemCapture.StartRecording();
        }
        catch (Exception ex)
        {
            StopCapture(ref _systemCapture);
            log?.Invoke($"System audio bridge failed: {ex.Message}");
        }
    }

    private void ConfigurePlaybackSession(bool enabled, Action<string>? log)
    {
        if (!enabled)
        {
            if (_remotePlaybackSession is not null)
            {
                _remotePlaybackSession.Stop();
                _remotePlaybackSession.Dispose();
                _remotePlaybackSession = null;
            }
            return;
        }

        if (_remotePlaybackSession is not null)
        {
            return;
        }

        try
        {
            EnsureRemotePlayback(new WaveFormat(48000, 16, 2));
        }
        catch (Exception ex)
        {
            _remotePlaybackSession?.Dispose();
            _remotePlaybackSession = null;
            log?.Invoke($"Remote audio playback bridge failed: {ex.Message}");
        }
    }

    public void PlayRemoteFrame(OpenLinkAudioFrame frame, Action<string>? log = null)
    {
        if (frame.Payload.Length == 0)
        {
            return;
        }

        var codec = OpenLinkAudioSettings.NormalizeCodec(frame.Codec);
        if (!OpenLinkAudioSettings.IsCodecAvailable(codec))
        {
            log?.Invoke($"Remote audio frame ignored: unsupported codec {frame.Codec}.");
            return;
        }

        try
        {
            var decoded = DecodeFramePayload(frame);
            if (decoded.Payload.Length == 0)
            {
                return;
            }

            var payload = decoded.Channels == TransportChannels
                ? decoded.Payload
                : ConvertPcmToStereo(decoded.Payload, decoded.Channels, decoded.BitsPerSample);
            EnsureRemotePlayback(new WaveFormat(decoded.SampleRate, decoded.BitsPerSample, TransportChannels));
            _remotePlaybackBuffer?.AddSamples(payload, 0, payload.Length);
            TryStartRemotePlayback(decoded.SampleRate);
            StatusText = BuildStatus();
        }
        catch (Exception ex)
        {
            log?.Invoke($"Remote audio playback failed: {ex.Message}");
        }
    }

    private string BuildStatus()
    {
        var microphone = _microphoneCapture is null ? "microphone muted" : "microphone capture active";
        var system = _systemCapture is null ? "system audio muted" : "system audio capture active";
        var playback = _remotePlaybackSession is null ? "remote playback inactive" : $"remote playback active via {_remotePlaybackDriverKey} to {_remotePlaybackOutputName}";
        return $"OpenLink audio bridge: {microphone} ({_microphoneFormatText}), {system} ({_systemFormatText}), {playback}, direct buffer {_directAudioBufferSamples} samples, Windows playback buffer {_windowsAudioBufferSamples} samples, streaming {CodecDescription(_audioStreamingCodec)}, virtual endpoint {VirtualDeviceName}.";
    }

    private void ForwardCaptureFrame(string source, WaveFormat format, byte[] buffer, int byteCount, ref long lastTicks)
    {
        var sink = _frameSink;
        if (sink is null || byteCount <= 0)
        {
            return;
        }

        var now = DateTimeOffset.UtcNow.Ticks;
        if (now - Interlocked.Read(ref lastTicks) < CaptureFrameInterval(format.SampleRate).Ticks)
        {
            return;
        }
        Interlocked.Exchange(ref lastTicks, now);

        if (Interlocked.Increment(ref _framesInFlight) > 8)
        {
            Interlocked.Decrement(ref _framesInFlight);
            return;
        }

        var activeCodec = OpenLinkAudioSettings.IsCodecAvailable(_audioStreamingCodec)
            ? OpenLinkAudioSettings.NormalizeCodec(_audioStreamingCodec)
            : "pcm_s16le";
        var bitsPerSample = OpenLinkAudioSettings.BitsPerSampleForCodec(activeCodec);
        var pcm16 = ConvertPcm16ToStereo(
            ConvertCaptureBufferToPcm16(format, buffer, byteCount, _localCaptureGain),
            format.Channels);
        var payload = bitsPerSample == 32 ? ConvertPcm16ToPcm32(pcm16) : pcm16;
        if (payload.Length == 0)
        {
            Interlocked.Decrement(ref _framesInFlight);
            return;
        }

        var sampleRate = NormalizeSupportedSampleRate(format.SampleRate);
        if (OpenLinkAudioSettings.IsWavCodec(activeCodec))
        {
            payload = EncodeWavePcm(payload, sampleRate, bitsPerSample, TransportChannels);
        }

        var frame = new OpenLinkAudioFrame(source, sampleRate, bitsPerSample, TransportChannels, activeCodec, payload);

        _ = Task.Run(async () =>
        {
            try
            {
                await sink(frame);
            }
            catch
            {
                // Dropped audio frames should not tear down remote control.
            }
            finally
            {
                Interlocked.Decrement(ref _framesInFlight);
            }
        });
    }

    private void EnsureRemotePlayback(WaveFormat format)
    {
        if (_remotePlaybackSession is not null &&
            _remotePlaybackFormat is not null &&
            _remotePlaybackFormat.SampleRate == format.SampleRate &&
            _remotePlaybackFormat.BitsPerSample == format.BitsPerSample &&
            _remotePlaybackFormat.Channels == format.Channels)
        {
            return;
        }

        if (_remotePlaybackSession is not null)
        {
            _remotePlaybackSession.Stop();
            _remotePlaybackSession.Dispose();
            _remotePlaybackStarted = false;
        }

        _remotePlaybackFormat = format;
        _remotePlaybackBuffer = new BufferedWaveProvider(format)
        {
            BufferDuration = PlaybackBufferDuration(format.SampleRate),
            DiscardOnBufferOverflow = true
        };
        _remotePlaybackSession = CreatePlaybackSession(format);
        _remotePlaybackSession.Init(_remotePlaybackBuffer);
        _remotePlaybackSession.Volume = _remotePlaybackVolume;
        _remotePlaybackStarted = false;
    }

    private void TryStartRemotePlayback(int sampleRate)
    {
        if (_remotePlaybackStarted ||
            _remotePlaybackSession is null ||
            _remotePlaybackBuffer is null ||
            _remotePlaybackFormat is null)
        {
            return;
        }

        var bytesPerSampleFrame = Math.Max(1, _remotePlaybackFormat.BlockAlign);
        var targetBytes = Math.Max(
            bytesPerSampleFrame,
            (int)(sampleRate * bytesPerSampleFrame * PrebufferDuration(sampleRate).TotalSeconds));
        if (_remotePlaybackBuffer.BufferedBytes < targetBytes)
        {
            return;
        }

        _remotePlaybackSession.Play();
        _remotePlaybackStarted = true;
    }

    private IWavePlayer CreatePlaybackSession(WaveFormat format)
    {
        if (_useAsioPlayback)
        {
            try
            {
                var driverNames = GetAsioDriverNames();
                var driverName = SelectAsioDriver(driverNames, _asioDriverName);

                if (!string.IsNullOrWhiteSpace(driverName))
                {
                    _remotePlaybackDriverKey = $"ASIO ({driverName})";
                    _remotePlaybackOutputName = driverName.Contains("ASIOA", StringComparison.OrdinalIgnoreCase)
                        ? "ASIOA Audio Router selected ASIO output"
                        : "selected ASIO output";
                    return new AsioOut(driverName);
                }
            }
            catch
            {
                // Fall back to the default Windows playback path below.
            }
        }

        if (TryCreateWasapiDefaultPlayback(out var wasapiPlayback))
        {
            return wasapiPlayback;
        }

        _remotePlaybackDriverKey = "WaveOut fallback";
        _remotePlaybackOutputName = "Windows wave mapper";
        return new WaveOutEvent
        {
            DeviceNumber = -1,
            DesiredLatency = WindowsDesiredLatencyMilliseconds(format.SampleRate),
            Volume = _remotePlaybackVolume
        };
    }

    private bool TryCreateWasapiDefaultPlayback(out IWavePlayer playback)
    {
        playback = null!;
        try
        {
            using var enumerator = new MMDeviceEnumerator();
            var device = enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
            _remotePlaybackDriverKey = "WASAPI shared";
            _remotePlaybackOutputName = string.IsNullOrWhiteSpace(device.FriendlyName)
                ? "system default audio device"
                : device.FriendlyName;
            playback = new WasapiOut(device, AudioClientShareMode.Shared, true, WindowsDesiredLatencyMilliseconds(device.AudioClient.MixFormat.SampleRate));
            return true;
        }
        catch
        {
            return false;
        }
    }

    private TimeSpan CaptureFrameInterval(int sampleRate)
    {
        var milliseconds = SamplesToMilliseconds(_directAudioBufferSamples, sampleRate);
        return TimeSpan.FromMilliseconds(Math.Clamp(milliseconds, 5.0, 80.0));
    }

    private TimeSpan PlaybackBufferDuration(int sampleRate)
    {
        var milliseconds = SamplesToMilliseconds(_windowsAudioBufferSamples, sampleRate);
        return TimeSpan.FromMilliseconds(Math.Clamp(milliseconds * 8, 160.0, 800.0));
    }

    private TimeSpan PrebufferDuration(int sampleRate)
    {
        var milliseconds = SamplesToMilliseconds(_windowsAudioBufferSamples, sampleRate);
        return TimeSpan.FromMilliseconds(Math.Clamp(milliseconds * 3, 80.0, 240.0));
    }

    private int WindowsDesiredLatencyMilliseconds(int sampleRate)
    {
        var bufferMilliseconds = SamplesToMilliseconds(_windowsAudioBufferSamples, sampleRate);
        return (int)Math.Round(Math.Clamp(bufferMilliseconds * 4, 90.0, 400.0));
    }

    private static double SamplesToMilliseconds(int samples, int sampleRate)
    {
        return sampleRate <= 0 ? 20.0 : samples / (double)sampleRate * 1000.0;
    }

    public static IReadOnlyList<string> GetAsioDriverNames()
    {
        try
        {
            return AsioOut.GetDriverNames();
        }
        catch
        {
            return [];
        }
    }

    public static IReadOnlyList<OpenLinkAsioDriverInfo> GetAsioDriverInfo()
    {
        return GetAsioDriverNames()
            .Select(name => new OpenLinkAsioDriverInfo(
                name,
                IsAsioaDriver(name),
                name.Contains("ASIO4ALL", StringComparison.OrdinalIgnoreCase),
                DescribeAsioDriver(name)))
            .OrderByDescending(info => info.IsAsioa)
            .ThenByDescending(info => info.IsAsio4All)
            .ThenBy(info => info.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private static string? SelectAsioDriver(IReadOnlyList<string> driverNames, string requestedDriverName)
    {
        if (!string.IsNullOrWhiteSpace(requestedDriverName))
        {
            var exact = driverNames.FirstOrDefault(name =>
                string.Equals(name, requestedDriverName, StringComparison.OrdinalIgnoreCase));
            if (!string.IsNullOrWhiteSpace(exact))
            {
                return exact;
            }
        }

        return driverNames.FirstOrDefault(IsAsioaDriver)
            ?? driverNames.FirstOrDefault(name => name.Contains("ASIO4ALL", StringComparison.OrdinalIgnoreCase))
            ?? driverNames.FirstOrDefault();
    }

    private static bool IsAsioaDriver(string driverName)
    {
        return driverName.Contains("ASIOA", StringComparison.OrdinalIgnoreCase) ||
               driverName.Contains("Audio Router", StringComparison.OrdinalIgnoreCase);
    }

    private static string DescribeAsioDriver(string driverName)
    {
        if (IsAsioaDriver(driverName))
        {
            return "ASIOA Audio Router. Use this when routing OpenLink audio through the ASIOA driver and its selected in/out pairs.";
        }

        if (driverName.Contains("ASIO4ALL", StringComparison.OrdinalIgnoreCase))
        {
            return "ASIO4ALL compatibility driver. Use this for systems that already depend on ASIO4ALL.";
        }

        return "Installed ASIO driver.";
    }

    private static void StopCapture<TCapture>(ref TCapture? capture)
        where TCapture : class, IWaveIn
    {
        if (capture is null)
        {
            return;
        }

        try
        {
            capture.StopRecording();
        }
        catch
        {
            // Best-effort shutdown; the capture object is disposed below.
        }

        if (capture is IDisposable disposable)
        {
            disposable.Dispose();
        }

        capture = null;
    }

    private static byte[] ConvertCaptureBufferToPcm16(WaveFormat format, byte[] buffer, int byteCount, float gain)
    {
        if (byteCount <= 0)
        {
            return [];
        }

        if (format.Encoding == WaveFormatEncoding.Pcm && format.BitsPerSample == 16)
        {
            var payload = new byte[byteCount];
            Buffer.BlockCopy(buffer, 0, payload, 0, byteCount);
            ApplyPcm16Gain(payload, gain);
            return payload;
        }

        if (format.Encoding == WaveFormatEncoding.IeeeFloat && format.BitsPerSample == 32)
        {
            var sampleCount = byteCount / sizeof(float);
            var payload = new byte[sampleCount * sizeof(short)];
            for (var sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++)
            {
                var value = BitConverter.ToSingle(buffer, sampleIndex * sizeof(float));
                var clipped = Math.Clamp(value, -1.0f, 1.0f);
                var pcm = FloatToPcm16(clipped * gain);
                BinaryPrimitives.WriteInt16LittleEndian(payload.AsSpan(sampleIndex * sizeof(short), sizeof(short)), pcm);
            }

            return payload;
        }

        if (format.Encoding == WaveFormatEncoding.Pcm && format.BitsPerSample == 32)
        {
            var sampleCount = byteCount / sizeof(int);
            var payload = new byte[sampleCount * sizeof(short)];
            for (var sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++)
            {
                var value = BinaryPrimitives.ReadInt32LittleEndian(buffer.AsSpan(sampleIndex * sizeof(int), sizeof(int)));
                var pcm = ApplyGain((short)(value >> 16), gain);
                BinaryPrimitives.WriteInt16LittleEndian(payload.AsSpan(sampleIndex * sizeof(short), sizeof(short)), pcm);
            }

            return payload;
        }

        if (format.Encoding == WaveFormatEncoding.Pcm && format.BitsPerSample == 24)
        {
            var sampleCount = byteCount / 3;
            var payload = new byte[sampleCount * sizeof(short)];
            for (var sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++)
            {
                var offset = sampleIndex * 3;
                var value = buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
                if ((value & 0x800000) != 0)
                {
                    value |= unchecked((int)0xFF000000);
                }

                var pcm = ApplyGain((short)(value >> 8), gain);
                BinaryPrimitives.WriteInt16LittleEndian(payload.AsSpan(sampleIndex * sizeof(short), sizeof(short)), pcm);
            }

            return payload;
        }

        return [];
    }

    private static byte[] ConvertPcm16ToStereo(byte[] monoOrMultichannelPayload, int channels)
    {
        if (monoOrMultichannelPayload.Length == 0 || channels <= 0)
        {
            return [];
        }

        if (channels == TransportChannels)
        {
            return monoOrMultichannelPayload;
        }

        var sampleCount = monoOrMultichannelPayload.Length / sizeof(short);
        var frames = sampleCount / channels;
        var stereo = new byte[frames * TransportChannels * sizeof(short)];
        for (var frame = 0; frame < frames; frame++)
        {
            short left;
            short right;
            if (channels == 1)
            {
                left = right = BinaryPrimitives.ReadInt16LittleEndian(
                    monoOrMultichannelPayload.AsSpan(frame * sizeof(short), sizeof(short)));
            }
            else
            {
                var baseOffset = frame * channels * sizeof(short);
                left = BinaryPrimitives.ReadInt16LittleEndian(monoOrMultichannelPayload.AsSpan(baseOffset, sizeof(short)));
                right = BinaryPrimitives.ReadInt16LittleEndian(monoOrMultichannelPayload.AsSpan(baseOffset + sizeof(short), sizeof(short)));
            }

            var outOffset = frame * TransportChannels * sizeof(short);
            BinaryPrimitives.WriteInt16LittleEndian(stereo.AsSpan(outOffset, sizeof(short)), left);
            BinaryPrimitives.WriteInt16LittleEndian(stereo.AsSpan(outOffset + sizeof(short), sizeof(short)), right);
        }

        return stereo;
    }

    private static (byte[] Payload, int SampleRate, int BitsPerSample, int Channels) DecodeFramePayload(OpenLinkAudioFrame frame)
    {
        var codec = OpenLinkAudioSettings.NormalizeCodec(frame.Codec);
        if (OpenLinkAudioSettings.IsWavCodec(codec) && TryDecodeWavePcm(frame.Payload, out var wavPayload, out var wavSampleRate, out var wavBits, out var wavChannels))
        {
            return (wavPayload, wavSampleRate, wavBits, wavChannels);
        }

        return (frame.Payload, NormalizeSupportedSampleRate(frame.SampleRate), frame.BitsPerSample == 32 ? 32 : 16, Math.Max(1, frame.Channels));
    }

    private static byte[] ConvertPcmToStereo(byte[] monoOrMultichannelPayload, int channels, int bitsPerSample)
    {
        return bitsPerSample == 32
            ? ConvertPcm32ToStereo(monoOrMultichannelPayload, channels)
            : ConvertPcm16ToStereo(monoOrMultichannelPayload, channels);
    }

    private static byte[] ConvertPcm32ToStereo(byte[] monoOrMultichannelPayload, int channels)
    {
        if (monoOrMultichannelPayload.Length == 0 || channels <= 0)
        {
            return [];
        }

        if (channels == TransportChannels)
        {
            return monoOrMultichannelPayload;
        }

        var sampleCount = monoOrMultichannelPayload.Length / sizeof(int);
        var frames = sampleCount / channels;
        var stereo = new byte[frames * TransportChannels * sizeof(int)];
        for (var frame = 0; frame < frames; frame++)
        {
            int left;
            int right;
            if (channels == 1)
            {
                left = right = BinaryPrimitives.ReadInt32LittleEndian(
                    monoOrMultichannelPayload.AsSpan(frame * sizeof(int), sizeof(int)));
            }
            else
            {
                var baseOffset = frame * channels * sizeof(int);
                left = BinaryPrimitives.ReadInt32LittleEndian(monoOrMultichannelPayload.AsSpan(baseOffset, sizeof(int)));
                right = BinaryPrimitives.ReadInt32LittleEndian(monoOrMultichannelPayload.AsSpan(baseOffset + sizeof(int), sizeof(int)));
            }

            var outOffset = frame * TransportChannels * sizeof(int);
            BinaryPrimitives.WriteInt32LittleEndian(stereo.AsSpan(outOffset, sizeof(int)), left);
            BinaryPrimitives.WriteInt32LittleEndian(stereo.AsSpan(outOffset + sizeof(int), sizeof(int)), right);
        }

        return stereo;
    }

    private static byte[] ConvertPcm16ToPcm32(byte[] pcm16Payload)
    {
        var sampleCount = pcm16Payload.Length / sizeof(short);
        var pcm32 = new byte[sampleCount * sizeof(int)];
        for (var sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++)
        {
            var sample = BinaryPrimitives.ReadInt16LittleEndian(pcm16Payload.AsSpan(sampleIndex * sizeof(short), sizeof(short)));
            BinaryPrimitives.WriteInt32LittleEndian(pcm32.AsSpan(sampleIndex * sizeof(int), sizeof(int)), sample << 16);
        }

        return pcm32;
    }

    private static byte[] EncodeWavePcm(byte[] pcmPayload, int sampleRate, int bitsPerSample, int channels)
    {
        var bytesPerSample = bitsPerSample / 8;
        var blockAlign = (short)(channels * bytesPerSample);
        var byteRate = sampleRate * blockAlign;
        var wave = new byte[44 + pcmPayload.Length];

        WriteAscii(wave, 0, "RIFF");
        BinaryPrimitives.WriteInt32LittleEndian(wave.AsSpan(4, 4), 36 + pcmPayload.Length);
        WriteAscii(wave, 8, "WAVE");
        WriteAscii(wave, 12, "fmt ");
        BinaryPrimitives.WriteInt32LittleEndian(wave.AsSpan(16, 4), 16);
        BinaryPrimitives.WriteInt16LittleEndian(wave.AsSpan(20, 2), 1);
        BinaryPrimitives.WriteInt16LittleEndian(wave.AsSpan(22, 2), (short)channels);
        BinaryPrimitives.WriteInt32LittleEndian(wave.AsSpan(24, 4), sampleRate);
        BinaryPrimitives.WriteInt32LittleEndian(wave.AsSpan(28, 4), byteRate);
        BinaryPrimitives.WriteInt16LittleEndian(wave.AsSpan(32, 2), blockAlign);
        BinaryPrimitives.WriteInt16LittleEndian(wave.AsSpan(34, 2), (short)bitsPerSample);
        WriteAscii(wave, 36, "data");
        BinaryPrimitives.WriteInt32LittleEndian(wave.AsSpan(40, 4), pcmPayload.Length);
        Buffer.BlockCopy(pcmPayload, 0, wave, 44, pcmPayload.Length);
        return wave;
    }

    private static bool TryDecodeWavePcm(byte[] wave, out byte[] payload, out int sampleRate, out int bitsPerSample, out int channels)
    {
        payload = [];
        sampleRate = 48000;
        bitsPerSample = 16;
        channels = TransportChannels;

        if (wave.Length < 44 || !AsciiEquals(wave, 0, "RIFF") || !AsciiEquals(wave, 8, "WAVE"))
        {
            return false;
        }

        var offset = 12;
        var foundFormat = false;
        while (offset + 8 <= wave.Length)
        {
            var chunkId = ReadAscii(wave, offset, 4);
            var chunkSize = BinaryPrimitives.ReadInt32LittleEndian(wave.AsSpan(offset + 4, 4));
            var chunkDataOffset = offset + 8;
            if (chunkSize < 0 || chunkDataOffset + chunkSize > wave.Length)
            {
                break;
            }

            if (chunkId == "fmt " && chunkSize >= 16)
            {
                var audioFormat = BinaryPrimitives.ReadInt16LittleEndian(wave.AsSpan(chunkDataOffset, 2));
                if (audioFormat != 1)
                {
                    return false;
                }

                channels = Math.Max(1, (int)BinaryPrimitives.ReadInt16LittleEndian(wave.AsSpan(chunkDataOffset + 2, 2)));
                sampleRate = NormalizeSupportedSampleRate(BinaryPrimitives.ReadInt32LittleEndian(wave.AsSpan(chunkDataOffset + 4, 4)));
                bitsPerSample = BinaryPrimitives.ReadInt16LittleEndian(wave.AsSpan(chunkDataOffset + 14, 2)) == 32 ? 32 : 16;
                foundFormat = true;
            }
            else if (chunkId == "data" && foundFormat)
            {
                payload = new byte[chunkSize];
                Buffer.BlockCopy(wave, chunkDataOffset, payload, 0, chunkSize);
                return true;
            }

            offset = chunkDataOffset + chunkSize + (chunkSize % 2);
        }

        return false;
    }

    private static int NormalizeSupportedSampleRate(int sampleRate)
    {
        return Math.Abs(sampleRate - 44100) <= Math.Abs(sampleRate - 48000) ? 44100 : 48000;
    }

    private static string CodecDescription(string codec)
    {
        return OpenLinkAudioSettings.NormalizeCodec(codec) switch
        {
            "pcm_s32le" => "PCM stereo 32-bit",
            "wav_pcm_s16le" => "WAV PCM stereo 16-bit",
            "wav_pcm_s32le" => "WAV PCM stereo 32-bit",
            "flac" => "FLAC when FFmpeg is available",
            "ogg_opus" => "Ogg Opus when FFmpeg is available",
            "mp3" => "MP3 when FFmpeg is available",
            _ => "PCM stereo 16-bit"
        };
    }

    private static void WriteAscii(byte[] buffer, int offset, string value)
    {
        for (var index = 0; index < value.Length; index++)
        {
            buffer[offset + index] = (byte)value[index];
        }
    }

    private static string ReadAscii(byte[] buffer, int offset, int length)
    {
        return System.Text.Encoding.ASCII.GetString(buffer, offset, length);
    }

    private static bool AsciiEquals(byte[] buffer, int offset, string value)
    {
        if (offset + value.Length > buffer.Length)
        {
            return false;
        }

        for (var index = 0; index < value.Length; index++)
        {
            if (buffer[offset + index] != (byte)value[index])
            {
                return false;
            }
        }

        return true;
    }

    private static float PercentToGain(int percent)
    {
        return Math.Clamp(percent, 0, 150) / 100.0f;
    }

    private static void ApplyPcm16Gain(byte[] payload, float gain)
    {
        if (Math.Abs(gain - 1.0f) < 0.001f)
        {
            return;
        }

        for (var offset = 0; offset + 1 < payload.Length; offset += sizeof(short))
        {
            var sample = BinaryPrimitives.ReadInt16LittleEndian(payload.AsSpan(offset, sizeof(short)));
            BinaryPrimitives.WriteInt16LittleEndian(payload.AsSpan(offset, sizeof(short)), ApplyGain(sample, gain));
        }
    }

    private static short ApplyGain(short sample, float gain)
    {
        return FloatToPcm16(sample / (float)short.MaxValue * gain);
    }

    private static short FloatToPcm16(float value)
    {
        var clipped = Math.Clamp(value, -1.0f, 1.0f);
        return (short)Math.Round(clipped * short.MaxValue);
    }

    private static string FormatDescription(WaveFormat format)
    {
        return $"{format.Encoding} {format.SampleRate} Hz, {format.BitsPerSample}-bit, {format.Channels} channel(s)";
    }

    public void Dispose()
    {
        Stop();
    }
}
