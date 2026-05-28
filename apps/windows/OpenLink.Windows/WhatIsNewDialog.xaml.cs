using System.Windows;

namespace OpenLink.Windows;

public partial class WhatIsNewDialog : Window
{
    private sealed record ReleaseNoteItem(string Text)
    {
        public string DisplayText => $"- {Text}";
    }

    public WhatIsNewDialog(
        string version,
        string releaseNotes,
        bool updatePrompt = false,
        string appName = "OpenLink")
    {
        InitializeComponent();
        Title = updatePrompt ? $"{appName} Update Available" : $"{appName} What is New";
        TitleTextBlock.Text = updatePrompt
            ? $"{appName} {version} is available."
            : $"{appName} {version}";
        PrimaryButton.Content = updatePrompt ? "Update Now" : "OK";
        SecondaryButton.Content = updatePrompt ? "Later" : "Close";

        var items = BuildReleaseNoteItems(releaseNotes).ToList();
        if (items.Count > 1)
        {
            foreach (var item in items)
            {
                ReleaseNotesListBox.Items.Add(item);
            }

            ReleaseNotesListBox.SelectedIndex = 0;
            Loaded += (_, _) => ReleaseNotesListBox.Focus();
            return;
        }

        ReleaseNotesListBox.Visibility = Visibility.Collapsed;
        ReleaseNotesTextBox.Visibility = Visibility.Visible;
        ReleaseNotesTextBox.Text = string.IsNullOrWhiteSpace(releaseNotes)
            ? "No release notes were provided for this update."
            : releaseNotes.Trim();
        Loaded += (_, _) => ReleaseNotesTextBox.Focus();
    }

    private void Primary_Click(object sender, RoutedEventArgs e)
    {
        DialogResult = true;
    }

    private void Secondary_Click(object sender, RoutedEventArgs e)
    {
        DialogResult = false;
    }

    private static IEnumerable<ReleaseNoteItem> BuildReleaseNoteItems(string releaseNotes)
    {
        if (string.IsNullOrWhiteSpace(releaseNotes))
        {
            yield return new ReleaseNoteItem("No release notes were provided for this update.");
            yield break;
        }

        foreach (var line in SplitReleaseNotes(releaseNotes))
        {
            yield return new ReleaseNoteItem(line);
        }
    }

    private static IEnumerable<string> SplitReleaseNotes(string releaseNotes)
    {
        foreach (var rawLine in releaseNotes.Replace("\r\n", "\n").Split('\n'))
        {
            var line = rawLine.Trim();
            if (line.Length == 0)
            {
                continue;
            }

            yield return NormalizeBulletLine(line);
        }
    }

    private static string NormalizeBulletLine(string line)
    {
        var trimmed = line.TrimStart('-', '*', ' ', '\t');
        return trimmed.Length == 0 ? line.Trim() : trimmed.Trim();
    }
}
