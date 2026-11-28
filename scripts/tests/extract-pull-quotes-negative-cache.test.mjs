// BRO-7535: extract-pull-quotes.js must remember final rejections.
//
// Before the fix a review whose extraction was rejected (quote not in the
// text, NONE, hedge after retry, ...) got no stamp, so every run re-asked
// Gemini about the same ~1,100 reviews: ~1,940 calls per run, 0 written,
// about 650 USD/month. This test drives the REAL extractor (CLAUDE.md §15:
// require()d, LLM swapped for a fake) over synthetic fixtures and asserts the
// second pass makes zero LLM calls. Revert the stamp or the scan skip and the
// second-pass assertion fails.
//
// Fixtures are synthetic text written here; no real review text (private).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Fixture-only: safeWriteReview would otherwise read the live data/shows.json
// (live-data-lane gate). An empty show map makes its show-aware guards no-op.
require('../lib/review-write-guard.js')._setShowsCacheForTest(new Map());
const negCache = require('../lib/pull-quote-negative-cache.js');

const SENTENCES = [
  'The production at the Lantern Theatre opened on a damp Thursday evening with a full house.',
  'Its director has staged the piece with an eye for crisp movement and clean sightlines throughout.',
  'The second act gathers pace and the ensemble finds a confident rhythm that carries the finale.',
  'Several songs land with real force, and the orchestrations give the score a generous warmth.',
  'This is a sturdy, enjoyable evening that rewards anyone who loves a well built musical comedy.',
];
const FULL_TEXT = SENTENCES.join(' ');

function writeFixture(dir, show, name, extra = {}) {
  const showDir = path.join(dir, show);
  fs.mkdirSync(showDir, { recursive: true });
  const file = path.join(showDir, name);
  fs.writeFileSync(file, JSON.stringify({
    showId: show,
    outlet: 'Synthetic Gazette',
    outletId: 'synthetic-gazette',
    criticName: 'Test Critic',
    assignedScore: 60,
    contentTier: 'complete',
    fullText: FULL_TEXT,
    ...extra,
  }, null, 2));
  return file;
}

// One shared temp corpus; the extractor reads REVIEW_TEXTS_DIR at load time.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pq-negcache-'));
process.env.REVIEW_TEXTS_DIR = ROOT;
const extractor = require('../extract-pull-quotes.js');

let calls = 0;
let reply = () => 'A sentence the critic never wrote anywhere in this synthetic review, invented whole.';
extractor._setLLMForTest(async () => { calls++; return reply(); });

async function runPass() {
  const before = calls;
  const files = extractor.scanReviewFiles();
  for (const f of files) await extractor.processReview(f);
  return { files: files.length, calls: calls - before };
}

test('a rejected review is stamped and the second pass makes zero LLM calls', async () => {
  const file = writeFixture(ROOT, 'neg-cache-show-2026', 'synthetic-gazette--test-critic.json');

  const first = await runPass();
  assert.equal(first.files, 1, 'first pass should queue the unstamped review');
  assert.ok(first.calls >= 1, 'first pass should ask the LLM');

  const stamped = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(stamped.llmPullQuoteRejectedAt, 'final rejection must be stamped on the review file');
  assert.equal(stamped.llmPullQuoteRejectReason, 'not-in-text');
  assert.equal(stamped.llmPullQuoteRejectPromptVersion, extractor.PROMPT_VERSION);
  assert.equal(stamped.llmPullQuoteRejectInputHash, negCache.judgedInputHash(FULL_TEXT, 60));
  assert.equal(stamped.fullText, FULL_TEXT, 'stamp must not touch fullText');

  const second = await runPass();
  assert.equal(second.files, 0, 'second pass must not queue the stamped review');
  assert.equal(second.calls, 0, 'second pass over the same rejected review must make zero LLM calls');

  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('NONE answers are remembered too', async () => {
  reply = () => 'NONE';
  const file = writeFixture(ROOT, 'neg-cache-none-2026', 'synthetic-gazette--test-critic.json');
  await runPass();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).llmPullQuoteRejectReason, 'none');
  assert.equal((await runPass()).calls, 0);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('empty replies (safety/recitation blocks) are remembered', async () => {
  reply = () => '';
  const file = writeFixture(ROOT, 'neg-cache-empty-2026', 'synthetic-gazette--test-critic.json');
  await runPass();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).llmPullQuoteRejectReason, 'empty-reply');
  assert.equal((await runPass()).calls, 0);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('transient LLM failures are not stamped (retried next run)', async () => {
  reply = () => { throw new Error('HTTP 500'); };
  const file = writeFixture(ROOT, 'neg-cache-err-2026', 'synthetic-gazette--test-critic.json');
  await runPass();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).llmPullQuoteRejectedAt, undefined);
  assert.equal(extractor.scanReviewFiles().length, 1, 'errored review stays queued');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('changed fullText or prompt version re-queues; overwrite ignores the stamp', () => {
  const pv = extractor.PROMPT_VERSION;
  const stamp = negCache.buildRejectionStamp({ fullText: FULL_TEXT, reason: 'not-in-text', promptVersion: pv });
  const data = { fullText: FULL_TEXT, ...stamp };
  // stamp was built with no score; the review has none either

  assert.equal(negCache.shouldSkipForPriorRejection(data, { promptVersion: pv }), true);
  assert.equal(negCache.shouldSkipForPriorRejection({ ...data, fullText: FULL_TEXT + ' More text.' }, { promptVersion: pv }), false);
  assert.equal(negCache.shouldSkipForPriorRejection(data, { promptVersion: 'g9-other' }), false);
  assert.equal(negCache.shouldSkipForPriorRejection(data, { promptVersion: pv, overwrite: true }), false);
  assert.equal(negCache.shouldSkipForPriorRejection({ fullText: FULL_TEXT }, { promptVersion: pv }), false);
});

test('a score change re-queues a stamped review (the prompt verdict line and hedge guard use it)', async () => {
  reply = () => 'NONE';
  const file = writeFixture(ROOT, 'neg-cache-score-2026', 'synthetic-gazette--test-critic.json', { assignedScore: null });
  await runPass();
  assert.equal((await runPass()).calls, 0, 'unchanged unscored review stays skipped');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.assignedScore = 88; // scoring landed after the rejection
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  assert.ok((await runPass()).calls >= 1, 'newly scored review must be asked again');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('prompt version follows the prompt text', () => {
  assert.notEqual(negCache.promptVersionFor('prompt A'), negCache.promptVersionFor('prompt B'));
  assert.equal(negCache.promptVersionFor('prompt A'), negCache.promptVersionFor('prompt A'));
});

test('tripwire fires on many calls with nothing persisted, not otherwise', () => {
  assert.match(negCache.wastedRunTripwire({ llmCalls: 1942, written: 0, stamped: 0 }), /1942 LLM calls/);
  assert.equal(negCache.wastedRunTripwire({ llmCalls: 1942, written: 0, stamped: 900 }), null);
  assert.equal(negCache.wastedRunTripwire({ llmCalls: 1942, written: 3, stamped: 0 }), null);
  assert.equal(negCache.wastedRunTripwire({ llmCalls: 20, written: 0, stamped: 0 }), null);
});

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
