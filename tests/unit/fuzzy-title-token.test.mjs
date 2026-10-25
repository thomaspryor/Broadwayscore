// Review follow-ups for the BWW one-typo roundup fallback. Requires the real module.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { tokenFuzzyMatch, otherActiveShowMatchesExactly } = require('../../scripts/lib/fuzzy-title-token.js');

test('venue words in the slug never count as the typo partner', () => {
  // "Theater" vs slug "THEATRE" is one adjacent swap; it must not match.
  assert.equal(tokenFuzzyMatch(['harbor', 'theater'], ['harbor', 'theatre', 'opens']), null);
  assert.deepEqual(tokenFuzzyMatch(['other', 'desert', 'cities'], ['other', 'desert', 'cites', 'opens']), { token: 'cities', slugWord: 'cites' });
});

test('an upcoming near-twin owns its slug; an explicit empty pool does not block', () => {
  const twin = { id: 'b', title: 'Twin Show', status: 'upcoming' };
  assert.equal(otherActiveShowMatchesExactly({ id: 'a', title: 'Twin Shoe' }, (o) => o.id === 'b', [twin]), true);
  assert.equal(otherActiveShowMatchesExactly({ id: 'a', title: 'Twin Shoe' }, () => true, []), false);
});

test('override page title with a one-letter typo matches; a different show does not', async () => {
  const { pageTitleTypoMatch } = require('../../scripts/lib/fuzzy-title-token.js');
  const page = (t) => `<html><head><title>${t} | BroadwayWorld</title></head><body><h1>${t}</h1></body></html>`;
  assert.deepEqual(pageTitleTypoMatch('Celebrity Autobiography', page('Review Roundup: CELEBRITY AUTOPBIOGRAPHY On Broadway')), { token: 'autobiography', slugWord: 'autopbiography' });
  assert.equal(pageTitleTypoMatch('Celebrity Autobiography', page('Review Roundup: CELEBRITY AUTOBIOGRAPHY On Broadway')), null); // exact: caller's path
  assert.equal(pageTitleTypoMatch('Celebrity Autobiography', page('Review Roundup: CELEBRITY CHEF On Broadway')), null);
  assert.equal(pageTitleTypoMatch('Romeo + Juliet', page('Review Roundup: DRUNK ROMEO AND JULIET')), null);
});

test('gather-reviews waives only title-word checks, and only for override URLs', () => {
  const src = fs.readFileSync(new URL('../../scripts/gather-reviews.js', import.meta.url), 'utf8');
  assert.match(src, /if \(bwwResult\.fromOverride && !validation\.valid/);
  assert.equal((src.match(/fromOverride: true/g) || []).length, 3);
});

test('checkArchiveCategory rescues a one-typo BWW roundup title only for an override show', () => {
  const { checkArchiveCategory } = require('../../scripts/lib/archive-cache-guard.js');
  const html = '<html><head><title>Review Roundup: CELEBRITY AUTOPBIOGRAPHY On Broadway | BroadwayWorld</title></head><body></body></html>';
  const listed = { id: 'celebrity-autobiography-2026', title: 'Celebrity Autobiography', category: 'broadway', openingDate: '2026-05-18' };
  const r = checkArchiveCategory(html, listed, []);
  assert.equal(r.rescued, true, JSON.stringify(r));
  const unlisted = { ...listed, id: '__not-in-override-map__' };
  assert.equal(checkArchiveCategory(html, unlisted, []).ok, false);
});
