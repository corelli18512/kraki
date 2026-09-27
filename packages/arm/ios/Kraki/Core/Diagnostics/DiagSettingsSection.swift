#if KRAKI_DIAG
import SwiftUI

struct DiagSettingsSection: View {
    @AppStorage("kraki.diag.enabled") private var enabled = true
    @AppStorage("kraki.diag.lastSuccess") private var lastSuccess = 0.0
    @AppStorage("kraki.diag.pendingBytes") private var pendingBytes = 0
    @State private var marked = false
    var body: some View {
        Section("诊断日志 · 中间测试版") {
            Toggle("记录并发送诊断日志", isOn: $enabled)
            if lastSuccess > 0 {
                LabeledContent("最近上传", value: Date(timeIntervalSince1970: lastSuccess).formatted(date: .abbreviated, time: .standard))
            } else {
                Text("尚未上传，前台非计费网络下自动重试").font(.caption).foregroundStyle(.secondary)
            }
            LabeledContent("等待发送", value: ByteCountFormatter.string(fromByteCount: Int64(pendingBytes), countStyle: .file))
            Button(marked ? "已标记" : "标记：刚才出现卡顿或显示异常") {
                KrakiDiag.record(.marker)
                marked = true
            }
            .disabled(!enabled)
            Text("不含消息正文、草稿、语音或附件内容。仅在前台通过非计费网络低优先级上传，最多 20 MB/天；本地最多 50 MB。关闭会停止上传并清除尚未发送的诊断文件。")
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
