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
        Title = $"{machine.DisplayName} details";
        TitleText.Text = machine.DisplayName;
        SummaryText.Text = machine.AccessibleSummary;
        System.Windows.Automation.AutomationProperties.SetName(SummaryText, machine.AccessibleSummary);
        RefreshLists();
    }

    private bool CanManageApps => _settings.AllowRemoteApplicationLaunch && _machine.IsTrusted;

    private RemoteApplicationRecord? SelectedApplication => ApplicationsListBox.SelectedItem as RemoteApplicationRecord;

    private void RefreshLists()
    {
        _applications.Clear();
        foreach (var app in RemoteApplicationRecord.GetLocalApplications())
        {
            _applications.Add(app);
        }

        _details.Clear();
        AddDetail("About", "Device name", _machine.DisplayName);
        AddDetail("About", "Platform", _machine.Platform);
        AddDetail("About", "Host name", _machine.MachineHostname);
        AddDetail("Connection", "Online state", _machine.IsOnline ? "online" : "offline");
        AddDetail("Connection", "Trusted", _machine.IsTrusted ? "trusted" : "not trusted");
        AddDetail("Connection", "Drop-in", _machine.DropInText);
        AddDetail("Connection", "Auto-connect", _machine.AutoConnect ? "enabled" : "disabled");
        AddDetail("Connection", "Last connected", _machine.LastConnectedText);
        AddDetail("Connection", "Last duration", _machine.LastDurationText);
        AddDetail("Network", "Domain used", _machine.DomainUsed);
        AddDetail("Network", "Local machine", Environment.MachineName);
        AddDetail("Permissions", "Remote control", _machine.AllowRemoteControl ? "allowed" : "blocked");
        AddDetail("Permissions", "Swap control", _machine.AllowSwapControl ? "allowed" : "blocked");
        AddDetail("Permissions", "Keyboard co-use", _machine.AllowKeyboardCoUse ? "allowed" : "blocked");
        AddDetail("Permissions", "Microphone audio", _machine.AllowMicrophoneAudio ? "allowed" : "muted");
        AddDetail("Permissions", "System audio", _machine.AllowSystemAudio ? "allowed" : "muted");
        AddDetail("Permissions", "Remote app management", CanManageApps ? "allowed for trusted machines" : "blocked in settings or not trusted");

        SummaryText.Text = $"{_machine.DisplayName}. {_applications.Count} applications listed. Escape closes this window.";
        System.Windows.Automation.AutomationProperties.SetName(SummaryText, SummaryText.Text);
    }

    private void AddDetail(string category, string name, string value)
    {
        _details.Add(new DeviceDetailItem { Category = category, Name = name, Value = value });
    }

    private void RefreshButton_Click(object sender, RoutedEventArgs e)
    {
        RefreshLists();
        _ = _sendRemoteAction("list_applications", null);
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
        if (!CanManageApps)
        {
            System.Windows.MessageBox.Show(this, "Remote app management is only available for trusted machines when the setting is enabled.", "OpenLink", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        if (IsLocalMachine())
        {
            RunLocalAction(action, app);
        }

        await _sendRemoteAction(action, app);
        RefreshLists();
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
