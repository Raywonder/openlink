using System.Windows;
using System.Windows.Controls;

namespace OpenLink.Windows;

public partial class SettingsWindow : Window
{
    public OpenLinkSettings Settings { get; }

    public SettingsWindow(OpenLinkSettings settings)
    {
        InitializeComponent();
        Settings = settings.Clone();
        LoadTtsVoices();
        LoadAsioDrivers();
        LoadAudioBufferChoices();
        ConfigureDefaultServerChoices();
        LoadSettings();
    }

    private void LoadSettings()
    {
        DefaultServerBox.Text = EndpointNormalizer.ToPublicServerUrl(
            EndpointNormalizer.NormalizeWebSocketUrl(
                Settings.DefaultServerUrl,
                Settings.CustomSignalingServerAccessEnabled));
        SessionPrefixBox.Text = Settings.SessionPrefix;
        StartHostingOnLaunchBox.IsChecked = Settings.StartHostingOnLaunch;
        CopyLinkWhenHostingStartsBox.IsChecked = Settings.CopyLinkWhenHostingStarts;
        MinimizeToTrayOnCloseBox.IsChecked = Settings.MinimizeToTrayOnClose;
        LaunchAtLoginBox.IsChecked = Settings.LaunchAtLogin;
        StartMinimizedToTrayOnLaunchBox.IsChecked = Settings.StartMinimizedToTrayOnLaunch;
        AutoReconnectOnLaunchBox.IsChecked = Settings.AutoReconnectOnLaunch;
        AutoStartInteractionOnConnectBox.IsChecked = Settings.AutoStartInteractionOnConnect;

        AllowRemoteControlBox.IsChecked = Settings.AllowRemoteControl;
        AllowClipboardSyncBox.IsChecked = Settings.AllowClipboardSync;
        AllowFileTransferBox.IsChecked = Settings.AllowFileTransfer;
        AllowAudioBox.IsChecked = Settings.AllowAudio;
        AllowDropInAccessBox.IsChecked = Settings.AllowDropInAccess;
        AllowSwapControlBox.IsChecked = Settings.AllowSwapControl;
        AllowKeyboardCoUseBox.IsChecked = Settings.AllowKeyboardCoUse;
        CtrlAltDeleteGuardEnabledBox.IsChecked = Settings.CtrlAltDeleteGuardEnabled;
        SelectComboItem(CtrlAltDeleteRemotePressCountBox, Settings.CtrlAltDeleteRemotePressCount.ToString());
        SelectComboItem(CtrlAltDeleteLocalLockPressCountBox, Settings.CtrlAltDeleteLocalLockPressCount.ToString());
        SelectComboItem(CtrlAltDeleteUnlockActionBox, Settings.CtrlAltDeleteUnlockAction);
        AllowMicrophoneAudioBox.IsChecked = Settings.AllowMicrophoneAudio;
        AllowSystemAudioBox.IsChecked = Settings.AllowSystemAudio;
        RemoteAudioVolumeSlider.Value = Settings.RemoteAudioVolumePercent;
        LocalAudioCaptureVolumeSlider.Value = Settings.LocalAudioCaptureVolumePercent;
        SelectComboItem(DirectAudioBufferBox, Settings.DirectAudioBufferSamples.ToString());
        SelectComboItem(WindowsAudioBufferBox, Settings.WindowsAudioBufferSamples.ToString());
        SelectComboItem(AudioStreamingCodecBox, Settings.AudioStreamingCodec);
        EnableAsioAudioDriverBox.IsChecked = Settings.EnableAsioAudioDriver;
        SelectComboItem(AsioDriverBox, Settings.AsioDriverName);
        AsioLatencySlider.Value = Settings.AsioLatencyMilliseconds;
        AutoMuteControlledComputerAudioBox.IsChecked = Settings.AutoMuteControlledComputerAudio;
        MuteRemoteAudioWhenInactiveBox.IsChecked = Settings.MuteRemoteAudioWhenInactive;
        AutoMuteProcessesOnConnectBox.Text = Settings.AutoMuteProcessesOnConnect;
        UseVoiceLinkAudioFallbackBox.IsChecked = Settings.UseVoiceLinkAudioFallback;
        AutoConnectTrustedMachinesBox.IsChecked = Settings.AutoConnectTrustedMachines;
        AllowRemoteApplicationLaunchBox.IsChecked = Settings.AllowRemoteApplicationLaunch;
        AllowRemoteSettingsManagementBox.IsChecked = Settings.AllowRemoteSettingsManagement;
        AllowTrustedOwnerRemoteSettingsChangesBox.IsChecked = Settings.AllowTrustedOwnerRemoteSettingsChanges;
        RequireApprovalForGuestRemoteSettingsChangesBox.IsChecked = Settings.RequireApprovalForGuestRemoteSettingsChanges;
        LockLocalSettingsDuringRemoteOwnerSessionBox.IsChecked = Settings.LockLocalSettingsDuringRemoteOwnerSession;
        RequireApprovalForNewDevicesBox.IsChecked = Settings.RequireApprovalForNewDevices;
        TamperProtectionEnabledBox.IsChecked = Settings.TamperProtectionEnabled;

        AnnounceStatusChangesBox.IsChecked = Settings.AnnounceStatusChanges;
        ShowActivityLogBox.IsChecked = Settings.ShowActivityLog;
        DetailedScreenReaderMessagesBox.IsChecked = Settings.DetailedScreenReaderMessages;
        SoundAlertsBox.IsChecked = Settings.SoundAlerts;
        ReduceMotionBox.IsChecked = Settings.ReduceMotion;
        EnableDiagnosticSendingBox.IsChecked = Settings.EnableDiagnosticSending;
        ShowOnlineOfflineNotificationsBox.IsChecked = Settings.ShowOnlineOfflineNotifications;
        ShowConnectionNotificationsBox.IsChecked = Settings.ShowConnectionNotifications;
        ShowElapsedConnectionTimeBox.IsChecked = Settings.ShowElapsedConnectionTime;
        AnnounceConnectionStrengthBox.IsChecked = Settings.AnnounceConnectionStrength;
        EnableLocalTtsHelperBox.IsChecked = Settings.EnableLocalTtsHelper;
        EnableBrailleDisplaySupportBox.IsChecked = Settings.EnableBrailleDisplaySupport;
        RouteBrailleToRemoteWhenConnectedBox.IsChecked = Settings.RouteBrailleToRemoteWhenConnected;
        SelectComboItem(BrailleProviderBox, Settings.BrailleProvider);
        BrlttyExecutablePathBox.Text = Settings.BrlttyExecutablePath;
        SelectTtsVoice(Settings.LocalTtsVoiceId);
        LocalTtsRateSlider.Value = Settings.LocalTtsRate;
        LocalTtsVolumeSlider.Value = Settings.LocalTtsVolumePercent;
        SelectComboItem(TtsFallbackModeBox, Settings.TtsFallbackMode);

        CheckForUpdatesAutomaticallyBox.IsChecked = Settings.CheckForUpdatesAutomatically;
        DownloadUpdatesAutomaticallyBox.IsChecked = Settings.DownloadUpdatesAutomatically;
        SelectComboItem(UpdateChannelBox, Settings.UpdateChannel);

        UpdateManifestBox.Text = Settings.UpdateManifestUrl;
        LocalServerPortBox.Text = Settings.LocalServerPort;
        LocalServerEnabledBox.IsChecked = Settings.LocalServerEnabled;
        VoiceLinkAudioFallbackBox.Text = Settings.VoiceLinkAudioFallbackUrl;
    }

    private void SaveButton_Click(object sender, RoutedEventArgs e)
    {
        if (!TryValidate())
        {
            return;
        }

        Settings.DefaultServerUrl = EndpointNormalizer.NormalizeWebSocketUrl(
            DefaultServerBox.Text.Trim(),
            Settings.CustomSignalingServerAccessEnabled);
        Settings.SessionPrefix = SessionPrefixBox.Text.Trim();
        Settings.StartHostingOnLaunch = StartHostingOnLaunchBox.IsChecked == true;
        Settings.CopyLinkWhenHostingStarts = CopyLinkWhenHostingStartsBox.IsChecked == true;
        Settings.MinimizeToTrayOnClose = MinimizeToTrayOnCloseBox.IsChecked == true;
        Settings.LaunchAtLogin = LaunchAtLoginBox.IsChecked == true;
        Settings.StartMinimizedToTrayOnLaunch = StartMinimizedToTrayOnLaunchBox.IsChecked == true;
        Settings.AutoReconnectOnLaunch = AutoReconnectOnLaunchBox.IsChecked == true;
        Settings.AutoStartInteractionOnConnect = AutoStartInteractionOnConnectBox.IsChecked == true;

        Settings.AllowRemoteControl = AllowRemoteControlBox.IsChecked == true;
        Settings.AllowClipboardSync = AllowClipboardSyncBox.IsChecked == true;
        Settings.AllowFileTransfer = AllowFileTransferBox.IsChecked == true;
        Settings.AllowAudio = AllowAudioBox.IsChecked == true;
        Settings.AllowDropInAccess = AllowDropInAccessBox.IsChecked == true;
        Settings.AllowSwapControl = AllowSwapControlBox.IsChecked == true;
        Settings.AllowKeyboardCoUse = AllowKeyboardCoUseBox.IsChecked == true;
        Settings.CtrlAltDeleteGuardEnabled = CtrlAltDeleteGuardEnabledBox.IsChecked == true;
        Settings.CtrlAltDeleteRemotePressCount = GetComboInt(CtrlAltDeleteRemotePressCountBox, 2);
        Settings.CtrlAltDeleteLocalLockPressCount = GetComboInt(CtrlAltDeleteLocalLockPressCountBox, 3);
        Settings.CtrlAltDeleteUnlockAction = GetComboText(CtrlAltDeleteUnlockActionBox, "return-to-remote");
        Settings.AllowMicrophoneAudio = AllowMicrophoneAudioBox.IsChecked == true;
        Settings.AllowSystemAudio = AllowSystemAudioBox.IsChecked == true;
        Settings.RemoteAudioVolumePercent = (int)RemoteAudioVolumeSlider.Value;
        Settings.LocalAudioCaptureVolumePercent = (int)LocalAudioCaptureVolumeSlider.Value;
        Settings.DirectAudioBufferSamples = OpenLinkAudioSettings.ClampBufferSamples(GetComboInt(DirectAudioBufferBox, 512));
        Settings.WindowsAudioBufferSamples = OpenLinkAudioSettings.ClampBufferSamples(GetComboInt(WindowsAudioBufferBox, 512));
        Settings.AudioStreamingCodec = OpenLinkAudioSettings.NormalizeCodec(GetComboText(AudioStreamingCodecBox, "pcm_s16le"));
        Settings.EnableAsioAudioDriver = EnableAsioAudioDriverBox.IsChecked == true;
        Settings.AsioDriverName = GetComboText(AsioDriverBox, "");
        Settings.AsioLatencyMilliseconds = (int)AsioLatencySlider.Value;
        Settings.AutoMuteControlledComputerAudio = AutoMuteControlledComputerAudioBox.IsChecked == true;
        Settings.MuteRemoteAudioWhenInactive = MuteRemoteAudioWhenInactiveBox.IsChecked == true;
        Settings.AutoMuteProcessesOnConnect = AutoMuteProcessesOnConnectBox.Text.Trim();
        Settings.UseVoiceLinkAudioFallback = UseVoiceLinkAudioFallbackBox.IsChecked == true;
        Settings.AutoConnectTrustedMachines = AutoConnectTrustedMachinesBox.IsChecked == true;
        Settings.AllowRemoteApplicationLaunch = AllowRemoteApplicationLaunchBox.IsChecked == true;
        Settings.AllowRemoteSettingsManagement = AllowRemoteSettingsManagementBox.IsChecked == true;
        Settings.AllowTrustedOwnerRemoteSettingsChanges = AllowTrustedOwnerRemoteSettingsChangesBox.IsChecked == true;
        Settings.RequireApprovalForGuestRemoteSettingsChanges = RequireApprovalForGuestRemoteSettingsChangesBox.IsChecked == true;
        Settings.LockLocalSettingsDuringRemoteOwnerSession = LockLocalSettingsDuringRemoteOwnerSessionBox.IsChecked == true;
        Settings.RequireApprovalForNewDevices = RequireApprovalForNewDevicesBox.IsChecked == true;
        Settings.TamperProtectionEnabled = TamperProtectionEnabledBox.IsChecked == true;

        Settings.AnnounceStatusChanges = AnnounceStatusChangesBox.IsChecked == true;
        Settings.ShowActivityLog = ShowActivityLogBox.IsChecked == true;
        Settings.DetailedScreenReaderMessages = DetailedScreenReaderMessagesBox.IsChecked == true;
        Settings.SoundAlerts = SoundAlertsBox.IsChecked == true;
        Settings.ReduceMotion = ReduceMotionBox.IsChecked == true;
        Settings.EnableDiagnosticSending = EnableDiagnosticSendingBox.IsChecked == true;
        Settings.ShowOnlineOfflineNotifications = ShowOnlineOfflineNotificationsBox.IsChecked == true;
        Settings.ShowConnectionNotifications = ShowConnectionNotificationsBox.IsChecked == true;
        Settings.ShowElapsedConnectionTime = ShowElapsedConnectionTimeBox.IsChecked == true;
        Settings.AnnounceConnectionStrength = AnnounceConnectionStrengthBox.IsChecked == true;
        Settings.EnableLocalTtsHelper = EnableLocalTtsHelperBox.IsChecked == true;
        Settings.LocalTtsVoiceId = GetSelectedTtsVoiceId();
        Settings.LocalTtsRate = LocalTtsRateSlider.Value;
        Settings.LocalTtsVolumePercent = (int)LocalTtsVolumeSlider.Value;
        Settings.TtsFallbackMode = GetComboText(TtsFallbackModeBox, "screen-reader");
        Settings.EnableBrailleDisplaySupport = EnableBrailleDisplaySupportBox.IsChecked == true;
        Settings.RouteBrailleToRemoteWhenConnected = RouteBrailleToRemoteWhenConnectedBox.IsChecked == true;
        Settings.BrailleProvider = GetComboText(BrailleProviderBox, "auto");
        Settings.BrlttyExecutablePath = BrlttyExecutablePathBox.Text.Trim();

        Settings.CheckForUpdatesAutomatically = CheckForUpdatesAutomaticallyBox.IsChecked == true;
        Settings.DownloadUpdatesAutomatically = DownloadUpdatesAutomaticallyBox.IsChecked == true;
        Settings.UpdateChannel = GetComboText(UpdateChannelBox, "Stable");

        Settings.UpdateManifestUrl = UpdateManifestBox.Text.Trim();
        Settings.LocalServerPort = LocalServerPortBox.Text.Trim();
        Settings.LocalServerEnabled = LocalServerEnabledBox.IsChecked == true;
        Settings.VoiceLinkAudioFallbackUrl = VoiceLinkAudioFallbackBox.Text.Trim();

        DialogResult = true;
    }

    private bool TryValidate()
    {
        var serverText = DefaultServerBox.Text.Trim();
        if (!Uri.TryCreate(serverText, UriKind.Absolute, out var serverUri) ||
            (serverUri.Scheme != "https" && serverUri.Scheme != "http" && serverUri.Scheme != "wss" && serverUri.Scheme != "ws"))
        {
            ShowValidationError("Default server must be an http or https URL. OpenLink will use the matching secure WebSocket internally.", DefaultServerBox);
            return false;
        }

        if (!Settings.CustomSignalingServerAccessEnabled &&
            !EndpointNormalizer.IsApprovedDefaultWebSocketUrl(serverText))
        {
            ShowValidationError("Default server must be one of the approved OpenLink servers for this client build.", DefaultServerBox);
            return false;
        }

        if (string.IsNullOrWhiteSpace(SessionPrefixBox.Text))
        {
            ShowValidationError("Session prefix cannot be blank.", SessionPrefixBox);
            return false;
        }

        if (!Uri.TryCreate(UpdateManifestBox.Text.Trim(), UriKind.Absolute, out var manifestUri) ||
            (manifestUri.Scheme != "https" && manifestUri.Scheme != "http"))
        {
            ShowValidationError("Update manifest must be an http or https URL.", UpdateManifestBox);
            return false;
        }

        if (!int.TryParse(LocalServerPortBox.Text.Trim(), out var port) || port < 1 || port > 65535)
        {
            ShowValidationError("Local server port must be between 1 and 65535.", LocalServerPortBox);
            return false;
        }

        if (!Uri.TryCreate(VoiceLinkAudioFallbackBox.Text.Trim(), UriKind.Absolute, out var fallbackUri) ||
            (fallbackUri.Scheme != "wss" && fallbackUri.Scheme != "ws"))
        {
            ShowValidationError("VoiceLink audio fallback must be a ws or wss URL.", VoiceLinkAudioFallbackBox);
            return false;
        }

        if (EnableAsioAudioDriverBox.IsChecked == true &&
            AsioDriverBox.Items.OfType<ComboBoxItem>().All(item => string.IsNullOrWhiteSpace(item.Content?.ToString())))
        {
            ShowValidationError("No ASIO or ASIO4ALL drivers were found. Install a driver first, or leave ASIO disabled.", AsioDriverBox);
            return false;
        }

        return true;
    }

    private void ConfigureDefaultServerChoices()
    {
        DefaultServerBox.Items.Clear();
        foreach (var url in EndpointNormalizer.ApprovedPublicUrls)
        {
            DefaultServerBox.Items.Add(new ComboBoxItem { Content = url });
        }

        DefaultServerBox.IsEditable = Settings.CustomSignalingServerAccessEnabled;
        if (Settings.CustomSignalingServerAccessEnabled &&
            !EndpointNormalizer.IsApprovedDefaultWebSocketUrl(Settings.DefaultServerUrl))
        {
            DefaultServerBox.Items.Add(new ComboBoxItem { Content = EndpointNormalizer.ToPublicServerUrl(Settings.DefaultServerUrl) });
        }
    }

    private void ShowValidationError(string message, System.Windows.Controls.Control control)
    {
        System.Windows.MessageBox.Show(this, message, "Settings", MessageBoxButton.OK, MessageBoxImage.Warning);
        control.Focus();
    }

    private void LoadTtsVoices()
    {
        LocalTtsVoiceBox.Items.Clear();
        LocalTtsVoiceBox.Items.Add(new ComboBoxItem { Content = "System default", Tag = "" });

        foreach (var voice in OpenLinkTtsService.GetInstalledVoices())
        {
            LocalTtsVoiceBox.Items.Add(new ComboBoxItem
            {
                Content = $"{voice.Name} ({voice.Locale})",
                Tag = voice.Id
            });
        }
    }

    private void SelectTtsVoice(string voiceId)
    {
        foreach (var item in LocalTtsVoiceBox.Items.OfType<ComboBoxItem>())
        {
            if (string.Equals(item.Tag?.ToString() ?? "", voiceId, StringComparison.OrdinalIgnoreCase))
            {
                LocalTtsVoiceBox.SelectedItem = item;
                return;
            }
        }

        LocalTtsVoiceBox.SelectedIndex = 0;
    }

    private void LoadAsioDrivers()
    {
        AsioDriverBox.Items.Clear();
        AsioDriverBox.Items.Add(new ComboBoxItem
        {
            Content = "System default audio driver",
            Tag = "",
            ToolTip = "Use normal Windows audio instead of ASIO."
        });
        foreach (var driverName in OpenLinkAudioBridge.GetAsioDriverNames())
        {
            AsioDriverBox.Items.Add(new ComboBoxItem
            {
                Content = driverName,
                Tag = driverName,
                ToolTip = driverName
            });
        }
    }

    private void LoadAudioBufferChoices()
    {
        DirectAudioBufferBox.Items.Clear();
        WindowsAudioBufferBox.Items.Clear();
        foreach (var samples in OpenLinkAudioSettings.BufferSampleChoices)
        {
            var label = $"{samples} samples";
            DirectAudioBufferBox.Items.Add(new ComboBoxItem { Content = label, Tag = samples.ToString() });
            WindowsAudioBufferBox.Items.Add(new ComboBoxItem { Content = label, Tag = samples.ToString() });
        }
    }

    private string GetSelectedTtsVoiceId()
    {
        return LocalTtsVoiceBox.SelectedItem is ComboBoxItem item
            ? item.Tag?.ToString() ?? ""
            : "";
    }

    private async void TestLocalTtsButton_Click(object sender, RoutedEventArgs e)
    {
        var preview = Settings.Clone();
        preview.EnableLocalTtsHelper = true;
        preview.LocalTtsVoiceId = GetSelectedTtsVoiceId();
        preview.LocalTtsRate = LocalTtsRateSlider.Value;
        preview.LocalTtsVolumePercent = (int)LocalTtsVolumeSlider.Value;
        using var service = new OpenLinkTtsService(preview);
        await service.TestAsync();
    }

    private async void TestBrailleButton_Click(object sender, RoutedEventArgs e)
    {
        var preview = Settings.Clone();
        preview.EnableBrailleDisplaySupport = true;
        preview.BrailleProvider = GetComboText(BrailleProviderBox, "auto");
        preview.BrlttyExecutablePath = BrlttyExecutablePathBox.Text.Trim();
        var service = new BrailleDisplayService(preview);
        var sent = await service.SendAsync("OpenLink braille display test.");
        if (!sent)
        {
            System.Windows.MessageBox.Show(
                this,
                "OpenLink could not send the braille test. Make sure NVDA is running with a braille display, or install and start BRLTTY and try again.",
                "Braille Display",
                MessageBoxButton.OK,
                MessageBoxImage.Information);
        }
    }

    private static void SelectComboItem(System.Windows.Controls.ComboBox comboBox, string value)
    {
        foreach (var item in comboBox.Items.OfType<ComboBoxItem>())
        {
            var itemValue = item.Tag?.ToString() ?? item.Content?.ToString();
            if (string.Equals(itemValue, value, StringComparison.OrdinalIgnoreCase))
            {
                comboBox.SelectedItem = item;
                return;
            }
        }

        comboBox.Text = value;
    }

    private static string GetComboText(System.Windows.Controls.ComboBox comboBox, string fallback)
    {
        return comboBox.SelectedItem is ComboBoxItem item
            ? item.Tag?.ToString() ?? item.Content?.ToString() ?? fallback
            : string.IsNullOrWhiteSpace(comboBox.Text) ? fallback : comboBox.Text.Trim();
    }

    private static int GetComboInt(System.Windows.Controls.ComboBox comboBox, int fallback)
    {
        return int.TryParse(GetComboText(comboBox, fallback.ToString()), out var value) ? value : fallback;
    }
}
