/// KrakiLogger — Debug logging for the networking pipeline.
///
/// All output is gated behind `#if DEBUG` — compiles to nothing in release.
/// Use `KLog.d(...)` for debug messages.
///
/// Writes via `print` only. Xcode's console captures stdout, so the
/// developer sees every log line while attached. For non-Xcode debugging
/// (Console.app on another Mac, `idevicesyslog`, etc.), set the
/// `KRAKI_LOG_OS_LOG=1` env var to mirror to `os_log` / `NSLog`. We
/// don't mirror by default because (a) Xcode is the normal debug surface
/// and shows duplicate lines for all three channels, and (b) during
/// agent-reply streaming the per-message log volume × three channels
/// dominates CPU.

import Foundation
import os.log

private let krakiOSLog = OSLog(subsystem: "chat.kraki.ios", category: "debug")
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
        let filename = (file as NSString).lastPathComponent
        let line = "🦑 [\(filename):\(line)] \(message())"
        print(line)
        if mirrorToOSLog {
            os_log("%{public}s", log: krakiOSLog, type: .info, line)
            NSLog("%@", line)
        }
        #endif
    }
}
