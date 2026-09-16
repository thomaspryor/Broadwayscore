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
  const existing = { openingDate: null, previewsStartDate: null };
  const result = evaluateReconciliationSafety(existing, { venue: 'New Theatre' }, 1);
  assert.equal(result.safe, false);
  assert.match(result.reason, /venue-change-single-source-unconfirmed/);
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
