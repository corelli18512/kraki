import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Pure-data chat loading geometry helpers. Cross-platform (used by both the
/// iOS `ChatView` and the macOS `MacChatView`). Extracted from ChatView.swift
/// so the macOS target — which does not compile ChatView.swift — still links.

enum ChatEntryLoading {
    static func isEntryGateActive(
        providerWaitingForLatest: Bool,
        hasMaterializedLatest: Bool
    ) -> Bool {
        !hasMaterializedLatest && providerWaitingForLatest
    }

    /// A cold launch restores every cached device as offline until the first
    /// authenticated Relay snapshot arrives. Keep Chat's first frame behind the
    /// existing entry gate during that short handshake so it does not lay out
    /// once without the composer and jump again when the device becomes online.
    /// A genuine connection failure releases the gate and keeps offline history
    /// available.
    static func isInitialConnectionGateActive(
        hasStoredCredentials: Bool,
        hasCompletedInitialConnect: Bool,
        connectionStatus: ConnectionStatus
    ) -> Bool {
        guard hasStoredCredentials, !hasCompletedInitialConnect else { return false }
        switch connectionStatus {
        case .awaitingLogin, .connecting, .authenticating:
            return true
        case .connected, .disconnected, .error:
            return false
        }
    }

    static func isWaitingForLatest(
        expectedLastSeq: Int,
        windowBottomSeq: Int,
        hasMessages: Bool,
        sessionLoading: Bool
    ) -> Bool {
        if expectedLastSeq > 0 {
            return windowBottomSeq < expectedLastSeq
        }
        return !hasMessages && sessionLoading
    }
}

enum ChatBottomObstruction {
    static func height(
        measuredComposerHeight: CGFloat,
        composerVisible: Bool,
        compacting: Bool
    ) -> CGFloat {
        let composerFloor: CGFloat = composerVisible ? 54 : 0
        let compactionFloor: CGFloat = compacting ? 40 : 0
        let spacing: CGFloat = composerVisible && compacting ? 8 : 0
        return max(measuredComposerHeight, composerFloor + compactionFloor + spacing)
    }
}
