#if os(macOS)
import SwiftUI

/// Compact Mac presentation of the same information/actions exposed by the iOS
/// SessionInfoSheet, presented by the chat (MacChatView) so the More button is
/// not a dead affordance on macOS.
struct MacSessionInfoSheet: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    let session: SessionInfo
    /// Rename…: open with the title field focused for editing.
    let startsRenaming: Bool

    @State private var editingTitle: Bool
    @State private var titleDraft: String
    @State private var showDeleteConfirmation = false
    @State private var sessionIDCopied = false
    @State private var sessionIDCopyFeedbackTask: Task<Void, Never>?
    @State private var selectedModel: String
    @State private var reasoningEffort: ReasoningEffort?
    @FocusState private var titleFocused: Bool

    init(session: SessionInfo, startsRenaming: Bool = false) {
        self.session = session
        self.startsRenaming = startsRenaming
        _editingTitle = State(initialValue: startsRenaming)
        _titleDraft = State(initialValue: startsRenaming ? (session.title ?? session.autoTitle ?? "") : "")
        _selectedModel = State(initialValue: session.model ?? "")
        _reasoningEffort = State(initialValue: session.reasoningEffort)
    }

    private var liveSession: SessionInfo {
        appState.sessionStore.sessions[session.id] ?? session
    }
    private var currentMode: SessionMode {
        appState.sessionStore.sessionModes[session.id] ?? session.mode
    }
    private var usage: SessionUsage? {
        appState.sessionStore.sessionUsage[session.id] ?? session.usage
    }
    private var device: DeviceSummary? {
        appState.deviceStore.devices[session.deviceId]
    }
    private var version: String? {
        appState.deviceStore.deviceVersions[session.deviceId]
    }
    private var availableModels: [String] {
        appState.deviceStore.models(for: session.deviceId, agentId: session.agent)
    }
    private var modelDetails: [ModelDetail] {
        appState.deviceStore.modelDetails(for: session.deviceId, agentId: session.agent)
    }
    /// The model's name as the pickers and the session list show it.
    private func modelName(_ id: String?) -> String? {
        appState.deviceStore.modelDisplayName(id, deviceId: session.deviceId, agent: session.agent)
    }
    private var supportedEfforts: [ReasoningEffort] {
        guard let detail = modelDetails.first(where: { $0.id == selectedModel }),
              detail.supportsReasoningEffort else { return [] }
        return detail.supportedReasoningEfforts ?? []
    }
    private var contextWindow: Int? {
        guard let model = liveSession.model else { return nil }
        return modelDetails.first(where: { $0.id == model })?.contextWindow
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Session Info").font(.system(size: 17, weight: .semibold))
                Spacer()
                Button("Done") {
                    // Done closes the sheet without the title field losing
                    // focus first: save what was typed.
                    saveTitleIfEdited()
                    dismiss()
                }
                    .keyboardShortcut(.cancelAction)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 14)

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    // Mode lives in the chat header (single entry point, as on iOS).
                    sessionSection
                    if let usage { usageSection(usage) }
                    if let device { deviceSection(device) }
                    actionsSection
                }
                .padding(20)
            }
        }
        .frame(width: 440, height: 580)
        .background(Color.surfacePrimary)
        .onAppear {
            syncModelConfiguration()
            if startsRenaming { DispatchQueue.main.async { titleFocused = true } }
        }
        .onChange(of: liveSession.model) { _, _ in syncModelConfiguration() }
        .onChange(of: liveSession.reasoningEffort) { _, _ in syncModelConfiguration() }
        .onDisappear {
            // Closed any other way while the title is still being edited:
            // keep what was typed, by the same rules (review #91).
            saveTitleIfEdited()
            sessionIDCopyFeedbackTask?.cancel()
            sessionIDCopyFeedbackTask = nil
        }
        .confirmationDialog(
            "Delete Session",
            isPresented: $showDeleteConfirmation,
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                appState.commandSender?.deleteSession(sessionId: session.id)
                dismiss()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This will permanently delete this session and all its messages.")
        }
    }

    private var sessionSection: some View {
        VStack(alignment: .leading, spacing: 9) {
            sectionHeader("Session")
            infoRow(label: "Title") {
                if editingTitle {
                    TextField("Session title", text: $titleDraft)
                        .multilineTextAlignment(.trailing)
                        .focused($titleFocused)
                        .onSubmit { commitTitleEdit() }
                        // Esc here goes to the field editor, not to Done's
                        // shortcut: save what was typed and close, like Done.
                        .onExitCommand {
                            saveTitleIfEdited()
                            dismiss()
                        }
                        .onChange(of: titleFocused) { _, focused in
                            if !focused && editingTitle { commitTitleEdit() }
                        }
                } else {
                    Button {
                        titleDraft = titleEditOriginal
                        editingTitle = true
                        DispatchQueue.main.async { titleFocused = true }
                    } label: {
                        HStack(spacing: 4) {
                            Text(verbatim: session.displayTitle).lineLimit(1).truncationMode(.middle)
                            LucideIcon(.pencil, size: 11, strokeWidth: 2, color: .secondary)
                        }
                    }
                    .buttonStyle(.plain)
                    .help(MacControlHelp.rename)
                }
            }
            sessionIDRow
            infoRow("Agent", session.agent)
            infoRow(label: "Model") {
                if availableModels.isEmpty {
                    Text(verbatim: modelName(liveSession.model) ?? "—")
                } else {
                    Picker("", selection: Binding(
                        get: { selectedModel },
                        set: { applyModel($0) }
                    )) {
                        ForEach(availableModels, id: \.self) { Text(verbatim: modelName($0) ?? $0).tag($0) }
                    }
                    .labelsHidden()
                    .frame(maxWidth: 250, alignment: .trailing)
                }
            }
            if !supportedEfforts.isEmpty {
                infoRow(label: "Thinking") {
                    Picker("", selection: Binding(
                        get: { reasoningEffort ?? supportedEfforts[0] },
                        set: { applyReasoningEffort($0) }
                    )) {
                        ForEach(supportedEfforts, id: \.rawValue) { effort in
                            Text(effortLabel(effort)).tag(effort)
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.segmented)
                    .frame(maxWidth: 250, alignment: .trailing)
                }
            }
            infoRow("Created", session.createdAt.formatted(date: .abbreviated, time: .shortened))
        }
    }

    private func syncModelConfiguration() {
        selectedModel = liveSession.model ?? availableModels.first ?? ""
        reasoningEffort = normalizedEffort(
            for: selectedModel,
            preferred: liveSession.reasoningEffort
        )
    }

    private func normalizedEffort(for model: String, preferred: ReasoningEffort?) -> ReasoningEffort? {
        MacSessionInfoRules.effort(for: model, in: modelDetails, preferred: preferred)
    }

    private func applyModel(_ model: String) {
        selectedModel = model
        let effort = MacSessionInfoRules.effortAfterModelChange(
            to: model, in: modelDetails, current: reasoningEffort
        )
        reasoningEffort = effort
        appState.commandSender?.setSessionModel(
            sessionId: session.id,
            model: model,
            reasoningEffort: effort
        )
    }

    private func applyReasoningEffort(_ effort: ReasoningEffort) {
        reasoningEffort = effort
        appState.commandSender?.setSessionModel(
            sessionId: session.id,
            model: selectedModel,
            reasoningEffort: effort
        )
    }

    private func effortLabel(_ effort: ReasoningEffort) -> String {
        switch effort {
        case .low: return String(localized: "Low")
        case .medium: return String(localized: "Medium")
        case .high: return String(localized: "High")
        case .xhigh: return String(localized: "XHigh")
        case .max: return String(localized: "Max")
        }
    }

    private var sessionIDRow: some View {
        infoRow(label: "Session ID") {
            HStack(spacing: 7) {
                Text(verbatim: session.id)
                    .font(.system(size: 12.5, weight: .regular, design: .monospaced))
                    .foregroundStyle(Color.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
                    .help(session.id)
                    .accessibilityLabel("Session ID \(session.id)")

                Button(action: copySessionID) {
                    HStack(spacing: 4) {
                        Image(systemName: sessionIDCopied ? "checkmark" : "doc.on.doc")
                            .font(.system(size: 11, weight: .semibold))
                        if sessionIDCopied {
                            Text("Copied")
                                .font(.system(size: 11, weight: .medium))
                        }
                    }
                    .foregroundStyle(sessionIDCopied ? Color.green : Color.textSecondary)
                    .frame(width: 64, height: 24, alignment: .trailing)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(sessionIDCopied ? String(localized: "Session ID copied") : String(localized: "Copy Session ID"))
                .accessibilityLabel(sessionIDCopied ? String(localized: "Session ID copied") : String(localized: "Copy Session ID"))
                .accessibilityHint("Copies the complete Session ID to the clipboard")
            }
            .frame(maxWidth: 285, alignment: .trailing)
        }
    }

    private func copySessionID() {
        KrakiPasteboard.setString(session.id)
        sessionIDCopyFeedbackTask?.cancel()
        withAnimation(.easeInOut(duration: 0.15)) {
            sessionIDCopied = true
        }
        sessionIDCopyFeedbackTask = Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.5))
            guard !Task.isCancelled else { return }
            withAnimation(.easeInOut(duration: 0.15)) {
                sessionIDCopied = false
            }
            sessionIDCopyFeedbackTask = nil
        }
    }

    private func usageSection(_ usage: SessionUsage) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            sectionHeader("Usage")
            if let used = usage.contextTokens {
                if let ceiling = contextWindow, ceiling > 0 {
                    let ratio = min(1, Double(used) / Double(ceiling))
                    let context = "\(MacChatFormat.tokenCount(used)) / \(MacChatFormat.tokenCount(ceiling))  ·  \(ratio.formatted(.percent.precision(.fractionLength(0))))"
                    VStack(alignment: .leading, spacing: 6) {
                        infoRow("Context", context)
                        ProgressView(value: ratio).tint(contextBandColor(ratio))
                    }
                } else {
                    infoRow("Context", MacChatFormat.tokenCount(used))
                }
            }
            infoRow("Input tokens", MacChatFormat.tokenCount(usage.inputTokens))
            infoRow("Output tokens", MacChatFormat.tokenCount(usage.outputTokens))
            infoRow("Cache read", MacChatFormat.tokenCount(usage.cacheReadTokens))
            infoRow("Cache write", MacChatFormat.tokenCount(usage.cacheWriteTokens))
            Divider()
            infoRow("Total cost", MacChatFormat.cost(usage.totalCost))
            infoRow("Duration", MacChatFormat.duration(usage.totalDurationMs))
        }
    }

    private func deviceSection(_ device: DeviceSummary) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            sectionHeader("Device")
            infoRow("Name", device.name)
            infoRow(label: "Status") {
                HStack(spacing: 4) {
                    Circle().fill(device.online ? Color.green : Color.gray).frame(width: 6, height: 6)
                    Text(device.online ? String(localized: "Online") : String(localized: "Offline"))
                }
            }
            if let version { infoRow("Version", version) }
        }
    }

    private var actionsSection: some View {
        HStack(spacing: 12) {
            Button {
                appState.commandSender?.forkSession(sessionId: session.id)
                dismiss()
            } label: {
                HStack(spacing: 5) {
                    LucideIcon(.gitFork, size: 16, color: .krakiPrimary)
                    Text("Fork")
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .tint(.krakiPrimary)

            Button(role: .destructive) { showDeleteConfirmation = true } label: {
                Label("Delete", systemImage: "trash").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .tint(.red)
        }
    }

    /// What the title field starts from.
    private var titleEditOriginal: String {
        session.title ?? session.autoTitle ?? ""
    }

    private func commitTitleEdit() {
        saveTitleIfEdited()
        titleFocused = false
    }

    /// Not editing, or unchanged: no rename, so an auto title does not
    /// become a fixed one (and clearing a never-set title is a no-op).
    private func saveTitleIfEdited() {
        if let title = MacSessionInfoRules.titleToSaveOnClose(
            editing: editingTitle, draft: titleDraft, session: session
        ) {
            appState.commandSender?.renameSession(sessionId: session.id, title: title)
        }
        editingTitle = false
    }

    private func sectionHeader(_ title: LocalizedStringKey) -> some View {
        Text(title)
            .font(.caption.weight(.semibold))
            .textCase(.uppercase)
            .foregroundStyle(.secondary)
    }

    private func infoRow(_ label: LocalizedStringKey, _ value: String) -> some View {
        infoRow(label: label) { Text(verbatim: value).multilineTextAlignment(.trailing) }
    }

    private func infoRow<Trailing: View>(
        label: LocalizedStringKey,
        @ViewBuilder trailing: () -> Trailing
    ) -> some View {
        HStack(spacing: 8) {
            Text(label).foregroundStyle(.secondary)
            Spacer(minLength: 8)
            trailing()
        }
        .font(.system(size: 15))
        .contentShape(Rectangle())
    }

    private func contextBandColor(_ ratio: Double) -> Color {
        if ratio >= 0.85 { return .red }
        if ratio >= 0.60 { return Color(hex: 0xFBBF24) }
        return .green
    }
}
#endif
