using System.IO;
using System.Text.Json;

namespace OpenLink.Windows;

public sealed class OpenLinkSettings
{
    public string DefaultServerUrl { get; set; } = "wss://openlink.raywonderis.me/ws";
    public string SessionPrefix { get; set; } = "win";
    public bool StartHostingOnLaunch { get; set; }
    public bool CopyLinkWhenHostingStarts { get; set; } = true;
    public bool MinimizeToTrayOnClose { get; set; } = true;
    public bool LaunchAtLogin { get; set; } = true;
    public bool StartMinimizedToTrayOnLaunch { get; set; } = true;
    public bool AutoReconnectOnLaunch { get; set; } = true;
    public bool AutoStartInteractionOnConnect { get; set; } = true;
    public bool ShowOnlineOfflineNotifications { get; set; } = true;
    public bool ShowConnectionNotifications { get; set; } = true;
    public bool ShowElapsedConnectionTime { get; set; } = true;
    public bool AnnounceConnectionStrength { get; set; } = true;

    public bool AllowRemoteControl { get; set; } = true;
    public bool AllowClipboardSync { get; set; } = true;
    public bool AllowFileTransfer { get; set; } = true;
    public bool AllowAudio { get; set; } = true;
    public bool AllowDropInAccess { get; set; }
    public bool AllowSwapControl { get; set; } = true;
    public bool AllowKeyboardCoUse { get; set; } = true;
    public bool AllowMicrophoneAudio { get; set; } = true;
    public bool AllowSystemAudio { get; set; } = true;
    public bool AutoMuteControlledComputerAudio { get; set; }
    public bool MuteRemoteAudioWhenInactive { get; set; } = true;
    public string AutoMuteProcessesOnConnect { get; set; } = "VoiceOver, Music";
    public bool UseVoiceLinkAudioFallback { get; set; } = true;
    public string VoiceLinkAudioFallbackUrl { get; set; } = "wss://voicelink.tappedin.fm/openlink/audio";
    public bool AutoConnectTrustedMachines { get; set; } = true;
    public bool AllowRemoteApplicationLaunch { get; set; } = true;
    public bool RequireApprovalForNewDevices { get; set; } = true;

    public bool AnnounceStatusChanges { get; set; } = true;
    public bool DetailedScreenReaderMessages { get; set; } = true;
    public bool SoundAlerts { get; set; } = true;
    public bool ReduceMotion { get; set; }

    public bool CheckForUpdatesAutomatically { get; set; } = true;
    public bool DownloadUpdatesAutomatically { get; set; } = true;
    public string UpdateChannel { get; set; } = "Stable";

    public string UpdateManifestUrl { get; set; } = "https://files.tappedin.fm/Public/openlink/update.json";
    public bool LocalServerEnabled { get; set; }
    public string LocalServerPort { get; set; } = "8765";

    public OpenLinkSettings Clone()
    {
        return new OpenLinkSettings
        {
            DefaultServerUrl = DefaultServerUrl,
            SessionPrefix = SessionPrefix,
            StartHostingOnLaunch = StartHostingOnLaunch,
            CopyLinkWhenHostingStarts = CopyLinkWhenHostingStarts,
            MinimizeToTrayOnClose = MinimizeToTrayOnClose,
            LaunchAtLogin = LaunchAtLogin,
            StartMinimizedToTrayOnLaunch = StartMinimizedToTrayOnLaunch,
            AutoReconnectOnLaunch = AutoReconnectOnLaunch,
            AutoStartInteractionOnConnect = AutoStartInteractionOnConnect,
            ShowOnlineOfflineNotifications = ShowOnlineOfflineNotifications,
            ShowConnectionNotifications = ShowConnectionNotifications,
            ShowElapsedConnectionTime = ShowElapsedConnectionTime,
            AnnounceConnectionStrength = AnnounceConnectionStrength,
            AllowRemoteControl = AllowRemoteControl,
            AllowClipboardSync = AllowClipboardSync,
            AllowFileTransfer = AllowFileTransfer,
            AllowAudio = AllowAudio,
            AllowDropInAccess = AllowDropInAccess,
            AllowSwapControl = AllowSwapControl,
            AllowKeyboardCoUse = AllowKeyboardCoUse,
            AllowMicrophoneAudio = AllowMicrophoneAudio,
            AllowSystemAudio = AllowSystemAudio,
            AutoMuteControlledComputerAudio = AutoMuteControlledComputerAudio,
            MuteRemoteAudioWhenInactive = MuteRemoteAudioWhenInactive,
            AutoMuteProcessesOnConnect = AutoMuteProcessesOnConnect,
            UseVoiceLinkAudioFallback = UseVoiceLinkAudioFallback,
            VoiceLinkAudioFallbackUrl = VoiceLinkAudioFallbackUrl,
            AutoConnectTrustedMachines = AutoConnectTrustedMachines,
            AllowRemoteApplicationLaunch = AllowRemoteApplicationLaunch,
            RequireApprovalForNewDevices = RequireApprovalForNewDevices,
            AnnounceStatusChanges = AnnounceStatusChanges,
            DetailedScreenReaderMessages = DetailedScreenReaderMessages,
            SoundAlerts = SoundAlerts,
            ReduceMotion = ReduceMotion,
            CheckForUpdatesAutomatically = CheckForUpdatesAutomatically,
            DownloadUpdatesAutomatically = DownloadUpdatesAutomatically,
            UpdateChannel = UpdateChannel,
            UpdateManifestUrl = UpdateManifestUrl,
            LocalServerEnabled = LocalServerEnabled,
            LocalServerPort = LocalServerPort
        };
    }
}

public static class OpenLinkSettingsStore
{
    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        WriteIndented = true
    };

    public static string SettingsDirectory { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        "OpenLink");

    public static string LegacySettingsDirectory { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "OpenLink");

    public static string SettingsPath { get; } = Path.Combine(SettingsDirectory, "settings.native.json");
    public static string LegacySettingsPath { get; } = Path.Combine(LegacySettingsDirectory, "settings.native.json");

    public static OpenLinkSettings Load()
    {
        try
        {
            var settingsPath = File.Exists(SettingsPath) ? SettingsPath : LegacySettingsPath;
            if (!File.Exists(settingsPath))
            {
                return new OpenLinkSettings();
            }

            var json = File.ReadAllText(settingsPath);
            var settings = JsonSerializer.Deserialize<OpenLinkSettings>(json, SerializerOptions) ?? new OpenLinkSettings();
            if (string.IsNullOrWhiteSpace(settings.UpdateManifestUrl) ||
                settings.UpdateManifestUrl.Contains("openlink.devinecreations.net/downloads", StringComparison.OrdinalIgnoreCase))
            {
                settings.UpdateManifestUrl = new OpenLinkSettings().UpdateManifestUrl;
            }

            if (string.IsNullOrWhiteSpace(settings.DefaultServerUrl) ||
                settings.DefaultServerUrl.Contains("openlink.devinecreations.net", StringComparison.OrdinalIgnoreCase))
            {
                settings.DefaultServerUrl = new OpenLinkSettings().DefaultServerUrl;
            }

            if (string.IsNullOrWhiteSpace(settings.VoiceLinkAudioFallbackUrl))
            {
                settings.VoiceLinkAudioFallbackUrl = new OpenLinkSettings().VoiceLinkAudioFallbackUrl;
            }

            return settings;
        }
        catch
        {
            return new OpenLinkSettings();
        }
    }

    public static void Save(OpenLinkSettings settings)
    {
        Directory.CreateDirectory(SettingsDirectory);
        var json = JsonSerializer.Serialize(settings, SerializerOptions);
        File.WriteAllText(SettingsPath, json);
    }
}
