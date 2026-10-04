import XCTest
import SwiftUI
import AppKit
@testable import Kraki_Dev

/// Tables in the real chat view and the table window.
@MainActor final class TableRenderShots: XCTestCase {
    /// Renders sample tables for visual review (no pixel assertions).
    static let shotsDir: URL = {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("kraki-table-shots", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()
    static let sample = #"""
三种方案的对比如下：

| 方案 | 优点 | 风险 | 预计工作量 |
|:---|:---|:---|---:|
| **A 客户端改顺序** | 不改协议，对所有版本的 `Tentacle` 都有效 | 依赖客户端规则，回包仍可能丢 | 2 天 |
| **B Tentacle 补齐** | 结构上保证顺序，走可靠的流 | 要改协议、做版本判断和降级 | 5 天 |
| C 不改 | 无 | 用户继续看到旧内容，体验差 | 0 |

测试结果：

| Platform | Tests | Skipped | Failures | Duration |
|---|---:|---:|---:|---:|
| iOS | 551 | 6 | 0 | 153.3s |
| Mac | 199 | 49 | 0 | 219.6s |
| Web | 353 | 0 | 0 | 5.7s |
| Tentacle | 1120 | 0 | 0 | 20.9s |
| Head | 412 | 2 | 0 | 11.0s |
| Chaos E2E | 10 | 0 | 0 | 6m 40s |

修改的文件：

| File | Change |
|---|---|
| `packages/arm/ios/Kraki/Core/Storage/MessageProvider.swift` | head request retries (5 s timeout × 4) |
| `packages/arm/ios/Kraki/Features/Chat/ChatPerfListView.swift` | bottom spinner only for local newer pages |


Links and code in cells:

| Item | Where | Notes |
|---|---|---|
| Docs | [Kraki docs](https://kraki.chat/docs) | see https://kraki.chat/install. |
| Shell | `a \| b` | pipe inside code stays in one cell |

过去 7 天各接口的调用情况：

| Endpoint | Region | Method | Calls | p50 | p95 | p99 | Errors | Err % | Bytes in | Bytes out | Cache hit | Owner | Since |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| `/api/session/list` | tokyo | GET | 43,245 | 27 ms | 88 ms | 209 ms | 202 | 0.47% | 75 MB | 3364 MB | 74% | head | 2026-08-28 |
| `/api/session/messages` | tokyo | GET | 8,402 | 72 ms | 223 ms | 524 ms | 109 | 1.30% | 89 MB | 1777 MB | 66% | head | 2026-07-12 |
| `/api/push/register` | tokyo | GET | 73,026 | 62 ms | 193 ms | 454 ms | 30 | 0.04% | 229 MB | 2584 MB | 80% | web | 2026-06-28 |
| `/api/voice/lease` | tokyo | GET | 77,548 | 58 ms | 181 ms | 426 ms | 25 | 0.03% | 48 MB | 2281 MB | 94% | head | 2026-08-23 |
| `/api/attachment` | tokyo | POST | 19,707 | 77 ms | 238 ms | 559 ms | 60 | 0.30% | 574 MB | 3343 MB | 83% | head | 2026-06-28 |
| `/api/auth/oauth` | tokyo | POST | 75,668 | 89 ms | 274 ms | 643 ms | 96 | 0.13% | 100 MB | 2244 MB | 85% | head | 2026-06-16 |
| `/api/diag/v1/batch` | tokyo | POST | 65,866 | 76 ms | 235 ms | 552 ms | 218 | 0.33% | 477 MB | 2399 MB | 99% | tentacle | 2026-08-19 |
| `/api/device/pair` | tokyo | GET | 33,361 | 31 ms | 100 ms | 237 ms | 357 | 1.07% | 84 MB | 2353 MB | 59% | web | 2026-09-20 |
| `/api/usage/history` | tokyo | GET | 96,409 | 65 ms | 202 ms | 475 ms | 147 | 0.15% | 121 MB | 2097 MB | 66% | head | 2026-08-14 |
| `/api/session/fork` | tokyo | GET | 64,889 | 61 ms | 190 ms | 447 ms | 20 | 0.03% | 783 MB | 2286 MB | 76% | tentacle | 2026-08-21 |
| `/api/session/list` | shanghai | POST | 78,705 | 71 ms | 220 ms | 517 ms | 296 | 0.38% | 71 MB | 3441 MB | 45% | tentacle | 2026-09-12 |
| `/api/session/messages` | shanghai | POST | 8,752 | 47 ms | 148 ms | 349 ms | 331 | 3.78% | 292 MB | 2936 MB | 64% | web | 2026-08-10 |
| `/api/push/register` | shanghai | GET | 61,315 | 53 ms | 166 ms | 391 ms | 86 | 0.14% | 506 MB | 242 MB | 53% | tentacle | 2026-07-17 |
| `/api/voice/lease` | shanghai | GET | 52,953 | 58 ms | 181 ms | 426 ms | 254 | 0.48% | 171 MB | 1840 MB | 65% | web | 2026-08-14 |
| `/api/attachment` | shanghai | POST | 57,229 | 78 ms | 241 ms | 566 ms | 142 | 0.25% | 368 MB | 2797 MB | 96% | tentacle | 2026-07-14 |
| `/api/auth/oauth` | shanghai | GET | 11,676 | 30 ms | 97 ms | 230 ms | 77 | 0.66% | 675 MB | 956 MB | 40% | tentacle | 2026-07-18 |
| `/api/diag/v1/batch` | shanghai | POST | 37,753 | 8 ms | 31 ms | 76 ms | 74 | 0.20% | 548 MB | 1513 MB | 79% | web | 2026-08-14 |
| `/api/device/pair` | shanghai | GET | 91,304 | 73 ms | 226 ms | 531 ms | 316 | 0.35% | 468 MB | 3685 MB | 95% | web | 2026-09-22 |
| `/api/usage/history` | shanghai | POST | 53,094 | 58 ms | 181 ms | 426 ms | 53 | 0.10% | 650 MB | 1641 MB | 43% | head | 2026-06-16 |
| `/api/session/fork` | shanghai | POST | 58,553 | 28 ms | 91 ms | 216 ms | 56 | 0.10% | 616 MB | 216 MB | 46% | head | 2026-07-27 |
| `/api/session/list` | us-east | GET | 14,099 | 54 ms | 169 ms | 398 ms | 314 | 2.23% | 73 MB | 3582 MB | 53% | web | 2026-09-14 |
| `/api/session/messages` | us-east | POST | 83,953 | 40 ms | 127 ms | 300 ms | 177 | 0.21% | 486 MB | 504 MB | 47% | tentacle | 2026-09-25 |
| `/api/push/register` | us-east | GET | 64,217 | 47 ms | 148 ms | 349 ms | 43 | 0.07% | 105 MB | 3071 MB | 61% | web | 2026-08-25 |
| `/api/voice/lease` | us-east | GET | 91,509 | 28 ms | 91 ms | 216 ms | 264 | 0.29% | 211 MB | 3896 MB | 73% | tentacle | 2026-07-27 |
| `/api/attachment` | us-east | GET | 4,344 | 75 ms | 232 ms | 545 ms | 152 | 3.50% | 713 MB | 3463 MB | 56% | web | 2026-08-15 |
| `/api/auth/oauth` | us-east | POST | 47,421 | 36 ms | 115 ms | 272 ms | 272 | 0.57% | 652 MB | 914 MB | 79% | head | 2026-07-22 |
| `/api/diag/v1/batch` | us-east | POST | 97,776 | 37 ms | 118 ms | 279 ms | 102 | 0.10% | 365 MB | 2995 MB | 41% | head | 2026-08-25 |
| `/api/device/pair` | us-east | POST | 34,770 | 32 ms | 103 ms | 244 ms | 354 | 1.02% | 458 MB | 3312 MB | 99% | web | 2026-08-21 |
| `/api/usage/history` | us-east | GET | 11,356 | 36 ms | 115 ms | 272 ms | 52 | 0.46% | 482 MB | 806 MB | 61% | head | 2026-09-10 |
| `/api/session/fork` | us-east | GET | 63,645 | 52 ms | 163 ms | 384 ms | 329 | 0.52% | 855 MB | 2706 MB | 47% | tentacle | 2026-07-25 |
| `/api/session/list` | eu-west | POST | 24,199 | 63 ms | 196 ms | 461 ms | 325 | 1.34% | 89 MB | 3281 MB | 86% | tentacle | 2026-09-22 |
| `/api/session/messages` | eu-west | GET | 98,232 | 18 ms | 61 ms | 146 ms | 371 | 0.38% | 175 MB | 521 MB | 41% | head | 2026-09-14 |
| `/api/push/register` | eu-west | POST | 80,960 | 84 ms | 259 ms | 608 ms | 242 | 0.30% | 160 MB | 2248 MB | 75% | head | 2026-06-10 |
| `/api/voice/lease` | eu-west | GET | 96,006 | 21 ms | 70 ms | 167 ms | 269 | 0.28% | 445 MB | 3571 MB | 52% | head | 2026-06-18 |
| `/api/attachment` | eu-west | GET | 28,689 | 45 ms | 142 ms | 335 ms | 256 | 0.89% | 783 MB | 2403 MB | 60% | tentacle | 2026-09-14 |
| `/api/auth/oauth` | eu-west | POST | 8,782 | 53 ms | 166 ms | 391 ms | 234 | 2.66% | 847 MB | 3759 MB | 96% | web | 2026-07-27 |
| `/api/diag/v1/batch` | eu-west | GET | 20,701 | 75 ms | 232 ms | 545 ms | 261 | 1.26% | 894 MB | 1803 MB | 89% | head | 2026-06-14 |
| `/api/device/pair` | eu-west | GET | 23,389 | 26 ms | 85 ms | 202 ms | 242 | 1.03% | 570 MB | 253 MB | 60% | web | 2026-09-13 |
| `/api/usage/history` | eu-west | GET | 74,239 | 15 ms | 52 ms | 125 ms | 127 | 0.17% | 284 MB | 173 MB | 89% | head | 2026-09-27 |
| `/api/session/fork` | eu-west | POST | 4,452 | 16 ms | 55 ms | 132 ms | 226 | 5.08% | 628 MB | 3987 MB | 72% | web | 2026-07-18 |
| `/api/session/list` | tokyo | POST | 60,089 | 73 ms | 226 ms | 531 ms | 273 | 0.45% | 520 MB | 3857 MB | 55% | web | 2026-08-27 |
| `/api/session/messages` | tokyo | POST | 27,353 | 65 ms | 202 ms | 475 ms | 70 | 0.26% | 125 MB | 1608 MB | 68% | tentacle | 2026-06-17 |
| `/api/push/register` | tokyo | POST | 56,943 | 17 ms | 58 ms | 139 ms | 108 | 0.19% | 803 MB | 502 MB | 97% | head | 2026-08-14 |
| `/api/voice/lease` | tokyo | GET | 33,975 | 25 ms | 82 ms | 195 ms | 239 | 0.70% | 765 MB | 3902 MB | 46% | tentacle | 2026-09-15 |
| `/api/attachment` | tokyo | POST | 88,334 | 36 ms | 115 ms | 272 ms | 82 | 0.09% | 528 MB | 1655 MB | 61% | tentacle | 2026-07-21 |
| `/api/auth/oauth` | tokyo | POST | 42,549 | 19 ms | 64 ms | 153 ms | 369 | 0.87% | 20 MB | 1385 MB | 75% | tentacle | 2026-09-10 |
| `/api/diag/v1/batch` | tokyo | POST | 51,176 | 50 ms | 157 ms | 370 ms | 264 | 0.52% | 525 MB | 3936 MB | 44% | head | 2026-07-13 |
| `/api/device/pair` | tokyo | GET | 11,818 | 41 ms | 130 ms | 307 ms | 139 | 1.18% | 798 MB | 744 MB | 57% | head | 2026-09-18 |
| `/api/usage/history` | tokyo | POST | 54,008 | 27 ms | 88 ms | 209 ms | 274 | 0.51% | 718 MB | 1340 MB | 45% | tentacle | 2026-06-15 |
| `/api/session/fork` | tokyo | GET | 56,547 | 17 ms | 58 ms | 139 ms | 137 | 0.24% | 650 MB | 363 MB | 91% | tentacle | 2026-06-17 |
| `/api/session/list` | shanghai | POST | 9,532 | 41 ms | 130 ms | 307 ms | 62 | 0.65% | 12 MB | 1390 MB | 75% | tentacle | 2026-08-14 |
| `/api/session/messages` | shanghai | GET | 6,463 | 75 ms | 232 ms | 545 ms | 363 | 5.62% | 113 MB | 3970 MB | 50% | tentacle | 2026-06-15 |
| `/api/push/register` | shanghai | POST | 27,246 | 47 ms | 148 ms | 349 ms | 321 | 1.18% | 544 MB | 3111 MB | 53% | tentacle | 2026-09-26 |
| `/api/voice/lease` | shanghai | POST | 88,900 | 30 ms | 97 ms | 230 ms | 138 | 0.16% | 823 MB | 75 MB | 56% | head | 2026-06-10 |
| `/api/attachment` | shanghai | GET | 96,886 | 72 ms | 223 ms | 524 ms | 282 | 0.29% | 527 MB | 1945 MB | 55% | tentacle | 2026-06-23 |
| `/api/auth/oauth` | shanghai | POST | 86,850 | 71 ms | 220 ms | 517 ms | 279 | 0.32% | 519 MB | 1261 MB | 84% | head | 2026-07-20 |
| `/api/diag/v1/batch` | shanghai | POST | 26,834 | 89 ms | 274 ms | 643 ms | 71 | 0.26% | 356 MB | 223 MB | 93% | head | 2026-06-12 |
| `/api/device/pair` | shanghai | GET | 82,778 | 40 ms | 127 ms | 300 ms | 220 | 0.27% | 57 MB | 347 MB | 82% | tentacle | 2026-08-17 |
| `/api/usage/history` | shanghai | POST | 91,591 | 45 ms | 142 ms | 335 ms | 23 | 0.03% | 190 MB | 646 MB | 57% | tentacle | 2026-06-18 |
| `/api/session/fork` | shanghai | POST | 48,528 | 50 ms | 157 ms | 370 ms | 280 | 0.58% | 251 MB | 142 MB | 96% | tentacle | 2026-07-21 |

Error rate is highest on `/api/voice/lease`.
"""#
    func testRenderTables() throws {
        let sid = "table-shot", dev = "table-dev"
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("tbl-\(UUID().uuidString)")
        let db = try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite"))
        let msgs = [
            ChatMessage(type: "user_message", seq: 1, sessionId: sid, deviceId: dev, timestamp: "2026-10-04T00:00:00.000Z", payload: ["content": AnyCodable("对比一下几个方案")]),
            ChatMessage(type: "agent_message", seq: 2, sessionId: sid, deviceId: dev, timestamp: "2026-10-04T00:00:01.000Z", payload: ["content": AnyCodable(Self.sample)]),
        ]
        try db.insert(sid, msgs)
        let app = AppState(testDatabase: db)
        app.sessionStore.sessions[sid] = SessionInfo(id: sid, deviceId: dev, deviceName: "Mac", agent: "claude", model: "m", title: "Tables",
            state: .idle, mode: .auto, lastSeq: 2, readSeq: 2, messageCount: 2, createdAt: Date(), pinned: false)
        app.deviceStore.devices[dev] = DeviceSummary(id: dev, name: "Mac", role: .tentacle, kind: .desktop, publicKey: nil,
            encryptionKey: nil, online: true, lastSeen: nil, createdAt: nil)
        app.testOutboundMessageHandler = { _, _, _ in true }
        app.messageProvider?.setTentacleInfo(sessionId: sid, lastSeq: 2, deviceId: dev)
        _ = app.messageProvider?.openSession(sid, reanchorLatest: true)
        for (name, appearance) in [("light", NSAppearance.Name.aqua), ("dark", .darkAqua)] {
            let vm = ChatViewModel(sessionId: sid, appState: app)
            vm.refreshMessageCache()
            let host = NSHostingView(rootView: MacChatView(sessionId: sid, prebuiltViewModel: vm).environment(app))
            let window = NSWindow(contentRect: NSRect(x: -10_000, y: -10_000, width: 820, height: 4_200),
                                  styleMask: [.titled, .resizable], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.appearance = NSAppearance(named: appearance)
            window.contentView = host
            window.setFrameOrigin(NSPoint(x: -10_000, y: -10_000))
            window.orderBack(nil)
            RunLoop.main.run(until: Date().addingTimeInterval(2.5))
            host.layoutSubtreeIfNeeded()
            let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: rep)
            try rep.representation(using: .png, properties: [:])!.write(to: Self.shotsDir.appendingPathComponent("mac-\(name).png"))
            window.orderOut(nil); window.contentView = nil
        }
    }

    func testRenderTableWindow() throws {
        try requireForegroundUITests()  // opens a real window
        let attributed = MacMarkdown.attributed(Self.sample, cacheKey: "mac-full-table-shot")
        var tables: [ChatTable] = []
        attributed.enumerateAttribute(.attachment, in: NSRange(location: 0, length: attributed.length)) { value, _, _ in
            if let t = value as? MacTableAttachment { tables.append(t.tableLayout) }
        }
        let big = try XCTUnwrap(tables.max { $0.bodyRowCount < $1.bodyRowCount })
        MacTableWindowController.show(big)
        RunLoop.main.run(until: Date().addingTimeInterval(0.8))
        let window = try XCTUnwrap(NSApp.windows.first { $0.title == "Table" })
        window.setFrameOrigin(NSPoint(x: -10_000, y: -10_000))
        window.setContentSize(NSSize(width: 900, height: 560))
        func find<T: NSView>(_ view: NSView, _ type: T.Type) -> T? {
            if let v = view as? T { return v }
            for sub in view.subviews { if let v = find(sub, type) { return v } }
            return nil
        }
        let field = try XCTUnwrap(find(window.contentView!, NSSearchField.self))
        field.stringValue = "voice"
        (window.windowController as? NSSearchFieldDelegate)?.controlTextDidChange?(
            Notification(name: NSControl.textDidChangeNotification, object: field))
        RunLoop.main.run(until: Date().addingTimeInterval(0.8))
        let view = try XCTUnwrap(window.contentView?.superview ?? window.contentView)
        let rep = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: rep)
        try rep.representation(using: .png, properties: [:])!.write(to: Self.shotsDir.appendingPathComponent("mac-window.png"))
        window.close()
    }
}
