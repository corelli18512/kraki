/**
 * Speech-provider selection for the production adapter. Dependency-free so it
 * can be tested without the deployed @coinfra/voice bundle.
 */

export const ASR_PROVIDER_NAMES = ['doubao', 'assemblyai'];

/** `ASR_PROVIDERS`: ordered failover list, e.g. `assemblyai,doubao`. Default `doubao`. */
export function asrProviderOrder(raw) {
  const names = (raw?.trim() || 'doubao')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const unknown = names.filter((name) => !ASR_PROVIDER_NAMES.includes(name));
  if (unknown.length) throw new Error(`ASR_PROVIDERS: unknown provider ${unknown.join(', ')}`);
  if (new Set(names).size !== names.length) throw new Error('ASR_PROVIDERS: duplicate provider');
  return names;
}
