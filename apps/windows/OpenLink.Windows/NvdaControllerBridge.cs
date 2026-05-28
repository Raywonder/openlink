using System.Diagnostics;
using System.Runtime.InteropServices;

namespace OpenLink.Windows;

internal sealed class NvdaControllerBridge
{
    public bool IsRunning => Process.GetProcessesByName("nvda").Length > 0;

    public bool Speak(string text)
    {
        if (string.IsNullOrWhiteSpace(text) || !IsRunning)
        {
            return false;
        }

        try
        {
            if (Environment.Is64BitProcess)
            {
                return NvdaController64.nvdaController_testIfRunning() == 0 &&
                       NvdaController64.nvdaController_speakText(text) == 0;
            }

            return NvdaController32.nvdaController_testIfRunning() == 0 &&
                   NvdaController32.nvdaController_speakText(text) == 0;
        }
        catch (DllNotFoundException)
        {
            return false;
        }
        catch (EntryPointNotFoundException)
        {
            return false;
        }
        catch (BadImageFormatException)
        {
            return false;
        }
    }

    public void CancelSpeech()
    {
        if (!IsRunning)
        {
            return;
        }

        try
        {
            if (Environment.Is64BitProcess)
            {
                NvdaController64.nvdaController_cancelSpeech();
            }
            else
            {
                NvdaController32.nvdaController_cancelSpeech();
            }
        }
        catch
        {
            // NVDA controller support is best-effort; UIA/TTS fallbacks remain active.
        }
    }

    private static class NvdaController64
    {
        [DllImport("nvdaControllerClient64.dll", CallingConvention = CallingConvention.Cdecl)]
        internal static extern int nvdaController_testIfRunning();

        [DllImport("nvdaControllerClient64.dll", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Unicode)]
        internal static extern int nvdaController_speakText(string text);

        [DllImport("nvdaControllerClient64.dll", CallingConvention = CallingConvention.Cdecl)]
        internal static extern int nvdaController_cancelSpeech();
    }

    private static class NvdaController32
    {
        [DllImport("nvdaControllerClient32.dll", CallingConvention = CallingConvention.Cdecl)]
        internal static extern int nvdaController_testIfRunning();

        [DllImport("nvdaControllerClient32.dll", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Unicode)]
        internal static extern int nvdaController_speakText(string text);

        [DllImport("nvdaControllerClient32.dll", CallingConvention = CallingConvention.Cdecl)]
        internal static extern int nvdaController_cancelSpeech();
    }
}
