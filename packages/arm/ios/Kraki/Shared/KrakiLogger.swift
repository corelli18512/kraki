/// KrakiLogger — Debug logging for the networking pipeline.
///
/// All output is gated behind `#if DEBUG` — compiles to nothing in release.
/// Use `KLog.d(...)` for debug messages.
///
/// Writes via three channels so logs are visible everywhere:
///   - `os_log` to the unified logging system (subsystem
///     `chat.kraki.ios`, category `debug`) — visible in Console.app
///     and `xcrun simctl spawn booted log stream`.
///   - `print` to stdout — visible when attached to Xcode debugger.
///   - `NSLog` to syslog — visible via `idevicesyslog` for real
///     devices connected via USB (os_log .debug entries are not
///     persisted to syslog relay).

import Foundation
import os.log

private let krakiOSLog = OSLog(subsystem: "chat.kraki.ios", category: "debug")

enum KLog {
    static func d(_ message: @autoclosure () -> String, file: String = #file, line: Int = #line) {
        #if DEBUG
        let filename = (file as NSString).lastPathComponent
        let line = "🦑 [\(filename):\(line)] \(message())"
        // Use .info instead of .debug — `.debug` from custom
        // subsystems is suppressed from the syslog relay by default
        // on iOS, so `idevicesyslog` on real devices wouldn't see
        // our messages. `.info` is persisted and forwarded.
        os_log("%{public}s", log: krakiOSLog, type: .info, line)
        print(line)
        NSLog("%@", line)
        #endif
    }
}
