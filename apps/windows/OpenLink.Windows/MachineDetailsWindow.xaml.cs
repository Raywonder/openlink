using System.Collections.ObjectModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Input;

namespace OpenLink.Windows;

public partial class MachineDetailsWindow : Window
{
    private readonly MachineRecord _machine;
    private readonly OpenLinkSettings _settings;
    private readonly Func<string, RemoteApplicationRecord?, Task> _sendRemoteAction;
    private readonly ObservableCollection<RemoteApplicationRecord> _applications = [];
    private readonly ObservableCollection<DeviceDetailItem> _details = [];

    public MachineDetailsWindow(
        MachineRecord machine,
        OpenLinkSettings settings,
        Func<string, RemoteApplicationRecord?, Task> sendRemoteAction)
    {
        InitializeComponent();
        _machine = machine;
        _settings = settings;
        _sendRemoteAction = sendRemoteAction;
        ApplicationsListBox.ItemsSource = _applications;
        DetailsListBox.ItemsSource = _details;
        Title = IsLocalMachine() ? $"This device, {machine.DisplayName} details" : $"{machine.DisplayName} details";
        TitleText.Text = IsLocalMachine() ? $"This device, {machine.DisplayName}" : machine.DisplayName;
        SummaryText.Text = machine.AccessibleSummary;
        System.Windows.Automation.AutomationProperties.SetName(SummaryText, machine.AccessibleSummary);
        ApplyLocalDeviceMode();
        RefreshLists();
        Loaded += MachineDetailsWindow_Loaded;
    }

    private bool CanManageApps => _settings.AllowRemoteApplicationLaunch && _machine.IsTrusted;

    private RemoteApplicationRecord? SelectedApplication => ApplicationsListBox.SelectedItem as RemoteApplicationRecord;

    public void UpdateRemoteApplications(IEnumerable<RemoteApplicationRecord> applications)
    {
        _applications.Clear();
        foreach (var app in applications.Where(item => !item.IsStatusOnly))
        {
            _applications.Add(app);
        }

        var count = _applications.Count;
        SetApplicationsStatus(count == 0
            ? $"No running applications were returned by {_machine.DisplayName}."
            : $"{count} running applications returned by {_machine.DisplayName}.");
        FocusApplicationsList();
        UpdateSummaryText();
    }

    private void RefreshLists()
    {
        _applications.Clear();
        if (IsLocalMachine())
        {
            foreach (var app in RemoteApplicationRecord.GetLocalApplications())
            {
                _applications.Add(app);
            }
            System.Windows.Automation.AutomationProperties.SetName(ApplicationsListBox, "Local running applications");
            SetApplicationsStatus($"{_applications.Count} local running applications listed.");
        }
        else
        {
            System.Windows.Automation.AutomationProperties.SetName(ApplicationsListBox, $"{_machine.DisplayName} running applications");
            SetApplicationsStatus($"OpenLink is asking {_machine.DisplayName} for its running applications.");
        }

        _details.Clear();
        AddDetail("About", "Device name", _machine.DisplayName);
        AddDetail("About", "Device scope", IsLocalMachine() ? "This device" : "Remote device");
        AddDetail("About", "Machine id", _machine.Id);
        AddDetail("About", "Platform", _machine.Platform);
        AddDetail("About", "Host name", _machine.MachineHostname);
        AddDetail("Connection", "Online state", _machine.IsOnline ? "online" : "offline");
        AddDetail("Connection", "Trusted", _machine.IsTrusted ? "trusted" : "not trusted");
        AddDetail("Connection", "Drop-in", _machine.DropInText);
        AddDetail("Connection", "Auto-connect", _machine.AutoConnect ? "enabled" : "disabled");
        AddDetail("Connection", "Last connected", _machine.LastConnectedText);
        AddDetail("Connection", "Last duration", _machine.LastDurationText);
        AddDetail("Network", "Domain used", _machine.DomainUsed);
        AddDetail("Network", IsLocalMachine() ? "Local machine" : "Remote machine", _machine.MachineHostname);
        AddDetail("Permissions", "Remote control", _machine.AllowRemoteControl ? "allowed" : "blocked");
        AddDetail("Permissions", "Swap control", _machine.AllowSwapControl ? "allowed" : "blocked");
        AddDetail("Permissions", "Keyboard co-use", _machine.AllowKeyboardCoUse ? "allowed" : "blocked");
        AddDetail("Permissions", "Microphone audio", _machine.AllowMicrophoneAudio ? "allowed" : "muted");
        AddDetail("Permissions", "System audio", _machine.AllowSystemAudio ? "allowed" : "muted");
        AddDetail("Permissions", "Remote app management", CanManageApps ? "allowed for trusted machines" : "blocked in settings or not trusted");

        UpdateSummaryText();
    }

    private void UpdateSummaryText()
    {
        SummaryText.Text = IsLocalMachine()
            ? $"This device, {_machine.DisplayName}. {_applications.Count} local applications listed. Use the machine list context menu to choose what remote users can access. Escape closes this window."
            : $"{_machine.DisplayName}. {_applications.Count} remote applications listed. Escape closes this window.";
        System.Windows.Automation.AutomationProperties.SetName(SummaryText, SummaryText.Text);
    }

    private void SetApplicationsStatus(string message)
    {
        ApplicationsStatusText.Text = message;
        System.Windows.Automation.AutomationProperties.SetName(ApplicationsStatusText, message);
    }

    private async void MachineDetailsWindow_Loaded(object sender, RoutedEventArgs e)
    {
        FocusApplicationsList();
        if (!IsLocalMachine())
        {
            await _sendRemoteAction("list_applications", null);
        }
    }

    private void FocusApplicationsList()
    {
        if (_applications.Count > 0 && ApplicationsListBox.SelectedIndex < 0)
        {
            ApplicationsListBox.SelectedIndex = 0;
            ApplicationsListBox.ScrollIntoView(ApplicationsListBox.SelectedItem);
        }

        ApplicationsListBox.Focus();
        Keyboard.Focus(ApplicationsListBox);
    }

    private void AddDetail(string category, string name, string value)
    {
        _details.Add(new DeviceDetailItem { Category = category, Name = name, Value = value });
    }

    private void RefreshButton_Click(object sender, RoutedEventArgs e)
    {
        RefreshLists();
        if (!IsLocalMachine())
        {
            _ = _sendRemoteAction("list_applications", null);
        }
    }

    private void ApplicationsListBox_MouseDoubleClick(object sender, MouseButtonEventArgs e)
    {
        _ = RunApplicationActionAsync("focus_application", SelectedApplication);
    }

    private void FocusApplication_Click(object sender, RoutedEventArgs e) => _ = RunApplicationActionAsync("focus_application", SelectedApplication);
    private void QuitApplication_Click(object sender, RoutedEventArgs e) => _ = RunApplicationActionAsync("quit_application", SelectedApplication);
    private void ForceQuitApplication_Click(object sender, RoutedEventArgs e) => _ = RunApplicationActionAsync("force_quit_application", SelectedApplication);
    private void QuitAndReopenApplication_Click(object sender, RoutedEventArgs e) => _ = RunApplicationActionAsync("quit_reopen_application", SelectedApplication);
    private void RestartMachine_Click(object sender, RoutedEventArgs e) => _ = RunApplicationActionAsync("restart_machine", null);
    private void LockMachine_Click(object sender, RoutedEventArgs e) => _ = RunApplicationActionAsync("lock_machine", null);
    private void LogoutMachine_Click(object sender, RoutedEventArgs e) => _ = RunApplicationActionAsync("logout_machine", null);

    private async Task RunApplicationActionAsync(string action, RemoteApplicationRecord? app)
    {
        if (app?.IsStatusOnly == true)
        {
            return;
        }

        if (!CanManageApps)
        {
            System.Windows.MessageBox.Show(this, "Remote app management is only available for trusted machines when the setting is enabled.", "OpenLink", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        if (IsLocalMachine())
        {
            RunLocalAction(action, app);
            RefreshLists();
            return;
        }

        await _sendRemoteAction(action, app);
        RefreshLists();
    }

    private void ApplyLocalDeviceMode()
    {
        if (!IsLocalMachine())
        {
            return;
        }

        RestartMachineButton.Visibility = Visibility.Collapsed;
        LogoutMachineButton.Visibility = Visibility.Collapsed;
        LockMachineButton.Content = "Lock This Device";
        System.Windows.Automation.AutomationProperties.SetName(LockMachineButton, "Lock this device");
        System.Windows.Automation.AutomationProperties.SetName(DetailsListBox, "This device details");
        System.Windows.Automation.AutomationProperties.SetName(ApplicationsListBox, "Local running applications");
    }

    private bool IsLocalMachine()
    {
        return string.Equals(_machine.MachineHostname, Environment.MachineName, StringComparison.OrdinalIgnoreCase) ||
               string.Equals(_machine.Id, Environment.MachineName, StringComparison.OrdinalIgnoreCase);
    }

    private void RunLocalAction(string action, RemoteApplicationRecord? app)
    {
        switch (action)
        {
            case "focus_application" when app is not null:
                FocusProcessWindow(app.ProcessId);
                break;
            case "quit_application" when app is not null:
                TryQuit(app.ProcessId, force: false, reopen: false);
                break;
            case "force_quit_application" when app is not null:
                TryQuit(app.ProcessId, force: true, reopen: false);
                break;
            case "quit_reopen_application" when app is not null:
                TryQuit(app.ProcessId, force: false, reopen: true);
                break;
            case "lock_machine":
                LockWorkStation();
                break;
            case "restart_machine":
            case "logout_machine":
                System.Windows.MessageBox.Show(this, "Restart and log out requests are sent to the trusted remote machine. Local restart/log out is not performed from this dialog.", "OpenLink", MessageBoxButton.OK, MessageBoxImage.Information);
                break;
        }
    }

    private static void TryQuit(int processId, bool force, bool reopen)
    {
        using var process = Process.GetProcessById(processId);
        var path = "";
        try { path = process.MainModule?.FileName ?? ""; } catch { }

        if (!force && process.MainWindowHandle != IntPtr.Zero)
        {
            process.CloseMainWindow();
            if (!process.WaitForExit(3000))
            {
                process.Kill(entireProcessTree: true);
            }
        }
        else
        {
            process.Kill(entireProcessTree: true);
        }

        if (reopen && !string.IsNullOrWhiteSpace(path))
        {
            Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
        }
    }

    private static void FocusProcessWindow(int processId)
    {
        using var process = Process.GetProcessById(processId);
        if (process.MainWindowHandle != IntPtr.Zero)
        {
            ShowWindow(process.MainWindowHandle, 9);
            SetForegroundWindow(process.MainWindowHandle);
        }
    }

    private void Window_KeyDown(object sender, System.Windows.Input.KeyEventArgs e)
    {
        if (e.Key == Key.Escape)
        {
            Close();
        }
    }

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern bool LockWorkStation();
}
