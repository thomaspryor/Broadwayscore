// BRO-4404: rebuild-all-reviews.js and review-guards.js explainExclusion must
// agree on the rejectionReason / rejectedAt exclusion. Rebuild used to carry a
// narrower inline copy (structural-star exception only), so files the guards
// call includable (json-ld star, independent excerpt score, fresh wrongProduction
// auto-clear) were silently dropped from reviews.json.
//
// 1. Static: rebuild calls the canonical helpers and holds no inline copy.
// 2. Corpus: helpers agree with explainExclusion on every real review-text file
//    (skipped when the private review-texts checkout is absent).
// 3. Corpus diff: LEGACY_REBUILD_EXCLUDES is the FROZEN pre-fix rebuild predicate,
//    kept only to classify what the fix changed. Every old-vs-new flip must fall in
//    a named class; anything else fails as unexplained.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');
const guards = require('./review-guards.js');
const { isRejectedByReasonExclusion, isRejectedAtExclusion, explainExclusion, hasStructuralStarScore, rejectedAtHumanCleared, isTimestampAfter } = guards;

function corpusDir() {
  const cands = [process.env.REVIEW_TEXTS_DIR, path.join(REPO_ROOT, 'data', 'review-texts'), path.join(os.homedir(), 'Broadwayscore', 'data', 'review-texts')].filter(Boolean);
  return cands.find(d => fs.existsSync(d) && fs.readdirSync(d).length > 100) || null;
}

function* corpus(dir) {
  for (const show of fs.readdirSync(dir)) {
    const sd = path.join(dir, show);
    let files; try { files = fs.readdirSync(sd); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      let data; try { data = JSON.parse(fs.readFileSync(path.join(sd, f), 'utf8')); } catch { continue; }
      if (data && (data.rejectionReason || data.rejectedAt)) yield { show, f, data };
    }
  }
}

// FROZEN pre-BRO-4404 rebuild inline logic (baseline only; never edit to "match").
function LEGACY_REBUILD_EXCLUDES(data) {
  if (data.rejectionReason && !hasStructuralStarScore(data)) return true;
  if (data.rejectedAt && typeof data.rejectedAt === 'string') {
    const reFetched = isTimestampAfter(data.textFetchedAt, data.rejectedAt);
    if (!reFetched && !hasStructuralStarScore(data) && !rejectedAtHumanCleared(data)) return true;
  }
  return false;
}
const NEW_REBUILD_EXCLUDES = d => isRejectedByReasonExclusion(d) || isRejectedAtExclusion(d);

function classifyFlip(d) {
  if (d.rejectionReason === 'not_a_review' && (d.originalScoreSource === 'json-ld' || d.aggregatorStarsSource === 'json-ld')) return 'json-ld-star';
  if (d.rejectionReason === 'not_a_review') return 'independent-excerpt-score';
  if (!d.rejectionReason && d.rejectedAt) return 'rejectedAt-wp-auto-clear-or-excerpt';
  return 'unexplained';
}

test('rebuild delegates rejectionReason/rejectedAt to the canonical helpers, no inline copy', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'rebuild-all-reviews.js'), 'utf8');
  assert.match(src, /if \(isRejectedByReasonExclusion\(data\)(?: && !laneOk\('wrongProduction'\))?\)/);
  assert.match(src, /if \(isRejectedAtExclusion\(data\)(?: && !laneOk\('wrongProduction'\))?\)/);
  assert.doesNotMatch(src, /if \(data\.rejectionReason && !hasStructuralStarScore/);
  assert.doesNotMatch(src, /if \(data\.rejectedAt && typeof data\.rejectedAt === 'string'\)/);
});

test('helpers behave on synthetic cases', () => {
  assert.equal(isRejectedByReasonExclusion({ rejectionReason: 'garbage_text' }), true);
  assert.equal(isRejectedByReasonExclusion({}), false);
  assert.equal(isRejectedAtExclusion({ rejectedAt: '2026-01-01T00:00:00Z' }), true);
  assert.equal(isRejectedAtExclusion({ rejectedAt: '2026-01-01T00:00:00Z', textFetchedAt: '2026-02-01T00:00:00Z' }), false);
  assert.equal(isRejectedAtExclusion({}), false);
});

// CI-safe parity matrix (the corpus test below skips without the private checkout).
test('synthetic matrix: helpers agree with explainExclusion on rejection-shaped records', () => {
  const base = { outletId: 'nytimes', fullText: 'x'.repeat(3000), url: 'https://example.com/review-of-the-show', assignedScore: 80, llmScore: { score: 80 } };
  const long = 'A real independent aggregator quote about the production that is comfortably longer than one hundred and fifty characters so the excerpt gate accepts it as clean content. '.repeat(2);
  const cases = [
    { rejectionReason: 'garbage_text' },
    { rejectionReason: 'not_a_review' },
    { rejectionReason: 'not_a_review', bwwExcerpt: long, aggregatorStars: '4/5' },
    { rejectionReason: 'not_a_review', bwwExcerpt: long, aggregatorStars: '4/5', wrongShow: true },
    { rejectionReason: 'not_a_review', originalScoreSource: 'json-ld', outletId: 'guardian' },
    { rejectionReason: 'not_a_review', scoreSource: 'wos-star-images', originalScoreNormalized: 100 },
    { rejectionReason: 'garbage_text', scoreSource: 'wos-star-images', originalScoreNormalized: 100 },
    { rejectedAt: '2026-01-01T00:00:00Z' },
    { rejectedAt: '2026-01-01T00:00:00Z', textFetchedAt: '2026-03-01T00:00:00Z' },
    { rejectedAt: '2026-01-01T00:00:00Z', wrongProduction: true, wrongProductionManualClear: true },
  ];
  for (const c of cases) {
    const d = { ...base, ...c };
    const helper = NEW_REBUILD_EXCLUDES(d);
    const reason = explainExclusion(d, undefined, 'x.json');
    const blamed = reason === 'rejectionReason' || reason === 'rejectedAt';
    if (helper) assert.notEqual(reason, null, JSON.stringify(c));
    if (!helper) assert.equal(blamed, false, JSON.stringify(c));
  }
});

const dir = corpusDir();
test('corpus: helpers agree with explainExclusion; every old-vs-new flip is classified', { skip: dir ? false : 'review-texts corpus not present' }, () => {
  let scanned = 0;
  const flips = [], disagreements = [];
  for (const { show, f, data } of corpus(dir)) {
    scanned++;
    const helper = NEW_REBUILD_EXCLUDES(data);
    const reason = explainExclusion(data, undefined, path.join(dir, show, f));
    // helper says exclude => explainExclusion must exclude; helper says include => explainExclusion must not blame these two reasons
    if (helper && reason === null) disagreements.push(`${show}/${f}: helper excludes, explainExclusion includes`);
    if (!helper && (reason === 'rejectionReason' || reason === 'rejectedAt')) disagreements.push(`${show}/${f}: helper includes, explainExclusion=${reason}`);
    if (LEGACY_REBUILD_EXCLUDES(data) !== helper) flips.push({ id: `${show}/${f}`, cls: classifyFlip(data), was: LEGACY_REBUILD_EXCLUDES(data), now: helper });
  }
  console.log(`# scanned ${scanned} rejected files; ${flips.length} old-vs-new flips`, JSON.stringify(flips.reduce((a, x) => (a[x.cls + (x.now ? ':now-excluded' : ':now-included')] = (a[x.cls + (x.now ? ':now-excluded' : ':now-included')] || 0) + 1, a), {})));
  assert.deepEqual(disagreements.slice(0, 20), []);
  assert.deepEqual(flips.filter(x => x.now || x.cls === 'unexplained').slice(0, 20), [], 'flips must only be excluded->included and classified');
});
