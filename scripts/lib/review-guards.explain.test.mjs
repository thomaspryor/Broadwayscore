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
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const guards = require('./review-guards.js');
const { explainExclusion, isIncludableForRebuild } = guards;

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR || path.join(ROOT, 'data', 'review-texts');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');

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

test('parity: explainExclusion()===null <=> isIncludableForRebuild()===true on every corpus file', (t) => {
  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    // Local worktrees without the private core-data checkout. CI's
    // checkout-core-data action populates it, so the corpus layer always runs
    // there — never silently "pass" by pretending the corpus was checked.
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
  assert.ok(files > 0, `corpus at ${REVIEW_TEXTS_DIR} produced 0 readable files — the parity check would be vacuous`);
  assert.deepStrictEqual(mismatches, [], `explain/boolean disagreement on ${mismatches.length}+ of ${files} corpus files`);
});
