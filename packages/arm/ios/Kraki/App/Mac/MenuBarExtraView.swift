/// MenuBarExtraView — the menu under Kraki's menu bar octopus.
///
/// The menu bar answers "is this Mac online?" and gets you to what needs
/// you; everything else lives in the window (see MacPresence.swift):
///   • This Mac's status (click: Settings › This Mac)
///   • Needs You — sessions waiting on a permission or an answer
///   • Open Kraki, Account Usage
///   • Go Online / Go Offline
///   • Settings…, Quit Kraki… (quitting takes this Mac offline)

#if os(macOS)
import SwiftUI
import AppKit

struct MenuBarExtraView: View {
    @Environment(AppState.self) private var appState
    @Environment(TentacleCLIManager.self) private var tentacleCLI
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        statusItem

        let waiting = MenuBarNeedsYou.sessions(in: appState)
        if !waiting.isEmpty {
            Divider()
            Section("Needs You") {
                ForEach(waiting.prefix(MenuBarNeedsYou.limit)) { item in
                    Button {
                        openKraki(selecting: item.id)
                    } label: {
                        Text(item.title)
                        Text(item.reason)
                    }
                }
                if waiting.count > MenuBarNeedsYou.limit {
                    Button("\(waiting.count - MenuBarNeedsYou.limit) more…") { openKraki() }
                }
            }
        }

        Divider()

        Button("Open Kraki") { openKraki() }
            .keyboardShortcut("0", modifiers: .command)

        Button("Account Usage") {
            UsagePeekController.shared.togglePinned()
        }

        Divider()

        if tentacleCLI.canGoOffline {
            Button("Take This Mac Offline") {
                Task { await tentacleCLI.goOffline() }
            }
        } else if tentacleCLI.canGoOnline {
            Button("Bring This Mac Online") {
                Task { await tentacleCLI.goOnline() }
            }
        }

        Button("Settings…") {
            NSApp.activate(ignoringOtherApps: true)
            openSettings()
        }
        .keyboardShortcut(",", modifiers: .command)

        Button(tentacleCLI.managesOnlinePresence && tentacleCLI.canGoOffline
               ? "Quit Kraki and Go Offline…" : "Quit Kraki") {
            MacPresenceController.shared.quitGoingOffline()
        }
    }

    @ViewBuilder
    private var statusItem: some View {
        let status = tentacleCLI.onlineStatus
        Button {
            switch status {
            case .needsLoginItems: BuiltInTentacle.openLoginItemsSettings()
            default:
                NSApp.activate(ignoringOtherApps: true)
                openSettings()
            }
        } label: {
            Image(nsImage: Self.statusDot(status))
            Text(status.title)
            if let detail = status.detail { Text(detail) }
        }
    }

    private func openKraki(selecting sessionId: String? = nil) {
        openWindow(id: "main")
        MacPresenceController.shared.showMainWindow()
        guard let sessionId else { return }
        // The window may still be mounting; it records the selection either way.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
            NotificationCenter.default.post(name: .macSelectSession, object: nil, userInfo: ["sessionId": sessionId])
        }
    }

    /// A colored status dot. Menus drop SwiftUI colors, so it is a
    /// non-template image.
    static func statusDot(_ status: MacOnlineStatus) -> NSImage {
        let color: NSColor = switch status {
        case .online: .systemGreen
        case .goingOnline, .goingOffline: .systemYellow
        case .needsLoginItems, .problem: .systemRed
        case .offline, .checking, .controlsOthersOnly: .tertiaryLabelColor
        }
        let image = NSImage(size: NSSize(width: 10, height: 10), flipped: false) { rect in
            color.setFill()
            NSBezierPath(ovalIn: rect.insetBy(dx: 1, dy: 1)).fill()
            return true
        }
        image.isTemplate = false
        return image
    }
}

/// The logo octopus in the menu bar. State shows as opacity and a badge,
/// never as a different shape (MacPresence.swift).
struct MenuBarIconLabel: View {
    let appState: AppState
    let tentacleCLI: TentacleCLIManager

    var body: some View {
        Image(nsImage: icon)
            .accessibilityLabel("Kraki")
    }

    private var icon: NSImage {
        #if DEBUG
        // Visual check of every icon state without touching a real service:
        // KRAKI_MENUBAR_ICON_PREVIEW=online|offline|starting|attention|problem
        if let preview = ProcessInfo.processInfo.environment["KRAKI_MENUBAR_ICON_PREVIEW"] {
            let status: MacOnlineStatus = switch preview {
            case "offline": .offline
            case "starting": .goingOnline
            case "problem": .needsLoginItems
            default: .online
            }
            return MacMenuBarIcon.image(status: status, needsYou: preview == "attention")
        }
        #endif
        return MacMenuBarIcon.image(
            status: tentacleCLI.onlineStatus,
            needsYou: MenuBarNeedsYou.any(in: appState)
        )
    }
}

/// Sessions waiting on the user, newest first.
enum MenuBarNeedsYou {
    static let limit = 5

    struct Item: Identifiable, Equatable {
        let id: String
        let title: String
        let reason: String
        let timestamp: String
    }

    @MainActor
    static func sessions(in appState: AppState) -> [Item] {
        // Walk the previews, not the sorted session list: the menu bar label
        // asks on every session update.
        let store = appState.sessionStore
        return items(titles: store.sessions.mapValues(\.displayTitle), previews: store.sessionPreviews)
    }

    /// Cheap check for the icon badge: no titles, no sorting.
    @MainActor
    static func any(in appState: AppState) -> Bool {
        let store = appState.sessionStore
        return store.sessionPreviews.contains { id, preview in
            (preview.type == "permission" || preview.type == "question") && store.sessions[id] != nil
        }
    }

    /// Live sessions (in `titles`) whose latest item is a permission
    /// request or a question.
    static func items(titles: [String: String], previews: [String: SessionPreview]) -> [Item] {
        previews.compactMap { id, preview in
            guard let title = titles[id] else { return nil }
            let reason: String
            switch preview.type {
            case "permission": reason = "Waiting for your approval"
            case "question": reason = "Asked you a question"
            default: return nil
            }
            return Item(id: id, title: title, reason: reason, timestamp: preview.timestamp)
        }
        .sorted { ($0.timestamp, $0.id) > ($1.timestamp, $1.id) }
    }
}

#endif
