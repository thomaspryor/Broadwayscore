// TESTS-VS-DERIVED-DATA-EXEMPT: BRO-4937 acceptance gate for retired provenance debt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { applyReviewFieldEdit } = require('../../scripts/lib/review-field-edit.js');
const { isOrphanedWrongProdProvenance } = require('../../scripts/lib/orphaned-wrongprod-provenance.js');

const baseline = JSON.parse(readFileSync(new URL('../../data/audit/orphaned-wrongprod-provenance-baseline.json', import.meta.url), 'utf8'));

test('BRO-4937: no orphaned wrongProduction files remain baselined', () => {
  assert.deepEqual(baseline.files, [], 'Triage each file before removing it from the baseline');
});

test('BRO-4937: every retired entry has evidence and every pending decision has an executable action', () => {
  const plan = JSON.parse(readFileSync(new URL('../../data/pending-fixes/bro-4937.json', import.meta.url), 'utf8'));
  const actions = plan.plan.actions;
  assert.equal(baseline.triage.length, 20);
  assert.equal(new Set(baseline.triage.map(t => t.file)).size, 20);
  assert.equal(plan.issueNumber, 'bro-4937');
  assert.ok(['pending', 'applied'].includes(plan.status));
  assert.equal(actions.length, 14);
  assert.equal(new Set(actions.map(a => a.file)).size, 14);

  const pending = baseline.triage.filter(t => t.decision === 'clear' || t.decision === 'restore');
  assert.equal(pending.filter(t => t.decision === 'clear').length, 8);
  assert.equal(pending.filter(t => t.decision === 'restore').length, 6);
  for (const t of baseline.triage) {
    assert.ok(t.evidence.length > 40, `${t.file}: missing source evidence`);
    if (!pending.includes(t)) {
      assert.ok(['already-restored', 'already-removed'].includes(t.decision));
      assert.ok(!actions.some(a => a.file === t.file), `${t.file}: already resolved`);
      continue;
    }
    const action = actions.find(a => a.file === t.file);
    assert.ok(action, `${t.file}: missing planned action`);
    assert.equal(action.type, 'review-field-edit');
    assert.equal(action.field, t.decision === 'clear' ? 'wrongProductionManualClear' : 'wrongProduction');
    assert.equal(action.newValue, true);
    assert.equal(action.description, `BRO-4937: ${t.evidence}`);
    // Exercise the executor and corpus predicate, rather than duplicating either.
    const record = { wrongProductionDetectedBy: 'ingest-anticipatory-gate', [action.field]: action.oldValue };
    assert.equal(isOrphanedWrongProdProvenance(record), true);
    const result = applyReviewFieldEdit(record, action, { fixId: 'bro-4937', at: '2026-10-25T00:00:00Z' });
    assert.equal(result.ok, true, `${t.file}: ${result.reason}`);
    assert.equal(result.record[action.field], true, t.file);
    assert.equal(isOrphanedWrongProdProvenance(result.record), false, t.file);
  }
});

test('BRO-4937: restore the misattributed Color Purple cast-change review exclusion', () => {
  const file = 'the-color-purple-2005/nytimes--alissa-wilkinson.json';
  const plan = JSON.parse(readFileSync(new URL('../../data/pending-fixes/bro-4937.json', import.meta.url), 'utf8'));
  assert.equal(baseline.triage.find(t => t.file === file).decision, 'restore');
  const action = plan.plan.actions.find(a => a.file === file);
  assert.equal(action.field, 'wrongProduction');
  assert.equal(action.oldValue, null);
  assert.equal(action.newValue, true);
});
