/// LogsWindow — Tail-following NSTextView of ~/.kraki/logs/*.log.
///
/// Minimal first pass: dropdown of log files in the directory, plain
/// monospace text view, follow toggle. We re-read on a 1s timer when
/// follow is on. M4 polish replaces this with a DispatchSource that
/// watches the file for writes.

#if os(macOS)
import SwiftUI
import AppKit

struct LogsWindow: View {
    @Environment(TentacleCLIManager.self) private var tentacleCLI

    @State private var availableFiles: [URL] = []
    @State private var selectedFile: URL?
    @State private var contents: String = ""
    @State private var follow: Bool = true
    @State private var pollTask: Task<Void, Never>?

    var body: some View {
        VStack(spacing: 0) {
            controlBar
            Divider()
            TextEditor(text: .constant(contents))
                .font(.system(.body, design: .monospaced))
                .scrollContentBackground(.hidden)
                .background(Color.surfacePrimary)
        }
        .task { await refreshFileList() }
        .task(id: selectedFile) { await reload() }
        .onAppear { startPollingIfNeeded() }
        .onDisappear { pollTask?.cancel() }
        .onChange(of: follow) { _, _ in startPollingIfNeeded() }
    }

    private var controlBar: some View {
        HStack(spacing: 8) {
            Picker("File", selection: $selectedFile) {
                ForEach(availableFiles, id: \.self) { url in
                    Text(url.lastPathComponent).tag(Optional(url))
                }
            }
            .pickerStyle(.menu)
            .frame(maxWidth: 260)

            Spacer()

            Toggle("Follow", isOn: $follow)
                .toggleStyle(.checkbox)

            Button("Reveal in Finder") {
                if let url = selectedFile {
                    NSWorkspace.shared.activateFileViewerSelecting([url])
                } else {
                    tentacleCLI.openLogsInFinder()
                }
            }

            Button("Refresh") {
                Task {
                    await refreshFileList()
                    await reload()
                }
            }
        }
        .padding(10)
    }

    // MARK: - File listing

    private func refreshFileList() async {
        let dir = URL(fileURLWithPath: tentacleCLI.logsDirectory, isDirectory: true)
        let urls = (try? FileManager.default.contentsOfDirectory(
            at: dir,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        )) ?? []
        let logs = urls.filter { $0.pathExtension == "log" }
            .sorted { a, b in
                let da = (try? a.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                let db = (try? b.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                return da > db
            }
        await MainActor.run {
            self.availableFiles = logs
            if self.selectedFile == nil { self.selectedFile = logs.first }
        }
    }

    /// Most of a log the window shows; older lines are in the file.
    private static let maxShownBytes: UInt64 = 512 * 1024

    private func reload() async {
        guard let url = selectedFile else {
            await MainActor.run { contents = "" }
            return
        }
        // Read only the tail, off the main thread: daemon logs grow to many
        // MB and Follow reloads every second.
        let text = await Task.detached(priority: .utility) { Self.tail(of: url) }.value
        await MainActor.run { if contents != text { contents = text } }
    }

    private static func tail(of url: URL) -> String {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return "" }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        let start = size > maxShownBytes ? size - maxShownBytes : 0
        try? handle.seek(toOffset: start)
        let data = (try? handle.readToEnd()) ?? Data()
        var text = String(decoding: data, as: UTF8.self)
        if start > 0, let firstNewline = text.firstIndex(of: "\n") {
            text = "… (showing the end of the log)\n" + text[text.index(after: firstNewline)...]
        }
        return text
    }

    private func startPollingIfNeeded() {
        pollTask?.cancel()
        guard follow else { return }
        pollTask = Task { @MainActor in
            while !Task.isCancelled {
                await reload()
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
    }
}

#endif
