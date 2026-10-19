#if os(iOS)
import SwiftUI

/// The New Session sheet's input: the chat composer's box and send button
/// (IOSComposerParts) in place of a Create button. Return or ↑ starts the
/// Session with the typed text as its first message. While dictating, ↑
/// starts it at once and the speech goes out as the new chat's first bubble,
/// corrected there in place (as on the Mac).
///
/// The draft lives under IOSVoiceComposer.newSessionDraftID, so text that
/// was not sent is still there the next time the sheet opens.
struct IOSNewSessionComposer: View {
    @Environment(AppState.self) private var appState
    /// The computer, agent and model are chosen; a message can be sent.
    let canStart: Bool
    let voiceContext: () -> VoiceSessionContext
    let onSendText: (String) -> Void
    let onSendVoice: () -> Void

    @FocusState private var focused: Bool
    @State private var showVoiceConsent = false

    static let draftID = IOSVoiceComposer.newSessionDraftID
    private static let transcriptMaxHeight: CGFloat = 132
    private static let expand = Animation.spring(response: 0.34, dampingFraction: 0.9)

    private var store: SessionStore { appState.sessionStore }
    private var voice: IOSVoiceComposer { appState.iosVoiceComposer }
    private var controller: KrakiVoiceInputController { appState.voiceInputController }
    private var text: String { store.drafts[Self.draftID] ?? "" }
    private var recording: Bool { voice.isRecording(in: Self.draftID) }
    private var hasText: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var canSend: Bool { canStart && (recording || hasText) }
    private var showsMic: Bool {
        VoiceComposerAccessPolicy.isVisible(capabilityAvailable: appState.voiceCapability != nil)
    }
    private var canStartVoice: Bool {
        VoiceComposerAccessPolicy.canStart(capabilityAvailable: appState.voiceCapability != nil,
                                           voiceControllerBusy: controller.isBusy)
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: IOSComposerMetrics.controlGap) {
            VStack(alignment: .leading, spacing: 0) {
                if recording {
                    transcript
                        .transition(.asymmetric(insertion: .opacity.combined(with: .offset(y: 12)), removal: .opacity))
                    IOSVoiceRecordingControls(
                        levels: controller.levels,
                        startedAt: voice.recordingStartedAt,
                        onCancel: { withAnimation(Self.expand) { voice.cancel() }; focused = true },
                        onEdit: { withAnimation(Self.expand) { voice.finishToDraft() }; focused = true }
                    )
                    .transition(.opacity)
                } else {
                    restingRow.transition(.opacity)
                }
            }
            .frame(maxWidth: .infinity)
            .frame(minHeight: IOSComposerMetrics.height)
            .background { IOSComposerGlassBackground() }
            .contentShape(IOSComposerGlassBackground.shape)
            .animation(Self.expand, value: recording)

            Button(action: send) { IOSComposerSendCircle(active: canSend) }
                .buttonStyle(.plain)
                .disabled(!canSend)
                .padding(.bottom, (IOSComposerMetrics.height - IOSComposerMetrics.control) / 2)
                .accessibilityIdentifier("new-session-send")
                .accessibilityLabel(recording ? String(localized: "Start session with what you said") : String(localized: "Start session"))
        }
        .onAppear { if !recording { focused = true } }
        .alert(VoiceConsent.title, isPresented: $showVoiceConsent) {
            Button(VoiceConsent.continueButton) {
                VoiceConsent.grant()
                startVoice()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(VoiceConsent.message)
        }
    }

    private var restingRow: some View {
        HStack(spacing: 0) {
            TextField("What should we work on?", text: Binding(
                get: { text },
                set: { newValue in
                    guard newValue != text else { return }
                    voice.takeOver(sessionID: Self.draftID)
                    if MessageInputView.isReturnKeySubmit(old: text, new: newValue) {
                        store.setDraft(Self.draftID, String(newValue.dropLast()))
                        send()
                    } else {
                        store.setDraft(Self.draftID, newValue)
                    }
                }
            ), axis: .vertical)
            .lineLimit(1...5)
            .textFieldStyle(.plain)
            .font(.body)
            .padding(.leading, 16)
            .padding(.trailing, 4)
            .padding(.vertical, 12)
            .focused($focused)
            .submitLabel(.send)
            .onSubmit(send)
            .accessibilityIdentifier("new-session-text")
            if showsMic {
                Button(action: startVoice) {
                    LucideIcon(.mic, size: 22, strokeWidth: 2.1, color: .secondary)
                        .frame(width: 44, height: IOSComposerMetrics.height)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!canStartVoice)
                .opacity(canStartVoice ? 1 : 0.4)
                .accessibilityIdentifier("new-session-voice")
                .accessibilityLabel("Start voice input")
            }
        }
        .padding(.trailing, 2)
    }

    private var transcript: some View {
        ScrollView {
            IOSVoiceLiveTranscript(preview: voice.preview, state: controller.state)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 4)
        }
        .frame(maxHeight: Self.transcriptMaxHeight)
        .fixedSize(horizontal: false, vertical: true)
        .defaultScrollAnchor(.bottom)
    }

    private func startVoice() {
        guard canStartVoice else { return }
        guard VoiceConsent.isGranted else {
            showVoiceConsent = true
            return
        }
        controller.clearFailure()
        focused = false
        withAnimation(Self.expand) {
            voice.begin(sessionID: Self.draftID, selection: nil, context: voiceContext())
        }
    }

    private func send() {
        guard canSend else { return }
        if recording {
            // The speech goes to the new chat's first bubble and is corrected
            // there; the sheet closes right away.
            onSendVoice()
            return
        }
        voice.takeOver(sessionID: Self.draftID)
        let prompt = text.trimmingCharacters(in: .whitespacesAndNewlines)
        store.setDraft(Self.draftID, "")
        onSendText(prompt)
    }
}
/// Starting a Session from the New Session composer.
@MainActor
enum NewSessionStart {
    /// Dictation in progress: create the Session now and hand the speech to
    /// its placeholder, where it becomes the first bubble, is corrected in
    /// place and goes out once the Session exists (as on the Mac). False when
    /// nothing was recording.
    @discardableResult
    static func withVoice(_ app: AppState, device: String, agent: String, model: String,
                          effort: ReasoningEffort?, title: String?) -> Bool {
        let voice = app.iosVoiceComposer
        guard voice.isRecording(in: IOSVoiceComposer.newSessionDraftID), let sender = app.commandSender else { return false }
        let request = sender.createSession(targetDeviceId: device, agentId: agent, model: model,
                                           reasoningEffort: effort, title: title, voice: true)
        guard let placeholder = sender.pendingPlaceholderIds[request] else { return false }
        return voice.send(attachments: nil, delivery: .prompt, targetSessionID: placeholder)
    }
}
#endif
