import SwiftUI

// MARK: - Welcome View

struct WelcomeView: View {
    var body: some View {
        VStack(spacing: 30) {
            Spacer()

            // Icon
            ZStack {
                Circle()
                    .fill(
                        LinearGradient(
                            colors: [.blue.opacity(0.2), .purple.opacity(0.2)],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .frame(width: 120, height: 120)

                Image(systemName: "link.circle.fill")
                    .font(.system(size: 60))
                    .foregroundStyle(
                        LinearGradient(
                            colors: [.blue, .purple],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
            }

            VStack(spacing: 12) {
                Text("Welcome to OpenLink")
                    .font(.largeTitle)
                    .fontWeight(.bold)

                Text("The secure connection layer for VoiceLink")
                    .font(.title3)
                    .foregroundColor(.gray)
            }

            // Features
            VStack(alignment: .leading, spacing: 16) {
                FeatureRow(icon: "lock.shield", title: "Secure Tunneling", description: "End-to-end encrypted connections")
                FeatureRow(icon: "network", title: "Auto-Discovery", description: "Find devices on your local network")
                FeatureRow(icon: "arrow.triangle.branch", title: "Smart Routing", description: "Automatic fallback between connection methods")
                FeatureRow(icon: "bolt.circle", title: "Low Latency", description: "Optimized for real-time voice communication")
            }
            .padding(.horizontal, 40)
            .padding(.top, 20)

            Spacer()

            Text("This installer will guide you through setting up OpenLink on your Mac.")
                .font(.caption)
                .foregroundColor(.gray)
                .multilineTextAlignment(.center)
                .padding(.bottom, 20)
        }
        .padding()
    }
}

struct FeatureRow: View {
    let icon: String
    let title: String
    let description: String

    var body: some View {
        HStack(spacing: 16) {
            Image(systemName: icon)
                .font(.title2)
                .foregroundColor(.blue)
                .frame(width: 40)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.headline)
                Text(description)
                    .font(.caption)
                    .foregroundColor(.gray)
            }

            Spacer()
        }
    }
}

// MARK: - License View

struct LicenseView: View {
    @State private var hasScrolledToBottom = false

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("License Agreement")
                .font(.title)
                .fontWeight(.bold)
                .padding(.horizontal)
                .padding(.top)

            Text("Please read and accept the license agreement to continue.")
                .font(.subheadline)
                .foregroundColor(.gray)
                .padding(.horizontal)

            // License text
            ScrollView {
                Text(licenseText)
                    .font(.system(.body, design: .monospaced))
                    .padding()
            }
            .background(Color.gray.opacity(0.05))
            .cornerRadius(8)
            .padding(.horizontal)

            HStack {
                Image(systemName: "info.circle")
                    .foregroundColor(.blue)
                Text("By clicking \"Accept & Continue\", you agree to the terms above.")
                    .font(.caption)
                    .foregroundColor(.gray)
            }
            .padding(.horizontal)
            .padding(.bottom)
        }
    }

    var licenseText: String {
        """
        MIT License

        Copyright (c) 2026 VoiceLink

        Permission is hereby granted, free of charge, to any person obtaining a copy
        of this software and associated documentation files (the "Software"), to deal
        in the Software without restriction, including without limitation the rights
        to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
        copies of the Software, and to permit persons to whom the Software is
        furnished to do so, subject to the following conditions:

        The above copyright notice and this permission notice shall be included in all
        copies or substantial portions of the Software.

        THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
        IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
        FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
        AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
        LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
        OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
        SOFTWARE.

        ---

        OpenLink Connection Service

        OpenLink provides secure, encrypted tunneling for VoiceLink voice chat
        connections. This software:

        - Creates secure WebSocket connections between devices
        - Handles automatic network discovery on local networks
        - Provides fallback routing when direct connections fail
        - Integrates with VoiceLink Native for remote server control

        Privacy Notice:
        OpenLink does not collect or store personal data. Connection metadata
        is temporarily cached for routing purposes and automatically purged.

        For support, visit: https://voicelink.app/support
        """
    }
}

// MARK: - Configuration View

struct ConfigurationView: View {
    @EnvironmentObject var state: InstallerState

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            Text("Configuration")
                .font(.title)
                .fontWeight(.bold)
                .padding(.horizontal)
                .padding(.top)

            Text("Customize how OpenLink connects and operates.")
                .font(.subheadline)
                .foregroundColor(.gray)
                .padding(.horizontal)

            ScrollView {
                VStack(spacing: 24) {
                    // Connection Mode
                    ConfigSection(title: "Connection Mode", icon: "antenna.radiowaves.left.and.right") {
                        ForEach(InstallerState.ConnectionMode.allCases, id: \.self) { mode in
                            ConnectionModeOption(mode: mode, isSelected: state.connectionMode == mode) {
                                state.connectionMode = mode
                            }
                        }
                    }

                    // Server Settings
                    ConfigSection(title: "Server Settings", icon: "server.rack") {
                        VStack(alignment: .leading, spacing: 12) {
                            HStack {
                                Text("Default Port:")
                                    .foregroundColor(.gray)
                                TextField("Port", value: $state.serverPort, format: .number)
                                    .textFieldStyle(.roundedBorder)
                                    .frame(width: 80)
                            }

                            Text("The port OpenLink will use for local connections. Default is 3000.")
                                .font(.caption)
                                .foregroundColor(.gray.opacity(0.8))
                        }
                    }

                    // Startup Options
                    ConfigSection(title: "Startup Options", icon: "power") {
                        VStack(alignment: .leading, spacing: 12) {
                            Toggle("Launch OpenLink at login", isOn: $state.enableAutoStart)
                            Toggle("Show in menu bar", isOn: $state.enableMenuBar)
                        }
                    }

                    // Notification Style
                    ConfigSection(title: "Notification Style", icon: "bell") {
                        VStack(alignment: .leading, spacing: 12) {
                            ForEach(InstallerState.NotificationStyle.allCases, id: \.self) { style in
                                NotificationStyleOption(style: style, isSelected: state.notificationStyle == style) {
                                    state.notificationStyle = style
                                }
                            }

                            HStack {
                                Image(systemName: "info.circle")
                                    .foregroundColor(.blue)
                                Text("Alerts show modal dialogs when user action is needed. Notification Center pushes quiet notifications.")
                                    .font(.caption)
                                    .foregroundColor(.gray)
                            }
                            .padding(.top, 4)
                        }
                    }
                }
                .padding()
            }
        }
    }
}

struct NotificationStyleOption: View {
    let style: InstallerState.NotificationStyle
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack {
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .foregroundColor(isSelected ? .blue : .gray)

                Image(systemName: style.icon)
                    .foregroundColor(isSelected ? .blue : .gray)
                    .frame(width: 24)

                VStack(alignment: .leading, spacing: 2) {
                    Text(style.rawValue)
                        .fontWeight(isSelected ? .semibold : .regular)
                        .foregroundColor(.primary)
                    Text(style.description)
                        .font(.caption)
                        .foregroundColor(.gray)
                }

                Spacer()
            }
            .padding(.vertical, 8)
        }
        .buttonStyle(.plain)
    }
}

struct ConfigSection<Content: View>: View {
    let title: String
    let icon: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Image(systemName: icon)
                    .foregroundColor(.blue)
                Text(title)
                    .font(.headline)
            }

            content
                .padding()
                .background(Color.gray.opacity(0.05))
                .cornerRadius(8)
        }
    }
}

struct ConnectionModeOption: View {
    let mode: InstallerState.ConnectionMode
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack {
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .foregroundColor(isSelected ? .blue : .gray)

                VStack(alignment: .leading, spacing: 2) {
                    Text(mode.rawValue)
                        .fontWeight(isSelected ? .semibold : .regular)
                        .foregroundColor(.primary)
                    Text(mode.description)
                        .font(.caption)
                        .foregroundColor(.gray)
                }

                Spacer()
            }
            .padding(.vertical, 8)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Server Pairing View

struct ServerPairingView: View {
    @EnvironmentObject var state: InstallerState
    @State private var showManualEntry = false
    @State private var showPairingHelp = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            Text("Server Pairing")
                .font(.title)
                .fontWeight(.bold)
                .padding(.horizontal)
                .padding(.top)

            HStack {
                Text("Connect OpenLink to a VoiceLink server.")
                    .font(.subheadline)
                    .foregroundColor(.gray)

                Spacer()

                Button(action: { showPairingHelp = true }) {
                    HStack(spacing: 4) {
                        Image(systemName: "questionmark.circle")
                        Text("How to get a code")
                    }
                    .font(.caption)
                    .foregroundColor(.blue)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal)

            VStack(spacing: 20) {
                // Pairing options
                if state.pairedServer == nil {
                    // Not paired yet
                    VStack(spacing: 20) {
                        // Enter pairing code
                        VStack(alignment: .leading, spacing: 12) {
                            HStack {
                                Image(systemName: "qrcode")
                                    .foregroundColor(.blue)
                                Text("Enter Pairing Code")
                                    .font(.headline)
                            }

                            HStack {
                                TextField("Enter 6-digit code", text: $state.pairingCode)
                                    .textFieldStyle(.roundedBorder)
                                    .font(.system(.title2, design: .monospaced))
                                    .multilineTextAlignment(.center)
                                    .frame(maxWidth: 200)

                                Button(action: pairWithCode) {
                                    if state.isPairing {
                                        ProgressView()
                                            .scaleEffect(0.8)
                                    } else {
                                        Text("Pair")
                                    }
                                }
                                .buttonStyle(.borderedProminent)
                                .disabled(state.pairingCode.count != 6 || state.isPairing)
                            }

                            Text("Get a pairing code from VoiceLink Native > Settings > Server Pairing")
                                .font(.caption)
                                .foregroundColor(.gray)
                        }
                        .padding()
                        .background(Color.gray.opacity(0.05))
                        .cornerRadius(8)

                        // Or manual entry
                        Button(action: { showManualEntry.toggle() }) {
                            HStack {
                                Image(systemName: showManualEntry ? "chevron.down" : "chevron.right")
                                Text("Manual Server Entry")
                            }
                            .font(.subheadline)
                            .foregroundColor(.blue)
                        }
                        .buttonStyle(.plain)

                        if showManualEntry {
                            VStack(alignment: .leading, spacing: 12) {
                                TextField("Server URL (e.g., http://192.168.1.100:3000)", text: $state.serverURL)
                                    .textFieldStyle(.roundedBorder)

                                Button("Connect") {
                                    connectToServer()
                                }
                                .buttonStyle(.bordered)
                                .disabled(state.serverURL.isEmpty)
                            }
                            .padding()
                            .background(Color.gray.opacity(0.05))
                            .cornerRadius(8)
                        }

                        // Skip option
                        Text("You can skip this step and pair later from the OpenLink menu bar app.")
                            .font(.caption)
                            .foregroundColor(.gray)
                            .multilineTextAlignment(.center)
                    }
                } else {
                    // Already paired
                    VStack(spacing: 16) {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 48))
                            .foregroundColor(.green)

                        Text("Successfully Paired!")
                            .font(.title2)
                            .fontWeight(.semibold)

                        if let server = state.pairedServer {
                            VStack(spacing: 8) {
                                HStack {
                                    Text("Server:")
                                        .foregroundColor(.gray)
                                    Text(server.name)
                                        .fontWeight(.medium)
                                }
                                HStack {
                                    Text("URL:")
                                        .foregroundColor(.gray)
                                    Text(server.url)
                                        .font(.system(.body, design: .monospaced))
                                }
                            }
                            .padding()
                            .background(Color.green.opacity(0.1))
                            .cornerRadius(8)
                        }

                        Button("Pair Different Server") {
                            state.pairedServer = nil
                            state.pairingCode = ""
                        }
                        .buttonStyle(.bordered)
                    }
                }

                if let error = errorMessage {
                    HStack {
                        Image(systemName: "exclamationmark.triangle")
                            .foregroundColor(.red)
                        Text(error)
                            .font(.caption)
                            .foregroundColor(.red)
                    }
                    .padding()
                    .background(Color.red.opacity(0.1))
                    .cornerRadius(8)
                }
            }
            .padding(.horizontal)

            Spacer()
        }
        .sheet(isPresented: $showPairingHelp) {
            PairingHelpSheet()
        }
    }

    func pairWithCode() {
        state.isPairing = true
        errorMessage = nil

        // Simulate pairing (in real implementation, this would call the server)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            state.isPairing = false

            // For demo purposes, accept any 6-digit code
            if state.pairingCode.count == 6 {
                state.pairedServer = InstallerState.PairedServer(
                    id: UUID().uuidString,
                    name: "VoiceLink Server",
                    url: "http://localhost:3000",
                    accessToken: UUID().uuidString,
                    pairedAt: Date()
                )
            } else {
                errorMessage = "Invalid pairing code. Please try again."
            }
        }
    }

    func connectToServer() {
        guard !state.serverURL.isEmpty else { return }

        state.isPairing = true
        errorMessage = nil

        // Simulate connection
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            state.isPairing = false
            state.pairedServer = InstallerState.PairedServer(
                id: UUID().uuidString,
                name: "Manual Server",
                url: state.serverURL,
                accessToken: UUID().uuidString,
                pairedAt: Date()
            )
        }
    }
}

// MARK: - Installation View

struct InstallationView: View {
    @EnvironmentObject var state: InstallerState

    var body: some View {
        VStack(spacing: 30) {
            Spacer()

            if state.isInstalling {
                // Installing
                VStack(spacing: 20) {
                    ProgressView()
                        .scaleEffect(1.5)

                    Text("Installing OpenLink...")
                        .font(.title2)
                        .fontWeight(.semibold)

                    ProgressView(value: state.installProgress)
                        .progressViewStyle(.linear)
                        .frame(width: 300)

                    Text(state.installStatus)
                        .font(.caption)
                        .foregroundColor(.gray)
                }
            } else {
                // Ready to install
                VStack(spacing: 20) {
                    Image(systemName: "arrow.down.circle")
                        .font(.system(size: 60))
                        .foregroundColor(.blue)

                    Text("Ready to Install")
                        .font(.title2)
                        .fontWeight(.semibold)

                    Text("OpenLink will be installed to /Applications")
                        .font(.subheadline)
                        .foregroundColor(.gray)

                    // Summary
                    VStack(alignment: .leading, spacing: 8) {
                        SummaryRow(label: "Connection Mode", value: state.connectionMode.rawValue)
                        SummaryRow(label: "Port", value: "\(state.serverPort)")
                        SummaryRow(label: "Auto-start", value: state.enableAutoStart ? "Enabled" : "Disabled")
                        SummaryRow(label: "Menu Bar", value: state.enableMenuBar ? "Enabled" : "Disabled")
                        SummaryRow(label: "Notifications", value: state.notificationStyle.rawValue)
                        if let server = state.pairedServer {
                            SummaryRow(label: "Paired Server", value: server.name)
                        }
                    }
                    .padding()
                    .background(Color.gray.opacity(0.05))
                    .cornerRadius(8)
                }
            }

            Spacer()
        }
        .padding()
    }
}

struct SummaryRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack {
            Text(label)
                .foregroundColor(.gray)
            Spacer()
            Text(value)
                .fontWeight(.medium)
        }
    }
}

// MARK: - Complete View

struct CompleteView: View {
    @EnvironmentObject var state: InstallerState

    var body: some View {
        VStack(spacing: 30) {
            Spacer()

            // Success animation
            ZStack {
                Circle()
                    .fill(Color.green.opacity(0.2))
                    .frame(width: 120, height: 120)

                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 60))
                    .foregroundColor(.green)
            }

            VStack(spacing: 12) {
                Text("Installation Complete!")
                    .font(.largeTitle)
                    .fontWeight(.bold)

                Text("OpenLink has been installed successfully.")
                    .font(.title3)
                    .foregroundColor(.gray)
            }

            // Next steps
            VStack(alignment: .leading, spacing: 16) {
                Text("Next Steps:")
                    .font(.headline)

                NextStepRow(number: 1, text: "Look for the OpenLink icon in your menu bar")
                NextStepRow(number: 2, text: "Open VoiceLink Native and connect to your server")
                NextStepRow(number: 3, text: "Start a voice chat and enjoy secure connections!")
            }
            .padding()
            .background(Color.blue.opacity(0.05))
            .cornerRadius(12)
            .padding(.horizontal, 40)

            Spacer()

            // Launch options
            VStack(spacing: 12) {
                Button(action: launchOpenLink) {
                    HStack {
                        Image(systemName: "play.circle")
                        Text("Launch OpenLink Now")
                    }
                }
                .buttonStyle(.borderedProminent)

                Button(action: openVoiceLink) {
                    HStack {
                        Image(systemName: "mic.circle")
                        Text("Open VoiceLink Native")
                    }
                }
                .buttonStyle(.bordered)
            }
            .padding(.bottom, 20)
        }
        .padding()
    }

    func launchOpenLink() {
        // Launch the installed app
        if let url = URL(string: "file:///Applications/OpenLink.app") {
            NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
        }
    }

    func openVoiceLink() {
        // Launch VoiceLink Native
        if let url = URL(string: "file:///Applications/VoiceLink%20Native.app") {
            NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
        }
    }
}

struct NextStepRow: View {
    let number: Int
    let text: String

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                Circle()
                    .fill(Color.blue)
                    .frame(width: 24, height: 24)
                Text("\(number)")
                    .font(.caption)
                    .fontWeight(.bold)
                    .foregroundColor(.white)
            }

            Text(text)
                .font(.subheadline)

            Spacer()
        }
    }
}

// MARK: - Pairing Help Sheet

struct PairingHelpSheet: View {
    @Environment(\.dismiss) var dismiss

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("How to Get a Pairing Code")
                    .font(.title2)
                    .fontWeight(.bold)
                Spacer()
                Button(action: { dismiss() }) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.title2)
                        .foregroundColor(.gray)
                }
                .buttonStyle(.plain)
            }
            .padding()

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    // Method 1: VoiceLink Native
                    PairingMethodSection(
                        icon: "desktopcomputer",
                        title: "From VoiceLink Native (Mac)",
                        steps: [
                            "Open VoiceLink Native on your Mac",
                            "Click the menu bar icon and select \"Settings\"",
                            "Go to \"Server & Pairing\" tab",
                            "Click \"Generate Pairing Code\"",
                            "Copy the 6-digit code shown"
                        ]
                    )

                    // Method 2: VoiceLink Desktop (Windows/Linux)
                    PairingMethodSection(
                        icon: "pc",
                        title: "From VoiceLink Desktop (Windows/Linux)",
                        steps: [
                            "Open VoiceLink Desktop application",
                            "Go to Settings (gear icon)",
                            "Navigate to \"Server Settings\"",
                            "Under \"Remote Connections\", click \"Generate Code\"",
                            "The 6-digit pairing code will be displayed"
                        ]
                    )

                    // Method 3: Web Dashboard
                    PairingMethodSection(
                        icon: "globe",
                        title: "From Web Dashboard",
                        steps: [
                            "Open your browser and go to your server URL",
                            "Log in to the admin dashboard",
                            "Navigate to \"Devices\" or \"Connections\"",
                            "Click \"Add New Device\"",
                            "Copy the generated pairing code"
                        ]
                    )

                    // Method 4: Menu Bar Server
                    PairingMethodSection(
                        icon: "menubar.rectangle",
                        title: "From Running Server (Menu Bar)",
                        steps: [
                            "If you have a server running, click its menu bar icon",
                            "Select \"Pairing\" or \"Remote Access\"",
                            "Choose \"Generate New Code\"",
                            "The code expires after 5 minutes"
                        ]
                    )

                    // Tips
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            Image(systemName: "lightbulb.fill")
                                .foregroundColor(.yellow)
                            Text("Tips")
                                .font(.headline)
                        }

                        VStack(alignment: .leading, spacing: 8) {
                            TipRow(text: "Pairing codes expire after 5 minutes for security")
                            TipRow(text: "You can pair multiple devices to the same server")
                            TipRow(text: "Keep the server running while entering the code")
                            TipRow(text: "Both devices must be connected to the internet")
                        }
                    }
                    .padding()
                    .background(Color.yellow.opacity(0.1))
                    .cornerRadius(12)

                    // Troubleshooting
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            Image(systemName: "wrench.and.screwdriver.fill")
                                .foregroundColor(.orange)
                            Text("Troubleshooting")
                                .font(.headline)
                        }

                        VStack(alignment: .leading, spacing: 8) {
                            TipRow(text: "\"Invalid code\" - Make sure you typed it correctly or generate a new one")
                            TipRow(text: "\"Server not found\" - Ensure the server is running and accessible")
                            TipRow(text: "\"Connection failed\" - Check your firewall settings")
                            TipRow(text: "Still having issues? Try the manual URL entry option")
                        }
                    }
                    .padding()
                    .background(Color.orange.opacity(0.1))
                    .cornerRadius(12)
                }
                .padding()
            }

            Divider()

            // Footer
            HStack {
                Button(action: {
                    if let url = URL(string: "https://voicelink.app/docs/pairing") {
                        NSWorkspace.shared.open(url)
                    }
                }) {
                    HStack {
                        Image(systemName: "book")
                        Text("Full Documentation")
                    }
                }
                .buttonStyle(.bordered)

                Spacer()

                Button("Got it") {
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
            }
            .padding()
        }
        .frame(width: 550, height: 650)
    }
}

struct PairingMethodSection: View {
    let icon: String
    let title: String
    let steps: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Image(systemName: icon)
                    .font(.title2)
                    .foregroundColor(.blue)
                    .frame(width: 32)
                Text(title)
                    .font(.headline)
            }

            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                    HStack(alignment: .top, spacing: 12) {
                        Text("\(index + 1).")
                            .font(.subheadline)
                            .fontWeight(.semibold)
                            .foregroundColor(.blue)
                            .frame(width: 20, alignment: .trailing)
                        Text(step)
                            .font(.subheadline)
                    }
                }
            }
            .padding(.leading, 44)
        }
        .padding()
        .background(Color.gray.opacity(0.05))
        .cornerRadius(12)
    }
}

struct TipRow: View {
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "checkmark.circle.fill")
                .font(.caption)
                .foregroundColor(.green)
            Text(text)
                .font(.caption)
        }
    }
}

// MARK: - Data Migration Helper

struct DataMigrationView: View {
    @EnvironmentObject var state: InstallerState
    @State private var isMigrating = false
    @State private var migrationComplete = false
    @State private var migratedItems: [String] = []

    var body: some View {
        VStack(spacing: 20) {
            if isMigrating {
                ProgressView("Migrating data...")
                    .padding()
            } else if migrationComplete {
                VStack(spacing: 12) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.largeTitle)
                        .foregroundColor(.green)
                    Text("Migration Complete")
                        .font(.headline)

                    if !migratedItems.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Migrated:")
                                .font(.caption)
                                .foregroundColor(.gray)
                            ForEach(migratedItems, id: \.self) { item in
                                HStack {
                                    Image(systemName: "checkmark")
                                        .font(.caption)
                                        .foregroundColor(.green)
                                    Text(item)
                                        .font(.caption)
                                }
                            }
                        }
                        .padding()
                        .background(Color.green.opacity(0.1))
                        .cornerRadius(8)
                    }
                }
            } else {
                VStack(spacing: 12) {
                    Image(systemName: "arrow.triangle.2.circlepath")
                        .font(.largeTitle)
                        .foregroundColor(.blue)
                    Text("Previous Installation Detected")
                        .font(.headline)
                    Text("Would you like to migrate your existing settings and data?")
                        .font(.subheadline)
                        .foregroundColor(.gray)
                        .multilineTextAlignment(.center)

                    HStack(spacing: 16) {
                        Button("Skip") {
                            migrationComplete = true
                        }
                        .buttonStyle(.bordered)

                        Button("Migrate") {
                            performMigration()
                        }
                        .buttonStyle(.borderedProminent)
                    }
                    .padding(.top)
                }
            }
        }
        .padding()
    }

    func performMigration() {
        isMigrating = true

        // Check for existing data to migrate
        let oldConfigPaths = [
            NSHomeDirectory() + "/.voicelink/config.json",
            NSHomeDirectory() + "/Library/Application Support/VoiceLink/settings.json",
            NSHomeDirectory() + "/Library/Application Support/OpenLink/config.json"
        ]

        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            // Migrate wallet links
            if let walletData = migrateWalletData() {
                migratedItems.append("Wallet connections (\(walletData) found)")
            }

            // Migrate server connections
            if let serverCount = migrateServerConnections() {
                migratedItems.append("Server connections (\(serverCount) found)")
            }

            // Migrate user preferences
            if migrateUserPreferences() {
                migratedItems.append("User preferences")
            }

            // Migrate trusted devices
            if let deviceCount = migrateTrustedDevices() {
                migratedItems.append("Trusted devices (\(deviceCount) found)")
            }

            isMigrating = false
            migrationComplete = true
        }
    }

    func migrateWalletData() -> Int? {
        // Check for existing wallet connections in old config
        let walletPath = NSHomeDirectory() + "/.voicelink/wallets.json"
        if FileManager.default.fileExists(atPath: walletPath) {
            // Copy to new location
            let newPath = NSHomeDirectory() + "/.openlink/wallets.json"
            try? FileManager.default.copyItem(atPath: walletPath, toPath: newPath)
            return 1
        }
        return nil
    }

    func migrateServerConnections() -> Int? {
        let serversPath = NSHomeDirectory() + "/.voicelink/servers.json"
        if FileManager.default.fileExists(atPath: serversPath) {
            let newPath = NSHomeDirectory() + "/.openlink/servers.json"
            try? FileManager.default.copyItem(atPath: serversPath, toPath: newPath)
            // Count servers
            if let data = FileManager.default.contents(atPath: serversPath),
               let servers = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
                return servers.count
            }
        }
        return nil
    }

    func migrateUserPreferences() -> Bool {
        // Migrate UserDefaults from old app
        if let oldDefaults = UserDefaults(suiteName: "com.voicelink.desktop") {
            let keys = ["connectionMode", "autoStart", "menuBarEnabled", "notificationStyle"]
            var migrated = false
            for key in keys {
                if let value = oldDefaults.object(forKey: key) {
                    UserDefaults.standard.set(value, forKey: key)
                    migrated = true
                }
            }
            return migrated
        }
        return false
    }

    func migrateTrustedDevices() -> Int? {
        let devicesPath = NSHomeDirectory() + "/.voicelink/trusted_devices.json"
        if FileManager.default.fileExists(atPath: devicesPath) {
            let newPath = NSHomeDirectory() + "/.openlink/trusted_devices.json"
            try? FileManager.default.copyItem(atPath: devicesPath, toPath: newPath)
            if let data = FileManager.default.contents(atPath: devicesPath),
               let devices = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
                return devices.count
            }
        }
        return nil
    }
}

// MARK: - Previews

#Preview("Welcome") {
    WelcomeView()
}

#Preview("Configuration") {
    ConfigurationView()
        .environmentObject(InstallerState.shared)
}

#Preview("Complete") {
    CompleteView()
        .environmentObject(InstallerState.shared)
}
