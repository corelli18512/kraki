import { act, render, screen } from '@testing-library/react';
import { beforeEach, expect, it } from 'vitest';
import { useStore } from '../../hooks/useStore';
import { ChatAnnouncer } from './ChatAnnouncer';

beforeEach(() => {
  useStore.getState().reset();
  useStore.getState().setDevices([{ id: 'd', name: 'Mac', role: 'tentacle', online: true }]);
  useStore.getState().upsertSession({ id: 's', deviceId: 'd', agent: 'pi', state: 'active', messageCount: 1 });
});

// K-212: a screen reader hears that the open conversation got a reply or needs
// the user, not only sighted users watching the bubbles.
it('announces a reply and a permission request in the open conversation, not the state it opened in (K-212)', () => {
  useStore.getState().setSessionPreview('s', { text: 'Old reply', type: 'agent', timestamp: '' });
  render(<ChatAnnouncer sessionId="s" />);
  const live = screen.getByTestId('chat-announcer');
  expect(live).toHaveAttribute('aria-live', 'polite');
  expect(live).toHaveTextContent('');
  act(() => {
    useStore.getState().upsertSession({ ...useStore.getState().sessions.get('s')!, state: 'idle' });
    useStore.getState().setSessionPreview('s', { text: 'Tests pass now.', type: 'agent', timestamp: '' });
  });
  expect(live).toHaveTextContent('Last message from agent: Tests pass now.');
  act(() => { useStore.getState().setSessionPreview('s', { text: 'Run npm test?', type: 'permission', timestamp: '' }); });
  expect(live).toHaveTextContent('Waiting for approval: Run npm test?');
});
