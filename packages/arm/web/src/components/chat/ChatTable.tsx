/**
 * Chat tables — the Mac/iOS ChatTable design (6a83a59f) for the Web:
 *
 * - a half size below body text, semibold secondary header, tabular
 *   right-aligned numbers, cell Markdown rendered; one rounded frame, header
 *   tint, row rules only;
 * - a table wider than the bubble scrolls sideways with the first column
 *   pinned and an edge fade;
 * - bubbles preview 8 rows with a footer ("Showing 8 of 60 rows · 14
 *   columns   Open table");
 * - the full table opens in a window: search (highlighted matches, Enter for
 *   next), header sort, Copy Markdown / Copy TSV.
 */
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import { jsx, jsxs } from 'react/jsx-runtime';
import type { Element, ElementContent, Root } from 'hast';
import { Search, X } from 'lucide-react';

export const PREVIEW_ROW_LIMIT = 8;

type Align = 'left' | 'right' | 'center';

export interface TableModel {
  header: ElementContent[][];
  body: ElementContent[][][];
  plainHeader: string[];
  plainBody: string[][];
  align: Align[];
  numeric: boolean[];
  columnCount: number;
}

function textOf(nodes: ElementContent[]): string {
  let out = '';
  for (const n of nodes) {
    if (n.type === 'text') out += n.value;
    else if (n.type === 'element') out += textOf(n.children);
  }
  return out;
}

const childrenOf = (el: Element, tag: string): Element[] =>
  el.children.filter((c): c is Element => c.type === 'element' && c.tagName === tag);

const NUMERIC = /^[~≈<>≤≥]?\s?[+\-−±]?[$€£¥]?\s?\d[\d,\s]*(\.\d+)?\s?(%|‰|[kKMBGT]B?|ms|µs|ns|s|m|h|d|x|×|★|pt|px)?$/;

export function isNumericCell(text: string): boolean {
  const plain = text.replace(/[*`]/g, '').trim();
  return plain.length > 0 && plain.length <= 24 && NUMERIC.test(plain);
}

export function isNumericColumn(cells: string[]): boolean {
  const filled = cells.map((c) => c.trim()).filter((c) => c && !['—', '-', '–', 'N/A', 'n/a', 'NA', '?'].includes(c));
  if (filled.length === 0) return false;
  return filled.filter(isNumericCell).length / filled.length >= 0.75;
}

/** hast <table> → model (cells keep their inline Markdown). */
export function tableModel(table: Element): TableModel {
  const rows: Element[] = [];
  for (const section of table.children) {
    if (section.type !== 'element') continue;
    if (section.tagName === 'tr') rows.push(section);
    else rows.push(...childrenOf(section, 'tr'));
  }
  const cellsOf = (tr: Element) => tr.children.filter((c): c is Element => c.type === 'element' && (c.tagName === 'td' || c.tagName === 'th'));
  const headerCells = rows[0] ? cellsOf(rows[0]) : [];
  const bodyRows = rows.slice(1).map(cellsOf);
  const columnCount = Math.max(headerCells.length, ...bodyRows.map((r) => r.length), 0);
  const pad = <T,>(arr: T[], fill: T) => (arr.length >= columnCount ? arr.slice(0, columnCount) : [...arr, ...Array(columnCount - arr.length).fill(fill)]);
  const header = pad(headerCells.map((c) => c.children), [] as ElementContent[]);
  const body = bodyRows.map((r) => pad(r.map((c) => c.children), [] as ElementContent[]));
  const plainHeader = header.map(textOf);
  const plainBody = body.map((r) => r.map(textOf));
  const numeric = Array.from({ length: columnCount }, (_, c) => isNumericColumn(plainBody.map((r) => r[c] ?? '')));
  const explicit = headerCells.map((c) => {
    const a = (c.properties?.align ?? (c.properties?.style as string | undefined)?.match(/text-align:\s*(\w+)/)?.[1]) as string | undefined;
    return a === 'right' || a === 'center' || a === 'left' ? a : undefined;
  });
  // GFM cannot say "unspecified": numbers read best right-aligned unless the
  // author centered them.
  const align = Array.from({ length: columnCount }, (_, c): Align => {
    const e = explicit[c];
    if (e === 'center' || e === 'right') return e;
    return numeric[c] ? 'right' : 'left';
  });
  return { header, body, plainHeader, plainBody, align, numeric, columnCount };
}

function renderCell(nodes: ElementContent[], components: Record<string, unknown>): ReactNode {
  const root: Root = { type: 'root', children: nodes };
  return toJsxRuntime(root, { Fragment, jsx, jsxs, components: components as never, passKeys: true });
}

type SortKey = { kind: 'number'; v: number } | { kind: 'text'; v: string } | { kind: 'empty' };
function sortKey(text: string): SortKey {
  const t = text.replace(/[*`]/g, '').trim();
  if (!t || ['—', '-', '–', 'N/A', 'n/a'].includes(t)) return { kind: 'empty' };
  const n = Number(t.replace(/[,\s$€£¥%~≈<>≤≥]/g, '').replace('−', '-').replace(/[a-zA-Z×★‰µ]+$/, ''));
  return Number.isFinite(n) && isNumericCell(t) ? { kind: 'number', v: n } : { kind: 'text', v: t.toLowerCase() };
}
function compare(a: string, b: string): number {
  const ka = sortKey(a), kb = sortKey(b);
  if (ka.kind === 'empty' || kb.kind === 'empty') return ka.kind === kb.kind ? 0 : ka.kind === 'empty' ? 1 : -1;
  if (ka.kind === 'number' && kb.kind === 'number') return ka.v - kb.v;
  return String(ka.v).localeCompare(String(kb.v), undefined, { numeric: true });
}

export function toMarkdown(model: TableModel, order?: number[]): string {
  const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const rows = (order ?? model.plainBody.map((_, i) => i)).map((i) => model.plainBody[i]);
  const sep = model.align.map((a) => (a === 'right' ? '---:' : a === 'center' ? ':---:' : '---'));
  return [model.plainHeader, sep, ...rows].map((r, i) => `| ${(i === 1 ? r : r.map(esc)).join(' | ')} |`).join('\n');
}

export function toTSV(model: TableModel, order?: number[]): string {
  const clean = (s: string) => s.replace(/[\t\n]/g, ' ');
  const rows = (order ?? model.plainBody.map((_, i) => i)).map((i) => model.plainBody[i]);
  return [model.plainHeader, ...rows].map((r) => r.map(clean).join('\t')).join('\n');
}

function Grid({ model, components, rows, sticky, sort, onSort, highlight, current }: {
  model: TableModel;
  components: Record<string, unknown>;
  rows: number[];
  sticky?: boolean;
  sort?: { column: number; ascending: boolean } | null;
  onSort?: (column: number) => void;
  highlight?: (row: number, column: number) => boolean;
  current?: { row: number; column: number } | null;
}) {
  return (
    <table className={sticky ? 'ktable-grid is-sticky' : 'ktable-grid'}>
      <thead>
        <tr>
          {model.header.map((cell, c) => (
            <th
              key={c}
              style={{ textAlign: model.align[c] }}
              className={onSort ? 'is-sortable' : undefined}
              onClick={onSort ? () => onSort(c) : undefined}
              aria-sort={sort?.column === c ? (sort.ascending ? 'ascending' : 'descending') : undefined}
            >
              {renderCell(cell, components)}
              {sort?.column === c && <span className="ktable-arrow">{sort.ascending ? '↑' : '↓'}</span>}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r}>
            {model.body[r].map((cell, c) => {
              const hit = highlight?.(r, c);
              const isCurrent = current?.row === r && current.column === c;
              return (
                <td
                  key={c}
                  style={{ textAlign: model.align[c] }}
                  className={[model.numeric[c] ? 'is-num' : '', hit ? 'is-hit' : '', isCurrent ? 'is-current' : ''].filter(Boolean).join(' ') || undefined}
                  data-cell={isCurrent ? 'current' : undefined}
                >
                  {renderCell(cell, components)}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Horizontal scroller with the right-edge fade while more is to the right. */
function SideScroll({ children, onOverflow }: { children: ReactNode; onOverflow?: (overflows: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ left: false, right: false });
  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const overflows = el.scrollWidth > el.clientWidth + 1;
    setFade({ left: el.scrollLeft > 1, right: overflows && el.scrollLeft + el.clientWidth < el.scrollWidth - 1 });
    onOverflow?.(overflows);
  }, [onOverflow]);
  useLayoutEffect(() => {
    update();
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [update]);
  return (
    <div className={`ktable-scroll${fade.left ? ' fade-left' : ''}${fade.right ? ' fade-right' : ''}`}>
      <div ref={ref} className="ktable-scroller" onScroll={update}>{children}</div>
    </div>
  );
}

function TableWindow({ model, components, onClose }: { model: TableModel; components: Record<string, unknown>; onClose: () => void }) {
  const [sort, setSort] = useState<{ column: number; ascending: boolean } | null>(null);
  const [query, setQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const order = useMemo(() => {
    const idx = model.plainBody.map((_, i) => i);
    if (!sort) return idx;
    const sorted = [...idx].sort((a, b) => compare(model.plainBody[a][sort.column] ?? '', model.plainBody[b][sort.column] ?? ''));
    return sort.ascending ? sorted : sorted.reverse();
  }, [model, sort]);

  const q = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q) return [] as { row: number; column: number }[];
    const out: { row: number; column: number }[] = [];
    for (const r of order) model.plainBody[r].forEach((cell, c) => { if (cell.toLowerCase().includes(q)) out.push({ row: r, column: c }); });
    return out;
  }, [q, order, model]);
  const current = matches.length ? matches[matchIndex % matches.length] : null;

  useEffect(() => { setMatchIndex(0); }, [q]);
  useEffect(() => {
    bodyRef.current?.querySelector<HTMLElement>('[data-cell="current"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [current]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && !window.getSelection()?.toString()) {
        e.preventDefault();
        void navigator.clipboard.writeText(toTSV(model, order));
        setCopied('TSV');
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onClose, model, order]);

  const onSort = (column: number) => setSort((s) => (s?.column !== column ? { column, ascending: true } : s.ascending ? { column, ascending: false } : null));
  const copy = (kind: 'Markdown' | 'TSV') => {
    void navigator.clipboard.writeText(kind === 'Markdown' ? toMarkdown(model, order) : toTSV(model, order));
    setCopied(kind);
    setTimeout(() => setCopied(null), 1500);
  };

  return createPortal(
    <div className="ktable-window-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ktable-window" role="dialog" aria-modal="true" aria-label="Table" data-testid="table-window">
        <div className="ktable-window-bar">
          <label className="ktable-search">
            <Search aria-hidden />
            <input
              autoFocus
              value={query}
              placeholder="Search"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && matches.length) setMatchIndex((i) => (i + (e.shiftKey ? matches.length - 1 : 1)) % matches.length); }}
            />
            {q && <span className="ktable-count">{matches.length ? `${(matchIndex % matches.length) + 1} of ${matches.length}` : 'No matches'}</span>}
          </label>
          <span className="ktable-spacer" />
          <span className="ktable-meta">{model.plainBody.length} rows · {model.columnCount} columns</span>
          <button type="button" className="ktable-btn" onClick={() => copy('Markdown')}>{copied === 'Markdown' ? 'Copied' : 'Copy Markdown'}</button>
          <button type="button" className="ktable-btn" onClick={() => copy('TSV')}>{copied === 'TSV' ? 'Copied' : 'Copy TSV'}</button>
          <button type="button" className="ktable-close" aria-label="Close" title="Close (Esc)" onClick={onClose}><X /></button>
        </div>
        <div className="ktable-window-body" ref={bodyRef}>
          <Grid
            model={model}
            components={components}
            rows={order}
            sticky
            sort={sort}
            onSort={onSort}
            highlight={q ? (r, c) => model.plainBody[r][c].toLowerCase().includes(q) : undefined}
            current={current}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function ChatTable({ node, components }: { node: Element; components: Record<string, unknown> }) {
  const model = useMemo(() => tableModel(node), [node]);
  const [overflows, setOverflows] = useState(false);
  const [open, setOpen] = useState(false);
  const previewRows = Math.min(model.body.length, PREVIEW_ROW_LIMIT);
  const hidden = model.body.length - previewRows;
  const rows = useMemo(() => Array.from({ length: previewRows }, (_, i) => i), [previewRows]);
  const footer = hidden > 0
    ? `Showing ${previewRows} of ${model.body.length} rows · ${model.columnCount} columns`
    : overflows ? `${model.columnCount} columns · scroll for more` : '';

  return (
    <div className="ktable" data-testid="chat-table">
      <SideScroll onOverflow={setOverflows}>
        <Grid model={model} components={components} rows={rows} sticky={overflows} />
      </SideScroll>
      {footer && (
        <div className="ktable-footer">
          <span>{footer}</span>
          <button type="button" className="ktable-open" onClick={() => setOpen(true)}>Open table</button>
        </div>
      )}
      {open && <TableWindow model={model} components={components} onClose={() => setOpen(false)} />}
    </div>
  );
}
