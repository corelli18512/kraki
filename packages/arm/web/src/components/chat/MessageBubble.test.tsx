import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { MessageBubble } from './MessageBubble';
import type { ChatMessage } from '../../types/store';

function renderMsg(message: ChatMessage) {
  return render(<MemoryRouter><MessageBubble message={message} /></MemoryRouter>);
}

function makeMsg(type: string, payload: Record<string, unknown>, extra?: Record<string, unknown>): ChatMessage {
  return {
    type,
    deviceId: 'dev-1',
    seq: 1,
    timestamp: '2026-03-18T12:00:00.000Z',
    sessionId: 'sess-1',
    payload,
    ...extra,
  } as ChatMessage;
}

describe('MessageBubble', () => {
  describe('user_message', () => {
    it('renders user message content', () => {
      renderMsg(makeMsg('user_message', { content: 'Hello agent!' }));
      expect(screen.getByText('Hello agent!')).toBeInTheDocument();
    });

    it('renders timestamp', () => {
      renderMsg(makeMsg('user_message', { content: 'test' }));
      expect(screen.getByText(/\d{1,2}:\d{2}/)).toBeInTheDocument();
    });
  });

  describe('agent_message', () => {
    it('renders agent message content', () => {
      renderMsg(makeMsg('agent_message', { content: 'Here is my analysis' }));
      expect(screen.getByText('Here is my analysis')).toBeInTheDocument();
    });

    it('renders markdown in agent message', () => {
      renderMsg(makeMsg('agent_message', { content: '**bold text**' }));
      const bold = screen.getByText('bold text');
      expect(bold.tagName).toBe('STRONG');
    });

    it('renders agent emoji icon', () => {
      const { container } = renderMsg(makeMsg('agent_message', { content: 'test' }));
      // agentInfo('') returns fallback emoji 🔮
      expect(container.textContent).toContain('🔮');
    });
  });

  describe('session_created', () => {
    it('renders session start message with agent name', () => {
      renderMsg(makeMsg('session_created', { agent: 'copilot' }));
      expect(screen.getByText(/Copilot session started/)).toBeInTheDocument();
    });

    it('renders model name when present', () => {
      renderMsg(makeMsg('session_created', { agent: 'claude', model: 'claude-4' }));
      expect(screen.getByText('(claude-4)')).toBeInTheDocument();
    });

    it('renders without model when absent', () => {
      renderMsg(makeMsg('session_created', { agent: 'codex' }));
      expect(screen.getByText(/Codex session started/)).toBeInTheDocument();
    });
  });

  describe('session_ended', () => {
    it('renders session end with reason', () => {
      renderMsg(makeMsg('session_ended', { reason: 'completed' }));
      expect(screen.getByText(/Session ended — completed/)).toBeInTheDocument();
    });
  });

  describe('tool_start', () => {
    it('renders tool start with name', () => {
      renderMsg(makeMsg('tool_start', { toolName: 'shell', args: { command: 'ls' } }));
      expect(screen.getByText('shell')).toBeInTheDocument();
      expect(screen.getByText(/shell/)).toBeInTheDocument();
    });
  });

  describe('tool_complete', () => {
    it('renders tool complete with name', () => {
      renderMsg(makeMsg('tool_complete', { toolName: 'read_file', args: { path: 'a.ts' }, result: 'content' }));
      expect(screen.getByText('read_file')).toBeInTheDocument();
    });
  });

  describe('error', () => {
    it('renders error message', () => {
      renderMsg(makeMsg('error', { message: 'Something went wrong' }));
      expect(screen.getByText('Error')).toBeInTheDocument();
      expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    });
  });

  describe('send_input', () => {
    it('renders sent input text', () => {
      renderMsg(makeMsg('send_input', { text: 'User typed this' }));
      expect(screen.getByText('User typed this')).toBeInTheDocument();
    });

    it('renders timestamp', () => {
      renderMsg(makeMsg('send_input', { text: 'test' }));
      expect(screen.getByText(/\d{1,2}:\d{2}/)).toBeInTheDocument();
    });
  });

  describe('permission', () => {
    it('renders permission request details', () => {
      renderMsg(makeMsg('permission', {
        id: 'p1', toolName: 'shell', args: { command: 'rm -rf' }, description: 'Delete files',
      }));
      expect(screen.getByText(/Permission requested/)).toBeInTheDocument();
      expect(screen.getByText('Delete files')).toBeInTheDocument();
      expect(screen.getByText('shell')).toBeInTheDocument();
    });

    it('renders approved resolution with description', () => {
      renderMsg(makeMsg('permission', {
        id: 'p2', toolName: 'shell', args: { command: 'npm test' }, description: 'Run: npm test', resolution: 'approved',
      }));
      expect(screen.getByText(/Approved/)).toBeInTheDocument();
      expect(screen.getByText('shell')).toBeInTheDocument();
      expect(screen.getByText('Run: npm test')).toBeInTheDocument();
    });

    it('renders denied resolution', () => {
      renderMsg(makeMsg('permission', {
        id: 'p3', toolName: 'shell', args: { command: 'rm -rf /' }, description: 'Run: rm -rf /', resolution: 'denied',
      }));
      expect(screen.getByText(/Denied/)).toBeInTheDocument();
      expect(screen.getByText('shell')).toBeInTheDocument();
    });

    it('renders always_allowed resolution', () => {
      renderMsg(makeMsg('permission', {
        id: 'p4', toolName: 'shell', args: { command: 'ls' }, description: 'Run: ls', resolution: 'always_allowed',
      }));
      expect(screen.getByText(/Allowed for session/)).toBeInTheDocument();
      expect(screen.getByText('shell')).toBeInTheDocument();
    });
  });

  describe('question', () => {
    it('renders question text', () => {
      renderMsg(makeMsg('question', { id: 'q1', question: 'Which framework?', choices: ['React', 'Vue'] }));
      expect(screen.getByText('Question')).toBeInTheDocument();
      expect(screen.getByText('Which framework?')).toBeInTheDocument();
    });
  });

  describe('approve', () => {
    it('renders nothing (resolution is on the permission bubble)', () => {
      const { container } = renderMsg(makeMsg('approve', { permissionId: 'perm-abcdef12' }));
      expect(container.firstChild).toBeNull();
    });
  });

  describe('deny', () => {
    it('renders nothing (resolution is on the permission bubble)', () => {
      const { container } = renderMsg(makeMsg('deny', { permissionId: 'perm-abcdef12' }));
      expect(container.firstChild).toBeNull();
    });
  });

  describe('always_allow', () => {
    it('renders nothing (resolution is on the permission bubble)', () => {
      const { container } = renderMsg(makeMsg('always_allow', { permissionId: 'perm-abcdef12' }));
      expect(container.firstChild).toBeNull();
    });
  });

  describe('answer', () => {
    it('renders answer text', () => {
      renderMsg(makeMsg('answer', { questionId: 'q1', answer: 'PostgreSQL' }));
      expect(screen.getByText('Answer')).toBeInTheDocument();
      expect(screen.getByText('PostgreSQL')).toBeInTheDocument();
    });
  });

  describe('kill_session', () => {
    it('renders kill session action', () => {
      renderMsg(makeMsg('kill_session', {}));
      expect(screen.getByText('Session killed')).toBeInTheDocument();
    });

    it('renders kill session without timestamp', () => {
      // Create message without timestamp to cover the fallback branch
      const msg = {
        type: 'kill_session',
        deviceId: 'dev-1',
        seq: 1,
        sessionId: 'sess-1',
        payload: {},
      } as ChatMessage;
      renderMsg(msg);
      expect(screen.getByText('Session killed')).toBeInTheDocument();
    });
  });

  describe('unknown type', () => {
    it('returns null for unknown message type', () => {
      const { container } = renderMsg(makeMsg('unknown_type', {}) as ChatMessage);
      expect(container.firstChild).toBeNull();
    });
  });
});
