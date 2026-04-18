/**
 * Animated ASCII banner for Kraki CLI.
 * Renders a colored octopus logo with radial reveal + title animation.
 */

import chalk from 'chalk';
import bannerData from './banner-data.json' with { type: 'json' };

const data = bannerData as { lines: string[]; colors: [number, number, number, number][][]; w: number; h: number };

const SCRAMBLE = '!@#$%^&*=+<>~/';
const TITLE = 'KRAKI';
const TITLE_COLORS = ['#00c9a7', '#00b4d8', '#ea6046', '#0891b2', '#ea6046'];

const BLOCK_MAP: Record<string, string> = {
  '.': '░', ':': '░', '-': '▒', '=': '▓', '+': '█', '*': '█', '#': '█', '%': '█', '@': '█',
};

/** Whether to render this cell as a block character (dense head) or original ASCII (tentacles) */
function useBlockChar(x: number, y: number, w: number): boolean {
  if (y < 8) return true;
  if (y === 8) {
    const cx = Math.floor(w / 2);
    return x >= cx - 9 && x < cx + 9;
  }
  return false;
}

/** Convert a character to its block equivalent if in the head region */
function toDisplayChar(ch: string, x: number, y: number, w: number): string {
  return useBlockChar(x, y, w) ? (BLOCK_MAP[ch] ?? ch) : ch;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function printAnimatedBanner(): Promise<void> {
  const { lines, colors, h, w } = data;
  const cx = w / 2;
  const cy = h / 2;

  // Build all cells with distance from center
  type Cell = { x: number; y: number; ch: string; r: number; g: number; b: number; dist: number };
  const cells: Cell[] = [];

  for (let y = 0; y < h; y++) {
    const colorMap = new Map(colors[y].map((c) => [c[0], c]));
    for (let x = 0; x < w; x++) {
      const ch = lines[y][x];
      if (ch === ' ') continue;
      const c = colorMap.get(x);
      if (!c) continue;
      const dist = Math.sqrt((x - cx) ** 2 + ((y - cy) * 2) ** 2);
      cells.push({ x, y, ch, r: c[1], g: c[2], b: c[3], dist });
    }
  }

  const maxDist = Math.max(...cells.map((c) => c.dist));

  // Build frame buffer
  const buffer: string[][] = [];
  for (let y = 0; y < h; y++) {
    buffer.push(new Array(w).fill(' '));
  }

  // Group cells into frames by distance
  const totalFrames = 20;
  const frames: Cell[][] = Array.from({ length: totalFrames }, () => []);
  for (const cell of cells) {
    const frame = Math.min(Math.floor((cell.dist / maxDist) * totalFrames), totalFrames - 1);
    frames[frame].push(cell);
  }

  // Hide cursor, clear screen, move to top
  process.stdout.write('\x1B[?25l\x1B[2J\x1B[H');

  const leftPad = '    ';
  console.log('');

  // Print empty lines to reserve space
  for (let y = 0; y < h; y++) {
    console.log('');
  }

  // Title + tagline placement: bottom-right, overlapping logo with 1 char padding
  const titleRow = h - 2;
  const taglineRow = h - 1;
  const tagline = 'E2E encrypted AI agent relay';

  // Both lines start right of center of the logo, +8 more right
  const textStart = Math.floor(w / 2) + 7;

  // Total text chars to animate (title spaced + tagline)
  const titleSpaced = TITLE.split('').map((c, i) => ({ ch: c, color: TITLE_COLORS[i] }));
  const totalTextChars = TITLE.length + tagline.length;
  let textCharsShown = 0;
  const textStartFrame = Math.floor(totalFrames * 0.4); // start at 40%, end with logo

  // Redraw helper
  const redraw = () => {
    process.stdout.write(`\x1B[${h}A`);
    for (let y = 0; y < h; y++) {
      const logoChars = [...buffer[y]];
      let suffix = '';

      if (y === titleRow && textCharsShown > 0) {
        const shown = Math.min(textCharsShown, TITLE.length);
        // Clear logo chars from textStart-1 onward on this row
        for (let c = Math.max(0, textStart - 1); c < w; c++) logoChars[c] = ' ';
        // Place title chars
        for (let i = 0; i < shown; i++) {
          const col = textStart + i * 2;
          if (col < w) {
            logoChars[col] = chalk.hex(titleSpaced[i].color).bold(titleSpaced[i].ch);
          } else {
            suffix += chalk.hex(titleSpaced[i].color).bold(titleSpaced[i].ch) + ' ';
          }
        }
      }

      if (y === taglineRow && textCharsShown > TITLE.length) {
        const tagShown = Math.min(textCharsShown - TITLE.length, tagline.length);
        // Clear logo chars from textStart-1 onward on this row
        for (let c = Math.max(0, textStart - 1); c < w; c++) logoChars[c] = ' ';
        // Place tagline chars
        for (let i = 0; i < tagShown; i++) {
          const col = textStart + i;
          if (col < w) {
            logoChars[col] = chalk.dim(tagline[i]);
          } else {
            suffix += chalk.dim(tagline[i]);
          }
        }
      }

      process.stdout.write(leftPad + logoChars.join('') + suffix + '\x1B[K\n');
    }
  };

  // Animate logo frames
  for (let f = 0; f < totalFrames; f++) {
    for (const cell of frames[f]) {
      const sc = SCRAMBLE[Math.floor(Math.random() * SCRAMBLE.length)];
      buffer[cell.y][cell.x] = chalk.rgb(cell.r, cell.g, cell.b)(sc);
    }

    if (f > 0) {
      for (const cell of frames[f - 1]) {
        buffer[cell.y][cell.x] = chalk.rgb(cell.r, cell.g, cell.b)(toDisplayChar(cell.ch, cell.x, cell.y, w));
      }
    }

    // Reveal text chars proportionally so they finish with the logo
    if (f >= textStartFrame) {
      const progress = (f - textStartFrame) / (totalFrames - 1 - textStartFrame);
      textCharsShown = Math.min(Math.floor(progress * totalTextChars), totalTextChars);
    }

    redraw();
    await sleep(50);
  }

  // Resolve final frame
  for (const cell of frames[totalFrames - 1]) {
    buffer[cell.y][cell.x] = chalk.rgb(cell.r, cell.g, cell.b)(toDisplayChar(cell.ch, cell.x, cell.y, w));
  }
  textCharsShown = totalTextChars;
  redraw();
  console.log('');

  // Show cursor
  process.stdout.write('\x1B[?25h');
}

/** Static (non-animated) banner for quick display */
export function printStaticBanner(): void {
  const { lines, colors, h, w } = data;

  const titleRow = h - 2;
  const taglineRow = h - 1;
  const tagline = 'E2E encrypted AI agent relay';
  const textStart = Math.floor(w / 2) + 7;

  console.log('');
  for (let y = 0; y < h; y++) {
    const colorMap = new Map(colors[y].map((c) => [c[0], c]));
    const chars: string[] = [];
    for (let x = 0; x < lines[y].length; x++) {
      const ch = lines[y][x];
      const c = colorMap.get(x);
      if (ch === ' ' || !c) {
        chars.push(' ');
      } else {
        chars.push(chalk.rgb(c[1], c[2], c[3])(toDisplayChar(ch, x, y, w)));
      }
    }

    let suffix = '';
    if (y === titleRow) {
      for (let c = Math.max(0, textStart - 1); c < w; c++) chars[c] = ' ';
      for (let i = 0; i < TITLE.length; i++) {
        const col = textStart + i * 2;
        if (col < w) {
          chars[col] = chalk.hex(TITLE_COLORS[i]).bold(TITLE[i]);
        } else {
          suffix += chalk.hex(TITLE_COLORS[i]).bold(TITLE[i]) + ' ';
        }
      }
    }
    if (y === taglineRow) {
      for (let c = Math.max(0, textStart - 1); c < w; c++) chars[c] = ' ';
      for (let i = 0; i < tagline.length; i++) {
        const col = textStart + i;
        if (col < w) {
          chars[col] = chalk.dim(tagline[i]);
        } else {
          suffix += chalk.dim(tagline[i]);
        }
      }
    }

    console.log('    ' + chars.join('') + suffix);
  }
  console.log('');
}
