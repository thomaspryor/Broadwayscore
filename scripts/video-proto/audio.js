// Synthesised audio, no samples and no licensing. Styles: 'groove' (bright major-key bed + punchy effects),
// 'sfx' (effects only), 'quiet' (the first quiet-pad version, kept for comparison).
const fs = require('fs');
const SR = 44100;
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

function synth(events, dur, file, style = 'groove') {
  const N = Math.floor(SR * dur), L = new Float32Array(N), R = new Float32Array(N);
  // add a voice at time t0; pan -1..1
  const add = (t0, len, gain, pan, fn) => {
    const i0 = Math.floor(t0 * SR), gl = gain * (1 - Math.max(0, pan)), gr = gain * (1 + Math.min(0, pan));
    for (let i = 0; i < len * SR && i0 + i < N; i++) { const v = fn(i / SR); L[i0 + i] += v * gl; R[i0 + i] += v * gr; }
  };
  const TAU = Math.PI * 2;
  // instruments
  const marimba = (t, m, g, pan = 0) => { const f = mtof(m); add(t, 0.7, g, pan, s => (Math.sin(TAU * f * s) * Math.exp(-s * 9) + 0.35 * Math.sin(TAU * f * 4 * s) * Math.exp(-s * 30)) * Math.min(1, s * 800)); };
  const pluck = (t, m, g, pan = 0) => { const f = mtof(m); add(t, 0.9, g, pan, s => (Math.sin(TAU * f * s) + 0.5 * Math.sin(TAU * 2 * f * s) + 0.25 * Math.sin(TAU * 3 * f * s)) * Math.exp(-s * 5.5) * Math.min(1, s * 600)); };
  const bass = (t, m, g) => { const f = mtof(m); add(t, 0.42, g, 0, s => Math.sin(TAU * f * s + 0.8 * Math.sin(TAU * f * s)) * Math.exp(-s * 5) * Math.min(1, s * 400)); };
  const noise = () => Math.random() * 2 - 1;
  const hat = (t, g, pan) => add(t, 0.07, g, pan, s => noise() * Math.exp(-s * 70));
  const clap = (t, g) => add(t, 0.18, g, 0, s => noise() * (Math.exp(-s * 35) + 0.6 * Math.exp(-Math.max(0, s - 0.012) * 35)));
  const kick = (t, g) => add(t, 0.25, g, 0, s => Math.sin(TAU * (48 + 90 * Math.exp(-s * 30)) * s) * Math.exp(-s * 12));
  const whoosh = (t, len, g) => { let lp = 0; add(t, len, g, 0, s => { const k = Math.sin(Math.PI * s / len); lp += (noise() - lp) * (0.05 + 0.5 * s / len); return lp * k * k; }); };
  const sparkle = (t, g) => [84, 88, 91, 96, 100].forEach((m, k) => marimba(t + k * 0.055, m, g * (1 - k * 0.1), k % 2 ? 0.4 : -0.4));

  if (style === 'groove') {
    const bpm = 108, beat = 60 / bpm, eighth = beat / 2;
    // C - Am - F - G, one bar each, light swing; major key, bouncy
    const bars = [[48, [60, 64, 67]], [45, [57, 60, 64]], [41, [57, 60, 65]], [43, [55, 59, 62]]];
    const total = Math.floor(dur / beat);
    for (let b = 0; b < total; b++) {
      const bar = bars[Math.floor(b / 4) % 4], t = b * beat, q = b % 4;
      if (q === 0 || q === 2) kick(t, 0.30);
      if (q === 1 || q === 3) clap(t, 0.10);
      bass(t, bar[0], 0.20); if (q === 2) bass(t + beat * 0.75, bar[0] + 7, 0.14);
      hat(t + eighth * 1.18, 0.05, 0.3); hat(t, 0.025, -0.3);
      // piano-ish stabs on the off beats
      if (q === 0 || q === 2) bar[1].forEach((m, k) => pluck(t + eighth * 1.18, m + 12, 0.045, (k - 1) * 0.35));
      // marimba tune: simple rising line over each bar
      marimba(t + (q % 2 ? eighth * 1.18 : 0), bar[1][q % 3] + 24, 0.05, q % 2 ? 0.5 : -0.5);
    }
  }
  if (style === 'quiet') {
    const pad = [110, 164.81, 246.94, 329.63, 392];
    for (let i = 0; i < N; i++) { const t = i / SR; let v = 0; pad.forEach((f, k) => v += Math.sin(TAU * f * t + k) * (0.5 + 0.5 * Math.sin(t * 0.4 + k))); L[i] += v * 0.018; R[i] += v * 0.018; }
  }
  for (const e of events) {
    if (style === 'quiet') {
      if (e.k === 'tick') { const f = 700 + 700 * (e.p || 0); add(e.t, 0.12, 0.16, 0, s => Math.sin(TAU * f * s) * Math.exp(-s * 60)); }
      else if (e.k === 'pop') add(e.t, 0.25, 0.14, 0, s => Math.sin(TAU * 520 * s) * Math.exp(-s * 28) + 0.35 * Math.sin(TAU * 1040 * s) * Math.exp(-s * 40));
      else if (e.k === 'chime') [523.25, 659.25, 783.99, 1046.5].forEach((f, k) => add(e.t + k * 0.09, 1.8, 0.13, 0, s => Math.sin(TAU * f * s) * Math.exp(-s * 2.6)));
      continue;
    }
    if (e.k === 'tick') { // score counting up: pentatonic marimba climbing with the count
      const scale = [0, 2, 4, 7, 9], step = Math.round((e.p || 0) * 15), m = 72 + scale[step % 5] + 12 * Math.floor(step / 5);
      marimba(e.t, m, 0.20, ((step % 4) - 1.5) * 0.25); }
    else if (e.k === 'pop') { // a card landing: soft thump + bright blip
      kick(e.t, 0.22); marimba(e.t, 79, 0.24, 0); marimba(e.t + 0.07, 86, 0.2, 0); whoosh(e.t - 0.12, 0.14, 0.05); }
    else if (e.k === 'chime') { // Gold: swell, brass-ish major stab, sparkle run
      whoosh(e.t - 0.5, 0.5, 0.12);
      [60, 64, 67, 72, 76].forEach((m, k) => add(e.t, 1.6, 0.075, (k - 2) * 0.3, s => (Math.sin(TAU * mtof(m) * s) + 0.4 * Math.sin(TAU * 2 * mtof(m) * s) + 0.2 * Math.sin(TAU * 3 * mtof(m) * s)) * Math.exp(-s * 2.2) * Math.min(1, s * 120)));
      kick(e.t, 0.45); clap(e.t, 0.14); sparkle(e.t + 0.04, 0.18); }
  }
  // soft limiter + 1.0s fades
  const fade = Math.floor(SR * 1.0);
  for (let i = 0; i < N; i++) { let g = 1; if (i < fade) g = i / fade; else if (N - 1 - i < fade) g = (N - 1 - i) / fade; L[i] = Math.tanh(L[i] * 1.4) * g; R[i] = Math.tanh(R[i] * 1.4) * g; }
  const pcm = Buffer.alloc(N * 4);
  for (let i = 0; i < N; i++) { pcm.writeInt16LE(Math.round(L[i] * 30000), i * 4); pcm.writeInt16LE(Math.round(R[i] * 30000), i * 4 + 2); }
  const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, pcm]));
}
module.exports = { synth };
