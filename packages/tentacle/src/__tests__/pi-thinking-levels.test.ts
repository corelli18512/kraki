/**
 * Unit tests for the pi adapter's thinking-level ladder.
 *
 * pi's ladder is off|minimal|low|medium|high|xhigh|max and `max` is a rung of its
 * own — on Anthropic's adaptive-thinking models it is the only one that reaches
 * the top effort. The adapter used to fold `max` into `xhigh` and advertise one
 * fixed ladder for every model, so the top rung was unreachable and models were
 * credited with rungs pi then clamped away. These tests pin the per-model
 * derivation (a mirror of pi-ai's `getSupportedThinkingLevels`) and the mapping.
 */

import { describe, it, expect } from 'vitest';
import {
  defaultEffortFor,
  effortToThinking,
  FALLBACK_EFFORTS,
  piThinkingLevelsFor,
  type PiCatalogModel,
} from '../adapters/pi.js';

const model = (over: Partial<PiCatalogModel>): PiCatalogModel => ({
  id: 'm', provider: 'p', reasoning: true, ...over,
});

describe('effortToThinking — Kraki effort → pi ThinkingLevel', () => {
  it('passes every rung through by name', () => {
    expect(effortToThinking('low')).toBe('low');
    expect(effortToThinking('medium')).toBe('medium');
    expect(effortToThinking('high')).toBe('high');
    expect(effortToThinking('xhigh')).toBe('xhigh');
  });

  it('keeps max as its own rung rather than folding it into xhigh', () => {
    expect(effortToThinking('max')).toBe('max');
  });

  it('returns undefined for an unset or unknown effort', () => {
    expect(effortToThinking(undefined)).toBeUndefined();
    expect(effortToThinking('ultra')).toBeUndefined();
  });
});

describe('piThinkingLevelsFor — per-model rungs from the catalog', () => {
  it('offers nothing for a non-reasoning model', () => {
    expect(piThinkingLevelsFor(model({ reasoning: false }))).toEqual([]);
  });

  it('treats xhigh and max as opt-in — absent from the map means absent', () => {
    // e.g. anthropic/claude-haiku-4-5: reasoning, but no map at all.
    expect(piThinkingLevelsFor(model({}))).toEqual(['low', 'medium', 'high']);
  });

  it('grants xhigh and max only when the map declares them', () => {
    // e.g. anthropic/claude-opus-5 and claude-fable-5.
    expect(piThinkingLevelsFor(model({
      thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
    }))).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('honours a max-without-xhigh model', () => {
    // e.g. zai/glm-5.2: adaptive max, no native xhigh.
    expect(piThinkingLevelsFor(model({
      thinkingLevelMap: { minimal: null, low: 'high', medium: 'high', high: 'high', max: 'max' },
    }))).toEqual(['low', 'medium', 'high', 'max']);
  });

  it('drops rungs the map nulls out', () => {
    // e.g. 1yuan-gpt/gpt-5.6-luna: everything above low is unavailable.
    expect(piThinkingLevelsFor(model({
      thinkingLevelMap: { off: 'low', minimal: 'low', low: 'low', medium: null, high: null, xhigh: null },
    }))).toEqual(['low']);
  });

  it('never surfaces off or minimal — Kraki has no such rung', () => {
    const levels = piThinkingLevelsFor(model({ thinkingLevelMap: { off: null } }));
    expect(levels).not.toContain('off');
    expect(levels).not.toContain('minimal');
  });
});

describe('defaultEffortFor', () => {
  it('defaults to high when the model has it', () => {
    expect(defaultEffortFor(['low', 'medium', 'high', 'xhigh', 'max'])).toBe('high');
  });

  it('walks down to the strongest available rung below high', () => {
    expect(defaultEffortFor(['low'])).toBe('low');
    expect(defaultEffortFor(['low', 'medium'])).toBe('medium');
  });

  it('is undefined when the model has no rungs at all', () => {
    expect(defaultEffortFor([])).toBeUndefined();
  });

  it('keeps the pre-existing default for the fallback ladder', () => {
    expect(defaultEffortFor(FALLBACK_EFFORTS)).toBe('high');
  });
});
