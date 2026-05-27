using System.Globalization;
using System.IO;
using System.Net;
using System.Speech.Synthesis;
using System.Text;
using System.Text.Json;

namespace OpenLink.Windows;

public sealed class OpenLinkTtsService : IDisposable
{
    public const int DefaultPort = 8766;
    public const string TestPhrase = "This is a test. This is what the system speech will sound like when using your local voice with the remote screen reader. You can change this at any time.";

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true
    };

    private readonly object _sync = new();
    private readonly Action<string>? _log;
    private SpeechSynthesizer _synthesizer = new();
    private HttpListener? _listener;
    private CancellationTokenSource? _cts;
    private OpenLinkSettings _settings;
    private bool _speaking;

    public OpenLinkTtsService(OpenLinkSettings settings, Action<string>? log = null)
    {
        _settings = settings.Clone();
        _log = log;
        _synthesizer.SpeakStarted += (_, _) => _speaking = true;
        _synthesizer.SpeakCompleted += (_, _) => _speaking = false;
        ApplySettings();
    }

    public bool IsRunning => _listener?.IsListening == true;

    public static IReadOnlyList<TtsVoiceInfo> GetInstalledVoices()
    {
        using var synth = new SpeechSynthesizer();
        return synth.GetInstalledVoices()
            .Where(voice => voice.Enabled)
            .Select(voice => new TtsVoiceInfo(
                voice.VoiceInfo.Name,
                voice.VoiceInfo.Name,
                voice.VoiceInfo.Culture.Name,
                voice.VoiceInfo.Gender.ToString(),
                "system-sapi",
                string.Equals(voice.VoiceInfo.Name, synth.Voice.Name, StringComparison.OrdinalIgnoreCase)))
            .ToList();
    }

    public void Configure(OpenLinkSettings settings)
    {
        _settings = settings.Clone();
        ApplySettings();

        if (_settings.EnableLocalTtsHelper)
        {
            Start();
        }
        else
        {
            Stop();
        }
    }

    public void Start()
    {
        if (!_settings.EnableLocalTtsHelper || IsRunning)
        {
            return;
        }

        try
        {
            _cts = new CancellationTokenSource();
            _listener = new HttpListener();
            _listener.Prefixes.Add($"http://127.0.0.1:{_settings.LocalTtsPort}/");
            _listener.Start();
            _ = Task.Run(() => ListenAsync(_cts.Token));
            _log?.Invoke($"OpenLink local TTS helper listening on 127.0.0.1:{_settings.LocalTtsPort}.");
        }
        catch (Exception ex)
        {
            _log?.Invoke($"OpenLink local TTS helper failed to start: {ex.Message}");
            Stop();
        }
    }

    public void Stop()
    {
        try
        {
            _cts?.Cancel();
            _listener?.Stop();
            _listener?.Close();
            StopSpeaking();
        }
        catch
        {
            // Best-effort shutdown only.
        }
        finally
        {
            _listener = null;
            _cts?.Dispose();
            _cts = null;
        }
    }

    public Task SpeakStatusAsync(string text)
    {
        if (!_settings.EnableLocalTtsHelper || string.IsNullOrWhiteSpace(text))
        {
            return Task.CompletedTask;
        }

        return SpeakAsync(new TtsSpeakRequest
        {
            Text = text,
            Priority = "polite",
            Interrupt = false,
            VoiceId = _settings.LocalTtsVoiceId,
            Rate = _settings.LocalTtsRate,
            Volume = _settings.LocalTtsVolumePercent / 100.0
        });
    }

    public Task SpeakRemoteAnnouncementAsync(string text)
    {
        if (!_settings.EnableLocalTtsHelper || string.IsNullOrWhiteSpace(text))
        {
            return Task.CompletedTask;
        }

        return SpeakAsync(new TtsSpeakRequest
        {
            Text = text,
            Priority = "assertive",
            Interrupt = true,
            VoiceId = _settings.LocalTtsVoiceId,
            Rate = _settings.LocalTtsRate,
            Volume = _settings.LocalTtsVolumePercent / 100.0
        });
    }

    public Task TestAsync()
    {
        return SpeakAsync(new TtsSpeakRequest
        {
            Text = TestPhrase,
            Priority = "assertive",
            Interrupt = true,
            VoiceId = _settings.LocalTtsVoiceId,
            Rate = _settings.LocalTtsRate,
            Volume = _settings.LocalTtsVolumePercent / 100.0
        });
    }

    private async Task ListenAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested && _listener?.IsListening == true)
        {
            try
            {
                var context = await _listener.GetContextAsync();
                _ = Task.Run(() => HandleRequestAsync(context), cancellationToken);
            }
            catch (Exception ex) when (ex is HttpListenerException or ObjectDisposedException or OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                _log?.Invoke($"OpenLink local TTS helper request failed: {ex.Message}");
            }
        }
    }

    private async Task HandleRequestAsync(HttpListenerContext context)
    {
        AddCorsHeaders(context.Response);

        if (context.Request.HttpMethod.Equals("OPTIONS", StringComparison.OrdinalIgnoreCase))
        {
            context.Response.StatusCode = 204;
            context.Response.Close();
            return;
        }

        try
        {
            var path = context.Request.Url?.AbsolutePath.TrimEnd('/').ToLowerInvariant() ?? "";
            switch (context.Request.HttpMethod, path)
            {
                case ("GET", "/status"):
                    await WriteJsonAsync(context.Response, BuildStatus());
                    break;
                case ("GET", "/voices"):
                    await WriteJsonAsync(context.Response, GetInstalledVoices());
                    break;
                case ("POST", "/speak"):
                    await SpeakAsync(await ReadSpeakRequestAsync(context.Request));
                    await WriteJsonAsync(context.Response, new { ok = true, speaking = _speaking });
                    break;
                case ("POST", "/stop"):
                    StopSpeaking();
                    await WriteJsonAsync(context.Response, new { ok = true, speaking = _speaking });
                    break;
                case ("POST", "/test"):
                    await TestAsync();
                    await WriteJsonAsync(context.Response, new { ok = true, speaking = _speaking });
                    break;
                default:
                    context.Response.StatusCode = 404;
                    await WriteJsonAsync(context.Response, new { ok = false, error = "not_found" });
                    break;
            }
        }
        catch (Exception ex)
        {
            context.Response.StatusCode = 500;
            _log?.Invoke($"OpenLink local TTS helper error: {ex.Message}");
            await WriteJsonAsync(context.Response, new { ok = false, error = "tts_error" });
        }
        finally
        {
            context.Response.Close();
        }
    }

    private object BuildStatus()
    {
        return new
        {
            ok = true,
            platform = "windows",
            provider = "system-sapi",
            loopbackOnly = true,
            speaking = _speaking,
            voiceId = string.IsNullOrWhiteSpace(_settings.LocalTtsVoiceId) ? _synthesizer.Voice.Name : _settings.LocalTtsVoiceId,
            port = _settings.LocalTtsPort
        };
    }

    private async Task<TtsSpeakRequest> ReadSpeakRequestAsync(HttpListenerRequest request)
    {
        using var reader = new StreamReader(request.InputStream, request.ContentEncoding);
        var body = await reader.ReadToEndAsync();
        return JsonSerializer.Deserialize<TtsSpeakRequest>(body, JsonOptions) ?? new TtsSpeakRequest();
    }

    private Task SpeakAsync(TtsSpeakRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Text))
        {
            return Task.CompletedTask;
        }

        lock (_sync)
        {
            if (request.Interrupt || string.Equals(request.Priority, "assertive", StringComparison.OrdinalIgnoreCase))
            {
                _synthesizer.SpeakAsyncCancelAll();
            }

            SelectVoice(request.VoiceId);
            _synthesizer.Rate = MapRate(request.Rate);
            _synthesizer.Volume = MapVolume(request.Volume);
            _synthesizer.SpeakAsync(request.Text);
        }

        return Task.CompletedTask;
    }

    private void StopSpeaking()
    {
        lock (_sync)
        {
            _synthesizer.SpeakAsyncCancelAll();
            _speaking = false;
        }
    }

    private void ApplySettings()
    {
        lock (_sync)
        {
            SelectVoice(_settings.LocalTtsVoiceId);
            _synthesizer.Rate = MapRate(_settings.LocalTtsRate);
            _synthesizer.Volume = _settings.LocalTtsVolumePercent;
        }
    }

    private void SelectVoice(string? voiceId)
    {
        if (string.IsNullOrWhiteSpace(voiceId))
        {
            return;
        }

        try
        {
            _synthesizer.SelectVoice(voiceId);
        }
        catch (Exception ex)
        {
            _log?.Invoke($"OpenLink local TTS voice unavailable: {voiceId}. {ex.Message}");
        }
    }

    private static int MapRate(double? rate)
    {
        var normalized = Math.Clamp(rate ?? 1.0, 0.5, 2.0);
        return (int)Math.Round((normalized - 1.0) * 10, MidpointRounding.AwayFromZero);
    }

    private static int MapVolume(double? volume)
    {
        return (int)Math.Round(Math.Clamp(volume ?? 1.0, 0.0, 1.0) * 100, MidpointRounding.AwayFromZero);
    }

    private static void AddCorsHeaders(HttpListenerResponse response)
    {
        response.Headers["Access-Control-Allow-Origin"] = "*";
        response.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
        response.Headers["Access-Control-Allow-Headers"] = "Content-Type";
    }

    private static async Task WriteJsonAsync(HttpListenerResponse response, object value)
    {
        response.ContentType = "application/json; charset=utf-8";
        var json = JsonSerializer.Serialize(value, JsonOptions);
        var bytes = Encoding.UTF8.GetBytes(json);
        response.ContentLength64 = bytes.Length;
        await response.OutputStream.WriteAsync(bytes);
    }

    public void Dispose()
    {
        Stop();
        _synthesizer.Dispose();
    }
}

public sealed record TtsVoiceInfo(
    string Id,
    string Name,
    string Locale,
    string Gender,
    string Provider,
    bool IsDefault);

public sealed class TtsSpeakRequest
{
    public string Text { get; set; } = "";
    public string Priority { get; set; } = "polite";
    public bool Interrupt { get; set; }
    public string? VoiceId { get; set; }
    public double? Rate { get; set; }
    public double? Volume { get; set; }
    public double? Pitch { get; set; }
    public string? SessionId { get; set; }
    public string? MachineId { get; set; }
}
