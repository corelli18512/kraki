#if os(iOS)
/// QuestionCardView — Violet-bordered action card for agent questions.
///
/// Mirrors QuestionInput.tsx. Shows the question text, optional choice
/// buttons, and a freeform text input field.

import SwiftUI

struct QuestionCardView: View {
    @Environment(AppState.self) private var appState
    let question: PendingQuestion

    @State private var freeformText = ""
    @FocusState private var isTextFieldFocused: Bool
    /// Question id we already auto-focused for. Prevents re-focusing
    /// on every view re-appearance when the same question stays on
    /// screen (which would steal focus from any other text field the
    /// user just tapped) while still autofocusing the FIRST time a
    /// brand-new question card appears.
    @State private var autoFocusedQuestionId: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Header
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "questionmark.circle.fill")
                    .foregroundStyle(.purple)
                    .font(.title3)

                VStack(alignment: .leading, spacing: 4) {
                    Text("Question")
                        .font(.headline)

                    Text(question.question)
                        .font(.body)
                        .foregroundStyle(.primary)
                }
            }

            // Choice buttons
            if let choices = question.choices, !choices.isEmpty {
                VStack(spacing: 6) {
                    ForEach(choices, id: \.self) { choice in
                        Button {
                            submitAnswer(choice)
                        } label: {
                            Text(choice)
                                .font(.subheadline)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 14)
                                .padding(.vertical, 10)
                        }
                        .buttonStyle(.bordered)
                        .tint(.purple)
                        .clipShape(Capsule())
                    }
                }
            }

            Divider()

            // Freeform input
            HStack(spacing: 8) {
                TextField("Type your answer…", text: $freeformText)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Color(.systemGray6))
                    .clipShape(Capsule())
                    .focused($isTextFieldFocused)
                    .submitLabel(.send)
                    .onSubmit {
                        guard !freeformText.trimmingCharacters(in: .whitespaces).isEmpty else { return }
                        submitAnswer(freeformText.trimmingCharacters(in: .whitespaces))
                    }

                Button {
                    guard !freeformText.trimmingCharacters(in: .whitespaces).isEmpty else { return }
                    submitAnswer(freeformText.trimmingCharacters(in: .whitespaces))
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                        .foregroundStyle(.purple)
                }
                .disabled(freeformText.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding()
        .background(Color.purple.opacity(0.05))
        .overlay(alignment: .top) {
            Rectangle()
                .fill(Color.purple)
                .frame(height: 3)
        }
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .onAppear {
            // Only autofocus the first time this question appears.
            // Repeated re-renders (parent recompose, scroll on/off
            // screen) shouldn't yank the keyboard focus back here.
            if autoFocusedQuestionId != question.id {
                autoFocusedQuestionId = question.id
                isTextFieldFocused = true
            }
        }
        .sensoryFeedback(.impact(flexibility: .solid, intensity: 0.5), trigger: question.id)
    }

    private func submitAnswer(_ answer: String) {
        appState.commandSender?.answer(sessionId: question.sessionId, questionId: question.id, answer: answer)
        isTextFieldFocused = false
        freeformText = ""
    }
}

// MARK: - Stacked Questions

/// Scrollable stack of pending questions for a session.
struct QuestionStackView: View {
    @Environment(AppState.self) private var appState
    let sessionId: String

    /// Currently-unresolved questions for this session, derived
    /// live from the loaded window. Matches the scan logic in
    /// `ChatViewModel.questions` — kept independent so this view
    /// can render even if no ChatViewModel is around (e.g. push
    /// notification → action sheet).
    private var questions: [PendingQuestion] {
        let msgs = appState.messageProvider?.currentWindow(sessionId) ?? []
        var resolvedIds = Set<String>()
        for m in msgs {
            switch m.type {
            case "answer", "question_resolved":
                if let qid = m.payload["questionId"]?.stringValue {
                    resolvedIds.insert(qid)
                }
            default:
                break
            }
        }
        var out: [PendingQuestion] = []
        for m in msgs where m.type == "question" {
            guard let qid = m.questionId else { continue }
            if m.payload["answer"] != nil { continue }
            if resolvedIds.contains(qid) { continue }
            let ts = Self.parseTimestamp(m.timestamp)
            out.append(PendingQuestion(
                id: qid,
                sessionId: sessionId,
                question: m.question ?? "",
                choices: m.choices,
                timestamp: ts
            ))
        }
        return out.sorted { $0.timestamp < $1.timestamp }
    }

    private static func parseTimestamp(_ iso: String?) -> Date {
        guard let iso else { return Date() }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: iso) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: iso) ?? Date()
    }

    var body: some View {
        if !questions.isEmpty {
            ScrollView {
                VStack(spacing: 10) {
                    ForEach(questions) { question in
                        QuestionCardView(question: question)
                    }
                }
                .padding(.horizontal)
            }
            .frame(maxHeight: WindowSize.height * 0.4)
        }
    }
}

#endif
