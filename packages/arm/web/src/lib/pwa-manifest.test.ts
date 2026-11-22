import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(readFileSync('public/manifest.json', 'utf8')) as {
  icons: Array<{ src: string; sizes: string; purpose: string }>;
};

function pngSize(path: string): [number, number] {
  const png = readFileSync(path);
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

describe('K-238: PWA maskable icon', () => {
  it('uses its own padded artwork, not the edge-to-edge icon', () => {
    const maskable = manifest.icons.filter((i) => i.purpose.split(' ').includes('maskable'));
    const any = manifest.icons.filter((i) => i.purpose.split(' ').includes('any')).map((i) => i.src);
    expect(maskable).toHaveLength(1);
    expect(any).not.toContain(maskable[0].src);
    expect(pngSize(`public${maskable[0].src}`)).toEqual([512, 512]);
  });
});
