import AppKit
import SwiftUI

final class WhatIsNewWindowController {
    static let currentReleaseNotes = """
    - Screen-reader readouts now use native UI Automation live-region events on Windows and NSAccessibility announcements on macOS.
    - OpenLink now shows a tCast-style What is New dialog after updates and keeps release notes available from the File menu.
    - macOS Settings now opens in a real foreground window and can be reopened from the app menu.
    - Trusted or owned devices can request remote OpenLink settings, while guest settings requests require local approval.
    - Ctrl Alt Backslash now waits for the key chord to release before opening controller actions, so the menu stays open for arrow-key navigation.
    - Controller and machine menus now include local Settings, remote Settings, running apps and processes, audio controls, volume presets, lock, restart, shut down, and log out.
    """

    private let version: String
    private let releaseNotes: String
    private let updatePrompt: Bool

    init(version: String, releaseNotes: String, updatePrompt: Bool = false) {
        self.version = version
        self.releaseNotes = releaseNotes
        self.updatePrompt = updatePrompt
    }

    func showWindow() {
        let window = makeWindow()
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    @MainActor
    func runModal() -> NSApplication.ModalResponse {
        let window = makeWindow()
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        return NSApplication.shared.runModal(for: window)
    }

    private func makeWindow() -> NSWindow {
        let view = WhatIsNewView(
            appName: "OpenLink",
            version: version,
            releaseNotes: releaseNotes,
            updatePrompt: updatePrompt
        ) { response in
            if let window = NSApplication.shared.keyWindow {
                NSApplication.shared.stopModal(withCode: response)
                window.close()
            }
        }

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 560, height: 420),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = updatePrompt ? "OpenLink Update Available" : "OpenLink What is New"
        window.contentMinSize = NSSize(width: 480, height: 340)
        window.contentViewController = NSHostingController(rootView: view)
        window.center()
        return window
    }

    static func notesDirectory() -> URL {
        URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent(".openlink", isDirectory: true)
    }

    static func lastVersion() -> String {
        let url = notesDirectory().appendingPathComponent("last-whats-new-version.txt")
        if let value = try? String(contentsOf: url, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
           !value.isEmpty {
            return value
        }

        return Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.7.25"
    }

    static func lastNotes() -> String {
        let url = notesDirectory().appendingPathComponent("last-whats-new-notes.txt")
        if let value = try? String(contentsOf: url, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
           !value.isEmpty {
            return value
        }

        return currentReleaseNotes
    }

    static func consumePendingInstallNotice() -> (version: String, notes: String)? {
        let directory = notesDirectory()
        let pendingURL = directory.appendingPathComponent("pending-update-success.txt")
        guard let version = try? String(contentsOf: pendingURL, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
              !version.isEmpty else {
            return nil
        }

        try? FileManager.default.removeItem(at: pendingURL)
        return (version, lastNotes())
    }
}

private struct WhatIsNewView: View {
    let appName: String
    let version: String
    let releaseNotes: String
    let updatePrompt: Bool
    let close: (NSApplication.ModalResponse) -> Void

    private var noteItems: [String] {
        let normalized = releaseNotes.replacingOccurrences(of: "\r\n", with: "\n")
        let items = normalized
            .split(separator: "\n")
            .map { line in
                line.trimmingCharacters(in: .whitespacesAndNewlines)
                    .trimmingCharacters(in: CharacterSet(charactersIn: "-* \t"))
            }
            .filter { !$0.isEmpty }
        return items.isEmpty ? ["No release notes were provided for this update."] : items
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(updatePrompt ? "\(appName) \(version) is available." : "\(appName) \(version)")
                .font(.title3)
                .fontWeight(.semibold)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)

            Text("What is new")
                .fontWeight(.semibold)
                .accessibilityAddTraits(.isHeader)

            List(noteItems, id: \.self) { item in
                Text("- \(item)")
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityLabel("What is new in this \(appName) update")

            HStack {
                Spacer()
                Button(updatePrompt ? "Update Now" : "OK") {
                    close(.alertFirstButtonReturn)
                }
                .keyboardShortcut(.defaultAction)

                Button(updatePrompt ? "Later" : "Close") {
                    close(.alertSecondButtonReturn)
                }
                .keyboardShortcut(.cancelAction)
            }
        }
        .padding(16)
        .frame(minWidth: 480, minHeight: 340)
    }
}
