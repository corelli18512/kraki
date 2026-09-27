// Kraki Lab Agent — stand-in for the embedded tentacle daemon.
//
// Modes:
//   daemon --tag T   long-running; heartbeat + TCC/keychain probes -> status-T.json
//   launch --tag T   exec `/usr/bin/open -W -n -a <own bundle> --args daemon --tag T`
//                    (a BundleProgram-compatible launcher that gives the daemon a
//                    LaunchServices identity, wherever the app bundle lives)
//   status           one-shot probes printed as JSON (run as a child of the app)
import Foundation
import Security
import Darwin

let args = CommandLine.arguments
let version = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "?"
let buildMarker = "kraki-lab-agent-build-\(LAB_VERSION)"
let home = NSHomeDirectory()
let labDir = home + "/Library/Application Support/KrakiLab"
try? FileManager.default.createDirectory(atPath: labDir, withIntermediateDirectories: true)

func arg(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}
let tag = arg("--tag") ?? "default"
let iso = ISO8601DateFormatter()

func log(_ s: String) {
    let line = "\(iso.string(from: Date())) [\(tag) v\(version) pid \(getpid())] \(s)\n"
    let path = labDir + "/agent-\(tag).log"
    if let h = FileHandle(forWritingAtPath: path) {
        h.seekToEndOfFile(); h.write(line.data(using: .utf8)!); try? h.close()
    } else {
        FileManager.default.createFile(atPath: path, contents: line.data(using: .utf8))
    }
}

func errnoText() -> String { String(cString: strerror(errno)) }

func probeRead(_ path: String) -> String {
    let fd = open(path, O_RDONLY)
    if fd >= 0 { close(fd); return "ok" }
    return "fail: \(errnoText())"
}

func probeList(_ path: String) -> String {
    guard let d = opendir(path) else { return "fail: \(errnoText())" }
    var n = 0
    while readdir(d) != nil { n += 1 }
    closedir(d)
    return "ok (\(n))"
}

/// Run an external executable with a timeout; a TCC consent prompt blocks the
/// child, which we report as "timeout" instead of hanging the daemon.
func runChild(_ exe: String, _ a: [String], timeout: Double) -> String {
    guard FileManager.default.isExecutableFile(atPath: exe) else { return "missing \(exe)" }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: exe)
    p.arguments = a
    let out = Pipe()
    p.standardOutput = out
    p.standardError = out
    do { try p.run() } catch { return "spawn failed: \(error)" }
    let deadline = Date().addingTimeInterval(timeout)
    while p.isRunning && Date() < deadline { usleep(100_000) }
    if p.isRunning { p.terminate(); return "timeout (likely TCC prompt)" }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    return (String(data: data, encoding: .utf8) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
}

let fdaTargets = ["Library/Safari", "Library/Mail", "Library/Application Support/com.apple.TCC/TCC.db"].map { home + "/" + $0 }
/// "granted" if any target is listable/readable, "denied" if any says EPERM, else "missing".
func fdaSelf() -> String {
    var parts: [String] = []
    for t in fdaTargets {
        var isDir: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: t, isDirectory: &isDir)
        parts.append((t as NSString).lastPathComponent + "=" + (isDir.boolValue ? probeList(t) : (exists ? probeRead(t) : "absent")))
    }
    return parts.joined(separator: " ")
}
let tccDB = home + "/Library/Safari"
let childExe = home + "/.labtools/child"

func keychainProbe() -> String {
    let base: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "chat.kraki.lab",
        kSecAttrAccount as String: "agent",
    ]
    var q = base
    q[kSecReturnData as String] = true
    var item: CFTypeRef?
    let s = SecItemCopyMatching(q as CFDictionary, &item)
    if s == errSecSuccess, let d = item as? Data {
        return "read ok (created by v\(String(data: d, encoding: .utf8) ?? "?"))"
    }
    if s == errSecItemNotFound {
        var add = base
        add[kSecValueData as String] = version.data(using: .utf8)!
        let a = SecItemAdd(add as CFDictionary, nil)
        return a == errSecSuccess ? "created by v\(version)" : "add failed \(a)"
    }
    return "read failed \(s)"
}

/// Keychain can present a blocking dialog; never let it stall the heartbeat.
func withTimeout(_ seconds: Double, _ body: @escaping () -> String) -> String {
    var result = "timeout (likely keychain prompt)"
    let sem = DispatchSemaphore(value: 0)
    DispatchQueue.global().async { let r = body(); result = r; sem.signal() }
    _ = sem.wait(timeout: .now() + seconds)
    return result
}

func probes(includeConsentProbes: Bool) -> [String: String] {
    var r: [String: String] = [
        "self_fda": fdaSelf(),
        "child_fda": runChild(childExe, ["list", tccDB], timeout: 5),
    ]
    if includeConsentProbes {
        // Desktop/Documents are consent-prompt services when FDA is absent.
        r["child_desktop"] = runChild(childExe, ["list", home + "/Desktop"], timeout: 15)
        r["child_documents"] = runChild(childExe, ["list", home + "/Documents"], timeout: 15)
        r["keychain"] = withTimeout(15, keychainProbe)
    }
    return r
}

func writeJSON(_ obj: [String: Any], _ path: String) {
    if let d = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]) {
        try? d.write(to: URL(fileURLWithPath: path), options: .atomic)
    }
}

let mode = args.count > 1 ? args[1] : "status"

switch mode {
case "launch":
    let bundle = Bundle.main.bundlePath
    log("launcher exec open -W -n -a \(bundle)")
    let argv = ["/usr/bin/open", "-W", "-n", "-a", bundle, "--args", "daemon", "--tag", tag]
    var cargs = argv.map { strdup($0) } + [nil]
    execv("/usr/bin/open", &cargs)
    log("execv failed: \(errnoText())")
    exit(1)

case "daemon":
    let started = Date()
    let exe = Bundle.main.executablePath ?? args[0]
    signal(SIGTERM, SIG_IGN)
    let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    term.setEventHandler { log("SIGTERM, exiting"); exit(0) }
    term.resume()
    log("daemon start exe=\(exe) ppid=\(getppid()) args=\(args)")
    var last: [String: String] = [:]
    var tick = 0
    Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in
        // Full probes at start and every minute; cheap FDA probes every tick.
        let p = probes(includeConsentProbes: tick % 12 == 0)
        for (k, v) in p { last[k] = v }
        if tick % 12 == 0 { log("probes \(last)") }
        tick += 1
        var st: [String: Any] = [
            "tag": tag, "version": version, "marker": buildMarker, "pid": Int(getpid()),
            "ppid": Int(getppid()), "exe": exe,
            "exeExists": FileManager.default.fileExists(atPath: exe),
            "bundlePath": Bundle.main.bundlePath,
            "startedAt": iso.string(from: started), "heartbeat": iso.string(from: Date()),
        ]
        for (k, v) in last { st[k] = v }
        writeJSON(st, labDir + "/status-\(tag).json")
    }.fire()
    RunLoop.main.run()

default: // status
    var st: [String: Any] = ["version": version, "pid": Int(getpid()), "ppid": Int(getppid()), "mode": "status"]
    for (k, v) in probes(includeConsentProbes: args.contains("--full")) { st[k] = v }
    let d = try! JSONSerialization.data(withJSONObject: st, options: [.prettyPrinted, .sortedKeys])
    print(String(data: d, encoding: .utf8)!)
}
