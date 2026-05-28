#if os(iOS)
/// SessionInfoSheet — Detail sheet for session metadata, usage, and mode.
///
/// Presented from the session detail "more" button as a medium-detent sheet.
/// Dismiss with the standard swipe-down gesture — no explicit Done button.

import SwiftUI

struct SessionInfoSheet: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    let session: SessionInfo

    @State private var showDeleteConfirmation = false
    @State private var editingTitle = false
    @State private var titleDraft = ""
    @FocusState private var titleFieldFocused: Bool

    private var usage: SessionUsage? {
        appState.sessionStore.sessionUsage[session.id]
    }

    private var device: DeviceSummary? {
        appState.deviceStore.devices[session.deviceId]
    }

    private var version: String? {
        appState.deviceStore.deviceVersions[session.deviceId]
    }

    private var availableModels: [String] {
        appState.deviceStore.deviceModels[session.deviceId] ?? []
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    modeSection
                    sessionSection
                    usageSection
                    deviceSection
                    actionsSection
                }
                .padding(.horizontal)
                .padding(.bottom)
            }
            .navigationTitle("Session Info")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: ModelPickerNav.self) { _ in
                ModelPickerScreen(session: session)
                    .environment(appState)
            }
            .alert("Delete Session", isPresented: $showDeleteConfirmation) {
                Button("Cancel", role: .cancel) {}
                Button("Delete", role: .destructive) {
                    appState.commandSender?.deleteSession(sessionId: session.id)
                    // Dismiss the sheet AND signal MainTabView to
                    // pop the session navigation stack — otherwise
                    // the user lands on a "Session not found"
                    // placeholder where the deleted session used to
                    // be, instead of the session list.
                    dismiss()
                    appState.sessionStore.popToSessionListSignal &+= 1
                }
            } message: {
                Text("This will permanently delete this session and all its messages.")
            }
        }
        .presentationDetents([.medium, .large])
    }

    // MARK: - Mode (top of sheet — most-used control)

    private var modeSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader("Mode")

            let modes: [SessionMode] = [.safe, .discuss, .execute, .delegate]
            let currentMode = appState.sessionStore.sessionModes[session.id] ?? session.mode

            TintedSegmentedControl(
                items: modes.map { $0.rawValue.capitalized },
                selection: Binding(
                    get: { modes.firstIndex(of: currentMode) ?? 1 },
                    set: { idx in
                        appState.commandSender?.setSessionMode(sessionId: session.id, mode: modes[idx])
                    }
                ),
                tintColor: UIColor(Color.modeColor(currentMode))
            )
            .frame(maxWidth: .infinity)
            .frame(height: 32)
            .animation(.easeInOut(duration: 0.3), value: currentMode)
        }
    }

    // MARK: - Session

    private var sessionSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader("Session")

            titleRow
            infoRow("Agent", value: session.agent)
            modelRow
            infoRow("Created", value: session.createdAt.formatted(date: .abbreviated, time: .shortened))
        }
    }

    /// Title row with inline edit affordance. Tapping the row puts the
    /// title into edit mode (matches the web `SessionInfoPanel`
    /// behaviour): pencil glyph indicates the row is renameable; the
    /// TextField commits on submit / blur. Submitting an empty string
    /// clears the manual title and reverts to the auto-generated one
    /// (`rename_session` payload contract).
    @ViewBuilder
    private var titleRow: some View {
        infoRow(label: "Title") {
            if editingTitle {
                TextField("Session title", text: $titleDraft)
                    .multilineTextAlignment(.trailing)
                    .submitLabel(.done)
                    .textInputAutocapitalization(.sentences)
                    .focused($titleFieldFocused)
                    .onSubmit { commitTitleEdit() }
                    .onChange(of: titleFieldFocused) { _, focused in
                        // Treat blur as "save" — same as web's onBlur.
                        if !focused && editingTitle { commitTitleEdit() }
                    }
            } else {
                Button {
                    titleDraft = session.title ?? session.autoTitle ?? ""
                    editingTitle = true
                    // Defer focus until the TextField has been
                    // instantiated; without this, .focused() can't
                    // attach before the same runloop tick ends.
                    DispatchQueue.main.async { titleFieldFocused = true }
                } label: {
                    HStack(spacing: 4) {
                        Text(session.displayTitle)
                            .foregroundStyle(.primary)
                            .multilineTextAlignment(.trailing)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        LucideIcon(.pencil, size: 11, strokeWidth: 2, color: .secondary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func commitTitleEdit() {
        let trimmed = titleDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        appState.commandSender?.renameSession(sessionId: session.id, title: trimmed)
        editingTitle = false
        titleFieldFocused = false
    }

    /// Tappable model row that pushes the in-sheet model picker.
    /// Mirrors the picker UX in `NewSessionSheet` so the same gesture
    /// is used to choose a model in both surfaces.
    @ViewBuilder
    private var modelRow: some View {
        let label = session.model ?? "Select"
        let canTap = !availableModels.isEmpty
        if canTap {
            NavigationLink(value: ModelPickerNav()) {
                infoRow(label: "Model") {
                    HStack(spacing: 4) {
                        Text(label)
                            .foregroundStyle(.primary)
                            .multilineTextAlignment(.trailing)
                        Image(systemName: "chevron.right")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
            .buttonStyle(.plain)
        } else if let model = session.model {
            infoRow("Model", value: model)
        }
    }

    // MARK: - Usage

    @ViewBuilder
    private var usageSection: some View {
        if let usage {
            VStack(alignment: .leading, spacing: 8) {
                sectionHeader("Usage")

                contextRow(usage: usage)

                tokenRow("Input tokens", count: usage.inputTokens)
                tokenRow("Output tokens", count: usage.outputTokens)
                tokenRow("Cache read", count: usage.cacheReadTokens)
                tokenRow("Cache write", count: usage.cacheWriteTokens)

                Divider()

                infoRow("Total cost", value: formatCost(usage.totalCost))
                infoRow("Duration", value: formatDuration(usage.totalDurationMs))
            }
        }
    }

    /// Hard ceiling for the session's current model, if the adapter
    /// publishes one. Read from `deviceModelDetails` keyed by the
    /// session's deviceId + model id.
    private var contextWindow: Int? {
        guard let model = session.model else { return nil }
        return appState.deviceStore.deviceModelDetails[session.deviceId]?
            .first(where: { $0.id == model })?.contextWindow
    }

    /// Renders a "Context" row when we have both the per-turn prompt
    /// usage from tentacle (`SessionUsage.contextTokens`) and the
    /// model's ceiling. Without the ceiling we still surface the raw
    /// token count so the value isn't silently dropped.
    @ViewBuilder
    private func contextRow(usage: SessionUsage) -> some View {
        if let used = usage.contextTokens {
            if let ceiling = contextWindow, ceiling > 0 {
                let ratio = min(1.0, Double(used) / Double(ceiling))
                let percent = Int((ratio * 100).rounded())
                VStack(alignment: .leading, spacing: 6) {
                    infoRow(label: "Context") {
                        Text("\(formatTokenCount(used)) / \(formatTokenCount(ceiling))  ·  \(percent)%")
                            .foregroundStyle(.primary)
                            .multilineTextAlignment(.trailing)
                    }
                    ProgressView(value: ratio)
                        .tint(contextBandColor(ratio: ratio))
                }
            } else {
                tokenRow("Context", count: used)
            }
        }
    }

    /// Green below 60%, amber under 85%, red above. Matches the
    /// "approach the ceiling" mental model.
    private func contextBandColor(ratio: Double) -> Color {
        if ratio >= 0.85 { return .red }
        if ratio >= 0.60 { return Color(hex: 0xFBBF24) }
        return .green
    }

    // MARK: - Device

    @ViewBuilder
    private var deviceSection: some View {
        if let device {
            VStack(alignment: .leading, spacing: 8) {
                sectionHeader("Device")

                // Tapping the device row exits the chat view entirely
                // and lands on the device detail panel in the Devices
                // tab — same UX as picking the device from the
                // Devices tab itself. Dismisses the sheet AND triggers
                // cross-tab navigation via `DeviceStore.navigateToDeviceId`
                // which `MainTabView` watches.
                Button {
                    dismiss()
                    appState.deviceStore.navigateToDeviceId = device.id
                } label: {
                    infoRow(label: "Name") {
                        HStack(spacing: 4) {
                            Text(device.name)
                                .foregroundStyle(.primary)
                                .multilineTextAlignment(.trailing)
                            Image(systemName: "chevron.right")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }
                }
                .buttonStyle(.plain)

                infoRow(label: "Status") {
                    HStack(spacing: 4) {
                        Circle()
                            .fill(device.online ? Color.green : Color.gray)
                            .frame(width: 6, height: 6)
                        Text(device.online ? "Online" : "Offline")
                            .foregroundStyle(.primary)
                    }
                }

                if let version {
                    infoRow("Version", value: version)
                }
            }
        }
    }

    // MARK: - Actions (Fork / Delete row)

    /// Side-by-side action row. Fork (krakiPrimary) on the left,
    /// Delete (destructive red) on the right. Equal half-widths
    /// inside the same horizontal stack so they read as a paired
    /// affordance rather than two separate sections.
    private var actionsSection: some View {
        HStack(spacing: 12) {
            forkButton
                .buttonStyle(.bordered)
                .controlSize(.regular)
                .tint(.krakiPrimary)

            deleteButton
                .buttonStyle(.bordered)
                .controlSize(.regular)
                .tint(.red)
        }
    }

    private var forkButton: some View {
        Button {
            // `forkSession` is fully optimistic — `CommandSender` adds
            // a pending placeholder to the session store and assigns
            // it to `navigateToSession`, which `MainTabView` watches.
            // That pop-then-push lands the user on the new session's
            // "Starting session…" placeholder while the tentacle
            // works. We dismiss this sheet right after so the user
            // sees the placeholder chat, not the info sheet, when
            // the navigation completes.
            appState.commandSender?.forkSession(sessionId: session.id)
            dismiss()
        } label: {
            HStack(spacing: 5) {
                LucideIcon(.gitFork, size: 16, color: .krakiPrimary)
                Text("Fork")
                    .font(.subheadline)
            }
            .frame(maxWidth: .infinity)
        }
    }

    private var deleteButton: some View {
        Button(role: .destructive) {
            showDeleteConfirmation = true
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "trash")
                    .font(.subheadline)
                Text("Delete")
                    .font(.subheadline)
            }
            .frame(maxWidth: .infinity)
        }
    }

    // MARK: - Helpers

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.caption.weight(.semibold))
            .textCase(.uppercase)
            .foregroundStyle(.secondary)
    }

    private func infoRow(_ label: String, value: String) -> some View {
        infoRow(label: label) {
            Text(value)
                .foregroundStyle(.primary)
                .multilineTextAlignment(.trailing)
        }
    }

    /// Shared row layout. All values surfaced in the sheet go through
    /// this helper so the label / value typography matches pixel-for-
    /// pixel across every row (Title, Model, Name, tokens, cost, …).
    @ViewBuilder
    private func infoRow<Trailing: View>(
        label: String,
        @ViewBuilder trailing: () -> Trailing
    ) -> some View {
        HStack(spacing: 8) {
            Text(label)
                .foregroundStyle(.secondary)
            Spacer(minLength: 8)
            trailing()
        }
        .font(.subheadline)
        .contentShape(Rectangle())
    }

    private func tokenRow(_ label: String, count: Int) -> some View {
        // Use the same plain `infoRow(_:value:)` rendering as every
        // other value so token rows match exactly. Tokens drop the
        // monospaced-digit treatment so the visual baseline lines up
        // with non-numeric values like the model name or the date.
        infoRow(label, value: formatTokenCount(count))
    }
}

// MARK: - Model picker (pushed inside the sheet's NavigationStack)

/// Hashable navigation token. We don't carry the session inline —
/// `ModelPickerScreen` re-reads from the store so it stays in sync
/// with any background updates while the picker is open.
private struct ModelPickerNav: Hashable {}

/// In-sheet model picker. Reuses the same `ModelPickerCard` component
/// the New Session sheet uses, so reasoning-effort segmentation, the
/// glass card look, and selection chevrons all behave identically.
/// Applies the chosen model + effort live via `setSessionModel`.
private struct ModelPickerScreen: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    let session: SessionInfo

    @State private var selectedModel: String
    @State private var reasoningEffort: ReasoningEffort?

    init(session: SessionInfo) {
        self.session = session
        _selectedModel = State(initialValue: session.model ?? "")
        _reasoningEffort = State(
            initialValue: session.model.flatMap { SessionPrefs.lastEffort(model: $0) }
        )
    }

    private var models: [String] {
        appState.deviceStore.deviceModels[session.deviceId] ?? []
    }

    private var modelDetails: [ModelDetail] {
        appState.deviceStore.deviceModelDetails[session.deviceId] ?? []
    }

    var body: some View {
        ScrollView {
            ModelPickerCard(
                models: models,
                modelDetails: modelDetails,
                selectedModel: selectedModel,
                reasoningEffort: $reasoningEffort,
                onSelect: { model in
                    selectedModel = model
                    SessionPrefs.saveLastModel(deviceId: session.deviceId, model: model)
                    appState.commandSender?.setSessionModel(
                        sessionId: session.id,
                        model: model,
                        reasoningEffort: reasoningEffort
                    )
                },
                onEffortChange: { effort in
                    SessionPrefs.saveLastEffort(model: selectedModel, effort: effort)
                    // Live-apply the new effort to the running session.
                    appState.commandSender?.setSessionModel(
                        sessionId: session.id,
                        model: selectedModel,
                        reasoningEffort: effort
                    )
                }
            )
            .padding(.horizontal)
            .padding(.top, 8)
        }
        .navigationTitle("Model")
        .navigationBarTitleDisplayMode(.inline)
    }
}

#endif
