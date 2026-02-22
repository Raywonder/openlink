import SwiftUI

struct ContentView: View {
    @EnvironmentObject var state: InstallerState

    var body: some View {
        ZStack {
            // Background gradient
            LinearGradient(
                gradient: Gradient(colors: [
                    Color(red: 0.1, green: 0.1, blue: 0.15),
                    Color(red: 0.15, green: 0.12, blue: 0.2)
                ]),
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()

            HStack(spacing: 0) {
                // Sidebar with steps
                InstallerSidebar()
                    .frame(width: 220)

                // Main content
                VStack(spacing: 0) {
                    // Content area
                    ZStack {
                        switch state.currentStep {
                        case .welcome:
                            WelcomeView()
                        case .license:
                            LicenseView()
                        case .configuration:
                            ConfigurationView()
                        case .serverPairing:
                            ServerPairingView()
                        case .installation:
                            InstallationView()
                        case .complete:
                            CompleteView()
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)

                    // Navigation buttons
                    NavigationBar()
                }
                .background(Color.white)
            }
        }
    }
}

// MARK: - Sidebar

struct InstallerSidebar: View {
    @EnvironmentObject var state: InstallerState

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Logo
            VStack(spacing: 8) {
                Image(systemName: "link.circle.fill")
                    .font(.system(size: 48))
                    .foregroundStyle(
                        LinearGradient(
                            colors: [.blue, .purple],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )

                Text("OpenLink")
                    .font(.title2)
                    .fontWeight(.bold)
                    .foregroundColor(.white)

                Text("Installer")
                    .font(.subheadline)
                    .foregroundColor(.white.opacity(0.7))
            }
            .padding(.top, 40)
            .padding(.bottom, 30)
            .frame(maxWidth: .infinity)

            // Steps
            VStack(alignment: .leading, spacing: 4) {
                ForEach(InstallerState.InstallerStep.allCases, id: \.self) { step in
                    StepRow(step: step, isActive: state.currentStep == step, isCompleted: step.rawValue < state.currentStep.rawValue)
                }
            }
            .padding(.horizontal, 16)

            Spacer()

            // Version info
            VStack(spacing: 4) {
                Text("Version 1.0.0")
                    .font(.caption)
                    .foregroundColor(.white.opacity(0.5))
                Text("VoiceLink Native")
                    .font(.caption2)
                    .foregroundColor(.white.opacity(0.4))
            }
            .padding(.bottom, 20)
            .frame(maxWidth: .infinity)
        }
        .background(Color.clear)
    }
}

struct StepRow: View {
    let step: InstallerState.InstallerStep
    let isActive: Bool
    let isCompleted: Bool

    var body: some View {
        HStack(spacing: 12) {
            // Step indicator
            ZStack {
                Circle()
                    .fill(isCompleted ? Color.green : (isActive ? Color.blue : Color.white.opacity(0.2)))
                    .frame(width: 28, height: 28)

                if isCompleted {
                    Image(systemName: "checkmark")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundColor(.white)
                } else {
                    Image(systemName: step.icon)
                        .font(.caption)
                        .foregroundColor(isActive ? .white : .white.opacity(0.6))
                }
            }

            Text(step.title)
                .font(.subheadline)
                .fontWeight(isActive ? .semibold : .regular)
                .foregroundColor(isActive ? .white : .white.opacity(0.6))

            Spacer()
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 12)
        .background(isActive ? Color.white.opacity(0.1) : Color.clear)
        .cornerRadius(8)
    }
}

// MARK: - Navigation Bar

struct NavigationBar: View {
    @EnvironmentObject var state: InstallerState

    var body: some View {
        HStack {
            // Back button
            if state.currentStep != .welcome && state.currentStep != .installation && state.currentStep != .complete {
                Button(action: {
                    withAnimation {
                        state.previousStep()
                    }
                }) {
                    HStack(spacing: 4) {
                        Image(systemName: "chevron.left")
                        Text("Back")
                    }
                }
                .buttonStyle(.bordered)
            }

            Spacer()

            // Next/Install button
            if state.currentStep != .complete {
                Button(action: {
                    withAnimation {
                        if state.currentStep == .serverPairing {
                            state.nextStep()
                            // Start installation
                            startInstallation()
                        } else {
                            state.nextStep()
                        }
                    }
                }) {
                    HStack(spacing: 4) {
                        Text(nextButtonTitle)
                        if state.currentStep != .installation {
                            Image(systemName: "chevron.right")
                        }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(state.currentStep == .installation && state.isInstalling)
            } else {
                // Finish button
                Button(action: {
                    NSApplication.shared.terminate(nil)
                }) {
                    Text("Finish")
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding()
        .background(Color.gray.opacity(0.05))
    }

    var nextButtonTitle: String {
        switch state.currentStep {
        case .welcome: return "Get Started"
        case .license: return "Accept & Continue"
        case .configuration: return "Continue"
        case .serverPairing: return "Install"
        case .installation: return "Installing..."
        case .complete: return "Finish"
        }
    }

    func startInstallation() {
        state.isInstalling = true
        OpenLinkInstaller.shared.install(state: state)
    }
}

// MARK: - Preview

#Preview {
    ContentView()
        .environmentObject(InstallerState.shared)
}
