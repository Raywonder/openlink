using System.IO;
using System.Text.Json;

namespace OpenLink.Windows;

public sealed class OpenLinkSettings
{
    public const string CloudUpdateManifestUrl = "https://devinecreations.net/openlink-downloads/update.json";
    public const string TappedInUpdateManifestUrl = "https://files.tappedin.fm/Public/openlink/update.json";

    public string DefaultServerUrl { get; set; } = EndpointNormalizer.CanonicalWebSocketUrl;
    public bool CustomSignalingServerAccessEnabled { get; set; }
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
    public bool AllowKeyboardCoUse { get; set; }
    public bool CtrlAltDeleteGuardEnabled { get; set; } = true;
    public int CtrlAltDeleteRemotePressCount { get; set; } = 2;
    public int CtrlAltDeleteLocalLockPressCount { get; set; } = 3;
    public string CtrlAltDeleteUnlockAction { get; set; } = "return-to-remote";
    public bool AllowMicrophoneAudio { get; set; } = true;
    public bool AllowSystemAudio { get; set; } = true;
    public int RemoteAudioVolumePercent { get; set; } = 30;
    public int LocalAudioCaptureVolumePercent { get; set; } = 100;
    public int DirectAudioBufferSamples { get; set; } = 1024;
    public int WindowsAudioBufferSamples { get; set; } = 1024;
    public string AudioStreamingCodec { get; set; } = "pcm_s16le";
    public bool EnableAsioAudioDriver { get; set; }
    public string AsioDriverName { get; set; } = "";
    public int AsioLatencyMilliseconds { get; set; } = 20;
    public bool AutoMuteControlledComputerAudio { get; set; }
    public bool MuteRemoteAudioWhenInactive { get; set; } = true;
    public string AutoMuteProcessesOnConnect { get; set; } = "VoiceOver, Music";
    public bool UseVoiceLinkAudioFallback { get; set; } = true;
    public string VoiceLinkAudioFallbackUrl { get; set; } = "wss://voicelink.tappedin.fm/openlink/audio";
    public bool AutoConnectTrustedMachines { get; set; } = true;
    public bool AllowRemoteApplicationLaunch { get; set; } = true;
    public bool AllowRemoteSettingsManagement { get; set; } = true;
    public bool AllowTrustedOwnerRemoteSettingsChanges { get; set; } = true;
    public bool RequireApprovalForGuestRemoteSettingsChanges { get; set; } = true;
    public bool LockLocalSettingsDuringRemoteOwnerSession { get; set; }
    public bool RequireApprovalForNewDevices { get; set; } = true;
    public bool TamperProtectionEnabled { get; set; }

    public bool AnnounceStatusChanges { get; set; } = true;
    public bool ShowActivityLog { get; set; }
    public bool DetailedScreenReaderMessages { get; set; } = true;
    public bool SoundAlerts { get; set; } = true;
    public bool ReduceMotion { get; set; }
    public bool EnableDiagnosticSending { get; set; } = true;
    public bool EnableLocalTtsHelper { get; set; }
    public string LocalTtsVoiceId { get; set; } = "";
    public double LocalTtsRate { get; set; } = 1.0;
    public int LocalTtsVolumePercent { get; set; } = 100;
    public string TtsFallbackMode { get; set; } = "screen-reader";
    public int LocalTtsPort { get; set; } = OpenLinkTtsService.DefaultPort;
    public bool EnableBrailleDisplaySupport { get; set; }
    public bool RouteBrailleToRemoteWhenConnected { get; set; } = true;
    public string BrailleProvider { get; set; } = "auto";
    public string BrlttyExecutablePath { get; set; } = "";

    public bool CheckForUpdatesAutomatically { get; set; } = true;
    public bool DownloadUpdatesAutomatically { get; set; } = true;
    public string UpdateChannel { get; set; } = "Stable";

    public string UpdateManifestUrl { get; set; } = CloudUpdateManifestUrl;
    public bool LocalServerEnabled { get; set; }
    public string LocalServerPort { get; set; } = "8765";

    public OpenLinkSettings Clone()
    {
        return new OpenLinkSettings
        {
            DefaultServerUrl = DefaultServerUrl,
            CustomSignalingServerAccessEnabled = CustomSignalingServerAccessEnabled,
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
            CtrlAltDeleteGuardEnabled = CtrlAltDeleteGuardEnabled,
            CtrlAltDeleteRemotePressCount = CtrlAltDeleteRemotePressCount,
            CtrlAltDeleteLocalLockPressCount = CtrlAltDeleteLocalLockPressCount,
            CtrlAltDeleteUnlockAction = CtrlAltDeleteUnlockAction,
            AllowMicrophoneAudio = AllowMicrophoneAudio,
            AllowSystemAudio = AllowSystemAudio,
            RemoteAudioVolumePercent = RemoteAudioVolumePercent,
            LocalAudioCaptureVolumePercent = LocalAudioCaptureVolumePercent,
            DirectAudioBufferSamples = DirectAudioBufferSamples,
            WindowsAudioBufferSamples = WindowsAudioBufferSamples,
            AudioStreamingCodec = AudioStreamingCodec,
            EnableAsioAudioDriver = EnableAsioAudioDriver,
            AsioDriverName = AsioDriverName,
            AsioLatencyMilliseconds = AsioLatencyMilliseconds,
            AutoMuteControlledComputerAudio = AutoMuteControlledComputerAudio,
            MuteRemoteAudioWhenInactive = MuteRemoteAudioWhenInactive,
            AutoMuteProcessesOnConnect = AutoMuteProcessesOnConnect,
            UseVoiceLinkAudioFallback = UseVoiceLinkAudioFallback,
            VoiceLinkAudioFallbackUrl = VoiceLinkAudioFallbackUrl,
            AutoConnectTrustedMachines = AutoConnectTrustedMachines,
            AllowRemoteApplicationLaunch = AllowRemoteApplicationLaunch,
            AllowRemoteSettingsManagement = AllowRemoteSettingsManagement,
            AllowTrustedOwnerRemoteSettingsChanges = AllowTrustedOwnerRemoteSettingsChanges,
            RequireApprovalForGuestRemoteSettingsChanges = RequireApprovalForGuestRemoteSettingsChanges,
            LockLocalSettingsDuringRemoteOwnerSession = LockLocalSettingsDuringRemoteOwnerSession,
            RequireApprovalForNewDevices = RequireApprovalForNewDevices,
            TamperProtectionEnabled = TamperProtectionEnabled,
            AnnounceStatusChanges = AnnounceStatusChanges,
            ShowActivityLog = ShowActivityLog,
            DetailedScreenReaderMessages = DetailedScreenReaderMessages,
            SoundAlerts = SoundAlerts,
            ReduceMotion = ReduceMotion,
            EnableDiagnosticSending = EnableDiagnosticSending,
            EnableLocalTtsHelper = EnableLocalTtsHelper,
            LocalTtsVoiceId = LocalTtsVoiceId,
            LocalTtsRate = LocalTtsRate,
            LocalTtsVolumePercent = LocalTtsVolumePercent,
            TtsFallbackMode = TtsFallbackMode,
            LocalTtsPort = LocalTtsPort,
            EnableBrailleDisplaySupport = EnableBrailleDisplaySupport,
            RouteBrailleToRemoteWhenConnected = RouteBrailleToRemoteWhenConnected,
            BrailleProvider = BrailleProvider,
            BrlttyExecutablePath = BrlttyExecutablePath,
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
                settings.UpdateManifestUrl.Contains("files.tappedin.fm/Public/openlink/update.json", StringComparison.OrdinalIgnoreCase) ||
                settings.UpdateManifestUrl.Contains("openlink.devinecreations.net/downloads", StringComparison.OrdinalIgnoreCase))
            {
                settings.UpdateManifestUrl = new OpenLinkSettings().UpdateManifestUrl;
            }

            settings.DefaultServerUrl = EndpointNormalizer.NormalizeWebSocketUrl(
                settings.DefaultServerUrl,
                settings.CustomSignalingServerAccessEnabled);
            if (!settings.CustomSignalingServerAccessEnabled &&
                !EndpointNormalizer.IsApprovedDefaultWebSocketUrl(settings.DefaultServerUrl))
            {
                settings.DefaultServerUrl = new OpenLinkSettings().DefaultServerUrl;
            }

            if (string.IsNullOrWhiteSpace(settings.VoiceLinkAudioFallbackUrl))
            {
                settings.VoiceLinkAudioFallbackUrl = new OpenLinkSettings().VoiceLinkAudioFallbackUrl;
            }

            settings.RemoteAudioVolumePercent = Math.Clamp(settings.RemoteAudioVolumePercent <= 0 ? 30 : settings.RemoteAudioVolumePercent, 0, 30);
            settings.LocalAudioCaptureVolumePercent = Math.Clamp(settings.LocalAudioCaptureVolumePercent, 0, 150);
            settings.DirectAudioBufferSamples = OpenLinkAudioSettings.ClampBufferSamples(settings.DirectAudioBufferSamples);
            settings.WindowsAudioBufferSamples = OpenLinkAudioSettings.ClampBufferSamples(settings.WindowsAudioBufferSamples);
            if (settings.DirectAudioBufferSamples < 1024 && settings.WindowsAudioBufferSamples < 1024)
            {
                settings.DirectAudioBufferSamples = 1024;
                settings.WindowsAudioBufferSamples = 1024;
            }
            settings.AudioStreamingCodec = OpenLinkAudioSettings.NormalizeCodec(settings.AudioStreamingCodec);
            settings.CtrlAltDeleteRemotePressCount = Math.Clamp(settings.CtrlAltDeleteRemotePressCount <= 0 ? 2 : settings.CtrlAltDeleteRemotePressCount, 1, 5);
            settings.CtrlAltDeleteLocalLockPressCount = Math.Clamp(settings.CtrlAltDeleteLocalLockPressCount <= 0 ? 3 : settings.CtrlAltDeleteLocalLockPressCount, 1, 5);
            if (string.IsNullOrWhiteSpace(settings.CtrlAltDeleteUnlockAction))
            {
                settings.CtrlAltDeleteUnlockAction = "return-to-remote";
            }
            settings.AsioLatencyMilliseconds = Math.Clamp(settings.AsioLatencyMilliseconds <= 0 ? 20 : settings.AsioLatencyMilliseconds, 5, 200);
            settings.LocalTtsRate = Math.Clamp(settings.LocalTtsRate <= 0 ? 1.0 : settings.LocalTtsRate, 0.5, 2.0);
            settings.LocalTtsVolumePercent = Math.Clamp(settings.LocalTtsVolumePercent, 0, 100);
            settings.LocalTtsPort = settings.LocalTtsPort is < 1 or > 65535 ? OpenLinkTtsService.DefaultPort : settings.LocalTtsPort;
            settings.TtsFallbackMode = string.IsNullOrWhiteSpace(settings.TtsFallbackMode) ? "screen-reader" : settings.TtsFallbackMode;
            settings.BrailleProvider = NormalizeBrailleProvider(settings.BrailleProvider);
            settings.BrlttyExecutablePath = settings.BrlttyExecutablePath?.Trim() ?? "";

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

    private static string NormalizeBrailleProvider(string? provider)
    {
        return provider?.Trim().ToLowerInvariant() switch
        {
            "nvda" => "nvda",
            "brltty" => "brltty",
            _ => "auto"
        };
    }
}

public static class OpenLinkAudioSettings
{
    public static readonly int[] BufferSampleChoices = [16, 32, 64, 128, 256, 512, 1024, 2048];
    public static readonly string[] SupportedTransportCodecs = ["pcm_s16le", "pcm_s32le", "wav_pcm_s16le", "wav_pcm_s32le"];
    public static readonly string[] KnownCodecChoices = ["pcm_s16le", "pcm_s32le", "wav_pcm_s16le", "wav_pcm_s32le", "flac", "ogg_opus", "mp3"];
    public static readonly int[] SupportedWaveSampleRates = [44100, 48000];

    public static int ClampBufferSamples(int samples)
    {
        if (samples <= 0)
        {
            return 512;
        }

        return Math.Clamp(samples, BufferSampleChoices[0], BufferSampleChoices[^1]);
    }

    public static string NormalizeCodec(string? codec)
    {
        if (string.IsNullOrWhiteSpace(codec))
        {
            return "pcm_s16le";
        }

        var normalized = codec.Trim().ToLowerInvariant();
        return KnownCodecChoices.Contains(normalized, StringComparer.OrdinalIgnoreCase)
            ? normalized
            : "pcm_s16le";
    }

    public static bool IsCodecAvailable(string? codec)
    {
        return SupportedTransportCodecs.Contains(NormalizeCodec(codec), StringComparer.OrdinalIgnoreCase);
    }

    public static bool RequiresExternalEncoder(string? codec)
    {
        return NormalizeCodec(codec) is "flac" or "ogg_opus" or "mp3";
    }

    public static int BitsPerSampleForCodec(string? codec)
    {
        return NormalizeCodec(codec) is "pcm_s32le" or "wav_pcm_s32le" ? 32 : 16;
    }

    public static bool IsWavCodec(string? codec)
    {
        return NormalizeCodec(codec).StartsWith("wav_", StringComparison.OrdinalIgnoreCase);
    }
}
