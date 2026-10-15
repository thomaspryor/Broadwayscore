// BRO-5398 — one review must not render twice because one copy carries a
// placeholder byline. Affluenza, Time Out London (2026-10-15 report): the
// person-bylined file (Andrzej Lukowski, 45) and a raw SERP capture bylined
// "Time Out" (the outlet's own name, 42) are the same article. The rebuild's
// Unknown-critic dedup keys on the raw criticName, so "Time Out" survived as
// its own critic and was only blanked for display afterwards ("Time Out London
// Staff"). Same on Hadestown/Rent (The Reviews Hub - London) and The Standard
// of Living (Time Out). CLAUDE.md §15: the real exported function; the rebuild
// cannot be required (it runs on load), so its wiring is pinned by source shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { decidePlaceholderBylineTwin, decideSameArticleNamedTwin } = require('../../scripts/lib/review-text-identity.js');
const { isPlaceholderCritic } = require('../../scripts/lib/critic-display-name.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Deterministic synthetic prose (no real review text in the repo).
function prose(seed, words) {
  const stems = ['harbour', 'lantern', 'velvet', 'orchard', 'thunder', 'marble', 'whisper', 'copper', 'meadow', 'cinder', 'anchor', 'saffron', 'timber', 'ripple', 'granite', 'plume'];
  let x = seed;
  const out = [];
  for (let i = 0; i < words; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out.push(`${stems[x % stems.length]}${(x >> 8) % 997}`);
  }
  return out.join(' ');
}

const BODY = prose(7, 300);
const OTHER = prose(99, 300);
// The same article as a raw page capture: headline, share widgets and a
// details block around the body, so a prefix fingerprint cannot match.
const WRAPPED = `Headline ${prose(3, 20)} Share Copy Link Facebook Twitter Written by A Critic Theatre Editor ${BODY} Details Address ${prose(5, 30)} Show more Buy`;

test('a placeholder-bylined page capture of a named critic\'s review is a twin', () => {
  const d = decidePlaceholderBylineTwin(WRAPPED, [{ fullText: BODY, hasPersonByline: true }]);
  assert.equal(d.drop, true);
  assert.equal(d.index, 0);
});

test('a bylineless piece beside a named critic\'s different review is kept (multi-critic outlets)', () => {
  assert.equal(decidePlaceholderBylineTwin(OTHER, [{ fullText: BODY, hasPersonByline: true }]).drop, false);
});

test('the kept entry must itself be person-bylined, and no kept entry means nothing to drop against', () => {
  assert.equal(decidePlaceholderBylineTwin(WRAPPED, [{ fullText: BODY, hasPersonByline: false }]).drop, false);
  assert.equal(decidePlaceholderBylineTwin(WRAPPED, []).drop, false);
  assert.equal(decidePlaceholderBylineTwin(WRAPPED, undefined).drop, false);
  assert.equal(decidePlaceholderBylineTwin('', [{ fullText: BODY, hasPersonByline: true }]).drop, false);
});

test('picks the matching entry among several kept critics', () => {
  const d = decidePlaceholderBylineTwin(WRAPPED, [
    { fullText: OTHER, hasPersonByline: true },
    { fullText: BODY, hasPersonByline: true },
  ]);
  assert.deepEqual([d.drop, d.index], [true, 1]);
});

test('the bylines in the reported cases are placeholders, real critics are not', () => {
  assert.equal(isPlaceholderCritic('Time Out', 'Time Out London'), true);
  assert.equal(isPlaceholderCritic('The Reviews Hub - London', 'The Reviews Hub'), true);
  assert.equal(isPlaceholderCritic('Andrzej Lukowski', 'Time Out London'), false);
});

test('rebuild-all-reviews.js sorts placeholder bylines after named critics and runs the twin dedup before the unknown-outlet dedup', () => {
  const src = readFileSync(path.join(repoRoot, 'scripts/rebuild-all-reviews.js'), 'utf8');
  assert.match(src, /isPlaceholderBylineFor\(d\.criticName[^\n]*\) meta\.isUnknown = 1;/, 'sortMeta marks placeholder bylines like Unknown files');
  assert.match(src, /isPlaceholderBylineFor\(data\.criticName[^\n]*\) \{/, 'the twin dedup uses the same placeholder test as the sort');
  const twin = src.indexOf('decidePlaceholderBylineTwin(data.fullText');
  assert.ok(twin > 0, 'twin dedup is wired in');
  assert.ok(twin > src.indexOf('skippedUnknownCriticDedup", showId'), 'after the Unknown-critic dedup');
  assert.ok(twin < src.indexOf('// Unknown-outlet dedup:'), 'before the unknown-outlet dedup');
  assert.match(src, /logExclusion\("skippedPlaceholderBylineTwin"/, 'exclusion is logged');
});

// ── same article filed under a second NAMED critic (TheaterMania Aladdin, Clyde's, ...) ──

// Two reviews of one show share a synopsis and a few lines, never 90% of their prose.
const SYNOPSIS = prose(41, 70);
const REVIEW_A = `${SYNOPSIS} ${prose(12, 250)}`;
const REVIEW_B = `${SYNOPSIS} ${prose(77, 250)}`;
// The same article re-captured with different page chrome and a short trailer.
const RECAPTURE = `Share ${prose(8, 10)} ${REVIEW_A} Related stories ${prose(9, 20)}`;

test('the same article under a second named critic is a twin', () => {
  const d = decideSameArticleNamedTwin(RECAPTURE, [{ fullText: REVIEW_B }, { fullText: REVIEW_A }]);
  assert.deepEqual([d.drop, d.index], [true, 1]);
});

test('two critics\' different reviews of the same show are both kept, even with a shared synopsis', () => {
  assert.equal(decideSameArticleNamedTwin(REVIEW_B, [{ fullText: REVIEW_A }]).drop, false);
});

test('nothing kept, empty text or missing entries never drop', () => {
  assert.equal(decideSameArticleNamedTwin(REVIEW_A, []).drop, false);
  assert.equal(decideSameArticleNamedTwin('', [{ fullText: REVIEW_A }]).drop, false);
  assert.equal(decideSameArticleNamedTwin(REVIEW_A, undefined).drop, false);
  assert.equal(decideSameArticleNamedTwin(REVIEW_A, [null, { fullText: '' }]).drop, false);
});

test('rebuild wires the named-twin dedup after the placeholder twin and before the unknown-outlet dedup', () => {
  const src = readFileSync(path.join(repoRoot, 'scripts/rebuild-all-reviews.js'), 'utf8');
  const named = src.indexOf('decideSameArticleNamedTwin(data.fullText');
  assert.ok(named > src.indexOf('decidePlaceholderBylineTwin(data.fullText'), 'after the placeholder twin');
  assert.ok(named < src.indexOf('// Unknown-outlet dedup:'), 'before the unknown-outlet dedup');
  assert.match(src, /logExclusion\("skippedSameArticleNamedTwin"/);
});
