using System.Diagnostics;
using System.IO;

namespace OpenLink.Windows;

public static class OpenLinkAudioDependencies
{
    private static int _ffmpegInstallStarted;

    public static bool IsFfmpegAvailable()
    {
        return CommandExists("ffmpeg.exe") || CommandExists("ffmpeg");
    }

    public static void EnsureForCodecInBackground(string codec, Action<string>? log = null)
    {
        if (!OpenLinkAudioSettings.RequiresExternalEncoder(codec) || IsFfmpegAvailable())
        {
            return;
        }

        if (Interlocked.Exchange(ref _ffmpegInstallStarted, 1) == 1)
        {
            return;
        }

        _ = Task.Run(() =>
        {
            try
            {
                var installer = FindCommand("winget.exe") ?? FindCommand("winget");
                var arguments = "install --id Gyan.FFmpeg --exact --silent --accept-package-agreements --accept-source-agreements";

                if (string.IsNullOrWhiteSpace(installer))
                {
                    installer = FindCommand("choco.exe") ?? FindCommand("choco");
                    arguments = "install ffmpeg -y --no-progress";
                }

                if (string.IsNullOrWhiteSpace(installer))
                {
                    log?.Invoke("FFmpeg is needed for FLAC, Ogg Opus, or MP3 streaming, but no supported package manager was found. PCM and WAV PCM remain available.");
                    return;
                }

                log?.Invoke("FFmpeg is missing. OpenLink is starting a background install so compressed audio formats can be enabled later.");
                using var process = Process.Start(new ProcessStartInfo
                {
                    FileName = installer,
                    Arguments = arguments,
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    WindowStyle = ProcessWindowStyle.Hidden
                });
                process?.WaitForExit();
                log?.Invoke(IsFfmpegAvailable()
                    ? "FFmpeg is now available for compressed OpenLink audio formats."
                    : "FFmpeg install finished but OpenLink still cannot find ffmpeg on PATH. PCM and WAV PCM remain available.");
            }
            catch (Exception ex)
            {
                log?.Invoke($"FFmpeg background install could not complete: {ex.Message}");
            }
        });
    }

    private static bool CommandExists(string command)
    {
        return !string.IsNullOrWhiteSpace(FindCommand(command));
    }

    private static string? FindCommand(string command)
    {
        try
        {
            var paths = (Environment.GetEnvironmentVariable("PATH") ?? string.Empty)
                .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            foreach (var path in paths)
            {
                var candidate = Path.Combine(path, command);
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
        }
        catch
        {
            return null;
        }

        return null;
    }
}
