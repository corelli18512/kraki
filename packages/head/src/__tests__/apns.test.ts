import { describe, expect, it } from 'vitest';
import { buildApnsPayload } from '../push/apns.js';

describe('buildApnsPayload', () => {
  it('requests the notification service extension with sound and an attention badge', () => {
    const payload = JSON.parse(buildApnsPayload({ blob: 'ciphertext', key: 'wrapped-key' }));

    expect(payload).toEqual({
      aps: {
        alert: { title: 'Kraki', body: 'Open Kraki to view the update.' },
        sound: 'default',
        badge: 1,
        'mutable-content': 1,
      },
      kraki: { blob: 'ciphertext', key: 'wrapped-key' },
    });
  });

  it('keeps sound and badge in the privacy-preserving fallback', () => {
    const payload = JSON.parse(buildApnsPayload());

    expect(payload).toEqual({
      aps: {
        alert: { title: 'Kraki', body: 'Open Kraki to view the update.' },
        sound: 'default',
        badge: 1,
      },
    });
  });
});
