using System.ComponentModel;
using System.IO;
using System.Runtime.CompilerServices;
using System.Text.Json;

namespace OpenLink.Windows;

public sealed class MachineRecord : INotifyPropertyChanged
{
    private bool _isOnline;
    private bool _allowDropIn;
    private bool _autoConnect;
    private bool _allowRemoteControl;
    private bool _allowSwapControl;
    private bool _allowKeyboardCoUse;
    private bool _allowMicrophoneAudio;
    private bool _allowSystemAudio;

    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string DisplayName { get; set; } = "Remote machine";
    public string MachineHostname { get; set; } = "";
    public string DomainUsed { get; set; } = EndpointNormalizer.CanonicalShareHost;
    public string Platform { get; set; } = "Unknown";
    public DateTimeOffset? LastConnectedAt { get; set; }
    public DateTimeOffset? LastDisconnectedAt { get; set; }
    public long LastDurationSeconds { get; set; }
    public string? LastSessionId { get; set; }
    public bool IsTrusted { get; set; }
    public bool AllowClipboardSync { get; set; } = true;
    public bool AllowFileTransfer { get; set; } = true;
    public string? Notes { get; set; }

    public bool IsOnline
    {
        get => _isOnline;
        set => SetField(ref _isOnline, value);
    }

    public bool AllowDropIn
    {
        get => _allowDropIn;
        set => SetField(ref _allowDropIn, value);
    }

    public bool AutoConnect
    {
        get => _autoConnect;
        set => SetField(ref _autoConnect, value);
    }

    public bool AllowRemoteControl
    {
        get => _allowRemoteControl;
        set => SetField(ref _allowRemoteControl, value);
    }

    public bool AllowSwapControl
    {
        get => _allowSwapControl;
        set => SetField(ref _allowSwapControl, value);
    }

    public bool AllowKeyboardCoUse
    {
        get => _allowKeyboardCoUse;
        set => SetField(ref _allowKeyboardCoUse, value);
    }

    public bool AllowMicrophoneAudio
    {
        get => _allowMicrophoneAudio;
        set => SetField(ref _allowMicrophoneAudio, value);
    }

    public bool AllowSystemAudio
    {
        get => _allowSystemAudio;
        set => SetField(ref _allowSystemAudio, value);
    }

    public string LastConnectedText => LastConnectedAt?.LocalDateTime.ToString("g") ?? "Never";
    public string LastDurationText => LastDurationSeconds <= 0 ? "No duration" : FormatDuration(LastDurationSeconds);
    public string DropInText => AllowDropIn ? "Drop-in allowed" : "Approval required";
    public string AudioText => $"Mic {(AllowMicrophoneAudio ? "on" : "off")}, system {(AllowSystemAudio ? "on" : "off")}";
    public bool IsThisDevice =>
        string.Equals(Id, Environment.MachineName, StringComparison.OrdinalIgnoreCase) ||
        string.Equals(MachineHostname, Environment.MachineName, StringComparison.OrdinalIgnoreCase);
    public string DisplayNameForList => IsThisDevice ? $"This device, {DisplayName}" : DisplayName;
    public string ConnectionActionHelp => IsThisDevice
        ? "This is the device you are using. Press Enter for local device details and use the context menu to change what remote users can access."
        : "Press Enter to connect. Press Shift F10 or the context menu key for machine actions.";
    public string AccessibleSummary => $"{DisplayNameForList}, {Platform}, host {MachineHostname}, last connected {LastConnectedText}, duration {LastDurationText}, {DropInText}, {AudioText}, {(IsOnline ? "online" : "offline")}";

    public event PropertyChangedEventHandler? PropertyChanged;

    public void TouchConnected(string? sessionId = null)
    {
        LastConnectedAt = DateTimeOffset.Now;
        LastSessionId = string.IsNullOrWhiteSpace(sessionId) ? LastSessionId : sessionId;
        IsOnline = true;
        OnPropertyChanged(nameof(LastConnectedText));
        OnPropertyChanged(nameof(AccessibleSummary));
    }

    public void TouchDisconnected()
    {
        LastDisconnectedAt = DateTimeOffset.Now;
        if (LastConnectedAt is { } connected)
        {
            LastDurationSeconds = Math.Max(1, (long)(LastDisconnectedAt.Value - connected).TotalSeconds);
        }

        IsOnline = false;
        OnPropertyChanged(nameof(LastDurationText));
        OnPropertyChanged(nameof(AccessibleSummary));
    }

    private static string FormatDuration(long seconds)
    {
        var span = TimeSpan.FromSeconds(seconds);
        if (span.TotalHours >= 1)
        {
            return $"{(int)span.TotalHours}h {span.Minutes}m";
        }

        if (span.TotalMinutes >= 1)
        {
            return $"{span.Minutes}m {span.Seconds}s";
        }

        return $"{span.Seconds}s";
    }

    private void SetField<T>(ref T field, T value, [CallerMemberName] string? propertyName = null)
    {
        if (EqualityComparer<T>.Default.Equals(field, value))
        {
            return;
        }

        field = value;
        OnPropertyChanged(propertyName);
        OnPropertyChanged(nameof(DropInText));
        OnPropertyChanged(nameof(AudioText));
        OnPropertyChanged(nameof(DisplayNameForList));
        OnPropertyChanged(nameof(ConnectionActionHelp));
        OnPropertyChanged(nameof(AccessibleSummary));
    }

    private void OnPropertyChanged([CallerMemberName] string? propertyName = null)
    {
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
    }
}

public static class MachineStore
{
    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        WriteIndented = true
    };

    public static string MachinesPath { get; } = Path.Combine(OpenLinkSettingsStore.SettingsDirectory, "machines.native.json");
    public static string LegacyMachinesPath { get; } = Path.Combine(OpenLinkSettingsStore.LegacySettingsDirectory, "machines.native.json");

    public static List<MachineRecord> Load()
    {
        try
        {
            var machinesPath = File.Exists(MachinesPath) ? MachinesPath : LegacyMachinesPath;
            if (!File.Exists(machinesPath))
            {
                return SeedTrustedPair();
            }

            var json = File.ReadAllText(machinesPath);
            var machines = JsonSerializer.Deserialize<List<MachineRecord>>(json, SerializerOptions) ?? [];
            MergeSeedTrustedPair(machines);
            return machines;
        }
        catch
        {
            return SeedTrustedPair();
        }
    }

    public static void Save(IEnumerable<MachineRecord> machines)
    {
        Directory.CreateDirectory(OpenLinkSettingsStore.SettingsDirectory);
        var json = JsonSerializer.Serialize(machines, SerializerOptions);
        File.WriteAllText(MachinesPath, json);
    }

    private static List<MachineRecord> SeedTrustedPair()
    {
        var machines = new List<MachineRecord>();
        MergeSeedTrustedPair(machines);
        return machines;
    }

    private static void MergeSeedTrustedPair(ICollection<MachineRecord> machines)
    {
        AddIfMissing(machines, new MachineRecord
        {
            Id = "dom-pc-laptop",
            DisplayName = "Dom PC Laptop",
            MachineHostname = "dom-pc-laptop",
            DomainUsed = "100.64.0.5",
            Platform = "Windows",
            IsTrusted = true,
            AllowDropIn = true,
            AutoConnect = true,
            AllowRemoteControl = true,
            AllowSwapControl = true,
            AllowKeyboardCoUse = true,
            AllowMicrophoneAudio = true,
            AllowSystemAudio = true,
            AllowClipboardSync = true,
            AllowFileTransfer = true,
            Notes = "Approved local profile seed for mutual Windows and Mac mini access."
        });

        AddIfMissing(machines, new MachineRecord
        {
            Id = "admin-s-mac-mini",
            DisplayName = "Admin's Mac mini",
            MachineHostname = "admin-s-mac-mini",
            DomainUsed = "100.64.0.6",
            Platform = "macOS",
            IsTrusted = true,
            AllowDropIn = true,
            AutoConnect = true,
            AllowRemoteControl = true,
            AllowSwapControl = true,
            AllowKeyboardCoUse = true,
            AllowMicrophoneAudio = true,
            AllowSystemAudio = true,
            AllowClipboardSync = true,
            AllowFileTransfer = true,
            Notes = "Approved local profile seed for mutual Windows and Mac mini access."
        });
    }

    private static void AddIfMissing(ICollection<MachineRecord> machines, MachineRecord candidate)
    {
        if (machines.Any(machine =>
                string.Equals(machine.Id, candidate.Id, StringComparison.OrdinalIgnoreCase) ||
                string.Equals(machine.MachineHostname, candidate.MachineHostname, StringComparison.OrdinalIgnoreCase)))
        {
            return;
        }

        machines.Add(candidate);
    }
}

public static class EndpointNormalizer
{
    public const string CanonicalWebSocketUrl = "wss://openlink.tappedin.fm/ws";
    public const string CanonicalShareHost = "openlink.tappedin.fm";
    public static readonly string[] ApprovedWebSocketUrls =
    [
        "wss://openlink.tappedin.fm/ws",
        "wss://openlink.raywonderis.me/ws",
        "wss://openlink.devinecreations.net/ws",
        "wss://openlink.devine-creations.com/ws"
    ];

    public static string NormalizeWebSocketUrl(string? value, bool allowCustomServer = false)
    {
        var text = string.IsNullOrWhiteSpace(value) ? CanonicalWebSocketUrl : value.Trim();

        if (!text.Contains("://", StringComparison.Ordinal))
        {
            text = $"wss://{text}";
        }

        if (!Uri.TryCreate(text, UriKind.Absolute, out var uri))
        {
            return CanonicalWebSocketUrl;
        }

        if (uri.Host.StartsWith("dvc.", StringComparison.OrdinalIgnoreCase))
        {
            return CanonicalWebSocketUrl;
        }

        var builder = new UriBuilder(uri)
        {
            Scheme = uri.Scheme is "ws" or "wss" ? uri.Scheme : uri.Scheme == "http" ? "ws" : "wss"
        };

        if (string.IsNullOrWhiteSpace(builder.Path) || builder.Path == "/")
        {
            builder.Path = "ws";
        }

        var normalized = builder.Uri.ToString();
        return allowCustomServer || IsApprovedDefaultWebSocketUrl(normalized)
            ? normalized
            : CanonicalWebSocketUrl;
    }

    public static string SignalingEndpointForMachine(MachineRecord machine, string? preferredServerUrl, bool allowCustomServer = false)
    {
        if (IsBackendHost(machine.DomainUsed, allowCustomServer))
        {
            return NormalizeWebSocketUrl(machine.DomainUsed, allowCustomServer);
        }

        return NormalizeWebSocketUrl(preferredServerUrl, allowCustomServer);
    }

    public static string ShareHostFor(string websocketUrl)
    {
        if (!Uri.TryCreate(websocketUrl, UriKind.Absolute, out var uri))
        {
            return CanonicalShareHost;
        }

        return uri.Host.StartsWith("dvc.", StringComparison.OrdinalIgnoreCase)
            ? CanonicalShareHost
            : uri.Host;
    }

    public static bool IsApprovedDefaultWebSocketUrl(string? value)
    {
        var normalized = NormalizeWebSocketUrlForComparison(value);
        return ApprovedWebSocketUrls.Any(url => string.Equals(url, normalized, StringComparison.OrdinalIgnoreCase));
    }

    private static string NormalizeWebSocketUrlForComparison(string? value)
    {
        var text = string.IsNullOrWhiteSpace(value) ? CanonicalWebSocketUrl : value.Trim();
        if (!text.Contains("://", StringComparison.Ordinal))
        {
            text = $"wss://{text}";
        }

        if (!Uri.TryCreate(text, UriKind.Absolute, out var uri))
        {
            return CanonicalWebSocketUrl;
        }

        var builder = new UriBuilder(uri)
        {
            Scheme = uri.Scheme is "ws" or "wss" ? uri.Scheme : uri.Scheme == "http" ? "ws" : "wss"
        };
        if (string.IsNullOrWhiteSpace(builder.Path) || builder.Path == "/")
        {
            builder.Path = "ws";
        }

        return builder.Uri.ToString();
    }

    private static bool IsBackendHost(string? value, bool allowCustomServer = false)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return false;
        }

        var text = value.Trim();
        if (!text.Contains("://", StringComparison.Ordinal))
        {
            text = $"wss://{text}";
        }

        if (!Uri.TryCreate(text, UriKind.Absolute, out var uri))
        {
            return false;
        }

        if (System.Net.IPAddress.TryParse(uri.Host, out _))
        {
            return allowCustomServer;
        }

        return allowCustomServer || ApprovedWebSocketUrls.Any(url =>
            Uri.TryCreate(url, UriKind.Absolute, out var approved) &&
            string.Equals(approved.Host, uri.Host, StringComparison.OrdinalIgnoreCase));
    }
}
