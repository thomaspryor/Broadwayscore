/**
 * BRO-2651 regression: EURYDICE (eurydice-off-broadway-2026) was auto-filed by
 * owner-alert-router after 5 failed self-heal image fetches. A real poster
 * (Maya Hawke / Sarah Ruhl / Signature Theatre, 400x631 JPEG) landed via
 * fetch-all-image-formats.yml on 2026-09-07 (commit e55a8812d7a) but the
 * Linear card was never auto-closed — the drain that verifies parked
 * machine-checkable issues hadn't shipped yet. This asserts the fix actually
 * held: the real shows.json entry points at a real, non-placeholder file on
 * disk, using the canonical predicate (CLAUDE.md rule 15), not a re-implementation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hasRealImage, imageOnDisk } = require('../../scripts/lib/show-images.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');
const SHOW_ID = 'eurydice-off-broadway-2026';

function loadShow() {
  const data = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data', 'shows.json'), 'utf8'));
  const list = Array.isArray(data) ? data : (data.shows || []);
  return list.find(s => s.id === SHOW_ID);
}

test('EURYDICE has a shows.json entry with an images block', () => {
  const show = loadShow();
  assert.ok(show, 'eurydice-off-broadway-2026 must exist in data/shows.json');
  assert.ok(show.images, 'show entry must carry an images object');
});

test('EURYDICE poster path resolves to a real, non-placeholder file on disk', () => {
  const show = loadShow();
  assert.equal(imageOnDisk(show.images.poster), true,
    `poster path ${show.images.poster} must exist on disk and not be a known placeholder`);
});

test('EURYDICE passes the canonical hasRealImage predicate (self-heal acceptance criteria)', () => {
  const show = loadShow();
  assert.equal(hasRealImage(show), true,
    'eurydice-off-broadway-2026 must have at least one real image — this is the condition the imageless-scored-show audit checks');
});

test('the poster file on disk is a real image, not a zero-byte or tiny stub', () => {
  const show = loadShow();
  const abs = path.join(REPO_ROOT, 'public', show.images.poster);
  const stat = fs.statSync(abs);
  assert.ok(stat.size > 10000, `poster.jpg is only ${stat.size} bytes — looks like a stub, not real key art`);
});
