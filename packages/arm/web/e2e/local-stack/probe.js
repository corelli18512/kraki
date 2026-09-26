// Frame probe for the Web chat list: per animation frame, where every rendered
// row is on screen. Analysed in Node: blank gaps, rows vanishing and coming
// back (flashes), and on-screen jumps of rows that stay rendered.
window.__kprobe = (() => {
  const frames = [];
  let running = false;
  const tick = () => {
    if (!running) return;
    const scroller = document.querySelector('.kchat-list');
    if (scroller) {
      const box = scroller.getBoundingClientRect();
      const dock = document.querySelector('.kcomposer-dock')?.getBoundingClientRect();
      const rows = [];
      for (const el of scroller.querySelectorAll('[data-row-key]')) {
        const r = el.getBoundingClientRect();
        if (r.bottom < box.top || r.top > box.bottom) continue;
        const bubble = el.querySelector('.kbubble');
        rows.push({ key: el.dataset.rowKey, top: Math.round(r.top - box.top), h: Math.round(r.height), bubble: bubble ? Math.round(bubble.getBoundingClientRect().height) : 0 });
      }
      const st0 = window.__krakiStore?.getState(); const sid = location.pathname.split('/session/')[1];
      const dbg = st0 && sid ? { card: (st0.cards.get(sid)?.action?.type ?? '-') + ':' + ((st0.cards.get(sid)?.text ?? '').length), state: st0.sessions.get(sid)?.state } : null;
      frames.push({ dbg, t: performance.now(), st: Math.round(scroller.scrollTop), sh: scroller.scrollHeight, vh: Math.round(box.height), dockTop: dock ? Math.round(dock.top - box.top) : null, rows });
    }
    requestAnimationFrame(tick);
  };
  return {
    start() { frames.length = 0; running = true; requestAnimationFrame(tick); },
    stop() { running = false; return frames; },
  };
})();
