import XCTest
import AppKit
import SwiftUI
@testable import Kraki_Dev

/// The hover text of the Mac's icon-only controls: every shape of the primary
/// button names its action, and a greyed-out control says why.
final class MacControlHelpTests: XCTestCase {
    func testPrimaryButtonNamesEachShape() {
        func help(_ a: MacControlHelp.Primary, canSend: Bool = true, reachable: Bool = true) -> String {
            MacControlHelp.primary(a, canSend: canSend, deviceReachable: reachable, deviceName: "Studio")
        }
        XCTAssertEqual(help(.send), "Send (Return)")
        XCTAssertEqual(help(.steer), "Steer: add this to the reply in progress (Return)")
        XCTAssertEqual(help(.answer), "Submit answer (Return)")
        XCTAssertEqual(help(.deny), "Deny with this reason (Return)")
        XCTAssertEqual(help(.stop(stopping: false)), "Stop the agent")
        XCTAssertEqual(help(.voiceSend), "Send what you said")
        XCTAssertEqual(help(.voiceAnswer), "Answer with what you said")
        XCTAssertEqual(help(.voiceEdit), "Stop and edit the text")
    }

    func testGreyedPrimaryButtonSaysWhy() {
        XCTAssertEqual(MacControlHelp.primary(.send, canSend: false, deviceReachable: true, deviceName: nil),
                       "Type a message")
        XCTAssertEqual(MacControlHelp.primary(.answer, canSend: false, deviceReachable: true, deviceName: nil),
                       "Type an answer")
        XCTAssertEqual(MacControlHelp.primary(.stop(stopping: true), canSend: false, deviceReachable: true,
                                              deviceName: "Studio"), "Stopping…")
        XCTAssertEqual(MacControlHelp.primary(.stop(stopping: false), canSend: false, deviceReachable: false,
                                              deviceName: "Studio"), "Studio is offline")
    }

    func testPrimaryShapeFollowsComposerState() {
        let of = { (voice: Bool, perm: Bool, q: Bool, stop: Bool, intent: MacComposerIntent) in
            MacControlHelp.Primary.of(voice: voice, permission: perm, question: q, stop: stop, stopping: false, intent: intent)
        }
        XCTAssertEqual(of(true, true, false, false, .denyPermission), .voiceEdit)
        XCTAssertEqual(of(true, false, true, false, .answerQuestion), .voiceAnswer)
        XCTAssertEqual(of(true, false, false, true, .prompt), .voiceSend, "voice wins over stop")
        XCTAssertEqual(of(false, false, false, true, .steer), .stop(stopping: false))
        XCTAssertEqual(of(false, false, false, false, .steer), .steer)
        XCTAssertEqual(MacControlHelp.accessibilityLabel(.send), "Send message")
        XCTAssertEqual(MacControlHelp.accessibilityLabel(.answer), "Submit answer")
    }

    func testImageBlockReasonFollowsComposerState() {
        XCTAssertEqual(MacControlHelp.AttachBlock.of(voice: true, canAttach: true, answering: false, agent: nil), .voice)
        XCTAssertNil(MacControlHelp.AttachBlock.of(voice: false, canAttach: true, answering: true, agent: "pi"))
        XCTAssertEqual(MacControlHelp.AttachBlock.of(voice: false, canAttach: false, answering: false, agent: "pi"), .agentBusy)
        XCTAssertEqual(MacControlHelp.AttachBlock.of(voice: false, canAttach: false, answering: true, agent: "codex"),
                       .answerTakesNoImage(agent: AgentInfo.from("codex").label))
    }

    func testImageButtonSaysWhyItIsGreyed() {
        XCTAssertEqual(MacControlHelp.attachImage(blocked: nil, hasImage: false), "Attach image (or paste or drop one)")
        XCTAssertEqual(MacControlHelp.attachImage(blocked: nil, hasImage: true), "Replace image")
        XCTAssertEqual(MacControlHelp.attachImage(blocked: .voice, hasImage: false), "Finish voice input first")
        XCTAssertEqual(MacControlHelp.attachImage(blocked: .agentBusy, hasImage: false),
                       "You can add an image when the agent is idle")
        XCTAssertEqual(MacControlHelp.attachImage(blocked: .answerTakesNoImage(agent: "Codex"), hasImage: false),
                       "Codex can't take an image in an answer")
    }

    func testVoiceButtonShowsTheShortcutTheKeyProbeUses() {
        XCTAssertEqual(MacControlHelp.voice(available: true, busy: false), "Dictate (⌥Space)")
        XCTAssertEqual(MacComposerVoiceKeyProbeView.action(keyCode: 49, flags: .option, isRepeat: false, voiceActive: false),
                       .toggle, "⌥Space in the tooltip must be the key that starts dictation")
        XCTAssertEqual(MacControlHelp.voice(available: false, busy: false), "Voice input isn't available")
        XCTAssertEqual(MacControlHelp.voice(available: true, busy: true), "Finishing the last recording…")
    }

    func testEveryModeHasItsOwnExplanation() {
        let texts = SessionMode.allCases.map(MacControlHelp.mode)
        XCTAssertEqual(Set(texts).count, SessionMode.allCases.count)
        for (mode, text) in zip(SessionMode.allCases, texts) {
            XCTAssertTrue(text.hasPrefix(mode.rawValue.capitalized + ":"), text)
        }
    }
}

/// `controlHelp` reaches the button itself (VoiceOver reads it as help) even
/// when the button is disabled, and an outer help replaces an inner one,
/// which is why the image slot puts it on each button.
@MainActor
final class MacControlHelpAccessibilityTests: XCTestCase {
    private func buttonHelp<V: View>(_ view: V) -> (help: String?, enabled: Bool)? {
        let host = NSHostingView(rootView: view.frame(width: 100, height: 100))
        host.frame = NSRect(x: 0, y: 0, width: 100, height: 100)
        let window = NSWindow(contentRect: host.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.2))
        func find(_ element: Any) -> (help: String?, enabled: Bool)? {
            let el = element as AnyObject
            if el.accessibilityRole?() == .button {
                return (el.accessibilityHelp?() ?? nil, el.isAccessibilityEnabled?() ?? true)
            }
            return (el.accessibilityChildren?() ?? nil ?? []).lazy.compactMap(find).first
        }
        return find(host)
    }

    func testDisabledButtonKeepsItsHelp() throws {
        let result = try XCTUnwrap(buttonHelp(Button("X") {}.disabled(true).controlHelp("Why")))
        XCTAssertEqual(result.help, "Why")
        XCTAssertFalse(result.enabled)
    }

    func testOuterHelpReplacesInner() throws {
        let result = try XCTUnwrap(buttonHelp(Button("X") {}.help("Inner").controlHelp("Outer")))
        XCTAssertEqual(result.help, "Outer")
    }
}
