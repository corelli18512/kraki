import AppKit
import SwiftUI
import XCTest
@testable import Kraki_Dev

/// Session › Rename… and a session row's Rename… open Session Info with the
/// title being edited, also as the first sheet a freshly mounted chat shows;
/// Esc in the title field saves an edited title like Done (review #91), and
/// so does the sheet closing another way; a Session deleted while its title is
/// being edited gets no rename (review F1).
/// Through the production main window and the real Session Info sheet.
@MainActor
final class MacSessionInfoRenameTests: XCTestCase {
    private let device = "rename-tentacle"
    private let scope = "mac-session-info-rename-tests"
    private var root: URL!
    private var app: AppState!
    private var window: NSWindow?
    private var renames: [(sessionId: String?, title: String?)] = []
    private var deletes: [String?] = []
    private var savedInspectorShown: Any?
    private var savedRenderBubbleTest: String?

    private func drain(_ ms: Int) { RunLoop.main.run(until: Date().addingTimeInterval(Double(ms) / 1000)) }

    override func setUpWithError() throws {
        try requireForegroundUITests() // presents a real sheet on an on-screen window
        try super.setUpWithError()
        savedRenderBubbleTest = getenv("KRAKI_RENDER_BUBBLE_TEST").map { String(cString: $0) }
        setenv("KRAKI_RENDER_BUBBLE_TEST", "1", 1)
        savedInspectorShown = UserDefaults.standard.object(forKey: "mac.inspectorShown")
        UserDefaults.standard.set(false, forKey: "mac.inspectorShown")
        MacSessionInfoRequest.pending = nil
        root = FileManager.default.temporaryDirectory.appendingPathComponent("mac-rename-\(UUID().uuidString)")
        app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        app.connectionStatus = .connected
        app.testOutboundMessageHandler = { [weak self] message, _, _ in
            if message["type"] as? String == "rename_session" {
                self?.renames.append((message["sessionId"] as? String,
                                      (message["payload"] as? [String: Any])?["title"] as? String))
            }
            if message["type"] as? String == "delete_session" {
                self?.deletes.append(message["sessionId"] as? String)
            }
            return true
        }
        app.deviceStore.addDevice(DeviceSummary(id: device, name: "Mac", role: .tentacle, kind: .desktop,
                                                publicKey: nil, encryptionKey: nil, online: true, lastSeen: nil, createdAt: nil))
        for (i, (id, title)) in [("s1", "Fix login bug"), ("s2", "Release notes")].enumerated() {
            app.sessionStore.sessions[id] = SessionInfo(
                id: id, deviceId: device, deviceName: "Mac", agent: "pi", title: title,
                state: .idle, mode: .auto, lastSeq: 0, readSeq: 0, messageCount: 0,
                createdAt: Date().addingTimeInterval(Double(-60 * i)), pinned: false)
        }
    }

    override func tearDown() {
        if let window, let sheet = window.attachedSheet { window.endSheet(sheet) }
        window?.orderOut(nil)
        window?.contentView = nil
        window = nil
        app = nil
        MacSessionInfoRequest.pending = nil
        if let savedInspectorShown {
            UserDefaults.standard.set(savedInspectorShown, forKey: "mac.inspectorShown")
        } else {
            UserDefaults.standard.removeObject(forKey: "mac.inspectorShown")
        }
        if let savedRenderBubbleTest {
            setenv("KRAKI_RENDER_BUBBLE_TEST", savedRenderBubbleTest, 1)
        } else {
            unsetenv("KRAKI_RENDER_BUBBLE_TEST")
        }
        if let root { try? FileManager.default.removeItem(at: root) }
        super.tearDown()
    }

    // MARK: Rename… enters title editing on the first open

    /// Session › Rename… right after the chat appeared: the first sheet this
    /// chat shows (it was plain Session Info until a second Rename…).
    func testRenameFromTheSessionMenuEditsTheTitleOnTheFirstOpen() throws {
        mount(selected: "s1")
        requestRenameFromTheSessionMenu("s1")
        let sheet = try waitForSheet()
        let field = try XCTUnwrap(waitFor { self.titleField(in: sheet, showing: "Fix login bug") },
                                  "the title is being edited: \(describe(sheet))")
        XCTAssertTrue(waitFor { self.hasFocus(field, in: sheet) }, "with the keyboard focus")
    }

    /// A session row's Rename… on a row that is not the open chat: that
    /// Session opens, and its Session Info starts with its title being edited.
    func testRenameFromAnotherRowEditsThatSessionsTitle() throws {
        mount(selected: "s1")
        // SessionsSidebarView+macOS, the row's Rename…: remember the request,
        // select the row, ask the open chat.
        MacSessionInfoRequest.pending = "s2"
        NotificationCenter.default.post(name: .macSelectSession, object: nil,
                                        userInfo: ["sessionId": "s2", "scope": scope])
        NotificationCenter.default.post(name: .macOpenSessionInfo, object: nil, userInfo: ["sessionId": "s2"])
        let sheet = try waitForSheet()
        let field = try XCTUnwrap(waitFor { self.titleField(in: sheet, showing: "Release notes") },
                                  "that Session's title is being edited: \(describe(sheet))")
        XCTAssertTrue(waitFor { self.hasFocus(field, in: sheet) }, "with the keyboard focus")
        XCTAssertNil(MacSessionInfoRequest.pending, "the request was used once")
    }

    // MARK: Esc in the title field

    func testEscWithAnEditedTitleSavesItLikeDone() throws {
        mount(selected: "s1")
        requestRenameFromTheSessionMenu("s1")
        let sheet = try waitForSheet()
        let field = try XCTUnwrap(waitFor { self.titleField(in: sheet, showing: "Fix login bug") },
                                  "the title is being edited: \(describe(sheet))")
        XCTAssertTrue(waitFor { self.hasFocus(field, in: sheet) })
        let editor = try XCTUnwrap(sheet.firstResponder as? NSTextView)
        editor.selectAll(nil)
        editor.insertText("Fix login bug (Esc)", replacementRange: editor.selectedRange())
        drain(100)

        pressEsc(in: sheet)
        XCTAssertTrue(waitFor { self.window?.attachedSheet == nil }, "Esc closes Session Info")
        XCTAssertTrue(waitFor { !self.renames.isEmpty }, "the edited title is saved")
        drain(1_500) // and only once: the sheet's late onDisappear adds nothing
        XCTAssertEqual(renames.map(\.title), ["Fix login bug (Esc)"])
        XCTAssertEqual(renames.first?.sessionId, "s1")
        XCTAssertEqual(app.sessionStore.sessions["s1"]?.title, "Fix login bug (Esc)")
    }

    func testEscWithoutAnEditSavesNothing() throws {
        mount(selected: "s1")
        requestRenameFromTheSessionMenu("s1")
        let sheet = try waitForSheet()
        let field = try XCTUnwrap(waitFor { self.titleField(in: sheet, showing: "Fix login bug") },
                                  "the title is being edited: \(describe(sheet))")
        XCTAssertTrue(waitFor { self.hasFocus(field, in: sheet) })

        pressEsc(in: sheet)
        XCTAssertTrue(waitFor { self.window?.attachedSheet == nil }, "Esc closes Session Info")
        drain(2_000) // past the sheet's late onDisappear
        XCTAssertTrue(renames.isEmpty, "nothing changed, nothing is sent: \(renames)")
        XCTAssertEqual(app.sessionStore.sessions["s1"]?.title, "Fix login bug")
    }

    // MARK: Closed another way while the title is being edited

    /// Another Session opened while s1's title is being edited: s1's chat and
    /// its Session Info close, and what was typed is saved for s1 — the
    /// still-existing Session keeps the onDisappear save (review F1 follow-up).
    func testOpeningAnotherSessionWhileTheTitleIsEditedSavesIt() throws {
        try untilTheClosedSheetIsReleased {
            mount(selected: "s1")
            _ = try openRenameAndType("Fix login bug (switched)")

            NotificationCenter.default.post(name: .macSelectSession, object: nil,
                                            userInfo: ["sessionId": "s2", "scope": scope])

            XCTAssertTrue(waitFor { self.window?.attachedSheet == nil }, "Session Info closes with s1's chat")
        }
        XCTAssertTrue(waitFor { !self.renames.isEmpty }, "the edited title is saved")
        drain(500)
        XCTAssertEqual(renames.map(\.title), ["Fix login bug (switched)"])
        XCTAssertEqual(renames.first?.sessionId, "s1")
        XCTAssertEqual(app.sessionStore.sessions["s1"]?.title, "Fix login bug (switched)")
    }

    // MARK: The session goes away while its title is being edited (review F1)

    /// Rename… → type → Delete → confirm: the session is deleted, and the
    /// sheet closing afterwards does not rename the deleted session.
    func testDeletingWhileTheTitleIsEditedSendsNoRename() throws {
        try untilTheClosedSheetIsReleased {
            mount(selected: "s1")
            let sheet = try openRenameAndType("Fix login bug (deleted)")

            // Pressed as a click on a Mac button does it: the title field keeps the focus.
            let delete = try XCTUnwrap(waitFor { self.button(titled: "Delete", in: sheet) },
                                       "Session Info offers Delete")
            XCTAssertTrue(delete.accessibilityPerformPress?() ?? false)
            let confirmation = try XCTUnwrap(waitFor { sheet.attachedSheet }, "Delete asks for confirmation")
            let confirm = try XCTUnwrap(waitFor { self.button(titled: "Delete", in: confirmation) },
                                        "the confirmation offers Delete")
            XCTAssertNotNil(titleField(in: sheet, showing: "Fix login bug (deleted)"),
                            "the title is still being edited")
            // The alert's NSButton reports false here although it performs the click.
            _ = confirm.accessibilityPerformPress?()

            XCTAssertTrue(waitFor { self.window?.attachedSheet == nil }, "Session Info closes")
            XCTAssertEqual(deletes, ["s1"], "the session is deleted")
            XCTAssertNil(app.sessionStore.sessions["s1"])
        }
        XCTAssertTrue(renames.isEmpty, "no rename for the deleted session: \(renames)")
    }

    /// Removed by another device (session_deleted) while its title is being
    /// edited: its chat closes, and Session Info closing renames nothing.
    func testRemovalElsewhereWhileTheTitleIsEditedSendsNoRename() throws {
        try untilTheClosedSheetIsReleased {
            mount(selected: "s1")
            _ = try openRenameAndType("Fix login bug (removed)")

            // MessageRouter, session_deleted.
            app.sessionStore.removeSession("s1")

            XCTAssertTrue(waitFor { self.window?.attachedSheet == nil }, "Session Info closes with its chat")
        }
        XCTAssertTrue(renames.isEmpty, "no rename for the removed session: \(renames)")
    }

    // MARK: Fixture

    /// Session › Rename… on s1, then the title typed over (still being edited).
    private func openRenameAndType(_ title: String) throws -> NSWindow {
        requestRenameFromTheSessionMenu("s1")
        let sheet = try waitForSheet()
        let field = try XCTUnwrap(waitFor { self.titleField(in: sheet, showing: "Fix login bug") },
                                  "the title is being edited: \(describe(sheet))")
        XCTAssertTrue(waitFor { self.hasFocus(field, in: sheet) })
        let editor = try XCTUnwrap(sheet.firstResponder as? NSTextView)
        editor.selectAll(nil)
        editor.insertText(title, replacementRange: editor.selectedRange())
        drain(100)
        return sheet
    }

    /// A closed sheet's onDisappear runs when its view is released, which in
    /// a test is the autorelease pool's drain (in the app, the next run loop
    /// turn): run `steps` in their own pool so that it happens in the test.
    private func untilTheClosedSheetIsReleased(_ steps: () throws -> Void) rethrows {
        try autoreleasepool { try steps() }
        drain(500)
    }

    /// A button by its title, through the accessibility tree (SwiftUI buttons
    /// are not NSButtons).
    private func button(titled title: String, in window: NSWindow) -> AnyObject? {
        func find(_ element: AnyObject) -> AnyObject? {
            if element.accessibilityRole?() == .button,
               element.accessibilityTitle?() == title || element.accessibilityLabel?() == title {
                return element
            }
            for child in element.accessibilityChildren?() ?? [] {
                if let found = find(child as AnyObject) { return found }
            }
            return nil
        }
        return window.contentView.flatMap { find($0) }
    }

    /// The production main window on screen (floating, never key: the
    /// developer's keyboard focus stays where it is).
    private func mount(selected: String) {
        let main = MainWindowView(initialSelectedSessionId: selected, selectionNotificationScope: scope)
            .environment(app).environment(TentacleCLIManager())
        let window = NSWindow(contentRect: NSRect(x: 40, y: 40, width: 1100, height: 720),
                              styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: main)
        window.level = .floating
        window.orderFrontRegardless()
        self.window = window
        drain(1_000)
    }

    /// What Session › Rename… (Commands) does for the open chat.
    private func requestRenameFromTheSessionMenu(_ id: String) {
        MacSessionInfoRequest.pending = id
        NotificationCenter.default.post(name: .macOpenSessionInfo, object: nil, userInfo: ["sessionId": id])
    }

    private func waitFor<T>(seconds: TimeInterval = 3, _ probe: () -> T?) -> T? {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if let value = probe() { return value }
            drain(50)
        }
        return probe()
    }

    private func waitFor(seconds: TimeInterval = 3, _ condition: () -> Bool) -> Bool {
        waitFor(seconds: seconds) { condition() ? true : nil } ?? false
    }

    private func waitForSheet() throws -> NSWindow {
        let sheet = try XCTUnwrap(waitFor { self.window?.attachedSheet }, "Session Info opens as a sheet")
        drain(300)
        return sheet
    }

    /// The editable title field, present only while the title is being edited.
    private func titleField(in sheet: NSWindow, showing title: String) -> NSTextField? {
        textFields(in: sheet.contentView).first { $0.isEditable && $0.stringValue == title }
    }

    private func hasFocus(_ field: NSTextField, in sheet: NSWindow) -> Bool {
        sheet.firstResponder === field || (sheet.firstResponder as? NSTextView)?.delegate === field
    }

    private func textFields(in view: NSView?) -> [NSTextField] {
        guard let view else { return [] }
        return ((view as? NSTextField).map { [$0] } ?? []) + view.subviews.flatMap { textFields(in: $0) }
    }

    private func describe(_ sheet: NSWindow) -> String {
        let fields = textFields(in: sheet.contentView).map { "\($0.isEditable ? "edit" : "label"):\($0.stringValue)" }
        return "fields=\(fields) firstResponder=\(String(describing: sheet.firstResponder))"
    }

    /// The Esc key, delivered to the sheet as AppKit delivers it.
    private func pressEsc(in sheet: NSWindow) {
        let esc = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [],
                                   timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: sheet.windowNumber,
                                   context: nil, characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}",
                                   isARepeat: false, keyCode: 53)
        if let esc { sheet.sendEvent(esc) }
        if let up = NSEvent.keyEvent(with: .keyUp, location: .zero, modifierFlags: [],
                                     timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: sheet.windowNumber,
                                     context: nil, characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}",
                                     isARepeat: false, keyCode: 53) {
            sheet.sendEvent(up)
        }
    }
}
