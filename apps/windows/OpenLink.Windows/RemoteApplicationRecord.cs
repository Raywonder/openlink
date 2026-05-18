using System.Diagnostics;

namespace OpenLink.Windows;

public sealed class RemoteApplicationRecord
{
    public int ProcessId { get; init; }
    public string Name { get; init; } = "";
    public string WindowTitle { get; init; } = "";
    public double MemoryMb { get; init; }
    public string Status { get; init; } = "";
    public DateTime? StartedAt { get; init; }
    public string Path { get; init; } = "";

    public string DisplayName => string.IsNullOrWhiteSpace(WindowTitle) ? Name : $"{Name}, {WindowTitle}";

    public string StartedText => StartedAt?.ToString("g") ?? "Unknown";

    public string AccessibleSummary =>
        $"{DisplayName}, process id {ProcessId}, memory {MemoryMb:N1} MB, status {Status}, started {StartedText}";

    public static IReadOnlyList<RemoteApplicationRecord> GetLocalApplications()
    {
        return Process.GetProcesses()
            .Select(TryCreate)
            .Where(item => item is not null)
            .Cast<RemoteApplicationRecord>()
            .OrderBy(item => item.Name, StringComparer.CurrentCultureIgnoreCase)
            .ThenBy(item => item.ProcessId)
            .ToList();
    }

    private static RemoteApplicationRecord? TryCreate(Process process)
    {
        try
        {
            var hasWindow = !string.IsNullOrWhiteSpace(process.MainWindowTitle);
            var name = process.ProcessName;
            if (!hasWindow && IsBackgroundNoise(name))
            {
                return null;
            }

            DateTime? startedAt = null;
            try { startedAt = process.StartTime; } catch { }

            var path = "";
            try { path = process.MainModule?.FileName ?? ""; } catch { }

            return new RemoteApplicationRecord
            {
                ProcessId = process.Id,
                Name = name,
                WindowTitle = process.MainWindowTitle,
                MemoryMb = process.WorkingSet64 / 1024d / 1024d,
                Status = process.Responding ? "responding" : "not responding",
                StartedAt = startedAt,
                Path = path
            };
        }
        catch
        {
            return null;
        }
        finally
        {
            process.Dispose();
        }
    }

    private static bool IsBackgroundNoise(string name)
    {
        return name.Contains("vshost", StringComparison.OrdinalIgnoreCase) ||
               name.Contains("conhost", StringComparison.OrdinalIgnoreCase) ||
               name.Contains("svchost", StringComparison.OrdinalIgnoreCase) ||
               name.Contains("runtimebroker", StringComparison.OrdinalIgnoreCase);
    }
}

public sealed class DeviceDetailItem
{
    public string Category { get; init; } = "";
    public string Name { get; init; } = "";
    public string Value { get; init; } = "";
    public string AccessibleSummary => $"{Category}, {Name}, {Value}";
}
