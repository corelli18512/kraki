/// CommandSender — Outgoing command builder mirroring commands.ts.
///
/// Each command:
///   1. Applies optimistic local updates to stores
///   2. Sends the message via WebSocket (encryption handled by AppState)
///
/// Holds a weak reference to AppState for accessing stores and send function.

import Foundation
import Observation

@Observable
final class CommandSender {
    /// requestId → initial prompt for session creation correlation.
    var pendingCreateRequests: [String: String] = [:]
    /// requestId → title to apply after session is created.
    var pendingCreateTitles: [String: String] = [:]
    /// requestId → placeholder session id used as the navigation token
    /// during optimistic create/fork. When `session_created` arrives
    /// with this requestId, the router swaps placeholderId → real id.
    var pendingPlaceholderIds: [String: String] = [:]
    /// First messages of create requests that timed out, by requestId.
    @ObservationIgnored private var timedOutCreatePrompts: [String: String] = [:]
    /// Debug automation correlation: resolved request id → authoritative
    /// session id. This never changes transport behavior; it only lets the
    /// in-process native automation driver wait for the exact create result.
    #if DEBUG
    private(set) var resolvedCreateSessions: [String: String] = [:]
    #endif
    /// Count of in-flight mode changes per session (for echo suppression).
    private var pendingModeChanges: [String: Int] = [:]

    /// Optimistic outbound user messages awaiting their server echo.
    /// Keyed `sessionId → clientId → pending placeholder`. Lives only
    /// in memory; never persisted; never enters `MessageStore`. The
    /// chat view model reads this through `pendingInputs(_:)` and
    /// appends the entries to the rendered turn list as standalone
    /// items.
    ///
    /// Echo arrival path: `MessageRouter` calls `clearPending(_:_:)`
    /// when a `user_message` lands carrying the same `clientId`. The
    /// real user_message then materialises through the normal store
    /// → grouper pipeline, and the synthesised pending entry simply
    /// disappears on the next render.
    private(set) var outbox: [String: [String: ChatMessage]] = [:]

    /// Delivery state of an optimistic input, surfaced on its bubble.
    enum PendingState: String {
        /// Queued/sent, waiting for the Tentacle echo.
        case sending
        /// No authoritative echo yet; timeout does not prove delivery failed.
        /// Retrying keeps the original clientId and is safe.
        case unconfirmed
        /// A local send/correction failure, not inferred from an echo timeout.
        case failed
        /// A sent voice message whose transcript is still being corrected.
        /// Local only: nothing has been handed to transport yet.
        case correcting
    }

    /// Wire payload of each optimistic input, kept for idempotent retry.
    @ObservationIgnored private var outboundPayloads: [String: [String: Any]] = [:]
    @ObservationIgnored private var nextLocalOrder = 1
    @ObservationIgnored private var confirmationTasks: [String: Task<Void, Never>] = [:]
    /// How long an input may stay unconfirmed while the transport and target
    /// device are online before its status becomes explicitly unconfirmed.
    @ObservationIgnored var confirmationTimeout: Duration = .seconds(30)
    @ObservationIgnored var usageRefreshTimeout: Duration = .seconds(120)
    /// Inputs accepted from the user but not yet handed to transport (the
    /// path was down or the Tentacle's key unknown). Dispatched on reconnect.
    @ObservationIgnored private var undispatched = Set<String>()
    /// Inputs whose delivery became uncertain (restored after a relaunch, or
    /// a reconnect happened after they were sent). Re-sent once, as soon as
    /// the session's Tentacle is known, online and deduplicates retries.
    @ObservationIgnored private var needsResend = Set<String>()
    /// Payload deliveries this recent mean the link is busy, not broken: an
    /// echo queued behind a backlog legitimately takes longer. Heartbeats do
    /// not count, so a quiet healthy link still surfaces a lost input.
    static let busyLinkWindow: TimeInterval = 30
    /// Durable outbox (production only). Unconfirmed inputs survive process
    /// death and come back as retryable instead of silently disappearing.
    @ObservationIgnored private var outboxURL: URL?
    private static let outboxWriteQueue = DispatchQueue(label: "chat.kraki.outbox.write", qos: .utility)

    private weak var appState: AppState?

    init(appState: AppState, outboxURL: URL? = nil) {
        self.appState = appState
        self.outboxURL = outboxURL
        restoreOutbox()
    }

    // MARK: - Send Helpers

    /// Send an encrypted message through the WebSocket.
    /// The actual encryption + routing is handled by AppState/networking layer.
    @discardableResult
    private func send(
        _ payload: [String: Any],
        sessionId: String? = nil,
        connectionScoped: Bool = false
    ) -> Bool {
        guard let appState else { return false }
        var msg = payload
        if let sessionId { msg["sessionId"] = sessionId }
        msg["deviceId"] = appState.deviceId ?? ""
        msg["seq"] = 0
        msg["timestamp"] = ISO8601.now()
        let accepted = appState.sendEncryptedMessage(msg, connectionScoped: connectionScoped)
        #if KRAKI_DIAG
        if payload["type"] as? String == "send_input", let wire = payload["payload"] as? [String: Any],
           let clientId = wire["clientId"] as? String {
            var fields: [DiagField: DiagValue] = [.clientId: .id(clientId), .accepted: .bool(accepted), .stack: .tag(KrakiDiag.stack)]
            if let answerTo = wire["answerTo"] as? String { fields[.answerTo] = .id(answerTo) }
            KrakiDiag.record(.handoff, session: sessionId, fields)
        }
        #endif
        return accepted
    }

    enum InputDelivery: String {
        case prompt
        case steer
    }

    // MARK: - Input

    @discardableResult
    func sendInput(
        sessionId: String,
        text: String,
        attachments: [ImageAttachment]? = nil,
        delivery: InputDelivery = .prompt,
        answerTo: String? = nil
    ) -> Bool {
        guard appState != nil else { return false }

        // Generate a correlation id. Tentacle echoes this back inside
        // the resulting `user_message.payload.clientId`, letting us
        // resolve the right pending placeholder even with multiple
        // in-flight sends, reconnects, or multi-device scenarios.
        let clientId = UUID().uuidString
        #if KRAKI_DIAG
        var diagFields: [DiagField: DiagValue] = [.clientId: .id(clientId), .textLength: .int(text.utf8.count),
                                                  .attachments: .int(attachments?.count ?? 0), .source: .tag("CommandSender.sendInput") ]
        if let answerTo { diagFields[.answerTo] = .id(answerTo) }
        if let ix = KrakiDiag.interaction { diagFields[.ix] = .id(ix) }
        KrakiDiag.record(.input, session: sessionId, diagFields)
        var diagAccepted = false
        defer { KrakiDiag.record(.result, session: sessionId, [.clientId: .id(clientId), .accepted: .bool(diagAccepted)]) }
        #endif
        let (pending, payload) = makePendingInput(sessionId: sessionId, clientId: clientId, text: text,
                                                  attachments: attachments, delivery: delivery,
                                                  answerTo: answerTo, state: .sending)
        // Signed out: nothing can ever deliver it. Anything else (reconnecting,
        // the Tentacle's key not known yet) is transient: keep the input queued
        // and dispatch it when the path is back instead of dropping it.
        guard isSignedIn else { return false }
        if !send(["type": "send_input", "payload": payload], sessionId: sessionId) {
            undispatched.insert(clientId)
        }
        appState?.sendMetrics.created(
            clientId, kind: answerTo != nil ? .answer : delivery == .steer ? .steer : .typed,
            textLength: text.utf8.count, attachments: attachments?.count ?? 0,
            pathUp: isDeliveryPathUp(sessionId))
        #if KRAKI_DIAG
        diagAccepted = true
        KrakiDiag.record(.outbox, session: sessionId, [.clientId: .id(clientId), .phase: .tag("created")])
        #endif
        var bucket = outbox[sessionId] ?? [:]
        bucket[clientId] = pending
        outbox[sessionId] = bucket
        outboundPayloads[clientId] = payload
        armConfirmationTimeout(sessionId: sessionId, clientId: clientId)
        persistOutbox()
        return true
    }

    /// Optimistic: a pending placeholder lives in the in-memory outbox. The
    /// render layer (ChatViewModel) appends it to the turn list; it never
    /// touches MessageStore. When Tentacle echoes `user_message` back
    /// (MessageRouter clears the matching clientId), the placeholder
    /// disappears and the real bubble takes its place. Attachments are kept
    /// on the pending payload (same shape as the server's user_message) so
    /// the bubble can render the image immediately.
    private func makePendingInput(
        sessionId: String, clientId: String, text: String,
        attachments: [ImageAttachment]?, delivery: InputDelivery, answerTo: String? = nil,
        state: PendingState
    ) -> (ChatMessage, [String: Any]) {
        var pendingPayload: [String: AnyCodable] = [
            "content": AnyCodable(text),
            "clientId": AnyCodable(clientId),
        ]
        var payload: [String: Any] = ["text": text, "clientId": clientId]
        // An answer is its own message, never a steer of the running turn.
        if let answerTo {
            pendingPayload["answerTo"] = AnyCodable(answerTo)
            payload["answerTo"] = answerTo
        } else if delivery == .steer {
            pendingPayload["delivery"] = AnyCodable(delivery.rawValue)
            payload["delivery"] = delivery.rawValue
        }
        if let attachments, !attachments.isEmpty {
            let encoded = attachments.map { att -> [String: String] in
                ["type": att.type, "mimeType": att.mimeType, "data": att.data]
            }
            pendingPayload["attachments"] = AnyCodable(encoded)
            payload["attachments"] = encoded
        }
        pendingPayload["localState"] = AnyCodable(state.rawValue)
        pendingPayload["localOrder"] = AnyCodable(nextLocalOrder)
        // Where in the conversation this was written. A message that is never
        // delivered stays here instead of sliding below later messages.
        if let head = appState?.sessionStore.sessions[sessionId]?.lastSeq, head > 0 {
            pendingPayload[Self.afterSeqKey] = AnyCodable(head)
        }
        nextLocalOrder += 1
        let pending = ChatMessage(
            type: "pending_input",
            seq: 0,
            sessionId: sessionId,
            deviceId: appState?.deviceId,
            timestamp: ISO8601.now(),
            payload: pendingPayload
        )
        return (pending, payload)
    }

    // MARK: - Staged (voice) input
    //
    // A voice message the user already sent appears at once as a bubble, but
    // is only handed to transport after speech correction completes, so the
    // agent always receives the corrected text. Until then it is `correcting`
    // and nothing has left the device. If the app dies meanwhile it is
    // restored as `failed` with the original transcript (Retry sends it).

    /// Show a not-yet-sent bubble. `text` is the transcript so far.
    @discardableResult
    func stageInput(
        sessionId: String,
        text: String,
        attachments: [ImageAttachment]? = nil,
        delivery: InputDelivery = .prompt,
        answerTo: String? = nil
    ) -> String? {
        guard appState != nil else { return nil }
        let clientId = UUID().uuidString
        #if KRAKI_DIAG
        KrakiDiag.record(.input, session: sessionId,
            [.clientId: .id(clientId), .textLength: .int(text.utf8.count), .attachments: .int(attachments?.count ?? 0),
             .source: .tag("CommandSender.stageInput")])
        #endif
        // A voice answer is staged like any message; `answerTo` rides along
        // so it is dispatched (after correction) as the question's answer.
        var (pending, payload) = makePendingInput(sessionId: sessionId, clientId: clientId, text: text,
                                                  attachments: attachments, delivery: delivery,
                                                  answerTo: answerTo, state: .correcting)
        pending.payload["originalText"] = AnyCodable(text)
        appState?.sendMetrics.created(clientId, kind: .voice, textLength: text.utf8.count,
                                      attachments: attachments?.count ?? 0, pathUp: isDeliveryPathUp(sessionId))
        var bucket = outbox[sessionId] ?? [:]
        bucket[clientId] = pending
        outbox[sessionId] = bucket
        payload["text"] = text
        outboundPayloads[clientId] = payload
        persistOutbox()
        return clientId
    }

    func isStaged(sessionId: String, clientId: String) -> Bool {
        outbox[sessionId]?[clientId]?.payload["localState"]?.stringValue == PendingState.correcting.rawValue
    }

    /// The uncorrected transcript of a staged/failed voice input, if any.
    func originalText(sessionId: String, clientId: String) -> String? {
        outbox[sessionId]?[clientId]?.payload["originalText"]?.stringValue
    }

    /// Stream correction progress into a staged bubble. `original` updates
    /// the fallback transcript while more raw speech is still arriving.
    /// `uncorrected` (UTF-16 range in `text`) is the part of the transcript
    /// the correction has not reached yet; it renders light, the rest solid.
    func updateStagedInput(sessionId: String, clientId: String, text: String, original: String? = nil,
                           uncorrected: NSRange? = nil) {
        guard isStaged(sessionId: sessionId, clientId: clientId),
              var bucket = outbox[sessionId], var message = bucket[clientId] else { return }
        let fade: [Int]? = uncorrected.flatMap { $0.length > 0 ? [$0.location, $0.length] : nil }
        let oldFade = message.payload["uncorrected"]?.value as? [Int]
        guard message.content != text || fade != oldFade
                || (original != nil && original != originalText(sessionId: sessionId, clientId: clientId))
        else { return }
        message.payload["content"] = AnyCodable(text)
        if let fade { message.payload["uncorrected"] = AnyCodable(fade) }
        else { message.payload.removeValue(forKey: "uncorrected") }
        if let original { message.payload["originalText"] = AnyCodable(original) }
        bucket[clientId] = message
        outbox[sessionId] = bucket
    }

    /// Correction finished: send `text` now. No-op (false) if the user
    /// already deleted it or chose Send Original.
    @discardableResult
    func dispatchStagedInput(sessionId: String, clientId: String, text: String) -> Bool {
        guard isStaged(sessionId: sessionId, clientId: clientId),
              var bucket = outbox[sessionId], var message = bucket[clientId] else { return false }
        message.payload["content"] = AnyCodable(text)
        message.payload.removeValue(forKey: "uncorrected")
        bucket[clientId] = message
        outbox[sessionId] = bucket
        var payload = outboundPayloads[clientId] ?? ["clientId": clientId]
        payload["text"] = text
        outboundPayloads[clientId] = payload
        appState?.sendMetrics.dispatched(clientId)
        // A transient transport refusal queues it (sent on reconnect), like a
        // typed message; only a signed-out app fails it.
        guard isSignedIn else {
            setPendingState(sessionId, clientId: clientId, .failed, cause: "signed_out")
            return false
        }
        if !send(["type": "send_input", "payload": payload], sessionId: sessionId) {
            undispatched.insert(clientId)
        }
        setPendingState(sessionId, clientId: clientId, .sending)
        armConfirmationTimeout(sessionId: sessionId, clientId: clientId)
        persistOutbox()
        return true
    }

    /// Correction could not be confirmed: never send automatically. The bubble
    /// shows `text` (the original transcript) as not delivered; Retry sends it.
    func failStagedInput(sessionId: String, clientId: String, text: String) {
        guard isStaged(sessionId: sessionId, clientId: clientId),
              var bucket = outbox[sessionId], var message = bucket[clientId] else { return }
        message.payload["content"] = AnyCodable(text)
        message.payload["originalText"] = AnyCodable(text)
        message.payload.removeValue(forKey: "uncorrected")
        bucket[clientId] = message
        outbox[sessionId] = bucket
        var payload = outboundPayloads[clientId] ?? ["clientId": clientId]
        payload["text"] = text
        outboundPayloads[clientId] = payload
        setPendingState(sessionId, clientId: clientId, .failed, cause: "correction")
    }

    // MARK: - Delivery state

    func pendingState(_ message: ChatMessage) -> PendingState {
        message.payload["localState"]?.stringValue.flatMap(PendingState.init(rawValue:)) ?? .sending
    }

    private func setPendingState(_ sessionId: String, clientId: String, _ state: PendingState, cause: String? = nil) {
        guard var bucket = outbox[sessionId], var message = bucket[clientId] else { return }
        guard message.payload["localState"]?.stringValue != state.rawValue else { return }
        appState?.sendMetrics.state(clientId, state.rawValue,
                                    cause: cause ?? (state == .unconfirmed ? "stalled" : nil),
                                    inBackground: appState?.isInBackground ?? false)
        #if KRAKI_DIAG
        KrakiDiag.record(.outbox, session: sessionId, [.clientId: .id(clientId), .phase: .tag(state.rawValue)])
        #endif
        message.payload["localState"] = AnyCodable(state.rawValue)
        bucket[clientId] = message
        outbox[sessionId] = bucket
        persistOutbox()
    }

    /// Confirmation is the Tentacle echo. Only *stalled* time counts: the
    /// Relay connection and the target device are up and no inbound traffic is
    /// flowing. An offline device means the input is legitimately queued; a
    /// busy link means the echo is behind a backlog. Halfway through, the input
    /// is re-sent once with the same clientId (idempotent in Tentacle); only
    /// after the full window is it shown as unconfirmed.
    private func armConfirmationTimeout(sessionId: String, clientId: String) {
        confirmationTasks[clientId]?.cancel()
        let timeout = confirmationTimeout
        let step = min(Duration.seconds(1), timeout / 10)
        confirmationTasks[clientId] = Task { @MainActor [weak self] in
            var stalled = Duration.zero
            var resent = false
            while !Task.isCancelled {
                try? await Task.sleep(for: step)
                guard !Task.isCancelled, let self,
                      self.outbox[sessionId]?[clientId] != nil else { return }
                guard self.isDeliveryPathUp(sessionId) else { continue }
                if self.undispatched.contains(clientId) {
                    // Accepted while the path was down: send as soon as it is up.
                    self.redispatch(sessionId: sessionId, clientId: clientId, reason: "path_up")
                    continue
                }
                if self.needsResend.contains(clientId), self.canResendAutomatically(sessionId) {
                    self.needsResend.remove(clientId)
                    if self.redispatch(sessionId: sessionId, clientId: clientId, reason: "uncertain") {
                        self.setPendingState(sessionId, clientId: clientId, .sending)
                        stalled = .zero
                    }
                    continue
                }
                guard !self.isLinkBusy else { continue }
                stalled += step
                if !resent, stalled >= timeout / 2, self.canResendAutomatically(sessionId) {
                    resent = true
                    self.redispatch(sessionId: sessionId, clientId: clientId, reason: "stalled")
                }
                if stalled >= timeout {
                    self.setPendingState(sessionId, clientId: clientId, .unconfirmed)
                    self.confirmationTasks[clientId] = nil
                    return
                }
            }
        }
    }

    /// Automatic re-sends of an input that may already have arrived are safe
    /// only if the session's Tentacle advertised `idempotent_input`.
    private func canResendAutomatically(_ sessionId: String) -> Bool {
        guard let appState else { return false }
        guard let deviceId = appState.sessionStore.sessions[sessionId]?.deviceId else { return false }
        return appState.deviceStore.deviceFeatures[deviceId]?.contains("idempotent_input") == true
    }

    /// An input can eventually be delivered only by a signed-in app. Before
    /// the first authentication of a cold launch the device id is not known
    /// yet, but stored credentials mean it will be.
    private var isSignedIn: Bool {
        guard let appState else { return false }
        #if DEBUG
        if appState.testOutboundMessageHandler != nil { return true }
        #endif
        return appState.deviceId != nil || appState.hasStoredCredentials
    }

    private var isLinkBusy: Bool {
        #if DEBUG
        if appState?.testOutboundMessageHandler != nil { return false }
        #endif
        guard let last = appState?.pulseManager?.lastDeliveryAt else { return false }
        return Date().timeIntervalSince(last) < Self.busyLinkWindow
    }

    /// Hand an existing pending input to transport again (same clientId).
    /// Returns whether transport accepted it.
    @discardableResult
    private func redispatch(sessionId: String, clientId: String, reason: String) -> Bool {
        guard let message = outbox[sessionId]?[clientId] else { return false }
        var payload = outboundPayloads[clientId] ?? ["text": message.content ?? "", "clientId": clientId]
        if payload["text"] == nil { payload["text"] = message.content ?? "" }
        #if KRAKI_DIAG
        KrakiDiag.record(.outbox, session: sessionId, [.clientId: .id(clientId), .phase: .tag("resend_\(reason)")])
        #endif
        guard send(["type": "send_input", "payload": payload], sessionId: sessionId) else {
            undispatched.insert(clientId)
            return false
        }
        undispatched.remove(clientId)
        outboundPayloads[clientId] = payload
        appState?.sendMetrics.retried(clientId, manual: false)
        return true
    }

    /// Re-send every input still waiting for its echo — after this app
    /// (re)authenticates, when a session's Tentacle comes back online, or after
    /// a relaunch. Tentacle deduplicates by clientId and re-echoes, so this is
    /// safe even when the first copy did arrive. Inputs still being corrected
    /// or that failed locally are never sent automatically.
    func resendPendingInputs(sessionId only: String? = nil, deviceId: String? = nil, reason: String) {
        for (sessionId, bucket) in outbox {
            if let only, only != sessionId { continue }
            if let deviceId, appState?.sessionStore.sessions[sessionId]?.deviceId != deviceId { continue }
            for (clientId, message) in bucket.sorted(by: {
                ($0.value.payload["localOrder"]?.intValue ?? 0) < ($1.value.payload["localOrder"]?.intValue ?? 0)
            }) {
                let state = pendingState(message)
                guard state == .sending || state == .unconfirmed else { continue }
                // One never handed to transport is always safe to send. One
                // that was is re-sent only to a Tentacle that deduplicates
                // retries (older ones could run a queued input twice). Either
                // way the armed timer finishes the job if the path, session or
                // Tentacle features are not known yet (e.g. right after launch).
                if undispatched.contains(clientId) {
                    if redispatch(sessionId: sessionId, clientId: clientId, reason: reason) {
                        setPendingState(sessionId, clientId: clientId, .sending)
                    }
                } else if isDeliveryPathUp(sessionId), canResendAutomatically(sessionId) {
                    needsResend.remove(clientId)
                    if redispatch(sessionId: sessionId, clientId: clientId, reason: reason) {
                        setPendingState(sessionId, clientId: clientId, .sending)
                    }
                } else {
                    needsResend.insert(clientId)
                }
                if confirmationTasks[clientId] == nil || state == .unconfirmed {
                    armConfirmationTimeout(sessionId: sessionId, clientId: clientId)
                }
            }
        }
    }

    private func isDeliveryPathUp(_ sessionId: String) -> Bool {
        guard let appState else { return false }
        #if DEBUG
        if appState.testOutboundMessageHandler != nil { return true }
        #endif
        guard appState.isFullyOnline,
              let deviceId = appState.sessionStore.sessions[sessionId]?.deviceId else { return false }
        return appState.deviceStore.devices[deviceId]?.online == true
    }

    /// Resend an unconfirmed input with the SAME clientId (idempotent on the
    /// Tentacle side). Returns false if it could not be handed to transport.
    @discardableResult
    func retryPending(sessionId: String, clientId: String) -> Bool {
        #if KRAKI_DIAG
        KrakiDiag.record(.outbox, session: sessionId, [.clientId: .id(clientId), .phase: .tag("retry")])
        #endif
        guard let message = outbox[sessionId]?[clientId] else { return false }
        var payload = outboundPayloads[clientId] ?? ["text": message.content ?? "", "clientId": clientId]
        if payload["text"] == nil { payload["text"] = message.content ?? "" }
        if outboundPayloads[clientId] == nil, message.payload["delivery"]?.stringValue == "steer" {
            payload["delivery"] = "steer"
        }
        appState?.sendMetrics.retried(clientId, manual: true)
        guard send(["type": "send_input", "payload": payload], sessionId: sessionId) else {
            setPendingState(sessionId, clientId: clientId, .failed, cause: "refused")
            return false
        }
        outboundPayloads[clientId] = payload
        setPendingState(sessionId, clientId: clientId, .sending)
        armConfirmationTimeout(sessionId: sessionId, clientId: clientId)
        return true
    }

    /// Remove an unconfirmed input (Delete). Returns its text.
    @discardableResult
    func discardPending(sessionId: String, clientId: String) -> String? {
        let text = outbox[sessionId]?[clientId]?.content
        appState?.sendMetrics.finished(clientId, .deleted)
        clearPending(sessionId, clientId: clientId)
        return text
    }

    // MARK: - Outbox queries / mutators

    /// Pending placeholders for a session in send order (oldest
    /// first). Used by `ChatViewModel` to append to the turn list at
    /// render time.
    func pendingInputs(_ sessionId: String) -> [ChatMessage] {
        guard let bucket = outbox[sessionId], !bucket.isEmpty else { return [] }
        // Send order is a local monotonic counter; millisecond timestamps
        // alone tie for rapid sends and dictionary order is undefined.
        return bucket.values.sorted {
            let a = $0.payload["localOrder"]?.intValue ?? 0
            let b = $1.payload["localOrder"]?.intValue ?? 0
            if a != b { return a < b }
            return ($0.timestamp ?? "") < ($1.timestamp ?? "")
        }
    }

    /// A history/range replay is also an authoritative confirmation, even if
    /// its live echo was missed. Match session, message type and client ID;
    /// never clear another queued input or infer confirmation from text.
    func confirmPendingInputs(_ sessionId: String, messages: [ChatMessage]) {
        guard outbox[sessionId]?.isEmpty == false else { return }
        // Some history rows inherit sessionId from their batch envelope.
        for message in messages where (message.sessionId == nil || message.sessionId == sessionId)
            && message.type == "user_message" && message.seq > 0 {
            if let clientId = message.payload["clientId"]?.stringValue {
                clearPending(sessionId, clientId: clientId)
            }
        }
    }

    /// Remove a single pending entry by clientId. Called by
    /// `MessageRouter` when the matching `user_message` echo lands;
    /// also called from compose-side retry/cancel UI (when it exists).
    /// No-op if the entry is gone — multi-device echoes or replays
    /// can fire this more than once.
    func clearPending(_ sessionId: String, clientId: String) {
        guard var bucket = outbox[sessionId] else { return }
        guard bucket.removeValue(forKey: clientId) != nil else { return }
        #if KRAKI_DIAG
        KrakiDiag.record(.outbox, session: sessionId, [.clientId: .id(clientId), .phase: .tag("cleared")])
        #endif
        if bucket.isEmpty {
            outbox.removeValue(forKey: sessionId)
        } else {
            outbox[sessionId] = bucket
        }
        confirmationTasks.removeValue(forKey: clientId)?.cancel()
        outboundPayloads.removeValue(forKey: clientId)
        undispatched.remove(clientId)
        needsResend.remove(clientId)
        // No-op when already finished as deleted; otherwise its echo landed.
        appState?.sendMetrics.finished(clientId, .delivered)
        persistOutbox()
    }

    /// Drop every pending entry for a session. Used on logout /
    /// session deletion / explicit cancel-all.
    func clearAllPending(_ sessionId: String) {
        for clientId in (outbox[sessionId].map { Array($0.keys) } ?? []) {
            appState?.sendMetrics.finished(clientId, .cleared)
            confirmationTasks.removeValue(forKey: clientId)?.cancel()
            outboundPayloads.removeValue(forKey: clientId)
        }
        outbox.removeValue(forKey: sessionId)
        persistOutbox()
    }

    // MARK: - Outbox persistence

    private struct StoredPending: Codable {
        let sessionId: String
        let clientId: String
        let timestamp: String?
        let order: Int
        let text: String
        let delivery: String?
        let attachments: [[String: String]]?
        var answerTo: String? = nil
        var state: String? = nil
        var afterSeq: Int? = nil
    }

    /// Pending payload key: the session head seq when the input was written.
    static let afterSeqKey = "localAfterSeq"

    #if DEBUG
    /// Functional tests wait for the actual FIFO boundary, not a disk-speed guess.
    func waitForOutboxWritesForTesting() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            Self.outboxWriteQueue.async { continuation.resume() }
        }
    }
    #endif

    private func persistOutbox() {
        guard let outboxURL else { return }
        var stored: [StoredPending] = []
        for (sessionId, bucket) in outbox {
            for (clientId, message) in bucket {
                let payload = outboundPayloads[clientId]
                let attachments = payload?["attachments"] as? [[String: String]]
                // Keep the durable file small: very large image payloads are
                // retained in memory only.
                let persistedAttachments = (attachments?.reduce(0) { $0 + ($1["data"]?.utf8.count ?? 0) } ?? 0) < 6_000_000
                    ? attachments : nil
                stored.append(StoredPending(
                    sessionId: sessionId,
                    clientId: clientId,
                    timestamp: message.timestamp,
                    order: message.payload["localOrder"]?.intValue ?? 0,
                    // A still-correcting voice input restores as failed with
                    // its original transcript, never a half-corrected one.
                    text: message.payload["originalText"]?.stringValue ?? message.content ?? "",
                    delivery: message.payload["delivery"]?.stringValue,
                    attachments: persistedAttachments,
                    answerTo: message.answerTo,
                    state: message.payload["localState"]?.stringValue,
                    afterSeq: message.payload[Self.afterSeqKey]?.intValue
                ))
            }
        }
        let url = outboxURL
        let data = try? JSONEncoder().encode(stored)
        // Preserve mutation order: a late older write must not resurrect a
        // just-cleared outbox after its newer delete has completed.
        Self.outboxWriteQueue.async {
            if stored.isEmpty {
                try? FileManager.default.removeItem(at: url)
            } else if let data {
                try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                         withIntermediateDirectories: true)
                try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            }
        }
    }

    /// Previously sent inputs return as `sending` and are re-sent automatically
    /// once connected (retry is idempotent by clientId); ones that did land are
    /// removed if the echo is already cached, even without an open chat.
    private func restoreOutbox() {
        guard let outboxURL,
              let data = try? Data(contentsOf: outboxURL),
              let stored = try? JSONDecoder().decode([StoredPending].self, from: data) else { return }
        for item in stored {
            if appState?.messageDatabase.hasConfirmedInput(item.sessionId, clientId: item.clientId) == true { continue }
            #if KRAKI_DIAG
            var diagFields: [DiagField: DiagValue] = [.clientId: .id(item.clientId), .phase: .tag("restored")]
            if let answerTo = item.answerTo { diagFields[.answerTo] = .id(answerTo) }
            KrakiDiag.record(.outbox, session: item.sessionId, diagFields)
            #endif
            var payload: [String: AnyCodable] = [
                "content": AnyCodable(item.text),
                "clientId": AnyCodable(item.clientId),
                "localState": AnyCodable(item.state == "failed" || item.state == "correcting"
                    ? PendingState.failed.rawValue : PendingState.sending.rawValue),
                "localOrder": AnyCodable(item.order),
            ]
            if let delivery = item.delivery { payload["delivery"] = AnyCodable(delivery) }
            if let answerTo = item.answerTo { payload["answerTo"] = AnyCodable(answerTo) }
            if let attachments = item.attachments { payload["attachments"] = AnyCodable(attachments) }
            if let afterSeq = item.afterSeq { payload[Self.afterSeqKey] = AnyCodable(afterSeq) }
            appState?.sendMetrics.restored(
                item.clientId,
                kind: item.state == "correcting" ? .voice : item.answerTo != nil ? .answer
                    : item.delivery == "steer" ? .steer : .typed,
                createdAt: item.timestamp.flatMap { ISO8601.parse($0) },
                failed: item.state == "failed" || item.state == "correcting")
            var bucket = outbox[item.sessionId] ?? [:]
            bucket[item.clientId] = ChatMessage(
                type: "pending_input", seq: 0, sessionId: item.sessionId, deviceId: nil,
                timestamp: item.timestamp, payload: payload)
            outbox[item.sessionId] = bucket
            var wire: [String: Any] = ["text": item.text, "clientId": item.clientId]
            if let delivery = item.delivery { wire["delivery"] = delivery }
            if let answerTo = item.answerTo { wire["answerTo"] = answerTo }
            if let attachments = item.attachments { wire["attachments"] = attachments }
            outboundPayloads[item.clientId] = wire
            nextLocalOrder = max(nextLocalOrder, item.order + 1)
            if item.state != "failed" && item.state != "correcting" {
                needsResend.insert(item.clientId)
                armConfirmationTimeout(sessionId: item.sessionId, clientId: item.clientId)
            }
        }
    }

    // MARK: - Permissions

    // Permission buttons resolve optimistically (`resolvePrompt`); Tentacle's
    // resolved card confirms the decision.
    @discardableResult
    func approve(sessionId: String, permissionId: String) -> Bool {
        resolvePrompt(sessionId: sessionId, promptId: permissionId, decision: "approve") {
            self.send(["type": "approve", "payload": ["permissionId": permissionId]], sessionId: sessionId)
        }
    }

    @discardableResult
    func deny(sessionId: String, permissionId: String, reason: String? = nil) -> Bool {
        var payload: [String: Any] = ["permissionId": permissionId]
        if let reason, !reason.isEmpty {
            payload["reason"] = reason
        }
        return resolvePrompt(sessionId: sessionId, promptId: permissionId, decision: "deny") {
            self.send(["type": "deny", "payload": payload], sessionId: sessionId)
        }
    }

    @discardableResult
    func alwaysAllow(sessionId: String, permissionId: String, toolKind: String? = nil) -> Bool {
        var payload: [String: Any] = ["permissionId": permissionId]
        if let toolKind { payload["toolKind"] = toolKind }
        return resolvePrompt(sessionId: sessionId, promptId: permissionId, decision: "always_allow") {
            self.send(["type": "always_allow", "payload": payload], sessionId: sessionId)
        }
    }

    /// Optimistic permission resolution: show the decision at once (the
    /// bubble stays, its buttons become read-only so a second tap cannot send
    /// again), then either Tentacle's resolved card confirms it, or a transport
    /// failure / missing confirmation reverts it with an explanation.
    private func resolvePrompt(sessionId: String, promptId: String, decision: String,
                               transmit: () -> Bool) -> Bool {
        guard let store = appState?.messageStore else { return transmit() }
        store.applyLocalResolution(sessionId, promptId: promptId, decision: decision)
        guard transmit() else {
            store.revertLocalResolution(sessionId, promptId: promptId,
                                        message: "Couldn't send. Try again.")
            return false
        }
        let timeout = confirmationTimeout
        Task { @MainActor [weak self] in
            while true {
                try? await Task.sleep(for: timeout)
                guard let self, store.isLocalResolutionPending(sessionId, promptId: promptId) else { return }
                if self.isDeliveryPathUp(sessionId) {
                    store.revertLocalResolution(sessionId, promptId: promptId,
                                                message: "Not confirmed by the agent. Try again.")
                    return
                }
            }
        }
        return true
    }

    // MARK: - Questions

    /// Answering is sending a message: a choice is just a shortcut for its
    /// text. The answer lands as a user message (optimistic, retryable,
    /// durable outbox) carrying `answerTo`.
    @discardableResult
    func answer(sessionId: String, questionId: String, answer: String,
                attachments: [ImageAttachment]? = nil) -> Bool {
        #if KRAKI_DIAG
        KrakiDiag.answer(session: sessionId, question: questionId, length: answer.utf8.count,
                         pending: outbox[sessionId]?.values.filter { $0.answerTo == questionId }.count ?? 0,
                         source: "CommandSender.answer")
        #endif
        // One open question takes one answer. A second call while the first is
        // still on its way (two dispatch paths for one click — Mac 0.2.40 sent
        // seq 90 and 91 for one mouse event) must not send a second message.
        // A failed answer can be answered again (its bubble also offers Retry).
        if outbox[sessionId]?.values.contains(where: {
            $0.answerTo == questionId && pendingState($0) != .failed
        }) == true {
            KLog.diag("[Answer] dropped duplicate answer for open question=\(questionId.prefix(12))")
            return true
        }
        return sendInput(sessionId: sessionId, text: answer, attachments: attachments, answerTo: questionId)
    }

    // MARK: - Session Control

    func killSession(sessionId: String) {
        send(["type": "kill_session", "payload": [:] as [String: Any]], sessionId: sessionId)
    }

    @discardableResult
    func abortSession(sessionId: String) -> Bool {
        send(
            ["type": "abort_session", "payload": [:] as [String: Any]],
            sessionId: sessionId,
            connectionScoped: true
        )
    }

    // MARK: - Session Mode

    func setSessionMode(sessionId: String, mode: SessionMode) {
        guard let appState else { return }

        // Track for echo suppression
        pendingModeChanges[sessionId, default: 0] += 1

        send(["type": "set_session_mode", "payload": ["mode": mode.wireName]], sessionId: sessionId)
        appState.sessionStore.setMode(sessionId, mode)
        // Pending permission prompts are resolved by the tentacle, never
        // approved from here.
    }

    /// Consume one pending mode echo. Returns true if this was our own echo.
    func consumeModeEcho(_ sessionId: String) -> Bool {
        guard let count = pendingModeChanges[sessionId], count > 0 else { return false }
        if count == 1 {
            pendingModeChanges.removeValue(forKey: sessionId)
        } else {
            pendingModeChanges[sessionId] = count - 1
        }
        return true
    }

    // MARK: - Session Model

    func setSessionModel(sessionId: String, model: String, reasoningEffort: ReasoningEffort? = nil) {
        guard let appState else { return }

        var payload: [String: Any] = ["model": model]
        if let reasoningEffort { payload["reasoningEffort"] = reasoningEffort.rawValue }
        send(["type": "set_session_model", "payload": payload], sessionId: sessionId)

        // Optimistic update
        appState.sessionStore.setModel(
            sessionId,
            model,
            reasoningEffort: reasoningEffort
        )
    }

    // MARK: - Session Lifecycle

    /// Create a new session. Returns the requestId for tracking. Also
    /// allocates a client-side placeholder session id, navigates to
    /// it immediately so the user sees a "Starting session…" screen
    /// while the tentacle responds. When `session_created` arrives,
    /// the router swaps the placeholder for the real id.
    @discardableResult
    func createSession(
        targetDeviceId: String,
        agentId: AgentId = "copilot",
        model: String,
        reasoningEffort: ReasoningEffort? = nil,
        prompt: String? = nil,
        cwd: String? = nil,
        title: String? = nil
    ) -> String {
        let requestId = "req_" + UUID().uuidString.lowercased()
        let placeholderId = "pending-\(UUID().uuidString.lowercased())"

        if let prompt {
            pendingCreateRequests[requestId] = prompt
        } else {
            pendingCreateRequests[requestId] = ""
        }

        if let title, !title.isEmpty {
            pendingCreateTitles[requestId] = title
        }

        pendingPlaceholderIds[requestId] = placeholderId

        if let appState {
            appState.sessionStore.addPendingSession(placeholderId)
            appState.sessionStore.navigateToSession = placeholderId
            schedulePendingTimeout(requestId: requestId)
        }

        var payload: [String: Any] = [
            "requestId": requestId,
            "targetDeviceId": targetDeviceId,
            "agentId": agentId,
            "model": model,
        ]
        if let reasoningEffort { payload["reasoningEffort"] = reasoningEffort.rawValue }
        // The first message is NOT sent with create_session: Tentacle would
        // hand it straight to the agent without recording it (no user bubble)
        // and resolveCreateRequest sends it again. It is kept here and sent as
        // ordinary input once the session exists.
        if let cwd { payload["cwd"] = cwd }

        send(["type": "create_session", "payload": payload])
        return requestId
    }

    func forkSession(sessionId: String) {
        let requestId = "req_" + UUID().uuidString.lowercased()
        let placeholderId = "pending-\(UUID().uuidString.lowercased())"
        pendingCreateRequests[requestId] = ""
        pendingPlaceholderIds[requestId] = placeholderId
        deferredForks.insert(requestId)

        if let appState {
            appState.sessionStore.addPendingSession(placeholderId)
            let source = appState.sessionStore.sessions[sessionId]
            if let title = source?.title ?? source?.autoTitle, !title.isEmpty {
                appState.sessionStore.pendingSessionTitles[placeholderId] = title.hasPrefix("Fork") ? title : "Fork of \(title)"
            }
            // A fork is usually ready within a round trip: open it directly
            // then. Only a slow fork shows the "Copying…" page first, so the
            // common case has no placeholder flash.
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .milliseconds(450))
                guard let self, self.pendingPlaceholderIds[requestId] == placeholderId,
                      let appState = self.appState, appState.sessionStore.isPending(placeholderId) else { return }
                self.placeholdersShown.insert(placeholderId)
                appState.sessionStore.navigationPushesOnTop = true
                appState.sessionStore.navigateToSession = placeholderId
            }
            schedulePendingTimeout(requestId: requestId)
        }

        send([
            "type": "fork_session",
            "payload": ["requestId": requestId, "sourceSessionId": sessionId],
        ], sessionId: sessionId)
    }

    /// Forks whose placeholder page is deferred (by requestId), and the
    /// placeholders that were actually shown.
    private var deferredForks: Set<String> = []
    private var placeholdersShown: Set<String> = []

    /// Import a local session into the tentacle. The `localSessionId`
    /// also serves as the future session id, so we can mark it
    /// pending and navigate immediately without waiting for a server
    /// response. Picker metadata (cwd / summary / source / model /
    /// branch / startTime) is passed through so the tentacle can skip
    /// re-scanning the filesystem.
    @discardableResult
    func importSession(
        localSessionId: String,
        targetDeviceId: String,
        meta: [String: Any]? = nil
    ) -> String {
        let requestId = "req_" + UUID().uuidString.lowercased()
        pendingCreateRequests[requestId] = ""
        // For import, the localSessionId IS the future session id.
        pendingPlaceholderIds[requestId] = localSessionId

        if let appState {
            appState.sessionStore.addPendingSession(localSessionId)
            appState.sessionStore.navigateToSession = localSessionId
            schedulePendingTimeout(requestId: requestId)
        }

        var payload: [String: Any] = [
            "requestId": requestId,
            "localSessionId": localSessionId,
            "targetDeviceId": targetDeviceId,
        ]
        if let meta { payload["meta"] = meta }

        send(["type": "import_session", "payload": payload])
        return requestId
    }

    /// Per-pending-request timeout. If `session_created` doesn't land
    /// within 30 s, fail the placeholder with a "timed out" error so
    /// the UI doesn't hang forever.
    private func schedulePendingTimeout(requestId: String) {
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(30))
            guard let self,
                  let placeholderId = self.pendingPlaceholderIds[requestId],
                  let appState = self.appState,
                  appState.sessionStore.isPending(placeholderId) else { return }
            appState.sessionStore.setPendingError(
                placeholderId,
                reason: "Request timed out"
            )
            // The computer may still create the session later. Keep the first
            // message so it lands in that session's draft instead of being lost
            // (not sent: the user may already have retried).
            if let prompt = self.pendingCreateRequests[requestId], !prompt.isEmpty {
                self.timedOutCreatePrompts[requestId] = prompt
            }
            self.clearPendingRequest(requestId)
        }
    }

    /// Drop in-flight bookkeeping for a requestId (resolution, error,
    /// or timeout). Does NOT touch the SessionStore's pending entry —
    /// that's owned by router/UI for swap-out logic.
    func clearPendingRequest(_ requestId: String) {
        pendingCreateRequests.removeValue(forKey: requestId)
        pendingCreateTitles.removeValue(forKey: requestId)
        pendingPlaceholderIds.removeValue(forKey: requestId)
    }

    func deleteSession(sessionId: String) {
        guard let appState else { return }
        // Remove local history only once the delete is on its way. If it
        // cannot be sent (offline), the session would come back with the next
        // session list — with its local history already gone.
        guard send(["type": "delete_session", "payload": [:] as [String: Any]], sessionId: sessionId) else {
            appState.lastError = "Couldn't delete the session while offline. Try again when connected."
            return
        }
        appState.sessionStore.removeSession(sessionId)
        appState.messageStore.deleteSessionMessages(sessionId)
    }

    // MARK: - Device Lifecycle

    /// Remove a device from the user's account. Routed through the
    /// command layer (not raw `sendEncryptedMessage`) so it shares the
    /// same connectivity/queue semantics as other commands and won't
    /// silently disappear if the socket is mid-reconnect.
    func removeDevice(deviceId: String) {
        // Relay-terminated: the relay must read it, so it goes as plaintext
        // control. It used to be end-to-end encrypted to the computers, which
        // ignore it, so the relay never removed anything.
        appState?.sendRelayControl(["type": "remove_device", "deviceId": deviceId])
    }

    // MARK: - Local sessions (import picker)

    /// Ask a tentacle for its catalog of importable local sessions.
    /// The tentacle responds with `local_sessions_list` which the
    /// router lands into `deviceStore.localSessions[deviceId]`.
    func requestLocalSessions(
        targetDeviceId: String,
        search: String? = nil,
        liveOnly: Bool = false,
        includeLinked: Bool = false
    ) {
        guard let appState else { return }
        appState.deviceStore.localSessionsLoading.insert(targetDeviceId)
        var filter: [String: Any] = [:]
        if let search, !search.isEmpty { filter["search"] = search }
        if liveOnly { filter["liveOnly"] = true }
        if includeLinked { filter["includeLinked"] = true }
        var payload: [String: Any] = [:]
        if !filter.isEmpty { payload["filter"] = filter }
        send([
            "type": "request_local_sessions",
            "targetDeviceId": targetDeviceId,
            "payload": payload,
        ])
    }

    // MARK: - Read State

    func markRead(sessionId: String, seq: Int, automatic: Bool = false) {
        guard let appState else { return }
        if automatic && appState.sessionStore.isAutoReadSuppressed(sessionId) { return }
        if !automatic { appState.sessionStore.allowAutoRead(sessionId) }
        send(["type": "mark_read", "payload": ["seq": seq]], sessionId: sessionId)
        appState.sessionStore.markRead(sessionId, seq: seq)
    }

    func markUnread(sessionId: String) {
        guard let appState else { return }
        appState.sessionStore.suppressAutoRead(sessionId)
        send(["type": "mark_unread", "payload": [:] as [String: Any]], sessionId: sessionId)
        appState.sessionStore.markUnread(sessionId)
    }

    // MARK: - Session Metadata

    func renameSession(sessionId: String, title: String) {
        guard let appState else { return }
        // Optimistic
        appState.sessionStore.setTitle(sessionId, title: title.isEmpty ? nil : title, autoTitle: nil)
        send(["type": "rename_session", "payload": ["title": title]], sessionId: sessionId)
    }

    // MARK: - Archive (F2)

    func archiveSession(sessionId: String, archived: Bool) {
        send(["type": "archive_session", "payload": ["archived": archived]], sessionId: sessionId)
    }

    /// App-side connection-scoped: not retained for app reconnect replay. A
    /// request already accepted by Head may still be forwarded after reconnect;
    /// the worker coalesces reads and owns the provider cooldown/Retry-After.
    @discardableResult
    func refreshAccountUsage(deviceIds: Set<String>? = nil, automatic: Bool = false,
                             now: Date = Date()) -> Int {
        guard let appState, appState.connectionStatus == .connected else { return 0 }
        let store = appState.deviceStore
        var sent = 0
        for id in store.usageRefreshTargets(deviceIds: deviceIds) where store.canRefreshUsage(id, automatic: automatic, now: now) {
            let requestId = UUID().uuidString
            store.beginUsageRefresh(id, requestId: requestId, now: now)
            guard send(["type": "refresh_account_usage", "targetDeviceId": id,
                        "payload": ["requestId": requestId]], connectionScoped: true) else {
                store.finishUsageRefresh(id, requestId: requestId, error: "connection")
                continue
            }
            sent += 1
            let timeout = usageRefreshTimeout
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: timeout)
                self?.appState?.deviceStore.finishUsageRefresh(id, requestId: requestId, error: "timeout")
            }
        }
        return sent
    }

    /// Ask a computer to update Kraki (remote update). `when`: nil asks first
    /// if sessions are running; "now" stops them; "idle" waits for them.
    @discardableResult
    func updateDevice(_ deviceId: String, when: String? = nil) -> Bool {
        guard let appState else { return false }
        let store = appState.deviceStore
        let requestId = UUID().uuidString
        var payload: [String: Any] = ["requestId": requestId]
        if let when { payload["when"] = when }
        let info = store.deviceUpdates[deviceId]
        store.setUpdateProgress(deviceId, DeviceUpdateProgress(phase: .requested, requestId: requestId, from: info?.current, to: info?.latest))
        guard send(["type": "update_device", "targetDeviceId": deviceId, "payload": payload], connectionScoped: true) else {
            store.setUpdateProgress(deviceId, DeviceUpdateProgress(phase: .failed, requestId: requestId, error: "Not connected."))
            return false
        }
        return true
    }

    func requestArchivedSessions(targetDeviceId: String) {
        send(["type": "request_archived_sessions", "targetDeviceId": targetDeviceId, "payload": [:] as [String: Any]])
    }

    func setAutoArchiveDays(targetDeviceId: String, days: Int) {
        send(["type": "set_auto_archive_days", "targetDeviceId": targetDeviceId, "payload": ["days": days]])
    }

    func deleteArchivedSessions(targetDeviceId: String) {
        guard send(["type": "delete_archived_sessions", "targetDeviceId": targetDeviceId, "payload": [:] as [String: Any]]) else {
            appState?.lastError = "Couldn't delete archived sessions while offline. Try again when connected."
            return
        }
        appState?.sessionStore.archivedSessions[targetDeviceId] = []
    }

    /// Restore an archived session and show it right away; the computer's
    /// next session_list confirms it.
    func openArchivedSession(_ digest: SessionDigest, deviceId: String) {
        guard let appState else { return }
        let name = appState.deviceStore.device(for: deviceId)?.name ?? deviceId
        appState.sessionStore.upsertSession(digest, deviceId: deviceId, deviceName: name)
        appState.sessionStore.archivedSessions[deviceId]?.removeAll { $0.id == digest.id }
        archiveSession(sessionId: digest.id, archived: false)
    }

    func pinSession(sessionId: String, pinned: Bool) {
        guard let appState else { return }
        // Optimistic
        appState.sessionStore.setPinned(sessionId, pinned)
        send(["type": "pin_session", "payload": ["pinned": pinned]], sessionId: sessionId)
    }

    // MARK: - Replay

    /// Ask the tentacle for turn-aligned messages.
    ///
    /// - `beforeSeq == nil` → tentacle anchors at the latest turn and
    ///   extends back through earlier whole turns up to its soft cap.
    ///   This is the "fetch the latest" path.
    /// - `beforeSeq == X`   → tentacle returns the immediate slice of
    ///   prior turns ending at `X - 1`. This is the "page older" path.
    ///
    /// Reply arrives as a `session_messages_batch` envelope and is
    /// handled by `MessageProvider.handleBatch`.
    func requestSessionMessages(sessionId: String, beforeSeq: Int? = nil) {
        var payload: [String: Any] = ["sessionId": sessionId]
        if let beforeSeq { payload["beforeSeq"] = beforeSeq }
        send(["type": "request_session_messages", "payload": payload], sessionId: sessionId)
    }

    /// Ask the tentacle for messages with seq in the exact inclusive
    /// range `[fromSeq, toSeq]`. Reply arrives as a
    /// `session_messages_range_batch` envelope. Used by
    /// `MessageProvider`'s push-gap recovery — turn-aligned fetches
    /// can't address arbitrary seqs.
    func requestSessionMessagesRange(sessionId: String, fromSeq: Int, toSeq: Int) {
        let payload: [String: Any] = [
            "sessionId": sessionId,
            "fromSeq": fromSeq,
            "toSeq": toSeq,
        ]
        send(["type": "request_session_messages_range", "payload": payload], sessionId: sessionId)
    }

    /// Pull one turn's TRACE steps (tool/narration detail) for the "Steps"
    /// popup, keyed by the concluding bubble's spine seq. Reply arrives as a
    /// `turn_trace_batch` envelope → `MessageProvider.handleTurnTraceBatch`.
    func requestTurnTrace(sessionId: String, bubbleSeq: Int) {
        let payload: [String: Any] = ["sessionId": sessionId, "bubbleSeq": bubbleSeq]
        send(["type": "request_turn_trace", "payload": payload], sessionId: sessionId)
    }

    /// Ask for the current status-card snapshot (draft + action slot) on
    /// session-open / reconnect while a turn is in progress. Reply is a
    /// unicast `agent_message_delta`(reset) + `card_action`.
    func requestCard(sessionId: String) {
        send(["type": "request_card", "payload": ["sessionId": sessionId]], sessionId: sessionId)
    }

    /// Resolve every optimistic action whose pulse send seq ≤ `seqUpTo` as
    /// confirmed delivered (the peer acked the frame). Mirrors arm-web's
    /// `resolvePulseAcked`.
    func resolvePulseAcked(seqUpTo: UInt64) {}

    // MARK: - Cleanup

    /// Clean up a failed create request.
    func clearRequest(_ requestId: String) {
        pendingCreateRequests.removeValue(forKey: requestId)
    }

    /// Resolve a create request — correlate the requestId with the created sessionId.
    func resolveCreateRequest(_ requestId: String, sessionId: String) {
        guard let appState else { return }
        if let prompt = timedOutCreatePrompts.removeValue(forKey: requestId) {
            appState.sessionStore.setDraft(sessionId, prompt)
            return
        }
        #if DEBUG
        resolvedCreateSessions[requestId] = sessionId
        #endif
        // Apply pending title (if any) before sending input
        if let title = pendingCreateTitles.removeValue(forKey: requestId), !title.isEmpty {
            renameSession(sessionId: sessionId, title: title)
        }
        // Swap the optimistic placeholder for the real session id, if
        // we had pre-navigated. The router has already inserted the
        // real session into the store; we just need to retire the
        // placeholder entry and re-point navigation.
        if let placeholderId = pendingPlaceholderIds.removeValue(forKey: requestId) {
            // The placeholder route removes its pending mark when the user
            // backs out of "Starting session…". In that case the new Session
            // only appears in the list; it must not pull the user back in.
            // A fork's placeholder is only shown when the fork is slow; if it
            // never was, open the fork as a normal push (nothing to replace).
            let isDeferredFork = deferredForks.remove(requestId) != nil
            let placeholderShown = placeholdersShown.remove(placeholderId) != nil
            let stillOnPlaceholder = appState.sessionStore.isPending(placeholderId)
                && (!isDeferredFork || placeholderShown)
            let openWithoutPlaceholder = isDeferredFork && !placeholderShown
            if placeholderId != sessionId {
                appState.sessionStore.removePendingSession(placeholderId)
            } else {
                // Import path: localSessionId == real sessionId. Drop
                // pending mark now that the session exists for real.
                appState.sessionStore.removePendingSession(sessionId)
            }
            #if os(iOS)
            if stillOnPlaceholder {
                appState.sessionStore.navigationReplacesPlaceholder = true
                appState.sessionStore.navigateToSession = sessionId
            } else if openWithoutPlaceholder {
                appState.sessionStore.navigationPushesOnTop = true
                appState.sessionStore.navigateToSession = sessionId
            }
            #else
            // The sidebar may be scrolled away from the new row (e.g. below
            // many pinned Sessions): bring it into view with a minimal scroll.
            appState.sessionStore.sessionListRevealId = sessionId
            appState.sessionStore.navigateToSession = sessionId
            #endif
        }
        if let prompt = pendingCreateRequests.removeValue(forKey: requestId) {
            // If we had a prompt, send it now
            if !prompt.isEmpty {
                sendInput(sessionId: sessionId, text: prompt)
            }
        }
    }

    /// Mark a pending request as failed (server-side `error` carrying
    /// our `requestId`). Surfaces the reason on the placeholder so the
    /// view can render an error state with Back.
    func failPendingRequest(_ requestId: String, reason: String) {
        guard let appState else { return }
        if let placeholderId = pendingPlaceholderIds.removeValue(forKey: requestId) {
            appState.sessionStore.setPendingError(placeholderId, reason: reason)
            // A fast-failing fork never showed its page: show it now, with
            // the error, so the failure isn't silent.
            if deferredForks.remove(requestId) != nil, placeholdersShown.remove(placeholderId) == nil {
                appState.sessionStore.navigationPushesOnTop = true
                appState.sessionStore.navigateToSession = placeholderId
            }
        }
        pendingCreateRequests.removeValue(forKey: requestId)
        pendingCreateTitles.removeValue(forKey: requestId)
    }

    func reset() {
        confirmationTasks.values.forEach { $0.cancel() }
        confirmationTasks.removeAll()
        outboundPayloads.removeAll()
        outbox.removeAll()
        persistOutbox()
        pendingCreateRequests.removeAll()
        pendingCreateTitles.removeAll()
        pendingPlaceholderIds.removeAll()
        deferredForks.removeAll()
        placeholdersShown.removeAll()
        timedOutCreatePrompts.removeAll()
        pendingModeChanges.removeAll()
        #if DEBUG
        resolvedCreateSessions.removeAll()
        #endif
    }
}
