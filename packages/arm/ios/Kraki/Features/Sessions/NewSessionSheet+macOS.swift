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
/// them. Send needs some text.
///
/// Voice input is the chat Composer's: the same mic / ⌥Space, recording
/// surface (live transcript over the waveform, Cancel / Edit), and the same
/// progressive correction in the real editor. There is no Session to stage a
/// bubble in yet, so ↑ while recording finishes into the editor, waits for
/// the correction, then starts the Session with the corrected text.
import AppKit
import SwiftUI

// MARK: - Composer

struct NewSessionComposer: View {
    @Environment(AppState.self) private var appState
    @Environment(TentacleCLIManager.self) private var tentacleCLI

    var placeholder = "Describe a task, e.g. “Fix the failing tests in my-app”"
    var minLines = 3
    var onCreated: () -> Void = {}
    /// Tests observe which computer the composer picked.
    var onDeviceSelected: (String) -> Void = { _ in }

    /// Set when "+" / ⌘N asks for the composer; a composer that mounts right
    /// after (switching away from a session) still plays the nudge.
    static var nudgeRequestedAt: Date?
    @State private var nudged = false
    /// The user chose a computer by hand; stop re-picking the default.
    @State private var userPickedDevice = false

    private func nudge() {
        Self.nudgeRequestedAt = nil
        withAnimation(.easeOut(duration: 0.12)) { nudged = true }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
            withAnimation(.easeInOut(duration: 0.6)) { nudged = false }
        }
    }

    /// Kept in the SessionStore (like a Session's draft) so the voice
    /// transaction can write into it; it also survives visiting a Session.
    private static let draftID = IOSVoiceComposer.newSessionDraftID
    private var text: String { appState.sessionStore.drafts[Self.draftID] ?? "" }
    private var textBinding: Binding<String> {
        Binding(get: { text }, set: { new in
            guard new != text else { return }
            takeOverFromVoice()
            appState.sessionStore.setDraft(Self.draftID, new)
        })
    }
    @State private var focused = false
    @State private var showVoiceConsent = false
    @State private var focusRequest = 0
    @State private var nativeEditorHasText = false
    @State private var selection: NSRange?
    /// ↑ pressed while recording: start once the correction has landed.
    @State private var sendAfterVoice = false
    @State private var editorWidth: CGFloat = 0
    /// The editor height for the current text: growth past the minimum eases.
    private var editorHeightKey: CGFloat {
        voiceOwnsComposer ? -1 : MacComposerScrollableTextInput.fittedHeight(
            text, width: editorWidth, minLines: CGFloat(minLines), maxLines: 10)
    }

    private var voiceController: KrakiVoiceInputController { appState.voiceInputController }
    private var voiceComposer: IOSVoiceComposer { appState.iosVoiceComposer }
    private var voiceOwnsComposer: Bool { voiceComposer.isRecording(in: Self.draftID) }
    private var voiceFinishing: Bool { voiceComposer.isFinishing(in: Self.draftID) }
    private var canShowVoice: Bool {
        VoiceComposerAccessPolicy.isVisible(capabilityAvailable: appState.voiceCapability != nil)
    }
    private var canStartVoice: Bool {
        VoiceComposerAccessPolicy.canStart(capabilityAvailable: appState.voiceCapability != nil,
                                           voiceControllerBusy: voiceController.isBusy)
    }

    @State private var selectedDeviceId = ""
    @State private var selectedAgentId: AgentId = ""
    @State private var selectedModel = ""
    @State private var reasoningEffort: ReasoningEffort?

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
    private var hasText: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var canStart: Bool {
        availability == .ready && !selectedDeviceId.isEmpty && !selectedAgentId.isEmpty && !selectedModel.isEmpty
    }
    private var canSubmit: Bool { hasText && canStart }
    /// The send control: while recording it sends the voice message.
    private var sendEnabled: Bool {
        if sendAfterVoice { return false }
        return voiceOwnsComposer ? canStart : canSubmit
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 10) {
                textArea
                    .alert(VoiceConsent.title, isPresented: $showVoiceConsent) {
                        Button(VoiceConsent.continueButton) {
                            VoiceConsent.grant()
                            handleVoiceButton()
                        }
                        Button("Cancel", role: .cancel) {}
                    } message: {
                        Text(VoiceConsent.message)
                    }
                HStack(spacing: 6) {
                    devicePill
                    if availability == .ready {
                        agentPill
                        modelPill
                        if let efforts = supportedEfforts, !efforts.isEmpty { effortPill(efforts) }
                    }
                    Spacer(minLength: 8)
                    if voiceOwnsComposer {
                        // Recording: Cancel / Edit take the mic's place.
                        voiceActions
                    } else if canShowVoice {
                        micButton
                    }
                    sendButton
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 14 - MacComposerMetrics.textVerticalPadding)
            .padding(.bottom, 10)
            .animation(.easeOut(duration: 0.18), value: editorHeightKey)
            .background(composerBackground)
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .strokeBorder(focused ? Color.krakiPrimary.opacity(0.45) : Color.borderPrimary.opacity(0.6), lineWidth: 1)
            )
            .contentShape(Rectangle())
            .onTapGesture { if !voiceOwnsComposer { requestFocus() } }
            // "+" / ⌘N: the border briefly brightens, then settles — no glow.
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .strokeBorder(Color.krakiPrimary.opacity(nudged ? 0.9 : 0), lineWidth: 1.5)
                    .allowsHitTesting(false)
            )

            if voiceController.hasFailure(for: Self.draftID) { voiceFailureRow }
            statusLine
        }
        .background {
            MacComposerVoiceKeyProbe(
                enabled: canShowVoice,
                voiceActive: voiceOwnsComposer,
                onToggle: handleVoiceButton,
                onCancel: {
                    guard voiceOwnsComposer else { return }
                    voiceComposer.cancel()
                    requestFocus()
                }
            )
            .frame(width: 0, height: 0)
        }
        .onAppear {
            selectDefaults(); requestFocus()
            if let t = Self.nudgeRequestedAt, Date().timeIntervalSince(t) < 1 { nudge() }
        }
        .onDisappear {
            // Leaving for a Session: an utterance in progress becomes the draft.
            voiceComposer.depart(sessionID: Self.draftID)
            sendAfterVoice = false
        }
        .onReceive(NotificationCenter.default.publisher(for: .macFocusNewSessionComposer)) { _ in
            if !voiceOwnsComposer { requestFocus() }
            nudge()
        }
        .onChange(of: voiceOwnsComposer) { was, owns in
            if was, !owns, !sendAfterVoice { requestFocus() }
        }
        .onChange(of: voiceComposer.editorRequest) { _, _ in
            if voiceComposer.editorSessionID == Self.draftID { requestFocus() }
        }
        // ↑ while recording: the correction has finished (or failed) — start
        // with what is in the editor now.
        .onChange(of: voiceFinishing) { _, finishing in
            guard !finishing, !voiceOwnsComposer, sendAfterVoice else { return }
            sendAfterVoice = false
            submit()
        }
        .onChange(of: selectedDeviceId) { _, id in onDeviceChanged(); onDeviceSelected(id) }
        // Computers come online after the composer appeared (first launch, a
        // restart or update of this Mac's service): until the user picks one
        // by hand, keep the default current — last used, else This Mac, else
        // any online one. (Before, a last-used This Mac coming online second
        // was never picked: it counted as "the user last used another one".)
        .onChange(of: localDeviceId) { _, _ in followDefault() }
        .onChange(of: selectedAgentId) { _, _ in onAgentChanged() }
        .onChange(of: selectedModel) { _, _ in onModelChanged() }
        .onChange(of: agents.map(\.id)) { _, _ in onDeviceChanged() }
        .onChange(of: onlineTentacles.map(\.id)) { _, _ in followDefault() }
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

    @State private var openPill: Pill?
    enum Pill: Hashable { case device, agent, model, effort }

    private func pill<Content: View>(_ which: Pill, enabled: Bool = true, @ViewBuilder label: () -> PillLabel,
                                     @ViewBuilder content: @escaping () -> Content) -> some View {
        Button { openPill = which } label: { label() }
            .buttonStyle(.plain)
            .disabled(!enabled)
            .popover(isPresented: Binding(get: { openPill == which }, set: { if !$0 { openPill = nil } }),
                     arrowEdge: .bottom) {
                content().frame(width: 280)
            }
    }

    private var devicePill: some View {
        pill(.device) {
            PillLabel(text: selectedDevice.map { $0.id == localDeviceId ? "This Mac" : $0.name } ?? "Choose a computer",
                      dot: selectedDevice?.online == true ? Color(hex: 0x34D399) : Color.textMuted)
        } content: {
            DeviceChoiceList(online: onlineTentacles, offline: offlineTentacles, localId: localDeviceId,
                             selected: selectedDeviceId,
                             updates: Set(tentacles.map(\.id).filter { appState.deviceStore.availableUpdate(for: $0) != nil })) { selectedDeviceId = $0; userPickedDevice = true; openPill = nil }
        }
        .help(selectedDevice?.name ?? "")
        .accessibilityIdentifier("mac.newSession.device")
    }

    private var agentPill: some View {
        pill(.agent, enabled: agents.count > 1) {
            PillLabel(text: AgentInfo.from(selectedAgentId).label, agent: selectedAgentId, showsChevron: agents.count > 1)
        } content: {
            AgentChoiceList(agents: agents, selected: selectedAgentId) { selectedAgentId = $0; openPill = nil }
        }
        .accessibilityIdentifier("mac.newSession.agent")
    }

    private func modelName(_ id: String) -> String {
        modelDetails.first { $0.id == id }?.name ?? id
    }

    private var modelPill: some View {
        pill(.model, enabled: models.count > 1) {
            PillLabel(text: selectedModel.isEmpty ? "Model" : modelName(selectedModel), showsChevron: models.count > 1)
        } content: {
            ModelChoiceList(models: models, name: modelName, selected: selectedModel) { selectedModel = $0; openPill = nil }
        }
        .accessibilityIdentifier("mac.newSession.model")
    }

    private func effortPill(_ efforts: [ReasoningEffort]) -> some View {
        pill(.effort) {
            PillLabel(text: reasoningEffort.map { "\(Self.effortLabel($0)) thinking" } ?? "Thinking",
                      symbol: Self.effortSymbol(reasoningEffort))
        } content: {
            EffortChoiceList(efforts: efforts, selected: reasoningEffort) { reasoningEffort = $0; openPill = nil }
        }
        .accessibilityIdentifier("mac.newSession.effort")
    }

    // MARK: Text / voice

    private var editorMinHeight: CGFloat {
        MacComposerScrollableTextInput.height(lines: CGFloat(minLines)) + MacComposerMetrics.textVerticalPadding * 2
    }

    /// The chat Composer's native editor, or its recording surface while
    /// dictating. Both are inset 4 pt; pull them back to the pills' edge.
    @ViewBuilder
    private var textArea: some View {
        Group {
            if voiceOwnsComposer {
                // Same height as the editor it replaces: the box never jumps;
                // a long utterance scrolls and keeps its newest words in view.
                MacComposerVoiceTranscriptOnly(controller: voiceController, preview: voiceComposer.preview,
                                               topAligned: true, showsWaveform: false)
                    .frame(height: MacComposerScrollableTextInput.height(lines: CGFloat(minLines)))
                    .padding(.leading, 4) // the editor's text inset
                    .padding(.vertical, MacComposerMetrics.textVerticalPadding)
            } else {
                ZStack(alignment: .topLeading) {
                    Text(placeholder)
                        .font(.system(size: 15))
                        .foregroundStyle(Color.textMuted)
                        .padding(.leading, 4)
                        .padding(.top, 1)
                        .opacity(MacComposerPlaceholderPolicy.isVisible(committedText: text,
                                                                        nativeEditorHasText: nativeEditorHasText) ? 1 : 0)
                        .allowsHitTesting(false)
                    MacComposerScrollableTextInput(
                        text: textBinding,
                        focused: $focused,
                        nativeEditorHasText: $nativeEditorHasText,
                        enabled: !voiceOwnsComposer,
                        focusRequest: focusRequest,
                        selectionRequest: voiceComposer.editorSessionID == Self.draftID ? voiceComposer.selectionRequest : nil,
                        uncorrectedRange: voiceComposer.uncorrectedRange(in: Self.draftID),
                        onRequestFocus: requestFocus,
                        onSubmit: submit,
                        onSelection: { selection = $0 },
                        onTakeOver: takeOverFromVoice,
                        minLines: CGFloat(minLines),
                        maxLines: 10
                    )
                    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { editorWidth = $0 }
                    .accessibilityIdentifier("mac.newSession.text")
                }
                .padding(.vertical, MacComposerMetrics.textVerticalPadding)
            }
        }
        .padding(.leading, -4)
    }

    private var micButton: some View {
        Button(action: handleVoiceButton) {
            ZStack {
                Image(systemName: "mic")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(.secondary)
                    .opacity(voiceFinishing && !sendAfterVoice ? 0 : 1)
                // A pending send already spins on ↑; one spinner is enough.
                if voiceFinishing && !sendAfterVoice { ProgressView().controlSize(.small) }
            }
            .frame(width: 30, height: 30)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!canStartVoice || sendAfterVoice)
        .opacity((canStartVoice || voiceFinishing) && !sendAfterVoice ? 1 : 0.4)
        .background {
            #if DEBUG
            MacComposerControlGeometryProbe(identifier: "mac.newSession.voice")
            #endif
        }
        .help("Dictate (⌥Space)")
        .accessibilityLabel("Start voice input")
        .accessibilityIdentifier("mac.newSession.voice")
    }

    /// Recording, in the bottom row as on iOS: live level bars and the
    /// elapsed time, then Cancel / Edit where the mic was.
    private var voiceActions: some View {
        HStack(spacing: 8) {
            VoiceLevelBars(levels: voiceController.levels)
                .accessibilityIdentifier("mac.newSession.voiceLevels")
            if let start = voiceComposer.recordingStartedAt {
                TimelineView(.periodic(from: start, by: 1)) { context in
                    Text(Self.elapsed(from: start, to: context.date))
                        .font(.system(size: 11.5).monospacedDigit())
                        .foregroundStyle(Color.textMuted)
                }
                .padding(.trailing, 2)
            }
            Button { voiceComposer.cancel() } label: {
                Label("Cancel", systemImage: "xmark")
                    .font(.system(size: 12, weight: .medium))
                    .frame(width: 70, height: 30)
                    .background(.primary.opacity(0.05), in: Capsule())
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Cancel voice input")
            .background {
                #if DEBUG
                MacComposerControlGeometryProbe(identifier: "voice-cancel")
                #endif
            }
            Button { voiceComposer.finishToDraft() } label: {
                Label("Edit", systemImage: "character.cursor.ibeam")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color.krakiPrimary)
                    .frame(width: 62, height: 30)
                    .background(Color.krakiPrimary.opacity(0.10), in: Capsule())
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Edit voice text")
            .background {
                #if DEBUG
                MacComposerControlGeometryProbe(identifier: "voice-to-text")
                #endif
            }
        }
    }

    static func elapsed(from start: Date, to now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(start)))
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }

    private var voiceFailureRow: some View {
        HStack(spacing: 8) {
            Text(VoiceComposerPresentation.statusText(state: voiceController.state,
                                                      rawText: voiceController.rawText,
                                                      displayText: voiceController.displayText))
                .font(.system(size: 11.5))
                .foregroundStyle(Color.red)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("Dismiss") { voiceController.clearFailure() }
                .buttonStyle(.plain)
                .font(.system(size: 11.5, weight: .medium))
        }
        .padding(.leading, 4)
    }

    private func requestFocus() {
        focused = true
        focusRequest &+= 1
    }

    /// Typing, selecting or IME in the editor: a late correction must not
    /// overwrite it, and a pending voice send is called off.
    private func takeOverFromVoice() {
        voiceComposer.takeOver(sessionID: Self.draftID)
        sendAfterVoice = false
    }

    private func handleVoiceButton() {
        if voiceOwnsComposer { voiceComposer.finishToDraft(); return }
        guard canStartVoice, !sendAfterVoice else { return }
        guard VoiceConsent.isGranted else {
            showVoiceConsent = true
            return
        }
        MacChatComposer.playVoiceStartCue()
        voiceController.clearFailure()
        focused = false
        let context = VoiceSessionContextBuilder.buildNewSession(
            agent: selectedAgentId,
            model: selectedModel.isEmpty ? nil : modelName(selectedModel),
            deviceName: selectedDevice?.name
        )
        voiceComposer.begin(sessionID: Self.draftID, selection: selection, context: context)
    }

    private var sendButton: some View {
        Button(action: submit) {
            ZStack {
                Image(systemName: "arrow.up")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(.white)
                    .opacity(sendAfterVoice ? 0 : 1)
                if sendAfterVoice { ProgressView().controlSize(.small).tint(.white) }
            }
            .frame(width: 30, height: 30)
            .background(Circle().fill(Color.krakiPrimary))
            .opacity(sendEnabled || sendAfterVoice ? 1 : 0.3)
        }
        .buttonStyle(.plain)
        // Waiting to start: stays solid with its spinner (presses are ignored).
        .disabled(!sendEnabled && !sendAfterVoice)
        .background {
            #if DEBUG
            MacComposerControlGeometryProbe(identifier: "mac.newSession.create")
            #endif
        }
        .help(voiceOwnsComposer ? "Start session with what you said" : "Start session (Return)")
        .accessibilityLabel(voiceOwnsComposer ? "Send voice message" : "Start session")
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
        if sendAfterVoice { return }
        if voiceOwnsComposer {
            // No Session to stage a bubble in: finish into the editor (the
            // correction shows there as usual), then start when it is done.
            guard canStart else { return }
            sendAfterVoice = true
            voiceComposer.finishToDraft()
            return
        }
        // Return during a correction: send what is shown; the late
        // correction must not write into the cleared composer.
        voiceComposer.takeOver(sessionID: Self.draftID)
        guard canSubmit else { return }
        SessionPrefs.saveLastDevice(selectedDeviceId)
        SessionPrefs.saveLastAgent(deviceId: selectedDeviceId, agentId: selectedAgentId)
        SessionPrefs.saveLastModel(deviceId: selectedDeviceId, agentId: selectedAgentId, model: selectedModel)
        if let reasoningEffort { SessionPrefs.saveLastEffort(model: selectedModel, effort: reasoningEffort) }
        let prompt = text.trimmingCharacters(in: .whitespacesAndNewlines)
        appState.commandSender?.createSession(
            targetDeviceId: selectedDeviceId, agentId: selectedAgentId, model: selectedModel,
            reasoningEffort: reasoningEffort, prompt: prompt, cwd: nil, title: nil
        )
        appState.sessionStore.setDraft(Self.draftID, "")
        onCreated()
    }

    private func recheckLocalAgents() async {
        await tentacleCLI.restartDaemon()
        for _ in 0..<40 {
            try? await Task.sleep(nanoseconds: 250_000_000)
            if !agents.isEmpty { return }
        }
    }

    private func followDefault() {
        if Self.followsDefault(userPicked: userPickedDevice, selectedOnline: selectedDevice?.online == true) { selectDefaults() }
    }

    /// The default keeps following the online computers until the user picks
    /// one; a picked computer that goes offline falls back to the default.
    static func followsDefault(userPicked: Bool, selectedOnline: Bool) -> Bool {
        !userPicked || !selectedOnline
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

    static func effortLabel(_ effort: ReasoningEffort) -> String {
        switch effort {
        case .low: return "Low"
        case .medium: return "Medium"
        case .high: return "High"
        case .xhigh: return "Extra high"
        case .max: return "Max"
        }
    }

    /// A gauge that fills with the level.
    static func effortSymbol(_ effort: ReasoningEffort?) -> String {
        switch effort {
        case .low: return "gauge.with.dots.needle.0percent"
        case .medium, .none: return "gauge.with.dots.needle.33percent"
        case .high: return "gauge.with.dots.needle.67percent"
        case .xhigh, .max: return "gauge.with.dots.needle.100percent"
        }
    }
}

/// A compact rounded pill: an optional mark (status dot, the agent's own
/// logo, or a symbol), the value, and a chevron when there is a choice.
struct PillLabel: View {
    let text: String
    var dot: Color?
    var agent: String?
    var symbol: String?
    var showsChevron = true
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 5) {
            if let dot {
                Circle().fill(dot).frame(width: 6, height: 6)
            } else if let agent, !agent.isEmpty {
                AgentGlyph(agent: agent, size: 13)
            } else if let symbol {
                Image(systemName: symbol).font(.system(size: 11, weight: .medium))
            }
            Text(text).font(.system(size: 11.5, weight: .medium)).lineLimit(1)
            if showsChevron {
                Image(systemName: "chevron.down").font(.system(size: 7.5, weight: .bold)).opacity(0.6)
            }
        }
        .foregroundStyle(Color.textSecondary)
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(Capsule(style: .continuous).fill(Color.textPrimary.opacity(hovering && showsChevron ? 0.12 : 0.07)))
        .contentShape(Capsule())
        .onHover { hovering = $0 }
    }
}

// MARK: - Choice lists (popover contents)

/// One row in a pill's popover: mark, title, optional detail, checkmark.
struct ChoiceRow<Mark: View>: View {
    let title: String
    var detail: String?
    var selected = false
    var enabled = true
    @ViewBuilder var mark: () -> Mark
    var action: () -> Void = {}
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                mark().frame(width: 18)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).font(.system(size: 12.5, weight: .medium)).foregroundStyle(enabled ? Color.textPrimary : Color.textMuted)
                    if let detail {
                        Text(detail).font(.system(size: 10.5)).foregroundStyle(Color.textMuted).lineLimit(1)
                    }
                }
                Spacer(minLength: 6)
                if selected {
                    Image(systemName: "checkmark").font(.system(size: 11, weight: .semibold)).foregroundStyle(Color.krakiPrimary)
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(hovering && enabled ? Color.textPrimary.opacity(0.08) : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .onHover { hovering = $0 }
    }
}

private struct ChoiceSection<Content: View>: View {
    let title: String?
    @ViewBuilder var content: () -> Content
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let title {
                Text(title.uppercased()).font(.system(size: 9.5, weight: .semibold)).tracking(0.6)
                    .foregroundStyle(Color.textMuted).padding(.horizontal, 10).padding(.top, 4).padding(.bottom, 2)
            }
            content()
        }
    }
}

struct DeviceChoiceList: View {
    let online: [DeviceSummary]
    let offline: [DeviceSummary]
    let localId: String?
    let selected: String
    /// Computers with a newer Kraki available.
    var updates: Set<String> = []
    let choose: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ChoiceSection(title: "Online") {
                ForEach(online, id: \.id) { d in
                    ChoiceRow(title: d.id == localId ? "This Mac" : d.name,
                              detail: updates.contains(d.id) ? "Update available" : (d.id == localId ? d.name : nil),
                              selected: d.id == selected,
                              mark: { Image(systemName: d.id == localId ? "laptopcomputer" : "desktopcomputer")
                                        .foregroundStyle(Color(hex: 0x34D399)) },
                              action: { choose(d.id) })
                }
            }
            if !offline.isEmpty {
                ChoiceSection(title: "Offline") {
                    ForEach(offline.prefix(6), id: \.id) { d in
                        ChoiceRow(title: d.name, detail: "Open Kraki on it to use it", enabled: false,
                                  mark: { Image(systemName: "desktopcomputer").foregroundStyle(Color.textMuted) })
                    }
                    if offline.count > 6 {
                        Text("and \(offline.count - 6) more offline").font(.system(size: 10.5))
                            .foregroundStyle(Color.textMuted).padding(.horizontal, 10).padding(.top, 2)
                    }
                }
            }
        }
        .padding(8)
    }
}

struct AgentChoiceList: View {
    let agents: [AgentCapabilities]
    let selected: String
    let choose: (String) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(agents, id: \.id) { a in
                let n = a.models?.count ?? 0
                ChoiceRow(title: AgentInfo.from(a.id).label, detail: "\(n) \(n == 1 ? "model" : "models")",
                          selected: a.id == selected,
                          mark: { AgentGlyph(agent: a.id, size: 15) },
                          action: { choose(a.id) })
            }
        }
        .padding(8)
    }
}

struct ModelChoiceList: View {
    let models: [String]
    let name: (String) -> String
    let selected: String
    let choose: (String) -> Void
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(models, id: \.self) { m in
                    ChoiceRow(title: name(m), detail: name(m) == m ? nil : m, selected: m == selected,
                              mark: { EmptyView() }, action: { choose(m) })
                }
            }
            .padding(8)
        }
        .frame(maxHeight: 320)
        .fixedSize(horizontal: false, vertical: true)
    }
}

struct EffortChoiceList: View {
    let efforts: [ReasoningEffort]
    let selected: ReasoningEffort?
    let choose: (ReasoningEffort) -> Void
    private func detail(_ e: ReasoningEffort) -> String {
        switch e {
        case .low: return "Fastest replies"
        case .medium: return "Balanced"
        case .high: return "Thinks longer on hard problems"
        case .xhigh, .max: return "Most thorough, slowest"
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(efforts, id: \.rawValue) { e in
                ChoiceRow(title: NewSessionComposer.effortLabel(e), detail: detail(e), selected: e == selected,
                          mark: { Image(systemName: NewSessionComposer.effortSymbol(e)).foregroundStyle(Color.textSecondary) },
                          action: { choose(e) })
            }
        }
        .padding(8)
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
            Spacer(minLength: 0)
            VStack(spacing: 22) {
                VStack(spacing: 8) {
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
            Spacer(minLength: 0)
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
            NewSessionComposer(placeholder: "Describe a task", minLines: 4) {
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
