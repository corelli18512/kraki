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
        if !available { return "Voice input isn't available" }
        if busy { return "Finishing the last recording…" }
        return "Dictate (\(voiceShortcut))"
    }

    static let voiceCancel = "Discard the recording (Esc)"
    static let voiceEdit = "Stop and edit the text"
    static let clearMessage = "Clear message"
    static let replaceImage = "Replace image"
    static let removeImage = "Remove image"

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
        case .voice: return "Finish voice input first"
        case .agentBusy: return "You can add an image when the agent is idle"
        case let .answerTakesNoImage(agent): return "\(agent) can't take an image in an answer"
        case nil: return hasImage ? replaceImage : "Attach image (or paste or drop one)"
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
        case .send: return "Send message"
        case .steer: return "Steer agent"
        case .answer: return "Submit answer"
        case .deny: return "Deny with reason"
        case .stop: return "Stop agent"
        case .voiceSend: return "Send voice message"
        case .voiceAnswer: return "Submit voice answer"
        case .voiceEdit: return "Edit voice text"
        }
    }

    static func accessibilityHint(_ action: Primary) -> String {
        switch action {
        case .send: return "Sends the current message"
        case .steer: return "Interjects into the active agent turn"
        case .answer, .voiceAnswer: return "Answers the pending question"
        case .deny: return "Denies the permission with this reason"
        case .stop: return "Aborts the current agent turn"
        case .voiceSend: return "Sends what you said"
        case .voiceEdit: return "Puts what you said in the text box"
        }
    }

    static func primary(_ action: Primary, canSend: Bool, deviceReachable: Bool, deviceName: String?) -> String {
        let offline = "\(deviceName ?? "The computer") is offline"
        switch action {
        case let .stop(stopping):
            if stopping { return "Stopping…" }
            return deviceReachable ? "Stop the agent" : offline
        case .voiceSend: return "Send what you said"
        case .voiceAnswer: return "Answer with what you said"
        case .voiceEdit: return voiceEdit
        case .send, .steer, .answer, .deny:
            guard canSend else { return action == .answer ? "Type an answer" : "Type a message" }
            switch action {
            case .steer: return "Steer: add this to the reply in progress (Return)"
            case .answer: return "Submit answer (Return)"
            case .deny: return "Deny with this reason (Return)"
            default: return "Send (Return)"
            }
        }
    }

    // MARK: Chat

    static func mode(_ mode: SessionMode) -> String {
        switch mode {
        case .safe: return "Safe: asks you before changes, commands and external tools"
        case .auto: return "Auto: runs tools without asking"
        case .delegate: return "Delegate: runs tools and answers the agent's questions itself"
        }
    }

    static func modeCapsule(_ mode: SessionMode) -> String {
        "Mode: \(mode.rawValue.capitalized). Click to change"
    }

    static func title(_ title: String) -> String { "\(title)\nShow session info" }

    static let rename = "Rename"
    static let showSteps = "Show steps"
    static let closeSteps = "Close steps"
    static let jumpToLatest = "Jump to latest"
    static let jumpToReplyStart = "Jump to the start of the reply"
    static func toolDetails(expanded: Bool) -> String { expanded ? "Hide details" : "Show details" }
    static func report(_ title: String) -> String { "Open \(title)" }

    // MARK: New Session

    static func agentPill(choices: Int) -> String {
        choices > 1 ? "Choose the coding agent" : "The only coding agent on this computer"
    }

    static func modelPill(choices: Int) -> String {
        choices > 1 ? "Choose the model" : "This agent reports no other models"
    }

    static let effortPill = "How hard the model thinks"
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
