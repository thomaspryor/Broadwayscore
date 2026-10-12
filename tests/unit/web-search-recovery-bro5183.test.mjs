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

const PAGE = 'p '.repeat(300);
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
  assert.equal(isUnverifiableWebSearchRow({ ...ROW, fullText: PAGE, originalScore: '4/5' }), false, 'score read from the page');
  assert.equal(isUnverifiableWebSearchRow({ ...ROW, fullText: PAGE, humanReviewScore: 70 }), false, 'human score');
  assert.equal(isUnverifiableWebSearchRow({ ...ROW, fullText: PAGE, sources: ['web-search', 'dtli'] }), false, 'aggregator-backed row: not this rule');
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
      if (!src.includes('verifyContent(')) continue;
      if (/excerpt\s*[:=]\s*[\w.]*\.(dtliExcerpt|bwwExcerpt|showScoreExcerpt)\s*\|\|/.test(src)) offenders.push(path.relative(ROOT, p));
    }
  };
  walk(path.join(ROOT, 'scripts'));
  assert.deepEqual(offenders, [], 'use excerpt-fields verifierExcerpt(data)');
});
