using System.Windows;
using System.Windows.Controls;

namespace OpenLink.Windows;

public partial class RemoteAudioSettingsDialog : Window
{
    public bool AllowMicrophoneAudio { get; private set; }
    public bool AllowSystemAudio { get; private set; }
    public int RemoteAudioVolumePercent { get; private set; }
    public int DirectAudioBufferSamples { get; private set; }
    public int WindowsAudioBufferSamples { get; private set; }
    public string AudioStreamingCodec { get; private set; } = "pcm_s16le";

    public RemoteAudioSettingsDialog(MachineRecord machine, OpenLinkSettings settings)
    {
        InitializeComponent();
        TitleText.Text = $"Audio settings for {machine.DisplayName}";
        AllowMicrophoneAudio = machine.AllowMicrophoneAudio;
        AllowSystemAudio = machine.AllowSystemAudio;
        RemoteAudioVolumePercent = settings.RemoteAudioVolumePercent;
        DirectAudioBufferSamples = OpenLinkAudioSettings.ClampBufferSamples(settings.DirectAudioBufferSamples);
        WindowsAudioBufferSamples = OpenLinkAudioSettings.ClampBufferSamples(settings.WindowsAudioBufferSamples);
        AudioStreamingCodec = OpenLinkAudioSettings.NormalizeCodec(settings.AudioStreamingCodec);

        foreach (var samples in OpenLinkAudioSettings.BufferSampleChoices)
        {
            DirectBufferBox.Items.Add(new ComboBoxItem { Content = $"{samples} samples", Tag = samples.ToString() });
            WindowsBufferBox.Items.Add(new ComboBoxItem { Content = $"{samples} samples", Tag = samples.ToString() });
        }

        MicrophoneAudioBox.IsChecked = AllowMicrophoneAudio;
        SystemAudioBox.IsChecked = AllowSystemAudio;
        SelectComboItem(RemoteVolumeBox, RemoteAudioVolumePercent.ToString());
        SelectComboItem(DirectBufferBox, DirectAudioBufferSamples.ToString());
        SelectComboItem(WindowsBufferBox, WindowsAudioBufferSamples.ToString());
        SelectComboItem(StreamingFormatBox, AudioStreamingCodec);
    }

    private void OkButton_Click(object sender, RoutedEventArgs e)
    {
        AllowMicrophoneAudio = MicrophoneAudioBox.IsChecked == true;
        AllowSystemAudio = SystemAudioBox.IsChecked == true;
        RemoteAudioVolumePercent = Math.Clamp(GetComboInt(RemoteVolumeBox, 100), 0, 150);
        DirectAudioBufferSamples = OpenLinkAudioSettings.ClampBufferSamples(GetComboInt(DirectBufferBox, 512));
        WindowsAudioBufferSamples = OpenLinkAudioSettings.ClampBufferSamples(GetComboInt(WindowsBufferBox, 512));
        AudioStreamingCodec = OpenLinkAudioSettings.NormalizeCodec(GetComboText(StreamingFormatBox, "pcm_s16le"));
        DialogResult = true;
    }

    private static void SelectComboItem(System.Windows.Controls.ComboBox comboBox, string value)
    {
        foreach (var item in comboBox.Items.OfType<ComboBoxItem>())
        {
            var itemValue = item.Tag?.ToString() ?? item.Content?.ToString();
            if (string.Equals(itemValue, value, StringComparison.OrdinalIgnoreCase))
            {
                comboBox.SelectedItem = item;
                return;
            }
        }

        comboBox.SelectedIndex = comboBox.Items.Count > 0 ? 0 : -1;
    }

    private static string GetComboText(System.Windows.Controls.ComboBox comboBox, string fallback)
    {
        return comboBox.SelectedItem is ComboBoxItem item
            ? item.Tag?.ToString() ?? item.Content?.ToString() ?? fallback
            : string.IsNullOrWhiteSpace(comboBox.Text) ? fallback : comboBox.Text.Trim();
    }

    private static int GetComboInt(System.Windows.Controls.ComboBox comboBox, int fallback)
    {
        return int.TryParse(GetComboText(comboBox, fallback.ToString()), out var value) ? value : fallback;
    }
}
