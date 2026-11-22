#if os(macOS)
import Foundation

/// Which HTML artifact each Session shows in the main window's side pane
/// (moved out of MainWindowView.swift).
struct MacHTMLArtifactSessionPresentation: Equatable {
    let selection: MacSelectedHTMLArtifact
    var expanded: Bool
}

struct MacHTMLArtifactSessionCache: Equatable {
    private var presentations: [String: MacHTMLArtifactSessionPresentation] = [:]

    func presentation(for sessionId: String) -> MacHTMLArtifactSessionPresentation? {
        presentations[sessionId]
    }

    mutating func open(sessionId: String, ref: ContentRef) {
        presentations[sessionId] = MacHTMLArtifactSessionPresentation(
            selection: MacSelectedHTMLArtifact(sessionId: sessionId, ref: ref),
            expanded: false
        )
    }

    mutating func toggleExpanded(for sessionId: String) {
        guard var presentation = presentations[sessionId] else { return }
        presentation.expanded.toggle()
        presentations[sessionId] = presentation
    }

    mutating func close(sessionId: String) {
        presentations.removeValue(forKey: sessionId)
    }
}
#endif
