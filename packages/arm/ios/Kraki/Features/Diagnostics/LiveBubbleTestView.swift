#if os(iOS) && DEBUG
//  LiveBubbleTestView.swift
//  Simulator harness for the pure-spine render model's LIVE piece — the
//  card-driven `LiveAgentBubbleView` (draft + action slot). WS is locked so the
//  real card can't be exercised; this drives it with a mock `SessionCard` +
//  controls so the render is validated on a simulator.
//
//  Reach it via Settings → Diagnostics → "Live Bubble Test", or launch with
//  `KRAKI_LIVEBUBBLE=1` (straight in, no login).

import SwiftUI

struct LiveBubbleTestView: View {
    private let sessionId = "mock-live-1"
    @State private var card = MessageStore.SessionCard(text: "\u{6211}\u{5148}\u{5B9A}\u{4F4D}\u{4E00}\u{4E0B} hitch \u{7684}\u{6839}\u{56E0}\u{3002}", action: nil)
    @State private var hasSteps = true
    @State private var showSteps = false
    @State private var running = false

    private func action(_ type: String, _ payload: [String: AnyCodable]) -> ChatMessage {
        ChatMessage(type: type, seq: 0, sessionId: nil, deviceId: nil, timestamp: nil, payload: payload)
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    // A little static spine context above the live bubble.
                    userBubble("\u{628A} ChatView \u{7684}\u{6EDA}\u{52A8} hitch \u{4FEE}\u{4E00}\u{4E0B}")
                    BubbleActionSlot(action: card.action ?? ChatMessage(type: "tool_start", seq: 0, sessionId: nil, deviceId: nil, timestamp: nil, payload: [:]),
                        sessionMode: .auto,
                        onResolvePermission: { _, _, decision in resolvePermission(decision) })
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(Color.surfaceTertiary.opacity(0.6))
                        .cornerRadius(16)
                }
                .padding(.horizontal, 12).padding(.vertical, 16)
            }
            controls
        }
        .background(Color.surfacePrimary)
        .navigationTitle("Live Bubble Test")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showSteps) {
            LiveStepsSheet(steps: mockSteps, onClose: { showSteps = false })
        }
        .onAppear {
            switch ProcessInfo.processInfo.environment["KRAKI_LIVEBUBBLE_STATE"] {
            case "tool": card = .init(text: "", action: action("tool_start", ["toolName": AnyCodable("bash"), "headline": AnyCodable("$ grep -n height cache ChatPerfListView.swift")]))
            case "batch": card = .init(text: "", action: action("tool_batch", ["running": AnyCodable(3)]))
            case "perm": card = .init(text: "\u{51C6}\u{5907}\u{6539} height cache\u{FF0C}\u{9700}\u{8981}\u{4F60}\u{786E}\u{8BA4}\u{5199}\u{5165}\u{3002}", action: action("permission", ["id": AnyCodable("p1"), "toolName": AnyCodable("write_file"), "description": AnyCodable("ChatPerfListView.swift")]))
            case "steps": DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { showSteps = true }
            default: break
            }
        }
    }

    private func userBubble(_ text: String) -> some View {
        HStack {
            Spacer(minLength: 40)
            Text(text).font(.system(size: 15)).foregroundStyle(.white)
                .padding(.horizontal, 14).padding(.vertical, 9)
                .background(Color.accentColor, in: UnevenRoundedRectangle(
                    topLeadingRadius: 16, bottomLeadingRadius: 16, bottomTrailingRadius: 4, topTrailingRadius: 16))
        }
    }

    private var controls: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ctl("Draft") { card = .init(text: "\u{6211}\u{5148}\u{5B9A}\u{4F4D}\u{4E00}\u{4E0B} hitch \u{7684}\u{6839}\u{56E0}\u{FF0C}\u{770B}\u{8D77}\u{6765}\u{662F}\u{5DE8}\u{578B} turn \u{7684}\u{9AD8}\u{5EA6}\u{6D4B}\u{91CF}\u{5361}\u{5728}\u{4E3B}\u{7EBF}\u{7A0B}\u{3002}", action: nil) }
                ctl("Tool") { card = .init(text: "", action: action("tool_start", ["toolName": AnyCodable("bash"), "headline": AnyCodable("$ grep -n height cache ChatPerfListView.swift")])) }
                ctl("Batch") { card = .init(text: "", action: action("tool_batch", ["running": AnyCodable(3)])) }
                ctl("Perm") { card = .init(text: "\u{51C6}\u{5907}\u{6539} height cache\u{FF0C}\u{9700}\u{8981}\u{4F60}\u{786E}\u{8BA4}\u{5199}\u{5165}\u{3002}", action: action("permission", ["id": AnyCodable("p1"), "toolName": AnyCodable("write_file"), "description": AnyCodable("ChatPerfListView.swift")])) }
                ctl("Done") { card = .init(text: "\u{4FEE}\u{597D}\u{4E86} ✅ \u{53BB}\u{6389} height cache \u{6295}\u{673A}\u{9884}\u{70ED}\u{FF0C}131ms \u{539F}\u{5B50}\u{6D4B}\u{91CF}\u{5C31}\u{6CA1}\u{4E86}\u{3002}", action: nil) }
                ctl(running ? "…" : "▶︎ Sim") { simulate() }.disabled(running)
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
        }
        .background(.ultraThinMaterial)
        .overlay(alignment: .top) { Rectangle().fill(Color.borderPrimary).frame(height: 0.5) }
    }

    private func ctl(_ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label).font(.system(size: 13, weight: .medium)).foregroundStyle(Color.krakiPrimary)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(Color.krakiPrimary.opacity(0.12), in: Capsule())
        }
        .buttonStyle(.plain)
    }

    // MARK: Mock resolve + simulation

    private func resolvePermission(_ decision: String) {
        guard let a = card.action, a.type == "permission" else { return }
        var p = a.payload; p["decision"] = AnyCodable(decision)
        card.action = action("permission", p)
    }
    private func simulate() {
        guard !running else { return }
        running = true
        Task { @MainActor in
            func sleep(_ ms: UInt64) async { try? await Task.sleep(nanoseconds: ms * 1_000_000) }
            card = .init(text: "", action: nil)
            for ch in "\u{6211}\u{5148}\u{5B9A}\u{4F4D}\u{4E00}\u{4E0B} hitch \u{7684}\u{6839}\u{56E0}\u{3002}" { card.text.append(ch); await sleep(20) }
            await sleep(400)
            card = .init(text: "", action: action("tool_start", ["toolName": AnyCodable("bash"), "headline": AnyCodable("$ grep -n height cache")]))
            await sleep(900)
            card.action = action("tool_batch", ["running": AnyCodable(3)])
            await sleep(1000)
            card = .init(text: "\u{51C6}\u{5907}\u{6539} height cache\u{FF0C}\u{9700}\u{8981}\u{4F60}\u{786E}\u{8BA4}\u{5199}\u{5165}\u{3002}", action: action("permission", ["id": AnyCodable("p1"), "toolName": AnyCodable("write_file"), "description": AnyCodable("ChatPerfListView.swift")]))
            // wait for user (auto-approve after 5s)
            var waited: UInt64 = 0
            while waited < 5000 {
                if case let d = card.action?.payload["decision"]?.stringValue, d != nil { break }
                await sleep(100); waited += 100
            }
            if card.action?.payload["decision"]?.stringValue == nil { resolvePermission("approve") }
            await sleep(300)
            card = .init(text: "", action: nil)
            for ch in "\u{4FEE}\u{597D}\u{4E86} ✅ \u{53BB}\u{6389} height cache\u{FF0C}131ms \u{539F}\u{5B50}\u{6D4B}\u{91CF}\u{6CA1}\u{4E86}\u{FF0C}hitch \u{5E94}\u{8BE5}\u{6D88}\u{5931}\u{3002}" { card.text.append(ch); await sleep(18) }
            running = false
        }
    }

    private var mockSteps: [ChatMessage] {
        [
            action("agent_narration", ["content": AnyCodable("\u{5148}\u{5B9A}\u{4F4D} hitch \u{6839}\u{56E0}\u{3002}")]),
            action("tool_start", ["toolName": AnyCodable("bash"), "headline": AnyCodable("$ grep -n height cache"), "toolCallId": AnyCodable("c1")]),
            action("tool_complete", ["toolName": AnyCodable("bash"), "headline": AnyCodable("$ grep -n height cache"), "toolCallId": AnyCodable("c1"), "success": AnyCodable(true)]),
            action("agent_narration", ["content": AnyCodable("\u{786E}\u{8BA4}\u{662F}\u{5DE8}\u{578B} turn \u{7684}\u{539F}\u{5B50}\u{6D4B}\u{91CF}\u{3002}")]),
        ]
    }
}

/// Minimal iOS-styled Steps sheet for the harness (production reuses the same
/// interleaved narration + tool-chip layout fed from `MessageStore.traces`).
struct LiveStepsSheet: View {
    let steps: [ChatMessage]
    var onClose: () -> Void = {}

    private var visible: [ChatMessage] {
        var completed = Set<String>()
        for s in steps where s.type == "tool_complete" { if let id = s.toolCallId { completed.insert(id) } }
        return steps.filter { m in
            if m.type == "tool_start", let id = m.toolCallId { return !completed.contains(id) }
            return true
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(Array(visible.enumerated()), id: \.offset) { _, m in
                        switch m.type {
                        case "agent_narration", "agent_message":
                            Text(LiveMarkdown.attributed(m.content ?? "")).font(.system(size: 14)).foregroundStyle(Color.textSecondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        default:
                            HStack(spacing: 8) {
                                Image(systemName: m.type == "tool_complete" ? "checkmark.circle.fill" : "circle.dashed")
                                    .foregroundStyle(m.type == "tool_complete" ? Color.green : Color.secondary)
                                Text(m.toolName ?? "tool").font(.system(size: 13, weight: .semibold, design: .monospaced))
                                Text(m.headline ?? "").font(.system(size: 13, design: .monospaced)).foregroundStyle(.secondary).lineLimit(1)
                                Spacer(minLength: 0)
                            }
                            .padding(.horizontal, 12).padding(.vertical, 8)
                            .background(Color.surfaceSecondary, in: RoundedRectangle(cornerRadius: 8))
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading).padding(16)
            }
            .background(Color.surfacePrimary)
            .navigationTitle("Steps").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button { onClose() } label: { Image(systemName: "xmark") } } }
        }
    }
}
#endif
