// LIVE-DATA-LANE: corpus half reads data/review-texts (skipped when absent). Runs in check-corpus-drift.yml (BRO-7101).
// BRO-2453: decideEarlyFileExclusion is the ONE shared decision for the four early per-file gates
// (rebuild-all-reviews.js, explainExclusion, scoring-delta.js decideInclusion).
// 1. Unit: order, labels, opts routing, missing-predicate policy.
// 2. Source shape: no inline copy of the chain returns to rebuild / explainExclusion / scoring-delta.
// 3. Corpus: identical decisions to the FROZEN legacy inline chain on every real review file.
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
const g = require('./review-guards.js');
const { decideEarlyFileExclusion } = g;

// FROZEN pre-BRO-2453 inline chain (baseline only; never edit to "match").
function LEGACY(data, show, opts) {
  if (g.isCancelledBeforeOpeningShow(show)) return 'cancelledBeforeOpening';
  if (g.isUnverifiableWebSearchRow(data, opts)) return 'unverifiableWebSearchRow';
  if (g.isPreviewFirstLookPiece(data)) return 'previewFirstLookPiece';
  if (g.isCombinedReviewOfOtherMemberOnly(data, show)) return 'combinedReviewOfOtherMemberOnly';
  return null;
}

test('order: first matching gate wins, labels and statKeys line up', () => {
  const stub = (hits) => Object.fromEntries(['isCancelledBeforeOpeningShow', 'isUnverifiableWebSearchRow', 'isPreviewFirstLookPiece', 'isCombinedReviewOfOtherMemberOnly'].map(n => [n, () => hits.includes(n)]));
  assert.equal(decideEarlyFileExclusion({}, {}, { guards: stub([]) }), null);
  assert.deepEqual(decideEarlyFileExclusion({}, {}, { guards: stub(['isCombinedReviewOfOtherMemberOnly', 'isPreviewFirstLookPiece']) }),
    { statKey: 'skippedPreviewFirstLookPiece', reason: 'previewFirstLookPiece' });
  assert.equal(decideEarlyFileExclusion({}, {}, { guards: stub(['isCancelledBeforeOpeningShow', 'isUnverifiableWebSearchRow']) }).reason, 'cancelledBeforeOpening');
  assert.equal(decideEarlyFileExclusion({}, {}, { guards: stub(['isCombinedReviewOfOtherMemberOnly']) }).statKey, 'skippedCombinedReviewOfOtherMemberOnly');
});

test('opts reach only isUnverifiableWebSearchRow', () => {
  const seen = {};
  const guards = {
    isCancelledBeforeOpeningShow: () => false,
    isUnverifiableWebSearchRow: (d, o) => { seen.u = o; return false; },
    isPreviewFirstLookPiece: () => false,
    isCombinedReviewOfOtherMemberOnly: (...a) => { seen.argc = a.length; return false; },
  };
  decideEarlyFileExclusion({}, {}, { guards, opts: { forScoring: true } });
  assert.deepEqual(seen.u, { forScoring: true });
  assert.equal(seen.argc, 2);
});

test('missing predicate throws unless tolerateMissing', () => {
  const guards = { isCancelledBeforeOpeningShow: () => false };
  assert.throws(() => decideEarlyFileExclusion({}, {}, { guards }), /missing predicate/);
  assert.equal(decideEarlyFileExclusion({}, {}, { guards, tolerateMissing: true }), null);
});

test('source shape: callers use the shared function, no inline chain', () => {
  const rebuild = fs.readFileSync(path.join(REPO_ROOT, 'scripts/rebuild-all-reviews.js'), 'utf8');
  const delta = fs.readFileSync(path.join(REPO_ROOT, 'scripts/scoring-delta.js'), 'utf8');
  const guardsSrc = fs.readFileSync(path.join(__dirname, 'review-guards.js'), 'utf8');
  assert.match(rebuild, /decideEarlyFileExclusion\(data, showById\[showId\]\)/);
  assert.doesNotMatch(rebuild, /if \(isCancelledBeforeOpeningShow\(/);
  assert.doesNotMatch(rebuild, /if \(isCombinedReviewOfOtherMemberOnly\(/);
  assert.match(delta, /\)\(review, show, \{ guards, tolerateMissing: true \}\)/);
  for (const n of ['isCancelledBeforeOpeningShow', 'isUnverifiableWebSearchRow', 'isCombinedReviewOfOtherMemberOnly']) {
    assert.doesNotMatch(delta, new RegExp('guards\\.' + n + '\\(review'), n + ' inline copy returned to decideInclusion');
  }
  assert.doesNotMatch(delta, /guards\.isPreviewFirstLookPiece\(review\)/);
  assert.match(guardsSrc, /decideEarlyFileExclusion\(data, show, \{ opts \}\)/);
});

function corpusDir() {
  const cands = [process.env.REVIEW_TEXTS_DIR, path.join(REPO_ROOT, 'data', 'review-texts'), path.join(os.homedir(), 'Broadwayscore', 'data', 'review-texts')].filter(Boolean);
  return cands.find(d => fs.existsSync(d) && fs.readdirSync(d).length > 100) || null;
}

test('corpus: identical decisions to the legacy chain on every review file', { skip: !corpusDir() && 'review-texts absent' }, () => {
  const dir = corpusDir();
  const shows = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data/shows.json'), 'utf8'));
  const byId = Object.fromEntries((shows.shows || shows).map(s => [s.id, s]));
  let files = 0, changed = 0; const counts = {};
  for (const sid of fs.readdirSync(dir)) {
    const sd = path.join(dir, sid);
    let list; try { list = fs.readdirSync(sd); } catch { continue; }
    for (const f of list) {
      if (!f.endsWith('.json')) continue;
      let d; try { d = JSON.parse(fs.readFileSync(path.join(sd, f), 'utf8')); } catch { continue; }
      files++;
      for (const opts of [undefined, { forScoring: true }]) {
        const a = LEGACY(d, byId[sid], opts);
        const n = decideEarlyFileExclusion(d, byId[sid], { opts });
        const b = n ? n.reason : null;
        if (a !== b) changed++;
        if (opts === undefined) counts[a || 'none'] = (counts[a || 'none'] || 0) + 1;
      }
    }
  }
  console.log(`BRO-2453 corpus: files=${files} changedDecisions=${changed} counts=${JSON.stringify(counts)}`);
  assert.ok(files > 1000);
  assert.equal(changed, 0);
});
