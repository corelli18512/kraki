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
            isTextFieldFocused = true
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

    private var questions: [PendingQuestion] {
        appState.messageStore.questionsForSession(sessionId)
            .sorted { $0.timestamp < $1.timestamp }
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
            .frame(maxHeight: UIScreen.main.bounds.height * 0.4)
        }
    }
}
