/// MacControlHelp — the hover text (tooltip) of every icon-only control in the
/// Mac app, in one place. A greyed-out control says why it can't be used.
///
/// Keep the text short and in sentence case. Shortcuts go in parentheses and
/// use the same keys the key handlers use (Option-Space: MacComposerVoiceKeyProbeView.action).

#if os(macOS)
import SwiftUI

enum MacControlHelp {
    static let voiceShortcut = "⌥Space"

    // MARK: Composer

    static func voice(available: Bool, busy: Bool) -> String {
        if !available { return String(localized: "Voice input isn't available") }
        if busy { return String(localized: "Finishing the last recording…") }
        return String(localized: "Dictate (\(voiceShortcut))")
    }

    static let voiceCancel = String(localized: "Discard the recording (Esc)")
    static let voiceEdit = String(localized: "Stop and edit the text")
    static let clearMessage = String(localized: "Clear message")
    static let replaceImage = String(localized: "Replace image")
    static let removeImage = String(localized: "Remove image")

    /// Why the image button is greyed out, if it is.
    enum AttachBlock: Equatable {
        case voice
        /// Images go with a new message only once the agent is idle.
        case agentBusy
        /// Answering a question with an agent that takes no image in an answer.
        case answerTakesNoImage(agent: String)

        static func of(voice: Bool, canAttach: Bool, answering: Bool, agent: String?) -> AttachBlock? {
            if voice { return .voice }
            if canAttach { return nil }
            return answering ? .answerTakesNoImage(agent: AgentInfo.from(agent ?? "").label) : .agentBusy
        }
    }

    static func attachImage(blocked: AttachBlock?, hasImage: Bool) -> String {
        switch blocked {
        case .voice: return String(localized: "Finish voice input first")
        case .agentBusy: return String(localized: "You can add an image when the agent is idle")
        case let .answerTakesNoImage(agent): return String(localized: "\(agent) can't take an image in an answer")
        case nil: return hasImage ? replaceImage : String(localized: "Attach image (or paste or drop one)")
        }
    }

    /// What the round primary button does now. It changes shape: ↑ send,
    /// ↱ steer, ■ stop, ✓ edit voice text.
    enum Primary: Equatable {
        case send, steer, answer, deny
        case stop(stopping: Bool)
        case voiceSend, voiceAnswer, voiceEdit

        static func of(voice: Bool, permission: Bool, question: Bool, stop: Bool, stopping: Bool,
                       intent: MacComposerIntent) -> Primary {
            if voice { return permission ? .voiceEdit : (question ? .voiceAnswer : .voiceSend) }
            if stop { return .stop(stopping: stopping) }
            switch intent {
            case .prompt: return .send
            case .steer: return .steer
            case .answerQuestion: return .answer
            case .denyPermission: return .deny
            }
        }
    }

    /// VoiceOver's name for the primary button (UI tests find it by these).
    static func accessibilityLabel(_ action: Primary) -> String {
        switch action {
        case .send: return String(localized: "Send message")
        case .steer: return String(localized: "Steer agent")
        case .answer: return String(localized: "Submit answer")
        case .deny: return String(localized: "Deny with reason")
        case .stop: return String(localized: "Stop agent")
        case .voiceSend: return String(localized: "Send voice message")
        case .voiceAnswer: return String(localized: "Submit voice answer")
        case .voiceEdit: return String(localized: "Edit voice text")
        }
    }

    static func accessibilityHint(_ action: Primary) -> String {
        switch action {
        case .send: return String(localized: "Sends the current message")
        case .steer: return String(localized: "Interjects into the active agent turn")
        case .answer, .voiceAnswer: return String(localized: "Answers the pending question")
        case .deny: return String(localized: "Denies the permission with this reason")
        case .stop: return String(localized: "Aborts the current agent turn")
        case .voiceSend: return String(localized: "Sends what you said")
        case .voiceEdit: return String(localized: "Puts what you said in the text box")
        }
    }

    static func primary(_ action: Primary, canSend: Bool, deviceReachable: Bool, deviceName: String?) -> String {
        let offline = deviceName.map { String(localized: "\($0) is offline") }
            ?? String(localized: "The computer is offline")
        switch action {
        case let .stop(stopping):
            if stopping { return String(localized: "Stopping…") }
            return deviceReachable ? String(localized: "Stop the agent") : offline
        case .voiceSend: return String(localized: "Send what you said")
        case .voiceAnswer: return String(localized: "Answer with what you said")
        case .voiceEdit: return voiceEdit
        case .send, .steer, .answer, .deny:
            guard canSend else { return action == .answer ? String(localized: "Type an answer") : String(localized: "Type a message") }
            switch action {
            case .steer: return String(localized: "Steer: add this to the reply in progress (Return)")
            case .answer: return String(localized: "Submit answer (Return)")
            case .deny: return String(localized: "Deny with this reason (Return)")
            default: return String(localized: "Send (Return)")
            }
        }
    }

    // MARK: Chat

    static func mode(_ mode: SessionMode) -> String {
        switch mode {
        case .safe: return String(localized: "Safe: asks you before changes, commands and external tools")
        case .auto: return String(localized: "Auto: runs tools without asking")
        case .delegate: return String(localized: "Delegate: runs tools and answers the agent's questions itself")
        }
    }

    static func modeCapsule(_ mode: SessionMode) -> String {
        String(localized: "Mode: \(mode.chatLocalizedTitle). Click to change")
    }

    static func title(_ title: String) -> String { String(localized: "\(title)\nShow session info") }

    static let rename = String(localized: "Rename")
    static let showSteps = String(localized: "Show steps")
    static let closeSteps = String(localized: "Close steps")
    static let jumpToLatest = String(localized: "Jump to latest")
    static let jumpToReplyStart = String(localized: "Jump to the start of the reply")
    static func toolDetails(expanded: Bool) -> String { expanded ? String(localized: "Hide details") : String(localized: "Show details") }
    static func report(_ title: String) -> String { String(localized: "Open \(title)") }

    // MARK: New Session

    static func agentPill(choices: Int) -> String {
        choices > 1 ? String(localized: "Choose the coding agent") : String(localized: "The only coding agent on this computer")
    }

    static func modelPill(choices: Int) -> String {
        choices > 1 ? String(localized: "Choose the model") : String(localized: "This agent reports no other models")
    }

    static let effortPill = String(localized: "How hard the model thinks")
}

extension View {
    /// The same text for VoiceOver and for the pointer.
    func labelAndHelp(_ text: String) -> some View {
        accessibilityLabel(text).help(text)
    }

    /// A tooltip that shows on a greyed-out control too. SwiftUI's `.help`
    /// is not shown on a disabled control, so the text goes on an enabled
    /// container around it.
    func controlHelp(_ text: String) -> some View {
        ZStack { self }
            .contentShape(Rectangle())
            .help(text)
    }
}
extension NSView {
    /// VoiceOver label and tooltip in one call; the tooltip defaults to the label.
    func setAccessibilityLabel(_ label: String, toolTip: String?) {
        setAccessibilityLabel(label)
        self.toolTip = toolTip ?? label
    }
}
#endif
