import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { minimatch } from 'minimatch';

export interface ScopeModel {
  provider: string;
  model: string;
  name?: string;
}

/** Device capabilities use Pi's user settings, not an arbitrary project's
 * (trust-gated) .pi/settings.json. Resolve the env override just as Pi does. */
export function piSettingsPath(): string {
  const override = process.env.PI_CODING_AGENT_DIR;
  const dir = override?.startsWith('~/') ? join(homedir(), override.slice(2)) : override;
  return join(dir || join(homedir(), '.pi', 'agent'), 'settings.json');
}

/** Undefined/empty means all, matching Pi. Malformed settings throw so callers
 * can retain the last valid preference instead of silently exposing all models. */
export function readPiModelScope(): string[] | undefined {
  let text: string;
  try { text = readFileSync(piSettingsPath(), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const settings = JSON.parse(text);
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid Pi settings');
  const scope: unknown = settings.enabledModels;
  if (scope === undefined) return undefined;
  if (!Array.isArray(scope) || !scope.every(p => typeof p === 'string')) throw new Error('Invalid Pi enabledModels');
  return scope;
}

const thinkingLevels = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** Pi scope semantics: exact provider/id (never cross-provider), then fuzzy
 * ID/name with alias/latest preference; globs expand in catalog order. Thinking
 * suffixes do not change model IDs. Retain configured order and deduplicate. */
export function scopePiModels<T extends ScopeModel>(models: readonly T[], patterns: readonly string[] | undefined): T[] {
  if (!patterns?.length) return [...models];
  const result: T[] = [];
  const key = (m: T) => `${m.provider}/${m.model}`;
  const exact = (pattern: string): T | undefined => {
    const canonical = models.filter(m => key(m).toLowerCase() === pattern.trim().toLowerCase());
    if (canonical.length === 1) return canonical[0];
    const bare = models.filter(m => m.model.toLowerCase() === pattern.trim().toLowerCase());
    return bare.length === 1 ? bare[0] : undefined;
  };
  const match = (pattern: string): T | undefined => {
    const found = exact(pattern);
    if (found) return found;
    const candidates = models.filter(m => m.model.toLowerCase().includes(pattern.toLowerCase()) || m.name?.toLowerCase().includes(pattern.toLowerCase()));
    const aliases = candidates.filter(m => !/-\d{8}$/.test(m.model));
    return (aliases.length ? aliases : candidates).sort((a, b) => b.model.localeCompare(a.model))[0];
  };
  const resolve = (pattern: string): T | undefined => {
    const found = match(pattern);
    if (found) return found;
    const colon = pattern.lastIndexOf(':');
    return colon < 0 ? undefined : resolve(pattern.slice(0, colon));
  };
  for (const pattern of patterns) {
    let matches: T[];
    if (/[*?[]/.test(pattern)) {
      const colon = pattern.lastIndexOf(':');
      const glob = colon >= 0 && thinkingLevels.has(pattern.slice(colon + 1)) ? pattern.slice(0, colon) : pattern;
      const found = exact(glob);
      matches = found ? [found] : models.filter(m => minimatch(key(m), glob, { nocase: true }) || minimatch(m.model, glob, { nocase: true }));
    } else {
      const found = resolve(pattern);
      matches = found ? [found] : [];
    }
    for (const model of matches) if (!result.some(m => key(m) === key(model))) result.push(model);
  }
  // A configured scope with no matches must NOT expand to all providers.
  return result;
}
