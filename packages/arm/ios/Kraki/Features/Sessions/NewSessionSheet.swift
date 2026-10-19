#if os(iOS)
/// NewSessionSheet — Compact glass dialog for creating a new session.
///
/// Design language: **Crossfade replace** (Apple Music / Wallet style).
/// - Fixed `.height(360)` detent — no sheet resize, glass preserved.
/// - Tap a row → form content crossfades to the picker for that field,
///   filling the same area. Back chevron + title at top.
/// - No NavigationStack push, no popover, no detent change ⇒ no flicker.
/// - Liquid glass material on the floating card via `.glassEffect`.

import SwiftUI

struct NewSessionSheet: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss

    @State private var selectedDeviceId: String = ""
    @State private var selectedAgentId: String = ""
    @State private var selectedModel: String = ""
    @State private var reasoningEffort: ReasoningEffort?
    @State private var sessionTitle: String = ""
    @State private var screen: Screen = .form
    @State private var showImportSheet: Bool = false
    @State private var headerHeight: CGFloat = 0
    @State private var formCardHeight: CGFloat = 0
    @State private var composerHeight: CGFloat = 0

    private enum Screen: Equatable {
        case form
        case devicePicker
        /// Combined agent + model picker. When the device has multiple
        /// agents we show a row of agent chips at the top and the
        /// model list below. With a single agent the chip row hides
        /// and the picker degenerates to the same model-only list the
        /// pre-multi-agent build had.
        case agentModelPicker
    }

    private var deviceStore: DeviceStore { appState.deviceStore }

    private var tentacles: [DeviceSummary] {
        deviceStore.tentacleDevices
    }

    private var onlineTentacles: [DeviceSummary] {
        tentacles.filter(\.online)
    }

    /// Picker order: online computers first (the ones you can start a
    /// session on), then offline ones, most recently seen first.
    private var pickerDevices: [DeviceSummary] {
        onlineTentacles + tentacles.filter { !$0.online }.sorted {
            (DeviceDates.parse($0.lastSeen) ?? .distantPast) > (DeviceDates.parse($1.lastSeen) ?? .distantPast)
        }
    }

    private var agentsList: [AgentCapabilities] {
        deviceStore.agents(for: selectedDeviceId)
    }

    private var hasMultipleAgents: Bool {
        agentsList.count > 1
    }

    private var activeAgent: AgentCapabilities? {
        agentsList.first { $0.id == selectedAgentId } ?? agentsList.first
    }

    private var models: [String] {
        activeAgent?.models ?? []
    }

    private var modelDetails: [ModelDetail] {
        activeAgent?.modelDetails ?? []
    }

    private var selectedModelDetail: ModelDetail? {
        modelDetails.first { $0.id == selectedModel }
    }

    private var supportedEfforts: [ReasoningEffort]? {
        guard let detail = selectedModelDetail,
              detail.supportsReasoningEffort else { return nil }
        return detail.supportedReasoningEfforts
    }

    private var canSubmit: Bool {
        !selectedDeviceId.isEmpty && !selectedAgentId.isEmpty && !selectedModel.isEmpty
    }

    // MARK: - Body

    var body: some View {
        VStack(spacing: 0) {
            header
                .padding(.horizontal, 20)
                .padding(.top, 24)
                .padding(.bottom, 12)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { headerHeight = $0 }

            if tentacles.isEmpty {
                noDevicesView
            } else {
                ZStack {
                    switch screen {
                    case .form:
                        formCard
                            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { formCardHeight = $0 }
                            .transition(.opacity.combined(with: .scale(scale: 0.97)))
                    case .devicePicker:
                        devicePickerCard
                            .transition(.opacity.combined(with: .scale(scale: 0.97)))
                    case .agentModelPicker:
                        agentModelPickerCard
                            .transition(.opacity.combined(with: .scale(scale: 0.97)))
                    }
                }
                .animation(.easeInOut(duration: 0.22), value: screen)
                .padding(.horizontal, 16)
                .padding(.top, Self.cardTop)

                Spacer(minLength: 0)

                IOSNewSessionComposer(
                    canStart: canSubmit,
                    voiceContext: {
                        VoiceSessionContextBuilder.buildNewSession(
                            agent: selectedAgentId, model: selectedModel.isEmpty ? nil : selectedModel,
                            deviceName: tentacles.first { $0.id == selectedDeviceId }?.name)
                    },
                    onSendText: { createSession(prompt: $0) },
                    onSendVoice: createVoiceSession
                )
                .padding(.horizontal, 16)
                .padding(.top, Self.composerGap)
                .padding(.bottom, Self.composerBottom)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { composerHeight = $0 }
            }
        }
        .presentationDetents([.height(sheetHeight)])
        .animation(.easeInOut(duration: 0.22), value: sheetHeight)
        .presentationDragIndicator(.hidden)
        .presentationBackground(.clear)
        .onAppear { selectDefaults() }
        .onChange(of: selectedDeviceId) { _, _ in onDeviceChanged() }
        .onChange(of: selectedAgentId) { _, _ in onAgentChanged() }
        .onChange(of: selectedModel) { _, _ in onModelChanged() }
        .sheet(isPresented: $showImportSheet) {
            ImportSessionSheet()
                .environment(appState)
        }
    }

    // MARK: - Header

    @ViewBuilder
    private var header: some View {
        if screen == .form {
            HStack(spacing: 12) {
                Text("New Session")
                    .font(.title2.weight(.semibold))
                Spacer()
                // Import button hidden for the v1 launch — the
                // underlying `ImportSessionSheet` + `showImportSheet`
                // state is intentionally kept intact so we can
                // re-enable the entry point by flipping this flag
                // back to `true` once the import flow ships.
                if false {
                    Button {
                        showImportSheet = true
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "square.and.arrow.down")
                                .font(.subheadline.weight(.medium))
                            Text("Import")
                                .font(.subheadline.weight(.medium))
                        }
                        .foregroundStyle(Color.krakiPrimary)
                    }
                    .buttonStyle(.plain)
                }
            }
        } else {
            HStack(spacing: 8) {
                Button {
                    goBack()
                } label: {
                    Image(systemName: "chevron.left")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Color.krakiPrimary)
                        .padding(.trailing, 4)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                Text(headerTitle)
                    .font(.title2.weight(.semibold))
                Spacer()
            }
        }
    }

    private var headerTitle: String {
        switch screen {
        case .form: return String(localized: "New Session")
        case .devicePicker: return String(localized: "Device")
        case .agentModelPicker: return String(localized: "Agent")
        }
    }

    private func goBack() {
        withAnimation(.easeInOut(duration: 0.22)) {
            screen = .form
        }
    }

    // MARK: - Form Card

    /// "Agent" row label combines agent + model so the user sees what
    /// they'd be creating without drilling in. Falls back to "Select"
    /// when nothing is picked yet (e.g. greeting hasn't landed).
    private var agentRowValue: String {
        guard !selectedAgentId.isEmpty || !selectedModel.isEmpty else { return String(localized: "Select") }
        let agentLabel = selectedAgentId.isEmpty ? "" : AgentInfo.from(selectedAgentId).label
        if selectedModel.isEmpty { return agentLabel.isEmpty ? String(localized: "Select") : agentLabel }
        if agentLabel.isEmpty { return selectedModel }
        return "\(agentLabel) · \(selectedModel)"
    }

    private var formCard: some View {
        VStack(spacing: 0) {
            rowButton(label: String(localized: "Device"),
                      value: tentacles.first(where: { $0.id == selectedDeviceId })?.name ?? String(localized: "Select")) {
                withAnimation(.easeInOut(duration: 0.22)) { screen = .devicePicker }
            }

            Divider().padding(.leading, 16)

            if agentsList.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text("Agent").foregroundStyle(Color.primary)
                        Spacer()
                        Text(agentStatusText).foregroundStyle(.tertiary)
                    }
                    if deviceStore.agentAvailability(for: selectedDeviceId) == .noAgents {
                        Text("Install Claude Code, Codex, GitHub Copilot CLI or pi on that computer and sign in, then restart Kraki there.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
            } else {
                rowButton(label: String(localized: "Agent"), value: agentRowValue) {
                    withAnimation(.easeInOut(duration: 0.22)) { screen = .agentModelPicker }
                }
            }

            Divider().padding(.leading, 16)

            HStack {
                Text("Title").foregroundStyle(Color.primary)
                TextField("Optional", text: $sessionTitle)
                    .multilineTextAlignment(.trailing)
                    .textInputAutocapitalization(.sentences)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
        }
        .modifier(GlassCardModifier())
    }

    private var agentStatusText: String {
        switch deviceStore.agentAvailability(for: selectedDeviceId) {
        case .ready, .connecting: return String(localized: "Connecting…")
        case .offline: return String(localized: "Device offline")
        case .noAgents: return String(localized: "None installed")
        }
    }

    private func rowButton(label: String, value: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Text(label).foregroundStyle(Color.primary)
                Spacer()
                Text(value).foregroundStyle(.secondary)
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Picker Card

    private var devicePickerCard: some View {
        AlwaysScrollableArea {
            VStack(spacing: 0) {
                ForEach(Array(pickerDevices.enumerated()), id: \.element.id) { index, device in
                    Button {
                        guard device.online else { return }
                        selectedDeviceId = device.id
                        SessionPrefs.saveLastDevice(device.id)
                        goBack()
                    } label: {
                        HStack(spacing: 10) {
                            Circle()
                                .fill(device.online ? Color.green : Color.gray)
                                .frame(width: 7, height: 7)
                            VStack(alignment: .leading, spacing: 1) {
                                HStack(spacing: 6) {
                                    Text(device.name)
                                        .foregroundStyle(device.online ? Color.primary : Color.secondary)
                                    if appState.deviceStore.availableUpdate(for: device.id) != nil { UpdateAvailableDot() }
                                }
                                if !device.online, let seen = DeviceDates.relative(device.lastSeen) {
                                    Text("Last online \(seen)")
                                        .font(.caption)
                                        .foregroundStyle(.tertiary)
                                }
                            }
                            Spacer()
                            if device.id == selectedDeviceId {
                                Image(systemName: "checkmark")
                                    .foregroundStyle(Color.krakiPrimary)
                            }
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(!device.online)

                    if index < pickerDevices.count - 1 {
                        Divider().padding(.leading, 16)
                    }
                }
            }
        }
        .modifier(GlassCardModifier())
    }

    // MARK: - Agent + Model Picker

    /// Combined picker. Multi-agent devices show a row of agent chips
    /// at the top and the agent's model list below — the same shape
    /// the web `NewSessionDialog` uses. Single-agent devices skip the
    /// chip strip entirely so the screen reads as a plain model list.
    private var agentModelPickerCard: some View {
        AlwaysScrollableArea {
            VStack(spacing: 12) {
                if hasMultipleAgents {
                    agentChipStrip
                        .padding(.horizontal, 4)
                }
                ModelPickerCard(
                    models: models,
                    modelDetails: modelDetails,
                    selectedModel: selectedModel,
                    reasoningEffort: $reasoningEffort,
                    onSelect: { model in
                        selectedModel = model
                        SessionPrefs.saveLastModel(
                            deviceId: selectedDeviceId,
                            agentId: selectedAgentId,
                            model: model
                        )
                        // Don't auto-back so user can tweak Thinking.
                    },
                    onEffortChange: { effort in
                        SessionPrefs.saveLastEffort(model: selectedModel, effort: effort)
                    }
                )
            }
        }
    }

    /// Horizontal pill list mirroring the web "Agent" buttons.
    private var agentChipStrip: some View {
        HStack(spacing: 8) {
            ForEach(agentsList, id: \.id) { agent in
                Button {
                    handleSelectAgent(agent.id)
                } label: {
                    Text(AgentInfo.from(agent.id).label)
                        .font(.subheadline.weight(.medium))
                        .padding(.horizontal, 14)
                        .padding(.vertical, 7)
                        .background(
                            agent.id == selectedAgentId
                                ? Color.krakiPrimary
                                : Color.secondary.opacity(0.18),
                            in: Capsule()
                        )
                        .foregroundStyle(
                            agent.id == selectedAgentId
                                ? Color.white
                                : Color.primary
                        )
                }
                .buttonStyle(.plain)
            }
            Spacer(minLength: 0)
        }
    }

    // MARK: - Create / Empty

    private static let cardTop: CGFloat = 16
    private static let composerGap: CGFloat = 12
    private static let composerBottom: CGFloat = 8
    /// Device / Agent pickers scroll inside this height.
    private static let pickerHeight: CGFloat = 280

    /// The sheet hugs its content: header, the card (or a picker), and the
    /// composer 12 pt below it; it grows with a multi-line draft or dictation.
    private var sheetHeight: CGFloat {
        guard !tentacles.isEmpty else { return 360 }
        guard headerHeight > 0, composerHeight > 0 else { return 360 }
        let middle = screen == .form ? formCardHeight : Self.pickerHeight
        return headerHeight + Self.cardTop + middle + Self.composerGap + composerHeight
    }

    /// Static help URL. Both candidates are well-formed RFC 3986
    /// strings the compiler accepts at build time; the fallback
    /// chain avoids a force-unwrap entirely in case Swift's URL
    /// parser ever tightens up around either string.
    private static let helpURL: URL = {
        if let u = URL(string: "https://github.com/corelli18512/kraki#readme") { return u }
        if let u = URL(string: "https://kraki.chat") { return u }
        // Last resort: an empty URL never traversed. Link wraps this
        // with a Tap action that just won't open; we'd rather show
        // a dead link than crash launch.
        return URL(fileURLWithPath: "/")
    }()

    private var noDevicesView: some View {
        VStack(spacing: 12) {
            Spacer()
            Text("No computers online").font(.title3).foregroundStyle(.secondary)
            Text("Connect a computer to create sessions").font(.subheadline).foregroundStyle(.tertiary)
            Link("How?", destination: Self.helpURL)
                .font(.subheadline)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Actions

    private func selectDefaults() {
        if selectedDeviceId.isEmpty {
            // Prefer the last-used device if it's still online; otherwise first online.
            if let lastId = SessionPrefs.lastDeviceId(),
               let lastOnline = onlineTentacles.first(where: { $0.id == lastId }) {
                selectedDeviceId = lastOnline.id
            } else if let first = onlineTentacles.first {
                selectedDeviceId = first.id
            }
        }
        applyAgentPref()
        applyModelPref()
    }

    private func onDeviceChanged() {
        applyAgentPref()
        applyModelPref()
    }

    /// Restore the last-used agent for the current device. Falls back
    /// to the first advertised slice. No-op when the device hasn't yet
    /// reported its agents (waiting on `device_greeting`).
    private func applyAgentPref() {
        guard !agentsList.isEmpty else { selectedAgentId = ""; return }
        let candidate = SessionPrefs.lastAgentId(deviceId: selectedDeviceId)
        if let candidate, agentsList.contains(where: { $0.id == candidate }) {
            selectedAgentId = candidate
        } else if !agentsList.contains(where: { $0.id == selectedAgentId }) {
            selectedAgentId = agentsList.first?.id ?? ""
        }
    }

    private func handleSelectAgent(_ agentId: String) {
        guard agentId != selectedAgentId else { return }
        selectedAgentId = agentId
        SessionPrefs.saveLastAgent(deviceId: selectedDeviceId, agentId: agentId)
        // Switching agent invalidates the model — re-resolve from prefs.
        applyModelPref()
    }

    private func onAgentChanged() {
        applyModelPref()
    }

    /// Restore the last model selected for the current device + agent,
    /// or auto-pick the first available if the saved model is gone.
    private func applyModelPref() {
        let available = models
        guard !available.isEmpty else { return }
        if let lastModel = SessionPrefs.lastModel(deviceId: selectedDeviceId, agentId: selectedAgentId),
           available.contains(lastModel) {
            selectedModel = lastModel
        } else if selectedModel.isEmpty || !available.contains(selectedModel) {
            selectedModel = available.first ?? ""
        }
    }

    private func onModelChanged() {
        guard let detail = selectedModelDetail else {
            reasoningEffort = nil
            return
        }
        guard detail.supportsReasoningEffort,
              let efforts = detail.supportedReasoningEfforts,
              !efforts.isEmpty else {
            reasoningEffort = nil
            return
        }
        // Restore last effort for this model, else fall back to the model's default.
        if let lastEffort = SessionPrefs.lastEffort(model: selectedModel),
           efforts.contains(lastEffort) {
            reasoningEffort = lastEffort
        } else {
            reasoningEffort = detail.defaultReasoningEffort
        }
    }

    private var titleForCreate: String? {
        let trimmed = sessionTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// The typed first message goes out once the Session exists.
    private func createSession(prompt: String) {
        guard canSubmit else { return }
        appState.commandSender?.createSession(
            targetDeviceId: selectedDeviceId, agentId: selectedAgentId, model: selectedModel,
            reasoningEffort: reasoningEffort, prompt: prompt, cwd: nil, title: titleForCreate
        )
        dismiss()
    }

    private func createVoiceSession() {
        guard canSubmit else { return }
        if NewSessionStart.withVoice(appState, device: selectedDeviceId, agent: selectedAgentId,
                                     model: selectedModel, effort: reasoningEffort, title: titleForCreate) {
            dismiss()
        }
    }

    private func effortLabel(_ effort: ReasoningEffort) -> String {
        switch effort {
        case .low:    return String(localized: "Low")
        case .medium: return String(localized: "Medium")
        case .high:   return String(localized: "High")
        case .xhigh:  return String(localized: "XHigh")
        case .max:    return String(localized: "Max")
        }
    }
}

/// Visual card showing one model per row with a leading checkmark on the
/// current selection and an inline "Thinking" segmented control under it
/// when the model supports reasoning effort. Shared by NewSessionSheet
/// (new session form) and SessionInfoSheet (live model switch).
struct ModelPickerCard: View {
    let models: [String]
    let modelDetails: [ModelDetail]
    let selectedModel: String
    @Binding var reasoningEffort: ReasoningEffort?
    /// Fired when the user taps a model row.
    let onSelect: (String) -> Void
    /// Fired when the user picks a reasoning effort for the current model.
    /// Optional — NewSessionSheet uses it to persist the last-used effort.
    var onEffortChange: ((ReasoningEffort) -> Void)? = nil

    private func supportedEfforts(for model: String) -> [ReasoningEffort]? {
        guard let detail = modelDetails.first(where: { $0.id == model }),
              detail.supportsReasoningEffort else { return nil }
        return detail.supportedReasoningEfforts
    }

    private func effortLabel(_ effort: ReasoningEffort) -> String {
        switch effort {
        case .low:    return String(localized: "Low")
        case .medium: return String(localized: "Medium")
        case .high:   return String(localized: "High")
        case .xhigh:  return String(localized: "XHigh")
        case .max:    return String(localized: "Max")
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(models.enumerated()), id: \.element) { index, model in
                Button {
                    onSelect(model)
                } label: {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Text(model).foregroundStyle(Color.primary)
                            Spacer()
                            if model == selectedModel {
                                Image(systemName: "checkmark")
                                    .foregroundStyle(Color.krakiPrimary)
                            }
                        }
                        if model == selectedModel,
                           let efforts = supportedEfforts(for: model),
                           !efforts.isEmpty {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("Thinking")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                ThinkingSegmentedControl(
                                    titles: efforts.map(effortLabel),
                                    selection: Binding(
                                        get: { efforts.firstIndex(of: reasoningEffort ?? efforts[0]) ?? 0 },
                                        set: {
                                            let effort = efforts[$0]
                                            reasoningEffort = effort
                                            onEffortChange?(effort)
                                        }
                                    ),
                                    tintColor: UIColor(Color.krakiPrimary)
                                )
                            }
                            .padding(.top, 2)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                if index < models.count - 1 {
                    Divider().padding(.leading, 16)
                }
            }
        }
        .modifier(GlassCardModifier())
    }
}

struct GlassCardModifier: ViewModifier {
    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: 16, style: .continuous)
        if #available(iOS 26.0, *) {
            content.glassEffect(.regular, in: shape)
        } else {
            content.background(.ultraThinMaterial, in: shape)
        }
    }
}

/// Native UISegmentedControl wrapped for SwiftUI so the selected segment
/// can be reliably tinted with the app's theme color. SwiftUI's
/// `Picker(.segmented) + .tint()` doesn't paint the selected pill on iOS 26.
struct ThinkingSegmentedControl: UIViewRepresentable {
    let titles: [String]
    @Binding var selection: Int
    let tintColor: UIColor

    func makeUIView(context: Context) -> UISegmentedControl {
        let control = UISegmentedControl(items: titles)
        control.selectedSegmentIndex = selection
        control.selectedSegmentTintColor = tintColor
        control.setTitleTextAttributes([.foregroundColor: UIColor.white], for: .selected)
        control.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .valueChanged)
        return control
    }

    func updateUIView(_ control: UISegmentedControl, context: Context) {
        if control.selectedSegmentIndex != selection {
            control.selectedSegmentIndex = selection
        }
        control.selectedSegmentTintColor = tintColor
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject {
        let parent: ThinkingSegmentedControl
        init(_ parent: ThinkingSegmentedControl) { self.parent = parent }
        @objc func changed(_ control: UISegmentedControl) {
            parent.selection = control.selectedSegmentIndex
        }
    }
}

/// Scrollable container with a custom always-visible scrollbar.
///
/// SwiftUI's `.scrollIndicators(.visible)` still auto-hides on iOS, so we
/// track scroll geometry via iOS 18's `onScrollGeometryChange` and draw a
/// thin capsule on the trailing edge whenever content overflows.
private struct AlwaysScrollableArea<Content: View>: View {
    let content: Content
    @State private var contentHeight: CGFloat = 0
    @State private var viewportHeight: CGFloat = 0
    @State private var offset: CGFloat = 0

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        ScrollView {
            content
        }
        .scrollIndicators(.hidden)
        .onScrollGeometryChange(for: ScrollMetrics.self) { geo in
            ScrollMetrics(
                content: geo.contentSize.height,
                viewport: geo.containerSize.height,
                offset: geo.contentOffset.y
            )
        } action: { _, new in
            contentHeight = new.content
            viewportHeight = new.viewport
            offset = new.offset
        }
        .overlay(alignment: .topTrailing) {
            if contentHeight > viewportHeight + 1, viewportHeight > 0 {
                scrollThumb
                    .padding(.trailing, 3)
                    .transition(.opacity)
            }
        }
    }

    private var scrollThumb: some View {
        let ratio = max(0.05, min(1.0, viewportHeight / contentHeight))
        let thumbHeight = max(28, viewportHeight * ratio)
        let maxScroll = max(contentHeight - viewportHeight, 1)
        let t = min(max(offset / maxScroll, 0), 1)
        let y = t * (viewportHeight - thumbHeight)
        return Capsule()
            .fill(Color.primary.opacity(0.25))
            .frame(width: 3, height: thumbHeight)
            .offset(y: y)
    }
}

private struct ScrollMetrics: Equatable {
    var content: CGFloat
    var viewport: CGFloat
    var offset: CGFloat
}

#endif
