import { render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatScroller } from './ChatScroller';

const realMatchMedia = window.matchMedia;
afterEach(() => { window.matchMedia = realMatchMedia; });

function primaryPointer(kind: 'fine' | 'coarse') {
  window.matchMedia = vi.fn((query: string) => ({ ...realMatchMedia(query), matches: query === `(pointer: ${kind})` })) as typeof window.matchMedia;
}

function renderScroller() {
  render(<ChatScroller rows={[{ key: '1' }]} renderRow={(row) => <p>{row.key}</p>} topInset={0} bottomInset={0} />);
  return screen.getByRole('region', { name: 'Conversation history' });
}

// K-212: the conversation can be focused (Tab) and scrolled with the keyboard,
// and is announced as a named region. WebKit cannot focus a plain scroller.
it('the conversation scroller is a focusable, named region (K-212)', () => {
  primaryPointer('fine');
  const region = renderScroller();
  expect(region).toHaveAttribute('data-chat-scroll');
  expect(region.tabIndex).toBe(0);
});

// A tap on message text would focus the scroller and close the keyboard.
it('on a touch screen the scroller is not focusable (U3)', () => {
  primaryPointer('coarse');
  const region = renderScroller();
  expect(region).not.toHaveAttribute('tabindex');
});
