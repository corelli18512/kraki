/**
 * @kraki/pulse — the delivery contract.
 *
 * Message sequencing, acks, and cursor-based resume for a breakable WebSocket
 * channel. Pure logic, no I/O in the core ({@link Endpoint}); bring your own
 * transport and storage. Every implementation (this one and the Swift port)
 * shares the byte-exact wire format in `spec/FIXTURES.md`.
 *
 * This package assumes NO application context: it moves opaque payload bytes
 * between two peers and guarantees in-order, exactly-once delivery — or makes
 * loss explicit via {@link Effect} `reset-inbound`. It does not know about
 * sessions, message types, users, or encryption. Wrap it however you like.
 */

export { Endpoint } from './endpoint.js';
export {
  decodeFrame,
  encodeFrame,
  type Frame,
  FrameType,
  MAGIC,
  VERSION,
} from './wire.js';
export {
  DEFAULT_PARAMS,
  type Effect,
  type EndpointOptions,
  LinkState,
  type Millis,
  type Payload,
  type PulseParams,
  type Seq,
  type Snapshot,
} from './types.js';
export { PulseSocket, type PulseSocketOptions } from './adapter-ws.js';
export {
  fromUtf8,
  isReliableType,
  packPulsePlaintext,
  type PulseEnvelope,
  RELIABLE_TYPES,
  tryUnpackPulse,
  utf8,
} from './kraki.js';
