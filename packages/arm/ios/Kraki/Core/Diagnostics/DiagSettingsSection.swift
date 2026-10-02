#if KRAKI_DIAG
import SwiftUI

struct DiagSettingsSection: View {
    @AppStorage("kraki.diag.enabled") private var enabled = true
    @AppStorage("kraki.diag.lastSuccess") private var lastSuccess = 0.0
    @AppStorage("kraki.diag.pendingBytes") private var pendingBytes = 0
    @AppStorage("kraki.diag.pendingBatches") private var pendingBatches = 0
    @AppStorage("kraki.diag.oldestBatch") private var oldestBatch = 0.0
    @AppStorage("kraki.diag.uploadState") private var uploadState = "waiting"
    @State private var marked = false
    var body: some View {
        Section("Diagnostics · Test Build") {
            Toggle("Record and Send Diagnostics", isOn: $enabled)
            if lastSuccess > 0 {
                LabeledContent("Last Upload", value: Date(timeIntervalSince1970: lastSuccess).formatted(date: .abbreviated, time: .standard))
            } else {
                Text("Not uploaded yet. Retries automatically in the foreground on an unmetered network.").font(.caption).foregroundStyle(.secondary)
            }
            LabeledContent("Pending", value: ByteCountFormatter.string(fromByteCount: Int64(pendingBytes), countStyle: .file))
            LabeledContent("Pending Batches", value: String(pendingBatches))
            if oldestBatch > 0 {
                LabeledContent("Oldest Pending Batch", value: Date(timeIntervalSince1970: oldestBatch).formatted(date: .abbreviated, time: .standard))
            }
            LabeledContent("Upload Status", value: uploadState)
            Text("Uploads only in the foreground, on an unmetered network and outside Low Power Mode; switching apps or continuous use may delay it.")
                .font(.caption).foregroundStyle(.secondary)
            Button(marked ? "Marked" : "Mark: Something Just Stuttered or Looked Wrong") {
                KrakiDiag.record(.marker)
                marked = true
            }
            .disabled(!enabled)
            Text("Never includes message text, drafts, voice or attachments. Uploaded at low priority in the foreground on unmetered networks, up to 20 MB a day; at most 50 MB kept locally. Turning this off stops uploads and deletes unsent diagnostics.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .onChange(of: enabled) { _, value in KrakiDiag.setEnabled(value) }
        .task(id: marked) {
            guard marked else { return }
            try? await Task.sleep(for: .seconds(3))
            marked = false
        }
    }
}
#endif
