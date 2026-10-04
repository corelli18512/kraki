#if os(macOS)
/// New session on Mac: one composer, used in two places.
///
/// - `MacStartSessionView` — the main window's idle pane (nothing selected):
///   a short heading and the composer, so starting work is the obvious thing.
/// - `NewSessionSheet` — ⌘N / the sidebar "+": the same composer in a sheet.
///
/// The composer is a message box first: type what the agent should do and
/// press Return. Computer, agent, model and reasoning are compact pills
/// under the text — remembered per computer/agent, so most people never touch
/// them. Return with an empty box just opens an empty session.
import SwiftUI

// MARK: - Composer

struct NewSessionComposer: View {
    @Environment(AppState.self) private var appState
    @Environment(TentacleCLIManager.self) private var tentacleCLI

    var placeholder = "Describe a task, e.g. “Fix the failing tests in my-app”"
    var minLines = 3
    var onCreated: () -> Void = {}

    @State private var text = ""
    @State private var selectedDeviceId = ""
    @State private var selectedAgentId: AgentId = ""
    @State private var selectedModel = ""
    @State private var reasoningEffort: ReasoningEffort?
    @FocusState private var focused: Bool

    private var deviceStore: DeviceStore { appState.deviceStore }
    private var tentacles: [DeviceSummary] { deviceStore.tentacleDevices }
    private var onlineTentacles: [DeviceSummary] { tentacles.filter(\.online) }
    private var offlineTentacles: [DeviceSummary] { tentacles.filter { !$0.online } }
    private var agents: [AgentCapabilities] { deviceStore.agents(for: selectedDeviceId) }
    private var availability: DeviceStore.AgentAvailability { deviceStore.agentAvailability(for: selectedDeviceId) }
    private var selectedDevice: DeviceSummary? { tentacles.first { $0.id == selectedDeviceId } }
    private var localDeviceId: String? { tentacleCLI.configInfo?.deviceId }
    private var selectedIsThisMac: Bool { localDeviceId != nil && localDeviceId == selectedDeviceId }
    private var activeAgent: AgentCapabilities? { agents.first { $0.id == selectedAgentId } ?? agents.first }
    private var models: [String] { activeAgent?.models ?? [] }
    private var modelDetails: [ModelDetail] { activeAgent?.modelDetails ?? [] }
    private var supportedEfforts: [ReasoningEffort]? {
        guard let d = modelDetails.first(where: { $0.id == selectedModel }), d.supportsReasoningEffort else { return nil }
        return d.supportedReasoningEfforts
    }
    private var canSubmit: Bool {
        availability == .ready && !selectedDeviceId.isEmpty && !selectedAgentId.isEmpty && !selectedModel.isEmpty
    }
    private var hasText: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 10) {
                TextField("", text: $text, prompt: Text(placeholder).foregroundStyle(Color.textMuted), axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(.system(size: 14))
                    .lineLimit(minLines...10)
                    .focused($focused)
                    .onKeyPress(.return, phases: .down) { press in
                        if press.modifiers.contains(.shift) || press.modifiers.contains(.option) {
                            text += "\n"
                        } else {
                            submit()
                        }
                        return .handled
                    }
                    .accessibilityIdentifier("mac.newSession.text")
                HStack(spacing: 6) {
                    devicePill
                    if availability == .ready {
                        agentPill
                        modelPill
                        if let efforts = supportedEfforts, !efforts.isEmpty { effortPill(efforts) }
                    }
                    Spacer(minLength: 8)
                    sendButton
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 10)
            .background(composerBackground)
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .strokeBorder(focused ? Color.krakiPrimary.opacity(0.45) : Color.borderPrimary.opacity(0.6), lineWidth: 1)
            )
            .contentShape(Rectangle())
            .onTapGesture { focused = true }

            statusLine
        }
        .onAppear { selectDefaults(); focused = true }
        .onChange(of: selectedDeviceId) { _, _ in onDeviceChanged() }
        .onChange(of: selectedAgentId) { _, _ in onAgentChanged() }
        .onChange(of: selectedModel) { _, _ in onModelChanged() }
        .onChange(of: agents.map(\.id)) { _, _ in onDeviceChanged() }
        .onChange(of: onlineTentacles.map(\.id)) { _, _ in if selectedDevice?.online != true { selectDefaults() } }
        .onChange(of: reasoningEffort) { _, effort in
            if let effort, !selectedModel.isEmpty { SessionPrefs.saveLastEffort(model: selectedModel, effort: effort) }
        }
    }

    @ViewBuilder
    private var composerBackground: some View {
        let shape = RoundedRectangle(cornerRadius: 18, style: .continuous)
        if #available(macOS 26.0, *) {
            Color.clear.glassEffect(.regular, in: shape)
        } else {
            shape.fill(Color.surfaceSecondary)
        }
    }

    // MARK: Pills

    private var devicePill: some View {
        Menu {
            if !onlineTentacles.isEmpty {
                Section("Online") {
                    ForEach(onlineTentacles, id: \.id) { d in
                        Toggle(isOn: Binding(get: { d.id == selectedDeviceId }, set: { if $0 { selectedDeviceId = d.id } })) {
                            Text(d.id == localDeviceId ? "\(d.name) (this Mac)" : d.name)
                        }
                    }
                }
            }
            if !offlineTentacles.isEmpty {
                Section("Offline") {
                    ForEach(offlineTentacles, id: \.id) { d in Text(d.name) }
                }
                .disabled(true)
            }
        } label: {
            PillLabel(icon: selectedIsThisMac ? "laptopcomputer" : "desktopcomputer",
                      text: selectedDevice.map { $0.id == localDeviceId ? "This Mac" : $0.name } ?? "Choose a computer",
                      dot: selectedDevice?.online == true ? Color(hex: 0x34D399) : Color.textMuted)
        }
        .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
        .help(selectedDevice?.name ?? "")
        .accessibilityIdentifier("mac.newSession.device")
    }

    private var agentPill: some View {
        Menu {
            ForEach(agents, id: \.id) { a in
                Toggle(isOn: Binding(get: { a.id == selectedAgentId }, set: { if $0 { selectedAgentId = a.id } })) {
                    Text(AgentInfo.from(a.id).label)
                }
            }
        } label: {
            PillLabel(icon: "sparkle", text: AgentInfo.from(selectedAgentId).label)
        }
        .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
        .disabled(agents.count < 2)
        .accessibilityIdentifier("mac.newSession.agent")
    }

    private func modelName(_ id: String) -> String {
        modelDetails.first { $0.id == id }?.name ?? id
    }

    private var modelPill: some View {
        Menu {
            ForEach(models, id: \.self) { m in
                Toggle(isOn: Binding(get: { m == selectedModel }, set: { if $0 { selectedModel = m } })) {
                    Text(modelName(m))
                }
            }
        } label: {
            PillLabel(icon: "cpu", text: selectedModel.isEmpty ? "Model" : modelName(selectedModel))
        }
        .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
        .disabled(models.count < 2)
        .accessibilityIdentifier("mac.newSession.model")
    }

    private func effortPill(_ efforts: [ReasoningEffort]) -> some View {
        Menu {
            ForEach(efforts, id: \.rawValue) { e in
                Toggle(isOn: Binding(get: { e == reasoningEffort }, set: { if $0 { reasoningEffort = e } })) {
                    Text(effortLabel(e))
                }
            }
        } label: {
            PillLabel(icon: "brain", text: reasoningEffort.map(effortLabel) ?? "Reasoning")
        }
        .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
        .accessibilityIdentifier("mac.newSession.effort")
    }

    private var sendButton: some View {
        Button(action: submit) {
            Image(systemName: "arrow.up")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 30, height: 30)
                .background(Circle().fill(Color.krakiPrimary))
                .opacity(canSubmit ? (hasText ? 1 : 0.75) : 0.3)
        }
        .buttonStyle(.plain)
        .disabled(!canSubmit)
        .help(hasText ? "Start session (Return)" : "Start an empty session (Return)")
        .accessibilityIdentifier("mac.newSession.create")
    }

    // MARK: Status under the box

    @ViewBuilder
    private var statusLine: some View {
        if tentacles.isEmpty || onlineTentacles.isEmpty {
            hint("moon.zzz", "No computer is online. Open Kraki on a computer to start a session there.")
        } else {
            switch availability {
            case .ready:
                EmptyView()
            case .connecting:
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text("Connecting to \(selectedDevice?.name ?? "the computer")…")
                        .font(.system(size: 11.5)).foregroundStyle(Color.textMuted)
                }.padding(.leading, 4)
            case .offline:
                hint("moon.zzz", "\(selectedDevice?.name ?? "This computer") is offline. Pick another one above.")
            case .noAgents:
                NoAgentsGuide(deviceName: selectedIsThisMac ? "this Mac" : (selectedDevice?.name ?? "this computer"),
                              isThisMac: selectedIsThisMac,
                              checkAgain: selectedIsThisMac ? { await recheckLocalAgents() } : nil)
                    .padding(14)
                    .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.surfaceSecondary))
            }
        }
    }

    private func hint(_ icon: String, _ text: String) -> some View {
        Label(text, systemImage: icon)
            .font(.system(size: 11.5)).foregroundStyle(Color.textMuted)
            .padding(.leading, 4)
    }

    // MARK: Actions

    private func submit() {
        guard canSubmit else { return }
        SessionPrefs.saveLastDevice(selectedDeviceId)
        SessionPrefs.saveLastAgent(deviceId: selectedDeviceId, agentId: selectedAgentId)
        SessionPrefs.saveLastModel(deviceId: selectedDeviceId, agentId: selectedAgentId, model: selectedModel)
        if let reasoningEffort { SessionPrefs.saveLastEffort(model: selectedModel, effort: reasoningEffort) }
        let prompt = text.trimmingCharacters(in: .whitespacesAndNewlines)
        appState.commandSender?.createSession(
            targetDeviceId: selectedDeviceId, agentId: selectedAgentId, model: selectedModel,
            reasoningEffort: reasoningEffort, prompt: prompt.isEmpty ? nil : prompt, cwd: nil, title: nil
        )
        text = ""
        onCreated()
    }

    private func recheckLocalAgents() async {
        await tentacleCLI.restartDaemon()
        for _ in 0..<40 {
            try? await Task.sleep(nanoseconds: 250_000_000)
            if !agents.isEmpty { return }
        }
    }

    /// Last-used computer if online; else this Mac if online; else any online one.
    private func selectDefaults() {
        let saved = SessionPrefs.lastDeviceId()
        selectedDeviceId = onlineTentacles.first(where: { $0.id == saved })?.id
            ?? onlineTentacles.first(where: { $0.id == localDeviceId })?.id
            ?? onlineTentacles.first?.id
            ?? tentacles.first?.id
            ?? ""
        onDeviceChanged()
    }

    private func onDeviceChanged() {
        guard !selectedDeviceId.isEmpty else { return }
        if let saved = SessionPrefs.lastAgentId(deviceId: selectedDeviceId), agents.contains(where: { $0.id == saved }) {
            selectedAgentId = saved
        } else if !agents.contains(where: { $0.id == selectedAgentId }) {
            selectedAgentId = agents.first?.id ?? ""
        }
        onAgentChanged()
    }

    private func onAgentChanged() {
        guard !selectedAgentId.isEmpty else { selectedModel = ""; reasoningEffort = nil; return }
        if let saved = SessionPrefs.lastModel(deviceId: selectedDeviceId, agentId: selectedAgentId), models.contains(saved) {
            selectedModel = saved
        } else if !models.contains(selectedModel) {
            selectedModel = models.first ?? ""
        }
        onModelChanged()
    }

    private func onModelChanged() {
        guard !selectedModel.isEmpty, let efforts = supportedEfforts, !efforts.isEmpty else { reasoningEffort = nil; return }
        if let saved = SessionPrefs.lastEffort(model: selectedModel), efforts.contains(saved) {
            reasoningEffort = saved
        } else if reasoningEffort == nil || !efforts.contains(reasoningEffort!) {
            reasoningEffort = efforts.contains(.medium) ? .medium : efforts.first
        }
    }

    private func effortLabel(_ effort: ReasoningEffort) -> String {
        switch effort {
        case .low: return "Low"
        case .medium: return "Medium"
        case .high: return "High"
        case .xhigh: return "Extra high"
        case .max: return "Max"
        }
    }
}

/// A compact rounded pill: icon, value, small chevron.
private struct PillLabel: View {
    let icon: String
    let text: String
    var dot: Color?
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 5) {
            if let dot {
                Circle().fill(dot).frame(width: 6, height: 6)
            } else {
                Image(systemName: icon).font(.system(size: 10.5, weight: .medium))
            }
            Text(text).font(.system(size: 11.5, weight: .medium)).lineLimit(1)
            Image(systemName: "chevron.down").font(.system(size: 7.5, weight: .bold)).opacity(0.6)
        }
        .foregroundStyle(Color.textSecondary)
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(Capsule(style: .continuous).fill(Color.textPrimary.opacity(hovering ? 0.12 : 0.07)))
        .contentShape(Capsule())
        .onHover { hovering = $0 }
    }
}

// MARK: - Idle pane

/// What the main window shows when no session is selected and Kraki is
/// ready: a heading, the composer, and a quiet way to add the phone.
struct MacStartSessionView: View {
    @Environment(AppState.self) private var appState
    var firstTime: Bool

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            VStack(spacing: 22) {
                VStack(spacing: 8) {
                    Image("KrakiLogo")
                        .resizable().interpolation(.high)
                        .frame(width: 44, height: 44)
                    Text(firstTime ? "What should we work on first?" : "What's next?")
                        .font(.system(size: 24, weight: .semibold))
                        .foregroundStyle(Color.textTitle)
                }
                NewSessionComposer()
                    .frame(maxWidth: 640)
                if firstTime {
                    Button {
                        NotificationCenter.default.post(name: .macOpenPairing, object: nil)
                    } label: {
                        Label("Use Kraki on your phone too", systemImage: "iphone")
                            .font(.system(size: 11.5))
                            .foregroundStyle(Color.textMuted)
                    }
                    .buttonStyle(.plain)
                    .onHover { inside in if inside { NSCursor.pointingHand.push() } else { NSCursor.pop() } }
                }
            }
            .padding(.horizontal, 40)
            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Sheet

struct NewSessionSheet: View {
    @Binding var isPresented: Bool
    var onCreated: (String) -> Void = { _ in }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("New session")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Color.textPrimary)
                Spacer()
                Button { isPresented = false } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(Color.textMuted)
                        .frame(width: 22, height: 22)
                        .background(Circle().fill(Color.textPrimary.opacity(0.07)))
                }
                .buttonStyle(.plain)
                .keyboardShortcut(.cancelAction)
                .help("Cancel (Esc)")
            }
            NewSessionComposer(placeholder: "Describe a task, or just press Return for an empty session", minLines: 4) {
                isPresented = false
            }
            Text("Return to start · Shift-Return for a new line · Esc to cancel")
                .font(.system(size: 10.5))
                .foregroundStyle(Color.textMuted)
        }
        .padding(20)
        .frame(width: 620)
        .background(Color.surfacePrimary)
    }
}
#endif
