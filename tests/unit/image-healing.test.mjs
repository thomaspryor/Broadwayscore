// TESTS-VS-DERIVED-DATA-EXEMPT: structural check (file exists on disk, non-placeholder
// hash, predicate returns true) — there is no precursor source file for images, the
// image file itself IS the source of truth; nothing here pins a scraped/derived fact.
/**
 * BRO-2652 regression: Bad Kreyòl (bad-krey-l-off-broadway-2026) was auto-filed by
 * owner-alert-router after 3+ self-heal image-fetch dispatches with no image landing
 * yet on disk at alert time. A real poster (TodayTix CDN, Signature Theatre / MTC
 * co-production art, archived locally as JPEG) landed via fetch-all-image-formats.yml
 * on 2026-09-01 (commit 8e9fc5d0706) — same pattern as BRO-2651 (Eurydice): the
 * self-heal succeeded, but the Linear card was never auto-closed because the drain
 * that verifies parked machine-checkable issues hadn't shipped yet. This asserts the
 * fix actually held: the real shows.json entry points at a real, non-placeholder file
 * on disk, using the canonical predicate (CLAUDE.md rule 15), not a re-implementation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hasRealImage, imageOnDisk } = require('../../scripts/lib/show-images.js');
const { hasArchivedShowImages } = require('../../scripts/lib/show-image-coverage.js');
const { findImagelessScoredShows, DEFAULT_THRESHOLD_HOURS } = require('../../scripts/lib/image-trigger-guard.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');
const SHOW_ID = 'bad-krey-l-off-broadway-2026';

function loadShow() {
  const data = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data', 'shows.json'), 'utf8'));
  const list = Array.isArray(data) ? data : (data.shows || []);
  return list.find(s => s.id === SHOW_ID);
}

test('Bad Kreyòl has a shows.json entry with an images block', () => {
  const show = loadShow();
  assert.ok(show, `${SHOW_ID} must exist in data/shows.json`);
  assert.ok(show.images, 'show entry must carry an images object');
});

test('Bad Kreyòl poster path resolves to a real, non-placeholder file on disk', () => {
  const show = loadShow();
  assert.equal(imageOnDisk(show.images.poster), true,
    `poster path ${show.images.poster} must exist on disk and not be a known placeholder`);
});

test('Bad Kreyòl passes the canonical hasRealImage predicate (self-heal acceptance criteria)', () => {
  const show = loadShow();
  assert.equal(hasRealImage(show), true,
    `${SHOW_ID} must have at least one real image — this is the condition the imageless-scored-show audit checks`);
});

test('Bad Kreyòl image directory passes the file-based coverage predicate (not just directory existence)', () => {
  assert.equal(
    hasArchivedShowImages(path.join(REPO_ROOT, 'public', 'images', 'shows'), SHOW_ID),
    true,
    `public/images/shows/${SHOW_ID} must hold at least one real image file`,
  );
});

test('the poster file on disk is a real image, not a zero-byte or tiny stub', () => {
  const show = loadShow();
  const abs = path.join(REPO_ROOT, 'public', show.images.poster);
  const stat = fs.statSync(abs);
  assert.ok(stat.size > 10000, `poster.jpg is only ${stat.size} bytes — looks like a stub, not real key art`);
});

test('findImagelessScoredShows no longer flags Bad Kreyòl now that it has a real image', () => {
  const nowMs = Date.now();
  const staleMs = nowMs - (DEFAULT_THRESHOLD_HOURS + 1) * 3600 * 1000;
  const show = loadShow();

  const flagged = findImagelessScoredShows(
    [{ id: SHOW_ID, hasImages: hasRealImage(show), reviewCount: 6, sinceMs: staleMs }],
    { nowMs, thresholdHours: DEFAULT_THRESHOLD_HOURS },
  );

  assert.deepEqual(flagged, [], 'a show with a real image must never reach the imageless-scored-show escalation path');
});
