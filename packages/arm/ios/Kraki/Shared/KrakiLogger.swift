/// KrakiLogger — Debug logging for the networking pipeline.
///
/// All output is gated behind `#if DEBUG` — compiles to nothing in release.
/// Use `KLog.d(...)` for debug messages.
///
/// **Default: silent.** Even in DEBUG builds, KLog.d is a no-op unless
/// the `KRAKI_LOG=1` env var is set (Xcode scheme → Run → Arguments →
/// Environment Variables). This is because the codebase emits per-frame
/// log lines during agent-reply streaming and 28-device-fanout
/// broadcasts — leaving them on burns the CPU on the device, especially
/// with the 3-channel writer (`print` + `os_log` + `NSLog`).
///
/// Set `KRAKI_LOG=1` for normal verbose logs (print only).
/// Set `KRAKI_LOG_OS_LOG=1` to additionally mirror to `os_log` + `NSLog`
/// for Console.app / idevicesyslog workflows.

import Foundation
import os.log

private let krakiOSLog = OSLog(subsystem: "chat.kraki.ios", category: "debug")
private let logEnabled: Bool = {
    #if DEBUG
    return ProcessInfo.processInfo.environment["KRAKI_LOG"] == "1"
    #else
    return false
    #endif
}()
private let mirrorToOSLog: Bool = {
    #if DEBUG
    return ProcessInfo.processInfo.environment["KRAKI_LOG_OS_LOG"] == "1"
    #else
    return false
    #endif
}()

enum KLog {
    static func d(_ message: @autoclosure () -> String, file: String = #file, line: Int = #line) {
        #if DEBUG
        guard logEnabled || mirrorToOSLog else { return }
        let filename = (file as NSString).lastPathComponent
        let line = "🦑 [\(filename):\(line)] \(message())"
        if logEnabled {
            print(line)
        }
        if mirrorToOSLog {
            os_log("%{public}s", log: krakiOSLog, type: .default, line)
        }
        #endif
    }

    /// Release-safe diagnostic log. Unlike `KLog.d`, this always
    /// emits via `os_log` (subsystem `chat.kraki.ios`, category
    /// `debug`) AND `NSLog`, regardless of build configuration or
    /// the `KRAKI_LOG` env var. Reserved for narrow, low-frequency
    /// flows we need to debug on production builds running on a
    /// physical device.
    ///
    /// View on a Mac with Xcode + cable attached:
    ///   - Console.app → select the device → filter
    ///     "Subsystem: chat.kraki.ios" or just search for "🩺".
    /// Or via `xcrun devicectl` / `idevicesyslog` if Xcode isn't
    /// installed.
    static func diag(_ message: @autoclosure () -> String, file: String = #file, line: Int = #line) {
        let filename = (file as NSString).lastPathComponent
        let line = "🩺 [\(filename):\(line)] \(message())"
        // .default (not .info) so it's forwarded through syslog
        // relay (idevicesyslog / pymobiledevice3 syslog live).
        // .info would only land in the in-memory ring buffer and
        // be invisible to off-device tooling.
        os_log("%{public}s", log: krakiOSLog, type: .default, line)
    }

    /// Always-on chat data-flow log. Same delivery as `diag` (NSLog
    /// + os_log), prefixed with 🪢 so the chat data-fetch flow is
    /// easy to grep for amid Apple's own console noise. Used to
    /// surface:
    ///   • Chat tab arrivals (session_list)
    ///   • Session open (DB load + remote head fetch decisions)
    ///   • History batch arrivals (session_messages_batch /
    ///     session_replay_batch)
    ///   • Older-pagination paths (DB-satisfied vs WS-requested)
    static func chat(_ message: @autoclosure () -> String, file: String = #file, line: Int = #line) {
        let filename = (file as NSString).lastPathComponent
        let line = "🪢 [\(filename):\(line)] \(message())"
        // .default (not .info) so syslog relay forwards it to
        // idevicesyslog / pymobiledevice3 / Console.app. `%{public}s`
        // prevents redaction. NSLog dropped — NSLog routes through
        // os_log with `%@` which marks the argument private, so the
        // content shows up as `<private>` in the syslog stream.
        os_log("%{public}s", log: krakiOSLog, type: .default, line)
    }
}
