#if os(iOS)
/// MarkdownText — Simple markdown rendering using SwiftUI's built-in
/// AttributedString parser plus a custom code-block handler.

import SwiftUI

// MARK: - MarkdownText

/// Renders markdown text. Uses SwiftUI's built-in markdown for inline
/// formatting (bold, italic, code, links) and a custom splitter for
/// fenced code blocks which SwiftUI doesn't handle natively.
struct MarkdownText: View {
    let text: String

    var body: some View {
        let segments = parseSegments(text)

        VStack(alignment: .leading, spacing: 8) {
            ForEach(segments.indices, id: \.self) { i in
                switch segments[i] {
                case .inline(let content):
                    inlineMarkdown(content)
                case .codeBlock(let language, let code):
                    codeBlockView(language: language, code: code)
                }
            }
        }
    }

    // MARK: - Inline Markdown

    @ViewBuilder
    private func inlineMarkdown(_ content: String) -> some View {
        if let attributed = try? AttributedString(markdown: content, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) {
            Text(attributed)
                .textSelection(.enabled)
        } else {
            Text(content)
                .textSelection(.enabled)
        }
    }

    // MARK: - Code Block

    @ViewBuilder
    private func codeBlockView(language: String?, code: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if let language, !language.isEmpty {
                Text(language)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 10)
                    .padding(.top, 6)
                    .padding(.bottom, 2)
            }

            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.monoSmall)
                    .textSelection(.enabled)
                    .padding(.horizontal, 10)
                    .padding(.vertical, language == nil ? 8 : 4)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.systemGray6))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

// MARK: - Segment Parsing

private enum MarkdownSegment {
    case inline(String)
    case codeBlock(language: String?, code: String)
}

/// Split markdown text into inline segments and fenced code blocks.
private func parseSegments(_ text: String) -> [MarkdownSegment] {
    var segments: [MarkdownSegment] = []
    let lines = text.components(separatedBy: "\n")
    var inlineBuffer: [String] = []
    var codeBuffer: [String] = []
    var codeLanguage: String?
    var inCodeBlock = false

    for line in lines {
        if inCodeBlock {
            if line.hasPrefix("```") {
                segments.append(.codeBlock(language: codeLanguage, code: codeBuffer.joined(separator: "\n")))
                codeBuffer.removeAll()
                codeLanguage = nil
                inCodeBlock = false
            } else {
                codeBuffer.append(line)
            }
        } else if line.hasPrefix("```") {
            // Flush accumulated inline text
            if !inlineBuffer.isEmpty {
                segments.append(.inline(inlineBuffer.joined(separator: "\n")))
                inlineBuffer.removeAll()
            }
            let lang = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
            codeLanguage = lang.isEmpty ? nil : lang
            inCodeBlock = true
        } else {
            inlineBuffer.append(line)
        }
    }

    // Flush remaining content
    if inCodeBlock {
        // Unclosed code block — treat as code anyway
        segments.append(.codeBlock(language: codeLanguage, code: codeBuffer.joined(separator: "\n")))
    }
    if !inlineBuffer.isEmpty {
        segments.append(.inline(inlineBuffer.joined(separator: "\n")))
    }

    return segments
}

#endif
