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

public sealed class OpenLinkAudioBridge : IDisposable
{
    private const int TransportChannels = 2;
    private WasapiCapture? _microphoneCapture;
    private WasapiLoopbackCapture? _systemCapture;
    private IWavePlayer? _remotePlaybackSession;
    private BufferedWaveProvider? _remotePlaybackBuffer;
    private WaveFormat? _remotePlaybackFormat;
    private bool _remotePlaybackStarted;
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
        _remotePlaybackVolume = PercentToGain(settings.RemoteAudioVolumePercent);
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
            log?.Invoke($"Audio streaming format {codec} is saved for negotiation, but this build can only transmit PCM stereo 16-bit. Using PCM until both endpoints support {codec}.");
            _loggedCodecFallback = true;
        }

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

        if (!string.Equals(frame.Codec, "pcm_s16le", StringComparison.OrdinalIgnoreCase))
        {
            log?.Invoke($"Remote audio frame ignored: unsupported codec {frame.Codec}.");
            return;
        }

        try
        {
            var payload = frame.Channels == TransportChannels
                ? frame.Payload
                : ConvertPcm16ToStereo(frame.Payload, frame.Channels);
            EnsureRemotePlayback(new WaveFormat(frame.SampleRate, frame.BitsPerSample, TransportChannels));
            _remotePlaybackBuffer?.AddSamples(payload, 0, payload.Length);
            TryStartRemotePlayback(frame.SampleRate);
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
        var playback = _remotePlaybackSession is null ? "remote playback inactive" : $"remote playback active via {_remotePlaybackDriverKey}";
        return $"OpenLink audio bridge: {microphone} ({_microphoneFormatText}), {system} ({_systemFormatText}), {playback}, direct buffer {_directAudioBufferSamples} samples, Windows playback buffer {_windowsAudioBufferSamples} samples, streaming PCM stereo 16-bit, virtual endpoint {VirtualDeviceName}.";
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

        if (Interlocked.Increment(ref _framesInFlight) > 4)
        {
            Interlocked.Decrement(ref _framesInFlight);
            return;
        }

        var payload = ConvertPcm16ToStereo(
            ConvertCaptureBufferToPcm16(format, buffer, byteCount, _localCaptureGain),
            format.Channels);
        if (payload.Length == 0)
        {
            Interlocked.Decrement(ref _framesInFlight);
            return;
        }

        var frame = new OpenLinkAudioFrame(source, format.SampleRate, 16, TransportChannels, "pcm_s16le", payload);

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
                var driverName = string.IsNullOrWhiteSpace(_asioDriverName)
                    ? driverNames.FirstOrDefault(name => name.Contains("ASIO4ALL", StringComparison.OrdinalIgnoreCase)) ?? driverNames.FirstOrDefault()
                    : _asioDriverName;

                if (!string.IsNullOrWhiteSpace(driverName))
                {
                    _remotePlaybackDriverKey = $"ASIO ({driverName})";
                    return new AsioOut(driverName);
                }
            }
            catch
            {
                // Fall back to the default Windows playback path below.
            }
        }

        _remotePlaybackDriverKey = "WaveOut/WASAPI-compatible";
        return new WaveOutEvent { DesiredLatency = WindowsDesiredLatencyMilliseconds(format.SampleRate), Volume = _remotePlaybackVolume };
    }

    private TimeSpan CaptureFrameInterval(int sampleRate)
    {
        var milliseconds = SamplesToMilliseconds(_directAudioBufferSamples, sampleRate);
        return TimeSpan.FromMilliseconds(Math.Clamp(milliseconds, 5.0, 80.0));
    }

    private TimeSpan PlaybackBufferDuration(int sampleRate)
    {
        var milliseconds = SamplesToMilliseconds(_windowsAudioBufferSamples, sampleRate);
        return TimeSpan.FromMilliseconds(Math.Clamp(milliseconds * 6, 80.0, 500.0));
    }

    private TimeSpan PrebufferDuration(int sampleRate)
    {
        var milliseconds = SamplesToMilliseconds(_windowsAudioBufferSamples, sampleRate);
        return TimeSpan.FromMilliseconds(Math.Clamp(milliseconds * 2, 40.0, 180.0));
    }

    private int WindowsDesiredLatencyMilliseconds(int sampleRate)
    {
        var bufferMilliseconds = SamplesToMilliseconds(_windowsAudioBufferSamples, sampleRate);
        return (int)Math.Round(Math.Clamp(bufferMilliseconds * 3, 60.0, 300.0));
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
