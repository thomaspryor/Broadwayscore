/**
 * verify-opening-grades-live.test.mjs — the RECHECK-AFTER acceptance command
 * for BRO-7082 ("every opening, every market, gets an automatic grade").
 *
 * Asserts against LIVE repo data (data/audit/opening-grades.json), like
 * verify-provider-spend-streak.test.mjs: re-run by
 * scripts/autonomous-acceptance-recheck.js after the stamp date. A red run is
 * the claim being disproven (the daily CI grade did not run, or ran on a
 * history too shallow to grade), not a code regression. Skipped before then.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, '..', 'data', 'audit', 'opening-grades.json');
const CHECKABLE_FROM = Date.parse('2026-11-09T00:00:00Z');
// The hand-run seed file was generated 2026-11-07; a CI run is later.
const FIRST_CI_AFTER = Date.parse('2026-11-08T00:00:00Z');
const MARKETS = ['broadway', 'off-broadway', 'west-end', 'off-west-end'];

test('the daily opening grade is CI-produced, fresh, covers four markets and is fully gradable', {
  skip: Date.now() < CHECKABLE_FROM && 'not checkable before 2026-11-09',
}, () => {
  const doc = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const at = Date.parse(doc.generatedAt);
  assert.ok(at >= FIRST_CI_AFTER, `generatedAt ${doc.generatedAt} predates the first daily CI run`);
  assert.ok(Date.now() - at < 3 * 86400000, `generatedAt ${doc.generatedAt} is more than 3 days old: the daily step stopped`);
  for (const m of MARKETS) assert.ok(doc.summary && doc.summary[m], `summary missing ${m}`);
  const notGradable = MARKETS.reduce((n, m) => n + (doc.summary[m].notGradable || 0), 0);
  assert.equal(notGradable, 0, `CI fetch depth too shallow: ${notGradable} openings not gradable (historyFrom ${doc.historyFrom})`);
});
