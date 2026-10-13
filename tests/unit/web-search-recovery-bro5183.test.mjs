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
  assert.equal(isUnverifiableWebSearchRow({ ...scored, fullText: shell, contentVerification: { isValid: false, wrongArticle: true } }), false, 'a verifier rejection is left to the wrong-article guards');
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
