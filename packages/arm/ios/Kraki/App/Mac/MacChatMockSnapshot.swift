#if os(macOS) && DEBUG
import Foundation

/// Builds a privacy-safe, geometry-preserving copy of the production stores for
/// the Mac Chat test window. The production UI/data stack remains unchanged;
/// only identifiers and user-authored strings are transformed.
@MainActor
final class MacChatMockSnapshotCache {
    static let shared = MacChatMockSnapshotCache()

    private(set) var cached: AppState?
    private var buildTask: Task<AppState, Error>?

    private init() {}

    func snapshot(from production: AppState) async throws -> AppState {
        if let cached { return cached }
        if let buildTask { return try await buildTask.value }

        let sessions = production.sessionStore.sessions.values.sorted { $0.id < $1.id }
        let devices = production.deviceStore.devices.values.sorted { $0.id < $1.id }
        let sessionIDs = Dictionary(uniqueKeysWithValues: sessions.enumerated().map {
            ($0.element.id, String(format: "mock-session-%03d", $0.offset + 1))
        })
        let deviceIDs = Dictionary(uniqueKeysWithValues: devices.enumerated().map {
            ($0.element.id, String(format: "mock-device-%03d", $0.offset + 1))
        })
        let descriptors = sessions.map {
            MacChatMockDescriptor(
                sourceID: $0.id,
                targetID: sessionIDs[$0.id]!,
                lastSeq: production.messageStore.dbLastSeq($0.id)
            )
        }
        let sourceDatabase = production.messageDatabase

        let task = Task<AppState, Error> { @MainActor in
            let database = try await Task.detached(priority: .userInitiated) {
                let root = FileManager.default.temporaryDirectory
                    .appendingPathComponent("kraki-mac-chat-mock-\(UUID().uuidString)", isDirectory: true)
                try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
                let output = try MessageDatabase(databaseURL: root.appendingPathComponent("messages.sqlite"))
                for descriptor in descriptors where descriptor.lastSeq > 0 {
                    let rows = sourceDatabase.messages(
                        descriptor.sourceID,
                        from: 1,
                        to: descriptor.lastSeq
                    )
                    let transformed = rows.map {
                        MacChatMockSanitizer.message(
                            $0,
                            sessionID: descriptor.targetID,
                            deviceIDs: deviceIDs
                        )
                    }
                    try output.insert(descriptor.targetID, transformed)
                }
                return output
            }.value

            let app = AppState(testDatabase: database)
            for (index, source) in sessions.enumerated() {
                guard let sessionID = sessionIDs[source.id] else { continue }
                let deviceID = deviceIDs[source.deviceId] ?? "mock-device-000"
                var copy = source
                let copiedLastSeq = app.messageStore.dbLastSeq(sessionID)
                copy = SessionInfo(
                    id: sessionID,
                    deviceId: deviceID,
                    deviceName: MacChatMockSanitizer.label("Mock Device \(index + 1)", length: source.deviceName.count),
                    agent: source.agent,
                    model: source.model,
                    title: MacChatMockSanitizer.label(
                        String(format: "Mock Session %03d", index + 1),
                        length: max(source.displayTitle.count, 16)
                    ),
                    autoTitle: nil,
                    state: source.state,
                    mode: source.mode,
                    lastSeq: copiedLastSeq,
                    readSeq: min(source.readSeq, copiedLastSeq),
                    messageCount: source.messageCount,
                    createdAt: source.createdAt,
                    usage: source.usage,
                    pinned: source.pinned,
                    currentToolName: source.currentToolName,
                    currentToolHeadline: source.currentToolHeadline.map { MacChatMockSanitizer.text($0) },
                    activity: .none
                )
                app.sessionStore.sessions[sessionID] = copy
                app.sessionStore.sessionModes[sessionID] = production.sessionStore.sessionModes[source.id] ?? source.mode
                if let usage = production.sessionStore.sessionUsage[source.id] {
                    app.sessionStore.sessionUsage[sessionID] = usage
                }
                if source.pinned { app.sessionStore.pinnedSessions.insert(sessionID) }
                if let preview = production.sessionStore.sessionPreviews[source.id] {
                    app.sessionStore.sessionPreviews[sessionID] = SessionPreview(
                        text: MacChatMockSanitizer.text(preview.text),
                        type: preview.type,
                        timestamp: preview.timestamp
                    )
                }
                if let draft = production.sessionStore.drafts[source.id] {
                    app.sessionStore.drafts[sessionID] = MacChatMockSanitizer.text(draft)
                }
                let head = copiedLastSeq
                app.messageProvider?.setTentacleInfo(
                    sessionId: sessionID,
                    lastSeq: head,
                    deviceId: deviceID
                )
            }

            for (index, source) in devices.enumerated() {
                guard let deviceID = deviceIDs[source.id] else { continue }
                app.deviceStore.devices[deviceID] = DeviceSummary(
                    id: deviceID,
                    name: "Mock Device \(index + 1)",
                    role: source.role,
                    kind: source.kind,
                    publicKey: nil,
                    encryptionKey: nil,
                    online: source.online,
                    lastSeen: source.lastSeen,
                    createdAt: source.createdAt
                )
                app.deviceStore.deviceAgents[deviceID] = production.deviceStore.deviceAgents[source.id]
                app.deviceStore.deviceVersions[deviceID] = "mock"
                #if os(macOS)
                app.deviceStore.deviceModels[deviceID] = production.deviceStore.deviceModels[source.id]
                app.deviceStore.deviceModelDetails[deviceID] = production.deviceStore.deviceModelDetails[source.id]
                #endif
            }

            let selectedID: String? = {
                if let active = production.sessionStore.activeSessionId,
                   let mapped = sessionIDs[active],
                   app.messageStore.dbLastSeq(mapped) > 0 {
                    return mapped
                }
                return app.sessionStore.navigationOrderedSessions.first {
                    app.messageStore.dbLastSeq($0.id) > 0
                }?.id
            }()
            if let selectedID {
                app.sessionStore.activeSessionId = selectedID
            }
            return app
        }
        buildTask = task
        do {
            let result = try await task.value
            cached = result
            buildTask = nil
            return result
        } catch {
            buildTask = nil
            throw error
        }
    }
}

private struct MacChatMockDescriptor: Sendable {
    let sourceID: String
    let targetID: String
    let lastSeq: Int
}

private enum MacChatMockSanitizer {
    private static let preservedStringKeys: Set<String> = [
        "type", "mimeType", "mode", "toolName", "kind", "language",
        "delivery", "decision", "state"
    ]
    private static let identifierKeys: Set<String> = [
        "id", "toolCallId", "permissionId", "questionId", "requestId", "clientId"
    ]
    private static let placeholderPNG =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL1WQAAAABJRU5ErkJggg=="

    static func message(
        _ source: ChatMessage,
        sessionID: String,
        deviceIDs: [String: String]
    ) -> ChatMessage {
        ChatMessage(
            type: source.type,
            seq: source.seq,
            sessionId: sessionID,
            deviceId: source.deviceId.flatMap { deviceIDs[$0] } ?? source.deviceId.map { _ in "mock-device-000" },
            timestamp: source.timestamp,
            payload: dictionary(source.payload, deviceIDs: deviceIDs)
        )
    }

    private static func dictionary(
        _ source: [String: AnyCodable],
        deviceIDs: [String: String]
    ) -> [String: AnyCodable] {
        source.mapValuesWithKeys { key, value in
            valueForKey(key, value: value, deviceIDs: deviceIDs)
        }
    }

    private static func valueForKey(
        _ key: String,
        value: AnyCodable,
        deviceIDs: [String: String]
    ) -> AnyCodable {
        if key == "data", value.stringValue != nil { return AnyCodable(placeholderPNG) }
        if key == "deviceId", let raw = value.stringValue {
            return AnyCodable(deviceIDs[raw] ?? "mock-device-000")
        }
        if preservedStringKeys.contains(key), let raw = value.stringValue { return AnyCodable(raw) }
        if identifierKeys.contains(key), let raw = value.stringValue {
            return AnyCodable("mock-\(abs(raw.hashValue))")
        }
        if let raw = value.stringValue { return AnyCodable(text(raw)) }
        if let array = value.arrayValue {
            return AnyCodable(array.map { item in
                if let dict = item.dictValue {
                    return AnyCodable(dictionary(dict, deviceIDs: deviceIDs))
                }
                if let raw = item.stringValue { return AnyCodable(text(raw)) }
                return item
            })
        }
        if let dict = value.dictValue {
            return AnyCodable(dictionary(dict, deviceIDs: deviceIDs))
        }
        return value
    }

    /// Keep whitespace and Markdown/code punctuation byte-for-byte where ASCII,
    /// while replacing letters and digits deterministically. Fence language
    /// tags are preserved so syntax-highlighting cost remains representative.
    static func text(_ source: String) -> String {
        var result = ""
        result.reserveCapacity(source.utf8.count)
        var inFenceHeader = false
        var backtickRun = 0
        for scalar in source.unicodeScalars {
            if scalar == "`" {
                backtickRun += 1
                result.unicodeScalars.append(scalar)
                if backtickRun == 3 { inFenceHeader = true }
                continue
            }
            if scalar == "\n" {
                inFenceHeader = false
                backtickRun = 0
                result.unicodeScalars.append(scalar)
                continue
            }
            if backtickRun > 0 { backtickRun = 0 }
            if inFenceHeader {
                result.unicodeScalars.append(scalar)
            } else if CharacterSet.uppercaseLetters.contains(scalar) {
                result.append("M")
            } else if CharacterSet.lowercaseLetters.contains(scalar) {
                result.append("x")
            } else if CharacterSet.letters.contains(scalar) {
                result.append("文")
            } else if CharacterSet.decimalDigits.contains(scalar) {
                result.append("0")
            } else {
                result.unicodeScalars.append(scalar)
            }
        }
        return result
    }

    static func label(_ label: String, length: Int) -> String {
        guard length > 0 else { return label }
        if label.count == length { return label }
        if label.count > length { return String(label.prefix(length)) }
        return label + String(repeating: "x", count: length - label.count)
    }
}

private extension Dictionary where Key == String, Value == AnyCodable {
    func mapValuesWithKeys(
        _ transform: (String, AnyCodable) -> AnyCodable
    ) -> [String: AnyCodable] {
        Dictionary(uniqueKeysWithValues: map { ($0.key, transform($0.key, $0.value)) })
    }
}
#endif
