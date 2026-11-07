// BRO-4656: the push-review-texts restore copied cleared manualClearFallback*
// give-up markers back from the committed file, because a null PROTECTED field
// looks like data loss unless isIntentionalClear() says otherwise. Three
// Spamalot tour reviews stayed blocked from scoring after the tour sweep had
// cleared them. These cases pin the two legitimate clears and the one restore
// that must still happen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isIntentionalClear } = require('./review-write-guard.js');
const { clearStaleScoringFailure } = require('./tour-backfill.js');

const FIELDS = ['manualClearFallbackFailedAt', 'manualClearFallbackFailureReason',
  'manualClearFallbackAttempts', 'manualClearFallbackAbandoned'];
const committed = {
  url: 'https://example.com/review', routedFromShowId: 'spamalot-2023',
  fullText: 'x'.repeat(4000),
  manualClearFallbackFailedAt: '2026-09-01T00:00:00Z',
  manualClearFallbackFailureReason: 'haiku-no-score',
  manualClearFallbackAttempts: 3,
  manualClearFallbackAbandoned: true,
};

test('tour sweep clear (routedPriorVerdicts keeps the old value) is honored', () => {
  const local = clearStaleScoringFailure(committed);
  assert.ok(local, 'repair should fire');
  for (const f of FIELDS) {
    assert.equal(local[f], null);
    assert.equal(isIntentionalClear(f, local, committed), true, f);
  }
});

test('a give-up recorded after the move is still restored', () => {
  const local = clearStaleScoringFailure(committed);
  const newer = { ...committed, manualClearFallbackFailedAt: '2026-10-04T00:00:00Z', manualClearFallbackAttempts: 1 };
  assert.equal(isIntentionalClear('manualClearFallbackFailedAt', local, newer), false);
  assert.equal(isIntentionalClear('manualClearFallbackAttempts', local, newer), false);
});

test('an omitted marker (undefined) on a scored routed file is still restored', () => {
  const local = { ...clearStaleScoringFailure(committed), llmScore: { score: 82 } };
  for (const f of FIELDS) delete local[f];
  for (const f of FIELDS) assert.equal(isIntentionalClear(f, local, committed), false, f);
});

test('a scored non-routed file losing its markers is still restored', () => {
  const local = { ...committed, routedFromShowId: undefined, llmScore: { score: 82 } };
  for (const f of FIELDS) local[f] = null;
  for (const f of FIELDS) assert.equal(isIntentionalClear(f, local, committed), false, f);
});

test('safeWriteReview keeps the archived-marker clear through a merge write', async () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { safeWriteReview } = require('./review-write-guard.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcf-'));
  const file = path.join(dir, 'outlet--critic.json');
  fs.writeFileSync(file, JSON.stringify(committed, null, 2));
  safeWriteReview(file, clearStaleScoringFailure(committed));
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const f of FIELDS) assert.equal(after[f], null, f);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a bare omission with no breadcrumb is still restored', () => {
  const local = { ...committed };
  for (const f of FIELDS) delete local[f];
  for (const f of FIELDS) assert.equal(isIntentionalClear(f, local, committed), false, f);
});

test('a live marker never counts as cleared', () => {
  const local = { ...committed, routedPriorVerdicts: { manualClearFallbackAbandoned: true } };
  for (const f of FIELDS) assert.equal(isIntentionalClear(f, local, committed), false, f);
});
