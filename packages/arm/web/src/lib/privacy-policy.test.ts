import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const policy = readFileSync('public/privacy/index.html', 'utf8');

it('publishes a standalone, bilingual, accessible policy without app/login/scripts', () => {
  expect(policy).toContain('<title>Privacy Policy — Kraki</title>');
  expect(policy).toContain('id="en" lang="en"');
  expect(policy).toContain('id="zh" lang="zh-CN"');
  expect(policy).toContain('mailto:corelli@corelli.cloud');
  expect(policy).not.toMatch(/<script\b|<iframe\b|<form\b/i);
  expect(policy).not.toMatch(/(?:src|href)="(?:http:|javascript:)/i);
});

it('distinguishes encryption, gateway context, opt-out, usage and deletion limitations', () => {
  for (const phrase of ['not all end-to-end encrypted', 'Custom Words are not end-to-end encrypted',
    'Doubao / Volcengine', 'AssemblyAI, which processes audio in the United States', 'as recognition hints', 'DeepSeek', 'unless you also turn off', 'heuristic, not a guarantee',
    'not anonymous', 'not controlled by Share Performance Data', '35 calendar days',
    '14 days from receipt', 'not a promise of simultaneous erasure', 'Google Fonts']) {
    expect(policy).toContain(phrase);
  }
});

it('names the speech provider per region in both languages', () => {
  expect(policy).toContain('the mainland China region uses Doubao / Volcengine');
  expect(policy).toContain('中国大陆区域使用豆包／火山引擎');
  expect(policy).toContain('日本和美国区域使用 AssemblyAI（在美国处理音频）');
  expect(policy.match(/assemblyai\.com\/legal\/privacy-policy/g)).toHaveLength(2);
});
