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
        LoadSettings();
    }

    private void LoadSettings()
    {
        DefaultServerBox.Text = Settings.DefaultServerUrl;
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
        AllowMicrophoneAudioBox.IsChecked = Settings.AllowMicrophoneAudio;
        AllowSystemAudioBox.IsChecked = Settings.AllowSystemAudio;
        RemoteAudioVolumeSlider.Value = Settings.RemoteAudioVolumePercent;
        LocalAudioCaptureVolumeSlider.Value = Settings.LocalAudioCaptureVolumePercent;
        AutoMuteControlledComputerAudioBox.IsChecked = Settings.AutoMuteControlledComputerAudio;
        MuteRemoteAudioWhenInactiveBox.IsChecked = Settings.MuteRemoteAudioWhenInactive;
        AutoMuteProcessesOnConnectBox.Text = Settings.AutoMuteProcessesOnConnect;
        UseVoiceLinkAudioFallbackBox.IsChecked = Settings.UseVoiceLinkAudioFallback;
        AutoConnectTrustedMachinesBox.IsChecked = Settings.AutoConnectTrustedMachines;
        AllowRemoteApplicationLaunchBox.IsChecked = Settings.AllowRemoteApplicationLaunch;
        RequireApprovalForNewDevicesBox.IsChecked = Settings.RequireApprovalForNewDevices;

        AnnounceStatusChangesBox.IsChecked = Settings.AnnounceStatusChanges;
        DetailedScreenReaderMessagesBox.IsChecked = Settings.DetailedScreenReaderMessages;
        SoundAlertsBox.IsChecked = Settings.SoundAlerts;
        ReduceMotionBox.IsChecked = Settings.ReduceMotion;
        ShowOnlineOfflineNotificationsBox.IsChecked = Settings.ShowOnlineOfflineNotifications;
        ShowConnectionNotificationsBox.IsChecked = Settings.ShowConnectionNotifications;
        ShowElapsedConnectionTimeBox.IsChecked = Settings.ShowElapsedConnectionTime;
        AnnounceConnectionStrengthBox.IsChecked = Settings.AnnounceConnectionStrength;

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

        Settings.DefaultServerUrl = DefaultServerBox.Text.Trim();
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
        Settings.AllowMicrophoneAudio = AllowMicrophoneAudioBox.IsChecked == true;
        Settings.AllowSystemAudio = AllowSystemAudioBox.IsChecked == true;
        Settings.RemoteAudioVolumePercent = (int)RemoteAudioVolumeSlider.Value;
        Settings.LocalAudioCaptureVolumePercent = (int)LocalAudioCaptureVolumeSlider.Value;
        Settings.AutoMuteControlledComputerAudio = AutoMuteControlledComputerAudioBox.IsChecked == true;
        Settings.MuteRemoteAudioWhenInactive = MuteRemoteAudioWhenInactiveBox.IsChecked == true;
        Settings.AutoMuteProcessesOnConnect = AutoMuteProcessesOnConnectBox.Text.Trim();
        Settings.UseVoiceLinkAudioFallback = UseVoiceLinkAudioFallbackBox.IsChecked == true;
        Settings.AutoConnectTrustedMachines = AutoConnectTrustedMachinesBox.IsChecked == true;
        Settings.AllowRemoteApplicationLaunch = AllowRemoteApplicationLaunchBox.IsChecked == true;
        Settings.RequireApprovalForNewDevices = RequireApprovalForNewDevicesBox.IsChecked == true;

        Settings.AnnounceStatusChanges = AnnounceStatusChangesBox.IsChecked == true;
        Settings.DetailedScreenReaderMessages = DetailedScreenReaderMessagesBox.IsChecked == true;
        Settings.SoundAlerts = SoundAlertsBox.IsChecked == true;
        Settings.ReduceMotion = ReduceMotionBox.IsChecked == true;
        Settings.ShowOnlineOfflineNotifications = ShowOnlineOfflineNotificationsBox.IsChecked == true;
        Settings.ShowConnectionNotifications = ShowConnectionNotificationsBox.IsChecked == true;
        Settings.ShowElapsedConnectionTime = ShowElapsedConnectionTimeBox.IsChecked == true;
        Settings.AnnounceConnectionStrength = AnnounceConnectionStrengthBox.IsChecked == true;

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
        if (!Uri.TryCreate(DefaultServerBox.Text.Trim(), UriKind.Absolute, out var serverUri) ||
            (serverUri.Scheme != "wss" && serverUri.Scheme != "ws"))
        {
            ShowValidationError("Default server must be a ws or wss URL.", DefaultServerBox);
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

        return true;
    }

    private void ShowValidationError(string message, System.Windows.Controls.Control control)
    {
        System.Windows.MessageBox.Show(this, message, "Settings", MessageBoxButton.OK, MessageBoxImage.Warning);
        control.Focus();
    }

    private static void SelectComboItem(System.Windows.Controls.ComboBox comboBox, string value)
    {
        foreach (var item in comboBox.Items.OfType<ComboBoxItem>())
        {
            if (string.Equals(item.Content?.ToString(), value, StringComparison.OrdinalIgnoreCase))
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
            ? item.Content?.ToString() ?? fallback
            : string.IsNullOrWhiteSpace(comboBox.Text) ? fallback : comboBox.Text.Trim();
    }
}
