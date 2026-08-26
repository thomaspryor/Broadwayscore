// Coverage Verdict S0 (task #902) — explainExclusion() parity + rule-name contract.
//
// explainExclusion() is the SINGLE implementation of the includability decision;
// isIncludableForRebuild() is a wrapper over it. This test exists to catch the
// day someone re-forks the two (the bug class in
// memory/feedback_includability_predicates_must_be_canonical.md — a "mirror"
// predicate that drifts from the thing it mirrors and silently stops agreeing).
//
// Three layers, cheapest first:
//   1. structural — isIncludableForRebuild's source really delegates
//   2. fixtures   — each rule name fires for the input that should trigger it
//   3. corpus     — explain()===null <=> isIncludable()===true on every
//                   review-text file on disk (~41.6K files, ~8s)
//
// Run: node --test scripts/lib/review-guards.explain.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const guards = require('./review-guards.js');
const { explainExclusion, isIncludableForRebuild } = guards;

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR || path.join(ROOT, 'data', 'review-texts');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');
// The corpus layer skips when data/review-texts is absent so a bare worktree can
// still run layers 1-2. That skip is a LOCAL affordance only: set
// REQUIRE_REVIEW_CORPUS=1 and a missing corpus is a hard failure instead. CI sets
// it on the one job that checks the corpus out, so "the parity test was green"
// can never again mean "the parity test skipped" (see the workflow comment in
// test.yml's Data Validation job).
const REQUIRE_CORPUS = process.env.REQUIRE_REVIEW_CORPUS === '1';

test('explainExclusion is exported and returns null / a rule name (never a boolean)', () => {
  assert.strictEqual(typeof explainExclusion, 'function');
  assert.strictEqual(explainExclusion(null), 'no-data');
  const clean = { fullText: 'A real review with plenty of text.', url: 'https://example.com/review' };
  assert.strictEqual(explainExclusion(clean, null, undefined), null);
  for (const input of [null, clean, { wrongShow: true }]) {
    const r = explainExclusion(input, null, undefined);
    assert.ok(r === null || typeof r === 'string', `expected null|string, got ${typeof r}`);
    assert.notStrictEqual(typeof r, 'boolean');
  }
});

test('isIncludableForRebuild delegates to explainExclusion (no forked rule chain)', () => {
  // Structural guard: catches a re-fork at the moment it is written, rather than
  // waiting for the two copies to disagree on some future corpus file.
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'review-guards.js'), 'utf8');
  const m = src.match(/function isIncludableForRebuild\(data, show, filePath\) \{([\s\S]*?)\n\}/);
  assert.ok(m, 'isIncludableForRebuild not found with the expected signature');
  const body = m[1].replace(/\/\/.*$/gm, '').trim();
  assert.strictEqual(
    body,
    "return explainExclusion(data, show, filePath) === null;",
    'isIncludableForRebuild must stay a one-line delegation to explainExclusion — do not reimplement the rule chain'
  );
});

test('scoring-delta.js compares explainExclusion, not just the wrapper', () => {
  // The §12.7 gate detects guard-logic edits by diffing predicate SOURCE
  // (scoring-delta.js `guardsIdentical`). isIncludableForRebuild is now a
  // permanent 2-line wrapper, so its source is frozen — comparing only it means
  // every future rule edit reads as "decisions identical" and skips the
  // inclusion replay. That is the exact 2026-07-21 blind spot the list was
  // extended to close; this test keeps it closed.
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'scoring-delta.js'), 'utf8');
  assert.match(
    src,
    /baseline\.explainExclusion\?\.toString\(\)[\s\S]{0,80}working\.explainExclusion\?\.toString\(\)/,
    'scoring-delta.js must include explainExclusion in its guard-identity comparison'
  );
});

test('each exclusion rule name fires for its own trigger', () => {
  const text = 'A perfectly ordinary review body with more than enough words to pass the text gate.';
  const cases = [
    ['no-data', null],
    ['wrongProduction', { fullText: text, wrongProduction: true }],
    ['wrongShow', { fullText: text, wrongShow: true }],
    ['wrongAttribution', { fullText: text, wrongAttribution: true }],
    ['duplicateOf', { fullText: text, duplicateOf: 'other--critic.json' }],
    ['isRoundupArticle', { fullText: text, isRoundupArticle: true }],
    ['nonReview', { fullText: text, isNonReview: true }],
    ['nonReview', { fullText: text, nonReviewContent: true }],
    ['fabricatedEntry', { fullText: text, fabricatedEntry: true }],
    ['isSyndicatedDuplicate', { fullText: text, isSyndicatedDuplicate: true }],
    ['crossOutletDuplicate', { fullText: text, crossOutletDuplicate: true }],
    ['scoreStatusToBeCalculated', { fullText: text, scoreStatus: 'TO_BE_CALCULATED' }],
    ['bwwAggregatorAmbiguous', { fullText: text, bwwAggregatorAmbiguous: true }],
    ['cvWrongArticleHighConfidence', { fullText: text, contentVerification: { wrongArticle: true, confidence: 'high' } }],
    ['rejectionReason', { fullText: text, rejectionReason: 'garbage_text' }],
    ['rejectedByMultipleModels', { fullText: text, rejectedBy: ['gpt', 'claude'] }],
    ['rejectedAt', { fullText: text, rejectedAt: '2026-01-01T00:00:00Z' }],
    ['contentTierInvalid', { fullText: text, contentTier: 'invalid' }],
    ['fullTextWrongAuthorNoExcerpt', { fullText: text, fullTextWrongAuthor: true }],
    ['noTextOrScoreSignal', { url: 'https://example.com/review' }],
    ['blockedReviewUrl', { fullText: text, url: 'https://www.google.com/url?q=https://example.com' }],
    // wrongShow survives its own rule (manually cleared) but still blocks the
    // stale wrong_content flag — the real live shape of this rule.
    ['wrongContentFlagsUncleared', { fullText: text, incompleteReason: 'wrong_content', wrongShow: true, wrongShowManualClear: true }],
    ['wrongContentNoUsableSignal', { incompleteReason: 'wrong_content' }],
  ];
  for (const [expected, data] of cases) {
    const got = explainExclusion(data, null, undefined);
    assert.strictEqual(got, expected, `expected rule "${expected}" for ${JSON.stringify(data)?.slice(0, 120)}, got "${got}"`);
    assert.strictEqual(isIncludableForRebuild(data, null, undefined), false);
  }
});

test('a clean review yields null and includable=true', () => {
  const clean = {
    fullText: 'A perfectly ordinary review body with more than enough words to pass the text gate.',
    url: 'https://www.nytimes.com/2026/01/01/theater/some-show-review.html',
    outletId: 'nytimes',
    criticName: 'Jesse Green',
  };
  assert.strictEqual(explainExclusion(clean, null, undefined), null);
  assert.strictEqual(isIncludableForRebuild(clean, null, undefined), true);
});

// BRO-2317 — a stale duplicateTextOf on a duplicate cluster's WINNER must not
// silently disable exclusion for every OTHER loser in the cluster. Real
// incident (2026-08-26): loves-labours-lost-globe-west-end-2026 had a 3-file
// same-URL Times cluster whose winner held its own fullText but ALSO carried a
// stale duplicateTextOf pointing at one of the two losers — that made the
// OTHER loser (whose duplicateOf points at the winner, non-circularly) look
// like it referenced "a reference that's also a dupe, elsewhere" and fall
// through unexcluded, tripping validate-data.js's NEW-duplicate-URL gate on
// main and failing all 17 open PRs.
function mkShowDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bro2317-'));
}

test('BRO-2317: real 3-file cluster — winner\'s own duplicateTextOf (set by collect-review-texts.js\'s content-fingerprint dedup, per its own fullText) does NOT block loser2 exclusion', () => {
  const showDir = mkShowDir();
  try {
    const url = 'https://www.thetimes.co.uk/article/loves-labours-lost-review-abc123';
    const winnerFile = 'times-uk--clive-davis.json';
    const loser1File = 'times-uk--david-jays-and-maxie-szalwinska.json';
    const loser2File = 'times-uk--other-critic.json';
    // loser1 is processed first and gets its own fullText; the winner is
    // processed later, its content-fingerprint matches loser1's, so
    // collect-review-texts.js's dedup pass ("1C. Content hash dedup") stamps
    // duplicateTextOf on the WINNER — this is normal, not stale, and the
    // winner legitimately keeps its own fullText alongside it (real corpus
    // pattern, confirmed via collect-review-texts.js:~4898).
    fs.writeFileSync(path.join(showDir, loser1File), JSON.stringify({
      url,
      fullText: 'The winner review holds its own full text right here, plenty of words.',
    }));
    fs.writeFileSync(path.join(showDir, winnerFile), JSON.stringify({
      url,
      fullText: 'The winner review holds its own full text right here, plenty of words.',
      duplicateTextOf: loser1File,
    }));
    fs.writeFileSync(path.join(showDir, loser2File), JSON.stringify({
      url,
      duplicateOf: winnerFile,
    }));

    const loser2Data = JSON.parse(fs.readFileSync(path.join(showDir, loser2File), 'utf8'));
    const reason = explainExclusion(loser2Data, null, path.join(showDir, loser2File));
    assert.strictEqual(reason, 'duplicateOf', 'loser2 must be excluded as a duplicate despite the winner\'s duplicateTextOf pointing elsewhere');
    assert.strictEqual(isIncludableForRebuild(loser2Data, null, path.join(showDir, loser2File)), false);
  } finally {
    fs.rmSync(showDir, { recursive: true, force: true });
  }
});

test('BRO-2317: winner\'s duplicateTextOf pointing straight back at ME (circular) still gets the same-URL tiebreak, not a silent fall-through', () => {
  const showDir = mkShowDir();
  try {
    const url = 'https://www.thetimes.co.uk/article/loves-labours-lost-review-abc123';
    const winnerFile = 'times-uk--clive-davis.json';
    const loser1File = 'times-uk--david-jays-and-maxie-szalwinska.json';

    fs.writeFileSync(path.join(showDir, winnerFile), JSON.stringify({
      url,
      fullText: 'The winner review holds its own full text right here, plenty of words.',
      duplicateTextOf: loser1File,
    }));
    // loser1 has no fullText of its own (a bare duplicateOf stub) — the
    // fingerprint check can't run, but same-URL alone must still tiebreak it,
    // matching rebuild-all-reviews.js's same-URL fallback.
    fs.writeFileSync(path.join(showDir, loser1File), JSON.stringify({
      url,
      duplicateOf: winnerFile,
    }));

    const loser1Data = JSON.parse(fs.readFileSync(path.join(showDir, loser1File), 'utf8'));
    const reason = explainExclusion(loser1Data, null, path.join(showDir, loser1File));
    assert.strictEqual(reason, 'duplicateOfCircularTiebreak', 'a circular same-URL pair without a fingerprint match on both sides must still tiebreak via same-URL, not silently fall through');
  } finally {
    fs.rmSync(showDir, { recursive: true, force: true });
  }
});

test('BRO-2317: duplicateOf on the reference (a real verdict, not a text pointer) still lets a non-circular loser through unexcluded (unchanged pre-existing behavior)', () => {
  const showDir = mkShowDir();
  try {
    const url = 'https://example.com/review-a';
    const winnerFile = 'outlet--winner.json';
    const loserFile = 'outlet--loser.json';

    // The "winner" here is itself still flagged with a live duplicateOf verdict
    // pointing at some OTHER, unrelated file — that's a real unresolved dupe
    // signal (not a stale text pointer), so the recovery fall-through must
    // still apply exactly as before BRO-2317.
    fs.writeFileSync(path.join(showDir, winnerFile), JSON.stringify({
      url,
      fullText: 'Some other unrelated full text.',
      duplicateOf: 'outlet--yet-another.json',
    }));
    fs.writeFileSync(path.join(showDir, loserFile), JSON.stringify({
      url,
      fullText: 'This file has its own full text too, plenty of words for the text gate.',
      duplicateOf: winnerFile,
    }));

    const loserData = JSON.parse(fs.readFileSync(path.join(showDir, loserFile), 'utf8'));
    const reason = explainExclusion(loserData, null, path.join(showDir, loserFile));
    assert.strictEqual(reason, null, 'a reference with its own live duplicateOf verdict should still recover the pointing file (fall through), unlike a stale duplicateTextOf');
  } finally {
    fs.rmSync(showDir, { recursive: true, force: true });
  }
});

test('BRO-2317: mutual circular duplicateOf pair with same fingerprint still tiebreaks correctly (isCircular untouched by the fix)', () => {
  const showDir = mkShowDir();
  try {
    const sameText = 'A perfectly ordinary review body shared by both circularly-pointing files here.';
    const aFile = 'outlet--aaa.json';
    const bFile = 'outlet--bbb.json';
    fs.writeFileSync(path.join(showDir, aFile), JSON.stringify({ fullText: sameText, duplicateOf: bFile }));
    fs.writeFileSync(path.join(showDir, bFile), JSON.stringify({ fullText: sameText, duplicateOf: aFile }));

    const aData = JSON.parse(fs.readFileSync(path.join(showDir, aFile), 'utf8'));
    const bData = JSON.parse(fs.readFileSync(path.join(showDir, bFile), 'utf8'));
    // Lexicographically-greater filename (bbb > aaa) is excluded; the other is kept.
    assert.strictEqual(explainExclusion(bData, null, path.join(showDir, bFile)), 'duplicateOfCircularTiebreak');
    assert.strictEqual(explainExclusion(aData, null, path.join(showDir, aFile)), null);
  } finally {
    fs.rmSync(showDir, { recursive: true, force: true });
  }
});

test('parity: explainExclusion()===null <=> isIncludableForRebuild()===true on every corpus file', (t) => {
  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    // NOT populated by checkout-core-data — that action copies only
    // /tmp/core-data-checkout/*.json into data/, never data/review-texts/. The
    // corpus lives in a separate private repo pulled by checkout-review-texts,
    // which the unit-tests job (where the scripts/lib/*.test.mjs glob runs) does
    // not use. So this branch is the CI default, not the local edge case: until
    // REQUIRE_REVIEW_CORPUS was added, "parity test green" in CI meant "parity
    // test skipped" on every single run.
    assert.ok(
      !REQUIRE_CORPUS,
      `REQUIRE_REVIEW_CORPUS=1 but no corpus at ${REVIEW_TEXTS_DIR} — the review-texts checkout did not land, so the parity layer would have silently skipped. Fix the checkout rather than unsetting the flag.`
    );
    t.skip(`no corpus at ${REVIEW_TEXTS_DIR} (run ./scripts/setup-local-data.sh, or set REVIEW_TEXTS_DIR)`);
    return;
  }
  let byId = new Map();
  try {
    const shows = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
    byId = new Map((shows.shows || shows).map(s => [s.id, s]));
  } catch { /* show context is optional for the parity contract */ }

  let files = 0;
  const mismatches = [];
  for (const dir of fs.readdirSync(REVIEW_TEXTS_DIR)) {
    const showDir = path.join(REVIEW_TEXTS_DIR, dir);
    let st;
    try { st = fs.statSync(showDir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const show = byId.get(dir) || null;
    let entries;
    try { entries = fs.readdirSync(showDir); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith('.json')) continue;
      const fp = path.join(showDir, f);
      let data;
      try { data = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
      files++;
      const reason = explainExclusion(data, show, fp);
      const includable = isIncludableForRebuild(data, show, fp);
      if ((reason === null) !== includable) {
        if (mismatches.length < 10) mismatches.push({ file: fp, reason, includable });
      }
      if (reason !== null && typeof reason !== 'string') {
        if (mismatches.length < 10) mismatches.push({ file: fp, badReasonType: typeof reason });
      }
    }
  }
  // An EMPTY corpus dir is the same situation as a missing one, and it is what
  // CI actually produces: something in the unit-tests job leaves a bare
  // data/review-texts/ behind (nothing is tracked under it — `git ls-tree
  // data/review-texts/` is 0 files — and checkout-review-texts never runs in
  // that job), so existsSync() said yes, the sweep read 0 files, and this
  // assertion failed the whole workflow. Presence of the directory is not
  // presence of the corpus; only the file count decides. Same policy as the
  // missing-dir branch above: hard-fail under REQUIRE_REVIEW_CORPUS, skip
  // otherwise.
  if (files === 0) {
    assert.ok(
      !REQUIRE_CORPUS,
      `REQUIRE_REVIEW_CORPUS=1 but ${REVIEW_TEXTS_DIR} holds 0 readable review files — the review-texts checkout did not land, so the parity layer would have been vacuous. Fix the checkout rather than unsetting the flag.`
    );
    t.skip(`corpus at ${REVIEW_TEXTS_DIR} is empty (run ./scripts/setup-local-data.sh, or set REVIEW_TEXTS_DIR)`);
    return;
  }
  assert.deepStrictEqual(mismatches, [], `explain/boolean disagreement on ${mismatches.length}+ of ${files} corpus files`);
});
