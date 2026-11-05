import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ChatScroller } from './ChatScroller';

// K-212: the conversation can be focused (Tab) and scrolled with the keyboard,
// and is announced as a named region. WebKit cannot focus a plain scroller.
it('the conversation scroller is a focusable, named region (K-212)', () => {
  render(<ChatScroller rows={[{ key: '1' }]} renderRow={(row) => <p>{row.key}</p>} topInset={0} bottomInset={0} />);
  const region = screen.getByRole('region', { name: 'Conversation history' });
  expect(region).toHaveAttribute('data-chat-scroll');
  expect(region.tabIndex).toBe(0);
});
