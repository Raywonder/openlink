import Foundation

struct BrlttyBridgeStatus {
    let available: Bool
    let enabled: Bool
    let provider: String
    let executablePath: String

    var summary: String {
        if !enabled {
            return "Braille display support is off."
        }
        if available {
            return "BRLTTY is available at \(executablePath)."
        }
        return "BRLTTY was not found. Install BRLTTY or set the executable path, then try again."
    }
}

final class BrlttyBridge {
    static let shared = BrlttyBridge()

    private init() {}

    func status() -> BrlttyBridgeStatus {
        let provider = UserDefaults.standard.string(forKey: "brailleProvider") ?? "auto"
        let executable = resolveExecutablePath()
        return BrlttyBridgeStatus(
            available: executable != nil || pythonBrlapiAvailable(),
            enabled: UserDefaults.standard.bool(forKey: "enableBrailleDisplaySupport"),
            provider: provider,
            executablePath: executable ?? "brlapi python module"
        )
    }

    @discardableResult
    func send(_ text: String) -> Bool {
        guard UserDefaults.standard.bool(forKey: "enableBrailleDisplaySupport") else { return false }
        let normalized = text
            .replacingOccurrences(of: "\r", with: " ")
            .replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return false }

        let provider = (UserDefaults.standard.string(forKey: "brailleProvider") ?? "auto").lowercased()
        if provider == "auto" || provider == "brltty" {
            if sendViaBrlapiPython(normalized) {
                return true
            }
            return sendViaBrlttyCommand(normalized)
        }

        return false
    }

    private func sendViaBrlapiPython(_ text: String) -> Bool {
        guard pythonBrlapiAvailable() else { return false }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.environment = (ProcessInfo.processInfo.environment).merging(["OPENLINK_BRAILLE_TEXT": text]) { _, new in new }
        process.arguments = [
            "python3",
            "-c",
            """
import os
import brlapi
b = brlapi.Connection()
b.writeText(os.environ.get("OPENLINK_BRAILLE_TEXT", ""))
"""
        ]

        return run(process)
    }

    private func sendViaBrlttyCommand(_ text: String) -> Bool {
        guard let executable = resolveExecutablePath() else { return false }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = ["-m", text]
        return run(process)
    }

    private func resolveExecutablePath() -> String? {
        let explicit = UserDefaults.standard.string(forKey: "brlttyExecutablePath")?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let candidates = [
            explicit,
            "/opt/homebrew/bin/brltty",
            "/usr/local/bin/brltty",
            "/usr/bin/brltty",
            "/opt/local/bin/brltty"
        ].filter { !$0.isEmpty }

        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    private func pythonBrlapiAvailable() -> Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["python3", "-c", "import brlapi"]
        return run(process)
    }

    private func run(_ process: Process) -> Bool {
        process.standardOutput = Pipe()
        process.standardError = Pipe()
        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus == 0
        } catch {
            return false
        }
    }
}
