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
          <h1>iOS Chat alignment passed</h1>
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
                    payload: ["content": AnyCodable("Now stream a long answer and keep the bubble stable while it grows.")]
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
                lastSeq: 3,
                readSeq: 3,
                messageCount: 3,
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
            app.messageProvider?.setTentacleInfo(sessionId: sessionID, lastSeq: 3, deviceId: deviceID)
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
    @State private var selectedArtifact: IOSSelectedHTMLArtifact?
    @State private var revision = 0
    @State private var phase = "Preparing production Chat path…"

    private let tokens = Array(repeating: [
        "The live bubble keeps its logical identity while the current TextKit surface remains visible.",
        "Each exact height is applied with an interruptible ease-out transition and bottom following stays synchronized.",
        "New streaming revisions take over from the presentation frame instead of reloading or flashing the cell.",
        "HTML report cards use fixed metadata geometry and the WebView remains outside the virtualized conversation list.",
    ], count: 9).flatMap { $0 }

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
            phase = "Streaming through the production collection path"
            for token in tokens {
                appState.messageStore.applyCardMessage(
                    IOSChatAlignmentPreviewFixture.sessionID,
                    token + " ",
                    reset: false
                )
                revision += 1
                try? await Task.sleep(for: .milliseconds(55))
            }
            phase = "Streaming complete · opening secure report"
            IOSChatAlignmentLog.write("stream-complete revisions=\(revision)")
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
