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
            os_log("%{public}s", log: krakiOSLog, type: .info, line)
            NSLog("%@", line)
        }
        #endif
    }
}
