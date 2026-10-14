// TESTS-VS-DERIVED-DATA-EXEMPT: structural check (file exists on disk, non-placeholder
// hash, predicate returns true) — there is no precursor source file for images, the
// image file itself IS the source of truth; nothing here pins a scraped/derived fact.
/**
 * BRO-2765 regression: THE LONELY FEW (the-lonely-few-off-broadway-2024) was
 * auto-filed by owner-alert-router after 3+ self-heal image-fetch attempts
 * (ledger shows 8 by the time it stopped). A real poster (guitar neck / pink
 * heart pick key art) landed via the twice-weekly "Auto-fetch and archive
 * show images" cron on 2026-09-10 (commit 1f87fea3cb7), independent of the
 * failing self-heal loop, but the alert condition was never resolved because
 * audit-imageless-scored-shows.js never called resolveCondition() when a
 * flagged show's image landed (same root cause as BRO-2651/Eurydice). This
 * asserts the fix actually held: the real shows.json entry points at a real,
 * non-placeholder file on disk, using the canonical predicate (CLAUDE.md
 * rule 15), not a re-implementation.
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
const SHOW_ID = 'the-lonely-few-off-broadway-2024';

function loadShow() {
  const data = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data', 'shows.json'), 'utf8'));
  const list = Array.isArray(data) ? data : (data.shows || []);
  return list.find(s => s.id === SHOW_ID);
}

test('THE LONELY FEW has a shows.json entry with an images block', () => {
  const show = loadShow();
  assert.ok(show, 'the-lonely-few-off-broadway-2024 must exist in data/shows.json');
  assert.ok(show.images, 'show entry must carry an images object');
});

test('THE LONELY FEW poster path resolves to a real, non-placeholder file on disk', () => {
  const show = loadShow();
  assert.equal(imageOnDisk(show.images.poster), true,
    `poster path ${show.images.poster} must exist on disk and not be a known placeholder`);
});

test('THE LONELY FEW passes the canonical hasRealImage predicate (self-heal acceptance criteria)', () => {
  const show = loadShow();
  assert.equal(hasRealImage(show), true,
    'the-lonely-few-off-broadway-2024 must have at least one real image — this is the condition the imageless-scored-show audit checks');
});

test('the poster file on disk is a real image, not a zero-byte or tiny stub', () => {
  const show = loadShow();
  const abs = path.join(REPO_ROOT, 'public', show.images.poster);
  const stat = fs.statSync(abs);
  assert.ok(stat.size > 10000, `poster.jpg is only ${stat.size} bytes — looks like a stub, not real key art`);
});
