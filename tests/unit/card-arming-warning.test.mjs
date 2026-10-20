// BRO-3613 chooses option 2: creation stays local, dispatch checks vacuity.
// Exercise the real shared warning used by linear-brain.js create.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { armingWarning } = require('../../scripts/lib/card-arming-warning.js');
const { evaluateVerifiability } = require('../../scripts/lib/verify-gate.js');
const {
  classifyVacuousCheck,
  VACUOUS_TEST_F_SATISFIED,
} = require('../../scripts/lib/card-premises-auditor.js');

test('an already-satisfied test -f stays silent at creation without consulting origin/main', () => {
  const cmd = 'test -f scripts/opening-night-poller.js';
  const notes = `## Acceptance criteria\nVERIFY: ${cmd}\n`;
  const existsOnOriginMainFn = mock.fn((file) => {
    assert.equal(file, 'scripts/opening-night-poller.js');
    return true;
  });

  // Prove this is the vacuous case using the real classifier and a stub
  // oracle, then prove creation deliberately leaves that check to dispatch.
  assert.equal(classifyVacuousCheck(cmd, existsOnOriginMainFn).kind, VACUOUS_TEST_F_SATISFIED);
  assert.equal(existsOnOriginMainFn.mock.callCount(), 1);
  existsOnOriginMainFn.mock.resetCalls();
  assert.equal(evaluateVerifiability(notes).armed, true);
  assert.equal(armingWarning(notes, { existsOnOriginMainFn }), null);
  assert.equal(existsOnOriginMainFn.mock.callCount(), 0);
  assert.equal(armingWarning(notes), null, 'the production default also stays silent');
});

test('a new artifact stays silent without consulting origin/main', () => {
  const notes = '## Acceptance criteria\nVERIFY: test -f scripts/bro-3613-not-written.js\n';
  const existsOnOriginMainFn = mock.fn(() => false);

  assert.equal(evaluateVerifiability(notes).armed, true);
  assert.equal(armingWarning(notes, { existsOnOriginMainFn }), null);
  assert.equal(existsOnOriginMainFn.mock.callCount(), 0);
});

test('skipping origin/main preserves the local warning for a directory operand', () => {
  const notes = '## Acceptance criteria\nVERIFY: test -f scripts/lib\n';
  const existsOnOriginMainFn = mock.fn(() => true);

  assert.equal(evaluateVerifiability(notes).armed, true);
  assert.match(armingWarning(notes, { existsOnOriginMainFn }), /directory/i);
  assert.equal(existsOnOriginMainFn.mock.callCount(), 0);
});
