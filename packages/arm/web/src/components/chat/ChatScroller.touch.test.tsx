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

  it('K-105: a page prepended during the fling keeps the reader on the same row (WebKit drops scrollTop writes mid-momentum)', async () => {
    const ROW = 100;
    const older = Array.from({ length: 10 }, (_, i) => ({ key: `o${i + 1}` }));
    let top = 2_000;
    let coasting = false;
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const key = this.dataset.scrollKey;
      if (key === undefined) return DOMRect.fromRect({ x: 0, y: 0, width: 400, height: 800 });
      const index = [...this.parentElement!.children].indexOf(this);
      return DOMRect.fromRect({ x: 0, y: index * ROW - top, width: 400, height: ROW });
    });
    try {
      const view = (list: { key: string }[]) => <ChatScroller rows={list} renderRow={(row) => <p>{row.key}</p>} topInset={0} bottomInset={0} />;
      const { container, rerender } = render(view(rows));
      const el = container.querySelector<HTMLDivElement>('[data-chat-scroll]')!;
      let count = rows.length;
      Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => count * ROW + 800 });
      Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 800 });
      Object.defineProperty(el, 'scrollTop', {
        configurable: true,
        get: () => top,
        // Model of the WebKit behaviour: while momentum coasts a write is
        // lost unless the momentum has been stopped (overflow hidden).
        set: (v: number) => { if (!coasting || el.style.overflowY === 'hidden') top = v; },
      });
      const scrollTo = (value: number) => { top = value; fireEvent.scroll(el); };
      scrollTo(1_000);
      fireEvent.touchStart(el, { touches: [{ clientY: 100 }] });
      fireEvent.touchMove(el, { touches: [{ clientY: 180 }] });
      scrollTo(900);
      fireEvent.touchEnd(el, { touches: [] });
      coasting = true;
      scrollTo(500); // reading row 6 at the top
      count = rows.length + older.length;
      rerender(view([...older, ...rows]));
      expect(top).toBe(500 + older.length * ROW);
      await frame();
      expect(el.style.overflowY).toBe('');
    } finally { rect.mockRestore(); }
  });
});
