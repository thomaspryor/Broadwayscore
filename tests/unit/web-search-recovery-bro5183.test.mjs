// BRO-5183: recovering real text for the legacy web-search rows BRO-5107 excludes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const { isUnverifiableWebSearchRow } = require('../../scripts/lib/review-guards.js');
const { verifierExcerpt } = require('../../scripts/lib/excerpt-fields.js');
const { applyReviewFieldEdit } = require('../../scripts/lib/review-field-edit.js');

const PAGE = 'p '.repeat(600);
const ROW = {
  showId: 'a-dolls-house-part-2-2017', outletId: 'observer', criticName: 'Rex Reed',
  source: 'web-search', sources: ['web-search'],
  url: 'https://observer.com/2017/04/a-dolls-house-part-2-broadway-review/',
  dtliExcerpt: 'An invented one-sentence summary.', assignedScore: 80,
  llmScore: { score: 80 }, llmMetadata: { textSource: { type: 'excerpt' } },
};

test('recovered text does not bring the row back until it is rescored on that text', () => {
  assert.equal(isUnverifiableWebSearchRow({ ...ROW, fullText: PAGE }), true, 'score still read from the excerpt');
  assert.equal(isUnverifiableWebSearchRow({ ...ROW, fullText: PAGE, needsRescore: true, llmMetadata: undefined }), true, 'rescore pending, no score provenance');
  assert.equal(isUnverifiableWebSearchRow({ ...ROW, fullText: PAGE, needsRescore: true, llmMetadata: { textSource: { type: 'fullText' } } }), false, 'already scored on page text; a leftover flag does not hide it');
  assert.equal(isUnverifiableWebSearchRow({ ...ROW, fullText: PAGE, llmMetadata: { textSource: { type: 'fullText' } } }), false, 'rescored on the page');
  assert.equal(isUnverifiableWebSearchRow({ ...ROW, fullText: PAGE, llmMetadata: undefined }), false, 'no excerpt provenance recorded');
  assert.equal(isUnverifiableWebSearchRow({ ...ROW, fullText: PAGE, originalScore: '4/5', originalScoreSource: 'html-stars' }), false, 'score read from the page');
  assert.equal(isUnverifiableWebSearchRow({ ...ROW, fullText: PAGE, originalScore: '2/5 stars' }), true, 'a bare originalScore may be the search step\'s own guess');
  assert.equal(isUnverifiableWebSearchRow({ ...ROW, fullText: PAGE, humanReviewScore: 70 }), false, 'human score');
  assert.equal(isUnverifiableWebSearchRow({ ...ROW, fullText: PAGE, sources: ['web-search', 'dtli'] }), false, 'aggregator-backed row: not this rule');
});

test('a legacy url row counts only with a verified or full page, not a 300-char shell', () => {
  const scored = { ...ROW, llmMetadata: { textSource: { type: 'fullText' } } };
  const shell = 'x'.repeat(365);
  assert.equal(isUnverifiableWebSearchRow({ ...scored, fullText: shell, contentTier: 'truncated' }), true, '365-char TheaterMania shell, never verified');
  assert.equal(isUnverifiableWebSearchRow({ ...scored, fullText: 'y'.repeat(1200), contentTier: 'invalid' }), true, 'classifier tiers it invalid');
  assert.equal(isUnverifiableWebSearchRow({ ...scored, fullText: 'y'.repeat(1200), contentTier: 'complete' }), false, 'full page, never verified');
  assert.equal(isUnverifiableWebSearchRow({ ...scored, fullText: shell, contentVerification: { isValid: true, verifiedBy: 'llm:claude-haiku' } }), false, 'short but verified');
  assert.equal(isUnverifiableWebSearchRow({ ...scored, fullText: shell, contentVerification: { isValid: false, verifiedBy: 'heuristic' } }), true, 'short and not LLM-verified');
  assert.equal(isUnverifiableWebSearchRow({ ...scored, fullText: 'y'.repeat(1200), contentTier: 'complete', contentVerification: { isValid: false, wrongArticle: true, verifiedBy: 'llm:claude-haiku' } }), false, 'a full page the verifier doubted is left to the wrong-article guards');
});

test('the verifier never gets a legacy web-search excerpt as its reference', () => {
  assert.equal(verifierExcerpt(ROW), '');
  assert.equal(verifierExcerpt({ ...ROW, sources: ['web-search', 'dtli'] }), ROW.dtliExcerpt);
  assert.equal(verifierExcerpt({ sources: ['bww-roundup'], bwwExcerpt: 'b' }), 'b');
  assert.equal(verifierExcerpt(null), '');
});

test('an excluded web-search row\'s made-up url may be repaired to the outlet\'s real review', () => {
  const real = 'https://observer.com/2017/04/a-dolls-house-part-2-review-laurie-metcalf/';
  const ok = applyReviewFieldEdit({ ...ROW }, { field: 'url', oldValue: ROW.url, newValue: real }, 'bro-5183');
  assert.equal(ok.ok, true, ok.reason);
  const verified = { ...ROW, fullText: PAGE, llmMetadata: { textSource: { type: 'fullText' } } };
  const refused = applyReviewFieldEdit(verified, { field: 'url', oldValue: ROW.url, newValue: real }, 'bro-5183');
  assert.equal(refused.ok, false, 'a row with verified page text keeps its url');
  const other = applyReviewFieldEdit({ ...ROW }, { field: 'url', oldValue: ROW.url, newValue: 'https://variety.com/2017/legit/reviews/x-1202/' }, 'bro-5183');
  assert.equal(other.ok, false, 'never another outlet\'s url');
});

test('no verifyContent caller builds its excerpt from the raw excerpt fields', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!['node_modules', 'tests'].includes(e.name)) walk(p); continue; }
      if (!/\.(c?js|mjs|ts)$/.test(e.name)) continue;
      const src = fs.readFileSync(p, 'utf8');
      if (!/\b(verifyContent|heuristicVerify)\(/.test(src)) continue;
      // Any excerpt built from a raw aggregator excerpt field, by dot,
      // bracket or destructured access, instead of verifierExcerpt(data).
      const raw = /\bexcerpt\s*[:=][^,;\n]*\b(dtli|bww|showScore|nycTheatre|lboRoundup)Excerpt\b/;
      if (src.split('\n').some((l) => raw.test(l) && !l.includes('verifierExcerpt'))) offenders.push(path.relative(ROOT, p));
    }
  };
  walk(path.join(ROOT, 'scripts'));
  assert.deepEqual(offenders, [], 'use excerpt-fields verifierExcerpt(data)');
});

// BRO-5222: the provenance clause above is for rebuild. The scorer is how such a
// row gets a page-based score, so it must not hold the scorer out (deadlock:
// the recovered Farnsworth Variety row could never be rescored, and
// audit-stuck-rescore-flags --fix then cleared flags like its own).
const { isIncludableForRebuild } = require('../../scripts/lib/review-guards.js');
const { isScoreable } = require('../../scripts/lib/is-scoreable.js');
const { isStuckRescoreFlag } = require('../../scripts/lib/stuck-rescore-flag.js');
const { selectScorableText } = require('../../scripts/lib/scorable-text.js');
const PROSE = Array.from({ length: 14 }, (_, i) =>
  `In the revival of A Doll's House, Part 2, the actors find new shades in scene ${i + 1}; the direction keeps the argument taut and the design is spare, and the evening earns its laughs without cheating the drama.`).join(' ');

test('the scorer may rescore a legacy row on its recovered page text (BRO-5222)', () => {
  assert.equal(selectScorableText({ ...ROW, fullText: PROSE }, {}).isExcerpt, false, 'fixture page text is scoreable');
  for (const row of [
    { ...ROW, fullText: PROSE },
    { ...ROW, fullText: PROSE, needsRescore: true, llmScore: undefined, assignedScore: undefined, llmMetadata: undefined },
  ]) {
    assert.equal(isUnverifiableWebSearchRow(row), true, 'rebuild still holds it out');
    assert.equal(isIncludableForRebuild(row), false);
    assert.equal(isUnverifiableWebSearchRow(row, { forScoring: true }), false, 'scorer may take it');
    assert.equal(isScoreable(row), true);
  }
  const flagged = { ...ROW, fullText: PROSE, needsRescore: true };
  assert.equal(isStuckRescoreFlag(flagged), false, 'the stuck-flag sweep leaves a recovered, flagged row queued');
});

test('the scorer stays out when it would fall back to the invented excerpt (BRO-5222)', () => {
  const garbage = { ...ROW, fullText: PAGE, dtliExcerpt: 'An invented summary of the revival that reads like a verdict but came from the search step itself, not the page. '.repeat(3) };
  assert.equal(selectScorableText(garbage, {}).isExcerpt, true, 'fixture page text is rejected, excerpt fallback');
  assert.equal(isUnverifiableWebSearchRow(garbage, { forScoring: true }), true);
  assert.equal(isScoreable(garbage), false);
  assert.equal(isUnverifiableWebSearchRow({ ...ROW, fullText: 'short stub text', url: ROW.url }, { forScoring: true }), true, 'text-proof clauses still apply');
});

// The guard must ask the scorer's own text picker (input-builder.ts ->
// getBestTextForScoring), which can rank a verdict-bearing excerpt above a
// truncated page and appends excerpts to a short page (ship-check, BRO-5222).
const { getBestTextForScoring } = require('../../scripts/lib/text-quality.js');
const VERDICT_EXCERPT = 'A triumphant, must-see revival; highly recommended and the best production of the season by far, a stunning evening.';

test('the scorer stays out when its picker would choose the invented excerpt over the page (BRO-5222)', () => {
  const cut = PROSE.slice(0, 1800) + ' and then the second act turns on';
  const row = { ...ROW, fullText: cut, dtliExcerpt: VERDICT_EXCERPT };
  assert.equal(getBestTextForScoring(row).type, 'excerpt', 'fixture: the picker prefers the excerpt');
  assert.equal(isUnverifiableWebSearchRow(row, { forScoring: true }), true);
  assert.equal(isScoreable(row), false);
});

test('the scorer stays out when the picker would append the invented excerpt to a short page (BRO-5222)', () => {
  const row = { ...ROW, fullText: PROSE.slice(0, 1200) + '.', dtliExcerpt: VERDICT_EXCERPT };
  const best = getBestTextForScoring(row);
  if (best.type === 'fullText') assert.ok(best.text.includes(require('../../scripts/lib/text-quality.js').EXCERPT_APPENDIX_MARKER), 'fixture: excerpt appended');
  assert.equal(isUnverifiableWebSearchRow(row, { forScoring: true }), true);
  assert.equal(isScoreable(row), false);
});

test('whenever the scorer takes a legacy row, it reads only the page (BRO-5222)', () => {
  for (const row of [{ ...ROW, fullText: PROSE }, { ...ROW, fullText: PROSE, dtliExcerpt: VERDICT_EXCERPT }]) {
    if (!isScoreable(row)) continue;
    const best = getBestTextForScoring(row);
    assert.equal(best.type, 'fullText');
    assert.ok(!best.text.includes(require('../../scripts/lib/text-quality.js').EXCERPT_APPENDIX_MARKER));
  }
});
