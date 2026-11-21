// BRO-2708 — the clearBreadcrumbRetracted stamp was a permanent tombstone, so the
// remedy for the BRO-185 self-contradictory-clear backlog armed its own recurrence.
//
// Mechanism, established by instrumenting safeWriteReview through a real scoped
// rebuild of the-sound-of-music-2027 (not by reading source):
//
//   w1  rebuild-all-reviews.js:1407  force:true  -> preserved: []
//       dateless-revival auto-clear re-STAMPS wrongProductionAutoCleared.
//   w2  rebuild-all-reviews.js:1593  no force    -> preserved: [wrongProductionAutoCleared,
//                                                               wrongProductionAutoClearedAt]
//       pre-opening guard re-flags and DOES call invalidateWrongProductionAutoClear.
//       The delete happened in memory and was reverted on the way to disk.
//
// safeWriteReview's clearHonored() is
//     isIntentionalClear(field, incomingSnapshot, existing)
//     && !isIntentionalClear(field, existing, existing)
// and the SECOND conjunct failed, because the drain had stamped clearBreadcrumbRetracted
// on the file and the stamp persisted forever, so `existing` permanently satisfied it.
//
// The fix makes the retraction LIVE-SCOPED: it speaks for a record only while the field
// it names is actually absent from that record. 707 files corpus-wide carried the stamp;
// 7 were tripped when this was found, and all 7 carried it (7/7).
//
// These tests drive the REAL exported functions, per CLAUDE.md rule 15 — no copied logic.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const guard = require('./review-write-guard.js');
const { safeWriteReview, invalidateWrongProductionAutoClear, isIntentionalClear, PROTECTED_FIELDS } = guard;

// A show id deliberately absent from shows.json: safeWriteReview's date-plausibility
// quarantine only fires when _getShowById(parentDir) resolves, so an unknown id keeps
// that guard out of the way and makes these assertions about the retraction logic alone.
const FIXTURE_SHOW = 'zz-bro2708-retraction-fixture-2026';
const AUTOCLEAR_FIELDS = ['wrongProductionAutoCleared', 'wrongProductionAutoClearedAt'];
const PRE_OPENING_NOTE =
  'Pre-opening guard: pre-window date — review dated 2026-02-05 is 60+ days before show starts 2027-03-23';
const RETRACTION_REASON =
  'retracted stale wrongProductionAutoCleared: contradicted live wrongProduction (#1020)';

// Computed, never hardcoded: _clearBreadcrumbRetracted is freshness-gated
// (CLEAR_RETRACTION_FRESH_DAYS), so a literal date would quietly expire and red CI a week
// after merge rather than failing here and now.
const TODAY = new Date().toISOString().split('T')[0];

// Guards the premise of the whole fix: these fields must actually be PROTECTED, or the
// restore this test is about could never fire and every assertion below would be vacuous.
test('premise: the auto-clear breadcrumb fields are PROTECTED (otherwise these tests are vacuous)', () => {
  for (const f of AUTOCLEAR_FIELDS) {
    assert.ok(PROTECTED_FIELDS.includes(f), `${f} must be in PROTECTED_FIELDS`);
  }
});

function seedFile(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro2708-'));
  const showDir = path.join(dir, FIXTURE_SHOW);
  fs.mkdirSync(showDir, { recursive: true });
  const fp = path.join(showDir, 'the-daily--ana-taveira.json');
  const record = {
    url: 'https://thedailytexan.com/2026/02/05/bass-concert-hall-is-alive-with-the-sound-of-music/',
    outlet: 'The Daily',
    publishDate: '2026-02-05',
    wrongProduction: true,
    wrongProductionNote: PRE_OPENING_NOTE,
    wrongProductionReason: 'dateless-revival',
    ...extra,
  };
  fs.writeFileSync(fp, JSON.stringify(record, null, 2));
  return { fp, record: JSON.parse(JSON.stringify(record)) };
}

// Exactly the state --fix-safe leaves behind: flag live, breadcrumb gone, retraction
// stamped. This is the "green" state the BRO-185 acceptance test needs to stay stable.
function seedDrainedFile() {
  return seedFile({
    clearBreadcrumbRetracted: RETRACTION_REASON,
    clearBreadcrumbRetractedAt: TODAY,
    clearBreadcrumbRetractedFields: [...AUTOCLEAR_FIELDS],
  });
}

// Replays the two writes rebuild-all-reviews.js makes to the same object in one pass.
function runRebuildCycle(fp, d) {
  // w1 — rebuild-all-reviews.js:1393-1407, dateless-revival auto-clear (force).
  const wasNote = d.wrongProductionNote || d.wrongProductionReason || '(no marker)';
  d.wrongProduction = false;
  d.wrongProductionAutoCleared = `rebuild: dateless-revival hold released (was: ${wasNote})`;
  d.wrongProductionAutoClearedAt = new Date().toISOString().split('T')[0];
  delete d.wrongProductionNote;
  delete d.wrongProductionReason;
  safeWriteReview(fp, d, { force: true });

  // w2 — rebuild-all-reviews.js:1590-1593, dated pre-opening guard re-flags (no force).
  d.wrongProduction = true;
  invalidateWrongProductionAutoClear(d);
  d.wrongProductionNote = PRE_OPENING_NOTE;
  return safeWriteReview(fp, d);
}

test('a drained file survives the rebuild auto-clear/re-flag pair without going self-contradictory (BRO-2708)', () => {
  const { fp, record } = seedDrainedFile();
  const res = runRebuildCycle(fp, record);

  const final = JSON.parse(fs.readFileSync(fp, 'utf8'));
  assert.equal(final.wrongProduction, true, 'the re-flag must stand');
  assert.equal(
    final.wrongProductionAutoCleared,
    undefined,
    'wrongProductionAutoCleared was restored over a live wrongProduction — this is the self-contradictory clear'
  );
  assert.equal(final.wrongProductionAutoClearedAt, undefined);
  assert.deepEqual(
    res.preserved.filter((f) => AUTOCLEAR_FIELDS.includes(f)),
    [],
    'the guard must not preserve breadcrumb fields the caller deliberately invalidated'
  );
});

test('the clean state is a FIXPOINT: a second rebuild cycle does not reintroduce the contradiction', () => {
  const { fp, record } = seedDrainedFile();
  runRebuildCycle(fp, record);
  // Re-read from disk the way the next rebuild would, rather than reusing the object.
  const reread = JSON.parse(fs.readFileSync(fp, 'utf8'));
  runRebuildCycle(fp, reread);

  const final = JSON.parse(fs.readFileSync(fp, 'utf8'));
  assert.equal(final.wrongProduction, true);
  assert.equal(
    final.wrongProductionAutoCleared,
    undefined,
    'the treadmill is only broken if the state is stable across repeated rebuilds, not just the first'
  );
});

test('a retraction stops speaking for a record once the field it names is live again', () => {
  const reCreated = {
    wrongProductionAutoCleared: 'rebuild: UK URL on London show (www.newyorktheatreguide.com)',
    wrongProductionAutoClearedAt: TODAY,
    clearBreadcrumbRetracted: RETRACTION_REASON,
    clearBreadcrumbRetractedAt: TODAY,
    clearBreadcrumbRetractedFields: [...AUTOCLEAR_FIELDS],
  };
  assert.equal(
    isIntentionalClear('wrongProductionAutoCleared', reCreated, reCreated),
    false,
    'the value is present, so nothing has been retracted from this record'
  );
});

test('a retraction still speaks for a record whose named field really is gone (no weakening)', () => {
  const trulyCleared = {
    wrongProduction: true,
    clearBreadcrumbRetracted: RETRACTION_REASON,
    clearBreadcrumbRetractedAt: TODAY,
    clearBreadcrumbRetractedFields: [...AUTOCLEAR_FIELDS],
  };
  assert.equal(
    isIntentionalClear('wrongProductionAutoCleared', trulyCleared, trulyCleared),
    true,
    'the deliberate-clear exemption must still work — this is what the breadcrumb is for'
  );
});

test('the liveness check is field-scoped: one live field does not mute the retraction for another', () => {
  const mixed = {
    wrongProductionAutoCleared: 'live again',
    // crossOutletVerified is genuinely still deleted
    clearBreadcrumbRetracted: RETRACTION_REASON,
    clearBreadcrumbRetractedAt: TODAY,
    clearBreadcrumbRetractedFields: ['wrongProductionAutoCleared', 'crossOutletVerified'],
  };
  assert.equal(isIntentionalClear('wrongProductionAutoCleared', mixed, mixed), false);
  assert.equal(
    isIntentionalClear('crossOutletVerified', mixed, mixed),
    true,
    'a live field in one family must not retire the retraction covering another'
  );
});

test('a record that never carried the stamp gets full data-loss protection', () => {
  const plain = { wrongProduction: true };
  assert.equal(isIntentionalClear('wrongProductionAutoCleared', plain, plain), false);
});

// The drain was never the cause. A file that has NEVER been drained carries no retraction
// stamp at all, so before this fix its re-flag write failed clearHonored()'s FIRST conjunct
// instead of its second — and went contradictory just the same. Measured:
//   NEVER-DRAINED  preserved=[wrongProductionAutoCleared, wrongProductionAutoClearedAt]
//   DRAINED        preserved=[wrongProductionAutoCleared, wrongProductionAutoClearedAt]
// Fixing only the stamped case would have left the far larger untouched population broken,
// and would have looked like a fix because the 7 known-red files are all drained ones.
test('a file that was NEVER drained also survives the cycle (the drain was not the cause)', () => {
  const { fp, record } = seedFile({});
  assert.equal(record.clearBreadcrumbRetracted, undefined, 'fixture must carry no retraction stamp');
  const res = runRebuildCycle(fp, record);

  const final = JSON.parse(fs.readFileSync(fp, 'utf8'));
  assert.equal(final.wrongProduction, true);
  assert.equal(
    final.wrongProductionAutoCleared,
    undefined,
    'an undrained file went self-contradictory — the fix only covered files a prior drain had stamped'
  );
  assert.deepEqual(res.preserved.filter((f) => AUTOCLEAR_FIELDS.includes(f)), []);
});

test('invalidateWrongProductionAutoClear records a retraction for exactly what it deleted', () => {
  const d = {
    wrongProduction: true,
    wrongProductionAutoCleared: 'rebuild: UK URL on London show (www.newyorktheatreguide.com)',
    wrongProductionAutoClearedAt: TODAY,
  };
  invalidateWrongProductionAutoClear(d);
  assert.equal(d.wrongProductionAutoCleared, undefined);
  assert.equal(d.wrongProductionAutoClearedAt, undefined);
  assert.deepEqual([...d.clearBreadcrumbRetractedFields].sort(), [...AUTOCLEAR_FIELDS].sort());
  assert.ok(d.clearBreadcrumbRetracted, 'a retraction reason must be recorded');
});

test('invalidateWrongProductionAutoClear mints nothing when there was no breadcrumb to retract', () => {
  const d = { wrongProduction: true };
  invalidateWrongProductionAutoClear(d);
  assert.equal(
    d.clearBreadcrumbRetracted,
    undefined,
    'a no-op invalidate must not mint a stamp that could authorize losing these fields later'
  );
});

test('a minted retraction goes inert as soon as the field it names is live again', () => {
  // This is what keeps the invalidate-side stamp from becoming a standing permission slip:
  // it stops speaking the moment a writer legitimately re-creates the value.
  const d = {
    wrongProduction: true,
    wrongProductionAutoCleared: 'x',
    wrongProductionAutoClearedAt: TODAY,
  };
  invalidateWrongProductionAutoClear(d);
  assert.equal(isIntentionalClear('wrongProductionAutoCleared', d, d), true, 'active while the field is gone');

  d.wrongProductionAutoCleared = 'rebuild: a later writer re-created this';
  assert.equal(
    isIntentionalClear('wrongProductionAutoCleared', d, d),
    false,
    'the stamp must not outlive the deletion it describes'
  );
});

test('a retraction preserves coverage of a sibling family it also named', () => {
  const d = {
    wrongProductionAutoCleared: 'x',
    wrongProductionAutoClearedAt: TODAY,
    clearBreadcrumbRetracted: 'earlier retraction of a different family',
    clearBreadcrumbRetractedAt: TODAY,
    clearBreadcrumbRetractedFields: ['crossOutletVerified'],
  };
  invalidateWrongProductionAutoClear(d);
  assert.deepEqual(
    [...d.clearBreadcrumbRetractedFields].sort(),
    ['crossOutletVerified', ...AUTOCLEAR_FIELDS].sort(),
    'stamping one family must union with, not replace, an existing retraction'
  );
  assert.equal(isIntentionalClear('crossOutletVerified', d, d), true, 'sibling coverage survives');
});

test('a retraction older than the freshness window stops speaking (bounds the stale-stamp window)', () => {
  const stale = {
    wrongProduction: true,
    clearBreadcrumbRetracted: RETRACTION_REASON,
    clearBreadcrumbRetractedAt: '2020-01-01',
    clearBreadcrumbRetractedFields: [...AUTOCLEAR_FIELDS],
  };
  assert.equal(
    isIntentionalClear('wrongProductionAutoCleared', stale, stale),
    false,
    'an ancient stamp must not authorize dropping a value some later writer re-created'
  );
});

// Legacy shape, pinned deliberately. An undated retraction must KEEP working: expiring it
// would make a previously-honored clear un-honored, so the guard would resurrect the field
// the sweep removed. That is a widening, and it is the failure the breadcrumb exists to
// prevent. tests/unit/review-write-guard.test.mjs:1164 writes exactly this shape.
test('an undated retraction still speaks (expiring it would widen, not narrow)', () => {
  const undated = {
    wrongProduction: true,
    clearBreadcrumbRetracted: RETRACTION_REASON,
    clearBreadcrumbRetractedFields: [...AUTOCLEAR_FIELDS],
  };
  assert.equal(isIntentionalClear('wrongProductionAutoCleared', undated, undated), true);
});
