/// Global hold-to-peek shortcut for the account usage panel.
///
/// Carbon `RegisterEventHotKey` delivers press and release without the
/// Accessibility / Input Monitoring permission a global key monitor needs.
/// Default F6; the user can record another one in Settings › General.

#if os(macOS)
import AppKit
import Carbon
import Combine
import SwiftUI

/// Keyboard: hidden → compact → (hover) detailed. Mouse: pinned detailed.
/// Hover can't keep a keyboard-only peek alive after its key is released.
struct UsagePeekState: Equatable {
    enum Presentation: Equatable { case hidden, compact, detailed }
    private(set) var held = false
    private(set) var pinned = false
    private(set) var hovering = false
    var isVisible: Bool { held || pinned }
    var presentation: Presentation {
        guard isVisible else { return .hidden }
        return pinned || hovering ? .detailed : .compact
    }
    mutating func press() { if !held { hovering = false }; held = true }
    mutating func release() { held = false; hovering = false }
    mutating func hover(_ inside: Bool) { guard held, !pinned else { return }; hovering = inside }
    mutating func click() { if pinned { dismiss() } else { pinned = true; hovering = false } }
    mutating func dismiss() { held = false; pinned = false; hovering = false }
}

struct UsageShortcut: Codable, Equatable {
    var keyCode: UInt32
    var modifiers: UInt32
    var keyName: String

    static let initial = UsageShortcut(keyCode: 97, modifiers: 0, keyName: "F6")
    static let functionNames: [UInt32: String] = [122: "F1", 120: "F2", 99: "F3", 118: "F4", 96: "F5", 97: "F6",
        98: "F7", 100: "F8", 101: "F9", 109: "F10", 103: "F11", 111: "F12", 105: "F13", 107: "F14", 113: "F15",
        106: "F16", 64: "F17", 79: "F18", 80: "F19", 90: "F20"]

    var display: String {
        var text = ""
        if modifiers & UInt32(controlKey) != 0 { text += "⌃" }
        if modifiers & UInt32(optionKey) != 0 { text += "⌥" }
        if modifiers & UInt32(shiftKey) != 0 { text += "⇧" }
        if modifiers & UInt32(cmdKey) != 0 { text += "⌘" }
        return text + (Self.functionNames[keyCode] ?? keyName)
    }

    /// Function keys, or a combination with ⌘/⌃/⌥ — never a plain typing key.
    var isSafeToRegister: Bool {
        let allowed = UInt32(cmdKey | shiftKey | optionKey | controlKey)
        guard keyCode != 53, !keyName.isEmpty, modifiers & ~allowed == 0 else { return false }
        return Self.functionNames[keyCode] != nil || modifiers & UInt32(cmdKey | optionKey | controlKey) != 0
    }
}

final class UsagePeekHotKey: ObservableObject {
    @Published private(set) var shortcut: UsageShortcut
    @Published private(set) var error: String?
    @Published private(set) var recording = false
    /// Off by default: a global F6 must not be taken from users who didn't ask for it.
    @Published private(set) var enabled: Bool
    var onPress: (() -> Void)?
    var onRelease: (() -> Void)?
    var onRecording: (() -> Void)?
    private var reference: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private let defaults: UserDefaults
    private static let defaultsKey = "mac.usagePeekShortcut"
    private static let enabledKey = "mac.usagePeekShortcutEnabled"
    private static let signature: OSType = 0x4B555347 // 'KUSG'

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let data = defaults.data(forKey: Self.defaultsKey),
           let stored = try? JSONDecoder().decode(UsageShortcut.self, from: data), stored.isSafeToRegister {
            shortcut = stored
        } else {
            shortcut = .initial
        }
        enabled = defaults.bool(forKey: Self.enabledKey)
    }

    func setEnabled(_ on: Bool) {
        guard on != enabled else { return }
        enabled = on
        defaults.set(on, forKey: Self.enabledKey)
        if on { error = nil; registerSaved() }
        else { unregister(); error = nil }
    }

    private func unregister() {
        if let reference { UnregisterEventHotKey(reference); self.reference = nil }
    }

    /// Installs the Carbon handler and registers the saved shortcut.
    func start() {
        guard handler == nil else { return }
        var eventTypes = [EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
                          EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased))]
        let status = InstallEventHandler(GetApplicationEventTarget(), { _, event, context in
            guard let event, let context else { return OSStatus(eventNotHandledErr) }
            var id = EventHotKeyID()
            let code = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                                         nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
            guard code == noErr, id.signature == UsagePeekHotKey.signature else { return OSStatus(eventNotHandledErr) }
            let owner = Unmanaged<UsagePeekHotKey>.fromOpaque(context).takeUnretainedValue()
            let kind = GetEventKind(event)
            DispatchQueue.main.async {
                guard !owner.recording else { return }
                if kind == UInt32(kEventHotKeyPressed) { owner.onPress?() }
                else if kind == UInt32(kEventHotKeyReleased) { owner.onRelease?() }
            }
            return noErr
        }, eventTypes.count, &eventTypes, Unmanaged.passUnretained(self).toOpaque(), &handler)
        if status != noErr { error = "Couldn't install the global shortcut handler (\(status))." }
        else { registerSaved() }
        KLog.diag("[UsagePeek] hotkey \(shortcut.display) enabled=\(enabled) handler=\(status) registered=\(reference != nil)")
    }

    deinit {
        if let reference { UnregisterEventHotKey(reference) }
        if let handler { RemoveEventHandler(handler) }
    }

    private func register(_ spec: UsageShortcut, output: inout EventHotKeyRef?) -> OSStatus {
        RegisterEventHotKey(spec.keyCode, spec.modifiers, EventHotKeyID(signature: Self.signature, id: 1),
                            GetApplicationEventTarget(), 0, &output)
    }

    private func registerSaved() {
        guard enabled, reference == nil, handler != nil else { return }
        let status = register(shortcut, output: &reference)
        if status != noErr { error = "\(shortcut.display) is already in use (\(status)). Choose another shortcut." }
    }

    func beginRecording() {
        guard !recording else { return }
        if let reference { UnregisterEventHotKey(reference); self.reference = nil }
        recording = true
        error = nil
        onRecording?()
    }

    func cancelRecording() {
        guard recording else { return }
        recording = false
        registerSaved()
    }

    @discardableResult
    func update(_ spec: UsageShortcut) -> Bool {
        guard spec.isSafeToRegister else {
            error = "Use F1–F20, or a combination with ⌘, ⌃ or ⌥."
            return false
        }
        let wasRecording = recording
        if !wasRecording { beginRecording() }
        guard enabled else {
            // Not active: just remember the choice for when it is turned on.
            shortcut = spec
            recording = false
            error = nil
            if let data = try? JSONEncoder().encode(spec) { defaults.set(data, forKey: Self.defaultsKey) }
            return true
        }
        var candidate: EventHotKeyRef?
        let status = register(spec, output: &candidate)
        guard status == noErr else {
            error = "\(spec.display) can't be used (\(status)); the previous shortcut is kept."
            if !wasRecording { recording = false; registerSaved() }
            return false
        }
        reference = candidate
        shortcut = spec
        recording = false
        error = nil
        if let data = try? JSONEncoder().encode(spec) { defaults.set(data, forKey: Self.defaultsKey) }
        return true
    }
}

private final class UsageShortcutRecorderButton: NSButton {
    var manager: UsagePeekHotKey?
    var isCapturing = false
    override var acceptsFirstResponder: Bool { true }
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        target = self
        action = #selector(startCapture)
    }
    required init?(coder: NSCoder) {
        super.init(coder: coder)
        target = self
        action = #selector(startCapture)
    }
    @objc private func startCapture() {
        manager?.beginRecording()
        isCapturing = true
        title = "Press a shortcut… (Esc to cancel)"
        window?.makeFirstResponder(self)
    }
    override func keyDown(with event: NSEvent) {
        guard isCapturing, let manager else { super.keyDown(with: event); return }
        if event.keyCode == 53 { finish(cancel: true); return }
        guard !event.isARepeat else { return }
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        var carbon: UInt32 = 0
        if flags.contains(.command) { carbon |= UInt32(cmdKey) }
        if flags.contains(.control) { carbon |= UInt32(controlKey) }
        if flags.contains(.option) { carbon |= UInt32(optionKey) }
        if flags.contains(.shift) { carbon |= UInt32(shiftKey) }
        let keyCode = UInt32(event.keyCode)
        let name = UsageShortcut.functionNames[keyCode] ?? event.charactersIgnoringModifiers?.uppercased() ?? ""
        if manager.update(UsageShortcut(keyCode: keyCode, modifiers: carbon, keyName: name)) { finish(cancel: false) }
    }
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard isCapturing else { return super.performKeyEquivalent(with: event) }
        keyDown(with: event)
        return true
    }
    override func resignFirstResponder() -> Bool {
        if isCapturing { finish(cancel: true) }
        return super.resignFirstResponder()
    }
    private func finish(cancel: Bool) {
        isCapturing = false
        if cancel { manager?.cancelRecording() }
        title = manager?.shortcut.display ?? "F6"
    }
}

struct UsageShortcutRecorder: NSViewRepresentable {
    @ObservedObject var manager: UsagePeekHotKey
    func makeNSView(context: Context) -> NSButton {
        let button = UsageShortcutRecorderButton(frame: .zero)
        button.manager = manager
        button.bezelStyle = .rounded
        button.font = .monospacedSystemFont(ofSize: 13, weight: .medium)
        button.setAccessibilityLabel("Change the account usage shortcut")
        return button
    }
    func updateNSView(_ nsView: NSButton, context: Context) {
        nsView.title = manager.recording ? "Press a shortcut… (Esc to cancel)" : manager.shortcut.display
    }
    static func dismantleNSView(_ nsView: NSButton, coordinator: ()) {
        (nsView as? UsageShortcutRecorderButton)?.manager?.cancelRecording()
    }
}
#endif
