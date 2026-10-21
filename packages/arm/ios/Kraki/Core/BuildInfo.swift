import Foundation

/// Build-time identity, never fetched from the latest release or the launch environment.
struct BuildInfo: Decodable, Equatable {
    let schemaVersion: Int
    let channel: String
    let repository: String?
    let commit: String?
    let workflow: String?
    let runId: String?
    let runAttempt: String?

    static let local = BuildInfo(schemaVersion: 1, channel: "local", repository: nil,
                                 commit: nil, workflow: nil, runId: nil, runAttempt: nil)
    static let current: BuildInfo = {
        guard let url = Bundle.main.url(forResource: "build-info", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let info = try? JSONDecoder().decode(BuildInfo.self, from: data) else { return .local }
        return info
    }()

    var hasBuildRecord: Bool {
        schemaVersion == 1 && ["ci", "release"].contains(channel)
            && repository == "corelli18512/kraki"
            && matches(commit, "^[a-f0-9]{40}$")
            && matches(runId, "^[1-9][0-9]*$") && matches(runAttempt, "^[1-9][0-9]*$")
            && [".github/workflows/release.yml", ".github/workflows/ios-testflight.yml"].contains(workflow ?? "")
    }

    var runLabel: String {
        guard hasBuildRecord, let runId, let runAttempt else { return String(localized: "Local build") }
        return runAttempt == "1" ? runId : String(localized: "\(runId) · attempt \(runAttempt)")
    }

    var runURL: URL? {
        guard hasBuildRecord, let runId, let runAttempt else { return nil }
        return URL(string: "https://github.com/corelli18512/kraki/actions/runs/\(runId)/attempts/\(runAttempt)")
    }

    var sourceURL: URL? {
        guard hasBuildRecord, let commit else { return nil }
        return URL(string: "https://github.com/corelli18512/kraki/commit/\(commit)")
    }

    var provenanceURL: URL? {
        guard channel == "release", let runURL else { return nil }
        // Attestation links are published in the run summary after packaging.
        return URL(string: runURL.absoluteString + "#summary")
    }

    private func matches(_ value: String?, _ pattern: String) -> Bool {
        guard let value else { return false }
        return value.range(of: pattern, options: .regularExpression) != nil
    }
}
