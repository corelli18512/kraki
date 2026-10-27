#if os(macOS) && DEBUG
import AppKit
import SwiftUI
import XCTest
@testable import Kraki_Dev

/// Focus, IME and undo regressions of the native Mac composer editor
/// (`MacComposerScrollableTextInput` / `MacComposerTextView`), driven through
/// the production `MacChatComposer` and `NewSessionComposer`. Off-screen
/// borderless windows that are key only inside this inactive test app; no
/// events are posted to the system.
@MainActor
final class MacComposerInputRegressionTests: XCTestCase {
    private final class KeyableWindow: NSWindow {
        override var canBecomeKey: Bool { true }
        /// The test host is never the active app: report key so the
        /// composer's `window.isKeyWindow` focus paths run.
        override var isKeyWindow: Bool { true }
    }

    private var window: NSWindow?
    private var savedLastDevice: String?

    override func setUpWithError() throws { try requireForegroundUITests() }

    override func tearDown() {
        MacComposerMetrics.snapshotFlatGlass = false
        window?.orderOut(nil); window?.contentView = nil; window = nil
        if let savedLastDevice { SessionPrefs.saveLastDevice(savedLastDevice) }
        savedLastDevice = nil
        super.tearDown()
    }

    private func drain(_ ms: Int) { RunLoop.main.run(until: Date().addingTimeInterval(Double(ms) / 1000)) }
    private func views(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap { views($0) } }
    private func editor(in window: NSWindow) throws -> MacComposerTextView {
        try XCTUnwrap(views(try XCTUnwrap(window.contentView)).compactMap { $0 as? MacComposerTextView }.first)
    }
    private func type(_ text: String, into editor: NSTextView) {
        editor.insertText(text, replacementRange: NSRange(location: NSNotFound, length: 0))
    }

    private func makeWindow(width: CGFloat, height: CGFloat) -> NSWindow {
        let window = KeyableWindow(contentRect: NSRect(x: -6000, y: -6000, width: width, height: height),
                                   styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .aqua)
        self.window = window
        return window
    }

    /// The production chat composer for "voice-a" above a plain text field
    /// (standing in for the sidebar Search field).
    private func makeChatComposer(width: CGFloat = 640) -> (NSWindow, AppState, NSTextField) {
        MacComposerMetrics.snapshotFlatGlass = true
        let app = IOSVoiceHoldScenarioFixture.makeAppState(driver: IOSVoiceHoldScenarioDriver(automaticCorrections: false))
        let window = makeWindow(width: width, height: 220)
        let root = VStack(spacing: 0) { Spacer(minLength: 0); MacChatComposer(sessionId: "voice-a") }
            .frame(maxWidth: .infinity, maxHeight: .infinity).environment(app)
        let container = NSView(frame: NSRect(x: 0, y: 0, width: width, height: 220))
        let host = NSHostingView(rootView: root)
        host.frame = container.bounds
        host.autoresizingMask = [.width, .height]
        let field = NSTextField(frame: NSRect(x: 10, y: 190, width: 200, height: 22))
        container.addSubview(host)
        container.addSubview(field)
        window.contentView = container
        window.orderFrontRegardless(); window.makeKey()
        drain(500)
        return (window, app, field)
    }

    private func rerenderComposer(_ app: AppState) {
        // Another session's update: MacChatComposer.body reads `sessions`.
        app.sessionStore.sessions["voice-b"]?.title = "Other conversation \(UUID().uuidString)"
        drain(250)
    }

    // MARK: Focus

    /// The user types in the composer, then moves to another text field
    /// (e.g. sidebar Search). An unrelated re-render must not pull focus back:
    /// before, the binding stayed true and every update re-asserted focus.
    func testComposerDoesNotTakeFocusBackFromAnotherTextField() throws {
        let (window, app, field) = makeChatComposer()
        let editor = try editor(in: window)
        XCTAssertTrue(window.makeFirstResponder(editor)); drain(100)
        type("draft", into: editor); drain(150)
        XCTAssertTrue(window.makeFirstResponder(field)); drain(150)
        XCTAssertNotNil(field.currentEditor())

        rerenderComposer(app)
        XCTAssertFalse(window.firstResponder === editor, "composer took focus back from another text field")
        XCTAssertNotNil(field.currentEditor(), "the other text field lost focus on an unrelated re-render")
        rerenderComposer(app)
        XCTAssertNotNil(field.currentEditor())
        XCTAssertEqual(app.sessionStore.drafts["voice-a"], "draft")

        // Clicking back into the composer still works, and the next
        // re-render keeps it (focus is synced from the editor itself).
        XCTAssertTrue(window.makeFirstResponder(editor)); drain(50)
        rerenderComposer(app)
        XCTAssertTrue(window.firstResponder === editor, "clicking back into the composer did not stick")
        // The click that activates an inactive window reaches the editor.
        XCTAssertTrue(editor.acceptsFirstMouse(for: nil))
    }

    @Observable final class InputState {
        var text = ""
        var focused = false
        var hasText = false
        var composingText: String?
        var focusRequest = 0
        var tick = 0
    }

    struct InputHost: View {
        @Bindable var state: InputState
        var body: some View {
            VStack(spacing: 0) {
                Text("tick \(state.tick)").frame(height: 20)
                MacComposerScrollableTextInput(
                    text: $state.text, focused: $state.focused, nativeEditorHasText: $state.hasText,
                    nativeComposingText: $state.composingText,
                    enabled: true, focusRequest: state.focusRequest,
                    onRequestFocus: { state.focused = true; state.focusRequest += 1 },
                    onSubmit: {}, onSelection: { _ in }, onTakeOver: {})
                    .frame(width: 300)
                Spacer(minLength: 0)
            }
        }
    }

    /// With the binding false (after voice started, or never focused), a click
    /// into the editor makes it first responder; the next re-render used to
    /// resign it because nothing synced the binding until the first keystroke.
    func testClickIntoComposerSticksWhenBindingWasFalse() throws {
        let state = InputState()
        let window = makeWindow(width: 400, height: 200)
        let host = NSHostingView(rootView: InputHost(state: state))
        host.frame = NSRect(x: 0, y: 0, width: 400, height: 200)
        window.contentView = host
        window.orderFrontRegardless(); window.makeKey()
        drain(300)
        let editor = try editor(in: window)
        XCTAssertFalse(state.focused)
        XCTAssertTrue(window.makeFirstResponder(editor)) // what mouseDown in the editor does
        drain(100)
        state.tick += 1
        drain(200)
        XCTAssertTrue(window.firstResponder === editor, "an unrelated re-render resigned the editor the user clicked into")
        XCTAssertTrue(state.focused)

        // A programmatic unfocus (voice start sets the binding false) still resigns.
        state.focused = false
        drain(200)
        XCTAssertFalse(window.firstResponder === editor)
        // And an explicit focus request still focuses.
        state.focused = true; state.focusRequest += 1
        drain(200)
        XCTAssertTrue(window.firstResponder === editor)
    }

    private final class ToggleKeyWindow: NSWindow {
        var reportsKey = false
        override var canBecomeKey: Bool { true }
        override var isKeyWindow: Bool { reportsKey }
    }

    /// A focus request while the window is not key (app in the background,
    /// launching) waits: no focus is taken until the window becomes key,
    /// then the editor takes it exactly once and stops observing.
    func testFocusRequestWaitsUntilTheWindowBecomesKey() throws {
        let state = InputState()
        let window = ToggleKeyWindow(contentRect: NSRect(x: -6000, y: -6000, width: 400, height: 200),
                                     styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        self.window = window
        let host = NSHostingView(rootView: InputHost(state: state))
        host.frame = NSRect(x: 0, y: 0, width: 400, height: 200)
        let field = NSTextField(frame: NSRect(x: 10, y: 170, width: 100, height: 22))
        host.addSubview(field)
        window.contentView = host
        window.orderFrontRegardless()
        drain(300)
        let editor = try editor(in: window)
        let coordinator = try XCTUnwrap(editor.delegate as? MacComposerScrollableTextInput.Coordinator)

        state.focused = true; state.focusRequest += 1
        drain(300)
        XCTAssertFalse(window.firstResponder === editor, "took focus in a window that is not key")
        XCTAssertTrue(coordinator.waitsForKeyWindow)
        state.tick += 1 // unrelated re-render while still not key
        drain(200)
        XCTAssertFalse(window.firstResponder === editor)

        window.reportsKey = true
        NotificationCenter.default.post(name: NSWindow.didBecomeKeyNotification, object: window)
        XCTAssertTrue(window.firstResponder === editor, "did not take focus when the window became key")
        XCTAssertFalse(coordinator.waitsForKeyWindow, "the key-window observer was not removed")
        XCTAssertTrue(state.focused)

        // Later key changes do not re-assert focus.
        XCTAssertTrue(window.makeFirstResponder(field)); drain(200)
        NotificationCenter.default.post(name: NSWindow.didBecomeKeyNotification, object: window)
        drain(100)
        XCTAssertFalse(window.firstResponder === editor)
        XCTAssertNotNil(field.currentEditor())
    }

    // MARK: Image preview

    @Observable final class PreviewState { var open = false }

    /// The chat composer with MainWindowView's image preview overlay above it.
    struct PreviewHost: View {
        @Bindable var preview: PreviewState
        let image: NSImage
        var body: some View {
            ZStack {
                VStack(spacing: 0) { Spacer(minLength: 0); MacChatComposer(sessionId: "voice-a") }
                if preview.open {
                    MacImagePreviewOverlay(selection: MacImagePreviewSelection(image: image, title: "shot.png"),
                                           onClose: { preview.open = false })
                }
            }
        }
    }

    /// The image preview takes first responder (zoom keys). Closing it hands
    /// focus back to the composer if the composer had it; otherwise focus
    /// is not pulled into the composer.
    func testClosingTheImagePreviewReturnsFocusToTheComposer() throws {
        MacComposerMetrics.snapshotFlatGlass = true
        let app = IOSVoiceHoldScenarioFixture.makeAppState(driver: IOSVoiceHoldScenarioDriver(automaticCorrections: false))
        let preview = PreviewState()
        let image = NSImage(size: NSSize(width: 40, height: 30), flipped: false) { rect in
            NSColor.systemTeal.setFill(); rect.fill(); return true
        }
        let window = makeWindow(width: 640, height: 300)
        let root = PreviewHost(preview: preview, image: image)
            .frame(maxWidth: .infinity, maxHeight: .infinity).environment(app)
        let container = NSView(frame: NSRect(x: 0, y: 0, width: 640, height: 300))
        let host = NSHostingView(rootView: root)
        host.frame = container.bounds
        let field = NSTextField(frame: NSRect(x: 10, y: 270, width: 200, height: 22))
        container.addSubview(host)
        container.addSubview(field)
        window.contentView = container
        window.orderFrontRegardless(); window.makeKey()
        drain(500)
        let editor = try editor(in: window)
        XCTAssertTrue(window.makeFirstResponder(editor)); drain(100)
        type("draft", into: editor); drain(150)

        preview.open = true
        drain(400)
        XCTAssertTrue(window.firstResponder is MacZoomableImageView, "the preview did not take focus")
        rerenderComposer(app)
        XCTAssertTrue(window.firstResponder is MacZoomableImageView, "the composer took focus from the open preview")

        preview.open = false
        drain(400)
        XCTAssertTrue(window.firstResponder === editor, "closing the preview did not return focus to the composer")
        type(" more", into: editor); drain(150)
        XCTAssertEqual(app.sessionStore.drafts["voice-a"], "draft more")

        // Opened from another field: closing does not pull focus into the composer.
        XCTAssertTrue(window.makeFirstResponder(field)); drain(200)
        preview.open = true; drain(400)
        preview.open = false; drain(400)
        XCTAssertFalse(window.firstResponder === editor, "closing the preview pulled focus into the composer")
    }

    /// Paging creates a new zoom view per image; the composer to refocus is
    /// passed on, and only the view that has focus when it closes hands back.
    func testImagePreviewPagingKeepsTheComposerToRefocus() throws {
        let (window, _, _) = makeChatComposer()
        let editor = try editor(in: window)
        XCTAssertTrue(window.makeFirstResponder(editor)); drain(100)
        let content = try XCTUnwrap(window.contentView)
        let first = MacZoomableImageView(frame: content.bounds)
        content.addSubview(first)
        XCTAssertTrue(window.firstResponder === first)
        XCTAssertTrue(first.composerToRefocus === editor)
        let second = MacZoomableImageView(frame: content.bounds)
        content.addSubview(second)
        first.removeFromSuperview()
        XCTAssertTrue(window.firstResponder === second)
        XCTAssertTrue(second.composerToRefocus === editor)
        second.removeFromSuperview()
        XCTAssertTrue(window.firstResponder === editor)
    }

    // MARK: IME

    /// Clear (and Send / deny / answer: each sets the draft to "") while a
    /// Pinyin composition is marked. The replacement used to be skipped and
    /// the commit republished the cleared text.
    func testClearWhileComposingDiscardsTheComposition() throws {
        let (window, app, _) = makeChatComposer()
        let editor = try editor(in: window)
        XCTAssertTrue(window.makeFirstResponder(editor)); drain(100)
        type("old draft ", into: editor); drain(150)
        editor.setMarkedText("ni", selectedRange: NSRange(location: 2, length: 0),
                             replacementRange: NSRange(location: NSNotFound, length: 0))
        drain(150)
        XCTAssertEqual(app.sessionStore.drafts["voice-a"], "old draft ", "marked text must not reach the draft")

        app.sessionStore.setDraft("voice-a", "")
        drain(200)
        XCTAssertEqual(editor.string, "", "the cleared text is still in the editor")
        XCTAssertFalse(editor.hasMarkedText(), "the composition survived Clear")

        // Anything typed next (a late IME commit included) starts from empty.
        type("\u{4F60}", into: editor); drain(200)
        XCTAssertEqual(app.sessionStore.drafts["voice-a"], "\u{4F60}", "cleared text came back after the next input")
        XCTAssertEqual(editor.string, "\u{4F60}")
        XCTAssertTrue(window.firstResponder === editor)
    }

    /// The new-session composer's Send (create) while text is marked: the
    /// prompt is sent once and must not come back into the editor or draft.
    func testNewSessionSendWhileComposingDoesNotResurrectThePrompt() throws {
        savedLastDevice = SessionPrefs.lastDeviceId()
        SessionPrefs.saveLastDevice("voice-test-device")
        let app = IOSVoiceHoldScenarioFixture.makeAppState(driver: IOSVoiceHoldScenarioDriver(automaticCorrections: false))
        app.deviceStore.setDeviceAgents("voice-test-device", agents: [
            AgentCapabilities(type: "code", id: "pi", models: ["m"], modelDetails: nil),
        ])
        let window = makeWindow(width: 820, height: 420)
        window.contentView = NSHostingView(rootView: MacStartSessionView(firstTime: false)
            .environment(app).environment(TentacleCLIManager()))
        window.orderFrontRegardless(); window.makeKey()
        drain(600)
        let key = IOSVoiceComposer.newSessionDraftID
        let editor = try editor(in: window)
        XCTAssertTrue(window.makeFirstResponder(editor)); drain(100)
        type("Fix the tests ", into: editor); drain(150)
        editor.setMarkedText("ni", selectedRange: NSRange(location: 2, length: 0),
                             replacementRange: NSRange(location: NSNotFound, length: 0))
        drain(150)

        let content = try XCTUnwrap(window.contentView)
        let marker = try XCTUnwrap(views(content).first { $0.identifier?.rawValue == "mac.newSession.create" })
        let frame = marker.convert(marker.bounds, to: nil)
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            let event = try XCTUnwrap(NSEvent.mouseEvent(with: type, location: CGPoint(x: frame.midX, y: frame.midY),
                modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                context: nil, eventNumber: 1, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0))
            window.sendEvent(event)
        }
        drain(300)
        let created = Array(app.commandSender?.pendingCreateRequests.values ?? [:].values)
        XCTAssertEqual(created, ["Fix the tests"], "the prompt was not sent exactly once")
        let live = try self.editor(in: window)
        XCTAssertFalse(live.string.contains("Fix the tests"), "the sent prompt is still in the editor")
        type("\u{4F60}", into: live); drain(200)
        XCTAssertFalse((app.sessionStore.drafts[key] ?? "").contains("Fix the tests"), "the sent prompt came back into the draft")
    }

    /// A composition that wraps onto a new line grows the composer like
    /// committed text does; before, the box stayed one row and the committed
    /// text scrolled out of view until commit.
    func testMarkedTextThatWrapsGrowsTheComposer() async throws {
        let (window, app, _) = makeChatComposer(width: 640)
        let editor = try editor(in: window)
        XCTAssertTrue(window.makeFirstResponder(editor)); drain(100)
        type("Fix the failing tests in my-app, then run the whole suite", into: editor); drain(400)
        let scroll = try XCTUnwrap(editor.enclosingScrollView)
        let oneRow = scroll.contentSize.height
        let oneRowMinX = scroll.convert(scroll.bounds, to: nil).minX
        XCTAssertEqual(editor.frame.height, oneRow, accuracy: 0.5, "precondition: the committed draft is one line")

        editor.setMarkedText("zhongwenshurufashiyixiahuanhang", selectedRange: NSRange(location: 31, length: 0),
                             replacementRange: NSRange(location: NSNotFound, length: 0))
        // Settled, the document fits the clip exactly: the composer is the
        // only writer of the editor's height (audit finding 9). Polled, not
        // a fixed wait, before the exact assertions.
        let exact: CGFloat = 0.01
        try await waitBriefly {
            scroll.contentSize.height > oneRow + 10 && abs(scroll.contentSize.height - editor.frame.height) < exact
                && abs(scroll.contentView.bounds.minY) < exact
        }
        XCTAssertTrue(editor.hasMarkedText())
        XCTAssertGreaterThan(scroll.contentSize.height, oneRow + 10, "the composer did not grow for the wrapped composition")
        XCTAssertEqual(scroll.contentSize.height, editor.frame.height, accuracy: exact,
                       "the composing text is scrolled inside a box that is too short")
        XCTAssertEqual(scroll.contentView.bounds.minY, 0, accuracy: exact, "the committed text scrolled out of view")
        // The box takes the two-row (stacked) layout like committed text
        // that wraps: the editor spans the box instead of following the
        // attach button.
        XCTAssertLessThan(scroll.convert(scroll.bounds, to: nil).minX, oneRowMinX - 10,
                          "a wrapping composition kept the one-row layout")
        XCTAssertEqual(app.sessionStore.drafts["voice-a"], "Fix the failing tests in my-app, then run the whole suite",
                       "marked text must not reach the draft")

        editor.unmarkText()
        try await waitBriefly {
            app.sessionStore.drafts["voice-a"] == editor.string && abs(scroll.contentSize.height - editor.frame.height) < exact
        }
        XCTAssertEqual(app.sessionStore.drafts["voice-a"], editor.string)
        XCTAssertEqual(scroll.contentSize.height, editor.frame.height, accuracy: exact)
    }

    // MARK: Undo

    /// What AppKit does for Edit ▸ Undo / ⌘Z: the first responder in the
    /// chain that implements the action validates and performs it.
    private func chainTarget(_ action: Selector, in window: NSWindow) -> NSResponder? {
        var responder = window.firstResponder
        while let current = responder {
            if current.responds(to: action) { return current }
            responder = current.nextResponder
        }
        return nil
    }

    private func validates(_ action: Selector, in window: NSWindow) -> Bool {
        let item = NSMenuItem(title: "", action: action, keyEquivalent: "")
        guard let target = chainTarget(action, in: window) else { return false }
        if let validator = target as? NSMenuItemValidation { return validator.validateMenuItem(item) }
        if let validator = target as? NSUserInterfaceValidations { return validator.validateUserInterfaceItem(item) }
        return true
    }

    func testUndoAndRedoThroughTheResponderChainUpdateTheDraft() throws {
        let (window, app, _) = makeChatComposer()
        let editor = try editor(in: window)
        let undo = Selector(("undo:")), redo = Selector(("redo:"))
        XCTAssertTrue(window.makeFirstResponder(editor)); drain(100)
        XCTAssertFalse(validates(undo, in: window), "nothing to undo yet")
        type("hello world", into: editor); drain(200)
        XCTAssertEqual(app.sessionStore.drafts["voice-a"], "hello world")

        // One typing run is one undo step (NSTextView coalesces typing).
        XCTAssertTrue(validates(undo, in: window), "Edit ▸ Undo is disabled after typing")
        var changeNotes = 0
        let observer = NotificationCenter.default.addObserver(forName: NSText.didChangeNotification, object: editor,
                                                              queue: nil) { _ in changeNotes += 1 }
        defer { NotificationCenter.default.removeObserver(observer) }
        XCTAssertTrue(window.firstResponder?.tryToPerform(undo, with: nil) == true)
        drain(200)
        // TextKit 1 posts its own change for the undo; the editor's explicit
        // didChangeText() is a guarantee on top (a second, no-op publish).
        print("UNDO NSText.didChange notifications per undo: \(changeNotes)")
        XCTAssertGreaterThanOrEqual(changeNotes, 1, "undo did not announce the change")
        XCTAssertEqual(editor.string, "")
        XCTAssertEqual(app.sessionStore.drafts["voice-a"] ?? "", "", "undo changed the editor but not the draft")
        rerenderComposer(app)
        XCTAssertEqual(editor.string, "", "a re-render snapped the undone text back")

        XCTAssertTrue(validates(redo, in: window), "Edit ▸ Redo is disabled after an undo")
        XCTAssertTrue(window.firstResponder?.tryToPerform(redo, with: nil) == true)
        drain(200)
        XCTAssertEqual(editor.string, "hello world")
        XCTAssertEqual(app.sessionStore.drafts["voice-a"], "hello world")

        // A programmatic whole-draft replacement (Send, Clear, voice, Edit)
        // drops the history: no stale record may edit the new text.
        app.sessionStore.setDraft("voice-a", "voice text")
        drain(200)
        XCTAssertEqual(editor.string, "voice text")
        XCTAssertFalse(validates(undo, in: window), "stale undo records survived a draft replacement")
        _ = window.firstResponder?.tryToPerform(undo, with: nil)
        drain(100)
        XCTAssertEqual(editor.string, "voice text")
        XCTAssertEqual(app.sessionStore.drafts["voice-a"], "voice text")
    }


    /// The app's composer paste/focus regression probe (also run by the
    /// automation driver) passes against the current focus model.
    func testPasteFocusRegressionProbePasses() {
        let done = expectation(description: "probe")
        var result: [String: Any] = [:]
        MacComposerPasteFocusRegression.run { result = $0; done.fulfill() }
        wait(for: [done], timeout: 5)
        XCTAssertEqual(result["passed"] as? Bool, true, "\(result)")
    }
}
#endif
