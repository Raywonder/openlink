using System.Diagnostics;
using System.IO;

namespace OpenLink.Windows;

public sealed class BrailleDisplayService
{
    private readonly NvdaControllerBridge _nvda = new();
    private readonly Action<string>? _log;
    private OpenLinkSettings _settings;
    private bool _loggedUnavailable;

    public BrailleDisplayService(OpenLinkSettings settings, Action<string>? log = null)
    {
        _settings = settings.Clone();
        _log = log;
    }

    public void Configure(OpenLinkSettings settings)
    {
        _settings = settings.Clone();
        _loggedUnavailable = false;
    }

    public BrailleDisplayStatus GetStatus()
    {
        var brlttyPath = ResolveBrlttyExecutablePath();
        return new BrailleDisplayStatus(
            Enabled: _settings.EnableBrailleDisplaySupport,
            Provider: NormalizeProvider(_settings.BrailleProvider),
            NvdaAvailable: _nvda.IsRunning,
            BrlttyAvailable: brlttyPath is not null,
            BrlttyPath: brlttyPath ?? "");
    }

    public Task<bool> SendAsync(string text)
    {
        if (!_settings.EnableBrailleDisplaySupport || string.IsNullOrWhiteSpace(text))
        {
            return Task.FromResult(false);
        }

        var provider = NormalizeProvider(_settings.BrailleProvider);
        var normalized = NormalizeBrailleText(text);

        if (provider is "auto" or "nvda")
        {
            if (_nvda.Braille(normalized))
            {
                return Task.FromResult(true);
            }
        }

        if (provider is "auto" or "brltty")
        {
            return Task.FromResult(SendViaBrltty(normalized));
        }

        return Task.FromResult(false);
    }

    private bool SendViaBrltty(string text)
    {
        var brlttyPath = ResolveBrlttyExecutablePath();
        if (brlttyPath is null)
        {
            LogUnavailableOnce("BRLTTY was not found. Install BRLTTY or use NVDA braille output, then enable braille display support again.");
            return false;
        }

        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = brlttyPath,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            startInfo.ArgumentList.Add("-m");
            startInfo.ArgumentList.Add(text);
            using var process = Process.Start(startInfo);
            return process is not null;
        }
        catch (Exception ex)
        {
            _log?.Invoke($"BRLTTY braille output failed: {ex.Message}");
            return false;
        }
    }

    private string? ResolveBrlttyExecutablePath()
    {
        var candidates = new List<string>();
        if (!string.IsNullOrWhiteSpace(_settings.BrlttyExecutablePath))
        {
            candidates.Add(_settings.BrlttyExecutablePath);
        }

        candidates.AddRange([
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "BRLTTY", "bin", "brltty.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "BRLTTY", "bin", "brltty.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "brltty", "bin", "brltty.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "brltty", "bin", "brltty.exe")
        ]);

        var pathValue = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var pathPart in pathValue.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            candidates.Add(Path.Combine(pathPart, "brltty.exe"));
        }

        return candidates.FirstOrDefault(File.Exists);
    }

    private void LogUnavailableOnce(string message)
    {
        if (_loggedUnavailable)
        {
            return;
        }

        _loggedUnavailable = true;
        _log?.Invoke(message);
    }

    private static string NormalizeProvider(string? provider)
    {
        return provider?.Trim().ToLowerInvariant() switch
        {
            "nvda" => "nvda",
            "brltty" => "brltty",
            _ => "auto"
        };
    }

    private static string NormalizeBrailleText(string text)
    {
        return text
            .Replace('\r', ' ')
            .Replace('\n', ' ')
            .Trim();
    }
}

public sealed record BrailleDisplayStatus(
    bool Enabled,
    string Provider,
    bool NvdaAvailable,
    bool BrlttyAvailable,
    string BrlttyPath);
