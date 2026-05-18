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
    private WasapiCapture? _microphoneCapture;
    private WasapiLoopbackCapture? _systemCapture;
    private WaveOutEvent? _remotePlaybackSession;
    private BufferedWaveProvider? _remotePlaybackBuffer;
    private WaveFormat? _remotePlaybackFormat;
    private Func<OpenLinkAudioFrame, Task>? _frameSink;
    private long _lastMicrophoneFrameTicks;
    private long _lastSystemFrameTicks;
    private string _microphoneFormatText = "microphone format unknown";
    private string _systemFormatText = "system audio format unknown";
    private int _framesInFlight;
    private bool _isStarted;

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
            EnsureRemotePlayback(new WaveFormat(frame.SampleRate, frame.BitsPerSample, frame.Channels));
            _remotePlaybackBuffer?.AddSamples(frame.Payload, 0, frame.Payload.Length);
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
        var playback = _remotePlaybackSession is null ? "remote playback inactive" : "remote playback session active";
        return $"OpenLink audio bridge: {microphone} ({_microphoneFormatText}), {system} ({_systemFormatText}), {playback}, virtual endpoint {VirtualDeviceName}.";
    }

    private void ForwardCaptureFrame(string source, WaveFormat format, byte[] buffer, int byteCount, ref long lastTicks)
    {
        var sink = _frameSink;
        if (sink is null || byteCount <= 0)
        {
            return;
        }

        var now = DateTimeOffset.UtcNow.Ticks;
        if (now - Interlocked.Read(ref lastTicks) < TimeSpan.FromMilliseconds(40).Ticks)
        {
            return;
        }
        Interlocked.Exchange(ref lastTicks, now);

        if (Interlocked.Increment(ref _framesInFlight) > 4)
        {
            Interlocked.Decrement(ref _framesInFlight);
            return;
        }

        var payload = ConvertCaptureBufferToPcm16(format, buffer, byteCount);
        if (payload.Length == 0)
        {
            Interlocked.Decrement(ref _framesInFlight);
            return;
        }

        var frame = new OpenLinkAudioFrame(source, format.SampleRate, 16, format.Channels, "pcm_s16le", payload);

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
        }

        _remotePlaybackFormat = format;
        _remotePlaybackBuffer = new BufferedWaveProvider(format)
        {
            BufferDuration = TimeSpan.FromSeconds(2),
            DiscardOnBufferOverflow = true
        };
        _remotePlaybackSession = new WaveOutEvent { DesiredLatency = 120 };
        _remotePlaybackSession.Init(_remotePlaybackBuffer);
        _remotePlaybackSession.Play();
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

    private static byte[] ConvertCaptureBufferToPcm16(WaveFormat format, byte[] buffer, int byteCount)
    {
        if (byteCount <= 0)
        {
            return [];
        }

        if (format.Encoding == WaveFormatEncoding.Pcm && format.BitsPerSample == 16)
        {
            var payload = new byte[byteCount];
            Buffer.BlockCopy(buffer, 0, payload, 0, byteCount);
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
                var pcm = (short)Math.Round(clipped * short.MaxValue);
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
                var pcm = (short)(value >> 16);
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

                var pcm = (short)(value >> 8);
                BinaryPrimitives.WriteInt16LittleEndian(payload.AsSpan(sampleIndex * sizeof(short), sizeof(short)), pcm);
            }

            return payload;
        }

        return [];
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
