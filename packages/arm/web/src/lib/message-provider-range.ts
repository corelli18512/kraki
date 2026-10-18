import type { ChatMessage } from '../types/store';

/** Missing integer intervals inside an already displayed window (never below it). */
export function missingIntervals(messages: ChatMessage[], from: number, to: number): Array<[number, number]> {
  const seqs = [...new Set(messages.flatMap(message => {
    const seq = 'seq' in message ? message.seq : undefined;
    return typeof seq === 'number' && Number.isInteger(seq) && seq >= from && seq <= to ? [seq] : [];
  }))].sort((a, b) => a - b);
  const gaps: Array<[number, number]> = [];
  let next = from;
  for (const seq of seqs) {
    if (next < seq) gaps.push([next, seq - 1]);
    next = seq + 1;
  }
  if (next <= to) gaps.push([next, to]);
  return gaps;
}

/** An authoritative (even empty) response settles its requested interval. */
export function excludeInterval(intervals: Array<[number, number]>, from: number, to: number): Array<[number, number]> {
  return intervals.flatMap(([lo, hi]): Array<[number, number]> => {
    if (hi < from || lo > to) return [[lo, hi]];
    const remaining: Array<[number, number]> = [];
    if (lo < from) remaining.push([lo, from - 1]);
    if (hi > to) remaining.push([to + 1, hi]);
    return remaining;
  });
}
