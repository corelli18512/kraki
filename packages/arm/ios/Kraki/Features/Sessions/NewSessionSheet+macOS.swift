#if os(macOS)
/// NewSessionSheet — mac equivalent of the iOS create-session sheet.
///
/// Layout: native AppKit-style modal sheet (fixed 480×360) with a
/// header strip, a form (Device / Model / Title / Effort), and a
/// footer with Cancel + Create. Uses brand tokens to match the iOS
/// visual language even though the chrome is plain SwiftUI.
import SwiftUI

struct NewSessionSheet: View {
    @Environment(AppState.self) private var appState
    @Binding var isPresented: Bool
    var onCreated: (String) -> Void = { _ in }

    @State private var selectedDeviceId: String = ""
    @State private var selectedAgentId: AgentId = ""
    @State private var selectedModel: String = ""
    @State private var reasoningEffort: ReasoningEffort?
    @State private var sessionTitle: String = ""

    private var deviceStore: DeviceStore { appState.deviceStore }
    private var tentacles: [DeviceSummary] { deviceStore.tentacleDevices }
    private var onlineTentacles: [DeviceSummary] { tentacles.filter(\.online) }
    private var agents: [AgentCapabilities] { deviceStore.agents(for: selectedDeviceId) }
    private var activeAgent: AgentCapabilities? {
        agents.first { $0.id == selectedAgentId } ?? agents.first
    }
    private var models: [String] { activeAgent?.models ?? [] }
    private var modelDetails: [ModelDetail] { activeAgent?.modelDetails ?? [] }
    private var selectedModelDetail: ModelDetail? { modelDetails.first { $0.id == selectedModel } }
    private var supportedEfforts: [ReasoningEffort]? {
        guard let d = selectedModelDetail, d.supportsReasoningEffort else { return nil }
        return d.supportedReasoningEfforts
    }
    private var canSubmit: Bool {
        !selectedDeviceId.isEmpty && !selectedAgentId.isEmpty && !selectedModel.isEmpty
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
                .overlay(Color.borderPrimary)

            if tentacles.isEmpty {
                emptyState
            } else {
                form
            }

            Divider()
                .overlay(Color.borderPrimary)
            footer
        }
        .frame(width: 480, height: 410)
        .background(Color.surfacePrimary)
        .onAppear(perform: selectDefaults)
        .onChange(of: selectedDeviceId) { _, _ in onDeviceChanged() }
        .onChange(of: selectedAgentId) { _, _ in onAgentChanged() }
        .onChange(of: selectedModel) { _, _ in onModelChanged() }
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "plus.bubble.fill")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Color.krakiPrimary)
            Text("New Session")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Color.textPrimary)
            Spacer()
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
        .background(Color.surfaceSecondary)
    }

    // MARK: - Empty

    private var emptyState: some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: "antenna.radiowaves.left.and.right.slash")
                .font(.system(size: 32, weight: .light))
                .foregroundStyle(Color.textMuted)
            Text("No Tentacle Devices Online")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Color.textPrimary)
            Text("Install the Kraki CLI on a device and start the daemon to create a session.")
                .font(.system(size: 12))
                .foregroundStyle(Color.textSecondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 320)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Form

    private var form: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                fieldLabel("Device")
                Picker("", selection: $selectedDeviceId) {
                    ForEach(tentacles, id: \.id) { device in
                        HStack {
                            Circle()
                                .fill(device.online ? Color(hex: 0x34D399) : Color.textMuted)
                                .frame(width: 6, height: 6)
                            Text(device.name)
                        }
                        .tag(device.id)
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
            }

            VStack(alignment: .leading, spacing: 6) {
                fieldLabel("Agent")
                Picker("", selection: $selectedAgentId) {
                    if agents.isEmpty {
                        Text("Loading…").tag("")
                    }
                    ForEach(agents, id: \.id) { agent in
                        Text(AgentInfo.from(agent.id).label).tag(agent.id)
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .disabled(agents.isEmpty)
            }

            VStack(alignment: .leading, spacing: 6) {
                fieldLabel("Model")
                Picker("", selection: $selectedModel) {
                    if models.isEmpty {
                        Text("Loading…").tag("")
                    }
                    ForEach(models, id: \.self) { model in
                        Text(model).tag(model)
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .disabled(models.isEmpty)
            }

            if let efforts = supportedEfforts, !efforts.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    fieldLabel("Reasoning")
                    Picker("", selection: Binding(
                        get: { reasoningEffort?.rawValue ?? "" },
                        set: { reasoningEffort = ReasoningEffort(rawValue: $0) }
                    )) {
                        ForEach(efforts, id: \.rawValue) { effort in
                            Text(effortLabel(effort)).tag(effort.rawValue)
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.segmented)
                }
            }

            VStack(alignment: .leading, spacing: 6) {
                fieldLabel("Title (optional)")
                TextField("Session title", text: $sessionTitle)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(submit)
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 20)
        .padding(.top, 18)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func fieldLabel(_ text: String) -> some View {
        Text(text.uppercased())
            .font(.system(size: 10, weight: .semibold))
            .tracking(0.8)
            .foregroundStyle(Color.textMuted)
    }

    // MARK: - Footer

    private var footer: some View {
        HStack {
            Spacer()
            Button("Cancel") { isPresented = false }
                .keyboardShortcut(.cancelAction)
            Button("Create") { submit() }
                .keyboardShortcut(.defaultAction)
                .disabled(!canSubmit)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .background(Color.surfaceSecondary)
    }

    // MARK: - Actions

    private func submit() {
        guard canSubmit else { return }
        let trimmed = sessionTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        appState.commandSender?.createSession(
            targetDeviceId: selectedDeviceId,
            agentId: selectedAgentId,
            model: selectedModel,
            reasoningEffort: reasoningEffort,
            prompt: nil,
            cwd: nil,
            title: trimmed.isEmpty ? nil : trimmed
        )
        isPresented = false
    }

    private func selectDefaults() {
        if selectedDeviceId.isEmpty {
            selectedDeviceId = onlineTentacles.first?.id ?? tentacles.first?.id ?? ""
        }
        onDeviceChanged()
    }

    private func onDeviceChanged() {
        if !agents.contains(where: { $0.id == selectedAgentId }) {
            selectedAgentId = agents.first?.id ?? ""
        }
        onAgentChanged()
    }

    private func onAgentChanged() {
        if !models.contains(selectedModel) {
            selectedModel = models.first ?? ""
        }
        onModelChanged()
    }

    private func onModelChanged() {
        if let efforts = supportedEfforts, !efforts.isEmpty {
            if reasoningEffort == nil || !efforts.contains(reasoningEffort!) {
                reasoningEffort = efforts.first
            }
        } else {
            reasoningEffort = nil
        }
    }

    private func effortLabel(_ effort: ReasoningEffort) -> String {
        switch effort {
        case .low: return "Low"
        case .medium: return "Medium"
        case .high: return "High"
        case .xhigh: return "Max"
        }
    }
}
#endif
