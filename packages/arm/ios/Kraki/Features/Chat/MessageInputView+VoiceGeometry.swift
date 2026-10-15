#if os(iOS)
import SwiftUI

extension MessageInputView {
    static func elapsed(from start: Date, to now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(start)))
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
}

extension View {
    /// Read-only layout evidence; absent from release builds and inert outside
    /// explicitly enabled isolated tests. No sizing state feeds back into UI.
    @ViewBuilder
    func voiceGeometryProbe(_ name: String) -> some View {
        #if DEBUG
        if IOSVoiceGeometryProbe.enabled {
            onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: {
                IOSVoiceGeometryProbe.frames[name] = $0
            }
        } else { self }
        #else
        self
        #endif
    }
}

#if DEBUG
@MainActor
enum IOSVoiceGeometryProbe {
    static var enabled = false
    static var frames: [String: CGRect] = [:]
}
#endif
#endif
