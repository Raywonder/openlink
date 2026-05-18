using System.ComponentModel;
using System.Diagnostics;
using System.Windows;

namespace OpenLink.Windows;

/// <summary>
/// Interaction logic for App.xaml
/// </summary>
public partial class App : System.Windows.Application
{
    private const string SingleInstanceMutexName = @"Global\OpenLink.Windows.SingleInstance";
    private static Mutex? _singleInstanceMutex;

    protected override void OnStartup(StartupEventArgs e)
    {
        ForceCloseOtherOpenLinkProcesses();

        _singleInstanceMutex = new Mutex(true, SingleInstanceMutexName, out var ownsSingleInstance);
        if (!ownsSingleInstance)
        {
            ForceCloseOtherOpenLinkProcesses();
            _singleInstanceMutex.Dispose();
            _singleInstanceMutex = new Mutex(true, SingleInstanceMutexName, out ownsSingleInstance);
        }

        if (!ownsSingleInstance)
        {
            Shutdown();
            return;
        }

        base.OnStartup(e);

        var window = new MainWindow();
        MainWindow = window;
        window.Show();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        try
        {
            _singleInstanceMutex?.ReleaseMutex();
        }
        catch (ApplicationException)
        {
        }
        finally
        {
            _singleInstanceMutex?.Dispose();
            _singleInstanceMutex = null;
        }

        base.OnExit(e);
    }

    private static void ForceCloseOtherOpenLinkProcesses()
    {
        var currentProcessId = Environment.ProcessId;

        foreach (var process in Process.GetProcessesByName("OpenLink"))
        {
            using (process)
            {
                if (process.Id == currentProcessId)
                {
                    continue;
                }

                try
                {
                    if (process.HasExited)
                    {
                        continue;
                    }

                    process.Kill(entireProcessTree: true);
                    process.WaitForExit(5000);
                }
                catch (Win32Exception)
                {
                }
                catch (InvalidOperationException)
                {
                }
                catch (NotSupportedException)
                {
                }
            }
        }
    }
}
