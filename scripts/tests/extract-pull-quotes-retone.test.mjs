// BRO-8067: a stored pull quote picked for the raw file score (59, "mixed") on a
// review the site shows at 80 is re-picked once, stamped, and never re-asked.
// Runs the real extractor (require()d, LLM faked) twice over a temp corpus.
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

const SENTENCES = [
  'The production at the Lantern Theatre opened on a damp Thursday evening with a full house.',
  'Its director has staged the piece with an eye for crisp movement and clean sightlines throughout.',
  'The second act gathers pace and the ensemble finds a confident rhythm that carries the finale.',
  'Several songs land with real force, and the orchestrations give the score a generous warmth.',
  'This is a sturdy, enjoyable evening that rewards anyone who loves a well built musical comedy.',
];
const FULL_TEXT = SENTENCES.join(' ');
const OLD_QUOTE = SENTENCES[3];
const NEW_QUOTE = SENTENCES[2];

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pq-retone-'));
const ROOT = path.join(DATA, 'review-texts');
const live = [];
function fixture(show, extra = {}, liveScore = 80) {
  const dir = path.join(ROOT, show);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'gazette--test-critic.json');
  const rec = { showId: show, outlet: 'Gazette', outletId: 'gazette', criticName: 'Test Critic', url: `https://ex.com/${show}`,
    assignedScore: 59, contentTier: 'complete', fullText: FULL_TEXT, llmPullQuote: OLD_QUOTE, llmPullQuoteContextCheckedAt: '2026-11-01', ...extra };
  fs.writeFileSync(file, JSON.stringify(rec, null, 2));
  live.push({ showId: show, outletId: 'gazette', criticName: 'Test Critic', url: rec.url, assignedScore: liveScore });
  return file;
}
const repick = fixture('retone-show-2026');
const rejected = fixture('retone-reject-2026');
const human = fixture('retone-human-2026', { approvedFixes: [{ fixId: 'f1', field: 'llmPullQuote', at: '2026-11-01' }] });
const same = fixture('retone-same-2026', {}, 62);
fs.writeFileSync(path.join(DATA, 'reviews.json'), JSON.stringify({ reviews: live }));

process.env.REVIEW_TEXTS_DIR = ROOT;
const extractor = require('../extract-pull-quotes.js');
let calls = 0;
// The fake cannot see the show id in the prompt, so it is set per file.
async function runPass() {
  const before = calls;
  const files = extractor.scanReviewFiles();
  for (const f of files) {
    extractor._setLLMForTest(async () => { calls++; return f.filePath.includes('retone-reject') ? 'Words this critic never wrote in the review at all, invented whole.' : NEW_QUOTE; });
    await extractor.processReview(f);
  }
  return { queued: files.map(f => path.basename(path.dirname(f.filePath))).sort(), calls: calls - before };
}
const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));

test('wrong-direction quote is re-picked once; human, same-direction and rejected ones do not loop', async () => {
  const first = await runPass();
  assert.deepEqual(first.queued, ['retone-reject-2026', 'retone-show-2026']);
  assert.ok(first.calls >= 2);
  assert.equal(read(repick).llmPullQuote, NEW_QUOTE, 're-picked for the site score');
  assert.match(read(repick).llmPullQuoteVerdictBand, /^positive:[0-9a-f]{12}$/);
  assert.equal(read(rejected).llmPullQuote, OLD_QUOTE, 'a rejected re-pick keeps the old quote');
  assert.ok(read(rejected).llmPullQuoteRejectedAt, 'and is stamped');
  assert.equal(read(human).llmPullQuote, OLD_QUOTE, 'plan-edited quote untouched');
  assert.equal(read(same).llmPullQuote, OLD_QUOTE, 'same direction untouched');

  const second = await runPass();
  assert.deepEqual(second.queued, [], 'second pass queues nothing');
  assert.equal(second.calls, 0, 'second pass makes zero LLM calls');
});
