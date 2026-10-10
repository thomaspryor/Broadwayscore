/**
 * BRO-4895 regression: Variety pre-press-night interview scored 78 and live as T1.
 * Run: node --test scripts/lib/preopening-interview-signal.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { detectPreOpeningInterviewFeature: detect } = require('./preopening-interview-signal.js');

const SHOW = { id: 'rent-west-end-2026', openingDate: '2026-10-08' };
const interviewBody = Array.from({ length: 9 }, (_, i) =>
  `The cast has been rehearsing for weeks and the mood in the room is warm and focused, with everyone eager to share the work. "I grew up on this show and it still gives me chills every single time," Gaten Matarazzo says about the number. Luke Sheppard adds, "The ensemble found something new on day ${i}." ` +
  'The company gathered around the piano as the music director walked through the harmonies, and the director talked through staging notes with the actors in between runs of the song.'
).join('\n\n');
const mk = (o = {}) => ({ outletId: 'variety', publishDate: '2026-10-08', fullText: interviewBody, ...o });

test('flags a same-day interview feature (the Variety incident shape)', () => {
  const r = detect(mk(), SHOW);
  assert.equal(r.suspect, true);
  assert.equal(r.reason, 'preopening_interview_feature');
});

test('never flags once published after opening night', () => {
  assert.equal(detect(mk({ publishDate: '2026-10-09' }), SHOW).suspect, false);
});

test('never flags a human-cleared or human-scored file', () => {
  assert.equal(detect(mk({ humanReviewScore: 80 }), SHOW).suspect, false);
  assert.equal(detect(mk({ manuallyCleared: true }), SHOW).suspect, false);
});

test('a prose review with few attributions is not flagged', () => {
  const review = 'The staging is confident and the ensemble sings with real conviction throughout. '.repeat(60);
  assert.equal(detect(mk({ fullText: review }), SHOW).suspect, false);
});

test('missing dates / short text are inert', () => {
  assert.equal(detect(mk(), {}).suspect, false);
  assert.equal(detect(mk({ fullText: 'short' }), SHOW).suspect, false);
});

test('real Variety file is flagged (skipped when private repo absent)', (t) => {
  const f = '/Users/tompryor/broadway-review-texts/rent-west-end-2026/variety--ellise-shafer.json';
  if (!fs.existsSync(f)) return t.skip('review-texts not present');
  assert.equal(detect(JSON.parse(fs.readFileSync(f, 'utf-8')), SHOW).suspect, true);
});

test('scorer entry point wires the signal before any LLM call', () => {
  const idx = fs.readFileSync(path.join(ROOT, 'scripts/llm-scoring/index.ts'), 'utf-8');
  const sig = idx.indexOf('detectPreOpeningInterviewFeature(reviewFile');
  assert.ok(sig > 0, 'index.ts must call detectPreOpeningInterviewFeature');
  assert.ok(sig < idx.indexOf('scorer.scoreReviewFile(reviewFile)'), 'guard must precede scoring');
});

test('every workflow that runs the scorer passes --ensemble (express omitted it: root cause)', () => {
  const dir = path.join(ROOT, '.github', 'workflows');
  const offenders = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.yml'))) {
    const txt = fs.readFileSync(path.join(dir, f), 'utf-8').replace(/\\\n\s*/g, ' ');
    for (const line of txt.split('\n')) {
      if (/^\s*(?:-\s*)?(?:run:\s*)?(?:npx ts-node[^\n]*)?llm-scoring\/index\.ts/.test(line) && /ts-node/.test(line) && !line.trim().startsWith('#')) {
        if (!/--ensemble\b/.test(line)) offenders.push(`${f}: ${line.trim().slice(0, 120)}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('non-ISO dates and manual content tiers are inert', () => {
  assert.equal(detect(mk({ publishDate: '10/08/2026' }), SHOW).suspect, false);
  assert.equal(detect(mk({ manualContentTier: 'complete' }), SHOW).suspect, false);
});

test('stale-verdict heal knows the new rejecter', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/lib/stale-automated-text-verdict.js'), 'utf-8');
  assert.match(src, /'preopening-interview-signal'/);
});
