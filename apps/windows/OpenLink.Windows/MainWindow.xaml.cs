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
using System.Runtime.InteropServices;
using Microsoft.Win32;
using Forms = System.Windows.Forms;

namespace OpenLink.Windows;

public partial class MainWindow : Window
{
    private ClientWebSocket? _socket;
    private CancellationTokenSource? _socketCancellation;
    private OpenLinkSettings _settings = OpenLinkSettingsStore.Load();
    private readonly ObservableCollection<MachineRecord> _machines;
    private readonly Forms.NotifyIcon _trayIcon;
    private readonly DispatcherTimer _healthTimer;
    private readonly DispatcherTimer _elapsedTimer;
    private readonly OpenLinkAudioBridge _audioBridge = new();
    private readonly SoundActionPlayer _soundPlayer;
    private readonly SemaphoreSlim _sendLock = new(1, 1);
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
    private const int VkMenu = 0x12;
    private const int VkShift = 0x10;
    private const int VkTab = 0x09;
    private const int VkEscape = 0x1B;
    private const int VkLWin = 0x5B;
    private const int VkRWin = 0x5C;
    private const ulong MacShiftFlag = 0x20000;
    private const ulong MacControlFlag = 0x40000;
    private const ulong MacAlternateFlag = 0x80000;
    private const ulong MacCommandFlag = 0x100000;
    private const string ConnectionShortcutHelp = "Press Enter on a selected machine to connect. Press Shift F10 or the Applications key for the connection menu. Press Control Alt Backslash for controller actions. Press Control Shift Backslash to show Machines and settings. Press Alt C for the Connections menu.";
    private const string InteractionShortcutHelp = "To interact with the connected device, choose Start Using the device. Press Control Alt Backslash for controller actions. Use Minimize Remote Connection to Use Local Machine to return to this computer.";
    private static readonly string[] LegacyStartupValueNames =
    [
        "electron.app.OpenLink",
        "com.devinecreations.openlink"
    ];

    public MainWindow()
    {
        InitializeComponent();
        _soundPlayer = new SoundActionPlayer(AddLog);
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
            _audioBridge.Dispose();
            _sendLock.Dispose();
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
            ShowMachinesAndSettingsSurface();
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
            var ctrlDown = (GetAsyncKeyState(VkControl) & 0x8000) != 0;
            var altDown = (GetAsyncKeyState(VkMenu) & 0x8000) != 0;
            var shiftDown = (GetAsyncKeyState(VkShift) & 0x8000) != 0;
            var keyDown = message == WmKeydown || message == WmSyskeydown;

            if (keyDown && vkCode == VkOem5 && ctrlDown && altDown)
            {
                Dispatcher.BeginInvoke(QueueControllerActionsMenu);
                return new IntPtr(1);
            }
            if (keyDown && vkCode == VkOem5 && ctrlDown && shiftDown)
            {
                Dispatcher.BeginInvoke(ShowMachinesAndSettingsSurface);
                return new IntPtr(1);
            }
            if (keyDown && vkCode == VkEscape && _controllerActionsMenuOpen)
            {
                Dispatcher.BeginInvoke(CloseControllerActionsMenuSilently);
                return new IntPtr(1);
            }

            if (_remoteInputActive && _remoteInputMachine is not null)
            {
                if (keyDown && vkCode == VkEscape && ctrlDown && altDown)
                {
                    Dispatcher.BeginInvoke(() =>
                    {
                        StopRemoteInputForwarding("Control Alt Escape safety release");
                        SetStatus("Remote keyboard forwarding stopped. Keyboard returned to this computer.");
                        QueueControllerActionsMenu();
                    });
                    return new IntPtr(1);
                }

                if (ShouldKeepKeyLocal(vkCode, ctrlDown, altDown))
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
                return new IntPtr(1);
            }
        }

        return CallNextHookEx(_keyboardHook, nCode, wParam, lParam);
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
            Hide();
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
            _socketCancellation = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            _socket = new ClientWebSocket();
            await _socket.ConnectAsync(new Uri(serverUrl), _socketCancellation.Token);
            AddLog($"Connected to {serverUrl}");

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
                    version = "1.7.18",
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
        ConfigureLaunchAtLogin();
        SetStatus("Settings saved.");
        SettingsButton.Focus();
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

    private void QuitMenuItem_Click(object sender, RoutedEventArgs e)
    {
        _allowClose = true;
        _trayIcon.Visible = false;
        System.Windows.Application.Current.Shutdown();
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
    }

    private void HandleServerMessage(string json)
    {
        AddLog(json);

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
                break;
            case "peer_disconnected":
                var disconnectedPeerId = root.TryGetProperty("peerId", out var disconnectedPeerElement)
                    ? disconnectedPeerElement.GetString() ?? "remote device"
                    : "remote device";
                NotifyDeviceConnection(disconnectedPeerId, Environment.MachineName, false);
                StopRemoteInputForwarding("remote peer disconnected");
                break;
            case "machine_connect_ack":
                SetStatus(_remoteInputPending
                    ? "Remote machine accepted the connection. Starting keyboard and audio interaction now."
                    : _settings.AutoStartInteractionOnConnect
                        ? "Remote machine accepted the connection. Preparing keyboard and audio interaction."
                        : "Remote machine accepted the connection. Choose Start Using to begin keyboard and audio control.");
                break;
            case "start_interaction_ack":
                HandleStartInteractionAck(root);
                break;
            case "audio_frame":
                HandleRemoteAudioFrame(root);
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
                break;
            case "error":
            case "join_error":
                var message = root.TryGetProperty("message", out var messageElement)
                    ? messageElement.GetString()
                    : root.TryGetProperty("error", out var errorElement) ? errorElement.GetString() : "Unknown server error";
                SetStatus($"Server error: {message}");
                PlaySound(SoundAction.Error);
                StopRemoteInputForwarding($"server error: {message}");
                break;
        }
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
            StopRemoteInputForwarding(error);
            SetStatus($"Remote keyboard control did not start: {error}. Keyboard remains on this computer.");
            PlaySound(SoundAction.Error);
            ShowFromTray();
            return;
        }

        ActivateRemoteInputForwarding(requestId, message);
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

        SetStatus($"Hosting. Session {_activeSessionId}. {ConnectionShortcutHelp}");
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
            await Task.Delay(TimeSpan.FromSeconds(8), token);
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
            ShowFromTray();
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
        SetStatus(message ?? $"Keyboard is now being sent to {_remoteInputMachine.DisplayName}. Press Control Alt Backslash for controller actions. Press Control Alt Escape to return keyboard to this computer.");
        PlaySound(SoundAction.Connect);
        Hide();
    }

    private void StopRemoteInputForwarding(string? reason = null)
    {
        _audioBridge.SetFrameSink(null);
        _remoteInputActivationCts?.Cancel();
        _remoteInputActivationCts?.Dispose();
        _remoteInputActivationCts = null;

        if ((_remoteInputActive || _remoteInputPending) && _remoteInputMachine is not null)
        {
            AddLog(string.IsNullOrWhiteSpace(reason)
                ? $"Remote keyboard forwarding stopped for {_remoteInputMachine.DisplayName}."
                : $"Remote keyboard forwarding stopped for {_remoteInputMachine.DisplayName}: {reason}.");
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
            AddLog($"No macOS key mapping for Windows virtual key 0x{vkCode:X2}.");
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

    private static bool ShouldKeepKeyLocal(int vkCode, bool ctrlDown, bool altDown)
    {
        if (vkCode == VkLWin || vkCode == VkRWin)
        {
            return true;
        }

        if (altDown && vkCode == VkTab)
        {
            return true;
        }

        if (ctrlDown && altDown && vkCode == VkEscape)
        {
            return true;
        }

        return false;
    }

    private static ulong BuildMacModifierFlags(int vkCode, bool ctrlDown, bool altDown, bool shiftDown)
    {
        ulong flags = 0;
        if (shiftDown || vkCode == VkShift)
        {
            flags |= MacShiftFlag;
        }
        if (altDown || vkCode == VkMenu)
        {
            flags |= MacAlternateFlag;
        }
        if (ctrlDown || vkCode == VkControl)
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
        VkShift => 56,
        VkControl => 55,
        VkMenu => 58,
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
        var normalized = EndpointNormalizer.NormalizeWebSocketUrl(rawUrl);
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
        ServerCombo.Text = string.IsNullOrWhiteSpace(_settings.DefaultServerUrl)
            ? EndpointNormalizer.CanonicalWebSocketUrl
            : EndpointNormalizer.NormalizeWebSocketUrl(_settings.DefaultServerUrl);
        RebuildTrayMenu();
    }

    private void SetStatus(string status)
    {
        StatusTextBlock.Text = status;
        System.Windows.Automation.AutomationProperties.SetName(StatusTextBlock, $"Status: {status}");
        if (_settings.AnnounceStatusChanges)
        {
            AddLog(status);
        }
    }

    private void AddLog(string message)
    {
        LogListBox.Items.Insert(0, $"[{DateTime.Now:T}] {message}");
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

        var updater = new OpenLinkUpdater(_settings, SetStatus, AddLog);
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
            }
        }
        catch
        {
            // A stale marker should not interrupt startup.
        }
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
            domainUsed = EndpointNormalizer.ShareHostFor(serverUrl),
            platform = "Windows",
            lastSessionId = _activeSessionId
        };
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
            voiceLinkAudioFallback = _settings.UseVoiceLinkAudioFallback,
            voiceLinkAudioFallbackUrl = _settings.VoiceLinkAudioFallbackUrl,
            clipboardAllowed = _settings.AllowClipboardSync,
            fileTransferAllowed = _settings.AllowFileTransfer,
            remoteApplicationLaunchAllowed = _settings.AllowRemoteApplicationLaunch,
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
        return _machines
            .Where(IsConnectableMachine)
            .OrderByDescending(machine => machine.IsOnline)
            .ThenByDescending(machine => machine.LastConnectedAt)
            .FirstOrDefault();
    }

    private bool IsConnectableMachine(MachineRecord machine) => !IsLocalMachine(machine);

    private bool TryBlockLocalMachineAction(MachineRecord machine, string action)
    {
        if (IsConnectableMachine(machine))
        {
            return false;
        }

        SetStatus($"Cannot {action} {machine.DisplayName}; this is the current device. Select another machine.");
        MachinesListBox.Focus();
        return true;
    }

    private MachineRecord? FindControlledSideMachine()
    {
        var local = _machines.FirstOrDefault(item =>
            item.IsOnline &&
            (string.Equals(item.Id, Environment.MachineName, StringComparison.OrdinalIgnoreCase) ||
             string.Equals(item.MachineHostname, Environment.MachineName, StringComparison.OrdinalIgnoreCase)));

        if (local is not null)
        {
            return local;
        }

        return _sessionActive
            ? _machines.FirstOrDefault(item => item.IsOnline) ?? SelectedMachine
            : null;
    }

    private async Task ConnectToMachineAsync(MachineRecord machine, bool dropIn, bool? autoStartInteraction = null)
    {
        if (TryBlockLocalMachineAction(machine, "connect to"))
        {
            return;
        }

        var endpoint = EndpointNormalizer.SignalingEndpointForMachine(machine, _settings.DefaultServerUrl);
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
            ShowFromTray();
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
            ShowFromTray();
            return;
        }

        SetStatus(dropIn
            ? $"Drop-in connect requested for {machine.DisplayName}. {InteractionShortcutHelp}"
            : $"Connect requested for {machine.DisplayName}. {InteractionShortcutHelp}");
        NotifyDeviceConnection(Environment.MachineName, machine.DisplayName, true);
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
        machine.TouchDisconnected();
        MachineStore.Save(_machines);
        SetStatus($"Disconnect requested for {machine.DisplayName}.");
        NotifyDeviceConnection(Environment.MachineName, machine.DisplayName, false);
        if (!_machines.Any(item => item.IsOnline))
        {
            _sessionActive = false;
            StopRemoteInputForwarding();
            _audioBridge.Stop();
            UpdateConnectedUiState();
        }
    }

    private async Task DisconnectFromDeviceAsync(MachineRecord machine)
    {
        await SendPeerAsync(new
        {
            type = "controller_disconnect",
            targetMachineId = machine.Id,
            sessionId = machine.LastSessionId
        });
        machine.TouchDisconnected();
        MachineStore.Save(_machines);
        SetStatus($"Disconnected from {machine.DisplayName}.");
        NotifyDeviceConnection(Environment.MachineName, machine.DisplayName, false);
        _sessionActive = _machines.Any(item => item.IsOnline);
        if (!_sessionActive)
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
            fullKeyboardControl = true,
            transmitKeyboard = true,
            captureKeyboard = true,
            keyboardCoUseAllowed = machine.AllowKeyboardCoUse,
            microphoneAudioAllowed = true,
            systemAudioAllowed = true,
            transmitMicrophoneAudio = true,
            transmitSystemAudio = true,
            audioAllowed = _settings.AllowAudio,
            audioDirection = "bidirectional",
            audioTransport = "native-wasapi",
            voiceLinkAudioFallback = _settings.UseVoiceLinkAudioFallback,
            voiceLinkAudioFallbackUrl = _settings.VoiceLinkAudioFallbackUrl,
            interactionMode = "full-keyboard-and-audio",
            connectionPolicy = CreateConnectionPolicy()
        });

        if (!sent)
        {
            StopRemoteInputForwarding("remote socket is not open");
            ShowFromTray();
            SetStatus($"Start using {machine.DisplayName} could not begin because the remote connection is not open. Keyboard stayed on this computer.");
            PlaySound(SoundAction.Error);
            return;
        }

        StartAudioBridge($"using {machine.DisplayName}");
        SetStatus($"Start using {machine.DisplayName} requested. Waiting for the remote machine to confirm keyboard control. Keyboard remains on this computer until confirmation. {_audioBridge.StatusText}");
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
            source = frame.Source,
            sampleRate = frame.SampleRate,
            bitsPerSample = frame.BitsPerSample,
            channels = frame.Channels,
            codec = frame.Codec,
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
            _audioBridge.PlayRemoteFrame(frame, AddLog);
        }
        catch (Exception ex)
        {
            AddLog($"Remote audio frame failed: {ex.Message}");
        }
    }

    private async Task MinimizeRemoteForLocalUseAsync(MachineRecord machine)
    {
        StopRemoteInputForwarding();
        await SendPeerAsync(new
        {
            type = "pause_interaction",
            targetMachineId = machine.Id,
            keepSessionAlive = true,
            muteRemoteAudio = _settings.MuteRemoteAudioWhenInactive,
            reason = "controller-returned-to-local-machine"
        });
        ShowFromTray();
        SetStatus(_settings.MuteRemoteAudioWhenInactive
            ? $"Remote control for {machine.DisplayName} minimized. Remote audio muted while inactive."
            : $"Remote control for {machine.DisplayName} minimized. Remote audio remains allowed.");
    }

    private async Task SwapControlAsync(MachineRecord machine)
    {
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
        SetStatus($"Swap control requested for {machine.DisplayName}. Both keyboards remain enabled when allowed.");
    }

    private void MachinesListBox_KeyDown(object sender, System.Windows.Input.KeyEventArgs e)
    {
        if (e.Key != Key.Enter || SelectedMachine is not { } machine)
        {
            return;
        }

        e.Handled = true;
        if (TryBlockLocalMachineAction(machine, "connect to"))
        {
            return;
        }

        _ = ConnectToMachineAsync(machine, machine.AllowDropIn);
    }

    private void MachinesListBox_MouseDoubleClick(object sender, MouseButtonEventArgs e)
    {
        if (SelectedMachine is { } machine)
        {
            if (TryBlockLocalMachineAction(machine, "connect to"))
            {
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
        var name = SelectedMachine?.DisplayName;
        var startHeader = string.IsNullOrWhiteSpace(name) ? "Start Using Selected Device" : $"Start Using {name}";
        var disconnectHeader = string.IsNullOrWhiteSpace(name) ? "Disconnect from Selected Device" : $"Disconnect from {name}";
        var selectedConnected = SelectedMachine is { } selected && (selected.IsOnline || (_sessionActive && string.Equals(_activeMachineName, selected.DisplayName, StringComparison.OrdinalIgnoreCase)));
        StartUsingSelectedMenuItem.Header = startHeader;
        DisconnectFromSelectedMenuItem.Header = disconnectHeader;
        StartUsingMachineContextItem.Header = startHeader;
        DisconnectFromMachineContextItem.Header = disconnectHeader;
        StartUsingMachineContextItem.Visibility = selectedConnected ? Visibility.Visible : Visibility.Collapsed;
        ConnectMachineContextItem.Visibility = selectedConnected ? Visibility.Collapsed : Visibility.Visible;
        DropInMachineContextItem.Visibility = selectedConnected ? Visibility.Collapsed : Visibility.Visible;
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
            _activeMachineName = local.DisplayName;
            local.TouchConnected(_activeSessionId);
        }
        else if (_hostingStartedAt is not null)
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
        var menu = new Forms.ContextMenuStrip();
        menu.AccessibleName = "OpenLink tray menu";
        menu.AccessibleDescription = "OpenLink connection status and actions";
        AddTrayMenuItem(menu, GetTraySessionStatusText(), "OpenLink current session status", (_, _) => ShowFromTray());
        AddTrayMenuItem(menu, $"Keyboard help: {ConnectionShortcutHelp}", "Keyboard shortcuts for connection actions", (_, _) => ShowFromTray());
        AddTrayMenuItem(menu, $"Health status: {StripStatusPrefix(_serviceHealthText)}", "Refresh connection health", (_, _) => _ = RefreshServiceHealthAsync());
        AddTrayMenuItem(menu, $"Signal status: {StripStatusPrefix(_connectionStrengthText)}", "Refresh signal strength", (_, _) => _ = RefreshServiceHealthAsync());
        if (_sessionActive && _settings.ShowElapsedConnectionTime)
        {
            AddTrayMenuItem(menu, $"Elapsed time: {GetElapsedConnectionText()}", "Elapsed connection time", (_, _) => ShowFromTray());
        }
        menu.Items.Add(new Forms.ToolStripSeparator());
        if (!_sessionActive)
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

        var activeMachine = SelectedMachine is { } selected && IsConnectableMachine(selected)
            ? selected
            : _machines.FirstOrDefault(item => item.IsOnline && IsConnectableMachine(item));
        if (activeMachine is not null)
        {
            AddTrayMenuItem(menu, $"Start Using {activeMachine.DisplayName}", "Start full keyboard control and remote audio for the selected machine", (_, _) => _ = StartUsingMachineAsync(activeMachine));
            if (_sessionActive || activeMachine.IsOnline)
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
        AddTrayMenuItem(menu, "Quit", "Quit OpenLink", (_, _) =>
        {
            _allowClose = true;
            _trayIcon.Visible = false;
            System.Windows.Application.Current.Shutdown();
        });
            _trayIcon.ContextMenuStrip = menu;
        var tooltip = _sessionActive ? GetElapsedConnectionText() : _serviceHealthText;
        _trayIcon.Text = tooltip.Length > 63 ? tooltip[..63] : tooltip;
    }

    private void ShowControllerActionsMenu()
    {
        var lastMachine = GetControllerTargetMachine();
        if (lastMachine is null)
        {
            ShowFromTray();
            SetStatus("No remote machine is available for controller actions. The Machines list is open.");
            return;
        }

        var menu = new Forms.ContextMenuStrip
        {
            AccessibleName = $"Controller actions for {lastMachine.DisplayName}",
            AccessibleDescription = "Actions for the connected OpenLink controller"
        };
        _controllerActionsMenu?.Close();
        _controllerActionsMenu = menu;

        if (_sessionActive || lastMachine.IsOnline)
        {
            AddTrayMenuItem(menu, $"Start Using {lastMachine.DisplayName}", $"Start full keyboard control and remote audio transmission for {lastMachine.DisplayName}", (_, _) => _ = StartUsingMachineAsync(lastMachine));
            AddTrayMenuItem(menu, $"Minimize Remote Connection to Use Local Machine", "Pause active remote interaction and return focus to this local computer", (_, _) => _ = MinimizeRemoteForLocalUseAsync(lastMachine));
            AddTrayMenuItem(menu, $"Disconnect from {lastMachine.DisplayName}", "Disconnect this computer from the connected device", (_, _) => _ = DisconnectFromDeviceAsync(lastMachine));
            AddTrayMenuItem(menu, $"Swap Control with {lastMachine.DisplayName}", "Let the other machine control this one while both keyboards remain available", (_, _) => _ = SwapControlAsync(lastMachine));
        }
        else
        {
            AddTrayMenuItem(menu, $"Connect Last Machine, {lastMachine.DisplayName}", $"Connect to {lastMachine.DisplayName}", (_, _) => _ = ConnectLastMachineAsync());
        }
        AddTrayMenuItem(menu, $"Machine Details for {lastMachine.DisplayName}", "Show device, connection, network, and application details", (_, _) => ShowMachineDetails(lastMachine));
        menu.Items.Add(new Forms.ToolStripSeparator());
        AddTrayMenuItem(menu, "Toggle Microphone Audio", "Mute or allow microphone audio for OpenLink", (_, _) =>
        {
            lastMachine.AllowMicrophoneAudio = !lastMachine.AllowMicrophoneAudio;
            MachineStore.Save(_machines);
            SetStatus($"Microphone audio {(lastMachine.AllowMicrophoneAudio ? "allowed" : "muted")} for {lastMachine.DisplayName}.");
        }, isChecked: lastMachine.AllowMicrophoneAudio);
        AddTrayMenuItem(menu, "Toggle System Audio", "Mute or allow system audio for OpenLink", (_, _) =>
        {
            lastMachine.AllowSystemAudio = !lastMachine.AllowSystemAudio;
            MachineStore.Save(_machines);
            SetStatus($"System audio {(lastMachine.AllowSystemAudio ? "allowed" : "muted")} for {lastMachine.DisplayName}.");
        }, isChecked: lastMachine.AllowSystemAudio);

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
        menu.Closed += (_, _) =>
        {
            _controllerActionsMenuOpen = false;
            if (ReferenceEquals(_controllerActionsMenu, menu))
            {
                _controllerActionsMenu = null;
            }
            if (_sessionActive)
            {
                Hide();
            }
        };
        SetForegroundWindow(_windowHandle);
        var screenArea = Forms.Screen.PrimaryScreen?.WorkingArea ?? new System.Drawing.Rectangle(0, 0, 800, 600);
        var cursorPosition = Forms.Cursor.Position;
        var position = new System.Drawing.Point(
            Math.Clamp(cursorPosition.X, screenArea.Left + 8, screenArea.Right - 8),
            Math.Clamp(cursorPosition.Y, screenArea.Top + 8, screenArea.Bottom - 8));
        menu.Show(position);
        menu.Focus();
        if (menu.Items.Count > 0)
        {
            menu.Items[0].Select();
        }
        SetStatus($"Controller actions for {lastMachine.DisplayName}. Use arrow keys to choose an action. Escape closes the menu and keeps OpenLink in the tray.");
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
            await Task.Delay(180);
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

    private void CloseControllerActionsMenuSilently()
    {
        _controllerActionsMenu?.Close(Forms.ToolStripDropDownCloseReason.Keyboard);
        _controllerActionsMenuOpen = false;
        if (_sessionActive)
        {
            Hide();
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
        window.ShowDialog();
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
            machineInfo = CreateLocalMachineInfo(_activeServerUrl ?? GetServerUrl()),
            connectionPolicy = CreateConnectionPolicy()
        });
        SetStatus($"Sent {action.Replace('_', ' ')} request for {machine.DisplayName}.");
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
        if (_sessionActive)
        {
            var machineName = string.IsNullOrWhiteSpace(_activeMachineName) ? "a remote machine" : _activeMachineName;
            return $"Session status: connected to {machineName}";
        }

        if (_socket?.State == WebSocketState.Open)
        {
            return "Session status: hosting";
        }

        return "Session status: not connected";
    }

    private static string StripStatusPrefix(string text)
    {
        return text
            .Replace("Connection health: ", "", StringComparison.OrdinalIgnoreCase)
            .Replace("Signal strength: ", "", StringComparison.OrdinalIgnoreCase);
    }

    private void NotifyDeviceConnection(string fromDevice, string toDevice, bool connected)
    {
        var verb = connected ? "connected" : "disconnected";
        var message = connected
            ? $"Connection from {fromDevice} to {toDevice} has connected."
            : $"Connection from {fromDevice} to {toDevice} has disconnected.";
        SetStatus(message);
        if (_settings.ShowConnectionNotifications)
        {
            _trayIcon.ShowBalloonTip(3000, "OpenLink", message, connected ? Forms.ToolTipIcon.Info : Forms.ToolTipIcon.Warning);
        }
        PlaySound(connected ? SoundAction.Connect : SoundAction.Disconnect);
        AddLog($"Device {verb}: {fromDevice} -> {toDevice}");
    }

    private void UpdateConnectedUiState()
    {
        SettingsButton.Visibility = _sessionActive ? Visibility.Collapsed : Visibility.Visible;
        SessionTextBox.IsEnabled = !_sessionActive;
        ServerCombo.IsEnabled = !_sessionActive;
        RebuildTrayMenu();
    }

    private void HideToTrayForActiveSession()
    {
        if (!_settings.MinimizeToTrayOnClose || !IsVisible)
        {
            return;
        }

        Hide();
        _trayIcon.ShowBalloonTip(4000, "OpenLink", $"Connected. Press Control Alt Backslash for controller actions. Escape closes that menu and keeps OpenLink in the tray.", Forms.ToolTipIcon.Info);
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
        Show();
        WindowState = WindowState.Normal;
        Activate();
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
        if (_hostingStartedAt is null)
        {
            return "Connected time unknown";
        }

        var elapsed = DateTimeOffset.Now - _hostingStartedAt.Value;
        var machineName = string.IsNullOrWhiteSpace(_activeMachineName) ? "current machine" : _activeMachineName;
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
        if (_allowClose || !_settings.MinimizeToTrayOnClose)
        {
            return;
        }

        e.Cancel = true;
        Hide();
        _trayIcon.ShowBalloonTip(2000, "OpenLink", "OpenLink is still running. Use the tray menu to disconnect or quit.", Forms.ToolTipIcon.Info);
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

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr GetModuleHandle(string lpModuleName);
}
