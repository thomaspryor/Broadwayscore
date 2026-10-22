// show-id market suffix + year guard (BRO-4315, 2026 data audit S8-T1).
// TESTS-VS-DERIVED-DATA-EXEMPT: structural rule (id suffix agrees with category); shows.json is the source of truth for both fields, no facts pinned
//
// Every shows.json id's market suffix must match its category, and every
// live (non-closed) id's trailing year should match its opening or previews
// year (advisory; SHOW_ID_YEAR_STRICT=1 makes it fail). Known offenders sit in tests/fixtures/show-id-allowlist.json until
// their rename lands; anything else fails. Pure rules are the real modules
// (CLAUDE.md §15): scripts/lib/show-id-market-suffix.js, id-year-drift.js.
//
// Run: node --test tests/unit/show-id-market-suffix.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { marketSuffixMismatch, findMarketSuffixMismatches, offWestEndIdFor } = require('../../scripts/lib/show-id-market-suffix.js');
const { findIdYearDrift } = require('../../scripts/lib/id-year-drift.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOWS = path.join(ROOT, 'data', 'shows.json');
const allow = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'show-id-allowlist.json'), 'utf8'));

test('rule: suffix agrees with category', () => {
  const row = (id, category) => ({ id, category });
  assert.equal(marketSuffixMismatch(row('hamilton-2015', 'broadway')), null);
  assert.equal(marketSuffixMismatch(row('hamilton-west-end-2017', 'west-end')), null);
  assert.equal(marketSuffixMismatch(row('relics-off-west-end-2026', 'off-west-end')), null);
  assert.equal(marketSuffixMismatch(row('relics-off-west-end', 'off-west-end')), null);
  assert.equal(marketSuffixMismatch(row('kinky-boots-off-broadway-2026', 'off-broadway')), null);
  // The West End Noises Off: "-off" belongs to the title.
  assert.equal(marketSuffixMismatch(row('noises-off-west-end-2023', 'west-end')), null);
  assert.ok(marketSuffixMismatch(row('relics-west-end-2026', 'off-west-end')));
  assert.ok(marketSuffixMismatch(row('the-gin-game-2026', 'off-broadway')));
  assert.ok(marketSuffixMismatch(row('evita-west-end-2026', 'broadway')));
  assert.ok(marketSuffixMismatch(row('cats-2026', 'west-end')));
});

test('rule: off-west-end target id', () => {
  assert.equal(offWestEndIdFor('relics-west-end-2026'), 'relics-off-west-end-2026');
  assert.equal(offWestEndIdFor('magic-mike-live-west-end'), 'magic-mike-live-off-west-end');
  assert.equal(offWestEndIdFor('relics-off-west-end-2026'), null);
  assert.equal(offWestEndIdFor('evita-2026'), null);
});

test('allowlist entries are unique and sorted', () => {
  for (const key of ['marketSuffix', 'yearDrift']) {
    const list = allow[key];
    assert.ok(Array.isArray(list), `${key} must be an array`);
    assert.deepEqual(list, [...new Set(list)].sort(), `${key} must be sorted and unique`);
  }
});

const shows = fs.existsSync(SHOWS) ? JSON.parse(fs.readFileSync(SHOWS, 'utf8')).shows : null;

test('every shows.json id suffix matches its category', { skip: !shows && 'data/shows.json absent' }, () => {
  const allowed = new Set(allow.marketSuffix);
  const fresh = findMarketSuffixMismatches(shows).filter((h) => !allowed.has(h.id));
  assert.deepEqual(fresh.map((h) => `${h.id}: ${h.reason}`), [], 'new id/category mismatch: fix the id (scripts/rename-show-id.js) or the category');
  const live = new Set(shows.map((s) => s.id));
  const stale = allow.marketSuffix.filter((id) => live.has(id) && !marketSuffixMismatch(shows.find((s) => s.id === id)));
  if (stale.length) console.log(`allowlist: ${stale.length} marketSuffix entr(ies) now fixed, remove them: ${stale.join(', ')}`);
});

test('every live id year matches its opening or previews year', { skip: !shows && 'data/shows.json absent' }, () => {
  const allowed = new Set(allow.yearDrift);
  const fresh = findIdYearDrift(shows).filter((h) => !allowed.has(h.id))
    .map((h) => `${h.id}: id ${h.idYear}, opening ${h.openingYear}, previews ${h.previewsYear}`);
  // Advisory unless SHOW_ID_YEAR_STRICT=1 (CLAUDE.md §19): enrichment moves
  // dates after minting by design, so fresh drift appears without any code
  // change and must not block unrelated lands.
  if (process.env.SHOW_ID_YEAR_STRICT === '1') assert.deepEqual(fresh, [], 'new id-year drift: mint the id from the confirmed date, or rename it');
  else if (fresh.length) console.log(`advisory: ${fresh.length} id(s) drifted from their dates since the baseline: ${fresh.join('; ')}`);
});
