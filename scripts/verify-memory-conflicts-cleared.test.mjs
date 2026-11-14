/**
 * verify-memory-conflicts-cleared.test.mjs — RECHECK-AFTER acceptance command
 * for BRO-7228 (saved MEMORY.md conflict copies archive themselves).
 *
 * Asserts against LIVE repo data on purpose: the owner's Mac writes
 * cloud-memory/sync-conflicts.json at session stop, so the claim "the morning
 * digest stops flagging the 5 old MEMORY.md copies" can only be checked after
 * the Mac has pulled the fix and synced once. A red run is the claim being
 * disproven (the Mac has not synced, or the archive step is failing there),
 * not a code regression. The name starts with verify-, so land gates skip it
 * (scripts/lib/unit-test-collection.js DEFAULT_EXCLUDE_RE).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORT = path.join(HERE, '..', 'cloud-memory', 'sync-conflicts.json');
const CHECKABLE_FROM = Date.parse('2026-11-11T00:00:00Z');

test('no saved MEMORY.md conflict copies are waiting for review', {
  skip: Date.now() < CHECKABLE_FROM && 'not checkable before 2026-11-11 (needs a Mac session-stop sync)',
}, () => {
  const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
  const indexCopies = report.paths.filter((p) => /^_conflicts\/MEMORY\.cloud-conflict-/.test(p));
  assert.deepEqual(
    indexCopies,
    [],
    `${indexCopies.length} MEMORY.md copies still flagged (report generated ${report.generatedAt}): the Mac has not synced the BRO-7228 archive step yet`,
  );
});
