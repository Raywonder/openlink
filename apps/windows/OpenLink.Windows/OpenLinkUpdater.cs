using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace OpenLink.Windows;

public sealed class OpenLinkUpdater
{
    private static readonly JsonSerializerOptions ManifestJsonOptions = new()
    {
        PropertyNameCaseInsensitive = true
    };

    private readonly OpenLinkSettings _settings;
    private readonly Action<string> _announce;
    private readonly Action<string> _log;

    public OpenLinkUpdater(OpenLinkSettings settings, Action<string> announce, Action<string> log)
    {
        _settings = settings;
        _announce = announce;
        _log = log;
    }

    public async Task CheckAsync(bool interactive, CancellationToken cancellationToken = default)
    {
        if (!interactive && !_settings.CheckForUpdatesAutomatically && !_settings.DownloadUpdatesAutomatically)
        {
            return;
        }

        try
        {
            using var http = new HttpClient();
            var manifest = await FetchManifestAsync(http, cancellationToken);
            if (manifest is null || string.IsNullOrWhiteSpace(manifest.Version) || string.IsNullOrWhiteSpace(manifest.ResolvedDownloadUrl))
            {
                if (interactive)
                {
                    _announce("No valid OpenLink update information was found.");
                }
                return;
            }

            var current = GetCurrentVersion();
            if (!IsNewerVersion(manifest.Version, current))
            {
                if (interactive)
                {
                    _announce($"OpenLink is up to date. Current version {current}.");
                }
                return;
            }

            _announce($"OpenLink {manifest.Version} is available.");
            if (interactive && !ConfirmUpdate(manifest))
            {
                _announce("OpenLink update postponed.");
                return;
            }

            if (interactive || _settings.DownloadUpdatesAutomatically)
            {
                await DownloadAndInstallAsync(http, manifest, cancellationToken);
            }
        }
        catch (Exception ex)
        {
            _log($"OpenLink update check failed: {ex.Message}");
            if (interactive)
            {
                _announce($"OpenLink update check failed: {ex.Message}");
            }
        }
    }

    private async Task<UpdateManifest?> FetchManifestAsync(HttpClient http, CancellationToken cancellationToken)
    {
        Exception? lastError = null;
        foreach (var manifestUrl in GetManifestUrls())
        {
            try
            {
                await using var stream = await http.GetStreamAsync(manifestUrl, cancellationToken);
                var manifest = await JsonSerializer.DeserializeAsync<UpdateManifest>(stream, ManifestJsonOptions, cancellationToken);
                if (manifest is not null)
                {
                    _log($"OpenLink update manifest loaded from {manifestUrl.Host}.");
                    return manifest;
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                lastError = ex;
                _log($"OpenLink update manifest failed from {manifestUrl.Host}: {ex.Message}");
            }
        }

        if (lastError is not null)
        {
            throw lastError;
        }

        return null;
    }

    private IEnumerable<Uri> GetManifestUrls()
    {
        var urls = new[]
        {
            _settings.UpdateManifestUrl,
            OpenLinkSettings.CloudUpdateManifestUrl,
            OpenLinkSettings.TappedInUpdateManifestUrl
        };

        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var url in urls)
        {
            if (!Uri.TryCreate(url, UriKind.Absolute, out var uri))
            {
                continue;
            }

            if (seen.Add(uri.AbsoluteUri))
            {
                yield return uri;
            }
        }
    }

    private async Task DownloadAndInstallAsync(HttpClient http, UpdateManifest manifest, CancellationToken cancellationToken)
    {
        var updatesDir = Path.Combine(OpenLinkSettingsStore.SettingsDirectory, "updates");
        Directory.CreateDirectory(updatesDir);

        var fileName = string.IsNullOrWhiteSpace(manifest.FileName)
            ? Path.GetFileName(new Uri(manifest.ResolvedDownloadUrl).LocalPath)
            : manifest.FileName;
        if (string.IsNullOrWhiteSpace(fileName))
        {
            fileName = "OpenLink-Setup.exe";
        }

        var targetPath = GetUpdateInstallerPath(updatesDir, fileName, manifest.Version);
        var tempPath = targetPath + ".download";
        _announce($"Downloading OpenLink {manifest.Version}.");

        await using (var remote = await http.GetStreamAsync(manifest.ResolvedDownloadUrl, cancellationToken))
        await using (var local = new FileStream(tempPath, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            await remote.CopyToAsync(local, cancellationToken);
        }

        VerifyChecksumIfProvided(tempPath, manifest);

        if (File.Exists(targetPath))
        {
            File.Delete(targetPath);
        }

        File.Move(tempPath, targetPath);
        WritePendingUpdate(manifest.Version, manifest.ResolvedReleaseNotes);
        _announce("Update downloaded. OpenLink will install the update and restart.");
        StartInstallerAfterExit(updatesDir, targetPath, "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS");
        System.Windows.Application.Current.Dispatcher.Invoke(() =>
        {
            System.Windows.Application.Current.Shutdown();
        });
    }

    private bool ConfirmUpdate(UpdateManifest manifest)
    {
        var accepted = false;
        System.Windows.Application.Current.Dispatcher.Invoke(() =>
        {
            var dialog = new WhatIsNewDialog(manifest.Version, manifest.ResolvedReleaseNotes, updatePrompt: true);
            accepted = dialog.ShowDialog() == true;
        });
        return accepted;
    }

    private static void StartInstallerAfterExit(string updatesDir, string installerPath, string installerArguments)
    {
        var scriptPath = Path.Combine(updatesDir, "run-openlink-update.ps1");
        var installedAppPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            "OpenLink",
            "OpenLink.exe");
        var script = """
param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$InstallerPath,
    [Parameter(Mandatory = $true)][string]$InstallerArguments,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string]$InstalledAppPath
)

try {
    Wait-Process -Id $ProcessId -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 800
    Start-Process -FilePath $InstallerPath -ArgumentList $InstallerArguments -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -Wait
} catch {
    Start-Process -FilePath $InstallerPath -ArgumentList $InstallerArguments -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -Wait
}

Start-Sleep -Milliseconds 800
if (Test-Path -LiteralPath $InstalledAppPath) {
    Start-Process -FilePath $InstalledAppPath
}
""";
        File.WriteAllText(scriptPath, script);

        var launcherPath = Path.Combine(updatesDir, "run-openlink-update.vbs");
        var command = $@"powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{scriptPath}"" -ProcessId {Environment.ProcessId} -InstallerPath ""{installerPath}"" -InstallerArguments ""{installerArguments}"" -WorkingDirectory ""{updatesDir}"" -InstalledAppPath ""{installedAppPath}""";
        var launcher = "Set shell = CreateObject(\"WScript.Shell\")" + Environment.NewLine
            + $"shell.Run \"{command.Replace("\"", "\"\"")}\", 0, False" + Environment.NewLine;
        File.WriteAllText(launcherPath, launcher);

        Process.Start(new ProcessStartInfo("wscript.exe")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            WorkingDirectory = updatesDir,
            ArgumentList = { launcherPath }
        });
    }

    private static string GetUpdateInstallerPath(string updatesDir, string fileName, string version)
    {
        var extension = Path.GetExtension(fileName);
        if (string.IsNullOrWhiteSpace(extension))
        {
            extension = ".exe";
        }

        var baseName = Path.GetFileNameWithoutExtension(fileName);
        if (string.IsNullOrWhiteSpace(baseName))
        {
            baseName = "OpenLink-Setup";
        }

        var safeVersion = Regex.Replace(version, @"[^0-9A-Za-z._-]+", "-");
        return Path.Combine(updatesDir, $"{baseName}-{safeVersion}{extension}");
    }

    private static void VerifyChecksumIfProvided(string filePath, UpdateManifest manifest)
    {
        var expected = manifest.ResolvedSha256;
        if (string.IsNullOrWhiteSpace(expected))
        {
            return;
        }

        var normalizedExpected = NormalizeSha256(expected);
        if (normalizedExpected.Length != 64)
        {
            throw new InvalidOperationException("OpenLink update manifest has an invalid SHA256 value.");
        }

        using var stream = File.OpenRead(filePath);
        var actual = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
        if (!string.Equals(actual, normalizedExpected, StringComparison.OrdinalIgnoreCase))
        {
            try
            {
                File.Delete(filePath);
            }
            catch
            {
                // Best effort cleanup; the failed checksum prevents installation either way.
            }

            throw new InvalidOperationException("OpenLink update download failed checksum verification.");
        }
    }

    private static string NormalizeSha256(string value)
    {
        return Regex.Replace(value.Trim(), @"[^0-9A-Fa-f]", "").ToLowerInvariant();
    }

    private static void WritePendingUpdate(string version, string releaseNotes)
    {
        try
        {
            Directory.CreateDirectory(OpenLinkSettingsStore.SettingsDirectory);
            File.WriteAllText(Path.Combine(OpenLinkSettingsStore.SettingsDirectory, "pending-update-success.txt"), version);
            File.WriteAllText(Path.Combine(OpenLinkSettingsStore.SettingsDirectory, "last-whats-new-version.txt"), version);
            File.WriteAllText(Path.Combine(OpenLinkSettingsStore.SettingsDirectory, "last-whats-new-notes.txt"), releaseNotes);
        }
        catch
        {
            // The update can still install; this only controls the post-relaunch success message.
        }
    }

    private static string GetCurrentVersion()
    {
        return Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "0.0.0";
    }

    private static bool IsNewerVersion(string candidate, string current)
    {
        if (!Version.TryParse(candidate, out var candidateVersion))
        {
            return string.Compare(candidate, current, StringComparison.OrdinalIgnoreCase) > 0;
        }

        return !Version.TryParse(current, out var currentVersion)
            ? true
            : candidateVersion > currentVersion;
    }

    private sealed class UpdateManifest
    {
        [JsonPropertyName("version")]
        public string Version { get; set; } = "";

        [JsonPropertyName("download_url")]
        public string DownloadUrl { get; set; } = "";

        [JsonPropertyName("file_name")]
        public string FileName { get; set; } = "";

        [JsonPropertyName("release_notes")]
        public string ReleaseNotes { get; set; } = "";

        [JsonPropertyName("sha256")]
        public string Sha256 { get; set; } = "";

        [JsonPropertyName("notes")]
        public string Notes { get; set; } = "";

        [JsonPropertyName("platforms")]
        public Dictionary<string, UpdatePlatformManifest> Platforms { get; set; } = [];

        [JsonIgnore]
        public string ResolvedDownloadUrl =>
            !string.IsNullOrWhiteSpace(DownloadUrl)
                ? DownloadUrl
                : Platforms.TryGetValue("windows-x64", out var windows)
                    ? windows.ResolvedDownloadUrl
                    : "";

        [JsonIgnore]
        public string ResolvedReleaseNotes =>
            !string.IsNullOrWhiteSpace(ReleaseNotes) ? ReleaseNotes : Notes;

        [JsonIgnore]
        public string ResolvedSha256 =>
            !string.IsNullOrWhiteSpace(Sha256)
                ? Sha256
                : Platforms.TryGetValue("windows-x64", out var windows)
                    ? windows.Sha256
                    : "";
    }

    private sealed class UpdatePlatformManifest
    {
        [JsonPropertyName("installer_url")]
        public string InstallerUrl { get; set; } = "";

        [JsonPropertyName("url")]
        public string Url { get; set; } = "";

        [JsonPropertyName("sha256")]
        public string Sha256 { get; set; } = "";

        [JsonIgnore]
        public string ResolvedDownloadUrl =>
            !string.IsNullOrWhiteSpace(InstallerUrl) ? InstallerUrl : Url;
    }
}
