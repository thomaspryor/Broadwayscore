import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { evaluateDoneTransition, isMergedDeployedChecked, VERDICTS } =
  require('../../scripts/lib/done-semantics-gate.js');

test('BLOCKS: no PR reference and no verification command', () => {
  const r = evaluateDoneTransition({ prRef: null, notes: 'Fixed the thing, looks good.' });
  assert.equal(r.allowed, false);
  assert.equal(r.verdict, VERDICTS.BLOCKED_NO_EVIDENCE);
  assert.match(r.reason, /no PR reference recorded/);
});

test('BLOCKS: PR reference present but not deployed yet', () => {
  const r = evaluateDoneTransition({ prRef: { merged: true, deployed: false, checked: false }, notes: '' });
  assert.equal(r.allowed, false);
  assert.equal(r.verdict, VERDICTS.BLOCKED_NO_EVIDENCE);
  assert.match(r.reason, /not merged\+deployed\+checked/);
  assert.match(r.reason, /deployed=false/);
});

test('BLOCKS: PR merged and deployed but the post-deploy check never ran', () => {
  const r = evaluateDoneTransition({ prRef: { merged: true, deployed: true, checked: false }, notes: '' });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /checked=false/);
});

test('BLOCKS: notes contain prose acceptance criteria with no runnable command', () => {
  const notes = '## Acceptance criteria\n- The owner agrees this reads better.';
  const r = evaluateDoneTransition({ prRef: null, notes });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /no acceptance criteria found|names no runnable command/);
});

test('BLOCKS: notes carry a command that fails safe-form validation (mutating script)', () => {
  const notes = '## Acceptance criteria\n- run `node scripts/rebuild-all-reviews.js` and check the diff';
  const r = evaluateDoneTransition({ prRef: null, notes });
  assert.equal(r.allowed, false);
});

test('ALLOWS (code path): PR recorded merged + deployed + checked', () => {
  const r = evaluateDoneTransition({ prRef: { merged: true, deployed: true, checked: true }, notes: '' });
  assert.equal(r.allowed, true);
  assert.equal(r.verdict, VERDICTS.PR_MERGED_DEPLOYED_CHECKED);
  assert.equal(r.cmd, null);
});

test('ALLOWS (ops path): notes carry a safe-form verification command', () => {
  const notes = `## Acceptance criteria\n- \`node --test tests/unit/done-semantics-gate.test.mjs\` passes`;
  const r = evaluateDoneTransition({ prRef: null, notes });
  assert.equal(r.allowed, true);
  assert.equal(r.verdict, VERDICTS.VERIFY_CMD_RECORDED);
  assert.equal(r.cmd, 'node --test tests/unit/done-semantics-gate.test.mjs');
});

test('ALLOWS (ops path) even when a PR reference exists but is incomplete, as long as a verify command is present', () => {
  const notes = `## Acceptance criteria\n- \`npx tsc --noEmit\``;
  const r = evaluateDoneTransition({ prRef: { merged: true, deployed: false, checked: false }, notes });
  assert.equal(r.allowed, true);
  assert.equal(r.verdict, VERDICTS.VERIFY_CMD_RECORDED);
});

test('a bare owner-judgment marker alone (no command) does NOT satisfy this gate — Phase 2 is stricter than dispatch arming', () => {
  const notes = `## Problem\nEmail Matt about cross-promo.\n\nVERIFY: owner-judgment`;
  const r = evaluateDoneTransition({ prRef: null, notes });
  assert.equal(r.allowed, false, 'owner-judgment arms dispatch (verify-gate.js) but is not done-evidence — no artifact was actually checked');
});

test('isMergedDeployedChecked is false for any partial or missing shape', () => {
  assert.equal(isMergedDeployedChecked(null), false);
  assert.equal(isMergedDeployedChecked(undefined), false);
  assert.equal(isMergedDeployedChecked({}), false);
  assert.equal(isMergedDeployedChecked({ merged: true }), false);
  assert.equal(isMergedDeployedChecked({ merged: true, deployed: true }), false);
  assert.equal(isMergedDeployedChecked({ merged: true, deployed: true, checked: true }), true);
  assert.equal(isMergedDeployedChecked({ merged: 'true', deployed: true, checked: true }), false, 'truthy non-boolean must not satisfy this — only an explicit true counts as recorded evidence');
});
