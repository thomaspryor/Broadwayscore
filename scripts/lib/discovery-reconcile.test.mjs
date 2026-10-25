import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  computeShowReconciliation,
  evaluateReconciliationSafety,
  resolveReconciliationFields,
  appendReconciliationAudit,
  RECONCILE_MAX_SHIFT_DAYS,
} = require('./discovery-reconcile.js');

test('computeShowReconciliation: patches stale opening/preview/venue on an eligible show', () => {
  const existing = {
    title: 'Wanted',
    status: 'announced',
    openingDateSource: 'todaytix',
    openingDate: '2022-10-28',
    previewsStartDate: '2022-10-01',
    venue: 'Old Theatre',
  };
  const candidate = {
    title: 'Wanted',
    openingDate: '2026-10-15',
    openingDateSource: 'playbill',
    previewsStartDate: '2026-09-20',
    venue: 'New Theatre',
  };
  const patch = computeShowReconciliation(existing, candidate);
  assert.deepEqual(patch, {
    openingDate: '2026-10-15',
    openingDateSource: 'playbill',
    previewsStartDate: '2026-09-20',
    venue: 'New Theatre',
  });
});

test('computeShowReconciliation: no-op for an already-open show', () => {
  const existing = { title: 'Wanted', status: 'open', openingDateSource: 'todaytix' };
  const candidate = { title: 'Wanted', venue: 'New Theatre' };
  assert.equal(computeShowReconciliation(existing, candidate), null);
});

test('evaluateReconciliationSafety: 2+ agreeing sources are always trusted, even for venue changes', () => {
  const existing = { openingDate: '2026-01-01', previewsStartDate: '2025-12-01' };
  const result = evaluateReconciliationSafety(existing, { venue: 'New Theatre' }, 2);
  assert.equal(result.safe, true);
  assert.equal(result.reason, 'multi-source-agreement');
});

test('evaluateReconciliationSafety: single source, small date nudge is trusted (card #1446 drift-repair case)', () => {
  const existing = { openingDate: '2026-10-01', previewsStartDate: '2026-09-10' };
  const result = evaluateReconciliationSafety(
    existing,
    { openingDate: '2026-10-15', openingDateSource: 'playbill' },
    1
  );
  assert.equal(result.safe, true);
});

test('evaluateReconciliationSafety: single source venue change is held for corroboration', () => {
  const existing = { openingDate: null, previewsStartDate: null, venue: 'Old Theatre' };
  const result = evaluateReconciliationSafety(existing, { venue: 'New Theatre' }, 1);
  assert.equal(result.safe, false);
  assert.match(result.reason, /venue-change-single-source-unconfirmed/);
});

test('evaluateReconciliationSafety: single source venue FILL (no existing venue) is also held', () => {
  const existing = { openingDate: null, previewsStartDate: null, venue: null };
  const result = evaluateReconciliationSafety(existing, { venue: 'New Theatre' }, 1);
  assert.equal(result.safe, false);
  assert.match(result.reason, /venue-fill-single-source-unconfirmed/);
});

test('evaluateReconciliationSafety: single source date shift beyond the cap is held (wrong-production guard)', () => {
  const existing = { openingDate: '2026-01-01', previewsStartDate: null };
  const bigShiftDate = new Date('2026-01-01');
  bigShiftDate.setDate(bigShiftDate.getDate() + RECONCILE_MAX_SHIFT_DAYS + 30);
  const result = evaluateReconciliationSafety(
    existing,
    { openingDate: bigShiftDate.toISOString().split('T')[0], openingDateSource: 'todaytix' },
    1
  );
  assert.equal(result.safe, false);
  assert.match(result.reason, /shift-too-large/);
});

test('evaluateReconciliationSafety: single source date shift right at the cap boundary is trusted', () => {
  const existing = { openingDate: '2026-01-01', previewsStartDate: null };
  const capDate = new Date('2026-01-01');
  capDate.setDate(capDate.getDate() + RECONCILE_MAX_SHIFT_DAYS);
  const result = evaluateReconciliationSafety(
    existing,
    { openingDate: capDate.toISOString().split('T')[0], openingDateSource: 'todaytix' },
    1
  );
  assert.equal(result.safe, true);
});

test('evaluateReconciliationSafety: single source filling a date with NO existing baseline is held, not free-passed', () => {
  // Regression for a ship-check finding on the first version of this fix:
  // dayShift() returns 0 whenever either side is missing, so a naive
  // combined shift check let a single source fill in ANY date for a show
  // with no existing openingDate/previewsStartDate — the exact
  // parser-regression case the gate exists to catch, worse than a shift
  // because there's nothing to sanity-check the new value against.
  const existing = { openingDate: null, previewsStartDate: null };
  const result = evaluateReconciliationSafety(
    existing,
    { openingDate: '2099-01-01', openingDateSource: 'todaytix' },
    1
  );
  assert.equal(result.safe, false);
  assert.match(result.reason, /openingDate-fill-single-source-unconfirmed/);
});

test('evaluateReconciliationSafety: 2 sources CAN fill a date with no existing baseline', () => {
  const existing = { openingDate: null, previewsStartDate: null };
  const result = evaluateReconciliationSafety(
    existing,
    { openingDate: '2099-01-01', openingDateSource: 'todaytix' },
    2
  );
  assert.equal(result.safe, true);
});

test('resolveReconciliationFields: openingDate provenance always comes from a candidate that proposed the WINNING date', () => {
  // Regression for a ship-check finding: resolving openingDate and
  // openingDateSource as two independently-voted fields could pair a
  // majority-popular source LABEL with a date that label never actually
  // proposed. TodayTix proposes date A alone; two other sources agree on
  // date B with their own (different) source labels — B should win the
  // date vote AND carry a source label that actually proposed B.
  const existing = { openingDate: '2026-01-01', previewsStartDate: null, venue: null };
  const fields = {
    openingDate: new Map([
      ['2026-02-01', { sources: new Set(['todaytix']), openingDateSource: 'todaytix' }],
      ['2026-03-01', { sources: new Set(['playbill-broadway', 'showscore']), openingDateSource: 'playbill' }],
    ]),
  };
  const { patch } = resolveReconciliationFields(existing, fields);
  assert.equal(patch.openingDate, '2026-03-01');
  assert.equal(patch.openingDateSource, 'playbill');
});

test('resolveReconciliationFields: applies multi-source venue change, holds single-source venue change', () => {
  const existing = { openingDate: null, previewsStartDate: null, venue: 'Old Theatre' };
  const agreed = resolveReconciliationFields(existing, {
    venue: new Map([['New Theatre', new Set(['todaytix', 'olt'])]]),
  });
  assert.equal(agreed.patch.venue, 'New Theatre');
  assert.equal(agreed.heldFields.length, 0);

  const disputed = resolveReconciliationFields(existing, {
    venue: new Map([['New Theatre', new Set(['todaytix'])]]),
  });
  assert.equal(disputed.patch.venue, undefined);
  assert.equal(disputed.heldFields.length, 1);
  assert.equal(disputed.heldFields[0].field, 'venue');
});

test('evaluateReconciliationSafety: an unparseable candidate date is held, not treated as a zero-day shift', () => {
  const existing = { openingDate: '2026-01-01', previewsStartDate: null };
  const result = evaluateReconciliationSafety(
    existing,
    { openingDate: 'not-a-real-date', openingDateSource: 'todaytix' },
    1
  );
  assert.equal(result.safe, false);
  assert.match(result.reason, /shift-too-large/);
});

test('appendReconciliationAudit: writes a before/after trail and caps history at 50 runs', () => {
  const tmpPath = path.join(os.tmpdir(), `discovery-reconciliation-log-test-${process.pid}-${Date.now()}.json`);
  try {
    appendReconciliationAudit(
      [{ kind: 'applied', id: 'wanted-2026', title: 'Wanted', before: { venue: 'Old Theatre' }, after: { venue: 'New Theatre' } }],
      { mode: { dryRun: false } },
      tmpPath
    );
    let logged = JSON.parse(fs.readFileSync(tmpPath, 'utf8'));
    assert.equal(logged.runs.length, 1);
    assert.equal(logged.runs[0].entries[0].before.venue, 'Old Theatre');
    assert.equal(logged.runs[0].entries[0].after.venue, 'New Theatre');

    for (let i = 0; i < 60; i++) {
      appendReconciliationAudit([{ kind: 'applied', id: `show-${i}`, title: `Show ${i}` }], {}, tmpPath);
    }
    logged = JSON.parse(fs.readFileSync(tmpPath, 'utf8'));
    assert.equal(logged.runs.length, 50);
    // Oldest runs (including the first assertion's entry) are dropped, newest kept.
    assert.equal(logged.runs[logged.runs.length - 1].entries[0].id, 'show-59');
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
});
