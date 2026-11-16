// BRO-7536: classify-non-reviews.js --incremental must remember verdicts that
// write no flag (uncertain medium/low non-review, LANE-SKIP, EVIDENCE-CONFLICT).
//
// Before the fix those files got no stamp, so each 4x/day run (--limit=50)
// re-asked Gemini about the same files. This drives the REAL script (CLAUDE.md
// §15: require()d, LLM swapped for a fake) over synthetic fixtures and asserts
// the second run makes zero LLM calls for judged files, while EXTRACTION-SUSPECT
// stays retriable. Revert the stamp or the selection skip and it fails.
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

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'classify-verdict-cache-'));
const RT = path.join(ROOT, 'review-texts');
const SHOW = 'verdict-cache-show-2026';
const TITLE = 'The Synthetic Musical';

const FILLER = 'The company moves through the evening with an even, practised energy and the band plays the score cleanly. ';
const longText = (marker, n = 10) => `${marker} ${FILLER.repeat(n)}`.trim();

const FIXTURES = {
  'uncertain-outlet--critic-one.json': { url: 'https://example.org/culture/one', fullText: longText('MARKER_UNCERTAIN') },
  // Malformed reply salvaged by regex (low confidence): not a real verdict, must stay retriable.
  'salvage-outlet--critic-four.json': { url: 'https://example.org/culture/four', fullText: longText('MARKER_SALVAGE') },
  // Short body from a review-marker URL: the RC2 guard skips the stamp and must leave it retriable.
  'suspect-outlet--critic-two.json': { url: 'https://example.org/reviews/the-synthetic-musical-review/', fullText: longText('MARKER_SUSPECT', 3) },
  // High-confidence content-verifier "review" verdict blocks the terminal stamp.
  'conflict-outlet--critic-three.json': {
    url: 'https://example.org/culture/three',
    fullText: longText('MARKER_CONFLICT'),
    contentVerification: { isValid: true, confidence: 'high', articleType: 'review' },
  },
};

function writeCorpus() {
  fs.mkdirSync(path.join(RT, SHOW), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'shows.json'), JSON.stringify({ shows: [{ id: SHOW, title: TITLE }] }));
  const reviews = [];
  for (const [file, extra] of Object.entries(FIXTURES)) {
    const [outletId, critic] = file.replace(/\.json$/, '').split('--');
    const criticName = critic.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
    reviews.push({ showId: SHOW, outletId, criticName, assignedScore: 70 });
    fs.writeFileSync(path.join(RT, SHOW, file), JSON.stringify({ showId: SHOW, outletId, outlet: outletId, criticName, ...extra }, null, 2));
  }
  fs.writeFileSync(path.join(ROOT, 'reviews.json'), JSON.stringify({ reviews }));
}

writeCorpus();
process.env.CLASSIFY_NON_REVIEWS_DATA_DIR = ROOT;
process.argv = [process.argv[0], 'classify-non-reviews.js', '--incremental', '--concurrency=1'];
const classifier = require('../classify-non-reviews.js');

const asked = [];
classifier._setLLMForTest(async (_sys, user) => {
  const marker = (user.match(/MARKER_[A-Z]+/) || ['?'])[0];
  asked.push(marker);
  if (marker === 'MARKER_SALVAGE') return '{"isReview": false, "contentType": "feature", "confidence": "med'; // cut off mid-reply
  const confidence = marker === 'MARKER_UNCERTAIN' ? 'medium' : 'high';
  return JSON.stringify({ isReview: false, contentType: 'feature', confidence, reasoning: 'synthetic' });
});

const read = (f) => JSON.parse(fs.readFileSync(path.join(RT, SHOW, f), 'utf8'));
const write = (f, d) => fs.writeFileSync(path.join(RT, SHOW, f), JSON.stringify(d, null, 2));

async function run() {
  asked.length = 0;
  const log = console.log;
  console.log = () => {};
  try { await classifier.main(); } finally { console.log = log; }
  return [...asked].sort();
}

test('second incremental run asks only the EXTRACTION-SUSPECT file again', async () => {
  const first = await run();
  assert.deepEqual(first, ['MARKER_CONFLICT', 'MARKER_SALVAGE', 'MARKER_SUSPECT', 'MARKER_UNCERTAIN']);

  const u = read('uncertain-outlet--critic-one.json');
  assert.equal(u[cache.CLASSIFY_FIELDS.reason], 'uncertain');
  assert.equal(u[cache.CLASSIFY_FIELDS.promptVersion], classifier.CLASSIFY_PROMPT_VERSION);
  assert.equal(u[cache.CLASSIFY_FIELDS.provider], classifier.CLASSIFY_PROVIDER_KEY);
  assert.match(classifier.CLASSIFY_PROVIDER_KEY, /^gemini:gemini-/, 'key names provider and model');
  assert.equal(read('salvage-outlet--critic-four.json')[cache.CLASSIFY_FIELDS.at], undefined, 'salvaged malformed parse must not be stamped');
  assert.equal(u.isNonReview, undefined, 'uncertain verdict must not flag the file');
  assert.equal(u.classifiedAt, undefined, 'uncertain verdict is not a classification');

  const c = read('conflict-outlet--critic-three.json');
  assert.equal(c[cache.CLASSIFY_FIELDS.reason], 'evidence-conflict');
  assert.equal(c.isNonReview, undefined);

  const s = read('suspect-outlet--critic-two.json');
  assert.equal(s[cache.CLASSIFY_FIELDS.at], undefined, 'EXTRACTION-SUSPECT must not be stamped');
  assert.equal(s.isNonReview, undefined);

  const second = await run();
  assert.deepEqual(second, ['MARKER_SALVAGE', 'MARKER_SUSPECT'], 'judged files must make zero LLM calls on an unchanged second run');
});

test('changed text or an old prompt version re-queues a stamped file', async () => {
  const u = read('uncertain-outlet--critic-one.json');
  u.fullText = longText('MARKER_UNCERTAIN', 11); // refetched body
  write('uncertain-outlet--critic-one.json', u);
  assert.deepEqual(await run(), ['MARKER_SALVAGE', 'MARKER_SUSPECT', 'MARKER_UNCERTAIN']);
  assert.deepEqual(await run(), ['MARKER_SALVAGE', 'MARKER_SUSPECT'], 'restamped on the new text');

  const u2 = read('uncertain-outlet--critic-one.json');
  u2[cache.CLASSIFY_FIELDS.promptVersion] = 'g0-oldprompt';
  write('uncertain-outlet--critic-one.json', u2);
  assert.deepEqual(await run(), ['MARKER_SALVAGE', 'MARKER_SUSPECT', 'MARKER_UNCERTAIN']);
});

test('a verdict from another provider/model re-queues', async () => {
  const u = read('uncertain-outlet--critic-one.json');
  u[cache.CLASSIFY_FIELDS.provider] = 'openai:some-cheaper-model';
  write('uncertain-outlet--critic-one.json', u);
  assert.deepEqual(await run(), ['MARKER_SALVAGE', 'MARKER_SUSPECT', 'MARKER_UNCERTAIN']);
  assert.deepEqual(await run(), ['MARKER_SALVAGE', 'MARKER_SUSPECT']);
});

test('withdrawn evidence re-queues an EVIDENCE-CONFLICT file, which is then applied', async () => {
  const c = read('conflict-outlet--critic-three.json');
  delete c.contentVerification;
  write('conflict-outlet--critic-three.json', c);
  assert.deepEqual(await run(), ['MARKER_CONFLICT', 'MARKER_SALVAGE', 'MARKER_SUSPECT']);
  assert.equal(read('conflict-outlet--critic-three.json').isNonReview, true);
});

test('pure decision: stamp reasons, lane lapse, overwrite', () => {
  assert.equal(cache.classifyStampReason('uncertain'), 'uncertain');
  assert.equal(cache.classifyStampReason('lane-skip'), 'lane-skip');
  assert.equal(cache.classifyStampReason('evidence-conflict'), 'evidence-conflict');
  assert.equal(cache.classifyStampReason('extraction-suspect'), null);

  const pv = 'g1-abc';
  const fullText = longText('X');
  const lane = { fullText, ...cache.buildVerdictStamp(cache.CLASSIFY_FIELDS, { text: fullText, context: TITLE, reason: 'lane-skip', promptVersion: pv, provider: 'gemini:m' }) };
  assert.equal(cache.shouldSkipClassify(lane, { showTitle: TITLE, promptVersion: pv, provider: 'gemini:m', laneStillBypasses: true }), true);
  assert.equal(cache.shouldSkipClassify(lane, { showTitle: TITLE, promptVersion: pv, provider: 'gemini:m', laneStillBypasses: false }), false, 'lapsed lane re-queues');
  assert.equal(cache.shouldSkipClassify(lane, { showTitle: TITLE, promptVersion: pv, provider: 'gemini:m', laneStillBypasses: true, overwrite: true }), false);
  assert.equal(cache.shouldSkipClassify(lane, { showTitle: 'Other Title', promptVersion: pv, provider: 'gemini:m', laneStillBypasses: true }), false, 'prompt context change re-queues');
  assert.equal(cache.shouldSkipClassify({ fullText }, { showTitle: TITLE, promptVersion: pv, provider: 'gemini:m' }), false);
  assert.equal(cache.shouldSkipClassify(lane, { showTitle: TITLE, promptVersion: pv, provider: 'claude:m', laneStillBypasses: true }), false, 'other model re-queues');
});

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
