using System.Net.WebSockets;
using System.Net.Http;
using System.Collections.ObjectModel;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;
using System.IO;
using System.Media;
using System.Runtime.InteropServices;
using Microsoft.Win32;
using Forms = System.Windows.Forms;
using DrawingPoint = System.Drawing.Point;

namespace OpenLink.Windows;

public partial class MainWindow : Window
{
    private const string CurrentWhatIsNewNotes =
        """
        - Screen-reader readouts now use native UI Automation live-region events on Windows and NSAccessibility announcements on macOS.
        - OpenLink now shows a tCast-style What is New dialog after updates and keeps release notes available from the File menu.
        - macOS Settings now opens in a real foreground window and can be reopened from the app menu.
        - Trusted or owned devices can request remote OpenLink settings, while guest settings requests require local approval.
        - Ctrl Alt Backslash now waits for the key chord to release before opening controller actions, so the menu stays open for arrow-key navigation.
        - Controller and machine menus now include local Settings, remote Settings, running apps and processes, audio controls, volume presets, lock, restart, shut down, and log out.
        - macOS permission helper now opens Remote Desktop and Screen & System Audio Recording and reports stale OpenLink privacy entries.
        """;

    private ClientWebSocket? _socket;
    private CancellationTokenSource? _socketCancellation;
    private OpenLinkSettings _settings = OpenLinkSettingsStore.Load();
    private readonly ObservableCollection<MachineRecord> _machines;
    private readonly Forms.NotifyIcon _trayIcon;
    private readonly DispatcherTimer _healthTimer;
    private readonly DispatcherTimer _elapsedTimer;
    private readonly OpenLinkAudioBridge _audioBridge = new();
    private readonly OpenLinkTtsService _ttsService;
    private readonly SoundActionPlayer _soundPlayer;
    private readonly NvdaControllerBridge _nvdaController = new();
    private readonly SemaphoreSlim _sendLock = new(1, 1);
    private readonly Dictionary<string, MachineDetailsWindow> _machineDetailsWindows = new(StringComparer.OrdinalIgnoreCase);
    private static readonly HttpClient HealthClient = new() { Timeout = TimeSpan.FromSeconds(5) };
    private string? _activeSessionId;
    private string? _activeLink;
    private string? _activeServerUrl;
    private DateTimeOffset? _hostingStartedAt;
    private bool _allowClose;
    private bool _sessionActive;
    private string _serviceHealthText = "Connection health unknown";
    private string _connectionStrengthText = "Signal strength unknown";
    private string? _activeMachineName;
    private bool _serviceOnline;
    private bool? _lastServiceOnline;
    private int? _lastLatencyMs;
    private bool _remoteInputActive;
    private bool _remoteInputPending;
    private string? _remoteInputRequestId;
    private CancellationTokenSource? _remoteInputActivationCts;
    private MachineRecord? _remoteInputMachine;
    private TaskCompletionSource<bool>? _hostingReadyTcs;
    private bool _controllerActionsMenuQueued;
    private bool _controllerActionsMenuOpen;
    private Forms.ContextMenuStrip? _controllerActionsMenu;
    private bool _controllerHotkeyChordDown;
    private int _ctrlAltDeletePressCount;
    private DateTimeOffset _lastCtrlAltDeletePress = DateTimeOffset.MinValue;
    private bool _returnFromLocalLockPending;
    private Forms.Form? _controllerMenuOwner;
    private IntPtr _windowHandle;
    private IntPtr _keyboardHook;
    private LowLevelKeyboardProc? _keyboardHookProc;
    private const int ControllerActionsHotkeyId = 0x4f4c;
    private const int ControllerActionsShiftHotkeyId = 0x4f4d;
    private const int WmHotkey = 0x0312;
    private const int WhKeyboardLl = 13;
    private const int WmKeydown = 0x0100;
    private const int WmKeyup = 0x0101;
    private const int WmSyskeydown = 0x0104;
    private const int WmSyskeyup = 0x0105;
    private const uint ModAlt = 0x0001;
    private const uint ModControl = 0x0002;
    private const uint ModShift = 0x0004;
    private const uint VkOem5 = 0xDC;
    private const int VkControl = 0x11;
    private const int VkLControl = 0xA2;
    private const int VkRControl = 0xA3;
    private const int VkMenu = 0x12;
    private const int VkLMenu = 0xA4;
    private const int VkRMenu = 0xA5;
    private const int VkShift = 0x10;
    private const int VkLShift = 0xA0;
    private const int VkRShift = 0xA1;
    private const int VkTab = 0x09;
    private const int VkEscape = 0x1B;
    private const int VkDelete = 0x2E;
    private const int VkLWin = 0x5B;
    private const int VkRWin = 0x5C;
    private const int VkOem102 = 0xE2;
    private static readonly IntPtr HwndTopMost = new(-1);
    private const ulong MacShiftFlag = 0x20000;
    private const ulong MacControlFlag = 0x40000;
    private const ulong MacAlternateFlag = 0x80000;
    private const ulong MacCommandFlag = 0x100000;
    private const string ConnectionShortcutHelp = "Press Enter on a selected machine to connect. Press Shift F10 or the Applications key for the connection menu. Press Control Alt Backslash for controller actions. Press Control Shift Backslash to show Machines and settings. Press Alt C for the Connections menu.";
    private const string InteractionShortcutHelp = "To interact with the connected device, choose Start Using the device. Press Control Alt Backslash for controller actions. Use Minimize Remote Connection to Use Local Machine to return to this computer.";
    private static readonly string RuntimeLogDirectory = Path.Combine(OpenLinkSettingsStore.SettingsDirectory, "logs");
    private static readonly string RuntimeLogPath = Path.Combine(RuntimeLogDirectory, "openlink-windows.log");
    private const long RuntimeLogMaxBytes = 1024 * 1024;
    private static readonly string[] LegacyStartupValueNames =
    [
        "electron.app.OpenLink",
        "com.devinecreations.openlink"
    ];

    public MainWindow()
    {
        InitializeComponent();
        _soundPlayer = new SoundActionPlayer(AddLog);
        _ttsService = new OpenLinkTtsService(_settings, AddLog);
        _machines = new ObservableCollection<MachineRecord>(MachineStore.Load());
        MachinesListBox.ItemsSource = _machines;
        _trayIcon = CreateTrayIcon();
        _healthTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(30) };
        _healthTimer.Tick += async (_, _) => await RefreshServiceHealthAsync();
        _elapsedTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(30) };
        _elapsedTimer.Tick += (_, _) => RebuildTrayMenu();
        ApplySettingsToMainWindow();
        UpdateSelectedMachineActionLabels();
        SessionTextBox.Text = CreateSessionId();
        Loaded += MainWindow_Loaded;
        SourceInitialized += MainWindow_SourceInitialized;
        Closing += MainWindow_Closing;
        SystemEvents.SessionSwitch += SystemEvents_SessionSwitch;
        Closed += (_, _) =>
        {
            if (_windowHandle != IntPtr.Zero)
            {
                UnregisterHotKey(_windowHandle, ControllerActionsHotkeyId);
                UnregisterHotKey(_windowHandle, ControllerActionsShiftHotkeyId);
            }
            if (_keyboardHook != IntPtr.Zero)
            {
                UnhookWindowsHookEx(_keyboardHook);
            }
            _trayIcon.Dispose();
            _controllerMenuOwner?.Dispose();
            _audioBridge.Dispose();
            _ttsService.Dispose();
            _sendLock.Dispose();
            SystemEvents.SessionSwitch -= SystemEvents_SessionSwitch;
        };
    }

    private void MainWindow_SourceInitialized(object? sender, EventArgs e)
    {
        _windowHandle = new WindowInteropHelper(this).Handle;
        HwndSource.FromHwnd(_windowHandle)?.AddHook(WndProc);
        if (!RegisterHotKey(_windowHandle, ControllerActionsHotkeyId, ModControl | ModAlt, VkOem5))
        {
            AddLog($"Ctrl+Alt+Backslash RegisterHotKey failed: {Marshal.GetLastWin32Error()}. Low-level keyboard hook fallback is active.");
        }
        if (!RegisterHotKey(_windowHandle, ControllerActionsShiftHotkeyId, ModControl | ModShift, VkOem5))
        {
            AddLog($"Ctrl+Shift+Backslash RegisterHotKey failed: {Marshal.GetLastWin32Error()}. Low-level keyboard hook fallback is active.");
        }
        InstallKeyboardHookFallback();
    }

    private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg == WmHotkey && wParam.ToInt32() == ControllerActionsHotkeyId)
        {
            handled = true;
            QueueControllerActionsMenu();
        }
        else if (msg == WmHotkey && wParam.ToInt32() == ControllerActionsShiftHotkeyId)
        {
            handled = true;
            if (!_remoteInputActive && !_remoteInputPending)
            {
                ShowMachinesAndSettingsSurface();
            }
        }

        return IntPtr.Zero;
    }

    private void InstallKeyboardHookFallback()
    {
        _keyboardHookProc = KeyboardHookCallback;
        using var currentProcess = Process.GetCurrentProcess();
        using var currentModule = currentProcess.MainModule;
        var moduleHandle = currentModule?.ModuleName is { } moduleName ? GetModuleHandle(moduleName) : IntPtr.Zero;
        _keyboardHook = SetWindowsHookEx(WhKeyboardLl, _keyboardHookProc, moduleHandle, 0);
        if (_keyboardHook == IntPtr.Zero)
        {
            AddLog($"Keyboard hook fallback failed: {Marshal.GetLastWin32Error()}");
        }
    }

    private IntPtr KeyboardHookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        var message = wParam.ToInt32();
        if (nCode >= 0 && (message == WmKeydown || message == WmSyskeydown || message == WmKeyup || message == WmSyskeyup))
        {
            var vkCode = Marshal.ReadInt32(lParam);
            var keyDown = message == WmKeydown || message == WmSyskeydown;
            var ctrlDown = IsControlDown(vkCode, keyDown);
            var altDown = IsAltDown(vkCode, keyDown);
            var shiftDown = IsShiftDown(vkCode, keyDown);
            var controllerKey = IsBackslashVirtualKey(vkCode);

            if (controllerKey && ctrlDown && altDown)
            {
                if (keyDown && !_controllerHotkeyChordDown)
                {
                    _controllerHotkeyChordDown = true;
                    Dispatcher.BeginInvoke(QueueControllerActionsMenu);
                }
                if (!keyDown)
                {
                    _controllerHotkeyChordDown = false;
                }
                return new IntPtr(1);
            }
            if (controllerKey && ctrlDown && shiftDown)
            {
                if (_remoteInputActive || _remoteInputPending)
                {
                    if (!keyDown)
                    {
                        _controllerHotkeyChordDown = false;
                    }
                    return new IntPtr(1);
                }

                if (keyDown && !_controllerHotkeyChordDown)
                {
                    _controllerHotkeyChordDown = true;
                    Dispatcher.BeginInvoke(ShowMachinesAndSettingsSurface);
                }
                if (!keyDown)
                {
                    _controllerHotkeyChordDown = false;
                }
                return new IntPtr(1);
            }
            if (!keyDown && controllerKey)
            {
                _controllerHotkeyChordDown = false;
            }
            if (_remoteInputActive && _remoteInputMachine is not null)
            {
                if (_settings.CtrlAltDeleteGuardEnabled && ctrlDown && altDown && vkCode == VkDelete)
                {
                    if (keyDown)
                    {
                        Dispatcher.BeginInvoke(() => HandleCtrlAltDeleteDuringRemoteControl(_remoteInputMachine));
                    }

                    return new IntPtr(1);
                }

                if (keyDown && vkCode == VkEscape && ctrlDown && altDown && shiftDown)
                {
                    Dispatcher.BeginInvoke(() =>
                    {
                        StopRemoteInputForwarding("Control Alt Shift Escape safety release");
                        SetStatus("Remote keyboard forwarding stopped. Keyboard returned to this computer.");
                        QueueControllerActionsMenu();
                    });
                    return new IntPtr(1);
                }
            }

            if (keyDown && vkCode == VkEscape && _controllerActionsMenuOpen)
            {
                Dispatcher.BeginInvoke(CloseControllerActionsMenuSilently);
                return new IntPtr(1);
            }
            if (_controllerActionsMenuOpen)
            {
                return CallNextHookEx(_keyboardHook, nCode, wParam, lParam);
            }

            if (_remoteInputActive && _remoteInputMachine is not null)
            {
                if (ShouldKeepKeyLocal(vkCode, ctrlDown, altDown, shiftDown))
                {
                    return CallNextHookEx(_keyboardHook, nCode, wParam, lParam);
                }

                if (_socket?.State != WebSocketState.Open)
                {
                    Dispatcher.BeginInvoke(() => StopRemoteInputForwarding("remote socket closed"));
                    return CallNextHookEx(_keyboardHook, nCode, wParam, lParam);
                }

                var target = _remoteInputMachine;
                Dispatcher.BeginInvoke(() => _ = SendRemoteKeyboardInputAsync(target, vkCode, keyDown, ctrlDown, altDown, shiftDown));
                return ShouldPassForwardedKeyThroughLocally(target)
                    ? CallNextHookEx(_keyboardHook, nCode, wParam, lParam)
                    : new IntPtr(1);
            }
        }

        return CallNextHookEx(_keyboardHook, nCode, wParam, lParam);
    }

    private static bool IsBackslashVirtualKey(int vkCode)
    {
        return vkCode == VkOem5 || vkCode == VkOem102;
    }

    private static bool IsControlDown(int vkCode, bool keyDown)
    {
        return (GetAsyncKeyState(VkControl) & 0x8000) != 0 ||
            (GetAsyncKeyState(VkLControl) & 0x8000) != 0 ||
            (GetAsyncKeyState(VkRControl) & 0x8000) != 0 ||
            (keyDown && (vkCode == VkControl || vkCode == VkLControl || vkCode == VkRControl));
    }

    private static bool IsAltDown(int vkCode, bool keyDown)
    {
        return (GetAsyncKeyState(VkMenu) & 0x8000) != 0 ||
            (GetAsyncKeyState(VkLMenu) & 0x8000) != 0 ||
            (GetAsyncKeyState(VkRMenu) & 0x8000) != 0 ||
            (keyDown && (vkCode == VkMenu || vkCode == VkLMenu || vkCode == VkRMenu));
    }

    private static bool IsShiftDown(int vkCode, bool keyDown)
    {
        return (GetAsyncKeyState(VkShift) & 0x8000) != 0 ||
            (GetAsyncKeyState(VkLShift) & 0x8000) != 0 ||
            (GetAsyncKeyState(VkRShift) & 0x8000) != 0 ||
            (keyDown && (vkCode == VkShift || vkCode == VkLShift || vkCode == VkRShift));
    }

    private async void MainWindow_Loaded(object sender, RoutedEventArgs e)
    {
        ConfigureLaunchAtLogin();
        _healthTimer.Start();
        _elapsedTimer.Start();
        NotifyPendingUpdateIfPresent();
        await RefreshServiceHealthAsync();
        _ = CheckForUpdatesAsync(interactive: false);

        if (_settings.StartHostingOnLaunch)
        {
            await StartHostingAsync();
        }
        else if (_settings.AutoReconnectOnLaunch && _settings.AutoConnectTrustedMachines && _serviceOnline)
        {
            await ConnectToLastAutoConnectMachineAsync();
        }

        if (_settings.StartMinimizedToTrayOnLaunch)
        {
            HideOpenLinkWindow();
        }
    }

    private async void StartHostingButton_Click(object sender, RoutedEventArgs e)
    {
        await StartHostingAsync();
    }

    private async Task StartHostingAsync()
    {
        StartHostingButton.IsEnabled = false;
        StopHostingButton.IsEnabled = true;
        CopyLinkButton.IsEnabled = false;
        SetStatus("Starting hosting...");

        try
        {
            _activeSessionId = string.IsNullOrWhiteSpace(SessionTextBox.Text)
                ? CreateSessionId()
                : SessionTextBox.Text.Trim();
            SessionTextBox.Text = _activeSessionId;

            var serverUrl = GetServerUrl();
            _activeServerUrl = serverUrl;
            _hostingReadyTcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            await RefreshServiceHealthAsync(showTransitionNotifications: false);
            _socket = new ClientWebSocket();
            using var connectTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            await _socket.ConnectAsync(new Uri(serverUrl), connectTimeout.Token);
            _socketCancellation = new CancellationTokenSource();
            AddLog($"Connected to {serverUrl}");
            _ = SendDiagnosticEventAsync("signaling_connected", outcome: "success", metadata: new
            {
                endpoint = EndpointNormalizer.ShareHostFor(serverUrl),
                transport = "websocket"
            });

            var machineInfo = CreateLocalMachineInfo(serverUrl);
            var connectionPolicy = CreateConnectionPolicy();
            await SendAsync(new
            {
                type = "create_session",
                sessionId = _activeSessionId,
                password = "",
                machineInfo,
                connectionPolicy,
                hostInfo = new
                {
                    machineId = Environment.MachineName,
                    machineName = Environment.MachineName,
                    os = "Windows",
                    app = "OpenLink",
                    version = GetType().Assembly.GetName().Version?.ToString(3) ?? "1.7.21",
                    permissions = new
                    {
                        remoteControl = _settings.AllowRemoteControl,
                        clipboard = _settings.AllowClipboardSync,
                        fileTransfer = _settings.AllowFileTransfer,
                        audio = _settings.AllowAudio,
                        dropIn = _settings.AllowDropInAccess,
                        swapControl = _settings.AllowSwapControl,
                        keyboardCoUse = _settings.AllowKeyboardCoUse,
                        microphoneAudio = _settings.AllowMicrophoneAudio,
                        systemAudio = _settings.AllowSystemAudio,
                        requireApproval = _settings.RequireApprovalForNewDevices
                    },
                    accessibility = new
                    {
                        detailedMessages = _settings.DetailedScreenReaderMessages,
                        soundAlerts = _settings.SoundAlerts,
                        reduceMotion = _settings.ReduceMotion
                    }
                }
            });

            StartAudioBridge("hosting");
            _ = ReceiveLoopAsync(_socket, _socketCancellation.Token);
        }
        catch (Exception ex)
        {
            PlaySound(SoundAction.Error);
            SetStatus($"Failed to host: {ex.Message}");
            AddLog($"Error: {ex.Message}");
            _hostingReadyTcs?.TrySetResult(false);
            await StopHostingAsync();
        }
    }

    private void SettingsButton_Click(object sender, RoutedEventArgs e)
    {
        if (!CanOpenLocalSettings())
        {
            SetStatus("Local settings are locked while an owner remote session is active.");
            PlaySound(SoundAction.Error);
            return;
        }

        var dialog = new SettingsWindow(_settings)
        {
            Owner = this
        };

        if (dialog.ShowDialog() != true)
        {
            return;
        }

        _settings = dialog.Settings;
        OpenLinkSettingsStore.Save(_settings);
        ApplySettingsToMainWindow();
        _audioBridge.Configure(_settings, AddLog);
        _ttsService.Configure(_settings);
        _ = SendDiagnosticEventAsync("settings_saved", outcome: "success", metadata: new
        {
            diagnosticsEnabled = _settings.EnableDiagnosticSending,
            localTtsEnabled = _settings.EnableLocalTtsHelper,
            audioAllowed = _settings.AllowAudio
        });
        ConfigureLaunchAtLogin();
        SetStatus("Settings saved.");
        SettingsButton.Focus();
    }

    private bool CanOpenLocalSettings()
    {
        return !_settings.LockLocalSettingsDuringRemoteOwnerSession || !_sessionActive;
    }

    private void Window_KeyDown(object sender, System.Windows.Input.KeyEventArgs e)
    {
        if (e.Key == Key.OemComma &&
            (Keyboard.Modifiers & ModifierKeys.Control) == ModifierKeys.Control)
        {
            e.Handled = true;
            SettingsButton_Click(sender, new RoutedEventArgs());
        }
    }

    private async void StopHostingButton_Click(object sender, RoutedEventArgs e)
    {
        await StopHostingAsync();
    }

    private void CopyLinkButton_Click(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrWhiteSpace(_activeLink))
        {
            SetStatus("No link is ready yet.");
            return;
        }

        System.Windows.Clipboard.SetText(_activeLink);
        SetStatus("Link copied.");
    }

    private void StartHostingMenuItem_Click(object sender, RoutedEventArgs e)
    {
        _ = StartHostingAsync();
    }

    private void StopHostingMenuItem_Click(object sender, RoutedEventArgs e)
    {
        _ = StopHostingAsync();
    }

    private void CopyLinkMenuItem_Click(object sender, RoutedEventArgs e)
    {
        CopyLinkButton_Click(sender, e);
    }

    private void CheckUpdatesMenuItem_Click(object sender, RoutedEventArgs e)
    {
        _ = CheckForUpdatesAsync(interactive: true);
    }

    private void WhatIsNewMenuItem_Click(object sender, RoutedEventArgs e)
    {
        ShowWhatIsNewDialog(GetLastWhatIsNewVersion(), GetLastWhatIsNewNotes());
    }

    private void QuitMenuItem_Click(object sender, RoutedEventArgs e)
    {
        HideToTrayForActiveSession();
        if (IsVisible)
        {
            HideOpenLinkWindow();
        }
        _trayIcon.ShowBalloonTip(2500, "OpenLink", "OpenLink is minimized to the tray. Use the tray menu to quit.", Forms.ToolTipIcon.Info);
    }

    private void ConnectLastMachineMenuItem_Click(object sender, RoutedEventArgs e)
    {
        _ = ConnectLastMachineAsync();
    }

    private async Task ConnectLastMachineAsync()
    {
        var machine = GetLastConnectableMachine();
        if (machine is null)
        {
            SetStatus("No other machine is available. This device cannot connect to itself.");
            return;
        }

        await ConnectToMachineAsync(machine, machine.AllowDropIn);
    }

    private void DisconnectRemoteUserMenuItem_Click(object sender, RoutedEventArgs e)
    {
        var machine = FindControlledSideMachine();
        if (machine is not null)
        {
            _ = DisconnectMachineAsync(machine);
        }
        else
        {
            _ = StopHostingAsync();
        }
    }

    private void EndMyConnectionMenuItem_Click(object sender, RoutedEventArgs e)
    {
        _ = StopHostingAsync();
        SetStatus("Ending this computer's OpenLink connection.");
    }

    private void DisconnectFromSelectedDeviceMenuItem_Click(object sender, RoutedEventArgs e)
    {
        var machine = SelectedMachine ?? _machines.FirstOrDefault(item => item.IsOnline);
        if (machine is null)
        {
            SetStatus("No connected machine is selected.");
            return;
        }
        if (TryBlockLocalMachineAction(machine, "disconnect from"))
        {
            return;
        }

        _ = DisconnectFromDeviceAsync(machine);
    }

    private void StartUsingSelectedMachineMenuItem_Click(object sender, RoutedEventArgs e)
    {
        var machine = SelectedMachine ?? _machines.FirstOrDefault(item => item.IsOnline);
        if (machine is null)
        {
            SetStatus("No machine is selected.");
            return;
        }
        if (TryBlockLocalMachineAction(machine, "start using"))
        {
            return;
        }

        _ = StartUsingMachineAsync(machine);
    }

    private void SwapSelectedMachineMenuItem_Click(object sender, RoutedEventArgs e)
    {
        var machine = SelectedMachine ?? _machines.FirstOrDefault(item => item.IsOnline);
        if (machine is null)
        {
            SetStatus("No connected machine is selected.");
            return;
        }
        if (TryBlockLocalMachineAction(machine, "swap control with"))
        {
            return;
        }

        _ = SwapControlAsync(machine);
    }

    private async Task ReceiveLoopAsync(ClientWebSocket socket, CancellationToken cancellationToken)
    {
        var buffer = new byte[8192];

        try
        {
            while (socket.State == WebSocketState.Open && !cancellationToken.IsCancellationRequested)
            {
                using var ms = new MemoryStream();
                WebSocketReceiveResult result;
                do
                {
                    result = await socket.ReceiveAsync(buffer, cancellationToken);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        await Dispatcher.InvokeAsync(() => SetStatus("Server closed the connection."));
                        return;
                    }

                    ms.Write(buffer, 0, result.Count);
                } while (!result.EndOfMessage);

                var json = Encoding.UTF8.GetString(ms.ToArray());
                await Dispatcher.InvokeAsync(() => HandleServerMessage(json));
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            await Dispatcher.InvokeAsync(() =>
            {
                SetStatus($"Connection stopped: {ex.Message}");
                AddLog($"Connection stopped: {ex.Message}");
            });
        }
        finally
        {
            await Dispatcher.InvokeAsync(() => StopRemoteInputForwarding("signaling connection ended"));
        }
    }

    private void HandleServerMessage(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        var type = root.TryGetProperty("type", out var typeElement) ? typeElement.GetString() : "";

        if (string.Equals(type, "broadcast", StringComparison.OrdinalIgnoreCase) &&
            root.TryGetProperty("data", out var broadcastData) &&
            broadcastData.ValueKind == JsonValueKind.Object)
        {
            HandleServerMessage(broadcastData.GetRawText());
            return;
        }

        if (!ShouldSuppressServerLog(type))
        {
            AddLog(SummarizeServerMessage(root, type), announce: false);
        }

        switch (type)
        {
            case "connected":
                SetStatus("Connected. Creating session...");
                break;
            case "session_created":
                if (root.TryGetProperty("sessionId", out var sessionElement))
                {
                    _activeSessionId = sessionElement.GetString();
                    SessionTextBox.Text = _activeSessionId;
                    _ = SendAsync(new
                    {
                        type = "host_session",
                        sessionId = _activeSessionId,
                        machineInfo = CreateLocalMachineInfo(_activeServerUrl ?? GetServerUrl()),
                        connectionPolicy = CreateConnectionPolicy(),
                        hostInfo = new { machineId = Environment.MachineName, machineName = Environment.MachineName }
                    });
                }
                break;
            case "host_session_ok":
            case "host-session-ok":
                CompleteHosting();
                break;
            case "peer_joined":
                var peerId = root.TryGetProperty("peerId", out var peerElement)
                    ? peerElement.GetString() ?? "remote device"
                    : "remote device";
                NotifyDeviceConnection(peerId, Environment.MachineName, true);
                _ = SendDiagnosticEventAsync("peer_joined", outcome: "success", metadata: new { peerId });
                break;
            case "peer_disconnected":
                var disconnectedPeerId = root.TryGetProperty("peerId", out var disconnectedPeerElement)
                    ? disconnectedPeerElement.GetString() ?? "remote device"
                    : "remote device";
                NotifyDeviceConnection(disconnectedPeerId, Environment.MachineName, false);
                StopRemoteInputForwarding("remote peer disconnected");
                _ = SendDiagnosticEventAsync("peer_disconnected", outcome: "success", metadata: new { peerId = disconnectedPeerId });
                break;
            case "machine_connect_ack":
                SetStatus(_remoteInputPending
                    ? "Remote machine accepted the connection. Starting keyboard and audio interaction now."
                    : _settings.AutoStartInteractionOnConnect
                        ? "Remote machine accepted the connection. Preparing keyboard and audio interaction."
                        : "Remote machine accepted the connection. Choose Start Using to begin keyboard and audio control.",
                    announce: !_remoteInputPending);
                break;
            case "machine_connect_request":
                HandleMachineConnectRequest(root);
                break;
            case "start_interaction":
                HandleStartInteractionRequest(root);
                break;
            case "start_interaction_ack":
                HandleStartInteractionAck(root);
                break;
            case "audio_frame":
                HandleRemoteAudioFrame(root);
                break;
            case "input_event_ack":
            case "key_event_ack":
                HandleRemoteInputAck(root, type);
                break;
            case "machine_management_action":
                HandleMachineManagementAction(root);
                break;
            case "machine_management_action_ack":
                HandleMachineManagementActionAck(root);
                break;
            case "application_list":
            case "applications_list":
            case "running_applications":
                HandleRemoteApplicationList(root);
                break;
            case "tts_announcement":
            case "screen_reader_announcement":
                HandleRemoteTtsAnnouncement(root);
                break;
            case "message":
            case "chat_message":
            case "machine_message":
            case "text_message":
                PlaySound(SoundAction.MessageReceived);
                break;
            case "pause_interaction_ack":
            case "controller_disconnect_ack":
            case "disconnect_user_ack":
                StopRemoteInputForwarding(type ?? "remote interaction stopped");
                _ = SendDiagnosticEventAsync(type ?? "remote_interaction_stopped", outcome: "success");
                break;
            case "pause_interaction":
            case "controller_disconnect":
            case "disconnect_user":
                HandleRemoteInteractionStopRequest(type ?? "remote interaction stopped", root);
                break;
            case "error":
            case "join_error":
                var message = root.TryGetProperty("message", out var messageElement)
                    ? messageElement.GetString()
                    : root.TryGetProperty("error", out var errorElement) ? errorElement.GetString() : "Unknown server error";
                SetStatus($"Server error: {message}");
                PlaySound(SoundAction.Error);
                StopRemoteInputForwarding($"server error: {message}", announce: false);
                _ = SendDiagnosticEventAsync("server_error", outcome: "error", metadata: new { errorType = type, message });
                break;
        }
    }

    private static bool ShouldSuppressServerLog(string? type)
    {
        return type is not null &&
               (string.Equals(type, "audio_frame", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(type, "input_event_ack", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(type, "key_event_ack", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(type, "machine_event_ack", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(type, "machine_connect_ack", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(type, "diagnostic_event_ack", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(type, "machine_presence", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(type, "presence", StringComparison.OrdinalIgnoreCase));
    }

    private static string SummarizeServerMessage(JsonElement root, string? type)
    {
        if (string.IsNullOrWhiteSpace(type))
        {
            return "Received server message with no type.";
        }

        var source = root.TryGetProperty("sourceMachineId", out var sourceElement)
            ? sourceElement.GetString()
            : root.TryGetProperty("source", out var sourceNameElement) ? sourceNameElement.GetString() : null;
        var target = root.TryGetProperty("targetMachineId", out var targetElement) ? targetElement.GetString() : null;
        var requestId = root.TryGetProperty("requestId", out var requestElement) ? requestElement.GetString() : null;

        return string.Join(" ",
            new[]
            {
                $"Received {type}.",
                string.IsNullOrWhiteSpace(source) ? null : $"source={source}.",
                string.IsNullOrWhiteSpace(target) ? null : $"target={target}.",
                string.IsNullOrWhiteSpace(requestId) ? null : $"requestId={requestId}."
            }.Where(part => !string.IsNullOrWhiteSpace(part)));
    }

    private void HandleStartInteractionAck(JsonElement root)
    {
        var success = !root.TryGetProperty("success", out var successElement) || successElement.ValueKind != JsonValueKind.False;
        var requestId = root.TryGetProperty("requestId", out var requestElement) ? requestElement.GetString() : null;
        var message = root.TryGetProperty("message", out var messageElement) ? messageElement.GetString() : null;

        if (!success)
        {
            var error = root.TryGetProperty("error", out var errorElement)
                ? errorElement.GetString()
                : message ?? "remote machine rejected keyboard control";
            var permissionAction = root.TryGetProperty("permissionAction", out var permissionActionElement)
                ? permissionActionElement.GetString()
                : null;
            var permissionRecoveryCommand = root.TryGetProperty("permissionRecoveryCommand", out var permissionRecoveryElement)
                ? permissionRecoveryElement.GetString()
                : null;
            var permissionResetCommand = root.TryGetProperty("permissionResetCommand", out var permissionResetElement)
                ? permissionResetElement.GetString()
                : null;
            var permissionAlternatives = ReadStringArray(root, "permissionAlternatives");
            StopRemoteInputForwarding(error);
            var status = new StringBuilder();
            status.Append($"Remote keyboard control did not start: {error}. Keyboard remains on this computer.");
            if (!string.IsNullOrWhiteSpace(permissionAction))
            {
                status.Append(' ').Append(permissionAction);
            }
            if (!string.IsNullOrWhiteSpace(permissionRecoveryCommand))
            {
                status.Append(" Admin shell recovery command: ").Append(permissionRecoveryCommand);
            }
            if (!string.IsNullOrWhiteSpace(permissionResetCommand))
            {
                status.Append(" Reset stale macOS prompts with: ").Append(permissionResetCommand);
            }
            SetStatus(status.ToString());
            if (permissionAlternatives.Count > 0)
            {
                AddLog("Mac permission alternatives: " + string.Join(" ", permissionAlternatives));
            }
            PlaySound(SoundAction.Error);
            return;
        }

        ActivateRemoteInputForwarding(requestId, message);
        _ = SendDiagnosticEventAsync("start_interaction_ack", _remoteInputMachine, "success");
    }

    private static List<string> ReadStringArray(JsonElement root, string propertyName)
    {
        if (!root.TryGetProperty(propertyName, out var element) || element.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        var values = new List<string>();
        foreach (var item in element.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.String &&
                !string.IsNullOrWhiteSpace(item.GetString()))
            {
                values.Add(item.GetString()!);
            }
        }

        return values;
    }

    private void HandleRemoteTtsAnnouncement(JsonElement root)
    {
        var target = root.TryGetProperty("targetMachineId", out var targetElement) ? targetElement.GetString() : null;
        if (!string.IsNullOrWhiteSpace(target) &&
            !string.Equals(target, Environment.MachineName, StringComparison.OrdinalIgnoreCase) &&
            !_machines.Any(machine => string.Equals(machine.Id, target, StringComparison.OrdinalIgnoreCase) && IsLocalMachine(machine)))
        {
            return;
        }

        var text = root.TryGetProperty("text", out var textElement)
            ? textElement.GetString()
            : root.TryGetProperty("message", out var messageElement) ? messageElement.GetString() : null;
        if (string.IsNullOrWhiteSpace(text))
        {
            return;
        }

        AddLog($"Remote announcement: {text}");
        _ = _ttsService.SpeakRemoteAnnouncementAsync(text);
    }

    private void HandleRemoteInputAck(JsonElement root, string? type)
    {
        var success = !root.TryGetProperty("success", out var successElement) || successElement.ValueKind != JsonValueKind.False;
        if (success)
        {
            return;
        }

        var error = root.TryGetProperty("error", out var errorElement)
            ? errorElement.GetString()
            : "remote input was rejected";
        StopRemoteInputForwarding(error);
        SetStatus($"Remote keyboard forwarding stopped because the remote machine rejected input: {error}. Keyboard returned to this computer.");
        AddLog($"{type ?? "input_event_ack"} reported failure: {error}");
        PlaySound(SoundAction.Error);
    }

    private void HandleMachineManagementAction(JsonElement root)
    {
        if (!IsMessageTargetedToThisMachine(root))
        {
            return;
        }

        var action = root.TryGetProperty("action", out var actionElement) ? actionElement.GetString() : null;
        if (string.Equals(action, "open_settings", StringComparison.OrdinalIgnoreCase))
        {
            var trustedOwner = root.TryGetProperty("trustedOwner", out var trustedOwnerElement) &&
                trustedOwnerElement.ValueKind == JsonValueKind.True;
            var accepted = _settings.AllowRemoteSettingsManagement &&
                ((trustedOwner && _settings.AllowTrustedOwnerRemoteSettingsChanges) ||
                 !_settings.RequireApprovalForGuestRemoteSettingsChanges);
            var message = accepted
                ? $"OpenLink settings opened on {Environment.MachineName}."
                : $"OpenLink settings request needs local approval on {Environment.MachineName}.";
            _ = SendPeerAsync(new
            {
                type = "machine_management_action_ack",
                action = "open_settings",
                targetMachineId = GetSourceMachineId(root),
                sourceMachineId = Environment.MachineName,
                success = accepted,
                message,
                requiresLocalApproval = !accepted && _settings.RequireApprovalForGuestRemoteSettingsChanges,
                trustedOwner
            });

            if (accepted)
            {
                Dispatcher.Invoke(() => SettingsButton_Click(this, new RoutedEventArgs()));
            }
            else
            {
                SetStatus("A remote device requested settings access. Approve the device as trusted or disable guest approval before allowing remote settings changes.");
                PlaySound(SoundAction.MessageReceived);
            }
            return;
        }

        if (!string.Equals(action, "list_applications", StringComparison.OrdinalIgnoreCase))
        {
            HandleRemoteMachineControlAction(root, action);
            return;
        }

        var applications = RemoteApplicationRecord.GetLocalApplications()
            .Select(app => app.ToPayload())
            .ToList();
        _ = SendPeerAsync(new
        {
            type = "application_list",
            targetMachineId = GetSourceMachineId(root),
            sourceMachineId = Environment.MachineName,
            applications
        });
        SetStatus($"Sent {applications.Count} running applications to the controlling OpenLink machine.");
    }

    private void HandleRemoteMachineControlAction(JsonElement root, string? action)
    {
        var trustedOwner = root.TryGetProperty("trustedOwner", out var trustedOwnerElement) &&
            trustedOwnerElement.ValueKind == JsonValueKind.True;
        var accepted = trustedOwner && _settings.AllowRemoteApplicationLaunch;
        var message = accepted
            ? $"Remote {action?.Replace('_', ' ')} accepted by {Environment.MachineName}."
            : $"Remote {action?.Replace('_', ' ')} is not allowed on {Environment.MachineName}.";

        if (accepted)
        {
            switch (action)
            {
                case "set_audio_settings":
                    ApplyRemoteAudioSettings(root);
                    break;
                case "lock_machine":
                    LockWorkStation();
                    break;
                case "restart_machine":
                    Process.Start(new ProcessStartInfo("shutdown.exe", "/r /t 0") { UseShellExecute = false });
                    break;
                case "shutdown_machine":
                    Process.Start(new ProcessStartInfo("shutdown.exe", "/s /t 0") { UseShellExecute = false });
                    break;
                case "logout_machine":
                    Process.Start(new ProcessStartInfo("shutdown.exe", "/l") { UseShellExecute = false });
                    break;
                default:
                    accepted = false;
                    message = $"Remote {action?.Replace('_', ' ')} is not supported on {Environment.MachineName}.";
                    break;
            }
        }

        _ = SendPeerAsync(new
        {
            type = "machine_management_action_ack",
            action,
            targetMachineId = GetSourceMachineId(root),
            sourceMachineId = Environment.MachineName,
            success = accepted,
            message,
            trustedOwner
        });

        SetStatus(message);
    }

    private void ApplyRemoteAudioSettings(JsonElement root)
    {
        if (!root.TryGetProperty("audioSettings", out var audioSettings) ||
            audioSettings.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        if (audioSettings.TryGetProperty("allowMicrophoneAudio", out var microphoneElement) &&
            (microphoneElement.ValueKind == JsonValueKind.True || microphoneElement.ValueKind == JsonValueKind.False))
        {
            _settings.AllowMicrophoneAudio = microphoneElement.GetBoolean();
        }
        if (audioSettings.TryGetProperty("allowSystemAudio", out var systemAudioElement) &&
            (systemAudioElement.ValueKind == JsonValueKind.True || systemAudioElement.ValueKind == JsonValueKind.False))
        {
            _settings.AllowSystemAudio = systemAudioElement.GetBoolean();
        }
        if (audioSettings.TryGetProperty("remoteAudioVolumePercent", out var remoteVolumeElement) &&
            remoteVolumeElement.TryGetInt32(out var remoteVolume))
        {
            _settings.RemoteAudioVolumePercent = Math.Clamp(remoteVolume, 0, 150);
        }
        if (audioSettings.TryGetProperty("localAudioCaptureVolumePercent", out var captureVolumeElement) &&
            captureVolumeElement.TryGetInt32(out var captureVolume))
        {
            _settings.LocalAudioCaptureVolumePercent = Math.Clamp(captureVolume, 0, 150);
        }

        OpenLinkSettingsStore.Save(_settings);
        _audioBridge.Configure(_settings, AddLog);
    }

    private void HandleMachineManagementActionAck(JsonElement root)
    {
        if (!IsMessageTargetedToThisMachine(root))
        {
            return;
        }

        var action = root.TryGetProperty("action", out var actionElement) ? actionElement.GetString() : "machine action";
        var success = !root.TryGetProperty("success", out var successElement) || successElement.ValueKind != JsonValueKind.False;
        var message = root.TryGetProperty("message", out var messageElement) ? messageElement.GetString() : null;
        if (success)
        {
            SetStatus(message ?? $"{action?.Replace('_', ' ')} accepted by remote machine.");
            return;
        }

        SetStatus(message ?? $"{action?.Replace('_', ' ')} needs local approval on the remote machine.");
        PlaySound(SoundAction.MessageReceived);
    }

    private void HandleRemoteApplicationList(JsonElement root)
    {
        if (!IsMessageTargetedToThisMachine(root))
        {
            return;
        }

        var sourceMachineId = GetSourceMachineId(root);
        if (string.IsNullOrWhiteSpace(sourceMachineId))
        {
            sourceMachineId = root.TryGetProperty("sourceMachineId", out var sourceElement)
                ? sourceElement.GetString()
                : null;
        }

        if (string.IsNullOrWhiteSpace(sourceMachineId) ||
            !root.TryGetProperty("applications", out var applicationsElement) ||
            applicationsElement.ValueKind != JsonValueKind.Array)
        {
            return;
        }

        var applications = applicationsElement
            .EnumerateArray()
            .Where(item => item.ValueKind == JsonValueKind.Object)
            .Select(RemoteApplicationRecord.FromJson)
            .OrderBy(item => item.Name, StringComparer.CurrentCultureIgnoreCase)
            .ThenBy(item => item.ProcessId)
            .ToList();

        if (_machineDetailsWindows.TryGetValue(NormalizeMachineToken(sourceMachineId), out var window))
        {
            window.UpdateRemoteApplications(applications);
        }

        SetStatus($"{applications.Count} running applications received from {sourceMachineId}.");
    }

    private void HandleMachineConnectRequest(JsonElement root)
    {
        if (!IsMessageTargetedToThisMachine(root))
        {
            return;
        }

        var remoteMachine = UpsertRemoteMachineFromMessage(root);
        var accepted = _settings.AllowRemoteControl &&
            (!_settings.RequireApprovalForNewDevices || remoteMachine?.IsTrusted == true || remoteMachine?.AllowDropIn == true);
        var message = accepted
            ? $"Remote machine accepted by {Environment.MachineName}."
            : $"Remote control is not approved on {Environment.MachineName}.";

        _ = SendPeerAsync(new
        {
            type = "machine_connect_ack",
            targetMachineId = GetSourceMachineId(root),
            sourceMachineId = Environment.MachineName,
            success = accepted,
            message
        });

        SetStatus(accepted
            ? $"Remote connection request accepted from {remoteMachine?.DisplayName ?? "another OpenLink machine"}."
            : "Remote connection request blocked because this machine requires approval or remote control is disabled.");
        _ = SendDiagnosticEventAsync("machine_connect_request", remoteMachine, accepted ? "accepted" : "blocked");
    }

    private void HandleStartInteractionRequest(JsonElement root)
    {
        if (!IsMessageTargetedToThisMachine(root))
        {
            return;
        }

        var remoteMachine = UpsertRemoteMachineFromMessage(root);
        var requestId = root.TryGetProperty("requestId", out var requestElement) ? requestElement.GetString() : null;
        var accepted = _settings.AllowRemoteControl &&
            (!_settings.RequireApprovalForNewDevices || remoteMachine?.IsTrusted == true || remoteMachine?.AllowDropIn == true);
        var message = accepted
            ? $"Keyboard and audio control accepted by {Environment.MachineName}."
            : $"Keyboard control is not approved on {Environment.MachineName}.";

        _ = SendPeerAsync(new
        {
            type = "start_interaction_ack",
            targetMachineId = GetSourceMachineId(root),
            sourceMachineId = Environment.MachineName,
            requestId,
            success = accepted,
            message
        });

        if (!accepted)
        {
            SetStatus("Remote keyboard control request blocked because this machine requires approval or remote control is disabled.");
            PlaySound(SoundAction.Error);
            _ = SendDiagnosticEventAsync("start_interaction", remoteMachine, "blocked");
            return;
        }

        _sessionActive = true;
        UpdateConnectedUiState();
        PlaySound(SoundAction.Connect);
        var acceptedMessage = $"Remote keyboard and audio control accepted from {remoteMachine?.DisplayName ?? "another OpenLink machine"}. Use Control Alt Backslash for local OpenLink actions.";
        SetStatus(acceptedMessage);
        _ = SendPeerAsync(new
        {
            type = "tts_announcement",
            targetMachineId = GetSourceMachineId(root),
            sourceMachineId = Environment.MachineName,
            sourcePlatform = "Windows",
            priority = "assertive",
            interrupt = true,
            text = $"OpenLink is connected to {Environment.MachineName}. Remote audio and system announcements are ready."
        });
        HideToTrayForActiveSession();
        _ = SendDiagnosticEventAsync("start_interaction", remoteMachine, "accepted");
    }

    private void HandleRemoteInteractionStopRequest(string type, JsonElement root)
    {
        if (!IsMessageTargetedToThisMachine(root))
        {
            return;
        }

        _audioBridge.SetFrameSink(null);
        SetStatus("Remote interaction ended. Local keyboard and audio remain on this computer.");
        _ = SendPeerAsync(new
        {
            type = $"{type}_ack",
            targetMachineId = GetSourceMachineId(root),
            sourceMachineId = Environment.MachineName,
            success = true
        });
        _ = SendDiagnosticEventAsync(type, outcome: "acknowledged");
    }

    private void CompleteHosting()
    {
        var host = EndpointNormalizer.ShareHostFor(_activeServerUrl ?? GetServerUrl());
        _activeLink = $"https://{host}/token/{Uri.EscapeDataString(_activeSessionId ?? "")}";
        LinkTextBox.Text = _activeLink;
        CopyLinkButton.IsEnabled = true;
        _hostingStartedAt = DateTimeOffset.Now;
        _sessionActive = true;
        _hostingReadyTcs?.TrySetResult(true);
        UpdateConnectedUiState();
        UpdateLocalMachineHistory(true);
        PlaySound(SoundAction.HostingStarted);
        if (_settings.CopyLinkWhenHostingStarts)
        {
            System.Windows.Clipboard.SetText(_activeLink);
        }

        SetStatus($"OpenLink online and waiting for a remote connection. Session {_activeSessionId}. {ConnectionShortcutHelp}");
        _ = SendDiagnosticEventAsync("hosting_started", outcome: "success", metadata: new
        {
            sessionId = _activeSessionId ?? "",
            audioTransport = "native-wasapi"
        });
        HideToTrayForActiveSession();
    }

    private async Task<bool> SendAsync(object payload)
    {
        if (_socket is null || _socket.State != WebSocketState.Open) return false;

        var json = JsonSerializer.Serialize(payload);
        var bytes = Encoding.UTF8.GetBytes(json);
        await _sendLock.WaitAsync();
        try
        {
            if (_socket is null || _socket.State != WebSocketState.Open) return false;
            await _socket.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None);
            return true;
        }
        finally
        {
            _sendLock.Release();
        }
    }

    private Task<bool> SendPeerAsync(object payload)
    {
        return SendAsync(new
        {
            type = "broadcast",
            data = payload
        });
    }

    private Task<bool> SendDiagnosticEventAsync(string eventName, MachineRecord? machine = null, string? outcome = null, object? metadata = null)
    {
        if (!_settings.EnableDiagnosticSending)
        {
            return Task.FromResult(false);
        }

        return SendAsync(new
        {
            type = "diagnostic_event",
            eventName,
            sessionId = _activeSessionId,
            sourceMachineId = Environment.MachineName,
            sourceMachineName = Environment.MachineName,
            sourcePlatform = "Windows",
            targetMachineId = machine?.Id,
            targetMachineName = machine?.DisplayName,
            targetPlatform = machine?.Platform,
            outcome = outcome ?? "info",
            metadata
        });
    }

    private async Task<bool> WaitForHostingReadyAsync(TimeSpan timeout)
    {
        if (_socket?.State != WebSocketState.Open)
        {
            return false;
        }

        if (_hostingStartedAt is not null)
        {
            return true;
        }

        var readyTask = _hostingReadyTcs?.Task;
        if (readyTask is null)
        {
            return true;
        }

        var completed = await Task.WhenAny(readyTask, Task.Delay(timeout));
        return completed == readyTask && readyTask.Result && _socket?.State == WebSocketState.Open;
    }

    private void BeginRemoteInputHandshake(MachineRecord machine, string requestId)
    {
        _remoteInputActivationCts?.Cancel();
        _remoteInputActivationCts?.Dispose();
        _remoteInputMachine = machine;
        _remoteInputRequestId = requestId;
        _remoteInputPending = true;
        _remoteInputActive = false;
        _remoteInputActivationCts = new CancellationTokenSource();
        var token = _remoteInputActivationCts.Token;
        _ = TimeoutRemoteInputHandshakeAsync(machine, requestId, token);
        AddLog($"Remote keyboard forwarding handshake requested for {machine.DisplayName} ({machine.Platform}).");
    }

    private async Task TimeoutRemoteInputHandshakeAsync(MachineRecord machine, string requestId, CancellationToken token)
    {
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(20), token);
        }
        catch (OperationCanceledException)
        {
            return;
        }

        await Dispatcher.InvokeAsync(() =>
        {
            if (!_remoteInputPending || _remoteInputRequestId != requestId)
            {
                return;
            }

            StopRemoteInputForwarding("remote input handshake timed out");
            SetStatus($"The remote machine did not confirm keyboard control for {machine.DisplayName}. Keyboard stayed on this computer.");
            AddLog($"Remote keyboard forwarding handshake timed out for {machine.DisplayName}.");
            PlaySound(SoundAction.Error);
        });
    }

    private void ActivateRemoteInputForwarding(string? requestId, string? message)
    {
        if (!_remoteInputPending && _remoteInputActive)
        {
            return;
        }

        if (!string.IsNullOrWhiteSpace(_remoteInputRequestId) &&
            !string.IsNullOrWhiteSpace(requestId) &&
            !string.Equals(_remoteInputRequestId, requestId, StringComparison.Ordinal))
        {
            AddLog($"Ignored remote keyboard ack for stale request {requestId}.");
            return;
        }

        if (_remoteInputMachine is null)
        {
            return;
        }

        _remoteInputActivationCts?.Cancel();
        _remoteInputActivationCts?.Dispose();
        _remoteInputActivationCts = null;
        _remoteInputPending = false;
        _remoteInputActive = true;
        AddLog($"Remote keyboard forwarding enabled for {_remoteInputMachine.DisplayName} ({_remoteInputMachine.Platform}).");
        StartAudioBridge($"using {_remoteInputMachine.DisplayName}");
        var screenReaderMessage = BuildScreenReaderConnectionMessage(_remoteInputMachine);
        if (!string.IsNullOrWhiteSpace(screenReaderMessage))
        {
            AddLog(screenReaderMessage);
            _ = _ttsService.SpeakStatusAsync(screenReaderMessage);
        }
        SetStatus(message ?? $"Keyboard is now being sent to {_remoteInputMachine.DisplayName}. Press Control Alt Backslash for controller actions. Press Control Alt Shift Escape to return keyboard to this computer.");
        PlaySound(SoundAction.Connect);
        HideOpenLinkWindow();
    }

    private void StopRemoteInputForwarding(string? reason = null, bool announce = true)
    {
        _audioBridge.SetFrameSink(null);
        _remoteInputActivationCts?.Cancel();
        _remoteInputActivationCts?.Dispose();
        _remoteInputActivationCts = null;

        if ((_remoteInputActive || _remoteInputPending) && _remoteInputMachine is not null)
        {
            AddLog(
                string.IsNullOrWhiteSpace(reason)
                    ? $"Remote keyboard forwarding stopped for {_remoteInputMachine.DisplayName}."
                    : $"Remote keyboard forwarding stopped for {_remoteInputMachine.DisplayName}: {reason}.",
                announce);
        }

        _remoteInputActive = false;
        _remoteInputPending = false;
        _remoteInputRequestId = null;
        _remoteInputMachine = null;
    }

    private async Task SendRemoteKeyboardInputAsync(MachineRecord machine, int vkCode, bool isDown, bool ctrlDown, bool altDown, bool shiftDown)
    {
        if (!_remoteInputActive || _socket?.State != WebSocketState.Open)
        {
            return;
        }

        var macKeyCode = TryMapWindowsVirtualKeyToMacKeyCode(vkCode);
        if (macKeyCode is null)
        {
            AddLog($"No macOS key mapping for Windows virtual key 0x{vkCode:X2}.", announce: false);
            return;
        }

        try
        {
            await SendPeerAsync(new
            {
                type = "input_event",
                targetMachineId = machine.Id,
                sourceMachineId = Environment.MachineName,
                sourcePlatform = "Windows",
                eventType = isDown ? 10 : 11,
                keyCode = macKeyCode.Value,
                flags = BuildMacModifierFlags(vkCode, ctrlDown, altDown, shiftDown),
                timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            });
        }
        catch (Exception ex)
        {
            StopRemoteInputForwarding($"send failed: {ex.Message}");
            SetStatus($"Keyboard forwarding stopped because the remote connection failed: {ex.Message}");
        }
    }

    private static bool ShouldKeepKeyLocal(int vkCode, bool ctrlDown, bool altDown, bool shiftDown)
    {
        // During Start Using, only OpenLink safety controls stay local.
        // Normal navigation and app-switching keys belong to the controlled machine.
        if (ctrlDown && altDown && shiftDown && vkCode == VkEscape)
        {
            return true;
        }

        return false;
    }

    private bool ShouldPassForwardedKeyThroughLocally(MachineRecord machine)
    {
        // Start Using is exclusive remote control. Co-use is reserved for explicit
        // swap/co-use modes so a normal remote-control session cannot leak keys locally.
        return false;
    }

    private void HandleCtrlAltDeleteDuringRemoteControl(MachineRecord machine)
    {
        var now = DateTimeOffset.UtcNow;
        _ctrlAltDeletePressCount = (now - _lastCtrlAltDeletePress) <= TimeSpan.FromSeconds(4)
            ? _ctrlAltDeletePressCount + 1
            : 1;
        _lastCtrlAltDeletePress = now;

        if (_ctrlAltDeletePressCount == 1)
        {
            SetStatus($"Control Alt Delete is guarded by OpenLink. Press it {_settings.CtrlAltDeleteRemotePressCount} times for {machine.DisplayName}. Press it {_settings.CtrlAltDeleteLocalLockPressCount} times for this Windows lock screen. Control Alt Shift Escape returns keyboard to this computer.");
            return;
        }

        if (_ctrlAltDeletePressCount == _settings.CtrlAltDeleteRemotePressCount)
        {
            _ = SendRemoteMachineActionAsync(machine, "lock_machine", null);
            SetStatus($"Sent lock request to {machine.DisplayName}. Control Alt Delete is still guarded on this computer.");
            return;
        }

        if (_ctrlAltDeletePressCount >= _settings.CtrlAltDeleteLocalLockPressCount)
        {
            _returnFromLocalLockPending = true;
            _ctrlAltDeletePressCount = 0;
            SetStatus("Locking this Windows computer. OpenLink will apply the selected return action after sign in.");
            LockWorkStation();
        }
    }

    private void SystemEvents_SessionSwitch(object sender, SessionSwitchEventArgs e)
    {
        if (e.Reason != SessionSwitchReason.SessionUnlock || !_returnFromLocalLockPending)
        {
            return;
        }

        _returnFromLocalLockPending = false;
        Dispatcher.BeginInvoke(() => ApplyCtrlAltDeleteUnlockActionAsync());
    }

    private async Task ApplyCtrlAltDeleteUnlockActionAsync()
    {
        var machine = _remoteInputMachine;
        if (machine is null)
        {
            SetStatus("Windows sign in complete. No remote device is currently controlled.");
            return;
        }

        switch (_settings.CtrlAltDeleteUnlockAction)
        {
            case "stay-connected-background":
                await MinimizeRemoteForLocalUseAsync(machine);
                break;
            case "disconnect":
                await DisconnectFromDeviceAsync(machine);
                break;
            default:
                SetStatus($"Windows sign in complete. Returning keyboard and audio focus to {machine.DisplayName}.");
                break;
        }
    }

    private static ulong BuildMacModifierFlags(int vkCode, bool ctrlDown, bool altDown, bool shiftDown)
    {
        ulong flags = 0;
        if (shiftDown || vkCode == VkShift || vkCode == VkLShift || vkCode == VkRShift)
        {
            flags |= MacShiftFlag;
        }
        if (altDown || vkCode == VkMenu || vkCode == VkLMenu || vkCode == VkRMenu)
        {
            flags |= MacAlternateFlag;
        }
        if (ctrlDown || vkCode == VkControl || vkCode == VkLControl || vkCode == VkRControl)
        {
            // Windows Ctrl maps to macOS Command for normal shortcut parity.
            flags |= MacCommandFlag;
        }
        if (vkCode == VkLWin || vkCode == VkRWin)
        {
            flags |= MacControlFlag;
        }

        return flags;
    }

    private static int? TryMapWindowsVirtualKeyToMacKeyCode(int vkCode) => vkCode switch
    {
        0x41 => 0,  // A
        0x53 => 1,  // S
        0x44 => 2,  // D
        0x46 => 3,  // F
        0x48 => 4,  // H
        0x47 => 5,  // G
        0x5A => 6,  // Z
        0x58 => 7,  // X
        0x43 => 8,  // C
        0x56 => 9,  // V
        0x42 => 11, // B
        0x51 => 12, // Q
        0x57 => 13, // W
        0x45 => 14, // E
        0x52 => 15, // R
        0x59 => 16, // Y
        0x54 => 17, // T
        0x31 => 18, // 1
        0x32 => 19, // 2
        0x33 => 20, // 3
        0x34 => 21, // 4
        0x36 => 22, // 6
        0x35 => 23, // 5
        0xBB => 24, // =
        0x39 => 25, // 9
        0x37 => 26, // 7
        0xBD => 27, // -
        0x38 => 28, // 8
        0x30 => 29, // 0
        0xDD => 30, // ]
        0x4F => 31, // O
        0x55 => 32, // U
        0xDB => 33, // [
        0x49 => 34, // I
        0x50 => 35, // P
        0x0D => 36, // Return
        0x4C => 37, // L
        0x4A => 38, // J
        0xDE => 39, // '
        0x4B => 40, // K
        0xBA => 41, // ;
        0xDC => 42, // \
        0xBC => 43, // ,
        0xBF => 44, // /
        0x4E => 45, // N
        0x4D => 46, // M
        0xBE => 47, // .
        0x09 => 48, // Tab
        0x20 => 49, // Space
        0xC0 => 50, // `
        0x60 => 82, // Numpad 0
        0x61 => 83, // Numpad 1
        0x62 => 84, // Numpad 2
        0x63 => 85, // Numpad 3
        0x64 => 86, // Numpad 4
        0x65 => 87, // Numpad 5
        0x66 => 88, // Numpad 6
        0x67 => 89, // Numpad 7
        0x68 => 91, // Numpad 8
        0x69 => 92, // Numpad 9
        0x6D => 78, // Numpad minus
        0x6B => 69, // Numpad plus
        0x6E => 65, // Numpad decimal
        0x6F => 75, // Numpad divide
        0x6A => 67, // Numpad multiply
        VkShift or VkLShift or VkRShift => 56,
        VkControl or VkLControl or VkRControl => 55,
        VkMenu or VkLMenu or VkRMenu => 58,
        0x1B => 53, // Escape
        0x08 => 51, // Delete/backspace
        0x25 => 123, // Left
        0x27 => 124, // Right
        0x28 => 125, // Down
        0x26 => 126, // Up
        0x70 => 122, // F1
        0x71 => 120, // F2
        0x72 => 99,  // F3
        0x73 => 118, // F4
        0x74 => 96,  // F5
        0x75 => 97,  // F6
        0x76 => 98,  // F7
        0x77 => 100, // F8
        0x78 => 101, // F9
        0x79 => 109, // F10
        0x7A => 103, // F11
        0x7B => 111, // F12
        _ => null
    };

    private async Task StopHostingAsync()
    {
        var hadActiveSession = _sessionActive || _socket?.State == WebSocketState.Open;
        try
        {
            _socketCancellation?.Cancel();
            if (_socket?.State == WebSocketState.Open)
            {
                await _socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Stopped", CancellationToken.None);
            }
        }
        catch
        {
        }
        finally
        {
            _socket?.Dispose();
            _socketCancellation?.Dispose();
            _socket = null;
            _socketCancellation = null;
            _hostingReadyTcs?.TrySetResult(false);
            _hostingReadyTcs = null;
            StopRemoteInputForwarding();
            StopHostingButton.IsEnabled = false;
            StartHostingButton.IsEnabled = true;
            CopyLinkButton.IsEnabled = !string.IsNullOrWhiteSpace(_activeLink);
            _sessionActive = false;
            _activeMachineName = null;
            _hostingStartedAt = null;
            _audioBridge.Stop();
            UpdateConnectedUiState();
            UpdateLocalMachineHistory(false);
            SetStatus("Stopped.");
            if (hadActiveSession)
            {
                PlaySound(SoundAction.HostingStopped);
            }
        }
    }

    private string GetServerUrl()
    {
        var selected = ServerCombo.Text.Trim();
        var rawUrl = string.IsNullOrWhiteSpace(selected)
            ? _settings.DefaultServerUrl
            : selected;
        var normalized = EndpointNormalizer.NormalizeWebSocketUrl(rawUrl, _settings.CustomSignalingServerAccessEnabled);
        if (!string.Equals(rawUrl, normalized, StringComparison.OrdinalIgnoreCase))
        {
            AddLog($"Normalized endpoint {rawUrl} to {normalized}");
            ServerCombo.Text = normalized;
        }

        return normalized;
    }

    private string CreateSessionId()
    {
        var prefix = string.IsNullOrWhiteSpace(_settings.SessionPrefix) ? "win" : _settings.SessionPrefix.Trim();
        return $"{prefix}-{DateTimeOffset.UtcNow.ToUnixTimeSeconds():x}";
    }

    private void ApplySettingsToMainWindow()
    {
        ServerCombo.Items.Clear();
        foreach (var url in EndpointNormalizer.ApprovedWebSocketUrls)
        {
            ServerCombo.Items.Add(new System.Windows.Controls.ComboBoxItem { Content = url });
        }
        ServerCombo.IsEditable = _settings.CustomSignalingServerAccessEnabled;
        if (_settings.CustomSignalingServerAccessEnabled &&
            !EndpointNormalizer.IsApprovedDefaultWebSocketUrl(_settings.DefaultServerUrl))
        {
            ServerCombo.Items.Add(new System.Windows.Controls.ComboBoxItem { Content = _settings.DefaultServerUrl });
        }

        ServerCombo.Text = string.IsNullOrWhiteSpace(_settings.DefaultServerUrl)
            ? EndpointNormalizer.CanonicalWebSocketUrl
            : EndpointNormalizer.NormalizeWebSocketUrl(_settings.DefaultServerUrl, _settings.CustomSignalingServerAccessEnabled);
        LogListBox.Visibility = _settings.ShowActivityLog ? Visibility.Visible : Visibility.Collapsed;
        _ttsService.Configure(_settings);
        RebuildTrayMenu();
    }

    private void SetStatus(string status, bool announce = true)
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.Invoke(() => SetStatus(status, announce));
            return;
        }

        var previousAccessibleName = System.Windows.Automation.AutomationProperties.GetName(StatusTextBlock);
        var nextAccessibleName = $"Status: {status}";
        StatusTextBlock.Text = status;
        System.Windows.Automation.AutomationProperties.SetName(StatusTextBlock, nextAccessibleName);
        if (announce)
        {
            AnnounceStatusToScreenReader(status, previousAccessibleName, nextAccessibleName);
        }
        if (_settings.AnnounceStatusChanges)
        {
            AddLog(status, announce: false);
            if (announce)
            {
                _ = _ttsService.SpeakStatusAsync(status);
            }
        }
    }

    private void AnnounceMessageToScreenReader(string message)
    {
        if (!_settings.AnnounceStatusChanges)
        {
            return;
        }

        var spoken = SanitizeLogLine(message);
        if (string.IsNullOrWhiteSpace(spoken))
        {
            return;
        }

        try
        {
            if (_nvdaController.Speak(spoken))
            {
                return;
            }

            var peer = System.Windows.Automation.Peers.UIElementAutomationPeer.FromElement(StatusTextBlock)
                ?? System.Windows.Automation.Peers.UIElementAutomationPeer.CreatePeerForElement(StatusTextBlock);
            peer?.RaiseNotificationEvent(
                System.Windows.Automation.AutomationNotificationKind.ActionCompleted,
                System.Windows.Automation.AutomationNotificationProcessing.ImportantMostRecent,
                spoken,
                "OpenLinkLogMessage");
        }
        catch
        {
            // Screen reader announcement is best-effort; logs still persist.
        }
    }

    private void AnnounceStatusToScreenReader(string status, string? previousAccessibleName, string nextAccessibleName)
    {
        try
        {
            if (_nvdaController.Speak(status))
            {
                return;
            }

            var peer = System.Windows.Automation.Peers.UIElementAutomationPeer.FromElement(StatusTextBlock)
                ?? System.Windows.Automation.Peers.UIElementAutomationPeer.CreatePeerForElement(StatusTextBlock);
            if (peer is null)
            {
                return;
            }

            peer.RaisePropertyChangedEvent(
                System.Windows.Automation.AutomationElementIdentifiers.NameProperty,
                previousAccessibleName ?? string.Empty,
                nextAccessibleName);
            peer.RaiseAutomationEvent(System.Windows.Automation.Peers.AutomationEvents.LiveRegionChanged);
            peer.RaiseNotificationEvent(
                System.Windows.Automation.AutomationNotificationKind.ActionCompleted,
                System.Windows.Automation.AutomationNotificationProcessing.ImportantMostRecent,
                status,
                "OpenLinkStatus");
        }
        catch
        {
            // Screen reader announcement is best-effort; local TTS remains the fallback when enabled.
        }
    }

    private void AddLog(string message) => AddLog(message, announce: true);

    private void AddLog(string message, bool announce)
    {
        if (_settings.ShowActivityLog)
        {
            LogListBox.Items.Insert(0, message);
        }
        if (announce)
        {
            AnnounceMessageToScreenReader(message);
        }
        WriteRuntimeLog(message);
    }

    private static void WriteRuntimeLog(string message)
    {
        try
        {
            Directory.CreateDirectory(RuntimeLogDirectory);
            if (File.Exists(RuntimeLogPath) && new FileInfo(RuntimeLogPath).Length > RuntimeLogMaxBytes)
            {
                var rotatedPath = Path.Combine(RuntimeLogDirectory, $"openlink-windows-{DateTime.Now:yyyyMMdd-HHmmss}.log");
                File.Move(RuntimeLogPath, rotatedPath, overwrite: true);
            }

            var line = $"{DateTimeOffset.Now:O} {SanitizeLogLine(message)}{Environment.NewLine}";
            File.AppendAllText(RuntimeLogPath, line, Encoding.UTF8);
        }
        catch
        {
            // Logging must never interrupt remote control.
        }
    }

    private static string SanitizeLogLine(string message)
    {
        var line = string.IsNullOrWhiteSpace(message) ? "" : message.Replace("\r", " ").Replace("\n", " ");
        foreach (var key in new[] { "token", "accessToken", "authorization", "password", "secret" })
        {
            line = System.Text.RegularExpressions.Regex.Replace(
                line,
                $"(\"{key}\"\\s*:\\s*\")[^\"]+(\")",
                $"$1[redacted]$2",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        }
        return line.Length > 4000 ? line[..4000] : line;
    }

    private void PlaySound(SoundAction action)
    {
        _soundPlayer.Play(action, _settings);
    }

    private async Task CheckForUpdatesAsync(bool interactive)
    {
        if (interactive)
        {
            SetStatus("Checking for OpenLink updates.");
        }

        var updater = new OpenLinkUpdater(_settings, status => SetStatus(status), AddLog);
        await updater.CheckAsync(interactive);
    }

    private void NotifyPendingUpdateIfPresent()
    {
        var pendingUpdatePath = Path.Combine(OpenLinkSettingsStore.SettingsDirectory, "pending-update-success.txt");
        if (!File.Exists(pendingUpdatePath))
        {
            return;
        }

        try
        {
            var version = File.ReadAllText(pendingUpdatePath).Trim();
            File.Delete(pendingUpdatePath);
            if (!string.IsNullOrWhiteSpace(version))
            {
                SetStatus($"OpenLink updated to {version}.");
                ShowWhatIsNewDialog(version, GetLastWhatIsNewNotes());
            }
        }
        catch
        {
            // A stale marker should not interrupt startup.
        }
    }

    private void ShowWhatIsNewDialog(string version, string notes)
    {
        var dialog = new WhatIsNewDialog(version, notes)
        {
            Owner = this
        };
        dialog.ShowDialog();
    }

    private static string GetLastWhatIsNewVersion()
    {
        var path = Path.Combine(OpenLinkSettingsStore.SettingsDirectory, "last-whats-new-version.txt");
        if (File.Exists(path))
        {
            var version = File.ReadAllText(path).Trim();
            if (!string.IsNullOrWhiteSpace(version))
            {
                return version;
            }
        }

        return typeof(MainWindow).Assembly.GetName().Version?.ToString(3) ?? "1.7.26";
    }

    private static string GetLastWhatIsNewNotes()
    {
        var path = Path.Combine(OpenLinkSettingsStore.SettingsDirectory, "last-whats-new-notes.txt");
        if (File.Exists(path))
        {
            var notes = File.ReadAllText(path).Trim();
            if (!string.IsNullOrWhiteSpace(notes))
            {
                return notes;
            }
        }

        return CurrentWhatIsNewNotes;
    }

    private void StartAudioBridge(string reason)
    {
        _audioBridge.Start(_settings, AddLog);
        AddLog($"Audio bridge active for {reason}: {_audioBridge.StatusText}");
    }

    private object CreateLocalMachineInfo(string serverUrl)
    {
        return new
        {
            id = Environment.MachineName,
            displayName = Environment.MachineName,
            hostname = Environment.MachineName,
            aliases = GetLocalMachineAliases(),
            domainUsed = EndpointNormalizer.ShareHostFor(serverUrl),
            platform = "Windows",
            screenReader = DetectLocalScreenReader(),
            audio = new
            {
                sampleRate = 48000,
                codec = OpenLinkAudioSettings.IsCodecAvailable(_settings.AudioStreamingCodec)
                    ? OpenLinkAudioSettings.NormalizeCodec(_settings.AudioStreamingCodec)
                    : "pcm_s16le",
                requestedCodec = OpenLinkAudioSettings.NormalizeCodec(_settings.AudioStreamingCodec),
                directAudioBufferSamples = OpenLinkAudioSettings.ClampBufferSamples(_settings.DirectAudioBufferSamples),
                windowsAudioBufferSamples = OpenLinkAudioSettings.ClampBufferSamples(_settings.WindowsAudioBufferSamples)
            },
            lastSessionId = _activeSessionId
        };
    }

    private static string[] GetLocalMachineAliases()
    {
        return new[]
        {
            Environment.MachineName,
            "dom-pc-laptop",
            "Dom PC Laptop"
        };
    }

    private static object DetectLocalScreenReader()
    {
        var activeReaders = new List<string>();
        foreach (var reader in new[] { "nvda", "jfw", "narrator", "supernova", "zoomtext" })
        {
            if (Process.GetProcessesByName(reader).Length > 0)
            {
                activeReaders.Add(reader switch
                {
                    "nvda" => "NVDA",
                    "jfw" => "JAWS",
                    "narrator" => "Narrator",
                    "supernova" => "SuperNova",
                    "zoomtext" => "ZoomText",
                    _ => reader
                });
            }
        }

        return new
        {
            enabled = activeReaders.Count > 0,
            names = activeReaders,
            primary = activeReaders.FirstOrDefault() ?? "",
            localAccessibilityRoute = activeReaders.Count > 0 ? "uia-screen-reader" : "openlink-tts"
        };
    }

    private static string BuildScreenReaderConnectionMessage(MachineRecord machine)
    {
        var readerInfo = DetectLocalScreenReader();
        var primaryProperty = readerInfo.GetType().GetProperty("primary");
        var primary = primaryProperty?.GetValue(readerInfo)?.ToString();
        return string.IsNullOrWhiteSpace(primary)
            ? $"Connected to {machine.DisplayName}. No local Windows screen reader was detected, so OpenLink local TTS will be used for remote accessibility announcements when enabled."
            : $"Connected to {machine.DisplayName}. Local screen reader detected: {primary}. OpenLink accessibility announcements are enabled for the remote session.";
    }

    private object CreateConnectionPolicy()
    {
        return new
        {
            trustedOnly = _settings.RequireApprovalForNewDevices,
            dropInAllowed = _settings.AllowDropInAccess,
            autoConnectTrustedMachines = _settings.AutoConnectTrustedMachines,
            autoStartInteractionOnConnect = _settings.AutoStartInteractionOnConnect,
            remoteControlAllowed = _settings.AllowRemoteControl,
            swapControlAllowed = _settings.AllowSwapControl,
            keyboardCoUseAllowed = _settings.AllowKeyboardCoUse,
            microphoneAudioAllowed = _settings.AllowMicrophoneAudio,
            systemAudioAllowed = _settings.AllowSystemAudio,
            audioTransport = "native-wasapi",
            audioCodec = OpenLinkAudioSettings.IsCodecAvailable(_settings.AudioStreamingCodec)
                ? OpenLinkAudioSettings.NormalizeCodec(_settings.AudioStreamingCodec)
                : "pcm_s16le",
            requestedAudioCodec = OpenLinkAudioSettings.NormalizeCodec(_settings.AudioStreamingCodec),
            directAudioBufferSamples = OpenLinkAudioSettings.ClampBufferSamples(_settings.DirectAudioBufferSamples),
            windowsAudioBufferSamples = OpenLinkAudioSettings.ClampBufferSamples(_settings.WindowsAudioBufferSamples),
            voiceLinkAudioFallback = _settings.UseVoiceLinkAudioFallback,
            voiceLinkAudioFallbackUrl = _settings.VoiceLinkAudioFallbackUrl,
            clipboardAllowed = _settings.AllowClipboardSync,
            fileTransferAllowed = _settings.AllowFileTransfer,
            remoteApplicationLaunchAllowed = _settings.AllowRemoteApplicationLaunch,
            diagnosticsEnabled = _settings.EnableDiagnosticSending,
            managedMachineConfirmation = "desktop-built-in",
            companionConfirmationSupported = true,
            companionPlatform = "iOS",
            autoMuteControlledComputerAudio = _settings.AutoMuteControlledComputerAudio,
            autoMuteProcessesOnConnect = ParseProcessList(_settings.AutoMuteProcessesOnConnect)
        };
    }

    private MachineRecord? SelectedMachine => MachinesListBox.SelectedItem as MachineRecord;

    private bool IsLocalMachine(MachineRecord machine)
    {
        return string.Equals(machine.Id, Environment.MachineName, StringComparison.OrdinalIgnoreCase) ||
               string.Equals(machine.MachineHostname, Environment.MachineName, StringComparison.OrdinalIgnoreCase);
    }

    private bool IsMessageTargetedToThisMachine(JsonElement root)
    {
        var target = root.TryGetProperty("targetMachineId", out var targetElement)
            ? targetElement.GetString()
            : null;
        if (string.IsNullOrWhiteSpace(target))
        {
            return true;
        }

        return GetLocalMachineAliases()
            .Append(Environment.MachineName)
            .Any(alias => string.Equals(NormalizeMachineToken(alias), NormalizeMachineToken(target), StringComparison.Ordinal));
    }

    private static string NormalizeMachineToken(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return "";
        }

        var builder = new StringBuilder(value.Length);
        foreach (var ch in value)
        {
            if (char.IsLetterOrDigit(ch))
            {
                builder.Append(char.ToLowerInvariant(ch));
            }
        }

        return builder.ToString();
    }

    private static string? GetSourceMachineId(JsonElement root)
    {
        if (root.TryGetProperty("sourceMachineId", out var sourceElement) &&
            sourceElement.ValueKind == JsonValueKind.String)
        {
            return sourceElement.GetString();
        }

        if (root.TryGetProperty("machineInfo", out var machineInfo) &&
            machineInfo.ValueKind == JsonValueKind.Object)
        {
            if (machineInfo.TryGetProperty("id", out var idElement) && idElement.ValueKind == JsonValueKind.String)
            {
                return idElement.GetString();
            }
            if (machineInfo.TryGetProperty("machineId", out var machineIdElement) && machineIdElement.ValueKind == JsonValueKind.String)
            {
                return machineIdElement.GetString();
            }
            if (machineInfo.TryGetProperty("hostname", out var hostElement) && hostElement.ValueKind == JsonValueKind.String)
            {
                return hostElement.GetString();
            }
        }

        return null;
    }

    private MachineRecord? UpsertRemoteMachineFromMessage(JsonElement root)
    {
        if (!root.TryGetProperty("machineInfo", out var machineInfo) ||
            machineInfo.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        var id = ReadString(machineInfo, "id") ?? ReadString(machineInfo, "machineId") ?? ReadString(machineInfo, "hostname") ?? GetSourceMachineId(root);
        var displayName = ReadString(machineInfo, "displayName") ?? ReadString(machineInfo, "machineName") ?? id ?? "OpenLink machine";
        var hostname = ReadString(machineInfo, "hostname") ?? ReadString(machineInfo, "machineName") ?? id ?? displayName;
        var platform = ReadString(machineInfo, "platform") ?? ReadString(machineInfo, "os") ?? "Unknown";
        var domainUsed = ReadString(machineInfo, "domainUsed") ?? ReadString(machineInfo, "domain") ?? "";

        if (string.IsNullOrWhiteSpace(id))
        {
            return null;
        }

        var machine = _machines.FirstOrDefault(item =>
            string.Equals(NormalizeMachineToken(item.Id), NormalizeMachineToken(id), StringComparison.Ordinal) ||
            string.Equals(NormalizeMachineToken(item.MachineHostname), NormalizeMachineToken(hostname), StringComparison.Ordinal));
        if (machine is null)
        {
            machine = new MachineRecord
            {
                Id = id,
                DisplayName = displayName,
                MachineHostname = hostname,
                Platform = platform,
                DomainUsed = domainUsed,
                IsTrusted = !_settings.RequireApprovalForNewDevices,
                AllowRemoteControl = _settings.AllowRemoteControl,
                AllowDropIn = _settings.AllowDropInAccess,
                AllowKeyboardCoUse = _settings.AllowKeyboardCoUse,
                AllowMicrophoneAudio = _settings.AllowMicrophoneAudio,
                AllowSystemAudio = _settings.AllowSystemAudio
            };
            _machines.Add(machine);
        }
        else
        {
            machine.DisplayName = displayName;
            machine.MachineHostname = hostname;
            machine.Platform = platform;
            if (!string.IsNullOrWhiteSpace(domainUsed))
            {
                machine.DomainUsed = domainUsed;
            }
        }

        if (machineInfo.TryGetProperty("audio", out var audioInfo) && audioInfo.ValueKind == JsonValueKind.Object)
        {
            machine.UpdateAudioDiagnostics(
                ReadInt(audioInfo, "sampleRate"),
                ReadInt(audioInfo, "directAudioBufferSamples"),
                ReadInt(audioInfo, "windowsAudioBufferSamples"),
                ReadString(audioInfo, "codec") ?? ReadString(audioInfo, "requestedCodec"));
        }

        machine.TouchConnected(_activeSessionId);
        MachineStore.Save(_machines);
        return machine;
    }

    private static int ReadInt(JsonElement root, string propertyName)
    {
        return root.TryGetProperty(propertyName, out var element) && element.ValueKind == JsonValueKind.Number && element.TryGetInt32(out var value)
            ? value
            : 0;
    }

    private static string? ReadString(JsonElement root, string propertyName)
    {
        return root.TryGetProperty(propertyName, out var element) && element.ValueKind == JsonValueKind.String
            ? element.GetString()
            : null;
    }

    private MachineRecord? GetControllerTargetMachine()
    {
        if (SelectedMachine is { } selected && IsConnectableMachine(selected))
        {
            return selected;
        }

        return GetLastConnectableMachine();
    }

    private MachineRecord? GetLastConnectableMachine()
    {
        return GetRecentConnectableMachines(1).FirstOrDefault();
    }

    private bool IsConnectableMachine(MachineRecord machine) => !IsLocalMachine(machine);

    private MachineRecord? GetActiveRemoteMachine()
    {
        if ((_remoteInputActive || _remoteInputPending) && _remoteInputMachine is { } remoteMachine && IsConnectableMachine(remoteMachine))
        {
            return remoteMachine;
        }

        if (string.IsNullOrWhiteSpace(_activeMachineName))
        {
            return null;
        }

        return _machines.FirstOrDefault(machine =>
            IsConnectableMachine(machine) &&
            machine.IsOnline &&
            string.Equals(_activeMachineName, machine.DisplayName, StringComparison.OrdinalIgnoreCase));
    }

    private bool IsActiveRemoteSessionFor(MachineRecord machine)
    {
        if (!IsConnectableMachine(machine))
        {
            return false;
        }

        if ((_remoteInputActive || _remoteInputPending) &&
            _remoteInputMachine is { } remoteMachine &&
            SameMachine(remoteMachine, machine))
        {
            return true;
        }

        return _sessionActive &&
               machine.IsOnline &&
               !string.IsNullOrWhiteSpace(_activeMachineName) &&
               string.Equals(_activeMachineName, machine.DisplayName, StringComparison.OrdinalIgnoreCase);
    }

    private static bool SameMachine(MachineRecord first, MachineRecord second)
    {
        return string.Equals(first.Id, second.Id, StringComparison.OrdinalIgnoreCase) ||
               string.Equals(first.MachineHostname, second.MachineHostname, StringComparison.OrdinalIgnoreCase) ||
               string.Equals(first.DisplayName, second.DisplayName, StringComparison.OrdinalIgnoreCase);
    }

    private List<MachineRecord> GetRecentConnectableMachines(int limit = 6)
    {
        return _machines
            .Where(IsConnectableMachine)
            .OrderByDescending(machine => machine.IsOnline)
            .ThenByDescending(machine => machine.LastConnectedAt ?? machine.LastDisconnectedAt ?? DateTimeOffset.MinValue)
            .ThenBy(machine => machine.DisplayName)
            .Take(limit)
            .ToList();
    }

    private bool TryBlockLocalMachineAction(MachineRecord machine, string action)
    {
        if (IsConnectableMachine(machine))
        {
            return false;
        }

        SetStatus($"This is the local OpenLink device. It is online and waiting for a connection, but it cannot {action} itself. Choose a remote device instead.");
        MachinesListBox.Focus();
        return true;
    }

    private MachineRecord? FindControlledSideMachine()
    {
        var activeRemote = GetActiveRemoteMachine();

        return activeRemote is not null
            ? activeRemote
            : null;
    }

    private async Task ConnectToMachineAsync(MachineRecord machine, bool dropIn, bool? autoStartInteraction = null)
    {
        if (TryBlockLocalMachineAction(machine, "connect to"))
        {
            return;
        }

        var endpoint = EndpointNormalizer.SignalingEndpointForMachine(
            machine,
            _settings.DefaultServerUrl,
            _settings.CustomSignalingServerAccessEnabled);
        ServerCombo.Text = endpoint;
        await RefreshServiceHealthAsync(showTransitionNotifications: false);
        AnnounceConnectionStrengthIfNeeded();
        _activeMachineName = machine.DisplayName;
        machine.TouchConnected(_activeSessionId);
        MachineStore.Save(_machines);

        if (_socket?.State != WebSocketState.Open)
        {
            SetStatus($"Connecting to {machine.DisplayName} through {endpoint}...");
            await StartHostingAsync();
        }

        if (!await WaitForHostingReadyAsync(TimeSpan.FromSeconds(8)))
        {
            SetStatus($"Could not connect to {machine.DisplayName} because the OpenLink signaling backend is not ready. Keyboard stayed on this computer.");
            AddLog($"Connect to {machine.DisplayName} stopped because the signaling socket was not ready. Endpoint: {endpoint}");
            _ = SendDiagnosticEventAsync("machine_connect_request", machine, "backend_not_ready", new { endpoint = EndpointNormalizer.ShareHostFor(endpoint) });
            return;
        }

        var connectSent = await SendPeerAsync(new
        {
            type = "machine_connect_request",
            targetMachineId = machine.Id,
            dropIn,
            machineInfo = CreateLocalMachineInfo(endpoint),
            connectionPolicy = CreateConnectionPolicy()
        });

        if (!connectSent)
        {
            SetStatus($"Could not connect to {machine.DisplayName} because the OpenLink signaling socket is closed. Keyboard stayed on this computer.");
            AddLog($"machine_connect_request for {machine.DisplayName} was not sent because the signaling socket is closed.");
            _ = SendDiagnosticEventAsync("machine_connect_request", machine, "send_failed", new { endpoint = EndpointNormalizer.ShareHostFor(endpoint) });
            return;
        }

        SetStatus(dropIn
            ? $"Drop-in connect requested for {machine.DisplayName}."
            : $"Connect requested for {machine.DisplayName}.",
            announce: false);
        NotifyDeviceConnection(Environment.MachineName, machine.DisplayName, true, announce: false);
        _ = SendDiagnosticEventAsync("machine_connect_request", machine, "sent", new
        {
            dropIn,
            endpoint = EndpointNormalizer.ShareHostFor(endpoint),
            autoStartInteraction = autoStartInteraction ?? _settings.AutoStartInteractionOnConnect
        });
        _sessionActive = true;
        _audioBridge.Configure(_settings, AddLog);
        UpdateConnectedUiState();
        HideToTrayForActiveSession();

        if (autoStartInteraction ?? _settings.AutoStartInteractionOnConnect)
        {
            await StartUsingConnectedMachineAsync(machine);
        }
    }

    private async Task DisconnectMachineAsync(MachineRecord machine)
    {
        await SendPeerAsync(new
        {
            type = "disconnect_user",
            targetMachineId = machine.Id,
            sessionId = machine.LastSessionId
        });
        _ = SendDiagnosticEventAsync("disconnect_user", machine, "sent");
        machine.TouchDisconnected();
        MachineStore.Save(_machines);
        SetStatus($"Disconnect requested for {machine.DisplayName}.");
        NotifyDeviceConnection(Environment.MachineName, machine.DisplayName, false);
        if (GetActiveRemoteMachine() is null)
        {
            _sessionActive = _socket?.State == WebSocketState.Open;
            StopRemoteInputForwarding();
            _audioBridge.Stop();
            UpdateConnectedUiState();
        }
    }

    private async Task DisconnectFromDeviceAsync(MachineRecord machine)
    {
        if (TryBlockLocalMachineAction(machine, "disconnect from"))
        {
            return;
        }

        await SendPeerAsync(new
        {
            type = "controller_disconnect",
            targetMachineId = machine.Id,
            sessionId = machine.LastSessionId
        });
        _ = SendDiagnosticEventAsync("controller_disconnect", machine, "sent");
        machine.TouchDisconnected();
        MachineStore.Save(_machines);
        SetStatus($"Disconnected from {machine.DisplayName}.");
        NotifyDeviceConnection(Environment.MachineName, machine.DisplayName, false);
        _sessionActive = _socket?.State == WebSocketState.Open || GetActiveRemoteMachine() is not null;
        if (GetActiveRemoteMachine() is null)
        {
            StopRemoteInputForwarding();
            _audioBridge.Stop();
        }
        UpdateConnectedUiState();
    }

    private async Task StartUsingMachineAsync(MachineRecord machine)
    {
        if (TryBlockLocalMachineAction(machine, "start using"))
        {
            return;
        }

        if (!_sessionActive || _activeMachineName != machine.DisplayName)
        {
            await ConnectToMachineAsync(machine, machine.AllowDropIn, autoStartInteraction: false);
        }

        await StartUsingConnectedMachineAsync(machine);
    }

    private async Task StartUsingConnectedMachineAsync(MachineRecord machine)
    {
        if (TryBlockLocalMachineAction(machine, "start using"))
        {
            return;
        }

        if (_remoteInputPending || _remoteInputActive)
        {
            SetStatus($"Keyboard and audio interaction with {machine.DisplayName} is already active or starting. {InteractionShortcutHelp}");
            return;
        }

        var requestId = Guid.NewGuid().ToString("N");
        BeginRemoteInputHandshake(machine, requestId);
        _audioBridge.SetFrameSink(frame => SendRemoteAudioFrameAsync(machine, frame));

        var sent = await SendPeerAsync(new
        {
            type = "start_interaction",
            requestId,
            targetMachineId = machine.Id,
            sourceMachineId = Environment.MachineName,
            sourceMachineName = Environment.MachineName,
            sourcePlatform = "Windows",
            sourceMachineAliases = GetLocalMachineAliases(),
            machineInfo = CreateLocalMachineInfo(_activeServerUrl ?? GetServerUrl()),
            fullKeyboardControl = true,
            transmitKeyboard = true,
            captureKeyboard = true,
            keyboardCoUseAllowed = false,
            microphoneAudioAllowed = true,
            systemAudioAllowed = true,
            transmitMicrophoneAudio = true,
            transmitSystemAudio = true,
            audioAllowed = _settings.AllowAudio,
            audioDirection = "bidirectional",
            audioTransport = "native-wasapi",
            audioCodec = OpenLinkAudioSettings.IsCodecAvailable(_settings.AudioStreamingCodec)
                ? OpenLinkAudioSettings.NormalizeCodec(_settings.AudioStreamingCodec)
                : "pcm_s16le",
            requestedAudioCodec = OpenLinkAudioSettings.NormalizeCodec(_settings.AudioStreamingCodec),
            directAudioBufferSamples = OpenLinkAudioSettings.ClampBufferSamples(_settings.DirectAudioBufferSamples),
            windowsAudioBufferSamples = OpenLinkAudioSettings.ClampBufferSamples(_settings.WindowsAudioBufferSamples),
            voiceLinkAudioFallback = _settings.UseVoiceLinkAudioFallback,
            voiceLinkAudioFallbackUrl = _settings.VoiceLinkAudioFallbackUrl,
            localTtsEnabled = _settings.EnableLocalTtsHelper,
            localTtsPort = _settings.LocalTtsPort,
            localTtsFallbackMode = _settings.TtsFallbackMode,
            interactionMode = "full-keyboard-and-audio",
            connectionPolicy = CreateConnectionPolicy()
        });

        if (!sent)
        {
            StopRemoteInputForwarding("remote socket is not open");
            ShowFromTray();
            SetStatus($"Start using {machine.DisplayName} could not begin because the remote connection is not open. Keyboard stayed on this computer.");
            PlaySound(SoundAction.Error);
            _ = SendDiagnosticEventAsync("start_interaction", machine, "send_failed");
            return;
        }

        _ = SendDiagnosticEventAsync("start_interaction", machine, "sent", new
        {
            audioDirection = "bidirectional",
            audioTransport = "native-wasapi",
            audioCodec = "pcm_s16le",
            requestedAudioCodec = OpenLinkAudioSettings.NormalizeCodec(_settings.AudioStreamingCodec),
            directAudioBufferSamples = OpenLinkAudioSettings.ClampBufferSamples(_settings.DirectAudioBufferSamples),
            windowsAudioBufferSamples = OpenLinkAudioSettings.ClampBufferSamples(_settings.WindowsAudioBufferSamples),
            keyboardControl = true
        });
        SetStatus($"Waiting for {machine.DisplayName} to confirm keyboard control. Keyboard and audio remain on this computer until confirmed.");
    }

    private Task<bool> SendRemoteAudioFrameAsync(MachineRecord machine, OpenLinkAudioFrame frame)
    {
        if (_socket?.State != WebSocketState.Open)
        {
            return Task.FromResult(false);
        }

        return SendPeerAsync(new
        {
            type = "audio_frame",
            targetMachineId = machine.Id,
            sourceMachineId = Environment.MachineName,
            source = frame.Source,
            sampleRate = frame.SampleRate,
            bitsPerSample = frame.BitsPerSample,
            channels = frame.Channels,
            codec = frame.Codec,
            requestedCodec = OpenLinkAudioSettings.NormalizeCodec(_settings.AudioStreamingCodec),
            directAudioBufferSamples = OpenLinkAudioSettings.ClampBufferSamples(_settings.DirectAudioBufferSamples),
            windowsAudioBufferSamples = OpenLinkAudioSettings.ClampBufferSamples(_settings.WindowsAudioBufferSamples),
            transport = "voicelink-pcm-ws",
            virtualDeviceName = _audioBridge.VirtualDeviceName,
            data = Convert.ToBase64String(frame.Payload)
        });
    }

    private void HandleRemoteAudioFrame(JsonElement root)
    {
        var target = root.TryGetProperty("targetMachineId", out var targetElement) ? targetElement.GetString() : null;
        if (!string.IsNullOrWhiteSpace(target) &&
            !string.Equals(target, Environment.MachineName, StringComparison.OrdinalIgnoreCase) &&
            !_machines.Any(machine => string.Equals(machine.Id, target, StringComparison.OrdinalIgnoreCase) && IsLocalMachine(machine)))
        {
            return;
        }

        try
        {
            var data = root.TryGetProperty("data", out var dataElement) ? dataElement.GetString() : null;
            if (string.IsNullOrWhiteSpace(data))
            {
                return;
            }

            var frame = new OpenLinkAudioFrame(
                root.TryGetProperty("source", out var sourceElement) ? sourceElement.GetString() ?? "remote" : "remote",
                root.TryGetProperty("sampleRate", out var sampleRateElement) ? sampleRateElement.GetInt32() : 48000,
                root.TryGetProperty("bitsPerSample", out var bitsElement) ? bitsElement.GetInt32() : 16,
                root.TryGetProperty("channels", out var channelsElement) ? channelsElement.GetInt32() : 2,
                root.TryGetProperty("codec", out var codecElement) ? codecElement.GetString() ?? "pcm_s16le" : "pcm_s16le",
                Convert.FromBase64String(data));
            var sourceMachineId = root.TryGetProperty("sourceMachineId", out var sourceMachineElement)
                ? sourceMachineElement.GetString()
                : null;
            var sourceMachine = _machines.FirstOrDefault(machine =>
                string.Equals(NormalizeMachineToken(machine.Id), NormalizeMachineToken(sourceMachineId), StringComparison.Ordinal) ||
                string.Equals(NormalizeMachineToken(machine.MachineHostname), NormalizeMachineToken(sourceMachineId), StringComparison.Ordinal)) ??
                _remoteInputMachine;
            sourceMachine?.UpdateAudioDiagnostics(
                frame.SampleRate,
                root.TryGetProperty("directAudioBufferSamples", out var directElement) && directElement.TryGetInt32(out var directSamples) ? directSamples : 0,
                root.TryGetProperty("windowsAudioBufferSamples", out var windowsElement) && windowsElement.TryGetInt32(out var windowsSamples) ? windowsSamples : 0,
                frame.Codec);
            _audioBridge.PlayRemoteFrame(frame, AddLog);
        }
        catch (Exception ex)
        {
            AddLog($"Remote audio frame failed: {ex.Message}");
        }
    }

    private async Task MinimizeRemoteForLocalUseAsync(MachineRecord machine)
    {
        if (TryBlockLocalMachineAction(machine, "minimize remote connection for"))
        {
            return;
        }

        StopRemoteInputForwarding();
        await SendPeerAsync(new
        {
            type = "pause_interaction",
            targetMachineId = machine.Id,
            keepSessionAlive = true,
            muteRemoteAudio = _settings.MuteRemoteAudioWhenInactive,
            reason = "controller-returned-to-local-machine"
        });
        _ = SendDiagnosticEventAsync("pause_interaction", machine, "sent", new { muteRemoteAudio = _settings.MuteRemoteAudioWhenInactive });
        ShowFromTray();
        SetStatus(_settings.MuteRemoteAudioWhenInactive
            ? $"Remote control for {machine.DisplayName} minimized. Remote audio muted while inactive."
            : $"Remote control for {machine.DisplayName} minimized. Remote audio remains allowed.");
    }

    private async Task SwapControlAsync(MachineRecord machine)
    {
        if (TryBlockLocalMachineAction(machine, "swap control with"))
        {
            return;
        }

        await SendPeerAsync(new
        {
            type = "swap_control_request",
            targetMachineId = machine.Id,
            allowKeyboardCoUse = machine.AllowKeyboardCoUse,
            microphoneAudioAllowed = machine.AllowMicrophoneAudio,
            systemAudioAllowed = machine.AllowSystemAudio,
            autoMuteControlledComputerAudio = _settings.AutoMuteControlledComputerAudio,
            autoMuteProcessesOnConnect = ParseProcessList(_settings.AutoMuteProcessesOnConnect)
        });
        _ = SendDiagnosticEventAsync("swap_control_request", machine, "sent", new
        {
            keyboardCoUse = machine.AllowKeyboardCoUse,
            microphoneAudio = machine.AllowMicrophoneAudio,
            systemAudio = machine.AllowSystemAudio
        });
        SetStatus($"Swap control requested for {machine.DisplayName}. Both keyboards remain enabled when allowed.");
    }

    private void MachinesListBox_KeyDown(object sender, System.Windows.Input.KeyEventArgs e)
    {
        if (e.Key != Key.Enter || SelectedMachine is not { } machine)
        {
            return;
        }

        e.Handled = true;
        if (IsLocalMachine(machine))
        {
            ShowMachineDetails(machine);
            SetStatus($"This device selected: {machine.DisplayName}. Use local actions to control what remote users can access.");
            return;
        }

        _ = ConnectToMachineAsync(machine, machine.AllowDropIn);
    }

    private void MachinesListBox_MouseDoubleClick(object sender, MouseButtonEventArgs e)
    {
        if (SelectedMachine is { } machine)
        {
            if (IsLocalMachine(machine))
            {
                ShowMachineDetails(machine);
                SetStatus($"This device selected: {machine.DisplayName}. Use local actions to control what remote users can access.");
                return;
            }

            _ = ConnectToMachineAsync(machine, machine.AllowDropIn);
        }
    }

    private void MachinesListBox_PreviewMouseRightButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (FindParent<System.Windows.Controls.ListBoxItem>(e.OriginalSource as DependencyObject) is { } item)
        {
            item.IsSelected = true;
            item.Focus();
            UpdateSelectedMachineActionLabels();
        }
    }

    private void MachinesListBox_SelectionChanged(object sender, System.Windows.Controls.SelectionChangedEventArgs e)
    {
        UpdateSelectedMachineActionLabels();
    }

    private void ConnectMachineMenuItem_Click(object sender, RoutedEventArgs e)
    {
        if (SelectedMachine is { } machine)
        {
            if (TryBlockLocalMachineAction(machine, "connect to"))
            {
                return;
            }

            _ = ConnectToMachineAsync(machine, false);
        }
    }

    private void UpdateSelectedMachineActionLabels()
    {
        var selectedMachine = SelectedMachine;
        var name = selectedMachine?.DisplayNameForList;
        var localSelected = selectedMachine is not null && IsLocalMachine(selectedMachine);
        var startHeader = string.IsNullOrWhiteSpace(name) ? "Start Using Selected Device" : $"Start Using {name}";
        var disconnectHeader = string.IsNullOrWhiteSpace(name) ? "Disconnect from Selected Device" : $"Disconnect from {name}";
        var detailsHeader = localSelected ? "This Device Details" : "Machine Details";
        var applicationsHeader = localSelected ? "Local Applications" : "Running Applications";
        var selectedConnected = selectedMachine is { } selected && (selected.IsOnline || (_sessionActive && string.Equals(_activeMachineName, selected.DisplayName, StringComparison.OrdinalIgnoreCase)));
        StartUsingSelectedMenuItem.Header = startHeader;
        DisconnectFromSelectedMenuItem.Header = disconnectHeader;
        MachineDetailsMenuItem.Header = detailsHeader;
        RunningApplicationsMenuItem.Header = applicationsHeader;
        SwapSelectedMenuItem.IsEnabled = !localSelected && selectedMachine is not null;
        StartUsingSelectedMenuItem.IsEnabled = !localSelected && selectedMachine is not null;
        DisconnectFromSelectedMenuItem.IsEnabled = !localSelected && selectedMachine is not null;
        StartUsingMachineContextItem.Header = startHeader;
        DisconnectFromMachineContextItem.Header = disconnectHeader;
        MachineDetailsContextItem.Header = detailsHeader;
        RunningApplicationsContextItem.Header = applicationsHeader;
        StartUsingMachineContextItem.Visibility = !localSelected && selectedConnected ? Visibility.Visible : Visibility.Collapsed;
        ConnectMachineContextItem.Visibility = !localSelected && !selectedConnected ? Visibility.Visible : Visibility.Collapsed;
        DropInMachineContextItem.Visibility = !localSelected && !selectedConnected ? Visibility.Visible : Visibility.Collapsed;
        DisconnectFromMachineContextItem.Visibility = !localSelected && selectedMachine is not null ? Visibility.Visible : Visibility.Collapsed;
        SwapMachineContextItem.Visibility = !localSelected && selectedMachine is not null ? Visibility.Visible : Visibility.Collapsed;
        UseCanonicalDomainContextItem.Header = localSelected ? "Use Canonical Public Domain for This Device" : "Use Canonical Public Domain";
        UseTailnetDomainContextItem.Header = localSelected ? "Use Tailnet Address for This Device" : "Use Tailnet Address";
        DisconnectRemoteUserContextItem.Header = localSelected ? "Disconnect Remote User from This Device" : "Disconnect Remote User from This Device";
        UpdateSelectedMachineToggleMenuStates();
    }

    private void UpdateSelectedMachineToggleMenuStates()
    {
        var machine = SelectedMachine;
        ToggleMachineMicContextItem.IsChecked = machine?.AllowMicrophoneAudio == true;
        ToggleMachineSystemAudioContextItem.IsChecked = machine?.AllowSystemAudio == true;
        ToggleMachineDropInContextItem.IsChecked = machine?.AllowDropIn == true;
        ToggleMachineAutoConnectContextItem.IsChecked = machine?.AutoConnect == true;
        ToggleMachineRemoteControlContextItem.IsChecked = machine?.AllowRemoteControl == true;
        ToggleMachineSwapControlContextItem.IsChecked = machine?.AllowSwapControl == true;
        ToggleMachineKeyboardCoUseContextItem.IsChecked = machine?.AllowKeyboardCoUse == true;
        ToggleMachineClipboardContextItem.IsChecked = machine?.AllowClipboardSync == true;
        ToggleMachineFileTransferContextItem.IsChecked = machine?.AllowFileTransfer == true;
    }

    private void DropInMachineMenuItem_Click(object sender, RoutedEventArgs e)
    {
        if (SelectedMachine is { } machine)
        {
            if (TryBlockLocalMachineAction(machine, "drop in to"))
            {
                return;
            }

            _ = ConnectToMachineAsync(machine, true);
        }
    }

    private void DisconnectMachineMenuItem_Click(object sender, RoutedEventArgs e)
    {
        if (FindControlledSideMachine() is { } machine)
        {
            _ = DisconnectMachineAsync(machine);
        }
    }

    private void SwapControlMenuItem_Click(object sender, RoutedEventArgs e)
    {
        if (SelectedMachine is { } machine)
        {
            if (TryBlockLocalMachineAction(machine, "swap control with"))
            {
                return;
            }

            _ = SwapControlAsync(machine);
        }
    }

    private void ToggleMachineMicMenuItem_Click(object sender, RoutedEventArgs e)
    {
        if (SelectedMachine is not { } machine) return;
        machine.AllowMicrophoneAudio = !machine.AllowMicrophoneAudio;
        MachineStore.Save(_machines);
        SetStatus($"Microphone audio {(machine.AllowMicrophoneAudio ? "allowed" : "muted")} for {machine.DisplayName}.");
    }

    private void ToggleMachineSystemAudioMenuItem_Click(object sender, RoutedEventArgs e)
    {
        if (SelectedMachine is not { } machine) return;
        machine.AllowSystemAudio = !machine.AllowSystemAudio;
        MachineStore.Save(_machines);
        SetStatus($"System audio {(machine.AllowSystemAudio ? "allowed" : "muted")} for {machine.DisplayName}.");
    }

    private void ToggleMachineDropInMenuItem_Click(object sender, RoutedEventArgs e) => ToggleSelectedMachine(machine => machine.AllowDropIn = !machine.AllowDropIn, machine => $"Drop-in {(machine.AllowDropIn ? "allowed" : "requires approval")} for {machine.DisplayName}.");
    private void ToggleMachineAutoConnectMenuItem_Click(object sender, RoutedEventArgs e) => ToggleSelectedMachine(machine => machine.AutoConnect = !machine.AutoConnect, machine => $"Auto-connect {(machine.AutoConnect ? "enabled" : "disabled")} for {machine.DisplayName}.");
    private void ToggleMachineRemoteControlMenuItem_Click(object sender, RoutedEventArgs e) => ToggleSelectedMachine(machine => machine.AllowRemoteControl = !machine.AllowRemoteControl, machine => $"Remote control {(machine.AllowRemoteControl ? "allowed" : "blocked")} for {machine.DisplayName}.");
    private void ToggleMachineSwapControlMenuItem_Click(object sender, RoutedEventArgs e) => ToggleSelectedMachine(machine => machine.AllowSwapControl = !machine.AllowSwapControl, machine => $"Swap control {(machine.AllowSwapControl ? "allowed" : "blocked")} for {machine.DisplayName}.");
    private void ToggleMachineKeyboardCoUseMenuItem_Click(object sender, RoutedEventArgs e) => ToggleSelectedMachine(machine => machine.AllowKeyboardCoUse = !machine.AllowKeyboardCoUse, machine => $"Keyboard co-use {(machine.AllowKeyboardCoUse ? "allowed" : "blocked")} for {machine.DisplayName}.");
    private void ToggleMachineClipboardMenuItem_Click(object sender, RoutedEventArgs e) => ToggleSelectedMachine(machine => machine.AllowClipboardSync = !machine.AllowClipboardSync, machine => $"Clipboard sync {(machine.AllowClipboardSync ? "allowed" : "blocked")} for {machine.DisplayName}.");
    private void ToggleMachineFileTransferMenuItem_Click(object sender, RoutedEventArgs e) => ToggleSelectedMachine(machine => machine.AllowFileTransfer = !machine.AllowFileTransfer, machine => $"File transfer {(machine.AllowFileTransfer ? "allowed" : "blocked")} for {machine.DisplayName}.");

    private void OpenRemoteSettingsMenuItem_Click(object sender, RoutedEventArgs e) => SendSelectedMachineManagementAction("open_settings");
    private void LockRemoteMachineMenuItem_Click(object sender, RoutedEventArgs e) => SendSelectedMachineManagementAction("lock_machine");
    private void RestartRemoteMachineMenuItem_Click(object sender, RoutedEventArgs e) => SendSelectedMachineManagementAction("restart_machine");
    private void ShutdownRemoteMachineMenuItem_Click(object sender, RoutedEventArgs e) => SendSelectedMachineManagementAction("shutdown_machine");
    private void LogoutRemoteMachineMenuItem_Click(object sender, RoutedEventArgs e) => SendSelectedMachineManagementAction("logout_machine");

    private void SendSelectedMachineManagementAction(string action)
    {
        if (SelectedMachine is not { } machine)
        {
            return;
        }
        if (TryBlockLocalMachineAction(machine, action.Replace('_', ' ')))
        {
            return;
        }

        _ = SendRemoteMachineActionAsync(machine, action, null);
    }

    private void UseCanonicalDomainMenuItem_Click(object sender, RoutedEventArgs e) => ToggleSelectedMachine(machine => machine.DomainUsed = EndpointNormalizer.CanonicalShareHost, machine => $"Public link domain for {machine.DisplayName} set to {EndpointNormalizer.CanonicalShareHost}.");

    private void UseTailnetDomainMenuItem_Click(object sender, RoutedEventArgs e)
    {
        ToggleSelectedMachine(machine =>
        {
            if (machine.Id == "dom-pc-laptop")
            {
                machine.DomainUsed = "100.64.0.5";
            }
            else if (machine.Id == "admin-s-mac-mini")
            {
                machine.DomainUsed = "100.64.0.6";
            }
            else if (!string.IsNullOrWhiteSpace(machine.MachineHostname))
            {
                machine.DomainUsed = machine.MachineHostname;
            }
        }, machine => $"Connection domain for {machine.DisplayName} set to {machine.DomainUsed}.");
    }

    private void ToggleSelectedMachine(Action<MachineRecord> change, Func<MachineRecord, string> status)
    {
        if (SelectedMachine is not { } machine)
        {
            SetStatus("No machine is selected.");
            return;
        }

        change(machine);
        MachineStore.Save(_machines);
        UpdateSelectedMachineActionLabels();
        SetStatus(status(machine));
    }

    private void MachineDetailsMenuItem_Click(object sender, RoutedEventArgs e)
    {
        if (SelectedMachine is not { } machine) return;
        ShowMachineDetails(machine);
    }

    private void RunningApplicationsMenuItem_Click(object sender, RoutedEventArgs e)
    {
        var machine = SelectedMachine ?? _machines.FirstOrDefault(item => item.IsOnline) ?? _machines.FirstOrDefault();
        if (machine is null)
        {
            SetStatus("No machine is available.");
            return;
        }

        ShowMachineDetails(machine);
    }

    private void RemoveMachineMenuItem_Click(object sender, RoutedEventArgs e)
    {
        if (SelectedMachine is not { } machine) return;
        _machines.Remove(machine);
        MachineStore.Save(_machines);
        SetStatus($"Removed {machine.DisplayName} from machines.");
    }

    private void UpdateLocalMachineHistory(bool connected)
    {
        var local = _machines.FirstOrDefault(machine =>
            string.Equals(machine.MachineHostname, Environment.MachineName, StringComparison.OrdinalIgnoreCase) ||
            string.Equals(machine.Id, Environment.MachineName, StringComparison.OrdinalIgnoreCase));

        if (local is null)
        {
            local = new MachineRecord
            {
                Id = Environment.MachineName,
                DisplayName = Environment.MachineName,
                MachineHostname = Environment.MachineName,
                DomainUsed = EndpointNormalizer.ShareHostFor(_activeServerUrl ?? GetServerUrl()),
                Platform = "Windows",
                IsTrusted = true
            };
            _machines.Add(local);
        }

        if (connected)
        {
            local.IsOnline = true;
            local.LastSessionId = string.IsNullOrWhiteSpace(_activeSessionId) ? local.LastSessionId : _activeSessionId;
        }
        else
        {
            local.TouchDisconnected();
        }

        MachineStore.Save(_machines);
    }

    private Forms.NotifyIcon CreateTrayIcon()
    {
        var icon = new Forms.NotifyIcon
        {
            Text = "OpenLink",
            Icon = System.Drawing.SystemIcons.Application,
            Visible = true
        };
        icon.DoubleClick += (_, _) => ShowFromTray();
        return icon;
    }

    private void RebuildTrayMenu()
    {
        var activeRemoteMachine = GetActiveRemoteMachine();
        var hasActiveRemoteSession = activeRemoteMachine is not null;
        var menu = new Forms.ContextMenuStrip();
        menu.AccessibleName = "OpenLink tray menu";
        menu.AccessibleDescription = "OpenLink connection status and actions";
        AddTrayMenuItem(menu, GetTraySessionStatusText(), "OpenLink current session status", (_, _) => ShowFromTray());
        AddTrayMenuItem(menu, $"Keyboard help: {ConnectionShortcutHelp}", "Keyboard shortcuts for connection actions", (_, _) => ShowFromTray());
        AddTrayMenuItem(menu, $"Health status: {StripStatusPrefix(_serviceHealthText)}", "Refresh connection health", (_, _) => _ = RefreshServiceHealthAsync());
        AddTrayMenuItem(menu, $"Signal status: {StripStatusPrefix(_connectionStrengthText)}", "Refresh signal strength", (_, _) => _ = RefreshServiceHealthAsync());
        if (hasActiveRemoteSession && _settings.ShowElapsedConnectionTime)
        {
            AddTrayMenuItem(menu, $"Elapsed time: {GetElapsedConnectionText()}", "Elapsed connection time", (_, _) => ShowFromTray());
        }
        menu.Items.Add(new Forms.ToolStripSeparator());
        if (!hasActiveRemoteSession)
        {
            AddTrayMenuItem(menu, "Show OpenLink", "Open the main OpenLink window", (_, _) => ShowFromTray());
            var lastConnectableMachine = GetLastConnectableMachine();
            AddTrayMenuItem(menu,
                lastConnectableMachine is null ? "Connect Last Machine" : $"Connect Last Machine, {lastConnectableMachine.DisplayName}",
                lastConnectableMachine is null ? "No other machine is available; this device cannot connect to itself" : $"Connect to {lastConnectableMachine.DisplayName}",
                (_, _) =>
            {
                var machine = GetLastConnectableMachine();
                if (machine is null)
                {
                    SetStatus("No other machine is available. This device cannot connect to itself.");
                }
                else
                {
                    _ = ConnectToMachineAsync(machine, machine.AllowDropIn);
                }
            }, enabled: lastConnectableMachine is not null);
            AddTrayMenuItem(menu, "Settings", "Open OpenLink settings", (_, _) => SettingsButton_Click(this, new RoutedEventArgs()));
            menu.Items.Add(new Forms.ToolStripSeparator());
        }
        else
        {
            AddTrayMenuItem(menu, "OpenLink actions", "Connection actions", (_, _) => { }, enabled: false);
        }

        var activeMachine = activeRemoteMachine ?? (SelectedMachine is { } selected && IsConnectableMachine(selected)
            ? selected
            : _machines.FirstOrDefault(item => item.IsOnline && IsConnectableMachine(item)));
        if (activeMachine is not null)
        {
            AddTrayMenuItem(menu, $"Start Using {activeMachine.DisplayName}", "Start full keyboard control and remote audio for the selected machine", (_, _) => _ = StartUsingMachineAsync(activeMachine));
            if (IsActiveRemoteSessionFor(activeMachine))
            {
                AddTrayMenuItem(menu, "Minimize Remote Connection to Use Local Machine", "Pause active remote interaction and return focus to this local computer", (_, _) => _ = MinimizeRemoteForLocalUseAsync(activeMachine));
                AddTrayMenuItem(menu, $"Disconnect from {activeMachine.DisplayName}", "Disconnect this computer from the selected remote device", (_, _) => _ = DisconnectFromDeviceAsync(activeMachine));
            }
        }

        AddTrayMenuItem(menu, "Disconnect Remote User from This Device", "On the controlled computer, disconnect the remote user connected to this machine", (_, _) =>
        {
            var machine = FindControlledSideMachine();
            if (machine is not null)
            {
                _ = DisconnectMachineAsync(machine);
            }
            else
            {
                _ = StopHostingAsync();
            }
        });
        AddTrayMenuItem(menu, "Swap Control", "Allow the other machine to control this one while both keyboards remain available", (_, _) =>
        {
            var machine = SelectedMachine is { } selected && IsConnectableMachine(selected)
                ? selected
                : _machines.FirstOrDefault(item => item.IsOnline && IsConnectableMachine(item));
            if (machine is not null)
            {
                _ = SwapControlAsync(machine);
            }
        });
        AddTrayMenuItem(menu, "Toggle Microphone Audio", "Mute or allow microphone audio for OpenLink", (_, _) =>
        {
            _settings.AllowMicrophoneAudio = !_settings.AllowMicrophoneAudio;
            OpenLinkSettingsStore.Save(_settings);
            _audioBridge.Configure(_settings, AddLog);
            SetStatus($"Microphone audio {(_settings.AllowMicrophoneAudio ? "allowed" : "muted")}.");
        }, isChecked: _settings.AllowMicrophoneAudio);
        AddTrayMenuItem(menu, "Toggle System Audio", "Mute or allow system audio for OpenLink", (_, _) =>
        {
            _settings.AllowSystemAudio = !_settings.AllowSystemAudio;
            OpenLinkSettingsStore.Save(_settings);
            _audioBridge.Configure(_settings, AddLog);
            SetStatus($"System audio {(_settings.AllowSystemAudio ? "allowed" : "muted")}.");
        }, isChecked: _settings.AllowSystemAudio);
        AddTrayMenuItem(menu,
            "Auto-Mute Remote Audio",
            "Toggle automatic muting of remote audio when a connection starts",
            (_, _) =>
        {
            _settings.AutoMuteControlledComputerAudio = !_settings.AutoMuteControlledComputerAudio;
            OpenLinkSettingsStore.Save(_settings);
            SetStatus($"Auto-mute remote audio {(_settings.AutoMuteControlledComputerAudio ? "enabled" : "disabled")}.");
        }, isChecked: _settings.AutoMuteControlledComputerAudio);
        menu.Items.Add(new Forms.ToolStripSeparator());
        AddTrayMenuItem(menu, "Machine Details", "Show connected machine details and running applications", (_, _) =>
        {
            var machine = SelectedMachine ?? _machines.FirstOrDefault(item => item.IsOnline) ?? _machines.FirstOrDefault();
            if (machine is not null)
            {
                ShowFromTray();
                ShowMachineDetails(machine);
            }
        });
        AddTrayMenuItem(menu, "Open Remote Settings", "Open settings on the selected trusted remote machine", (_, _) =>
        {
            var machine = SelectedMachine is { } selected && IsConnectableMachine(selected)
                ? selected
                : _machines.FirstOrDefault(item => item.IsOnline && IsConnectableMachine(item));
            if (machine is not null)
            {
                _ = SendRemoteMachineActionAsync(machine, "open_settings", null);
            }
            else
            {
                SetStatus("No trusted remote machine is available for remote settings.");
            }
        }, enabled: activeMachine is not null);
        AddTrayMenuItem(menu, "Quit", "Quit OpenLink", (_, _) =>
        {
            if (TryBlockQuitForTamperProtection())
            {
                return;
            }

            _allowClose = true;
            _trayIcon.Visible = false;
            System.Windows.Application.Current.Shutdown();
        });
            _trayIcon.ContextMenuStrip = menu;
        var tooltip = hasActiveRemoteSession ? GetElapsedConnectionText() : GetTraySessionStatusText();
        _trayIcon.Text = tooltip.Length > 63 ? tooltip[..63] : tooltip;
    }

    private void ShowControllerActionsMenu()
    {
        var lastMachine = GetControllerTargetMachine();
        if (lastMachine is null)
        {
            ShowMachinesAndSettingsSurface();
            SetStatus("No remote machine is available for controller actions. Machines and settings are open.");
            return;
        }

        var menu = new Forms.ContextMenuStrip
        {
            AccessibleName = $"Controller actions for {lastMachine.DisplayName}",
            AccessibleDescription = "Actions for the connected OpenLink controller",
            RenderMode = Forms.ToolStripRenderMode.System,
            ShowImageMargin = false,
            ShowCheckMargin = true
        };
        _controllerActionsMenu?.Close();
        _controllerActionsMenu = menu;

        var hasRemoteSession = IsActiveRemoteSessionFor(lastMachine);
        if (hasRemoteSession)
        {
            AddTrayMenuItem(menu, $"Start Using {lastMachine.DisplayName}", $"Start full keyboard control and remote audio transmission for {lastMachine.DisplayName}", (_, _) => _ = StartUsingMachineAsync(lastMachine));
            AddTrayMenuItem(menu, $"Minimize Remote Connection to Use Local Machine", "Pause active remote interaction and return focus to this local computer", (_, _) => _ = MinimizeRemoteForLocalUseAsync(lastMachine));
            AddTrayMenuItem(menu, $"Disconnect from {lastMachine.DisplayName}", "Disconnect this computer from the connected device", (_, _) => _ = DisconnectFromDeviceAsync(lastMachine));
            AddTrayMenuItem(menu, $"Swap Control with {lastMachine.DisplayName}", "Let the other machine control this one while both keyboards remain available", (_, _) => _ = SwapControlAsync(lastMachine));
        }
        else
        {
            if (_settings.AutoStartInteractionOnConnect)
            {
                AddTrayMenuItem(menu, $"Start Using {lastMachine.DisplayName}", $"Connect and start full keyboard control and remote audio transmission for {lastMachine.DisplayName}", (_, _) => _ = StartUsingMachineAsync(lastMachine));
            }
            else
            {
                AddTrayMenuItem(menu, $"Connect to {lastMachine.DisplayName}", $"Connect to {lastMachine.DisplayName} in the background without starting keyboard control", (_, _) => _ = ConnectToMachineAsync(lastMachine, lastMachine.AllowDropIn));
                AddTrayMenuItem(menu, $"Start Using {lastMachine.DisplayName}", $"Connect and start full keyboard control and remote audio transmission for {lastMachine.DisplayName}", (_, _) => _ = StartUsingMachineAsync(lastMachine));
            }
            AddRecentConnectionsMenu(menu, lastMachine);
        }
        AddTrayMenuItem(menu, $"Machine Details for {lastMachine.DisplayName}", "Show device, connection, network, and application details", (_, _) => ShowMachineDetails(lastMachine));
        AddTrayMenuItem(menu, $"Running Apps and Processes on {lastMachine.DisplayName}", $"List running applications and processes on {lastMachine.DisplayName}", (_, _) => ShowMachineDetails(lastMachine));
        AddTrayMenuItem(menu, $"Open Settings on {lastMachine.DisplayName}", $"Open OpenLink settings on {lastMachine.DisplayName} if this device is trusted or owned", (_, _) => _ = SendRemoteMachineActionAsync(lastMachine, "open_settings", null));
        AddTrayMenuItem(menu, "Open Local Settings, Ctrl Comma", "Open OpenLink settings on this computer", (_, _) => SettingsButton_Click(this, new RoutedEventArgs()));
        AddRemoteAudioMenu(menu, lastMachine);
        menu.Items.Add(new Forms.ToolStripSeparator());
        AddTrayMenuItem(menu, $"Lock {lastMachine.DisplayName}", $"Lock {lastMachine.DisplayName}", (_, _) => _ = SendRemoteMachineActionAsync(lastMachine, "lock_machine", null));
        AddTrayMenuItem(menu, $"Restart {lastMachine.DisplayName}", $"Restart {lastMachine.DisplayName}", (_, _) => _ = SendRemoteMachineActionAsync(lastMachine, "restart_machine", null));
        AddTrayMenuItem(menu, $"Shut Down {lastMachine.DisplayName}", $"Shut down {lastMachine.DisplayName}", (_, _) => _ = SendRemoteMachineActionAsync(lastMachine, "shutdown_machine", null));
        AddTrayMenuItem(menu, $"Log Out {lastMachine.DisplayName}", $"Log out {lastMachine.DisplayName}", (_, _) => _ = SendRemoteMachineActionAsync(lastMachine, "logout_machine", null));
        menu.Opening += (_, _) =>
        {
            _controllerActionsMenuOpen = true;
            if (menu.Items.Count > 0)
            {
                menu.Items[0].Select();
            }
        };
        menu.KeyDown += (_, e) =>
        {
            if (e.KeyCode == Forms.Keys.Escape)
            {
                e.Handled = true;
                CloseControllerActionsMenuSilently();
            }
        };
        var owner = EnsureControllerMenuOwner();
        menu.Closed += (_, _) =>
        {
            _controllerActionsMenuOpen = false;
            if (ReferenceEquals(_controllerActionsMenu, menu))
            {
                _controllerActionsMenu = null;
            }
            if (hasRemoteSession)
            {
                HideOpenLinkWindow();
            }
            owner.Hide();
        };
        var position = GetControllerMenuPosition();
        PrepareControllerMenuOwner(owner, position);
        menu.Show(owner, new DrawingPoint(0, owner.Height));
        menu.BeginInvoke(new Action(() =>
        {
            PrepareControllerMenuOwner(owner, position);
            menu.Focus();
            if (menu.Items.Count > 0)
            {
                menu.Items[0].Select();
            }
        }));
        SetStatus(hasRemoteSession
            ? $"Controller actions for {lastMachine.DisplayName}. Use arrow keys to choose an action. Escape closes the menu and keeps OpenLink in the tray."
            : $"Connection actions for {lastMachine.DisplayName}. Use Recent Connections for another device. Escape closes the menu.");
    }

    private void AddRemoteAudioMenu(Forms.ContextMenuStrip menu, MachineRecord machine)
    {
        AddTrayMenuItem(
            menu,
            $"Audio Settings for {machine.DisplayName}",
            $"Open one dialog for microphone, system audio, volume, buffer size, and streaming format settings for {machine.DisplayName}",
            (_, _) => ShowRemoteAudioSettingsDialog(machine));
    }

    private void AddRecentConnectionsMenu(Forms.ContextMenuStrip menu, MachineRecord currentMachine)
    {
        var recentMachines = GetRecentConnectableMachines()
            .Where(machine => !SameMachine(machine, currentMachine))
            .ToList();

        if (recentMachines.Count == 0)
        {
            return;
        }

        var recentMenu = new Forms.ToolStripMenuItem("Recent Connections")
        {
            AccessibleName = "Recent connections",
            AccessibleDescription = "Recently connected OpenLink machines"
        };

        foreach (var machine in recentMachines)
        {
            var title = _settings.AutoStartInteractionOnConnect
                ? $"Start Using {machine.DisplayName}"
                : $"Connect to {machine.DisplayName}";
            var description = _settings.AutoStartInteractionOnConnect
                ? $"Connect to recent OpenLink machine {machine.DisplayName} and start keyboard control"
                : $"Connect to recent OpenLink machine {machine.DisplayName} in the background";
            var item = new Forms.ToolStripMenuItem(title)
            {
                ToolTipText = title,
                AccessibleName = title,
                AccessibleDescription = description
            };
            item.Click += (_, _) =>
            {
                if (_settings.AutoStartInteractionOnConnect)
                {
                    _ = StartUsingMachineAsync(machine);
                }
                else
                {
                    _ = ConnectToMachineAsync(machine, machine.AllowDropIn);
                }
            };
            recentMenu.DropDownItems.Add(item);
        }

        menu.Items.Add(recentMenu);
    }

    private System.Drawing.Point GetControllerMenuPosition()
    {
        var screenArea = Forms.Screen.PrimaryScreen?.WorkingArea ?? new System.Drawing.Rectangle(0, 0, 800, 600);
        if (!IsVisible || WindowState == WindowState.Minimized)
        {
            return new System.Drawing.Point(screenArea.Right - 24, screenArea.Bottom - 24);
        }

        var cursorPosition = Forms.Cursor.Position;
        return new System.Drawing.Point(
            Math.Clamp(cursorPosition.X, screenArea.Left + 8, screenArea.Right - 8),
            Math.Clamp(cursorPosition.Y, screenArea.Top + 8, screenArea.Bottom - 8));
    }

    private Forms.Form EnsureControllerMenuOwner()
    {
        if (_controllerMenuOwner is { IsDisposed: false })
        {
            return _controllerMenuOwner;
        }

        _controllerMenuOwner = new Forms.Form
        {
            FormBorderStyle = Forms.FormBorderStyle.None,
            ShowInTaskbar = false,
            StartPosition = Forms.FormStartPosition.Manual,
            Size = new System.Drawing.Size(2, 2),
            Location = new DrawingPoint(0, 0),
            Opacity = 0.01,
            TopMost = true,
            Text = "OpenLink Controller Actions"
        };
        _controllerMenuOwner.AccessibleName = "OpenLink controller actions owner";
        _controllerMenuOwner.AccessibleDescription = "Keeps OpenLink controller actions focused for keyboard and screen reader navigation.";
        return _controllerMenuOwner;
    }

    private static void PrepareControllerMenuOwner(Forms.Form owner, DrawingPoint screenPosition)
    {
        owner.Location = screenPosition;
        owner.Show();
        owner.WindowState = Forms.FormWindowState.Normal;
        owner.TopMost = true;
        ShowWindow(owner.Handle, ShowWindowCommand.ShowNormal);
        SetWindowPos(
            owner.Handle,
            HwndTopMost,
            screenPosition.X,
            screenPosition.Y,
            Math.Max(2, owner.Width),
            Math.Max(2, owner.Height),
            SetWindowPosFlags.ShowWindow);
        BringWindowToTop(owner.Handle);
        SetActiveWindow(owner.Handle);
        SetForegroundWindow(owner.Handle);
        owner.Activate();
        owner.Focus();
    }

    private async void QueueControllerActionsMenu()
    {
        if (_controllerActionsMenuQueued)
        {
            return;
        }

        _controllerActionsMenuQueued = true;
        try
        {
            if (!await WaitForControllerHotkeyReleaseAsync())
            {
                SetStatus("Release Control Alt Backslash to open OpenLink controller actions.");
                return;
            }
            await Task.Delay(_remoteInputActive || _remoteInputPending ? 40 : 120);
            if (_controllerActionsMenuOpen && _controllerActionsMenu is not null)
            {
                _controllerActionsMenu.Focus();
                return;
            }

            ShowControllerActionsMenu();
        }
        finally
        {
            _controllerActionsMenuQueued = false;
        }
    }

    private static async Task<bool> WaitForControllerHotkeyReleaseAsync()
    {
        for (var i = 0; i < 100 && IsControllerHotkeyChordDown(); i++)
        {
            await Task.Delay(25);
        }

        return !IsControllerHotkeyChordDown();
    }

    private static bool IsControllerHotkeyChordDown()
    {
        return IsKeyCurrentlyDown(VkControl) &&
               IsKeyCurrentlyDown(VkMenu) &&
               (IsKeyCurrentlyDown((int)VkOem5) || IsKeyCurrentlyDown(VkOem102));
    }

    private static bool IsKeyCurrentlyDown(int virtualKey)
    {
        return (GetAsyncKeyState(virtualKey) & unchecked((short)0x8000)) != 0;
    }

    private void CloseControllerActionsMenuSilently()
    {
        _controllerActionsMenu?.Close(Forms.ToolStripDropDownCloseReason.Keyboard);
        _controllerActionsMenuOpen = false;
        if (_remoteInputActive || _remoteInputPending)
        {
            HideOpenLinkWindow();
        }
    }

    private void ShowMachinesAndSettingsSurface()
    {
        ShowFromTray();
        MachinesListBox.Focus();
        if (MachinesListBox.SelectedItem is null && MachinesListBox.Items.Count > 0)
        {
            MachinesListBox.SelectedIndex = 0;
            MachinesListBox.ScrollIntoView(MachinesListBox.SelectedItem);
        }

        Keyboard.Focus(MachinesListBox);
        SetStatus($"Machines list open. Settings are available from the Settings button or File menu. {ConnectionShortcutHelp}");
    }

    private void ShowMachineDetails(MachineRecord machine)
    {
        var window = new MachineDetailsWindow(machine, _settings, (action, application) => SendRemoteMachineActionAsync(machine, action, application))
        {
            Owner = this
        };
        foreach (var key in GetMachineWindowKeys(machine))
        {
            _machineDetailsWindows[key] = window;
        }

        try
        {
            window.ShowDialog();
        }
        finally
        {
            foreach (var key in GetMachineWindowKeys(machine))
            {
                if (_machineDetailsWindows.TryGetValue(key, out var existing) && ReferenceEquals(existing, window))
                {
                    _machineDetailsWindows.Remove(key);
                }
            }
        }
    }

    private static IEnumerable<string> GetMachineWindowKeys(MachineRecord machine)
    {
        return new[]
        {
            machine.Id,
            machine.MachineHostname,
            machine.DisplayName
        }
            .Select(NormalizeMachineToken)
            .Where(token => !string.IsNullOrWhiteSpace(token))
            .Distinct(StringComparer.OrdinalIgnoreCase);
    }

    private async Task SendRemoteMachineActionAsync(MachineRecord machine, string action, RemoteApplicationRecord? application)
    {
        await SendPeerAsync(new
        {
            type = "machine_management_action",
            action,
            targetMachineId = machine.Id,
            application = application is null
                ? null
                : new
                {
                    processId = application.ProcessId,
                    name = application.Name,
                    path = application.Path,
                    windowTitle = application.WindowTitle
                },
            trustedOwner = machine.IsTrusted || machine.AllowDropIn || machine.AutoConnect,
            settingsScope = action == "open_settings" ? "full" : null,
            requiresApprovalIfGuest = _settings.RequireApprovalForGuestRemoteSettingsChanges,
            machineInfo = CreateLocalMachineInfo(_activeServerUrl ?? GetServerUrl()),
            connectionPolicy = CreateConnectionPolicy()
        });
        SetStatus($"Sent {action.Replace('_', ' ')} request for {machine.DisplayName}.");
    }

    private void ShowRemoteAudioSettingsDialog(MachineRecord machine)
    {
        var dialog = new RemoteAudioSettingsDialog(machine, _settings)
        {
            Owner = this
        };
        if (dialog.ShowDialog() != true)
        {
            SetStatus($"Audio settings for {machine.DisplayName} canceled.");
            return;
        }

        _settings.RemoteAudioVolumePercent = dialog.RemoteAudioVolumePercent;
        _settings.DirectAudioBufferSamples = dialog.DirectAudioBufferSamples;
        _settings.WindowsAudioBufferSamples = dialog.WindowsAudioBufferSamples;
        _settings.AudioStreamingCodec = dialog.AudioStreamingCodec;
        OpenLinkSettingsStore.Save(_settings);
        _audioBridge.Configure(_settings, AddLog);

        _ = SendRemoteAudioSettingsAsync(
            machine,
            dialog.AllowMicrophoneAudio,
            dialog.AllowSystemAudio,
            dialog.RemoteAudioVolumePercent,
            dialog.DirectAudioBufferSamples,
            dialog.WindowsAudioBufferSamples,
            dialog.AudioStreamingCodec);
    }

    private async Task SendRemoteAudioSettingsAsync(
        MachineRecord machine,
        bool? allowMicrophoneAudio,
        bool? allowSystemAudio,
        int? remoteAudioVolumePercent,
        int? directAudioBufferSamples = null,
        int? windowsAudioBufferSamples = null,
        string? audioStreamingCodec = null)
    {
        await SendPeerAsync(new
        {
            type = "machine_management_action",
            action = "set_audio_settings",
            targetMachineId = machine.Id,
            trustedOwner = machine.IsTrusted || machine.AllowDropIn || machine.AutoConnect,
            machineInfo = CreateLocalMachineInfo(_activeServerUrl ?? GetServerUrl()),
            audioSettings = new
            {
                allowMicrophoneAudio,
                allowSystemAudio,
                remoteAudioVolumePercent,
                directAudioBufferSamples,
                windowsAudioBufferSamples,
                audioStreamingCodec = OpenLinkAudioSettings.NormalizeCodec(audioStreamingCodec ?? _settings.AudioStreamingCodec)
            }
        });

        if (allowMicrophoneAudio.HasValue)
        {
            machine.AllowMicrophoneAudio = allowMicrophoneAudio.Value;
        }
        if (allowSystemAudio.HasValue)
        {
            machine.AllowSystemAudio = allowSystemAudio.Value;
        }
        if (remoteAudioVolumePercent.HasValue)
        {
            _settings.RemoteAudioVolumePercent = Math.Clamp(remoteAudioVolumePercent.Value, 0, 150);
        }
        if (directAudioBufferSamples.HasValue)
        {
            _settings.DirectAudioBufferSamples = OpenLinkAudioSettings.ClampBufferSamples(directAudioBufferSamples.Value);
        }
        if (windowsAudioBufferSamples.HasValue)
        {
            _settings.WindowsAudioBufferSamples = OpenLinkAudioSettings.ClampBufferSamples(windowsAudioBufferSamples.Value);
        }
        if (!string.IsNullOrWhiteSpace(audioStreamingCodec))
        {
            _settings.AudioStreamingCodec = OpenLinkAudioSettings.NormalizeCodec(audioStreamingCodec);
        }
        machine.UpdateAudioDiagnostics(0, _settings.DirectAudioBufferSamples, _settings.WindowsAudioBufferSamples, _settings.AudioStreamingCodec);
        MachineStore.Save(_machines);
        OpenLinkSettingsStore.Save(_settings);
        _audioBridge.Configure(_settings, AddLog);

        SetStatus($"Sent audio settings request for {machine.DisplayName}.");
    }

    private static Forms.ToolStripMenuItem AddTrayMenuItem(
        Forms.ContextMenuStrip menu,
        string text,
        string accessibleDescription,
        EventHandler onClick,
        bool enabled = true,
        bool? isChecked = null)
    {
        var item = new Forms.ToolStripMenuItem(text, image: null, onClick)
        {
            Enabled = enabled,
            Checked = isChecked == true,
            CheckOnClick = isChecked.HasValue,
            AccessibleName = text,
            AccessibleDescription = accessibleDescription,
            AccessibleRole = isChecked.HasValue
                ? System.Windows.Forms.AccessibleRole.CheckButton
                : System.Windows.Forms.AccessibleRole.MenuItem
        };
        menu.Items.Add(item);
        return item;
    }

    private string GetTraySessionStatusText()
    {
        if (_remoteInputActive && GetActiveRemoteMachine() is { } controllingMachine)
        {
            return $"OpenLink status: controlling {controllingMachine.DisplayName}";
        }

        if (GetActiveRemoteMachine() is { } activeRemoteMachine)
        {
            return $"OpenLink status: connected to {activeRemoteMachine.DisplayName}";
        }

        if (_socket?.State == WebSocketState.Open)
        {
            return "OpenLink status: online, active, waiting for a connection. Click here to connect to a remote device.";
        }

        return "OpenLink status: waiting for a connection. Click here to connect to a remote device.";
    }

    private static string StripStatusPrefix(string text)
    {
        return text
            .Replace("Connection health: ", "", StringComparison.OrdinalIgnoreCase)
            .Replace("Signal strength: ", "", StringComparison.OrdinalIgnoreCase);
    }

    private void NotifyDeviceConnection(string fromDevice, string toDevice, bool connected, bool announce = true)
    {
        var verb = connected ? "connected" : "disconnected";
        var message = connected
            ? $"Connection from {fromDevice} to {toDevice} has connected."
            : $"Connection from {fromDevice} to {toDevice} has disconnected.";
        SetStatus(message, announce);
        if (_settings.ShowConnectionNotifications)
        {
            _trayIcon.ShowBalloonTip(3000, "OpenLink", message, connected ? Forms.ToolTipIcon.Info : Forms.ToolTipIcon.Warning);
        }
        PlaySound(connected ? SoundAction.Connect : SoundAction.Disconnect);
        AddLog($"Device {verb}: {fromDevice} -> {toDevice}", announce: false);
    }

    private void UpdateConnectedUiState()
    {
        var hasActiveRemoteSession = GetActiveRemoteMachine() is not null;
        SettingsButton.Visibility = hasActiveRemoteSession ? Visibility.Collapsed : Visibility.Visible;
        SessionTextBox.IsEnabled = _socket?.State != WebSocketState.Open;
        ServerCombo.IsEnabled = _socket?.State != WebSocketState.Open;
        RebuildTrayMenu();
    }

    private void HideToTrayForActiveSession()
    {
        if (!_settings.MinimizeToTrayOnClose || !IsVisible)
        {
            return;
        }

        HideOpenLinkWindow();
        var message = GetActiveRemoteMachine() is null
            ? "OpenLink is online and waiting for a connection. Use the tray menu to connect to a remote device."
            : "Connected. Press Control Alt Backslash for controller actions. Escape closes that menu and keeps OpenLink in the tray.";
        _trayIcon.ShowBalloonTip(4000, "OpenLink", message, Forms.ToolTipIcon.Info);
    }

    private async Task RefreshServiceHealthAsync(bool showTransitionNotifications = true)
    {
        var started = DateTimeOffset.Now;
        var previousOnline = _lastServiceOnline;
        try
        {
            using var response = await GetHealthWithCanonicalFallbackAsync(GetServerUrl());
            var latency = (int)(DateTimeOffset.Now - started).TotalMilliseconds;
            _lastLatencyMs = latency;
            _serviceOnline = response.IsSuccessStatusCode;
            _serviceHealthText = _serviceOnline
                ? $"Connection health: online ({latency} ms)"
                : $"Connection health: down ({(int)response.StatusCode})";
            _connectionStrengthText = DescribeConnectionStrength(_serviceOnline, latency);
        }
        catch
        {
            _serviceOnline = false;
            _lastLatencyMs = null;
            _serviceHealthText = "Connection health: down";
            _connectionStrengthText = DescribeConnectionStrength(false, null);
        }

        HealthTextBlock.Text = _serviceHealthText;
        SignalTextBlock.Text = _connectionStrengthText;
        System.Windows.Automation.AutomationProperties.SetName(HealthTextBlock, _serviceHealthText);
        System.Windows.Automation.AutomationProperties.SetName(SignalTextBlock, _connectionStrengthText);

        if (previousOnline.HasValue &&
            previousOnline.Value != _serviceOnline &&
            showTransitionNotifications &&
            _settings.ShowOnlineOfflineNotifications)
        {
            PlaySound(_serviceOnline ? SoundAction.Online : SoundAction.Offline);
            _trayIcon.ShowBalloonTip(
                2500,
                "OpenLink",
                _serviceOnline ? "OpenLink backend is online." : "OpenLink backend is offline.",
                _serviceOnline ? Forms.ToolTipIcon.Info : Forms.ToolTipIcon.Warning);
        }

        _lastServiceOnline = _serviceOnline;
        RebuildTrayMenu();
    }

    private static async Task<HttpResponseMessage> GetHealthWithCanonicalFallbackAsync(string websocketUrl)
    {
        var healthUrl = BuildHealthUrl(websocketUrl);
        try
        {
            var response = await HealthClient.GetAsync(healthUrl);
            if (response.IsSuccessStatusCode || IsCanonicalHealthUrl(healthUrl))
            {
                return response;
            }

            response.Dispose();
        }
        catch when (!IsCanonicalHealthUrl(healthUrl))
        {
        }

        return await HealthClient.GetAsync($"https://{EndpointNormalizer.CanonicalShareHost}/health");
    }

    private static bool IsCanonicalHealthUrl(string healthUrl) =>
        Uri.TryCreate(healthUrl, UriKind.Absolute, out var uri) &&
        string.Equals(uri.Host, EndpointNormalizer.CanonicalShareHost, StringComparison.OrdinalIgnoreCase);

    private static string BuildHealthUrl(string websocketUrl)
    {
        if (!Uri.TryCreate(websocketUrl, UriKind.Absolute, out var uri))
        {
            return $"https://{EndpointNormalizer.CanonicalShareHost}/health";
        }

        var builder = new UriBuilder(uri)
        {
            Scheme = uri.Scheme == "ws" ? "http" : "https",
            Path = "health",
            Query = ""
        };
        return builder.Uri.ToString();
    }

    private void ShowFromTray()
    {
        ShowInTaskbar = true;
        Show();
        WindowState = WindowState.Normal;
        Activate();
    }

    private void HideOpenLinkWindow()
    {
        ShowInTaskbar = false;
        Hide();
    }

    private async Task ConnectToLastAutoConnectMachineAsync()
    {
        var machine = _machines
            .Where(item => item.AutoConnect && item.IsTrusted)
            .OrderByDescending(item => item.LastConnectedAt)
            .FirstOrDefault();

        if (machine is not null)
        {
            await ConnectToMachineAsync(machine, machine.AllowDropIn);
        }
    }

    private void ConfigureLaunchAtLogin()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", writable: true);
            if (key is null)
            {
                return;
            }

            foreach (var valueName in LegacyStartupValueNames)
            {
                key.DeleteValue(valueName, throwOnMissingValue: false);
            }

            if (_settings.LaunchAtLogin)
            {
                var exePath = Environment.ProcessPath ?? Process.GetCurrentProcess().MainModule?.FileName;
                if (!string.IsNullOrWhiteSpace(exePath))
                {
                    key.SetValue("OpenLink", $"\"{exePath}\"");
                }
            }
            else
            {
                key.DeleteValue("OpenLink", throwOnMissingValue: false);
            }
        }
        catch (Exception ex)
        {
            AddLog($"Launch-at-login update failed: {ex.Message}");
        }
    }

    private string GetElapsedConnectionText()
    {
        var activeRemoteMachine = GetActiveRemoteMachine();
        if (activeRemoteMachine is null)
        {
            return _socket?.State == WebSocketState.Open
                ? "OpenLink online, active, waiting for a connection"
                : "OpenLink waiting for a connection";
        }

        if (_hostingStartedAt is null)
        {
            return "Connected time unknown";
        }

        var elapsed = DateTimeOffset.Now - _hostingStartedAt.Value;
        var machineName = activeRemoteMachine.DisplayName;
        if (elapsed.TotalHours >= 1)
        {
            return $"Connected to {machineName} for {(int)elapsed.TotalHours}h {elapsed.Minutes}m";
        }

        return $"Connected to {machineName} for {Math.Max(0, elapsed.Minutes)}m {elapsed.Seconds}s";
    }

    private string DescribeConnectionStrength(bool online, int? latencyMs)
    {
        if (!online)
        {
            return "Signal strength: down";
        }

        if (latencyMs is null)
        {
            return "Signal strength: unknown";
        }

        var rating = latencyMs.Value switch
        {
            < 100 => "great",
            < 250 => "good",
            < 600 => "fair",
            _ => "poor"
        };

        return $"Signal strength: {rating} ({latencyMs.Value} ms)";
    }

    private void AnnounceConnectionStrengthIfNeeded()
    {
        if (_settings.AnnounceConnectionStrength)
        {
            SetStatus(_connectionStrengthText);
        }
    }

    private static string[] ParseProcessList(string raw)
    {
        return raw
            .Split(new[] { ',', ';', '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(item => !string.IsNullOrWhiteSpace(item))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    private void MainWindow_Closing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        if (_allowClose && TryBlockQuitForTamperProtection())
        {
            _allowClose = false;
            e.Cancel = true;
            return;
        }

        if (_allowClose || !_settings.MinimizeToTrayOnClose)
        {
            return;
        }

        e.Cancel = true;
        HideOpenLinkWindow();
        _trayIcon.ShowBalloonTip(2000, "OpenLink", "OpenLink is still running. Use the tray menu to disconnect or quit.", Forms.ToolTipIcon.Info);
    }

    private bool TryBlockQuitForTamperProtection()
    {
        if (!_settings.TamperProtectionEnabled || !HasActiveRemoteQuitLock())
        {
            return false;
        }

        const string message = "Tamper detection is active. Disconnect the owned remote session or disable tamper protection from settings before quitting OpenLink.";
        SetStatus(message);
        SystemSounds.Exclamation.Play();
        if (_trayIcon.Visible)
        {
            _trayIcon.ShowBalloonTip(4000, "OpenLink tamper protection", message, Forms.ToolTipIcon.Warning);
        }
        ShowFromTray();
        return true;
    }

    private bool HasActiveRemoteQuitLock()
    {
        return _remoteInputActive ||
               _remoteInputPending ||
               _machines.Any(machine => machine.IsOnline && IsConnectableMachine(machine));
    }

    private static T? FindParent<T>(DependencyObject? source) where T : DependencyObject
    {
        while (source is not null)
        {
            if (source is T parent)
            {
                return parent;
            }

            source = VisualTreeHelper.GetParent(source);
        }

        return null;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr SetActiveWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, ShowWindowCommand nCmdShow);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, SetWindowPosFlags flags);

    [DllImport("user32.dll")]
    private static extern bool LockWorkStation();

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr GetModuleHandle(string lpModuleName);

    private enum ShowWindowCommand
    {
        ShowNormal = 1
    }

    [Flags]
    private enum SetWindowPosFlags
    {
        ShowWindow = 0x0040
    }
}
