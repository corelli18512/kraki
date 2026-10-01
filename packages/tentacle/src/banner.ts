/**
 * Kraki CLI banner: the current Kraki logo (the octopus with the coffee cup,
 * same artwork as the apps) drawn with half-block characters — each cell is
 * two pixels, top (▀ foreground) and bottom (background) — so the terminal
 * shows the real shapes and colours instead of an ASCII approximation.
 *
 * banner-data.json is generated from the app icon by scripts/gen-banner.py.
 *
 * The animated version reveals the logo radially from the centre through a
 * short glyph scramble (like the original banner), then fades in the
 * wordmark and tagline. Without a TTY or colour it prints text only.
 */

import chalk from 'chalk';
import bannerData from './banner-data.json' with { type: 'json' };

type Px = string | null; // "rrggbb" or transparent
const data = bannerData as unknown as { w: number; h: number; cells: [Px, Px][][] };

const TITLE = 'KRAKI';
const TAGLINE = 'Your coding agents, on every device';
/** Logo blues, dark → light (sampled from the artwork). */
const TITLE_COLORS = ['#0e5a9e', '#176fbd', '#2384d4', '#3a9de6', '#56b9f2'];
const SCRAMBLE = '░▒▓·:+*';
const LEFT = '  ';
const GAP = '   ';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function hex(c: string): string { return `#${c}`; }

/** One logo cell as coloured half blocks. */
function cell([top, bottom]: [Px, Px]): string {
  if (top && bottom) return chalk.hex(hex(top)).bgHex(hex(bottom))('▀');
  if (top) return chalk.hex(hex(top))('▀');
  if (bottom) return chalk.hex(hex(bottom))('▄');
  return ' ';
}

function title(shown = TITLE.length): string {
  return TITLE.slice(0, shown).split('').map((ch, i) => chalk.hex(TITLE_COLORS[i]).bold(ch)).join(' ');
}

/** Where the wordmark sits: beside the logo when it fits, else below. */
function layout(columns: number): 'side' | 'below' {
  return columns >= LEFT.length + data.w + GAP.length + TAGLINE.length + 1 ? 'side' : 'below';
}

/** Text rows beside the logo, vertically centred (title, blank, tagline). */
function sideText(y: number, titleShown: number, tagShown: number): string {
  const mid = Math.floor(data.h / 2);
  if (y === mid - 1 && titleShown > 0) return GAP + title(titleShown);
  if (y === mid + 1 && tagShown > 0) return GAP + chalk.dim(TAGLINE.slice(0, tagShown));
  return '';
}

function canDraw(): boolean {
  return Boolean(process.stdout.isTTY) && chalk.level > 0;
}

function printTextOnly(): void {
  console.log('');
  console.log(`${LEFT}${TITLE.split('').join(' ')}`);
  console.log(`${LEFT}${TAGLINE}`);
  console.log('');
}

export async function printAnimatedBanner(): Promise<void> {
  if (!canDraw()) { printTextOnly(); return; }
  const { w, h, cells } = data;
  const mode = layout(process.stdout.columns ?? 80);

  // Reveal order: distance from the logo centre (rows are twice as tall).
  const cx = w / 2;
  const cy = h / 2;
  const order: { x: number; y: number; d: number }[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (cells[y][x][0] || cells[y][x][1]) order.push({ x, y, d: Math.hypot(x - cx, (y - cy) * 2) });
    }
  }
  const maxD = Math.max(...order.map((o) => o.d));
  const FRAMES = 18;
  const state: ('hidden' | 'scramble' | 'done')[][] = cells.map((r) => r.map(() => 'hidden'));
  const frameOf = (d: number) => Math.min(FRAMES - 1, Math.floor((d / maxD) * FRAMES));

  const totalText = TITLE.length + TAGLINE.length;
  const textFrom = Math.floor(FRAMES * 0.45);
  let textShown = 0;
  const rowsTotal = h + (mode === 'below' ? 3 : 0);

  const render = (first: boolean) => {
    if (!first) process.stdout.write(`\x1B[${rowsTotal}A`);
    const titleShown = Math.min(textShown, TITLE.length);
    const tagShown = Math.max(0, textShown - TITLE.length);
    for (let y = 0; y < h; y++) {
      let line = '';
      for (let x = 0; x < w; x++) {
        const s = state[y][x];
        if (s === 'done') line += cell(cells[y][x]);
        else if (s === 'scramble') {
          const c = cells[y][x][0] ?? cells[y][x][1];
          line += chalk.hex(hex(c as string))(SCRAMBLE[Math.floor(Math.random() * SCRAMBLE.length)]);
        } else line += ' ';
      }
      const suffix = mode === 'side' ? sideText(y, titleShown, tagShown) : '';
      process.stdout.write(`${LEFT}${line}${suffix}\x1B[K\n`);
    }
    if (mode === 'below') {
      process.stdout.write('\x1B[K\n');
      process.stdout.write(`${LEFT}${titleShown ? title(titleShown) : ''}\x1B[K\n`);
      process.stdout.write(`${LEFT}${chalk.dim(TAGLINE.slice(0, tagShown))}\x1B[K\n`);
    }
  };

  process.stdout.write('\x1B[?25l'); // hide cursor
  const restore = () => process.stdout.write('\x1B[?25h');
  process.once('exit', restore);
  try {
    console.log('');
    render(true);
    for (let f = 0; f < FRAMES; f++) {
      for (const o of order) {
        const at = frameOf(o.d);
        if (at === f) state[o.y][o.x] = 'scramble';
        else if (at === f - 1) state[o.y][o.x] = 'done';
      }
      if (f >= textFrom) {
        textShown = Math.min(totalText, Math.ceil(((f - textFrom + 1) / (FRAMES - textFrom)) * totalText));
      }
      render(false);
      await sleep(45);
    }
    for (const o of order) state[o.y][o.x] = 'done';
    textShown = totalText;
    render(false);
    console.log('');
  } finally {
    restore();
    process.removeListener('exit', restore);
  }
}

/** Static banner (help screen). */
export function printStaticBanner(): void {
  if (!canDraw()) { printTextOnly(); return; }
  const { w, h, cells } = data;
  const mode = layout(process.stdout.columns ?? 80);
  console.log('');
  for (let y = 0; y < h; y++) {
    let line = '';
    for (let x = 0; x < w; x++) line += cell(cells[y][x]);
    console.log(LEFT + line + (mode === 'side' ? sideText(y, TITLE.length, TAGLINE.length) : ''));
  }
  if (mode === 'below') {
    console.log('');
    console.log(LEFT + title());
    console.log(LEFT + chalk.dim(TAGLINE));
  }
  console.log('');
}
