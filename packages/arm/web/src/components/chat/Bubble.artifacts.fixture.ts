// Focused desired-invariant variants of rows-phase1 rows-F6/F7.
// Fixtures only: projection and rendering are production spineRows + Bubble.
import type { ContentRef, SystemMessage } from '@kraki/protocol';
import type { ChatMessage } from '../../types/store';
import { spineRows, rowKey } from '../../lib/chat/spine';
import type { ChatRow } from './Bubble';

export const sessionId = 'isolated-bubble-artifacts';
export const reportTarget = 'http://127.0.0.1:9/report-canary-not-fetched';
export const report: ContentRef = { type: 'content_ref', id: 'loopback-report-canary', mimeType: 'text/html', size: 100, caption: 'Isolated report' };
export const image = { type: 'image' as const, mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' };
export const imageRef: ContentRef = { type: 'content_ref', id: '6b1048f8a6d40bac0b2954c18fefa40c', mimeType: 'image/png', size: 68, caption: 'Projected image' };
function message(type: string, seq: number, payload: Record<string, unknown>): ChatMessage {
  return { type, sessionId, deviceId: 'fixture-device', seq, timestamp: '2026-10-15T00:00:00Z', payload } as ChatMessage;
}
const prompt = message('user_message', 1, { content: 'Initial prompt' });
function projectedSystem(kind: string, content = '', existing = false, artifacts = [report, imageRef]) {
  return [prompt, message('system_message', 17, { kind, content, steps: 3, ...(existing ? { attachments: artifacts } : {}) }), message('idle', 18, { turnArtifacts: artifacts })];
}
function assistant(content: string, attachments: unknown[], steps = 1) {
  return [prompt, message('agent_message', 17, { content, attachments, steps })];
}
// anchorStepsOnlyTurn emits { kind: 'no_reply' }; modern RelayClient.send
// stamps steps, but the protocol also permits historical unstamped records.
// Omit the property entirely for legacy input rather than supplying a count.
export const stepCountCases = [
  { label: 'missing', payload: {} },
  { label: 'zero', payload: { steps: 0 } },
  { label: 'negative', payload: { steps: -1 } },
];
const noReplyMediaCases = [
  { label: 'report', artifacts: [report], reports: 1, images: 0 },
  { label: 'image', artifacts: [imageRef], reports: 0, images: 1 },
  { label: 'both', artifacts: [report, imageRef], reports: 1, images: 1 },
];
function noReplyInput(count: (typeof stepCountCases)[number], content?: string): ChatMessage {
  const payload: SystemMessage['payload'] = { kind: 'no_reply', ...count.payload, ...(content ? { content } : {}) };
  return message('system_message', 17, payload);
}
export const scenarios = [
  ...stepCountCases.flatMap((count) => [
    ...noReplyMediaCases.map((media) => ({
      id: `no-reply-${count.label}-${media.label}`,
      raw: [prompt, noReplyInput(count), message('idle', 18, { turnArtifacts: media.artifacts })],
      reports: media.reports, images: media.images, steps: true, prose: '',
    })),
    { id: `no-reply-${count.label}-plain`, raw: [prompt, noReplyInput(count)], reports: 0, images: 0, steps: true, prose: '' },
    { id: `no-reply-${count.label}-prose`, raw: [prompt, noReplyInput(count, 'Completed'), message('idle', 18, { turnArtifacts: [report, imageRef] })], reports: 1, images: 1, steps: false, prose: 'Completed' },
    { id: `agent-${count.label}-control`, raw: [prompt, message('agent_message', 17, { content: 'Ordinary reply', attachments: [report, image], ...count.payload })], reports: 1, images: 1, steps: false, prose: 'Ordinary reply' },
  ]),
  { id: 'plain-no-reply', raw: [prompt, message('system_message', 17, { kind: 'no_reply', steps: 3 })], reports: 0, images: 0, steps: true, prose: '' },
  { id: 'no-reply-projected', raw: projectedSystem('no_reply'), reports: 1, images: 1, steps: true, prose: '' },
  { id: 'no-reply-image-only', raw: projectedSystem('no_reply', '', false, [imageRef]), reports: 0, images: 1, steps: true, prose: '' },
  { id: 'no-reply-report-only', raw: projectedSystem('no_reply', '', false, [report]), reports: 1, images: 0, steps: true, prose: '' },
  { id: 'notice-projected', raw: projectedSystem('notice', 'Heads up'), reports: 1, images: 1, steps: true, prose: 'Heads up' },
  { id: 'no-reply-prose', raw: projectedSystem('no_reply', 'Completed'), reports: 1, images: 1, steps: true, prose: 'Completed' },
  { id: 'no-duplicate-refs', raw: projectedSystem('no_reply', '', true), reports: 1, images: 1, steps: true, prose: '' },
  { id: 'blank-notice-media', raw: projectedSystem('notice'), reports: 1, images: 1, steps: true, prose: '' },
  { id: 'image-only', raw: assistant('', [image]), reports: 0, images: 1, steps: true, prose: '' },
  { id: 'prose-image', raw: assistant('Image result', [image]), reports: 0, images: 1, steps: true, prose: 'Image result' },
  { id: 'report-only', raw: assistant('', [report]), reports: 1, images: 0, steps: true, prose: '' },
  { id: 'ordinary-media', raw: assistant('Ordinary reply', [report, image]), reports: 1, images: 1, steps: true, prose: 'Ordinary reply' },
  { id: 'no-trace-image', raw: assistant('', [image], 0), reports: 0, images: 1, steps: false, prose: '' },
  { id: 'question-control', raw: [prompt, message('agent_message', 17, { content: 'Please choose.', question: { id: 'q', text: 'Which color?', choices: ['Amber', 'Teal'] }, steps: 1 })], reports: 0, images: 0, steps: true, prose: 'Please choose.' },
  { id: 'notice-control', raw: [prompt, message('system_message', 17, { kind: 'notice', content: 'Notice' })], reports: 0, images: 0, steps: false, prose: 'Notice' },
];
export function rowsFor(raw: ChatMessage[]): ChatRow[] {
  return spineRows(raw, [], true).map((item) => ({ kind: 'spine', key: rowKey(item), item }));
}
