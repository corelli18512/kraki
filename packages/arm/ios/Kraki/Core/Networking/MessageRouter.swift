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

        // Parse usage if present — tentacle ships full SessionUsage in the
        // digest so the sidebar shows token totals without waiting for the
        // next idle frame.
        let usage: SessionUsage? = {
            guard let dict = json["usage"] as? [String: Any] else { return nil }
            guard let input = dict["inputTokens"] as? Int,
                  let output = dict["outputTokens"] as? Int,
                  let cacheRead = dict["cacheReadTokens"] as? Int,
                  let cacheWrite = dict["cacheWriteTokens"] as? Int else { return nil }
            let cost = (dict["totalCost"] as? Double) ?? Double(dict["totalCost"] as? Int ?? 0)
            let duration = (dict["totalDurationMs"] as? Double) ?? Double(dict["totalDurationMs"] as? Int ?? 0)
            let contextTokens = dict["contextTokens"] as? Int
            return SessionUsage(
                inputTokens: input, outputTokens: output,
                cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
                totalCost: cost, totalDurationMs: duration,
                contextTokens: contextTokens
            )
        }()

        // Parse preview if present — `{ text, type, timestamp }`.
        let preview: SessionPreview? = {
            guard let dict = json["preview"] as? [String: Any],
                  let text = dict["text"] as? String,
                  let type = dict["type"] as? String,
                  let timestamp = dict["timestamp"] as? String else { return nil }
            return SessionPreview(text: text, type: type, timestamp: timestamp)
        }()

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
            usage: usage,
            pinned: json["pinned"] as? Bool,
            source: json["source"] as? String,
            preview: preview
        )
    }
}

// MARK: - MessageRouter

final class MessageRouter {

    private weak var appState: AppState?
    private let encryptionHandler: EncryptionHandler

    private static let previewMaxLength = 80

    /// Event types that the tentacle persists per-session and stamps
    /// with the **per-session conversation seq** (small ordinal: 1, 2,
    /// 3, …). These are the only events whose `seq` field is
    /// comparable across the session — and therefore the only ones
    /// that should drive the seq-derived unread state.
    ///
    /// Transient streaming events (`active`, `agent_message_delta`,
    /// `session_read`, `session_mode_set`, …) carry a `seq` from a
    /// **different** global envelope counter and must be ignored here
    /// or they'd poison the per-session counter (e.g. a delta seq of
    /// 126_037 would race ahead of an idle seq of 12 and the badge
    /// would never light up).
    ///
    /// Keep this set in sync with `RelayClient.PERSISTENT_TYPES` in
    /// `packages/tentacle/src/relay-client.ts`.
    private static let persistentTypes: Set<String> = [
        "session_created",
        "agent_message",
        "interrupted_turn",
        "user_message",
        "permission",
        "permission_resolved",
        "question",
        "question_resolved",
        "tool_start",
        "tool_complete",
        "error",
        "session_ended",
        "idle",
        "session_replay_batch",
    ]

    /// Subset of `persistentTypes` whose arrival should light up the
    /// unread badge. Everything else in `persistentTypes` silently
    /// advances `readSeq` so it never produces a phantom badge
    /// mid-turn — the badge appears in the same SwiftUI tick that
    /// `updatePreview` flips the card to the agent's final reply (or
    /// to permission / question / error text).
    private static let notifyWorthyTypes: Set<String> = [
        "idle", "error", "permission", "question"
    ]

    // MARK: Init

    init(appState: AppState) {
        self.appState = appState
        self.encryptionHandler = EncryptionHandler(
            crypto: CryptoManager(),
            keychain: KeychainManager(),
            appState: appState
        )
        self.encryptionHandler.onDecrypted = { [weak self] data in
            Task { @MainActor in
                self?.handleDataMessage(data)
            }
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

        // Only log envelope frames once they're decrypted (📨 Inner
        // message ...). The outer "📥 broadcast" / "📥 unicast" doubles
        // the log volume during agent streaming without adding signal.
        switch type {
        case "unicast", "broadcast":
            break
        default:
            KLog.d("📥 \(type)")
        }

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

        case "auth_info_response":
            appState?.authManager?.handleAuthInfoResponse(message: json)

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

        case "push_token_registered":
            appState?.pushManager?.registered = true
            KLog.d("✅ push_token_registered")

        case "preferences_updated":
            // Live sync from another device (or echo of our own
            // update). Apply via PreferencesManager — its echo-loop
            // guard prevents the resulting AppStorage write from
            // bouncing back to the relay.
            if let prefs = json["preferences"] as? [String: Any] {
                Task { @MainActor in
                    appState?.preferencesManager?.applyRemote(prefs)
                }
            }

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
            Task { @MainActor in
                self.handleDataMessage(result.message)
            }
        } catch EncryptionError.notAddressedToUs {
            KLog.d("📭 Envelope not addressed to us — skipping")
        } catch {
            KLog.d("❌ Decryption failed: \(error)")
        }
    }

    // MARK: - Data Message Routing

    /// Route a decrypted inner message to the appropriate store(s).
    @MainActor
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

        if type == "session_messages_batch" {
            handleSessionMessagesBatch(dict)
            return
        }

        if type == "session_messages_range_batch" {
            handleSessionMessagesRangeBatch(dict)
            return
        }

        if type == "device_greeting" {
            handleDeviceGreeting(dict)
            return
        }

        if type == "local_sessions_list" {
            handleLocalSessionsList(dict)
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

        // Per-session seq bookkeeping (drives derived unread).
        //
        // IMPORTANT: only persistent message types carry a per-session
        // conversation seq. Transient envelopes (`active`,
        // `agent_message_delta`, `session_read`, …) carry a seq from a
        // different global counter and must be ignored here, otherwise
        // they'd race ahead of the per-session counter and notify-worthy
        // events (idle with seq=12) would arrive "behind" lastSeq and
        // never light up the badge. `session_read` echoes are handled
        // separately via `payload.seq` in the switch below.
        //
        // For persistent events the rule is:
        //   • lastSeq always advances (so the unread accounting is
        //     accurate).
        //   • readSeq silently advances for everything EXCEPT
        //     notify-worthy events (idle / error / permission /
        //     question). That way the badge only lights up the moment
        //     a turn-ending / attention-requiring event lands — the
        //     same SwiftUI tick `updatePreview` flips the card text.
        //   • While the user is actively viewing the session, readSeq
        //     advances on every persistent event AND we send
        //     `mark_read` upstream so other devices stay in sync.
        if let seq = dict["seq"] as? Int,
           Self.persistentTypes.contains(type) {
            let isNotify = Self.notifyWorthyTypes.contains(type)
            appState.sessionStore.bumpLastSeq(sessionId, seq: seq)
            // Keep `tentacleLastSeq` in sync with what push has
            // actually delivered so `requestLatest`/`ensureLoaded`'s
            // at-head check is based on reality, not on the lagging
            // value from the last `session_list`.
            appState.messageProvider?.observeLiveMessageSeq(sessionId, seq: seq, kind: type)
            let isActive = appState.sessionStore.activeSessionId == sessionId
            if isActive || !isNotify {
                appState.sessionStore.markRead(sessionId, seq: seq)
            }
            if isActive {
                appState.commandSender?.markRead(sessionId: sessionId, seq: seq)
            }
        }

        switch type {

        // ── Session lifecycle ────────────────────────────────────────────

        case "session_created":
            handleSessionCreated(sessionId: sessionId, dict: dict, payload: payload)

        case "session_ended":
            appState.sessionStore.updateState(sessionId, state: "ended")
            appState.sessionStore.flushDelta(sessionId)
            appState.messageProvider?.ingestTailCandidate(sessionId, json: json)

        case "session_deleted":
            appState.sessionStore.removeSession(sessionId)

        // ── Chat messages ────────────────────────────────────────────────

        case "user_message":
            // Persist + materialise the real user_message, then clear
            // any optimistic pending placeholder our outbox is
            // holding for the matching clientId. The render layer
            // will drop the placeholder on its next read and the
            // real bubble — produced via the normal store + grouper
            // pipeline — takes over.
            let clientId = payload?["clientId"] as? String
            let content = payload?["content"] as? String
            appState.messageProvider?.ingestTailCandidate(sessionId, json: json)
            if let clientId {
                appState.commandSender?.clearPending(sessionId, clientId: clientId)
            }
            if let content {
                updatePreview(sessionId, text: content, type: "user", timestamp: timestamp)
            }

        case "agent_message":
            appState.sessionStore.flushDelta(sessionId)
            appState.messageProvider?.ingestTailCandidate(sessionId, json: json)
            if let content = payload?["content"] as? String {
                appState.sessionStore.setAgentTextActivity(sessionId, text: content)
            }

        case "interrupted_turn":
            appState.sessionStore.flushDelta(sessionId)
            appState.messageProvider?.ingestTailCandidate(sessionId, json: json)
            let draft = payload?["draft"] as? String ?? ""
            updatePreview(sessionId, text: draft.isEmpty ? "Turn aborted" : draft,
                          type: "agent", timestamp: timestamp)

        case "agent_message_delta":
            if let content = payload?["content"] as? String {
                appState.sessionStore.appendDelta(sessionId, content)
                appState.sessionStore.setAgentTextActivity(sessionId, text: content)
            }

        // ── Permissions ──────────────────────────────────────────────────

        case "permission":
            appState.messageProvider?.ingestTailCandidate(sessionId, json: json)
            if let permId = payload?["id"] as? String {
                let toolName = payload?["toolName"] as? String ?? ""
                let description = payload?["description"] as? String ?? ""
                let rawArgs = payload?["args"] as? [String: Any]
                let codedArgs = rawArgs.map { dict in
                    dict.mapValues { AnyCodable($0) }
                }
                let perm = PendingPermission(
                    id: permId,
                    sessionId: sessionId,
                    description: description,
                    toolName: toolName.isEmpty ? nil : toolName,
                    args: codedArgs,
                    timestamp: Date()
                )
                _ = perm  // pending state is derived from messages now;
                          // PendingPermission no longer needs to be added
                          // to a dictionary — the underlying `permission`
                          // message we already appended above is the
                          // source of truth. ChatView derives the list
                          // from messages, sidebar uses preview.type.
                // Prefer the human-readable description; fall back to
                // the tool name so the preview always says SOMETHING.
                let previewBody = description.isEmpty ? toolName : description
                updatePreview(sessionId, text: previewBody, type: "permission",
                              timestamp: timestamp, notify: true)
            }

        case "permission_resolved":
            // Grouper folds the resolution into the originating
            // permission row (backpatchPermission). Just persist.
            appState.messageProvider?.ingestTailCandidate(sessionId, json: json)

        case "approve", "deny", "always_allow":
            // Defensive: these are inbound commands from arm; tentacle
            // doesn't broadcast them back today. If they ever do arrive
            // (cross-device or protocol drift), the grouper will fold
            // them the same way as permission_resolved. No special
            // handling needed here.
            break

        // ── Questions ────────────────────────────────────────────────────

        case "question":
            appState.messageProvider?.ingestTailCandidate(sessionId, json: json)
            if let qId = payload?["id"] as? String,
               let question = payload?["question"] as? String {
                // Same as permission: we no longer hold a derived
                // PendingQuestion in a dict — the message itself is
                // canonical. Sidebar reads preview.type to know there's
                // a pending question; ChatView scans its window.
                _ = qId
                updatePreview(sessionId, text: question, type: "question",
                              timestamp: timestamp, notify: true)
            }

        case "question_resolved":
            if let answer = payload?["answer"] as? String, !answer.isEmpty {
                updatePreview(sessionId, text: answer, type: "answer",
                              timestamp: timestamp)
            }
            appState.messageProvider?.ingestTailCandidate(sessionId, json: json)

        case "answer":
            appState.messageProvider?.ingestTailCandidate(sessionId, json: json)
            if let answer = payload?["answer"] as? String, !answer.isEmpty {
                updatePreview(sessionId, text: answer, type: "answer",
                              timestamp: timestamp)
            }

        // ── Tool events ──────────────────────────────────────────────────

        case "tool_start":
            appState.messageProvider?.ingestTailCandidate(sessionId, json: json)
            if let name = payload?["toolName"] as? String {
                let headline = payload?["headline"] as? String
                appState.sessionStore.setCurrentTool(sessionId, toolName: name, headline: headline)
            }
            // Mark any ContentRef we can see as awaiting push so views
            // expanding the chip see a spinner immediately if bytes
            // haven't arrived yet.
            registerContentRefs(in: payload, sessionId: sessionId)

        case "tool_complete":
            appState.messageProvider?.ingestTailCandidate(sessionId, json: json)
            let name = payload?["toolName"] as? String
            let success = payload?["success"] as? Bool
            appState.sessionStore.clearCurrentTool(sessionId, ifMatching: name, success: success)
            registerContentRefs(in: payload, sessionId: sessionId)
            // Also mark content_ref entries inside the `attachments`
            // array (e.g. images from `kraki-show_image`).
            if let arr = payload?["attachments"] as? [[String: Any]] {
                for att in arr {
                    if let type = att["type"] as? String,
                       (type == "content_ref" || type == "image_ref"),
                       let id = att["id"] as? String {
                        appState.attachmentStore.markAwaitingPush(id: id, sessionId: sessionId)
                    }
                }
            }

        // ── Attachment chunk push ────────────────────────────────────────

        case "attachment_data":
            handleAttachmentData(payload: payload)

        // ── Session state ────────────────────────────────────────────────

        case "idle":
            appState.sessionStore.updateState(sessionId, state: "idle")
            appState.sessionStore.flushDelta(sessionId)
            appState.messageProvider?.ingestTailCandidate(sessionId, json: json)
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
            // NOTE: We deliberately do NOT call `messageStore.append`
            // here. `active` is a TRANSIENT envelope (see the comment at
            // L297) whose `seq` field comes from the relay's GLOBAL event
            // counter, not the per-session conversation counter. Storing
            // it pollutes `messageStore.getLastSeq(sessionId)` with foreign
            // seqs, which then makes `MessageProvider.requestLatest`'s
            // `storeLastSeq >= tentacleLastSeq` short-circuit fire
            // spuriously — and we permanently stop fetching new messages
            // after reconnect. Compounding fact: `MessageBubbleView`
            // explicitly filters out `active` from rendering anyway, so
            // persisting it had zero UI value.

        case "error":
            appState.sessionStore.flushDelta(sessionId)
            appState.messageProvider?.ingestTailCandidate(sessionId, json: json)
            let errorText = payload?["message"] as? String ?? "Error"
            // If this error correlates to a pending create/fork/import
            // by requestId, fail the placeholder so the optimistic
            // view shows an error state instead of spinning forever.
            if let requestId = payload?["requestId"] as? String,
               appState.commandSender?.pendingPlaceholderIds[requestId] != nil {
                appState.commandSender?.failPendingRequest(requestId, reason: errorText)
            }
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
            let title = payload?["title"] as? String
            let autoTitle = payload?["autoTitle"] as? String
            appState.sessionStore.setTitle(sessionId, title: title, autoTitle: autoTitle)

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
            // Future / unknown message types fall through here. We
            // deliberately do NOT auto-persist them — same reason as
            // `case "active"` above: an unknown type could be a
            // transient envelope with a global-counter seq that
            // would silently pollute `getLastSeq`. If a new persistent
            // type is added, give it an explicit case + handler.
            break
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
        let maxSeq = parsed.map(\.lastSeq).max() ?? 0
        KLog.chat("📋 [1/sessions] session_list device=\(deviceName) count=\(parsed.count) maxLastSeq=\(maxSeq)")
        for (i, d) in parsed.enumerated() {
            let pin = (d.pinned == true) ? "📌" : "  "
            let prev: String
            if let p = d.preview {
                let snippet = p.text
                    .replacingOccurrences(of: "\n", with: "⏎")
                    .prefix(40)
                prev = "preview{type=\(p.type) ts=\(p.timestamp) text=\"\(snippet)\"}"
            } else {
                prev = "preview=nil"
            }
            let usage: String
            if let u = d.usage {
                usage = "usage{ctx=\(u.contextTokens ?? -1)}"
            } else {
                usage = "usage=nil"
            }
            let title = d.title.map { "title=\"\($0.prefix(30))\"" } ?? "title=nil"
            KLog.chat("    [\(i)] \(pin) id=\(d.id) lastSeq=\(d.lastSeq) readSeq=\(d.readSeq) mode=\(d.mode.rawValue) agent=\(d.agent) model=\(d.model ?? "nil") state=\(d.state.rawValue) msgCount=\(d.messageCount) \(title) \(prev) \(usage)")
        }

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

            // Apply sidebar preview from the digest. Tentacle does the
            // markdown stripping + 80-char truncation for us, so this
            // is the cheapest possible sidebar paint — no replay
            // round-trip needed.
            if let preview = digest.preview {
                appState.sessionStore.setPreview(
                    digest.id,
                    text: preview.text,
                    type: preview.type,
                    timestamp: preview.timestamp
                )
            }

            // Unread is derived from readSeq/lastSeq directly on each
            // SessionInfo. We advance both sides monotonically, then
            // (if the gap is non-empty) ask the persistent cache
            // whether any messages between them are unread-worthy. If
            // not — e.g. the gap is pure tool_* / active churn —
            // silently catch readSeq up so we don't show a phantom
            // badge.
            if digest.lastSeq > 0 {
                appState.sessionStore.bumpLastSeq(digest.id, seq: digest.lastSeq)
            }
            if digest.readSeq > 0 {
                appState.sessionStore.markRead(digest.id, seq: digest.readSeq)
            }
            if digest.lastSeq > digest.readSeq {
                let store = appState.messageStore
                let hasUnreadWorthy = store.hasUnreadWorthy(digest.id, afterSeq: digest.readSeq)
                let hasCachedGap = store.dbLastSeq(digest.id) >= digest.lastSeq
                if hasCachedGap && !hasUnreadWorthy {
                    // We have the gap fully cached and nothing in it is
                    // a real unread → suppress the badge.
                    appState.sessionStore.markRead(digest.id, seq: digest.lastSeq)
                }
            }

            // Store tentacle info so any later replay request can be
            // routed to the right producer device.
            appState.messageProvider?.setTentacleInfo(
                sessionId: digest.id,
                lastSeq: digest.lastSeq,
                deviceId: tentacleDeviceId
            )
        }

        // Warm-up: request latest for the top-N most recent sessions.
        // See `MessageProvider.runWarmup` for the algorithm.
        appState.messageProvider?.runWarmup(digests: parsed)

        // Self-heal the currently-open chat. Warm-up only covers the
        // top-N by recency, so if the user is viewing a session
        // outside that set when a reconnect lands, the chat view
        // would otherwise stay frozen at whatever was in the store
        // before the disconnect. ensureLoaded is idempotent — no-op
        // when storeLastSeq already ≥ tentacleLastSeq, and no-op
        // when another tentacle owns the active session (the owning
        // tentacle's session_list arrival will trigger it).
        if let active = appState.sessionStore.activeSessionId {
            appState.messageProvider?.ensureLoaded(sessionId: active, reason: "sessionListSelfHeal")
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
            appState.messageProvider?.ingestTailCandidate(sessionId, json: json)
        }

        // Seed an initial preview so the new card has a timestamp and
        // sorts to the top of the list, mirroring the web client.
        // The text mirrors what we render in the empty-preview branch
        // of `SessionCardView.previewText`.
        let timestamp = dict["timestamp"] as? String
            ?? ISO8601DateFormatter().string(from: Date())
        updatePreview(
            sessionId,
            text: "Session created",
            type: "session_created",
            timestamp: timestamp,
            notify: false
        )

        let lastSeq = payload?["lastSeq"] as? Int ?? 0
        appState.messageProvider?.setTentacleInfo(
            sessionId: sessionId, lastSeq: lastSeq, deviceId: deviceId
        )

        if lastSeq > 0 {
            appState.messageProvider?.requestLatest(sessionId: sessionId, reason: "newSession")
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
        // Greeting fully landed — clear the amber "connecting" dot.
        // This must come AFTER `setDeviceOnline(true)` above (which
        // re-inserts into pendingGreetingIds) so the net effect of a
        // greeting frame is "device is online + no longer pending".
        appState.deviceStore.markGreeted(deviceId)
    }

    /// Land a `local_sessions_list` response into the device store so
    /// the import picker can render it.
    private func handleLocalSessionsList(_ dict: [String: Any]) {
        guard let appState,
              let deviceId = dict["deviceId"] as? String else { return }
        let payload = dict["payload"] as? [String: Any]
        let arr = payload?["sessions"] as? [[String: Any]] ?? []
        let parsed = arr.compactMap { LocalSessionSummary.from($0) }
        appState.deviceStore.localSessions[deviceId] = parsed
        appState.deviceStore.localSessionsLoading.remove(deviceId)
    }

    private func handleReplayBatch(_ dict: [String: Any]) {
        guard let appState else { return }
        let payload = dict["payload"] as? [String: Any] ?? dict
        let sessionId = payload["sessionId"] as? String ?? dict["sessionId"] as? String ?? ""
        let messagesArray = payload["messages"] as? [[String: Any]] ?? []
        let lastSeq = payload["lastSeq"] as? Int ?? 0
        let totalLastSeq = payload["totalLastSeq"] as? Int ?? lastSeq
        let parsed = ProducerMessageDecoder.decodeBatchMessages(messagesArray)
        let firstSeq = parsed.first?.seq ?? 0
        let types = Set(parsed.map(\.type)).sorted().joined(separator: ",")
        KLog.chat("📦 [2/history←WS replay_batch] session=\(sessionId.prefix(12)) count=\(parsed.count) seq=[\(firstSeq)…\(lastSeq)] totalLastSeq=\(totalLastSeq) types=[\(types)]")
        appState.messageProvider?.handleBatch(
            sessionId: sessionId,
            messages: parsed,
            lastSeq: lastSeq,
            totalLastSeq: totalLastSeq
        )
    }

    /// Handle the turn-aligned response from tentacle's
    /// `request_session_messages` endpoint. Same delivery path as the
    /// legacy `session_replay_batch`; the provider relies on the
    /// session_list `lastSeq` to track head, so we don't need to
    /// signal head-coverage in the per-batch payload.
    private func handleSessionMessagesBatch(_ dict: [String: Any]) {
        guard let appState else { return }
        let payload = dict["payload"] as? [String: Any] ?? dict
        let sessionId = payload["sessionId"] as? String ?? dict["sessionId"] as? String ?? ""
        let messagesArray = payload["messages"] as? [[String: Any]] ?? []
        let firstSeq = payload["firstSeq"] as? Int ?? 0
        let lastSeq = payload["lastSeq"] as? Int ?? 0
        let parsed = ProducerMessageDecoder.decodeBatchMessages(messagesArray)
        let types = Set(parsed.map(\.type)).sorted().joined(separator: ",")
        KLog.chat("📦 [2/history←WS messages_batch] session=\(sessionId.prefix(12)) count=\(parsed.count) seq=[\(firstSeq)…\(lastSeq)] types=[\(types)]")
        appState.messageProvider?.handleBatch(
            sessionId: sessionId,
            messages: parsed,
            lastSeq: lastSeq,
            // The new endpoint doesn't carry a separate head marker;
            // tentacleLastSeq is kept fresh via session_list and the
            // store's own ingestion ceiling.
            totalLastSeq: lastSeq
        )
    }

    /// `session_messages_range_batch` — response to
    /// `request_session_messages_range` (push-gap recovery). Routed
    /// to MessageProvider's pendingTail machinery; do NOT call
    /// `handleBatch` here because this batch is not turn-aligned
    /// (caller asked for an exact `[fromSeq..toSeq]` slice) and may
    /// contain a sparse subset of that range.
    private func handleSessionMessagesRangeBatch(_ dict: [String: Any]) {
        guard let appState else { return }
        let payload = dict["payload"] as? [String: Any] ?? dict
        let sessionId = payload["sessionId"] as? String ?? dict["sessionId"] as? String ?? ""
        let messagesArray = payload["messages"] as? [[String: Any]] ?? []
        let firstSeq = payload["firstSeq"] as? Int ?? 0
        let lastSeq = payload["lastSeq"] as? Int ?? 0
        let truncated = payload["truncated"] as? Bool ?? false
        let parsed = ProducerMessageDecoder.decodeBatchMessages(messagesArray)
        appState.messageProvider?.handleRangeBatch(
            sessionId: sessionId,
            messages: parsed,
            firstSeq: firstSeq,
            lastSeq: lastSeq,
            truncated: truncated
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
        // `notify` retained as a no-op parameter for source
        // compatibility with existing call sites. Unread state lives
        // entirely in the seq pipeline now (`bumpLastSeq` / `markRead`),
        // so a preview update doesn't itself bump anything.
        _ = notify
        guard let appState else { return }
        appState.sessionStore.setSessionPreview(
            sessionId,
            text: truncPreview(text),
            type: type,
            timestamp: timestamp
        )
    }

    // MARK: - Attachment helpers

    /// Inspect a payload dict for `argsRef` / `resultRef` (top-level) and
    /// register each as awaiting-push so any view that subsequently
    /// expands the tool chip sees a spinner immediately while bytes
    /// arrive. No-op if a ref is already in flight or already on disk.
    @MainActor
    private func registerContentRefs(in payload: [String: Any]?, sessionId: String) {
        guard let appState, let payload else { return }
        for key in ["argsRef", "resultRef"] {
            if let dict = payload[key] as? [String: Any],
               let type = dict["type"] as? String,
               (type == "content_ref" || type == "image_ref"),
               let id = dict["id"] as? String {
                appState.attachmentStore.markAwaitingPush(id: id, sessionId: sessionId)
            }
        }
    }

    /// Process an inbound `attachment_data` chunk by routing it to the
    /// attachment store. Errors carried in the chunk envelope are
    /// surfaced through the store's state machine, not logged here.
    private func handleAttachmentData(payload: [String: Any]?) {
        guard let appState, let payload,
              let id = payload["id"] as? String,
              let mimeType = payload["mimeType"] as? String else { return }
        let index = payload["index"] as? Int ?? 0
        let total = payload["total"] as? Int ?? 1
        let data = payload["data"] as? String ?? ""
        let error = payload["error"] as? String
        appState.attachmentStore.ingestChunk(
            id: id,
            index: index,
            total: total,
            mimeType: mimeType,
            data: data,
            error: error
        )
    }
}
