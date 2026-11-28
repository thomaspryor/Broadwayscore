import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { shouldResolveStarBandAlert } = require('./lib/star-band-alert-decision.js');

test('clean or report-only-only runs resolve the alert', () => {
  assert.equal(shouldResolveStarBandAlert([]), true);
  assert.equal(shouldResolveStarBandAlert([{ kind: 'false-truncation' }]), true);
});
test('actionable findings keep it open', () => {
  assert.equal(shouldResolveStarBandAlert([{ kind: 'clobbered' }]), false);
  assert.equal(shouldResolveStarBandAlert([{ kind: 'false-truncation' }, { kind: 'unanchored' }]), false);
});
test('detector wires the decision to resolveCondition (class guard)', () => {
  const src = fs.readFileSync(new URL('./detect-star-band-regressions.js', import.meta.url), 'utf8');
  assert.match(src, /shouldResolveStarBandAlert\(findings\)/);
  assert.match(src, /resolveCondition\('star-band:regressions'/);
});
