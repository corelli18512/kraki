/**
 * Public library API for the voice broker — re-exports the pieces that
 * other packages (notably integration tests and future arm/iOS bindings)
 * need to consume. The CLI entry point lives in `cli.ts` and is what the
 * `bin` field installs.
 */

export { startBroker } from './server.js';
export type { BrokerOptions, BrokerServer } from './server.js';
export { verifyLease } from './lease-verifier.js';
export type { VerifyInput, VerifyOk, VerifyFail, VerifyReason } from './lease-verifier.js';
