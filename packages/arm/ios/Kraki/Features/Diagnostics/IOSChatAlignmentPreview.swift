#if os(iOS) && DEBUG
import SwiftUI
import UIKit

@MainActor
enum IOSChatAlignmentPreviewFixture {
    static let sessionID = "ios-alignment-preview"
    static let deviceID = "ios-alignment-device"
    static let artifact = ContentRef(
        type: "content_ref",
        id: "ios-alignment-report",
        mimeType: "text/html",
        size: reportHTML.utf8.count,
        caption: "Streaming Bubble Alignment Report",
        name: "alignment-report.html",
        width: nil,
        height: nil
    )

    static let reportHTML = """
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>iOS Chat Alignment Report</title>
        <style>
          body { font: 16px -apple-system, system-ui; margin: 0; padding: 28px; color: #0f172a; background: #f8fafc; }
          main { max-width: 680px; margin: auto; padding: 24px; border-radius: 18px; background: white; box-shadow: 0 12px 40px #0f172a18; }
          h1 { margin-top: 0; font-size: 25px; }
          .ok { display: inline-block; padding: 6px 10px; border-radius: 999px; color: #166534; background: #dcfce7; font-weight: 650; }
          li { margin: 10px 0; }
        </style>
      </head>
      <body>
        <main>
          <span class="ok">Native secure preview active</span>
          <h1>Fixture HTML artifact</h1>
          <p>Static fixture content. This page is not a test result.</p>
          <ul>
            <li>One reusable TextKit bubble cell</li>
            <li>Interruptible height animation</li>
            <li>Fixed native HTML artifact card</li>
            <li>One nonpersistent Session-level WKWebView</li>
          </ul>
        </main>
      </body>
    </html>
    """

    private static func renderedImage(
        background: UIColor,
        accent: UIColor,
        label: String
    ) -> UIImage {
        let size = CGSize(width: 640, height: 360)
        let renderer = UIGraphicsImageRenderer(size: size)
        return renderer.image { context in
            background.setFill()
            context.fill(CGRect(origin: .zero, size: size))
            accent.setFill()
            context.fill(CGRect(x: 56, y: 54, width: 528, height: 252))
            let text = NSAttributedString(
                string: label,
                attributes: [
                    .font: UIFont.systemFont(ofSize: 54, weight: .heavy),
                    .foregroundColor: UIColor.white,
                ]
            )
            let textSize = text.size()
            text.draw(at: CGPoint(
                x: (size.width - textSize.width) / 2,
                y: (size.height - textSize.height) / 2
            ))
        }
    }

    private static func inlineImage(
        background: UIColor,
        accent: UIColor,
        label: String
    ) -> [String: Any] {
        let image = renderedImage(background: background, accent: accent, label: label)
        return [
            "type": "image",
            "mimeType": "image/png",
            "data": image.pngData()?.base64EncodedString() ?? "",
        ]
    }

    static func imagePreviewSelection() -> IOSImagePreviewSelection {
        IOSImagePreviewSelection(items: [
            IOSImagePreviewItem(
                id: "fixture-image-1",
                image: renderedImage(background: .systemBlue, accent: .systemTeal, label: "IMAGE 1"),
                title: "Image 1"
            ),
            IOSImagePreviewItem(
                id: "fixture-image-2",
                image: renderedImage(background: .systemPurple, accent: .systemPink, label: "IMAGE 2"),
                title: "Image 2"
            ),
        ])
    }

    static func makeAppState() -> AppState {
        do {
            let root = FileManager.default.temporaryDirectory
                .appendingPathComponent("kraki-ios-chat-alignment-\(UUID().uuidString)", isDirectory: true)
            let database = try MessageDatabase(databaseURL: root.appendingPathComponent("messages.sqlite"))
            let report: [String: AnyCodable] = [
                "type": AnyCodable(artifact.type),
                "id": AnyCodable(artifact.id),
                "mimeType": AnyCodable(artifact.mimeType),
                "size": AnyCodable(artifact.size),
                "caption": AnyCodable(artifact.caption),
                "name": AnyCodable(artifact.name),
            ]
            let messages = [
                ChatMessage(
                    type: "user_message", seq: 1, sessionId: sessionID,
                    deviceId: deviceID, timestamp: "2026-08-03T00:00:00Z",
                    payload: ["content": AnyCodable("Generate a production readiness report for the native chat surface.")]
                ),
                ChatMessage(
                    type: "agent_message", seq: 2, sessionId: sessionID,
                    deviceId: deviceID, timestamp: "2026-08-03T00:00:01Z",
                    payload: [
                        "content": AnyCodable("The report artifact is ready. Streaming validation continues below."),
                        "attachments": AnyCodable([report, report]),
                    ]
                ),
                ChatMessage(
                    type: "user_message", seq: 3, sessionId: sessionID,
                    deviceId: deviceID, timestamp: "2026-08-03T00:00:02Z",
                    payload: ["content": AnyCodable("Show the mobile attachment gallery without covering this message.")]
                ),
                ChatMessage(
                    type: "agent_message", seq: 4, sessionId: sessionID,
                    deviceId: deviceID, timestamp: "2026-08-03T00:00:03Z",
                    payload: [
                        "content": AnyCodable("Images now live below the text bubble as one compact gallery.\n\n```tsx\nexport const Gallery = () => <Preview count={2} />\n```"),
                        "attachments": AnyCodable([
                            inlineImage(
                                background: .systemBlue,
                                accent: .systemTeal,
                                label: "IMAGE 1"
                            ),
                            inlineImage(
                                background: .systemPurple,
                                accent: .systemPink,
                                label: "IMAGE 2"
                            ),
                        ]),
                    ]
                ),
                // The history must end with an accepted prompt: opening a
                // window restores the card gate from persisted truth, and a
                // trailing agent_message closes it (every delta would be
                // dropped and the "streaming" preview would stream nothing).
                ChatMessage(
                    type: "user_message", seq: 5, sessionId: sessionID,
                    deviceId: deviceID, timestamp: "2026-08-03T00:00:04Z",
                    payload: ["content": AnyCodable("写一份完整的发布检查方案，带代码和表格。")]
                ),
            ]
            try database.insert(sessionID, messages)

            let app = AppState(testDatabase: database)
            app.sessionStore.sessions[sessionID] = SessionInfo(
                id: sessionID,
                deviceId: deviceID,
                deviceName: "Simulator",
                agent: "pi",
                model: "1yuan-gpt/gpt-5.6-sol",
                title: "iOS Chat Alignment",
                state: .active,
                mode: .discuss,
                lastSeq: 5,
                readSeq: 5,
                messageCount: 5,
                createdAt: Date(),
                pinned: false
            )
            app.deviceStore.devices[deviceID] = DeviceSummary(
                id: deviceID,
                name: "Simulator",
                role: .tentacle,
                kind: .desktop,
                publicKey: nil,
                encryptionKey: nil,
                online: true,
                lastSeen: nil,
                createdAt: nil
            )
            app.messageProvider?.setTentacleInfo(sessionId: sessionID, lastSeq: 5, deviceId: deviceID)
            _ = app.messageProvider?.openSession(sessionID, reanchorLatest: true)
            app.messageStore.beginCardTurn(sessionID)
            return app
        } catch {
            fatalError("Unable to create iOS Chat alignment fixture: \(error)")
        }
    }
}

@MainActor
enum IOSChatAlignmentLog {
    private static let fileURL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("ios-chat-alignment.log")

    static func reset() {
        try? FileManager.default.removeItem(at: fileURL)
    }

    static func write(_ line: String) {
        let data = Data((line + "\n").utf8)
        if !FileManager.default.fileExists(atPath: fileURL.path) {
            FileManager.default.createFile(atPath: fileURL.path, contents: data)
        } else if let handle = try? FileHandle(forWritingTo: fileURL) {
            defer { try? handle.close() }
            try? handle.seekToEnd()
            try? handle.write(contentsOf: data)
        }
        print("[ios-alignment] \(line)")
    }
}

struct IOSChatAlignmentPreview: View {
    @Environment(AppState.self) private var appState
    @State private var selectedImagePreview: IOSImagePreviewSelection?
    @State private var selectedArtifact: IOSSelectedHTMLArtifact?
    @State private var revision = 0
    @State private var phase = "Preparing production Chat path…"

    /// Realistic streamed answer: CJK prose, fenced code, list and table,
    /// long enough to exceed several screens and several render chunks.
    static let streamedAnswer: String = {
        let zh = "好的，我先梳理发布前需要确认的事项。首先要确认服务端配置和客户端版本一致，然后检查推送证书、数据库迁移和回滚方案。每一步都需要有明确的负责人和验收标准，避免上线后才发现问题。"
        let code = "```swift\nfunc verifyRelease() async throws {\n    let manifest = try await api.fetchManifest()\n    guard manifest.version == Bundle.main.version else {\n        throw ReleaseError.versionMismatch\n    }\n    try await migrations.dryRun()\n}\n```"
        let list = "检查清单：\n\n1. 版本号与构建号\n2. 证书与签名\n3. 数据迁移演练\n4. 回滚脚本\n5. 监控与告警\n\n- 风险：中\n- 需要灰度：是"
        let table = "| 项目 | 负责人 | 状态 |\n|---|---|---|\n| 签名 | 张三 | 完成 |\n| 迁移 | 李四 | 进行中 |\n| 监控 | 王五 | 待开始 |"
        let en = "Once these are green, cut the release branch, tag it, and let the staged rollout run for 24 hours before widening."
        return (0..<4).map { index in
            "## 第 \(index + 1) 部分\n\n\(zh)\n\n\(code)\n\n\(list)\n\n\(table)\n\n\(en)"
        }.joined(separator: "\n\n")
    }()

    private let tokens: [String] = {
        let characters = Array(streamedAnswer)
        return stride(from: 0, to: characters.count, by: 14).map {
            String(characters[$0..<min($0 + 14, characters.count)])
        }
    }()

    var body: some View {
        let _ = revision
        let _ = appState.messageStore.cards[IOSChatAlignmentPreviewFixture.sessionID]
        NavigationStack {
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    ProgressView()
                        .controlSize(.small)
                    Text(phase)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(Color.textSecondary)
                    Spacer(minLength: 0)
                    Text("r\(revision)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(Color.textMuted)
                }
                .padding(.horizontal, 14)
                .frame(height: 34)
                .background(Color.surfaceSecondary)

                ChatPerfListView(
                    sessionId: IOSChatAlignmentPreviewFixture.sessionID,
                    agent: "pi",
                    bottomContentInset: 24,
                    onResolvePermission: { _, _, _ in },
                    onAnswerQuestion: { _, _ in },
                    onOpenImage: { selection in
                        selectedImagePreview = selection
                    },
                    onOpenHTMLArtifact: { ref in
                        selectedArtifact = IOSSelectedHTMLArtifact(
                            sessionId: IOSChatAlignmentPreviewFixture.sessionID,
                            ref: ref
                        )
                    }
                )
            }
            .background(Color.surfacePrimary)
            .navigationTitle("iOS Chat Alignment")
            .navigationBarTitleDisplayMode(.inline)
        }
        .fullScreenCover(item: $selectedImagePreview) { selection in
            IOSImagePreviewGallery(selection: selection)
        }
        .sheet(item: $selectedArtifact) { selection in
            IOSHTMLArtifactPreview(selection: selection)
                .environment(appState)
        }
        .task {
            IOSChatAlignmentLog.reset()
            IOSChatAlignmentLog.write("start session=isolated productionPath=1")
            let html = IOSChatAlignmentPreviewFixture.reportHTML
            appState.attachmentStore.ingestChunk(
                id: IOSChatAlignmentPreviewFixture.artifact.id,
                index: 0,
                total: 1,
                mimeType: "text/html",
                data: Data(html.utf8).base64EncodedString(),
                error: nil
            )
            try? await Task.sleep(for: .milliseconds(600))
            if ProcessInfo.processInfo.environment["KRAKI_IOS_IMAGE_PREVIEW_AUTO_OPEN"] == "1" {
                phase = "Image gallery preview"
                selectedImagePreview = IOSChatAlignmentPreviewFixture.imagePreviewSelection()
                IOSChatAlignmentLog.write("image-preview-open requested=1 items=2")
                return
            }
            phase = "Streaming through the production collection path"
            for token in tokens {
                appState.messageStore.applyCardMessage(
                    IOSChatAlignmentPreviewFixture.sessionID,
                    token,
                    reset: false
                )
                revision += 1
                try? await Task.sleep(for: .milliseconds(30))
            }
            IOSChatAlignmentLog.write("stream-complete revisions=\(revision)")
            try? await Task.sleep(for: .milliseconds(500))
            // Land the concluding answer exactly like the router does.
            let landed: [String: Any] = [
                "type": "agent_message", "seq": 6,
                "sessionId": IOSChatAlignmentPreviewFixture.sessionID,
                "deviceId": IOSChatAlignmentPreviewFixture.deviceID,
                "timestamp": "2026-08-03T00:00:05Z",
                "payload": ["content": Self.streamedAnswer],
            ]
            if let json = try? JSONSerialization.data(withJSONObject: landed) {
                appState.messageProvider?.ingestTailCandidate(IOSChatAlignmentPreviewFixture.sessionID, json: json)
                appState.messageStore.endCardTurn(IOSChatAlignmentPreviewFixture.sessionID)
            }
            revision += 1
            phase = "Answer landed"
            IOSChatAlignmentLog.write("landed seq=6")
            guard ProcessInfo.processInfo.environment["KRAKI_IOS_ALIGNMENT_OPEN_REPORT"] == "1" else { return }
            try? await Task.sleep(for: .milliseconds(900))
            selectedArtifact = IOSSelectedHTMLArtifact(
                sessionId: IOSChatAlignmentPreviewFixture.sessionID,
                ref: IOSChatAlignmentPreviewFixture.artifact
            )
            IOSChatAlignmentLog.write("report-open requested=1")
        }
    }
}
#endif
