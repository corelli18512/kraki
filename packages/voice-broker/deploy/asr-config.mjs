/**
 * Speech-provider selection for the production adapter. Dependency-free so it
 * can be tested without the deployed @coinfra/voice bundle.
 *
 * One provider per region, no cross-provider failover: a region's voice
 * gateway is simply that region's implementation.
 */

export const ASR_PROVIDER_NAMES = ['doubao', 'assemblyai'];

/** `ASR_PROVIDER`: `doubao` (default) or `assemblyai`. */
export function asrProvider(env) {
  if (env.ASR_PROVIDERS !== undefined) {
    throw new Error('ASR_PROVIDERS (failover list) was removed: set ASR_PROVIDER to one provider');
  }
  const name = (env.ASR_PROVIDER?.trim() || 'doubao').toLowerCase();
  if (!ASR_PROVIDER_NAMES.includes(name)) throw new Error(`ASR_PROVIDER: unknown provider ${name}`);
  return name;
}
