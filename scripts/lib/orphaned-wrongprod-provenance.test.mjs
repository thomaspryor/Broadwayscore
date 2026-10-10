import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isOrphanedWrongProdProvenance: orphan } = require('./orphaned-wrongprod-provenance.js');

test('provenance with flag dropped is orphaned', () => {
  assert.equal(orphan({ wrongProductionDetectedBy: 'ingest-anticipatory-gate', tierReason: 'Wrong production' }), true);
  assert.equal(orphan({ wrongProductionDetail: 'x' }), true);
  assert.equal(orphan({ wrongProductionProvenance: 'url', wrongProduction: null }), true);
});
test('flag present (true) is fine', () => {
  assert.equal(orphan({ wrongProductionDetectedBy: 'a', wrongProduction: true }), false);
});
test('recorded clears are not orphans', () => {
  assert.equal(orphan({ wrongProductionDetectedBy: 'a', wrongProduction: false }), false);
  assert.equal(orphan({ wrongProductionDetectedBy: 'a', wrongProductionManualClear: true }), false);
  assert.equal(orphan({ wrongProductionDetectedBy: 'a', wrongProductionManualClear: 'false positive 2026-04-01' }), false);
});
test('other recorded clears are not orphans', () => {
  for (const c of [{ wrongProductionOverride: true }, { humanReviewedWrongProduction: false },
    { wrongProductionAutoCleared: 'rebuild: x' }, { wrongProductionAuditCleared: 'x' }]) {
    assert.equal(orphan({ wrongProductionDetectedBy: 'a', ...c }), false);
  }
});
test('files already excluded from scoring are not orphans', () => {
  for (const c of [{ duplicateOf: 'x/y.json' }, { isRoundupArticle: true }, { wrongShow: true }]) {
    assert.equal(orphan({ wrongProductionDetectedBy: 'a', ...c }), false);
  }
});
test('_wrongProductionDetectedBy counts as provenance', () => {
  assert.equal(orphan({ _wrongProductionDetectedBy: 'x' }), true);
});
test('no provenance / junk input is not an orphan', () => {
  assert.equal(orphan({ url: 'u' }), false);
  assert.equal(orphan({ wrongProductionDetectedBy: '' }), false);
  assert.equal(orphan(null), false);
});
