import type { Config, DOMPurify } from 'dompurify';

/** Serialized into the sandbox. Keep all implementation inside this function. */
export function installReportPreviewRuntime(purifier: DOMPurify | null, policy: Config, hasMermaid: boolean): void {
  const doc = document;
  // No native link default action, even if a URL is changed after preparation.
  const fragments = new WeakMap<Element, string>();
  doc.querySelectorAll('a').forEach((anchor) => {
    const href = anchor.getAttribute('href') || anchor.getAttribute('xlink:href');
    if (href?.startsWith('#')) fragments.set(anchor, href.slice(1));
    anchor.removeAttribute('href');
    anchor.removeAttribute('xlink:href');
    anchor.setAttribute('role', 'link');
    anchor.setAttribute('tabindex', '0');
  });
  const activate = (event: Event) => {
    const target = event.target instanceof Element ? event.target.closest('a') : null;
    if (!target) return;
    event.preventDefault();
    const fragment = fragments.get(target);
    if (!fragment) return;
    let id = fragment;
    try { id = decodeURIComponent(fragment); } catch { return; }
    doc.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  doc.addEventListener('click', activate, true);
  doc.addEventListener('auxclick', (event) => event.preventDefault(), true);
  doc.addEventListener('keydown', (event) => { if (event.key === 'Enter') activate(event); }, true);
  doc.addEventListener('submit', (event) => event.preventDefault(), true);

  doc.querySelectorAll('[data-panzoom]').forEach((shell) => {
    const viewport = shell.querySelector<HTMLElement>('.diagram-viewport');
    const canvas = shell.querySelector<HTMLElement>('.diagram-canvas');
    if (!(viewport instanceof HTMLElement) || !(canvas instanceof HTMLElement)) return;
    let scale = 1, x = 0, y = 0;
    let pointer: number | null = null;
    let startX = 0, startY = 0;
    const render = () => { canvas.style.transform = `translate(${x}px,${y}px) scale(${scale})`; };
    const zoom = (next: number, cx = viewport.clientWidth / 2, cy = viewport.clientHeight / 2) => {
      next = Math.max(0.55, Math.min(3.5, next));
      const ratio = next / scale;
      x = cx - (cx - x) * ratio;
      y = cy - (cy - y) * ratio;
      scale = next;
      render();
    };
    shell.querySelectorAll('button[data-action]').forEach((button) => {
      button.addEventListener('click', () => {
        switch (button.getAttribute('data-action')) {
          case 'in': zoom(scale * 1.2); break;
          case 'out': zoom(scale / 1.2); break;
          case 'fit': case 'reset': scale = 1; x = 0; y = 0; render(); break;
        }
      });
    });
    viewport.addEventListener('wheel', (event) => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      zoom(scale * (event.deltaY < 0 ? 1.12 : 0.89), event.clientX - rect.left, event.clientY - rect.top);
    }, { passive: false });
    viewport.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      pointer = event.pointerId;
      startX = event.clientX - x; startY = event.clientY - y;
      viewport.classList.add('dragging');
      viewport.setPointerCapture(event.pointerId);
    });
    viewport.addEventListener('pointermove', (event) => {
      if (event.pointerId !== pointer) return;
      x = event.clientX - startX; y = event.clientY - startY; render();
    });
    const stop = () => { pointer = null; viewport.classList.remove('dragging'); };
    viewport.addEventListener('pointerup', stop);
    viewport.addEventListener('pointercancel', stop);
    render();
  });

  if (!hasMermaid || !purifier) return;
  const mermaid = (window as unknown as { mermaid: {
    initialize: (config: unknown) => void;
    render: (id: string, source: string) => Promise<{ svg: string }>;
  } }).mermaid;
  mermaid.initialize({
    startOnLoad: false, securityLevel: 'strict', htmlLabels: false,
    flowchart: { htmlLabels: false }, suppressErrorRendering: true,
    secure: ['secure', 'securityLevel', 'startOnLoad', 'htmlLabels', 'flowchart', 'suppressErrorRendering'],
  });
  const renderIdPrefix = 'kraki-preview-mermaid-' + Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  let index = 0;
  for (const block of doc.querySelectorAll('pre.mermaid, div.mermaid, code.language-mermaid')) {
    const source = block.textContent || '';
    // Preview accepts diagrams, not report-controlled configuration or interactions.
    // Keep unsupported source visible; never evaluate directives/frontmatter/click bindings.
    if (/%%\{|^\s*---|\bclick\b/i.test(source)) continue;
    const id = `${renderIdPrefix}-${index++}`;
    void mermaid.render(id, source).then(({ svg }) => {
      const safe = purifier.sanitize(svg, { ...policy, WHOLE_DOCUMENT: false, RETURN_DOM_FRAGMENT: true });
      // Mermaid output has no navigation or resource URL privileges either.
      safe.querySelectorAll('a').forEach((anchor) => {
        anchor.removeAttribute('href'); anchor.removeAttribute('xlink:href');
      });
      safe.querySelectorAll('[href], [xlink\\:href], [src]').forEach((element) => {
        for (const name of ['href', 'xlink:href', 'src']) {
          const value = element.getAttribute(name);
          if (value !== null && !/^#[^\s\u0000-\u001f]*$/.test(value)) element.removeAttribute(name);
        }
      });
      block.replaceChildren(safe);
      block.setAttribute('data-kraki-mermaid', 'rendered');
    }).catch(() => { /* Invalid diagrams remain readable source. */ });
  }
}
