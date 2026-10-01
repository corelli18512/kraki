import Foundation
import SwiftUI

/// The user's own spelling vocabulary for voice correction, stored on this
/// device. One entry per line: a term (`Kubernetes`), or a term with the ways
/// speech recognition tends to mishear it (`PostgreSQL = post gress`).
/// Lines starting with `#` are comments. Nothing is built in: which words
/// matter is entirely the user's.
enum VoiceVocabulary {
    static let storageKey = "voice.vocabulary"
    /// Bounded so the correction prompt (and its cost) stays small.
    static let maxEntries = 100
    static let maxEntryLength = 120

    /// One line the parser had to skip or could not read as intended.
    struct Issue: Equatable {
        enum Kind: Equatable { case tooLong, emptySide, overLimit }
        let line: Int
        let kind: Kind
    }

    struct Report: Equatable {
        var entries: [String] = []
        var issues: [Issue] = []
    }

    /// A full-width “＝” (Chinese input) means the same as “=”.
    private static func normalized(_ raw: Substring) -> String {
        raw.replacingOccurrences(of: "＝", with: "=").trimmingCharacters(in: .whitespaces)
    }

    static func check(_ text: String) -> Report {
        var report = Report()
        var seen = Set<String>()
        for (index, raw) in text.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
            let line = normalized(raw)
            guard !line.isEmpty, !line.hasPrefix("#") else { continue }
            if line.count > maxEntryLength { report.issues.append(Issue(line: index + 1, kind: .tooLong)); continue }
            if let eq = line.firstIndex(of: "=") {
                let term = line[..<eq].trimmingCharacters(in: .whitespaces)
                let heard = line[line.index(after: eq)...].trimmingCharacters(in: .whitespaces)
                if term.isEmpty || heard.isEmpty { report.issues.append(Issue(line: index + 1, kind: .emptySide)); continue }
            }
            guard seen.insert(line.lowercased()).inserted else { continue }
            if report.entries.count == maxEntries { report.issues.append(Issue(line: index + 1, kind: .overLimit)); continue }
            report.entries.append(line)
        }
        return report
    }

    static func parse(_ text: String) -> [String] { check(text).entries }

    static func load(_ defaults: UserDefaults = .standard) -> [String] {
        parse(defaults.string(forKey: storageKey) ?? "")
    }
}

/// The editor (iOS settings page and the Mac General pane).
struct VoiceVocabularyEditor: View {
    @AppStorage(VoiceVocabulary.storageKey) private var text = ""
    @FocusState private var focused: Bool

    static let placeholder = "PostgreSQL = post gress, 破四格\nKubernetes = 酷伯内提斯\n张三丰 = 张三风"

    #if os(macOS)
    private let lineHeight: CGFloat = 19
    #else
    private let lineHeight: CGFloat = 24
    #endif

    private var editorHeight: CGFloat {
        let lines = max(text.split(separator: "\n", omittingEmptySubsequences: false).count, 3)
        return min(CGFloat(lines + 1) * lineHeight + 12, 360)
    }

    var body: some View {
        let report = VoiceVocabulary.check(text)
        VStack(alignment: .leading, spacing: 8) {
            ZStack(alignment: .topLeading) {
                TextEditor(text: $text)
                    .focused($focused)
                    .font(.body)
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    #endif
                    .scrollContentBackground(.hidden)
                if text.isEmpty {
                    Text(Self.placeholder)
                        .font(.body)
                        .foregroundStyle(.tertiary)
                        .padding(.top, 8)
                        #if os(macOS)
                        .padding(.leading, 5)
                        #else
                        .padding(.leading, 5)
                        #endif
                        .allowsHitTesting(false)
                }
            }
            .frame(maxWidth: .infinity, minHeight: editorHeight, maxHeight: editorHeight)
            #if os(macOS)
            .padding(6)
            .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .textBackgroundColor)))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color(nsColor: .separatorColor)))
            #endif

            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if let issue = report.issues.first {
                    Label(Self.describe(issue, more: report.issues.count - 1), systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                }
                Spacer(minLength: 8)
                Text("\(report.entries.count) / \(VoiceVocabulary.maxEntries)")
                    .monospacedDigit()
                    .foregroundStyle(report.entries.count >= VoiceVocabulary.maxEntries ? Color.orange : Color.secondary)
            }
            .font(.caption)
        }
    }

    static func describe(_ issue: VoiceVocabulary.Issue, more: Int) -> String {
        let what: String
        switch issue.kind {
        case .tooLong: what = "is longer than \(VoiceVocabulary.maxEntryLength) characters"
        case .emptySide: what = "needs a word on both sides of “=”"
        case .overLimit: what = "is over the \(VoiceVocabulary.maxEntries)-entry limit"
        }
        return "Line \(issue.line) \(what) and is ignored" + (more > 0 ? " (+\(more) more)" : "")
    }
}

/// Shown under the editor.
struct VoiceVocabularyFooter: View {
    var body: some View {
        Text("One word or name per line. After “=”, list how voice input tends to mishear it. Lines starting with # are notes. Only used to fix spelling in your voice messages, and kept on this device.")
    }
}
