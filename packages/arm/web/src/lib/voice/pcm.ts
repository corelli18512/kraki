/**
 * Microphone samples → 16 kHz mono Int16 PCM, the gateway's wire format
 * (VoiceInputCore's VoicePCMConverter): averaging when downsampling, linear
 * interpolation when the input is slower (8 kHz headsets).
 */
export const TARGET_RATE = 16_000;

export function toPcm16(samples: Float32Array, sourceRate: number, targetRate = TARGET_RATE): { pcm: Int16Array; peak: number } {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) { const v = Math.abs(samples[i]); if (v > peak) peak = v; }
  if (!samples.length || !(sourceRate > 0)) return { pcm: new Int16Array(0), peak };
  const clamp = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  const ratio = sourceRate / targetRate;
  const outLen = Math.floor(samples.length / ratio);
  const pcm = new Int16Array(outLen);
  if (ratio >= 1) {
    for (let i = 0; i < outLen; i++) {
      const a = Math.floor(i * ratio); const b = Math.min(samples.length, Math.max(a + 1, Math.floor((i + 1) * ratio)));
      let acc = 0;
      for (let j = a; j < b; j++) acc += samples[j];
      pcm[i] = clamp(acc / (b - a));
    }
  } else {
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio; const a = Math.floor(pos); const b = Math.min(samples.length - 1, a + 1); const f = pos - a;
      pcm[i] = clamp(samples[a] * (1 - f) + samples[b] * f);
    }
  }
  return { pcm, peak };
}

/** VoiceLevelBars.loudness: dB-mapped 0…1 (−48 dB … −6 dB). */
export function loudness(peak: number): number {
  if (!(peak > 0)) return 0;
  const db = 20 * Math.log10(peak);
  return Math.max(0, Math.min(1, (db + 48) / 42));
}
