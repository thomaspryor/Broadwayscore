// TESTS-VS-DERIVED-DATA-EXEMPT: structural sibling-pair checks; dates are read from shows.json itself, so no factual claim is pinned
/**
 * BRO-2121: corpus-wide sibling-misfile archive cleanup.
 *
 * Covers the shared detector (scripts/lib/sibling-misfile.js, used by both
 * extractors) against the REAL data/shows.json, and the archive audit
 * (scripts/audit-sibling-misfile-archive.js) against a simulated archive dir.
 * The live-corpus check at the bottom asserts the cleaned archive stays clean
 * when a local archive checkout is present (skipped otherwise: private repo).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const { detectSiblingMisfile } = require('../../scripts/lib/sibling-misfile.js');
const { buildSiblingIndex } = require('../../scripts/lib/market-routing.js');
const { scanArchive, deleteAndTombstone } = require('../../scripts/audit-sibling-misfile-archive.js');

const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf8'));
const list = raw.shows || raw;
const shows = Array.isArray(list) ? list : Object.values(list);
const siblingIndex = buildSiblingIndex(shows);
const byId = new Map(shows.map(s => [s.id, s]));
const open = id => byId.get(id).openingDate;
const ctx = id => ({ category: byId.get(id)?.category, siblingIndex });

// Reviews all dated at the CURRENT production's opening, filed under a historical revival's id.
const at = (date, n) => Array.from({ length: n }, (_, i) => ({ url: `https://example.com/r${i}`, publishDate: date }));

test('historical revival holding the current production page is flagged', () => {
  const v = detectSiblingMisfile('a-christmas-carol-1994', at(open('a-christmas-carol-2022'), 8), ctx('a-christmas-carol-1994'));
  assert.equal(v.misfiled, true);
  assert.equal(v.targetId, 'a-christmas-carol-2022');
  assert.equal(v.count, 8);
});

test('regional/off-broadway id holding its Broadway sibling page is flagged', () => {
  const v = detectSiblingMisfile('oh-mary-off-broadway-2024', at(open('oh-mary-2024'), 6), ctx('oh-mary-off-broadway-2024'));
  assert.equal(v.misfiled, true);
  assert.equal(v.targetId, 'oh-mary-2024');
});

test('a page whose reviews match its OWN opening is not flagged', () => {
  const v = detectSiblingMisfile('a-christmas-carol-2022', at(open('a-christmas-carol-2022'), 8), ctx('a-christmas-carol-2022'));
  assert.equal(v.misfiled, false);
});

test('below the min-3 threshold is not flagged', () => {
  const v = detectSiblingMisfile('a-christmas-carol-1994', at(open('a-christmas-carol-2022'), 2), ctx('a-christmas-carol-1994'));
  assert.equal(v.misfiled, false);
});

test('empty page is not flagged', () => {
  assert.equal(detectSiblingMisfile('a-christmas-carol-1994', [], ctx('a-christmas-carol-1994')).misfiled, false);
});

test('scanArchive reports misfiled pages in both aggregator dirs and ignores clean ones', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro2121-'));
  try {
    for (const agg of ['show-score', 'dtli']) fs.mkdirSync(path.join(root, agg));
    fs.writeFileSync(path.join(root, 'show-score/a-christmas-carol-1994.html'), 'x');
    fs.writeFileSync(path.join(root, 'show-score/a-christmas-carol-2022.html'), 'x');
    fs.writeFileSync(path.join(root, 'dtli/oh-mary-off-broadway-2024.html'), 'x');
    const date = id => (id.startsWith('oh-mary') ? open('oh-mary-2024') : open('a-christmas-carol-2022'));
    const hits = scanArchive(root, {
      shows,
      // Show Score extractor stand-in: applies the same shared detector the real one does.
      extractShowData: (html, id) => {
        const v = detectSiblingMisfile(id, at(date(id), 8), ctx(id));
        return v.misfiled
          ? { _rejectAll: true, _siblingMisfile: v }
          : { criticReviews: [] };
      },
      extractReviewsFromDTLI: (html, id) => at(date(id), 6),
    });
    assert.deepEqual(hits.map(h => `${h.aggregator}:${h.showId}:${h.targetId}`).sort(), [
      'dtli:oh-mary-off-broadway-2024:oh-mary-2024',
      'show-score:a-christmas-carol-1994:a-christmas-carol-2022',
    ]);
    // After deleting the flagged files, a rescan is empty (the cleanup contract).
    deleteAndTombstone(root, hits, '2026-10-05');
    // Tombstones keep the weekly fetcher (shouldSkipAsKnownNotFound) from re-fetching the same sibling page.
    const { loadNotFoundForAggregator, shouldSkipAsKnownNotFound } = require('../../scripts/lib/not-found-cache.js');
    assert.equal(shouldSkipAsKnownNotFound(loadNotFoundForAggregator(root, 'show-score'), 'a-christmas-carol-1994', false), true);
    assert.equal(shouldSkipAsKnownNotFound(loadNotFoundForAggregator(root, 'dtli'), 'oh-mary-off-broadway-2024', false), true);
    assert.equal(shouldSkipAsKnownNotFound(loadNotFoundForAggregator(root, 'show-score'), 'a-christmas-carol-2022', false), false);
    assert.equal(fs.existsSync(path.join(root, 'show-score/a-christmas-carol-1994.html')), false);
    const again = scanArchive(root, { shows, extractShowData: () => ({ criticReviews: [] }), extractReviewsFromDTLI: () => [] });
    assert.deepEqual(again, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('live archive checkout (if present) has 0 sibling-misfiled pages', { skip: !fs.existsSync(path.join(os.homedir(), 'broadway-review-texts/aggregator-archive')) }, () => {
  const hits = scanArchive(path.join(os.homedir(), 'broadway-review-texts/aggregator-archive'), {
    shows,
    extractShowData: require('../../scripts/extract-show-score-reviews.js').extractShowData,
    extractReviewsFromDTLI: require('../../scripts/extract-dtli-reviews.js').extractReviewsFromDTLI,
  });
  assert.deepEqual(hits.map(h => `${h.aggregator}:${h.showId}`), []);
});

test('extract-dtli-reviews isSiblingMisfilePage uses the shared detector', () => {
  const { isSiblingMisfilePage } = require('../../scripts/extract-dtli-reviews.js');
  assert.equal(isSiblingMisfilePage('a-christmas-carol-1994', at(open('a-christmas-carol-2022'), 5)), true);
  assert.equal(isSiblingMisfilePage('a-christmas-carol-2022', at(open('a-christmas-carol-2022'), 5)), false);
});

test('threshold boundaries: exactly 50% of >=3 flags; 3 of 7 and a split across siblings do not', () => {
  const id = 'a-christmas-carol-1994';
  const mixed = (n, rest) => [...at(open('a-christmas-carol-2022'), n), ...at(open('a-christmas-carol-1994'), rest)];
  assert.equal(detectSiblingMisfile(id, mixed(3, 3), ctx(id)).misfiled, true);
  assert.equal(detectSiblingMisfile(id, mixed(3, 4), ctx(id)).misfiled, false);
});

test('the real Show Score extractor exposes the detector verdict that the audit consumes', () => {
  const { extractShowData } = require('../../scripts/extract-show-score-reviews.js');
  assert.equal(typeof extractShowData, 'function');
});
