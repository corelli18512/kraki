import { describe, it, expect } from 'vitest';
import { timeAgo, formatTime, capitalize, agentInfo, truncate } from '../lib/format';

describe('format utilities', () => {
  describe('timeAgo', () => {
    it('returns "just now" for recent timestamps', () => {
      const now = new Date().toISOString();
      expect(timeAgo(now)).toBe('just now');
    });

    it('returns minutes ago', () => {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      expect(timeAgo(fiveMinAgo)).toBe('5m ago');
    });

    it('returns hours ago', () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      expect(timeAgo(twoHoursAgo)).toBe('2h ago');
    });

    it('returns days ago', () => {
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      expect(timeAgo(threeDaysAgo)).toBe('3d ago');
    });

    it('handles edge case at 59 seconds', () => {
      const t = new Date(Date.now() - 59 * 1000).toISOString();
      expect(timeAgo(t)).toBe('just now');
    });

    it('handles edge case at 60 seconds', () => {
      const t = new Date(Date.now() - 60 * 1000).toISOString();
      expect(timeAgo(t)).toBe('1m ago');
    });
  });

  describe('formatTime', () => {
    it('formats time as 24-hour HH:MM without AM/PM', () => {
      const result = formatTime('2026-03-18T14:30:00.000Z');
      expect(result).toMatch(/^\d{2}:\d{2}$/);
      expect(result).not.toMatch(/[AP]M/i);
    });
  });

  describe('capitalize', () => {
    it('capitalizes first letter', () => {
      expect(capitalize('hello')).toBe('Hello');
    });

    it('handles single character', () => {
      expect(capitalize('a')).toBe('A');
    });

    it('handles empty string', () => {
      expect(capitalize('')).toBe('');
    });

    it('preserves rest of string', () => {
      expect(capitalize('hELLO')).toBe('HELLO');
    });
  });

  describe('agentInfo', () => {
    it('returns correct info for copilot', () => {
      const info = agentInfo('copilot');
      expect(info.label).toBe('Copilot');
      expect(info.emoji).toBe('🤖');
      expect(info.color).toContain('blue');
    });

    it('returns correct info for claude', () => {
      const info = agentInfo('claude');
      expect(info.label).toBe('Claude');
      expect(info.emoji).toBe('🧠');
      expect(info.color).toContain('orange');
    });

    it('returns correct info for codex', () => {
      const info = agentInfo('codex');
      expect(info.label).toBe('Codex');
      expect(info.emoji).toBe('⚡');
      expect(info.color).toContain('green');
    });

    it('handles case-insensitive matching', () => {
      expect(agentInfo('Copilot').label).toBe('Copilot');
      expect(agentInfo('CLAUDE').label).toBe('Claude');
    });

    it('returns fallback for unknown agents', () => {
      const info = agentInfo('myagent');
      expect(info.label).toBe('Myagent');
      expect(info.emoji).toBe('🔮');
      expect(info.color).toContain('purple');
    });
  });

  describe('truncate', () => {
    it('returns original string when shorter than max', () => {
      expect(truncate('hello', 10)).toBe('hello');
    });

    it('returns original string when equal to max', () => {
      expect(truncate('hello', 5)).toBe('hello');
    });

    it('truncates with ellipsis when longer than max', () => {
      expect(truncate('hello world', 5)).toBe('hell…');
    });

    it('truncates long strings', () => {
      const long = 'a'.repeat(100);
      const result = truncate(long, 10);
      expect(result.length).toBe(10);
      expect(result.endsWith('…')).toBe(true);
    });
  });
});
