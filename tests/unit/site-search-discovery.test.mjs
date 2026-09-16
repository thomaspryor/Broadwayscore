/**
 * Regression tests for BRO-1095 (opera outlet production-disambiguation).
 *
 * Background: Operawire's WP REST search returns reviews of ALL global
 * productions of an opera (e.g. Opera Australia's Eugene Onegin), not just
 * the Met's, and Parterre Box's date-window query returned dozens of
 * unrelated daily art-song posts with no show-specific filter. Both leaked
 * wrong-production URL stubs into review-texts before hitting any
 * show-mention validator.
 *
 * Fixed in commit a60ce982738 (production-disambiguation reject-list +
 * per-outlet hardening) via filterOperaUrls()/hasNonMetOperaUrlMarker()
 * (reject-list + ±1yr window) plus per-outlet title/slug/excerpt matching.
 * These tests pin that behavior against regression.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterOperaUrls,
  operaTitleWords,
  isOperawireReviewUrl,
  parterrePostMatchesShow,
  operawirePostMatchesShow,
} from '../../scripts/lib/site-search-discovery.js';
import { hasNonMetOperaUrlMarker } from '../../scripts/lib/content-filters.js';

test('hasNonMetOperaUrlMarker rejects known non-Met opera houses', () => {
  assert.equal(hasNonMetOperaUrlMarker('https://operawire.com/opera-australia-2026-review-eugene-onegin/').rejected, true);
  assert.equal(hasNonMetOperaUrlMarker('https://operawire.com/royal-opera-house-2026-review-la-traviata/').rejected, true);
});

test('hasNonMetOperaUrlMarker allows Met productions through', () => {
  assert.equal(hasNonMetOperaUrlMarker('https://operawire.com/metropolitan-opera-2025-26-review-eugene-onegin/').rejected, false);
  assert.equal(hasNonMetOperaUrlMarker('https://operawire.com/metropolitan-opera-2025-26-review-innocence/').rejected, false);
});

test('filterOperaUrls drops the Opera Australia mis-hit while keeping the Met review', () => {
  const openingDate = new Date().toISOString().slice(0, 10); // within the 21-day window
  const urls = [
    'https://operawire.com/opera-australia-2026-review-eugene-onegin/',
    'https://operawire.com/metropolitan-opera-2025-26-review-eugene-onegin/',
  ];
  const filtered = filterOperaUrls(urls, 'operawire', 'eugene-onegin-off-broadway-2026', openingDate);
  assert.deepEqual(filtered, ['https://operawire.com/metropolitan-opera-2025-26-review-eugene-onegin/']);
});

test('filterOperaUrls rejects a same-house URL whose embedded year is >1yr from opening (revival disambiguation)', () => {
  const filtered = filterOperaUrls(
    ['https://newyorkclassicalreview.com/2022/03/review-eugene-onegin/'],
    'new-york-classical-review',
    'eugene-onegin-off-broadway-2026',
    '2026-03-15'
  );
  assert.deepEqual(filtered, []);
});

test('filterOperaUrls fails open with no openingDate (no year/day filtering applied)', () => {
  const urls = ['https://operawire.com/metropolitan-opera-2025-26-review-innocence/'];
  assert.deepEqual(filterOperaUrls(urls, 'operawire', 'innocence-off-broadway-2026', null), urls);
});

test('filterOperaUrls drops everything once >21 days past opening (stale stopgap gate)', () => {
  const old = new Date(Date.now() - 30 * 86400000).toISOString();
  const urls = ['https://operawire.com/metropolitan-opera-2025-26-review-innocence/'];
  assert.deepEqual(filterOperaUrls(urls, 'operawire', 'innocence-off-broadway-2026', old), []);
});

test('operaTitleWords strips multilingual conjunctions and diacritics', () => {
  assert.deepEqual(operaTitleWords('Tristan und Isolde'), ['tristan', 'isolde']);
  assert.deepEqual(operaTitleWords('Último Sueño'), ['ultimo', 'sueno']);
});

test('isOperawireReviewUrl keeps review slugs, drops announcement posts', () => {
  assert.equal(isOperawireReviewUrl('https://operawire.com/metropolitan-opera-2025-26-review-innocence/'), true);
  assert.equal(isOperawireReviewUrl('https://operawire.com/asmik-grigorian-headlines-met-season/'), false);
  assert.equal(isOperawireReviewUrl(null), false);
  assert.equal(isOperawireReviewUrl(undefined), false);
});

test('parterrePostMatchesShow matches on poetic title via excerpt, not just slug', () => {
  const showWords = operaTitleWords('Innocence');
  const post = {
    title: { rendered: 'A specter, haunting' },
    link: 'https://parterre.com/2026/05/a-specter-haunting/',
    excerpt: { rendered: '<p>Kaija Saariaho’s Innocence at the Metropolitan Opera.</p>' },
  };
  assert.equal(parterrePostMatchesShow(post, showWords), true);
});

test('parterrePostMatchesShow rejects unrelated daily art-song posts', () => {
  const showWords = operaTitleWords('Innocence');
  const post = {
    title: { rendered: 'Song of the Day: Schubert' },
    link: 'https://parterre.com/2026/05/song-of-the-day-schubert/',
    excerpt: { rendered: '<p>A daily lieder pick from the archive.</p>' },
  };
  assert.equal(parterrePostMatchesShow(post, showWords), false);
});

test('operawirePostMatchesShow rejects a fuzzy WP full-text hit that never names the show (real gap found 2026-09-15)', () => {
  const titleWords = operaTitleWords('Innocence');
  const post = {
    title: { rendered: 'Birgit Nilsson Festival 2026 Review: Matilda Sterby in Recital' },
    link: 'https://operawire.com/birgit-nilsson-festival-2026-review-matilda-sterby-in-recital/',
  };
  assert.equal(operawirePostMatchesShow(post, titleWords), false);
});

test('operawirePostMatchesShow keeps a genuine Met review of the show', () => {
  const titleWords = operaTitleWords('Eugene Onegin');
  const post = {
    title: { rendered: 'Metropolitan Opera 2025-26 Review: Eugene Onegin' },
    link: 'https://operawire.com/metropolitan-opera-2025-26-review-eugene-onegin/',
  };
  assert.equal(operawirePostMatchesShow(post, titleWords), true);
});

test('operawirePostMatchesShow matches a single-word title (Math.min(2,1) threshold)', () => {
  const titleWords = operaTitleWords('Turandot');
  const post = {
    title: { rendered: 'Metropolitan Opera 2025-26 Review: Turandot' },
    link: 'https://operawire.com/metropolitan-opera-2025-26-review-turandot/',
  };
  assert.equal(operawirePostMatchesShow(post, titleWords), true);
});

test('operawirePostMatchesShow / parterrePostMatchesShow become no-ops when the title is all stopwords (pre-existing threshold behavior, not a regression)', () => {
  // "Un Ballo in Maschera" tokenizes to [] — every word is <3 chars or a
  // stopword ("un","in") except "ballo"/"maschera" which DO survive, so use
  // a title that's entirely stopwords to hit the true edge case.
  const titleWords = operaTitleWords('La La');
  assert.deepEqual(titleWords, []);
  // Math.min(2, 0) === 0, and hits >= 0 is always true — any post matches.
  const unrelatedPost = {
    title: { rendered: 'Completely Unrelated Recital Review' },
    link: 'https://operawire.com/completely-unrelated-recital-review/',
  };
  assert.equal(operawirePostMatchesShow(unrelatedPost, titleWords), true);
  assert.equal(parterrePostMatchesShow({ ...unrelatedPost, excerpt: { rendered: '' } }, titleWords), true);
});

test('filterOperaUrls rejects a same-opera Wolf Trap review (non-Met company found live 2026-09-15)', () => {
  const urls = ['https://operawire.com/wolf-trap-opera-2026-review-eugene-onegin/'];
  const filtered = filterOperaUrls(urls, 'operawire', 'eugene-onegin-off-broadway-2026', new Date().toISOString());
  assert.deepEqual(filtered, []);
});

test('no regression for other opera outlets sharing filterOperaUrls (bachtrack-style reject list)', () => {
  const urls = [
    'https://bachtrack.com/review-la-traviata-opera-australia-sydney-march-2026',
    'https://bachtrack.com/review-la-traviata-metropolitan-opera-new-york-march-2026',
  ];
  const filtered = filterOperaUrls(urls, 'bachtrack', 'la-traviata-off-broadway-2026', new Date().toISOString());
  assert.deepEqual(filtered, ['https://bachtrack.com/review-la-traviata-metropolitan-opera-new-york-march-2026']);
});
