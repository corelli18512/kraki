// Kraki Lab — stand-in for Kraki.app owning an embedded background daemon.
//
// Actions (repeatable):  open -a "Kraki Lab" --args --action install-plist --quit
//   install-plist / uninstall-plist         A: ~/Library/LaunchAgents plist, open -W -n -a <helper>
//   sm-register:<name> / sm-unregister:<name> / sm-status
//        names: direct   (BundleProgram = helper exe, direct execve)
//               launcher (BundleProgram = helper exe in `launch` mode -> open -W -n -a)
//               openb    (ProgramArguments = /usr/bin/open -W -n -b chat.kraki.lab.agent)
//   spawn-status   run the helper executable as a child of this app (attribution test)
//   open-fda / reveal-helper
// Every action appends a JSON line to ~/Library/Application Support/KrakiLab/app-actions.jsonl
import AppKit
import ServiceManagement

let labDir = NSHomeDirectory() + "/Library/Application Support/KrakiLab"
try? FileManager.default.createDirectory(atPath: labDir, withIntermediateDirectories: true)
let appVersion = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "?"
let helperURL = Bundle.main.bundleURL.appendingPathComponent("Contents/Library/Helpers/Kraki Lab Agent.app")
let helperExe = helperURL.appendingPathComponent("Contents/MacOS/kraki-lab-agent").path
let plistLabel = "chat.kraki.lab.agent"
let plistPath = NSHomeDirectory() + "/Library/LaunchAgents/\(plistLabel).plist"
let uid = getuid()

func record(_ action: String, _ result: [String: Any]) {
    var r = result
    r["action"] = action
    r["appVersion"] = appVersion
    r["appPath"] = Bundle.main.bundlePath
    r["at"] = ISO8601DateFormatter().string(from: Date())
    guard let d = try? JSONSerialization.data(withJSONObject: r, options: [.sortedKeys]) else { return }
    let path = labDir + "/app-actions.jsonl"
    let line = d + "\n".data(using: .utf8)!
    if let h = FileHandle(forWritingAtPath: path) { h.seekToEndOfFile(); h.write(line); try? h.close() }
    else { FileManager.default.createFile(atPath: path, contents: line) }
}

@discardableResult
func run(_ exe: String, _ a: [String]) -> (Int32, String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: exe)
    p.arguments = a
    let out = Pipe()
    p.standardOutput = out; p.standardError = out
    do { try p.run() } catch { return (-1, "\(error)") }
    p.waitUntilExit()
    let s = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    return (p.terminationStatus, s.trimmingCharacters(in: .whitespacesAndNewlines))
}

func smService(_ name: String) -> SMAppService {
    SMAppService.agent(plistName: "chat.kraki.lab.sm-\(name).plist")
}

func statusName(_ s: SMAppService.Status) -> String {
    switch s {
    case .notRegistered: return "notRegistered"
    case .enabled: return "enabled"
    case .requiresApproval: return "requiresApproval"
    case .notFound: return "notFound"
    @unknown default: return "unknown(\(s.rawValue))"
    }
}

func performLabAction(_ action: String) {
    switch action {
    case "install-plist":
        let plist: [String: Any] = [
            "Label": plistLabel,
            "ProgramArguments": ["/usr/bin/open", "-W", "-n", "-a", helperURL.path, "--args", "daemon", "--tag", "plist"],
            "RunAtLoad": true,
            "KeepAlive": true,
            "ThrottleInterval": 10,
            "AssociatedBundleIdentifiers": ["chat.kraki.lab.app"],
            "StandardOutPath": labDir + "/plist-open.log",
            "StandardErrorPath": labDir + "/plist-open.log",
        ]
        let data = try! PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        let existing = FileManager.default.contents(atPath: plistPath)
        let unchanged = existing == data
        var out: [String: Any] = ["unchanged": unchanged]
        if !unchanged {
            try? FileManager.default.createDirectory(atPath: NSHomeDirectory() + "/Library/LaunchAgents", withIntermediateDirectories: true)
            try! data.write(to: URL(fileURLWithPath: plistPath))
            out["bootout"] = run("/bin/launchctl", ["bootout", "gui/\(uid)/\(plistLabel)"]).1
            let b = run("/bin/launchctl", ["bootstrap", "gui/\(uid)", plistPath])
            out["bootstrap"] = "\(b.0) \(b.1)"
        } else {
            // Loaded already? Otherwise bootstrap without rewriting the file.
            let p = run("/bin/launchctl", ["print", "gui/\(uid)/\(plistLabel)"])
            if p.0 != 0 { out["bootstrap"] = run("/bin/launchctl", ["bootstrap", "gui/\(uid)", plistPath]).1 }
        }
        record(action, out)
    case "uninstall-plist":
        let b = run("/bin/launchctl", ["bootout", "gui/\(uid)/\(plistLabel)"])
        try? FileManager.default.removeItem(atPath: plistPath)
        record(action, ["bootout": "\(b.0) \(b.1)"])
    case "sm-status":
        var r: [String: Any] = [:]
        for n in ["direct", "launcher", "openb"] { r[n] = statusName(smService(n).status) }
        record(action, r)
    case "spawn-status":
        let r = run(helperExe, ["status", "--full"])
        record(action, ["exit": r.0, "output": r.1])
    case "open-fda":
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")!)
        record(action, [:])
    case "reveal-helper":
        NSWorkspace.shared.activateFileViewerSelecting([helperURL])
        record(action, [:])
    default:
        if action.hasPrefix("sm-register:") || action.hasPrefix("sm-unregister:") {
            let name = String(action.split(separator: ":")[1])
            let svc = smService(name)
            var r: [String: Any] = [:]
            do {
                if action.hasPrefix("sm-register:") { try svc.register() } else { try svc.unregister() }
                r["ok"] = true
            } catch {
                r["ok"] = false
                r["error"] = "\(error)"
            }
            r["status"] = statusName(svc.status)
            record(action, r)
        } else {
            record(action, ["error": "unknown action"])
        }
    }
}

// ─── Minimal UI: status + draggable helper icon ───────────────────────────

final class DraggableIcon: NSImageView, NSDraggingSource {
    func draggingSession(_ s: NSDraggingSession, sourceOperationMaskFor c: NSDraggingContext) -> NSDragOperation { .copy }
    override func mouseDown(with event: NSEvent) {
        let item = NSDraggingItem(pasteboardWriter: helperURL as NSURL)
        item.setDraggingFrame(bounds, contents: image)
        beginDraggingSession(with: [item], event: event, source: self)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    let text = NSTextField(wrappingLabelWithString: "")
    func applicationDidFinishLaunching(_ n: Notification) {
        let a = CommandLine.arguments
        var i = 0
        while i < a.count {
            if a[i] == "--action", i + 1 < a.count { performLabAction(a[i + 1]); i += 1 }
            i += 1
        }
        if a.contains("--quit") { NSApp.terminate(nil); return }

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: 420),
                          styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Kraki Lab v\(appVersion)"
        let icon = DraggableIcon(frame: NSRect(x: 20, y: 290, width: 96, height: 96))
        icon.image = NSWorkspace.shared.icon(forFile: helperURL.path)
        let hint = NSTextField(labelWithString: "Drag “Kraki Lab Agent” into Full Disk Access")
        hint.frame = NSRect(x: 130, y: 330, width: 480, height: 20)
        var y: CGFloat = 250
        let v = window.contentView!
        for (title, action) in [("Install daemon (plist)", "install-plist"), ("Open Full Disk Access", "open-fda"),
                                ("Reveal helper in Finder", "reveal-helper"), ("Run helper as child", "spawn-status")] {
            let b = NSButton(title: title, target: self, action: #selector(click(_:)))
            b.identifier = NSUserInterfaceItemIdentifier(action)
            b.frame = NSRect(x: 20, y: y, width: 220, height: 28)
            v.addSubview(b)
            y -= 34
        }
        text.frame = NSRect(x: 260, y: 20, width: 360, height: 270)
        text.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        for sub in [icon, hint, text] as [NSView] { v.addSubview(sub) }
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.refresh() }.fire()
    }
    @objc func click(_ b: NSButton) { performLabAction(b.identifier!.rawValue); refresh() }
    func refresh() {
        var s = "app \(Bundle.main.bundlePath)\n"
        if Bundle.main.bundlePath.contains("/AppTranslocation/") { s += "⚠️ TRANSLOCATED\n" }
        for tag in ["plist", "sm-direct", "sm-launcher", "sm-openb"] {
            guard let d = FileManager.default.contents(atPath: labDir + "/status-\(tag).json"),
                  let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { continue }
            s += "\n[\(tag)] v\(j["version"] ?? "?") pid \(j["pid"] ?? "?") hb \(j["heartbeat"] ?? "?")\n"
            s += "  fda self=\(j["self_fda"] ?? "?")\n  child=\(j["child_fda"] ?? "?")\n"
        }
        text.stringValue = s
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
