// BRO-7536: detect-cross-outlet-duplicates.js must remember LLM pair verdicts.
//
// Before the fix the weekly run re-asked Gemini about the same borderline
// (40-70% similar) pairs every week. This drives the REAL script (CLAUDE.md
// §15: require()d, LLM swapped for a fake) over synthetic fixtures and asserts
// the second run makes zero LLM calls for judged pairs; an unclear reply is
// not stored (retried), and changed text or prompt version re-queues.
//
// Fixtures are synthetic text written here; no real review text (private).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cache = require('../lib/llm-verdict-cache.js');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'xoutlet-verdict-cache-'));
const RT = path.join(ROOT, 'review-texts');
const AUDIT = path.join(ROOT, 'audit');

const SHARED = 'the revival lands with a confident cast a handsome set and a band that plays the old score with real warmth while the second act finds a sharper comic rhythm than the first and the finale earns its applause through careful staging and patient direction across a long evening that rarely sags despite a running time near three hours';
const PREFIX = {
  alphaside: 'opening notes about an unrelated matinee crowd queueing politely outside a different playhouse on a wet afternoon in early spring while ushers checked tickets slowly',
  betaside: 'this critic walked over from the subway past bright souvenir stalls and food carts then waited in a crowded lobby where programmes were handed out by cheerful volunteers',
};
const uniq = (tag) => `${tag} ${PREFIX[tag.split(' ')[0]]}`;

// One pair per show; the marker in each text tells the fake LLM what to answer.
const PAIRS = {
  'pair-no-2026': 'NO',
  'pair-yes-2026': 'YES',
  'pair-unclear-2026': 'MAYBE',
};

function writePair(show, answer) {
  fs.mkdirSync(path.join(RT, show), { recursive: true });
  const mk = (outletId, critic, tag) => fs.writeFileSync(path.join(RT, show, `${outletId}--${critic.toLowerCase().replace(/\s+/g, '-')}.json`), JSON.stringify({
    showId: show, outletId, outlet: outletId, criticName: critic,
    fullText: `${uniq(`${tag} ANSWER${answer}`)} ${SHARED}`,
  }, null, 2));
  // Spelling variants of one critic: the pair policy flags them, the similarity layer still compares them.
  mk('alpha-outlet', 'Alex Sierz', 'alphaside');
  mk('beta-outlet', 'Aleks Sierz', 'betaside');
}
for (const [show, answer] of Object.entries(PAIRS)) writePair(show, answer);

process.env.REVIEW_TEXTS_DIR = RT;
process.env.CROSS_OUTLET_AUDIT_DIR = AUDIT;
process.argv = [process.argv[0], 'detect-cross-outlet-duplicates.js'];
const detector = require('../detect-cross-outlet-duplicates.js');

const asked = [];
detector._setLLMForTest(async (prompt) => {
  const m = prompt.match(/ANSWER([A-Z]+)/);
  asked.push(m[1]);
  return m[1];
});

async function run() {
  asked.length = 0;
  const log = console.log;
  console.log = () => {};
  try { await detector.main(); } finally { console.log = log; }
  return [...asked].sort();
}
const report = () => JSON.parse(fs.readFileSync(path.join(AUDIT, 'cross-outlet-duplicates.json'), 'utf8'));

test('second run reuses stored pair verdicts: only the unclear pair is asked again', async () => {
  assert.deepEqual(await run(), ['MAYBE', 'NO', 'YES']);
  const store = report().llmPairVerdicts;
  const verdicts = Object.values(store).map(e => e.verdict).sort();
  assert.deepEqual(verdicts, [false, true], 'definite verdicts stored, unclear one not');
  for (const e of Object.values(store)) assert.equal(e.promptVersion, detector.DUPLICATE_PROMPT_VERSION);
  assert.ok(report().duplicates.some(d => d.showId === 'pair-yes-2026'), 'YES pair reported as duplicate');

  assert.deepEqual(await run(), ['MAYBE'], 'judged pairs must make zero LLM calls on an unchanged second run');
  assert.ok(report().duplicates.some(d => d.showId === 'pair-yes-2026' && d.method === 'similarity+llm'), 'cached YES still yields the duplicate');
  assert.equal(Object.keys(report().llmPairVerdicts).length, 2, 'store survives the second run');
});

test('changed text or an old prompt version re-queues the pair', async () => {
  const f = path.join(RT, 'pair-no-2026', 'beta-outlet--aleks-sierz.json');
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  d.fullText = d.fullText.replace('betaside', 'betaside refetched');
  fs.writeFileSync(f, JSON.stringify(d, null, 2));
  assert.deepEqual(await run(), ['MAYBE', 'NO']);
  assert.equal(Object.keys(report().llmPairVerdicts).length, 2, 'full run prunes the stale entry for the old text');

  const r = report();
  for (const e of Object.values(r.llmPairVerdicts)) e.promptVersion = 'g0-oldprompt';
  fs.writeFileSync(path.join(AUDIT, 'cross-outlet-duplicates.json'), JSON.stringify(r, null, 2));
  assert.deepEqual(await run(), ['MAYBE', 'NO', 'YES']);
});

test('pure store helpers: order-independent key, null never recorded, prune', () => {
  assert.equal(cache.pairKey('aaa', 'bbb'), cache.pairKey('bbb', 'aaa'));
  const store = {};
  assert.equal(cache.recordPairVerdict(store, 'h1', 'h2', { verdict: null, promptVersion: 'p' }), false);
  assert.equal(cache.recordPairVerdict(store, 'h1', 'h2', { verdict: false, promptVersion: 'p' }), true);
  assert.equal(cache.lookupPairVerdict(store, 'h2', 'h1', 'p'), false);
  assert.equal(cache.lookupPairVerdict(store, 'h2', 'h1', 'q'), null);
  assert.equal(cache.lookupPairVerdict(store, 'h2', 'h1', 'p', { overwrite: true }), null);
  assert.deepEqual(Object.keys(cache.prunePairStore(store, new Set())), []);
});

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
