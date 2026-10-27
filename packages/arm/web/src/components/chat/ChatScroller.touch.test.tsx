import { act, fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatScroller } from './ChatScroller';

const rows = Array.from({ length: 20 }, (_, i) => ({ key: `${i + 1}` }));
const frame = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 40)));

function mount() {
  const onNearTop = vi.fn();
  const { container } = render(
    <ChatScroller rows={rows} renderRow={(row) => <p>{row.key}</p>} topInset={0} bottomInset={0} onNearTop={onNearTop} />,
  );
  const el = container.querySelector<HTMLDivElement>('[data-chat-scroll]')!;
  let top = 3_000;
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 10_000 });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 800 });
  Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => { top = v; } });
  const scrollTo = (value: number) => { top = value; fireEvent.scroll(el); };
  return { el, onNearTop, scrollTo };
}

describe('ChatScroller touch momentum', () => {
  it('a fling toward older rows that coasts into the top band pages older', async () => {
    const { el, onNearTop, scrollTo } = mount();
    scrollTo(3_000);
    fireEvent.touchStart(el, { touches: [{ clientY: 100 }] });
    fireEvent.touchMove(el, { touches: [{ clientY: 160 }] });
    scrollTo(2_900);
    fireEvent.touchEnd(el, { touches: [] });
    await frame(); // the finger is off: only momentum moves it now
    scrollTo(2_000);
    scrollTo(1_200);
    expect(onNearTop).not.toHaveBeenCalled();
    scrollTo(600);
    expect(onNearTop).toHaveBeenCalled();
  });

  it('momentum ends with the first newer movement; a later geometry decrease does not page', async () => {
    const { el, onNearTop, scrollTo } = mount();
    scrollTo(3_000);
    fireEvent.touchStart(el, { touches: [{ clientY: 100 }] });
    fireEvent.touchMove(el, { touches: [{ clientY: 160 }] });
    fireEvent.touchEnd(el, { touches: [] });
    await frame();
    scrollTo(2_000);
    scrollTo(2_050); // newer: the fling is over
    await frame();
    scrollTo(500);
    expect(onNearTop).not.toHaveBeenCalled();
  });

  it('momentum that has stopped no longer authorizes paging', async () => {
    const { el, onNearTop, scrollTo } = mount();
    scrollTo(3_000);
    fireEvent.touchStart(el, { touches: [{ clientY: 100 }] });
    fireEvent.touchMove(el, { touches: [{ clientY: 160 }] });
    fireEvent.touchEnd(el, { touches: [] });
    await frame();
    scrollTo(2_000);
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 400)));
    scrollTo(500); // a geometry correction long after the fling came to rest
    expect(onNearTop).not.toHaveBeenCalled();
  });

  it('a fling toward newer rows never pages older', async () => {
    const { el, onNearTop, scrollTo } = mount();
    scrollTo(1_500);
    fireEvent.touchStart(el, { touches: [{ clientY: 160 }] });
    fireEvent.touchMove(el, { touches: [{ clientY: 100 }] });
    fireEvent.touchEnd(el, { touches: [] });
    await frame();
    scrollTo(500);
    expect(onNearTop).not.toHaveBeenCalled();
  });
});
