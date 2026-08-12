/**
 * Dispatch-verifiable acceptance for task #1146: the rebuild's UK/major-outlet
 * and allowCrossMarket wrongShow auto-clear paths must never override a
 * >=2-model ensemble wrong_show verdict, nor vouch for a URL rewrite the
 * on-disk text predates.
 *
 * Unlike this repo's usual colocated unit tests, the corpus-scan test here
 * deliberately asserts against LIVE review-texts data rather than a fixture
 * (mirrors scripts/verify-provider-spend-streak.test.mjs) — it's the safe-form
 * command scripts/autonomous-acceptance-recheck.js re-runs to confirm the
 * contradictory state (rejectionReason='wrong_show' + wrongShowAutoCleared +
 * wrongShow!==true) stays at 0 going forward, not just at fix time.
 *
 * Run: node --test scripts/lib/wrongshow-autoclear-ensemble.test.mjs
 * (locally, point REVIEW_TEXTS_DIR at the canonical ~/broadway-review-texts
 * clone — the in-repo data/review-texts copy can be stale; see
 * memory/feedback_review_texts_not_symlink.md.)
 *
 * The corpus test SKIPS when data/review-texts is missing/empty rather than
 * failing — the scripts/lib/*.test.mjs glob runs in the unit-tests job, which
 * only runs checkout-core-data (top-level *.json), never checkout-review-texts
 * (task #1146 ship-check finding: this file would have hard-failed every CI
 * run once merged, the same corpus-missing trap review-guards.explain.test.mjs
 * hit before REQUIRE_REVIEW_CORPUS existed — see that file and the "Run
 * explainExclusion corpus parity" step in test.yml for the precedent). Set
 * REQUIRE_REVIEW_CORPUS=1 to turn a missing/empty corpus into a hard failure
 * instead of a silent skip; test.yml sets it only on the data-validation job's
 * re-run of this file, which does check out review-texts first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  shouldAutoClearWrongShowUkUrl,
  hasEnsembleConsensus,
  isTextStaleRelativeToUrlRewrite,
} = require('./wrong-production-autoclear.js');
// Generalized to (data, reason) under #1156 — see scripts/lib/autoclear-vs-ensemble.test.mjs
// for the wrongProduction-side coverage of the same functions.
const hasEnsembleWrongShowConsensus = (data) => hasEnsembleConsensus(data, 'wrong_show');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR || path.join(HERE, '..', '..', 'data', 'review-texts');
const REQUIRE_CORPUS = process.env.REQUIRE_REVIEW_CORPUS === '1';

test('unanimous 3/3 wrong_show ensemble verdict + UK-outlet URL on a London show is NOT auto-cleared', () => {
  const data = {
    wrongShow: true,
    rejectionReason: 'wrong_show',
    rejectedBy: 'ensemble-scoreability-check',
    rejectionReasoning:
      "claude: This review is about 'Noughts & Crosses' at Regent's Park Open Air Theatre, not 'Romeo and Juliet' at Harold Pinter Theatre; " +
      "openai: The text is a review of 'Noughts & Crosses' at the Regent's Park Open Air Theatre, not 'Romeo and Juliet' at the Harold Pinter Theatre.; " +
      "gemini: This review is for Noughts & Crosses at Regent's Park Open Air Theatre, not Romeo and Juliet at Harold Pinter Theatre.",
  };
  const wouldClear = shouldAutoClearWrongShowUkUrl(data, {
    isLondonMarketShow: true,
    isUkOutletUrl: true,
    dateMismatchOver90d: false,
  });
  assert.equal(wouldClear, false, 'a 3/3-model ensemble wrong_show verdict must outrank the UK-outlet-URL heuristic');
});

test('a single model reasoning that happens to contain a time-like "N:NN" after a semicolon is not miscounted as a 2nd model (ship-check regression)', () => {
  // Only "claude:" ever labels a segment here — the "8:00pm" inside claude's
  // own free-text reasoning must not be mistaken for a second model's tag.
  const data = {
    rejectionReason: 'wrong_show',
    rejectedBy: 'ensemble-scoreability-check',
    rejectionReasoning: 'claude: this review mentions an 8:00pm curtain; not the same show',
  };
  assert.equal(hasEnsembleWrongShowConsensus(data), false);
});

test('a genuine 2-model consensus is still detected', () => {
  const data = {
    rejectionReason: 'wrong_show',
    rejectedBy: 'ensemble-scoreability-check',
    rejectionReasoning: 'claude: wrong show; openai: also wrong show',
  };
  assert.equal(hasEnsembleWrongShowConsensus(data), true);
});

test('a same-day fetch-before-rewrite gap is detected as stale (ship-check regression)', () => {
  // parseDate() truncates to UTC midnight, which would have collapsed both
  // timestamps to the same instant and hidden a real same-day staleness gap.
  const data = {
    urlCorrectedFrom: 'https://example.com/old-article',
    urlUpdatedAt: '2026-04-03T23:00:00.000Z',
    textFetchedAt: '2026-04-03T01:00:00.000Z',
  };
  assert.equal(isTextStaleRelativeToUrlRewrite(data), true);
});

test('corpus: no review-text file has rejectionReason=wrong_show + wrongShowAutoCleared + wrongShow!==true', (t) => {
  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    assert.ok(
      !REQUIRE_CORPUS,
      `REQUIRE_REVIEW_CORPUS=1 but no corpus at ${REVIEW_TEXTS_DIR} — the review-texts checkout did not land, so this scan would have silently skipped. Fix the checkout rather than unsetting the flag.`
    );
    t.skip(`no corpus at ${REVIEW_TEXTS_DIR} (run ./scripts/setup-local-data.sh, or set REVIEW_TEXTS_DIR)`);
    return;
  }

  const offenders = [];
  let files = 0;
  for (const showId of fs.readdirSync(REVIEW_TEXTS_DIR)) {
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    let stat;
    try {
      stat = fs.statSync(showDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const file of fs.readdirSync(showDir)) {
      if (!file.endsWith('.json')) continue;
      let data;
      try {
        data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
      } catch {
        continue;
      }
      files++;
      if (data.rejectionReason === 'wrong_show' && data.wrongShowAutoCleared && data.wrongShow !== true) {
        offenders.push(`${showId}/${file}`);
      }
    }
  }

  if (files === 0) {
    assert.ok(
      !REQUIRE_CORPUS,
      `REQUIRE_REVIEW_CORPUS=1 but ${REVIEW_TEXTS_DIR} holds 0 readable review files — the review-texts checkout did not land, so this scan would have been vacuous. Fix the checkout rather than unsetting the flag.`
    );
    t.skip(`corpus at ${REVIEW_TEXTS_DIR} is empty (run ./scripts/setup-local-data.sh, or set REVIEW_TEXTS_DIR)`);
    return;
  }

  assert.equal(
    offenders.length,
    0,
    `${offenders.length} file(s) have rejectionReason='wrong_show' + wrongShowAutoCleared but wrongShow!==true ` +
      `(auto-clear outranked the ensemble verdict): ${offenders.slice(0, 10).join(', ')}`
  );
});
