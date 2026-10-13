/// The terminal result of one voice recording.

import Foundation

/// Opt-in terminal information for hold-to-text; existing onFinal clients keep
/// their original draft-only behavior. A recovered/raw-only result must not send.
struct VoiceInputCompletion {
    let text: String
    let rawText: String
    let completed: Bool
    /// Ended without a final transcript: connection or recognition failure,
    /// reset, quota or departure. An empty `rawText` then does not mean that
    /// nothing was said, only that nothing arrived.
    var failed = false
}
