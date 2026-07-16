# Superseded Protocol Draft

This English draft has been superseded by the reviewed single-session protocol proposal:

- [`session-subscription-protocol-proposal.zh-CN.md`](./session-subscription-protocol-proposal.zh-CN.md)

The authoritative v2 proposal intentionally removes:

- capability negotiation and mixed-version compatibility;
- plural session subscriptions;
- `targetDeviceId` from the encrypted inner request;
- subscription epoch and generation;
- a dedicated `SessionAttentionMessage`.

The accepted direction is a single current `sessionId | null`, a serialized page-entry request/ACK/snapshot assurance flow, existing `session_list[].preview` for online permission/question attention, independent offline push dispatch, and Head-visible opaque target-set multicast.
