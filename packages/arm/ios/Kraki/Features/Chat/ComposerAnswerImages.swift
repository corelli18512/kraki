import Foundation

/// Images in a composer answer to an agent's question (iPhone and Mac).
///
/// Only Pi's ask_user takes images with the answer. Claude, Copilot and Codex
/// questions take text only, so while answering one of them the attach control
/// is off and a staged image stays out of the answer (it stays in the
/// composer for a later message). Decided from the session's `agent`.
enum ComposerAnswerImages {
    static func allowed(agent: String?) -> Bool { agent?.lowercased() == "pi" }

    /// The attach control. Outside an answer it follows the existing rule
    /// (only while the agent is idle).
    static func canAttach(isIdle: Bool, answeringQuestion: Bool, agent: String?) -> Bool {
        answeringQuestion ? allowed(agent: agent) : isIdle
    }

    /// The staged image as the answer may carry it.
    static func attachments(_ staged: [ImageAttachment]?, agent: String?) -> [ImageAttachment]? {
        allowed(agent: agent) ? staged : nil
    }

    /// An answer needs text, or an image the agent takes.
    static func canSubmit(hasText: Bool, hasImage: Bool, agent: String?) -> Bool {
        hasText || (hasImage && allowed(agent: agent))
    }

    /// Send a typed answer with the staged image the agent takes. An
    /// image-only answer uses the "[image]" text of image-only messages
    /// (Tentacle answers with empty text plus the image). Returns false when
    /// there is nothing to send or the sender refused it.
    static func send(_ sender: CommandSender?, sessionId: String, questionId: String,
                     text: String, staged: [ImageAttachment]?, agent: String?) -> Bool {
        let answer = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let images = attachments(staged, agent: agent)
        guard !answer.isEmpty || images != nil else { return false }
        return sender?.answer(sessionId: sessionId, questionId: questionId,
                              answer: answer.isEmpty ? "[image]" : answer, attachments: images) == true
    }
}
