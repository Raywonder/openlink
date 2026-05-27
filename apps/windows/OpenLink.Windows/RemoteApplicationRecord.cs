using System.Diagnostics;
using System.Text.Json;

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
    public bool IsStatusOnly { get; init; }

    public string DisplayName => string.IsNullOrWhiteSpace(WindowTitle) ? Name : $"{Name}, {WindowTitle}";
    public string DisplayPath => IsStatusOnly ? Status : Path;
    public string DisplayMemoryText => IsStatusOnly ? "" : $"{MemoryMb:N1} MB";

    public string StartedText => StartedAt?.ToString("g") ?? "Unknown";

    public string AccessibleSummary => IsStatusOnly
        ? $"{DisplayName}, {Status}"
        : $"{DisplayName}, process id {ProcessId}, memory {MemoryMb:N1} MB, status {Status}, started {StartedText}";

    public static RemoteApplicationRecord CreateStatus(string name, string status)
    {
        return new RemoteApplicationRecord
        {
            ProcessId = 0,
            Name = name,
            Status = status,
            IsStatusOnly = true
        };
    }

    public static RemoteApplicationRecord FromJson(JsonElement element)
    {
        return new RemoteApplicationRecord
        {
            ProcessId = ReadInt(element, "processId") ?? ReadInt(element, "pid") ?? 0,
            Name = ReadString(element, "name") ?? "Application",
            WindowTitle = ReadString(element, "windowTitle") ?? "",
            MemoryMb = ReadDouble(element, "memoryMb") ?? 0,
            Status = ReadString(element, "status") ?? ReadApplicationStatus(element),
            Path = ReadString(element, "path") ?? ReadString(element, "bundleId") ?? ""
        };
    }

    public object ToPayload()
    {
        return new
        {
            processId = ProcessId,
            name = Name,
            path = Path,
            windowTitle = WindowTitle,
            memoryMb = MemoryMb,
            status = Status
        };
    }

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

    private static string? ReadString(JsonElement element, string propertyName)
    {
        return element.TryGetProperty(propertyName, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
    }

    private static int? ReadInt(JsonElement element, string propertyName)
    {
        if (!element.TryGetProperty(propertyName, out var value))
        {
            return null;
        }

        if (value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number))
        {
            return number;
        }

        if (value.ValueKind == JsonValueKind.String && int.TryParse(value.GetString(), out var parsed))
        {
            return parsed;
        }

        return null;
    }

    private static double? ReadDouble(JsonElement element, string propertyName)
    {
        if (!element.TryGetProperty(propertyName, out var value))
        {
            return null;
        }

        if (value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var number))
        {
            return number;
        }

        if (value.ValueKind == JsonValueKind.String && double.TryParse(value.GetString(), out var parsed))
        {
            return parsed;
        }

        return null;
    }

    private static string ReadApplicationStatus(JsonElement element)
    {
        var parts = new List<string>();
        if (element.TryGetProperty("isActive", out var active) && active.ValueKind is JsonValueKind.True or JsonValueKind.False)
        {
            parts.Add(active.GetBoolean() ? "active" : "not active");
        }
        if (element.TryGetProperty("isHidden", out var hidden) && hidden.ValueKind is JsonValueKind.True or JsonValueKind.False)
        {
            parts.Add(hidden.GetBoolean() ? "hidden" : "visible");
        }

        return parts.Count == 0 ? "running" : string.Join(", ", parts);
    }
}

public sealed class DeviceDetailItem
{
    public string Category { get; init; } = "";
    public string Name { get; init; } = "";
    public string Value { get; init; } = "";
    public string AccessibleSummary => $"{Category}, {Name}, {Value}";
}
