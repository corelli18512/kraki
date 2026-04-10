/// MessageRouter — Central message dispatcher.
///
/// Mirrors `message-router.ts`:
/// - Receives raw WebSocket frames via `handleRawMessage(_:)`.
/// - Routes **control messages** (auth_ok, auth_error, auth_challenge,
///   device_joined, device_left, device_removed, server_error, pong, ping).
/// - Routes **encrypted envelopes** (unicast, broadcast) through the
///   `EncryptionHandler`, then dispatches the decrypted inner payload via
///   `handleDataMessage(_:)`.
/// - `handleDataMessage` routes producer message types to the appropriate
///   store mutations on `AppState`.

import Foundation

// SessionDigest and SessionInfo are defined in Core/Protocol/ProtocolTypes.swift

// MARK: - SessionDigest JSON helper

extension SessionDigest {
    init?(json: [String: Any]) {
        guard let id = json["id"] as? String else { return nil }
        self.init(
            id: id,
            agent: json["agent"] as? String ?? "",
            model: json["model"] as? String,
            title: json["title"] as? String,
            autoTitle: json["autoTitle"] as? String,
            state: SessionState(rawValue: json["state"] as? String ?? "idle") ?? .idle,
            mode: SessionMode(rawValue: json["mode"] as? String ?? "discuss") ?? .discuss,
            lastSeq: json["lastSeq"] as? Int ?? 0,
            readSeq: json["readSeq"] as? Int ?? 0,
            messageCount: json["messageCount"] as? Int ?? 0,
            createdAt: json["createdAt"] as? String ?? "",
            usage: nil,
            pinned: json["pinned"] as? Bool
        )
    }
}

// MARK: - MessageRouter

final class MessageRouter {

    private weak var appState: AppState?
    private let encryptionHandler: EncryptionHandler

    private static let previewMaxLength = 80

    // MARK: Init

    init(appState: AppState) {
        self.appState = appState
        self.encryptionHandler = EncryptionHandler(
            crypto: CryptoManager(),
            keychain: KeychainManager(),
            appState: appState
        )
        self.encryptionHandler.onDecrypted = { [weak self] data in
            self?.handleDataMessage(data)
        }
    }

    // MARK: - Raw Message Entry Point

    /// Called by `WebSocketClient.onMessage` with the raw text-frame data.
    func handleRawMessage(_ data: Data) {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else {
            KLog.d("⚠️ Failed to parse incoming message")
            return
        }

        KLog.d("📥 \(type)")

        switch type {
        // ── Auth ──────────────────────────────────────────────────────────
        case "auth_ok":
            appState?.authManager?.handleAuthOk(message: json)

        case "auth_error":
            appState?.authManager?.handleAuthError(message: json)

        case "auth_challenge":
            if let nonce = json["nonce"] as? String {
                appState?.authManager?.handleAuthChallenge(nonce: nonce)
            }

        // ── Device lifecycle ─────────────────────────────────────────────
        case "device_joined":
            if let deviceDict = json["device"] as? [String: Any],
               let summary = DeviceSummary(json: deviceDict) {
                appState?.deviceStore.addDevice(summary)
            }

        case "device_left":
            if let deviceId = json["deviceId"] as? String {
                appState?.deviceStore.setDeviceOnline(deviceId, online: false)
            }

        case "device_removed":
            if let deviceId = json["deviceId"] as? String {
                appState?.deviceStore.removeDevice(deviceId)
            }

        // ── Server messages ──────────────────────────────────────────────
        case "server_error":
            let message = json["message"] as? String ?? "Unknown server error"
            appState?.lastError = message

        case "pong":
            break

        case "ping":
            appState?.wsClient?.sendRaw("{\"type\":\"pong\"}")

        // ── Encrypted envelopes ──────────────────────────────────────────
        case "unicast", "broadcast":
            handleEncryptedEnvelope(data)

        default:
            break
        }
    }

    // MARK: - Encrypted Envelope Handling

    private func handleEncryptedEnvelope(_ data: Data) {
        guard encryptionHandler.isReady else {
            KLog.d("🔒 Encryption not ready — queuing envelope (deviceId: \(appState?.deviceId ?? "nil"), hasKeys: \(KeychainManager().hasKeys()))")
            encryptionHandler.enqueue(data)
            return
        }
        do {
            let result = try encryptionHandler.decryptInbound(data)
            KLog.d("🔓 Decrypted → routing inner message")
            handleDataMessage(result.message)
        } catch EncryptionError.notAddressedToUs {
            KLog.d("📭 Envelope not addressed to us — skipping")
        } catch {
            KLog.d("❌ Decryption failed: \(error)")
        }
    }

    // MARK: - Data Message Routing

    /// Route a decrypted inner message to the appropriate store(s).
    func handleDataMessage(_ json: Data) {
        guard let appState,
              let dict = try? JSONSerialization.jsonObject(with: json) as? [String: Any],
              let type = dict["type"] as? String else {
            KLog.d("⚠️ Failed to parse decrypted inner message")
            return
        }

        KLog.d("📨 Inner message: \(type)")

        // ── Messages without a sessionId ─────────────────────────────────

        if type == "session_list" {
            handleSessionList(dict)
            return
        }

        if type == "session_replay_batch" {
            handleReplayBatch(dict)
            return
        }

        if type == "device_greeting" {
            handleDeviceGreeting(dict)
            return
        }

        // ── All remaining messages require a sessionId ───────────────────

        guard let sessionId = dict["sessionId"] as? String else { return }

        // Drop messages for sessions we don't know about, except session_created
        if type != "session_created",
           appState.sessionStore.session(for: sessionId) == nil {
            return
        }

        let payload = dict["payload"] as? [String: Any]
        let timestamp = dict["timestamp"] as? String

        switch type {

        // ── Session lifecycle ────────────────────────────────────────────

        case "session_created":
            handleSessionCreated(sessionId: sessionId, dict: dict, payload: payload)

        case "session_ended":
            appState.sessionStore.updateState(sessionId, state: "ended")
            appState.sessionStore.flushDelta(sessionId)
            appState.messageStore.appendMessage(sessionId, json: json)

        case "session_deleted":
            appState.sessionStore.removeSession(sessionId)

        // ── Chat messages ────────────────────────────────────────────────

        case "user_message":
            let hadPending = appState.messageStore.hasPendingInput(sessionId)
            if let seq = dict["seq"] as? Int {
                appState.messageStore.resolvePendingInput(sessionId, seq: seq)
            }
            if !hadPending {
                appState.messageStore.appendMessage(sessionId, json: json)
            }
            if let content = payload?["content"] as? String {
                updatePreview(sessionId, text: content, type: "user", timestamp: timestamp)
            }

        case "agent_message":
            appState.sessionStore.flushDelta(sessionId)
            appState.messageStore.appendMessage(sessionId, json: json)

        case "agent_message_delta":
            if let content = payload?["content"] as? String {
                appState.sessionStore.appendDelta(sessionId, content)
            }

        // ── Permissions ──────────────────────────────────────────────────

        case "permission":
            appState.messageStore.appendMessage(sessionId, json: json)
            if let permId = payload?["id"] as? String {
                let toolName = payload?["toolName"] as? String ?? ""
                appState.sessionStore.addPermission(
                    id: permId,
                    sessionId: sessionId,
                    toolName: toolName,
                    args: payload?["args"] as? [String: Any] ?? [:],
                    description: payload?["description"] as? String,
                    timestamp: timestamp
                )
                updatePreview(sessionId, text: toolName, type: "permission",
                              timestamp: timestamp, notify: true)
            }

        case "permission_resolved":
            if let permId = payload?["permissionId"] as? String,
               let resolution = payload?["resolution"] as? String {
                appState.sessionStore.removePermission(permId)
                appState.messageStore.resolvePermissionMessage(
                    sessionId, permissionId: permId, resolution: resolution
                )
            }
            appState.messageStore.appendMessage(sessionId, json: json)

        case "approve", "deny", "always_allow":
            if let permId = payload?["permissionId"] as? String {
                appState.sessionStore.removePermission(permId)
                let resolution: String = switch type {
                case "approve": "approved"
                case "deny": "denied"
                default: "always_allowed"
                }
                appState.messageStore.resolvePermissionMessage(
                    sessionId, permissionId: permId, resolution: resolution
                )
            }

        // ── Questions ────────────────────────────────────────────────────

        case "question":
            appState.messageStore.appendMessage(sessionId, json: json)
            if let qId = payload?["id"] as? String,
               let question = payload?["question"] as? String {
                appState.sessionStore.addQuestion(
                    id: qId,
                    sessionId: sessionId,
                    question: question,
                    choices: payload?["choices"] as? [String],
                    timestamp: timestamp
                )
                updatePreview(sessionId, text: question, type: "question",
                              timestamp: timestamp, notify: true)
            }

        case "question_resolved":
            if let qId = payload?["questionId"] as? String {
                let answer = payload?["answer"] as? String
                appState.sessionStore.removeQuestion(qId)
                appState.messageStore.resolveQuestionMessage(
                    sessionId, questionId: qId, answer: answer
                )
                if let answer, !answer.isEmpty {
                    updatePreview(sessionId, text: answer, type: "answer",
                                  timestamp: timestamp)
                }
            }
            appState.messageStore.appendMessage(sessionId, json: json)

        case "answer":
            if let qId = payload?["questionId"] as? String {
                let answer = payload?["answer"] as? String
                appState.sessionStore.removeQuestion(qId)
                appState.messageStore.resolveQuestionMessage(
                    sessionId, questionId: qId, answer: answer
                )
            }
            appState.messageStore.appendMessage(sessionId, json: json)
            if let answer = payload?["answer"] as? String, !answer.isEmpty {
                updatePreview(sessionId, text: answer, type: "answer",
                              timestamp: timestamp)
            }

        // ── Tool events ──────────────────────────────────────────────────

        case "tool_start", "tool_complete":
            appState.messageStore.appendMessage(sessionId, json: json)

        // ── Session state ────────────────────────────────────────────────

        case "idle":
            appState.sessionStore.updateState(sessionId, state: "idle")
            appState.sessionStore.flushDelta(sessionId)
            appState.messageStore.appendMessage(sessionId, json: json)
            if let usage = payload?["usage"] as? [String: Any] {
                appState.sessionStore.setSessionUsage(sessionId, usage: usage)
            }
            // Set preview from last agent_message in this turn
            if let lastContent = appState.messageStore.lastAgentMessageContent(sessionId) {
                updatePreview(sessionId, text: lastContent, type: "agent",
                              timestamp: timestamp, notify: true)
            }

        case "active":
            appState.sessionStore.updateState(sessionId, state: "active")
            appState.messageStore.appendMessage(sessionId, json: json)

        case "error":
            appState.sessionStore.flushDelta(sessionId)
            appState.messageStore.appendMessage(sessionId, json: json)
            let errorText = payload?["message"] as? String ?? "Error"
            updatePreview(sessionId, text: errorText, type: "error",
                          timestamp: timestamp, notify: true)

        // ── Session metadata ─────────────────────────────────────────────

        case "session_mode_set":
            if let mode = payload?["mode"] as? String {
                appState.sessionStore.setSessionMode(sessionId, mode: mode)
            }

        case "session_model_set":
            if let model = payload?["model"] as? String {
                appState.sessionStore.setSessionModel(sessionId, model: model)
            }

        case "session_title_updated":
            if let title = payload?["title"] as? String {
                let autoTitle = payload?["autoTitle"] as? Bool ?? false
                appState.sessionStore.setSessionTitle(
                    sessionId, title: title, autoTitle: autoTitle
                )
            }

        case "session_pinned":
            let pinned = payload?["pinned"] as? Bool ?? false
            appState.sessionStore.setSessionPinned(sessionId, pinned: pinned)

        case "session_read":
            if let readSeq = payload?["seq"] as? Int {
                appState.sessionStore.setSessionReadSeq(sessionId, seq: readSeq)
            }

        // ── Passthrough ──────────────────────────────────────────────────

        case "send_input":
            break // Display is handled by the user_message round-trip.

        default:
            if payload != nil {
                appState.messageStore.appendMessage(sessionId, json: json)
            }
        }
    }

    // MARK: - Drain Queue

    /// Drain any encrypted messages that were queued before auth completed.
    func drainQueue() {
        encryptionHandler.drainQueue()
    }

    // MARK: - Specific Handlers

    private func handleSessionList(_ dict: [String: Any]) {
        guard let appState else { return }

        let payload = dict["payload"] as? [String: Any]
        guard let sessions = (payload?["sessions"] ?? dict["sessions"]) as? [[String: Any]] else {
            KLog.d("⚠️ session_list: no sessions array found")
            return
        }

        let tentacleDeviceId = dict["deviceId"] as? String ?? ""
        let device = appState.deviceStore.device(for: tentacleDeviceId)
        let deviceName = device?.name ?? tentacleDeviceId

        let parsed = sessions.compactMap { SessionDigest(json: $0) }
        KLog.d("📋 session_list: \(parsed.count) sessions from \(deviceName)")

        // Remove sessions from this tentacle that are no longer in the list
        let tentacleIds = Set(parsed.map(\.id))
        for (sid, session) in appState.sessionStore.sessions {
            if session.deviceId == tentacleDeviceId && !tentacleIds.contains(sid) {
                appState.sessionStore.removeSession(sid)
            }
        }

        for digest in parsed {
            appState.sessionStore.upsertSession(digest, deviceId: tentacleDeviceId, deviceName: deviceName)

            // Sync mode
            appState.sessionStore.setMode(digest.id, digest.mode)

            // Sync usage
            if let usage = digest.usage {
                appState.sessionStore.setUsage(digest.id, usage)
            }

            // Sync pin
            appState.sessionStore.setPinned(digest.id, digest.pinned ?? false)

            // Reconstruct unread from readSeq vs lastSeq
            if digest.lastSeq > digest.readSeq {
                if appState.sessionStore.unreadCounts[digest.id] == nil {
                    appState.sessionStore.unreadCounts[digest.id] = digest.lastSeq - digest.readSeq
                }
            } else {
                appState.sessionStore.clearUnread(digest.id)
            }

            // Store tentacle info + fetch latest 50 messages
            appState.messageProvider?.setTentacleInfo(sessionId: digest.id, lastSeq: digest.lastSeq, deviceId: tentacleDeviceId)
            let fromSeq = max(1, digest.lastSeq - 49)
            if fromSeq <= digest.lastSeq && digest.lastSeq > 0 {
                appState.messageProvider?.requestLatest(sessionId: digest.id)
            }
        }
    }

    private func handleSessionCreated(
        sessionId: String,
        dict: [String: Any],
        payload: [String: Any]?
    ) {
        guard let appState else { return }

        let deviceId = dict["deviceId"] as? String ?? ""
        let device = appState.deviceStore.device(for: deviceId)

        let modeStr = payload?["mode"] as? String ?? "safe"
        let session = SessionInfo(
            id: sessionId,
            deviceId: deviceId,
            deviceName: device?.name ?? deviceId,
            agent: payload?["agent"] as? String ?? "",
            model: payload?["model"] as? String,
            title: nil,
            autoTitle: nil,
            state: .active,
            mode: SessionMode(rawValue: modeStr) ?? .safe,
            lastSeq: 0,
            readSeq: 0,
            messageCount: 0,
            createdAt: Date(),
            usage: nil,
            pinned: false
        )
        appState.sessionStore.upsertSession(session)

        // Store the raw message
        if let json = try? JSONSerialization.data(withJSONObject: dict) {
            appState.messageStore.appendMessage(sessionId, json: json)
        }

        let lastSeq = payload?["lastSeq"] as? Int ?? 0
        appState.messageProvider?.setTentacleInfo(
            sessionId: sessionId, lastSeq: lastSeq, deviceId: deviceId
        )

        if lastSeq > 0 {
            appState.messageProvider?.requestLatest(sessionId: sessionId)
        }

        // Correlate requestId — auto-navigate if we created this session
        if let requestId = payload?["requestId"] as? String {
            appState.commandSender?.resolveCreateRequest(
                requestId, sessionId: sessionId
            )
        }
    }

    private func handleDeviceGreeting(_ dict: [String: Any]) {
        guard let appState,
              let deviceId = dict["deviceId"] as? String else { return }
        let payload = dict["payload"] as? [String: Any]

        appState.deviceStore.setDeviceOnline(deviceId, online: true)

        if let models = payload?["models"] as? [String] {
            appState.deviceStore.setDeviceModels(deviceId, models: models)
        }
        if let modelDetails = payload?["modelDetails"] as? [[String: Any]] {
            appState.deviceStore.setDeviceModelDetails(deviceId, details: modelDetails)
        }
        if let version = payload?["version"] as? String {
            appState.deviceStore.setDeviceVersion(deviceId, version: version)
        }
    }

    private func handleReplayBatch(_ dict: [String: Any]) {
        guard let appState else { return }
        let payload = dict["payload"] as? [String: Any] ?? dict
        let sessionId = payload["sessionId"] as? String ?? dict["sessionId"] as? String ?? ""
        let messagesArray = payload["messages"] as? [[String: Any]] ?? []
        let lastSeq = payload["lastSeq"] as? Int ?? 0
        let totalLastSeq = payload["totalLastSeq"] as? Int ?? lastSeq
        KLog.d("📦 replay_batch: \(messagesArray.count) messages for session \(sessionId.prefix(12)), lastSeq: \(lastSeq)")
        let parsed = ProducerMessageDecoder.decodeBatchMessages(messagesArray)
        appState.messageProvider?.handleBatch(
            sessionId: sessionId,
            messages: parsed,
            lastSeq: lastSeq,
            totalLastSeq: totalLastSeq
        )
    }

    // MARK: - Preview Helpers

    private func truncPreview(_ text: String) -> String {
        text.count > Self.previewMaxLength
            ? String(text.prefix(Self.previewMaxLength)) + "…"
            : text
    }

    private func updatePreview(
        _ sessionId: String,
        text: String,
        type: String,
        timestamp: String?,
        notify: Bool = false
    ) {
        guard let appState else { return }
        let shouldIncrement = notify
            && appState.sessionStore.activeSessionId != sessionId
        appState.sessionStore.setSessionPreview(
            sessionId,
            text: truncPreview(text),
            type: type,
            timestamp: timestamp,
            incrementUnread: shouldIncrement
        )
    }
}
