// Locks the exclusion set shared by both scans in
// audit-cross-outlet-attributions.js. The bug this guards: the default-critic-of
// scan was missing the wrongProduction/wrongShow skip that the playbill-bleed
// scan had, so a file already flagged wrongShow was reported forever as an
// "unreviewed cross-outlet suspect" and held the CI acceptance test red.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { isTriagedOut } = require('../../scripts/lib/cross-outlet-triage.js');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('an untriaged record is not excluded', () => {
  assert.strictEqual(isTriagedOut({ criticName: 'A', outletId: 'b' }), false);
});

test('crossOutletVerified excludes', () => {
  assert.strictEqual(isTriagedOut({ crossOutletVerified: true }), true);
});

test('wrongAttribution excludes', () => {
  assert.strictEqual(isTriagedOut({ wrongAttribution: true }), true);
});

test('wrongShow excludes — the regression that held CI red', () => {
  assert.strictEqual(isTriagedOut({ wrongShow: true }), true);
});

test('wrongProduction excludes', () => {
  assert.strictEqual(isTriagedOut({ wrongProduction: true }), true);
});

test('duplicateOf does NOT exclude — duplication and attribution are independent', () => {
  // A duplicated syndicated article can still carry the wrong outlet's critic.
  // Skipping it would hide a real misattribution just because scoring drops the
  // row. Pinned so it does not get "helpfully" added back.
  assert.strictEqual(isTriagedOut({ duplicateOf: 'other-show/outlet--critic.json' }), false);
});

test('only literal true excludes, never a truthy string', () => {
  assert.strictEqual(isTriagedOut({ wrongShow: 'yes' }), false);
  assert.strictEqual(isTriagedOut({ crossOutletVerified: 1 }), false);
});

test('a null or non-object record never throws', () => {
  assert.strictEqual(isTriagedOut(null), false);
  assert.strictEqual(isTriagedOut(undefined), false);
  assert.strictEqual(isTriagedOut('nope'), false);
});

// The whole point of extracting the predicate is that the two scans cannot
// drift apart again. If someone re-inlines a check into one scan only, this
// fails.
test('both scans in the audit call the shared predicate, with no inline exclusion checks left', () => {
  const src = readFileSync(
    path.join(repoRoot, 'scripts', 'audit-cross-outlet-attributions.js'),
    'utf8'
  );
  // Tolerant on purpose: pinning the exact call arity or the parameter name
  // makes an innocent rename, a brace-wrapped continue, or a legitimate THIRD
  // scan fail here with a message that misdiagnoses the cause. What must hold
  // is that every scan routes through the helper -- which the field regexes
  // below actually enforce.
  const calls = src.match(/isTriagedOut\(\s*\w+\s*\)/g) || [];
  assert.ok(
    calls.length >= 2,
    `both the playbill-bleed scan and the default-critic-of scan must call isTriagedOut (found ${calls.length})`
  );
  for (const field of ['crossOutletVerified', 'wrongAttribution', 'wrongProduction', 'wrongShow']) {
    assert.ok(
      !new RegExp(`if \\(d\\.${field} === true`).test(src),
      `${field} must be checked only inside cross-outlet-triage.js, not re-inlined in a scan`
    );
  }
});
