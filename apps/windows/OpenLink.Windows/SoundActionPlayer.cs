using System.IO;
using System.Media;

namespace OpenLink.Windows;

public enum SoundAction
{
    Connect,
    Disconnect,
    DropIn,
    HostingStarted,
    HostingStopped,
    MessageReceived,
    Notification,
    Online,
    Offline,
    Reconnected,
    Error
}

public sealed class SoundActionPlayer
{
    private static readonly IReadOnlyDictionary<SoundAction, string> SoundFiles = new Dictionary<SoundAction, string>
    {
        [SoundAction.Connect] = "connected.wav",
        [SoundAction.Disconnect] = "disconnect.wav",
        [SoundAction.DropIn] = "dropin.wav",
        [SoundAction.HostingStarted] = "success.wav",
        [SoundAction.HostingStopped] = "hosting-stopped.wav",
        [SoundAction.MessageReceived] = "message-received.wav",
        [SoundAction.Notification] = "notification.wav",
        [SoundAction.Online] = "online.wav",
        [SoundAction.Offline] = "offline.wav",
        [SoundAction.Reconnected] = "reconnected.wav",
        [SoundAction.Error] = "error.wav"
    };

    private readonly Action<string>? _log;

    public SoundActionPlayer(Action<string>? log = null)
    {
        _log = log;
    }

    public void Play(SoundAction action, OpenLinkSettings settings)
    {
        if (!settings.SoundAlerts || !SoundFiles.TryGetValue(action, out var fileName))
        {
            return;
        }

        var path = Path.Combine(AppContext.BaseDirectory, "Assets", "Sounds", fileName);
        if (!File.Exists(path))
        {
            _log?.Invoke($"Sound asset missing for {action}: {path}");
            return;
        }

        try
        {
            var player = new SoundPlayer(path);
            player.Play();
        }
        catch (Exception ex)
        {
            _log?.Invoke($"Sound asset failed for {action}: {ex.Message}");
        }
    }
}
