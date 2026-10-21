// ------------------------------------------------------------
// Kraki Protocol — Message types and envelopes
// ------------------------------------------------------------
//
// The relay is a thin encrypted forwarder. It never reads message
// content — only the envelope fields visible to it.
//
// Two envelope directions:
//   Unicast   — app → specific tentacle (has `to` field)
//   Broadcast — tentacle → all devices (has optional `notify`)
//
// Inner messages (ProducerMessage / ConsumerMessage) are encrypted
// inside the blob and only visible to endpoints after decryption.
//
// Reliable per-hop delivery (seq / ack / resume / durable) is handled by
// the pulse layer, framed in the `pulse` envelope field — see
// PulseFrameField below. It does not interact with the per-session
// application seq inside the encrypted blob.
// ------------------------------------------------------------

import type { DeviceSummary, DeviceRole, DeviceInfo, DeviceCapabilities, PushProviderType } from './devices.js';
import type { SessionSummary, SessionDigest, SessionMode, SessionUsage } from './sessions.js';
import type { ToolArgs } from './tools.js';
import { type ConsumerMessage } from './consumer-messages.js';
import { type ControlMessage } from './control-messages.js';
import { type RelayEnvelope } from './envelopes.js';
import { type ProducerMessage } from './history-messages.js';
export { type ImageAttachment, type ContentRef, type Attachment } from './attachments.js';
export { type GithubTokenAuth, type GithubOAuthAuth, type PairingAuth, type ChallengeAuth, type ApiKeyAuth, type OpenAuth, type AuthMethod } from './auth-methods.js';
export { type SendInputMessage, type ApproveMessage, type DenyMessage, type AlwaysAllowMessage, type KillSessionMessage, type AbortSessionMessage, type CreateSessionMessage, type SetSessionModeMessage, type SetSessionModelMessage, type DeleteSessionMessage, type ForkSessionMessage, type MarkReadMessage, type RequestSessionReplayMessage, type RenameSessionMessage, type PinSessionMessage, type ArchiveSessionMessage, type RequestArchivedSessionsMessage, type DeleteArchivedSessionsMessage, type SetAutoArchiveDaysMessage, type MarkUnreadMessage, type RequestLocalSessionsMessage, type ImportSessionMessage, type RequestAttachmentMessage, type RequestUsageHistoryMessage, type ConsumerMessage } from './consumer-messages.js';
export { type AuthMessage, type AuthOkMessage, type AuthErrorCode, type AuthErrorMessage, isAcceptableRegionRedirect, type AuthChallengeMessage, type AuthResponseMessage, type ServerErrorMessage, type RequestPairingTokenMessage, type PairingTokenCreatedMessage, type CreatePairingTokenMessage, type AuthInfoRequest, type AuthInfoResponse, type DeviceJoinedMessage, type DeviceLeftMessage, type DevicePendingMessage, type RemoveDeviceMessage, type DeleteAccountMessage, type AccountDeletedMessage, ACCOUNT_DELETED_CLOSE_CODE, DEVICE_REPLACED_CLOSE_CODE, type DeviceRemovedMessage, type RenameDeviceMessage, type DeviceRenamedMessage, type UpdatePreferencesMessage, type PreferencesUpdatedMessage, type VoiceWord, type VoiceWordOp, type UpdateVoiceVocabularyMessage, type VoiceVocabularyUpdatedMessage, type RegisterPushTokenMessage, type PushTokenRegisteredMessage, type NotificationPreviewMessage, type UnregisterPushTokenMessage, type DispatchPushMessage, type ControlMessage } from './control-messages.js';
export { type PulseFrameField, HEAD_PULSE_TARGET, HEAD_CONTROL_TYPES, PULSE_SENDER_FIELD, type UnicastEnvelope, type MulticastEnvelope, type BroadcastEnvelope, type RelayEnvelope, type BlobPayload, type PingMessage, type PongMessage } from './envelopes.js';
export { type RequestSessionMessagesMessage, type SessionMessagesBatchMessage, type RequestSessionMessagesRangeMessage, type SessionMessagesRangeBatchMessage, type TraceEntry, type RequestTurnTraceMessage, type RequestCardMessage, type TurnTraceBatchMessage, type ClientFeaturesMessage, type SetSessionSubscriptionMessage, type SessionLiveSnapshot, type SessionSubscriptionSetMessage, type SessionListMessage, type ArchivedSessionListMessage, type PermissionResolvedMessage, type SessionPinnedMessage, type SessionReadMessage, type LocalSessionsListMessage, type AttachmentDataMessage, type ProducerMessage } from './history-messages.js';
export { type SessionCreatedMessage, type SessionEndedMessage, type UserMessage, type AgentMessage, type AgentMessageDelta, type PermissionRequest, type SubagentInfo, type ToolStartMessage, type ToolCompleteMessage, type AgentNarrationMessage, type CardActionState, type CardAction, type CompactingMessage, type IdleMessage, type ActiveMessage, type ErrorMessage, type SystemMessage, type InterruptedTurnMessage, type TurnStatusMessage, type SessionModeSetMessage, type SessionModelSetMessage, type SessionDeletedMessage, type SessionTitleUpdatedMessage, type DeviceGreetingMessage, type KrakiInstallMethod, type DeviceUpdateInfo } from './producer-messages.js';
export { type AccountUsageWindowKind, type AccountUsageWindow, type AccountUsage, type LocalNotificationMessage, type DeviceUsageMessage, type UsageHistorySample, type RefreshAccountUsageMessage, type UpdateDeviceMessage, type DeviceUpdatePhase, type DeviceUpdateStatusMessage, type UsageHistoryMessage, type SessionReplayBatchMessage } from './usage-messages.js';

// ============================================================
// Union of all messages
// ============================================================

/** Inner message (decrypted from blob) */
export type InnerMessage = ProducerMessage | ConsumerMessage;

/** Everything that flows over the WebSocket */
export type Message = RelayEnvelope | ControlMessage;

// Re-export types used in control messages
export type { DeviceSummary, DeviceRole, DeviceInfo, DeviceCapabilities, PushProviderType, SessionSummary, SessionDigest, SessionMode, SessionUsage, ToolArgs };

