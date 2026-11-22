import { describe, it, expect } from 'vitest';
import { readableProviderError } from '../provider-error.js';
import { TurnTracker } from '../turn-tracker.js';

describe('readableProviderError (K-170)', () => {
  it('keeps the provider sentence and status of a raw HTTP JSON body (Pi 429)', () => {
    expect(readableProviderError(
      `429: {"message":"You've hit your usage limit. Try again later.","type":"usage_limit_reached"}`,
    )).toBe("You've hit your usage limit. Try again later. (HTTP 429)");
  });

  it('reads nested error.message bodies (Anthropic/OpenAI shape)', () => {
    expect(readableProviderError(
      '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    )).toBe('invalid x-api-key (HTTP 401)');
    expect(readableProviderError('{"error":{"message":"Rate limit reached"}}')).toBe('Rate limit reached');
  });

  it('leaves everything else unchanged', () => {
    for (const text of [
      'Claude AI usage limit reached|1760000000',
      'Invalid API key - Please run /login',
      'Tool failed with {"a":1}',
      '429: {not json}',
      '500: {"code":17}',
    ]) {
      expect(readableProviderError(text)).toBe(text);
    }
  });

  it('a failed turn reports the readable text', () => {
    const errors: string[] = [];
    const tracker = new TurnTracker({
      onError: (_s: string, e: { message: string }) => { errors.push(e.message); },
      onIdle: () => {},
    }, 's1');
    tracker.beginTurn();
    tracker.setError('429: {"message":"Usage limit reached","type":"usage_limit_reached"}');
    tracker.finish();
    expect(errors).toEqual(['Usage limit reached (HTTP 429)']);
  });
});
