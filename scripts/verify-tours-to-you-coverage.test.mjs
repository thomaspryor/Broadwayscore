/**
 * verify-tours-to-you-coverage.test.mjs — RECHECK-AFTER acceptance probe for
 * BRO-4725 (Tours To You discovery reads every page over time).
 *
 * Asserts against LIVE repo data (data/audit/tour-autocreate.json, written by
 * the daily BWW landing job's create-tour-entries.js step), not a fixture.
 * Run by scripts/autonomous-acceptance-recheck.js after the stamp date; never
 * by CI (exempted in audit-orphan-tests.js). Red means the claim is disproven.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { stalePages } = require('./lib/tours-to-you-coverage.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const audit = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'data', 'audit', 'tour-autocreate.json'), 'utf8'));

// land.js runs every changed *.test.mjs, and the first scheduled landing run
// that writes coverage is 2026-10-06 14:00 UTC, so the live-data checks skip
// until a day after it.
const PENDING = Date.now() < Date.parse('2026-10-07T14:00:00Z');

test('the landing job reported in the last 48 hours', { skip: PENDING }, () => {
  const hours = (Date.now() - Date.parse(audit.generatedAt)) / 3600000;
  assert.ok(hours <= 48, `last report ${Math.round(hours)}h ago`);
});

test('discovery ran and keeps a coverage map of the Broadway-titled pages', { skip: PENDING }, () => {
  const d = audit.discovery || {};
  assert.ok(!d.error, `discovery failed: ${d.error}`);
  assert.ok(Object.keys(d.coverage || {}).length >= 100, 'coverage map missing or tiny');
});

test('every page has been read, and none is older than the stale window', { skip: PENDING }, () => {
  const coverage = audit.discovery.coverage;
  const never = Object.entries(coverage).filter(([, c]) => !c.checkedAt).map(([s]) => s);
  assert.deepEqual(never, [], `${never.length} page(s) never read`);
  const stale = stalePages(coverage, new Date()).map(r => r.slug);
  assert.deepEqual(stale, [], `${stale.length} page(s) unread past the window`);
});
