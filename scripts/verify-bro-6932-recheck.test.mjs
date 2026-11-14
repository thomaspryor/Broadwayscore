/**
 * verify-bro-6932-recheck.test.mjs: RECHECK-AFTER acceptance for BRO-6932
 * (social autopost quiet-day backfill; Off-West End off the Broadway accounts).
 *
 * Asserts against the LIVE ledger, not a fixture. The change landed 2026-11-03
 * (71531c4c9). A quiet day (no score post, brief, compare, retry or own-set
 * roundup/closing card) posts up to two settled shows from 14:00 local, and
 * no Off-West End show may post at all until the west-end channel set exists.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const LANDED = '2026-11-04';
const CHECKABLE_FROM = Date.parse('2026-11-09T00:00:00Z');
const ledger = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'social-autopost-ledger.json'), 'utf8'));

test('quiet-day backfill has posted at least one show since landing', {
  skip: Date.now() < CHECKABLE_FROM && 'not checkable before 2026-11-09',
}, () => {
  const posts = (ledger().posts || []).filter((p) => p.backfill && !p.skipped && (p.date || '') >= LANDED);
  assert.ok(posts.length >= 1, 'no quiet-day backfill post in the ledger since 2026-11-04');
});

test('no Off-West End show posted while the west-end channel set is empty', {
  skip: Date.now() < CHECKABLE_FROM && 'not checkable before 2026-11-09',
}, () => {
  const C = require('./social-autopost/config.js');
  const weSet = Object.values(C.CHANNEL_SETS['west-end'] || {}).filter(Boolean);
  if (weSet.length) return; // the West End accounts exist: Off-West End posts are expected there
  const shows = require('../data/shows.json');
  const owe = new Set((Array.isArray(shows) ? shows : shows.shows).filter((s) => s.category === 'off-west-end').map((s) => s.id));
  const bad = (ledger().posts || []).filter((p) => !p.skipped && (p.date || '') >= LANDED
    && (p.showIds || [p.showId]).some((id) => owe.has(id)));
  assert.deepEqual(bad.map((p) => p.id), [], 'Off-West End show posted to the Broadway accounts');
});
