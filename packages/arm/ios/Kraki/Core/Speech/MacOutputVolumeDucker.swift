#if os(macOS)
/// Lowers the Mac's sound output while the user dictates, and puts it back.
///
/// Ported from VoiceType (its `OutputVolumeDucker`). macOS has no
/// `AVAudioSession.duckOthers`; the iOS client gets ducking from the system.
/// Here the default output device's master volume is set to
/// min(original, 20 %, original × 40 %) and restored when capture stops.
///
/// Safety, because a volume left low is very visible:
///   • Restore only if the device is still at exactly the level we set: a
///     change the user made meanwhile (or mute) is never overwritten.
///   • The original level is journaled to disk before the volume is lowered.
///     A watchdog child process (this executable, `--voice-volume-watchdog`)
///     restores it if Kraki dies mid-recording; the next launch also recovers
///     a journal whose owner is gone.
///   • Devices without a writable master volume, or muted ones, are skipped.
import AudioToolbox
import CoreAudio
import Foundation

struct OutputVolumeState: Codable, Equatable {
    let deviceID: UInt32
    let originalVolume: Double
    let duckedVolume: Double
    let ownerPID: Int32
    let token: String
    let startedAt: TimeInterval
}

/// The output device seam (Core Audio in the app, a fake in tests).
protocol OutputVolumeBackend {
    func defaultDevice() throws -> UInt32
    func supportsWritableVolume(_ device: UInt32) -> Bool
    func volume(_ device: UInt32) throws -> Float32
    func setVolume(_ device: UInt32, _ value: Float32) throws
    func isMuted(_ device: UInt32) -> Bool
}

enum OutputVolumeRecovery: Equatable { case restored, userChanged, retry }

enum OutputVolumeDucking {
    static let cap: Float32 = 0.20
    static let scale: Float32 = 0.40
    /// Smaller than this, lowering is not worth touching the device.
    static let minimumDrop: Float32 = 0.02
    /// "Still at the level we set" (devices quantize volume steps).
    static let tolerance: Float32 = 0.015
    /// Let the full-volume start cue play before lowering output.
    static let cueDelay: TimeInterval = 0.25
    /// Watchdog ceiling: give the volume back even if Kraki never says so.
    static let watchdogMaxSeconds: TimeInterval = 30 * 60
    static let watchdogArgument = "--voice-volume-watchdog"

    /// nil: don't touch the volume (already quiet enough).
    static func target(original: Float32) -> Float32? {
        let target = min(original, cap, original * scale)
        return original - target >= minimumDrop ? target : nil
    }

    /// Restore only if the device is still at the exact level Kraki applied.
    static func recover(_ state: OutputVolumeState, backend: OutputVolumeBackend,
                        journal: OutputVolumeJournal) -> OutputVolumeRecovery {
        let device = state.deviceID
        guard let current = try? backend.volume(device) else { return .retry }
        if backend.isMuted(device) || abs(current - Float32(state.duckedVolume)) > tolerance {
            journal.remove()
            return .userChanged
        }
        do {
            try backend.setVolume(device, Float32(state.originalVolume))
            journal.remove()
            return .restored
        } catch {
            return .retry
        }
    }
}

/// The on-disk record of a lowered volume (crash recovery).
struct OutputVolumeJournal {
    let url: URL

    static var live: OutputVolumeJournal {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let id = Bundle.main.bundleIdentifier ?? "chat.kraki.mac"
        return OutputVolumeJournal(url: base.appendingPathComponent("Kraki/voice-output-volume.\(id).json"))
    }

    func read() -> OutputVolumeState? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(OutputVolumeState.self, from: data)
    }

    func write(_ state: OutputVolumeState) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(state).write(to: url, options: .atomic)
    }

    func remove() { try? FileManager.default.removeItem(at: url) }
}

func outputVolumeOwnerIsAlive(_ pid: Int32) -> Bool {
    guard pid > 1 else { return false }
    return kill(pid, 0) == 0 || errno == EPERM
}

/// Starts the process that restores the volume if Kraki dies.
protocol OutputVolumeWatchdogLauncher {
    func launch(journal: URL, state: OutputVolumeState) throws -> () -> Void
}

struct ProcessOutputVolumeWatchdogLauncher: OutputVolumeWatchdogLauncher {
    func launch(journal: URL, state: OutputVolumeState) throws -> () -> Void {
        guard let executable = Bundle.main.executableURL else {
            throw NSError(domain: "Kraki.VoiceVolume", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "no executable for the watchdog"])
        }
        let process = Process()
        process.executableURL = executable
        process.arguments = [OutputVolumeDucking.watchdogArgument, journal.path, state.token,
                             String(state.ownerPID), String(Int(OutputVolumeDucking.watchdogMaxSeconds))]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        return { if process.isRunning { process.terminate() } }
    }
}

final class MacOutputVolumeDucker {
    static let shared = MacOutputVolumeDucker()

    private let backend: OutputVolumeBackend
    private let journal: OutputVolumeJournal
    private let watchdogLauncher: OutputVolumeWatchdogLauncher
    private let isEnabled: () -> Bool
    private let queue: DispatchQueue

    private var state: OutputVolumeState?
    private var stopWatchdog: (() -> Void)?
    private var pendingBegin: DispatchWorkItem?
    private var restoreRetry: DispatchWorkItem?

    init(backend: OutputVolumeBackend = CoreAudioOutputVolume(),
         journal: OutputVolumeJournal = .live,
         watchdogLauncher: OutputVolumeWatchdogLauncher = ProcessOutputVolumeWatchdogLauncher(),
         isEnabled: @escaping () -> Bool = { VoiceInputSettings.lowerOtherAudio },
         queue: DispatchQueue = DispatchQueue(label: "chat.kraki.voice.output-volume")) {
        self.backend = backend
        self.journal = journal
        self.watchdogLauncher = watchdogLauncher
        self.isEnabled = isEnabled
        self.queue = queue
    }

    /// Launch: a journal left by a Kraki that died mid-recording.
    func recoverAbandonedState() {
        queue.async { [self] in
            guard state == nil, let stale = journal.read(), !outputVolumeOwnerIsAlive(stale.ownerPID) else { return }
            let result = OutputVolumeDucking.recover(stale, backend: backend, journal: journal)
            KLog.diag("🎙️ [voice] output volume recovery after abnormal exit: \(result)")
        }
    }

    /// Recording starts: lower the volume after the start cue.
    func scheduleLowering(after delay: TimeInterval = OutputVolumeDucking.cueDelay) {
        queue.async { [self] in
            pendingBegin?.cancel()
            guard isEnabled(), state == nil else { return }
            let work = DispatchWorkItem { [weak self] in
                self?.pendingBegin = nil
                self?.lower()
            }
            pendingBegin = work
            queue.asyncAfter(deadline: .now() + delay, execute: work)
        }
    }

    /// Capture stopped (released, cancelled, failed, app quitting).
    func restore(reason: String) {
        queue.async { [self] in restoreNow(reason: reason) }
    }

    /// For app termination: returns after the attempt.
    func restoreSynchronously(reason: String) {
        queue.sync { restoreNow(reason: reason) }
    }

    /// Tests: wait for queued work.
    func drain() { queue.sync {} }
    var isLowered: Bool { queue.sync { state != nil } }

    private func lower() {
        pendingBegin = nil
        guard isEnabled(), state == nil else { return }
        restoreRetry?.cancel()
        restoreRetry = nil
        do {
            let device = try backend.defaultDevice()
            guard backend.supportsWritableVolume(device), !backend.isMuted(device) else {
                KLog.diag("🎙️ [voice] output volume left alone: no writable volume or muted")
                return
            }
            let original = try backend.volume(device)
            // A journal left by a Kraki that died (its recovery couldn't run
            // yet) holds the user's real level: never overwrite it with the
            // still-lowered one. Leave the volume alone until it is recovered.
            if let stale = journal.read(), stale.token != state?.token {
                KLog.diag("🎙️ [voice] output volume left alone: an unrecovered level is pending")
                if !outputVolumeOwnerIsAlive(stale.ownerPID) {
                    let result = OutputVolumeDucking.recover(stale, backend: backend, journal: journal)
                    KLog.diag("🎙️ [voice] pending output volume recovery: \(result)")
                }
                return
            }
            guard let target = OutputVolumeDucking.target(original: original) else { return }
            let newState = OutputVolumeState(
                deviceID: device, originalVolume: Double(original), duckedVolume: Double(target),
                ownerPID: ProcessInfo.processInfo.processIdentifier, token: UUID().uuidString,
                startedAt: Date().timeIntervalSince1970)
            try journal.write(newState)
            let stop: () -> Void
            do {
                stop = try watchdogLauncher.launch(journal: journal.url, state: newState)
            } catch {
                journal.remove()
                throw error
            }
            var applied = newState
            do {
                try backend.setVolume(device, target)
                let observed = try backend.volume(device)
                guard abs(observed - target) <= OutputVolumeDucking.tolerance else {
                    throw NSError(domain: "Kraki.VoiceVolume", code: 2,
                                  userInfo: [NSLocalizedDescriptionKey: "device rejected the volume"])
                }
                // Compare later against what the device actually holds
                // (quantized), so a one-step change by the user is noticed.
                if observed != target {
                    applied = OutputVolumeState(
                        deviceID: device, originalVolume: newState.originalVolume, duckedVolume: Double(observed),
                        ownerPID: newState.ownerPID, token: newState.token, startedAt: newState.startedAt)
                    try journal.write(applied)
                }
            } catch {
                // Put back whatever we may have changed before giving up.
                try? backend.setVolume(device, original)
                journal.remove()
                stop()
                throw error
            }
            state = applied
            stopWatchdog = stop
            KLog.diag(String(format: "🎙️ [voice] output volume %.0f%% → %.0f%%", original * 100, target * 100))
        } catch {
            KLog.diag("🎙️ [voice] output volume not lowered: \(error.localizedDescription)")
        }
    }

    private func restoreNow(reason: String) {
        pendingBegin?.cancel()
        pendingBegin = nil
        guard let current = state else { return }
        switch OutputVolumeDucking.recover(current, backend: backend, journal: journal) {
        case .restored, .userChanged:
            KLog.diag("🎙️ [voice] output volume released reason=\(reason)")
            finish()
        case .retry:
            scheduleRetry(current, attempt: 1)
        }
    }

    /// A device switch can briefly invalidate the device id: retry for 30 s,
    /// then leave it to the watchdog / next launch (keeping the journal, so a
    /// new recording can't overwrite the unrecovered original level).
    private func scheduleRetry(_ target: OutputVolumeState, attempt: Int) {
        restoreRetry?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.state?.token == target.token else { return }
            switch OutputVolumeDucking.recover(target, backend: self.backend, journal: self.journal) {
            case .restored, .userChanged: self.finish()
            case .retry where attempt < 120: self.scheduleRetry(target, attempt: attempt + 1)
            case .retry: self.restoreRetry = nil
            }
        }
        restoreRetry = work
        queue.asyncAfter(deadline: .now() + 0.25, execute: work)
    }

    private func finish() {
        restoreRetry?.cancel()
        restoreRetry = nil
        stopWatchdog?()
        stopWatchdog = nil
        state = nil
    }
}

/// `kraki-mac --voice-volume-watchdog <journal> <token> <ownerPID> <maxSeconds>`:
/// waits for the owner to exit (or the ceiling), then restores the volume.
enum OutputVolumeWatchdog {
    static func runIfRequested(_ arguments: [String] = CommandLine.arguments) {
        guard arguments.count >= 2, arguments[1] == OutputVolumeDucking.watchdogArgument else { return }
        // Malformed: exit, never fall through to launching the app.
        guard arguments.count >= 6, let owner = Int32(arguments[4]),
              let maxSeconds = TimeInterval(arguments[5]) else { exit(64) }
        let journal = OutputVolumeJournal(url: URL(fileURLWithPath: arguments[2]))
        let token = arguments[3]
        let backend = CoreAudioOutputVolume()
        let deadline = Date().addingTimeInterval(maxSeconds)
        while true {
            // Kraki restored the volume itself (journal gone or replaced).
            guard let state = journal.read(), state.token == token else { exit(0) }
            if !outputVolumeOwnerIsAlive(owner) || Date() >= deadline {
                for _ in 0..<120 {
                    switch OutputVolumeDucking.recover(state, backend: backend, journal: journal) {
                    case .restored, .userChanged: exit(0)
                    case .retry: Thread.sleep(forTimeInterval: 0.25)
                    }
                }
                exit(1) // next launch retries from the journal
            }
            Thread.sleep(forTimeInterval: 0.1)
        }
    }
}

struct CoreAudioOutputVolume: OutputVolumeBackend {
    func defaultDevice() throws -> UInt32 {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var device = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device)
        guard status == noErr, device != 0 else { throw Self.error(status, "default output") }
        return device
    }

    private static var volumeAddress: AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyVolumeScalar,
                                   mScope: kAudioDevicePropertyScopeOutput, mElement: kAudioObjectPropertyElementMain)
    }

    func supportsWritableVolume(_ device: UInt32) -> Bool {
        var address = Self.volumeAddress
        guard AudioObjectHasProperty(device, &address) else { return false }
        var settable = DarwinBoolean(false)
        return AudioObjectIsPropertySettable(device, &address, &settable) == noErr && settable.boolValue
    }

    func volume(_ device: UInt32) throws -> Float32 {
        var address = Self.volumeAddress
        var value: Float32 = 0
        var size = UInt32(MemoryLayout<Float32>.size)
        let status = AudioObjectGetPropertyData(device, &address, 0, nil, &size, &value)
        guard status == noErr else { throw Self.error(status, "read volume") }
        return value
    }

    func setVolume(_ device: UInt32, _ value: Float32) throws {
        var address = Self.volumeAddress
        var value = min(1, max(0, value))
        let status = AudioObjectSetPropertyData(device, &address, 0, nil, UInt32(MemoryLayout<Float32>.size), &value)
        guard status == noErr else { throw Self.error(status, "write volume") }
    }

    func isMuted(_ device: UInt32) -> Bool {
        var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyMute,
                                                 mScope: kAudioDevicePropertyScopeOutput,
                                                 mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectHasProperty(device, &address) else { return false }
        var muted: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &muted) == noErr else { return false }
        return muted != 0
    }

    private static func error(_ status: OSStatus, _ what: String) -> NSError {
        NSError(domain: NSOSStatusErrorDomain, code: Int(status),
                userInfo: [NSLocalizedDescriptionKey: "\(what) failed (OSStatus \(status))"])
    }
}
#endif
