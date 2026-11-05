#if os(macOS)
import Foundation

/// Decisions of the Mac Session Info sheet that do not need the view.
enum MacSessionInfoRules {
    /// The title to save when the sheet closes (Done or Esc) while the title
    /// is still being edited; nil when nothing changed.
    static func titleToSaveOnClose(editing: Bool, draft: String, original: String) -> String? {
        guard editing else { return nil }
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed == original ? nil : trimmed
    }

    /// Picking another model keeps the chosen Thinking level when the new
    /// model supports it (as on iPhone); otherwise the new model's default.
    static func effortAfterModelChange(to model: String, in details: [ModelDetail],
                                       current: ReasoningEffort?) -> ReasoningEffort? {
        effort(for: model, in: details, preferred: current)
    }

    /// The Thinking level for `model`: `preferred` when the model supports
    /// it, else the model's default, else its first level; nil without levels.
    static func effort(for model: String, in details: [ModelDetail], preferred: ReasoningEffort?) -> ReasoningEffort? {
        guard let detail = details.first(where: { $0.id == model }),
              detail.supportsReasoningEffort,
              let efforts = detail.supportedReasoningEfforts,
              !efforts.isEmpty else { return nil }
        if let preferred, efforts.contains(preferred) { return preferred }
        if let defaultEffort = detail.defaultReasoningEffort,
           efforts.contains(defaultEffort) {
            return defaultEffort
        }
        return efforts.first
    }
}

#endif
