/**
 * BRO-3139: londontheatre.co.uk review stars live in embedded page data
 * (pageProps.initialState.content.pageContent.ourCriticsRating), not the article body.
 * Per CLAUDE.md rule 15 these require() the real extractor, the real exemption and the
 * real backfill script (run against a temp review-texts tree with fixture HTML).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const se = require('../../scripts/lib/score-extractors.js');
const { discardNoRatingOutletScore } = require('../../scripts/lib/no-rating-outlet-score.js');
const { applyRating, isCandidate } = require('../../scripts/backfill-london-theatre-stars.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'backfill-london-theatre-stars.js');

// Shape captured from https://www.londontheatre.co.uk/reviews/jane-eyre-review-southwark-playhouse
// (2026-10-10), trimmed. The decoys are real parts of the page: relatedArticles[] and
// product[0].review carry ratings of OTHER articles.
function page({ rating = '3', subType = 'Reviews', related = '5', jsonLd = true } = {}) {
  const data = {
    props: { pageProps: {
      relatedArticles: [{ ourCriticsRating: related, entryTitle: 'Another review' }],
      initialState: { content: { pageContent: {
        contentSubType: subType, ourCriticsRating: rating, slug: 'jane-eyre-review-southwark-playhouse',
        product: [{ review: { ourCriticsRating: related } }],
      } } },
    } },
  };
  const ld = jsonLd ? '<script type="application/ld+json">{"reviewRating":{"ratingValue":"3","worstRating":"1","bestRating":"5"}}</script>' : '';
  return `<html><head>${ld}</head><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`;
}

test('reads the article\'s own critic rating and normalises n/5 to n*20', () => {
  for (const [n, norm] of [['1', 20], ['2', 40], ['3', 60], ['4', 80], ['5', 100]]) {
    const r = se.extractLondonTheatreRating(page({ rating: n }));
    assert.equal(r.originalScore, `${n}/5 stars`);
    assert.equal(r.normalizedScore, norm);
    assert.equal(r.source, 'londontheatre-page-json');
  }
});

test('ignores the decoy ratings of related articles and the product block', () => {
  const r = se.extractLondonTheatreRating(page({ rating: '3', related: '5' }));
  assert.equal(r.normalizedScore, 60);
  // no rating on the article itself: the decoys must not be picked up instead
  const none = se.extractLondonTheatreRating(page({ rating: null, related: '5' }));
  assert.equal(none.__skipGeneric, true);
  assert.equal(none.originalScore, undefined);
});

test('no rating for non-review pages, odd values, unparseable data or no page data', () => {
  assert.equal(se.extractLondonTheatreRating(page({ subType: 'News' })).originalScore, undefined);
  for (const bad of ['0', '6', '3.5', 'three', '']) {
    assert.equal(se.extractLondonTheatreRating(page({ rating: bad })).originalScore, undefined, JSON.stringify(bad));
  }
  assert.equal(se.extractLondonTheatreRating('<html><script id="__NEXT_DATA__">{not json</script></html>').__skipGeneric, true);
  assert.equal(se.extractLondonTheatreRating('').__skipGeneric, true);
  assert.equal(se.extractLondonTheatreRating(null).__skipGeneric, true);
});

test('extractScore routes london-theatre to it and never falls through to generic extractors', () => {
  const ok = se.extractScore(page({ rating: '4' }), 'body text', 'london-theatre');
  assert.equal(ok.normalizedScore, 80);
  assert.equal(ok.outlet, 'london-theatre');
  // a Show-Score audience figure and body stars must not become a score on this outlet
  const html = '<html><script type="application/ld+json">{"aggregateRating":{"ratingValue":"89","bestRating":"100"}}</script></html>';
  assert.equal(se.extractScore(html, 'A fine show ★★★★', 'london-theatre'), null);
});

test('the page-data source is verified, and exempt from the no-critic-rating rule; everything else on the outlet is not', () => {
  assert.ok(se.OUTLET_VERIFIED_SOURCES.has('londontheatre-page-json'));
  assert.equal(se.publishesNoCriticRating('london-theatre'), true, 'generic JSON-LD / product-page ratings are still refused');
  assert.equal(se.publishesNoCriticRating('london-theatre', {}), true);
  assert.equal(se.publishesNoCriticRating('london-theatre', { originalScoreSource: 'show-score' }), true);
  assert.equal(se.publishesNoCriticRating('london-theatre', { originalScoreSource: 'londontheatre-page-json' }), false);
  assert.equal(se.publishesNoCriticRating('nytimes', {}), false);
});

test('discardNoRatingOutletScore keeps a page-data score and still discards an audience placeholder', () => {
  const keep = { outletId: 'london-theatre', originalScore: '3/5 stars', originalScoreNormalized: 60, originalScoreSource: 'londontheatre-page-json' };
  assert.equal(discardNoRatingOutletScore(keep), false);
  assert.equal(keep.originalScore, '3/5 stars');
  const drop = { outletId: 'london-theatre', originalScore: '89/100', originalScoreNormalized: 89, originalScoreSource: 'show-score' };
  assert.equal(discardNoRatingOutletScore(drop), true);
  assert.equal(drop.originalScore, null);
});

test('applyRating: records the rating, remembers the old value, clears the P0 breadcrumbs and replaces an aggregator scoreSource', () => {
  const rating = se.extractLondonTheatreRating(page({ rating: '3' }));
  const out = applyRating({ outletId: 'london-theatre', originalScore: '100/100', originalScoreCleared: true, originalScoreClearedReason: 'x', scoreSource: 'show-score-stars', scoreExtractionPending: true, assignedScore: 72 }, rating);
  assert.equal(out.originalScore, '3/5 stars');
  assert.equal(out.originalScoreNormalized, 60);
  assert.equal(out.originalScoreSource, 'londontheatre-page-json');
  assert.equal(out.previousOriginalScore, '100/100');
  assert.equal(out.originalScoreCleared, undefined);
  assert.equal(out.scoreExtractionPending, undefined);
  assert.equal(out.scoreSource, 'londontheatre-page-json');
  assert.equal(out.previousScoreSource, 'show-score-stars');
  assert.equal(out.assignedScore, 72, 'unrelated fields are untouched');
  // any other scoreSource is replaced too: the rebuild trusts a star only when scoreSource is a verified source
  const llm = applyRating({ outletId: 'london-theatre', scoreSource: 'llm-v6', source: 'show-score-playwright' }, rating);
  assert.equal(llm.scoreSource, 'londontheatre-page-json');
  assert.equal(llm.previousScoreSource, 'llm-v6');
  // idempotent: re-applying does not record the new source as the previous one
  assert.equal(applyRating(llm, rating).previousScoreSource, 'llm-v6');
});

test('isCandidate: only london-theatre review pages without a human score or an existing page-data score', () => {
  const base = { outletId: 'london-theatre', url: 'https://www.londontheatre.co.uk/reviews/x-review' };
  assert.equal(isCandidate(base, 'london-theatre--a.json'), true);
  assert.equal(isCandidate({ ...base, url: 'https://www.londontheatre.co.uk/theatre-news/news/x' }, 'london-theatre--a.json'), false);
  assert.equal(isCandidate({ ...base, outletId: 'londontheatre1' }, 'londontheatre1--a.json'), false);
  assert.equal(isCandidate({ ...base, humanReviewScore: 80 }, 'london-theatre--a.json'), false);
  assert.equal(isCandidate({ ...base, originalScoreSource: 'londontheatre-page-json' }, 'london-theatre--a.json'), false);
  assert.equal(isCandidate({ ...base, url: null }, 'london-theatre--a.json'), false);
  for (const flag of ['wrongProduction', 'wrongShow', 'duplicateOf', 'isNonReview']) {
    assert.equal(isCandidate({ ...base, [flag]: flag === 'duplicateOf' ? 'x.json' : true }, 'london-theatre--a.json'), false, flag);
  }
});

function tree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltr-'));
  for (const [rel, rec] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), JSON.stringify(rec));
  }
  return dir;
}
const read = (dir, rel) => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
function run(dir, fixtures, ...args) {
  return execFileSync('node', [SCRIPT, `--fixture-dir=${fixtures}`, ...args], { env: { ...process.env, REVIEW_TEXTS_DIR: dir }, encoding: 'utf8' });
}

test('backfill script: dry run writes nothing; --apply patches candidates and skips the rest; a second run is a no-op', () => {
  const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'ltf-'));
  fs.writeFileSync(path.join(fixtures, 'a-review-venue.html'), page({ rating: '3' }));
  fs.writeFileSync(path.join(fixtures, 'b-review-venue.html'), page({ rating: '5' }));
  fs.writeFileSync(path.join(fixtures, 'c-review-venue.html'), page({ rating: null }));
  const u = (s) => `https://www.londontheatre.co.uk/reviews/${s}`;
  const dir = tree({
    'show-a-2026/london-theatre--julia-rank.json': { outletId: 'london-theatre', url: u('a-review-venue'), assignedScore: 72, scoreSource: 'show-score-stars', originalScore: '100/100', originalScoreNormalized: 100, originalScoreCleared: true, showId: 'show-a-2026' },
    'show-a-2026/london-theatre--matt-wolf.json': { outletId: 'london-theatre', url: u('b-review-venue'), assignedScore: 90, scoreSource: 'llm-v6', showId: 'show-a-2026' },
    'show-a-2026/london-theatre--no-stars.json': { outletId: 'london-theatre', url: u('c-review-venue'), assignedScore: 70, showId: 'show-a-2026' },
    'show-a-2026/london-theatre--human.json': { outletId: 'london-theatre', url: u('a-review-venue'), humanReviewScore: 55, showId: 'show-a-2026' },
    'show-a-2026/london-theatre--news.json': { outletId: 'london-theatre', url: 'https://www.londontheatre.co.uk/theatre-news/news/x', showId: 'show-a-2026' },
    'show-a-2026/nytimes--jesse-green.json': { outletId: 'nytimes', url: u('a-review-venue'), showId: 'show-a-2026' },
  });
  const dry = run(dir, fixtures);
  assert.match(dry, /DRY RUN/);
  assert.match(dry, /"candidates":3,"fetched":3,"rated":2,"noRating":1/);
  assert.equal(read(dir, 'show-a-2026/london-theatre--julia-rank.json').originalScore, '100/100', 'dry run writes nothing');

  const applied = run(dir, fixtures, '--apply');
  assert.match(applied, /"written":2/);
  const a = read(dir, 'show-a-2026/london-theatre--julia-rank.json');
  assert.equal(a.originalScore, '3/5 stars');
  assert.equal(a.originalScoreNormalized, 60);
  assert.equal(a.originalScoreSource, 'londontheatre-page-json');
  assert.equal(a.scoreSource, 'londontheatre-page-json');
  assert.equal(a.originalScoreCleared, undefined);
  assert.equal(read(dir, 'show-a-2026/london-theatre--matt-wolf.json').originalScoreNormalized, 100);
  assert.equal(read(dir, 'show-a-2026/london-theatre--matt-wolf.json').scoreSource, 'londontheatre-page-json');
  assert.equal(read(dir, 'show-a-2026/london-theatre--matt-wolf.json').previousScoreSource, 'llm-v6');
  assert.equal(read(dir, 'show-a-2026/london-theatre--no-stars.json').originalScore, undefined);
  assert.equal(read(dir, 'show-a-2026/london-theatre--human.json').originalScore, undefined);

  const again = run(dir, fixtures, '--apply');
  assert.match(again, /"candidates":1,/, 'already-patched files are skipped; only the rating-less page remains a candidate');
  assert.match(again, /"written":0/);
});

test('backfill script: --limit caps the files fetched in one run', () => {
  const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'ltf-'));
  const files = {};
  for (const n of ['p1', 'p2', 'p3']) {
    fs.writeFileSync(path.join(fixtures, `${n}-review.html`), page({ rating: '4' }));
    files[`s-2026/london-theatre--${n}.json`] = { outletId: 'london-theatre', url: `https://www.londontheatre.co.uk/reviews/${n}-review`, showId: 's-2026' };
  }
  const dir = tree(files);
  const out = run(dir, fixtures, '--apply', '--limit=2');
  assert.match(out, /"candidates":3,"fetched":2,"rated":2/);
  assert.match(run(dir, fixtures, '--apply'), /"candidates":1,"fetched":1/);
});
