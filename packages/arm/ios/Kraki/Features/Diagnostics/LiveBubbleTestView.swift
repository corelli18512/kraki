#if os(iOS)
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
    @State private var card = MessageStore.SessionCard(text: "我先定位一下 hitch 的根因。", action: nil)
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
                    userBubble("把 ChatView 的滚动 hitch 修一下")
                    BubbleActionSlot(action: card.action ?? ChatMessage(type: "tool_start", seq: 0, sessionId: nil, deviceId: nil, timestamp: nil, payload: [:]),
                        sessionMode: .discuss,
                        onResolvePermission: { _, _, decision in resolvePermission(decision) },
                        onAnswerQuestion: { _, answer in answerQuestion(answer) })
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
            case "perm": card = .init(text: "准备改 height cache，需要你确认写入。", action: action("permission", ["id": AnyCodable("p1"), "toolName": AnyCodable("write_file"), "description": AnyCodable("ChatPerfListView.swift")]))
            case "question": card = .init(text: "", action: action("question", ["id": AnyCodable("q1"), "question": AnyCodable("要我顺便把 px 窗口上限退回 count cap 吗？"), "choices": AnyCodable(["好，一起改", "先不用"])]))
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
                ctl("Draft") { card = .init(text: "我先定位一下 hitch 的根因，看起来是巨型 turn 的高度测量卡在主线程。", action: nil) }
                ctl("Tool") { card = .init(text: "", action: action("tool_start", ["toolName": AnyCodable("bash"), "headline": AnyCodable("$ grep -n height cache ChatPerfListView.swift")])) }
                ctl("Batch") { card = .init(text: "", action: action("tool_batch", ["running": AnyCodable(3)])) }
                ctl("Perm") { card = .init(text: "准备改 height cache，需要你确认写入。", action: action("permission", ["id": AnyCodable("p1"), "toolName": AnyCodable("write_file"), "description": AnyCodable("ChatPerfListView.swift")])) }
                ctl("Question") { card = .init(text: "", action: action("question", ["id": AnyCodable("q1"), "question": AnyCodable("要我顺便把 px 窗口上限退回 count cap 吗？"), "choices": AnyCodable(["好，一起改", "先不用"])])) }
                ctl("Done") { card = .init(text: "修好了 ✅ 去掉 height cache 投机预热，131ms 原子测量就没了。", action: nil) }
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
    private func answerQuestion(_ answer: String) {
        guard let a = card.action, a.type == "question" else { return }
        var p = a.payload; p["answer"] = AnyCodable(answer)
        card.action = action("question", p)
    }

    private func simulate() {
        guard !running else { return }
        running = true
        Task { @MainActor in
            func sleep(_ ms: UInt64) async { try? await Task.sleep(nanoseconds: ms * 1_000_000) }
            card = .init(text: "", action: nil)
            for ch in "我先定位一下 hitch 的根因。" { card.text.append(ch); await sleep(20) }
            await sleep(400)
            card = .init(text: "", action: action("tool_start", ["toolName": AnyCodable("bash"), "headline": AnyCodable("$ grep -n height cache")]))
            await sleep(900)
            card.action = action("tool_batch", ["running": AnyCodable(3)])
            await sleep(1000)
            card = .init(text: "准备改 height cache，需要你确认写入。", action: action("permission", ["id": AnyCodable("p1"), "toolName": AnyCodable("write_file"), "description": AnyCodable("ChatPerfListView.swift")]))
            // wait for user (auto-approve after 5s)
            var waited: UInt64 = 0
            while waited < 5000 {
                if case let d = card.action?.payload["decision"]?.stringValue, d != nil { break }
                await sleep(100); waited += 100
            }
            if card.action?.payload["decision"]?.stringValue == nil { resolvePermission("approve") }
            await sleep(300)
            card = .init(text: "", action: nil)
            for ch in "修好了 ✅ 去掉 height cache，131ms 原子测量没了，hitch 应该消失。" { card.text.append(ch); await sleep(18) }
            running = false
        }
    }

    private var mockSteps: [ChatMessage] {
        [
            action("agent_narration", ["content": AnyCodable("先定位 hitch 根因。")]),
            action("tool_start", ["toolName": AnyCodable("bash"), "headline": AnyCodable("$ grep -n height cache"), "toolCallId": AnyCodable("c1")]),
            action("tool_complete", ["toolName": AnyCodable("bash"), "headline": AnyCodable("$ grep -n height cache"), "toolCallId": AnyCodable("c1"), "success": AnyCodable(true)]),
            action("agent_narration", ["content": AnyCodable("确认是巨型 turn 的原子测量。")]),
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
