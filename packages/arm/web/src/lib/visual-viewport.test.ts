import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trackVisualViewport } from './visual-viewport';

class FakeVisualViewport extends EventTarget { height = 800; offsetTop = 0; }

let vv: FakeVisualViewport;
let frames: FrameRequestCallback[];
let clock: number;
/** One 60 Hz frame. */
const runFrame = () => { clock += 16; const due = frames; frames = []; due.forEach((cb) => cb(clock)); };
const vvt = () => document.documentElement.style.getPropertyValue('--kraki-vvt');
const vvh = () => document.documentElement.style.getPropertyValue('--kraki-vvh');

beforeEach(() => {
  vv = new FakeVisualViewport();
  frames = [];
  clock = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.stubGlobal('visualViewport', vv);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => { frames = []; });
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('trackVisualViewport (K-234)', () => {
  it('follows the iOS keyboard pan frame by frame before Safari sends any viewport event', () => {
    const stop = trackVisualViewport();
    expect(vvt()).toBe('0px');
    const field = document.body.appendChild(document.createElement('textarea'));
    field.focus();
    // Safari pans the visual viewport during the keyboard animation without
    // dispatching scroll/resize until it settles.
    vv.offsetTop = 120;
    runFrame();
    expect(vvt()).toBe('120px');
    vv.offsetTop = 300; vv.height = 460;
    runFrame();
    expect(vvt()).toBe('300px');
    expect(vvh()).toBe('460px');
    stop();
    field.remove();
  });

  it('still follows a pan that starts after 10 still frames', () => {
    const stop = trackVisualViewport();
    const field = document.body.appendChild(document.createElement('textarea'));
    field.focus();
    for (let i = 0; i < 10; i++) runFrame();
    expect(frames).toHaveLength(1);
    vv.offsetTop = 200;
    runFrame();
    expect(vvt()).toBe('200px');
    stop();
    field.remove();
  });

  it('stops sampling once the geometry has settled', () => {
    const stop = trackVisualViewport();
    vv.dispatchEvent(new Event('resize'));
    let ran = 0;
    for (; ran < 120 && frames.length; ran++) runFrame();
    expect(frames).toHaveLength(0);
    // At least the minimum window (500 ms ≈ 31 frames), well before the 1 s cap.
    expect(ran).toBeGreaterThanOrEqual(31);
    expect(ran).toBeLessThan(62);
    stop();
  });
});
