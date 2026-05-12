/// KrakiLogger — Debug logging for the networking pipeline.
///
/// All output is gated behind `#if DEBUG` — compiles to nothing in release.
/// Use `KLog.d(...)` for debug messages.
///
/// Writes via `os_log` to the unified logging system (subsystem
/// `cloud.corelli.kraki`, category `debug`) AND mirrors to stdout so that
/// either `xcrun simctl spawn booted log stream` or `--console-pty` works.

import Foundation
import os.log

private let krakiOSLog = OSLog(subsystem: "cloud.corelli.kraki", category: "debug")

enum KLog {
    static func d(_ message: @autoclosure () -> String, file: String = #file, line: Int = #line) {
        #if DEBUG
        let filename = (file as NSString).lastPathComponent
        let line = "🦑 [\(filename):\(line)] \(message())"
        os_log("%{public}s", log: krakiOSLog, type: .debug, line)
        print(line)
        #endif
    }
}
