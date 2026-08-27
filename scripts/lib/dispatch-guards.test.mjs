// dispatch-guards.test.mjs — direct unit coverage for closedCardGuard's
// trashed-page check (task #1811). closedCardGuard had no colocated test
// file before this — it was only exercised indirectly through
// bsc-next.test.mjs's runSuccessionDispatch harness, which is the right
// place for wiring coverage but the wrong place for the guard's own pure
// decision logic. This file covers that logic directly, matching the
// colocated-test pattern predispatch-guard.test.mjs already establishes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { closedCardGuard, dispatchClaimGuard } = require('./dispatch-guards.js');
// BRO-2488: marketingProjectGuard lives in linear-dispatch.js, not this
// file's GUARD_NAMES family — it's issue-shaped (needs issue.project), and
// predispatch-queue-audit.js's runGuard() only ever simulates GUARD_NAMES
// members against a task-shaped {id, subject, description} object (a
// Notion-mirror task has no .project), so adding it there would report 100%
// "error" forever instead of ever actually firing. Same precedent
// checkTerminalStateGuard already set for a Linear-only issue-shaped guard.
// Required directly here (not just in linear-dispatch.test.mjs) because
// BRO-2488's own acceptance criteria is `node --test
// scripts/lib/dispatch-guards.test.mjs` proving this is no longer invisible
// to the dispatch funnel.
const { marketingProjectGuard } = require('./linear-dispatch.js');

const TASK = { id: '1811', subject: 'test task', status: 'in_progress' };

// ── behaviour table (task #1811 acceptance criteria) ───────────────────────
test('closedCardGuard: trashed page + "In progress" status is REFUSED', () => {
  const err = closedCardGuard(TASK, { status: 'In progress', archived: true }, {});
  assert.match(err, /REFUSING to dispatch #1811/);
  assert.match(err, /TRASH/);
});

test('closedCardGuard: trashed page + "Not started" status is REFUSED', () => {
  const err = closedCardGuard(TASK, { status: 'Not started', archived: true }, {});
  assert.match(err, /REFUSING to dispatch #1811/);
  assert.match(err, /TRASH/);
});

test('closedCardGuard: live page + "In progress" status is ALLOWED', () => {
  assert.equal(closedCardGuard(TASK, { status: 'In progress', archived: false }, {}), null);
});

test('closedCardGuard: live page + "Not started" status is ALLOWED', () => {
  assert.equal(closedCardGuard(TASK, { status: 'Not started', archived: false }, {}), null);
});

test('closedCardGuard: "Done" status (not trashed) is still REFUSED — existing behavior preserved', () => {
  const err = closedCardGuard(TASK, { status: 'Done', archived: false }, {});
  assert.match(err, /REFUSING to dispatch #1811/);
  assert.match(err, /already Done/);
});

test('closedCardGuard: card == null (degraded fetch) is ALLOWED — never livelocks the stall sweep', () => {
  assert.equal(closedCardGuard(TASK, null, {}), null);
});

// ── archived flag absent (pre-fix payloads, or any caller bypassing formatCard) ──
test('closedCardGuard: archived flag absent behaves as not-trashed (falsy, no throw)', () => {
  assert.equal(closedCardGuard(TASK, { status: 'In progress' }, {}), null);
});

// ── bypass flags ─────────────────────────────────────────────────────────────
test('closedCardGuard: --allow-closed-card bypasses a trashed-page refusal too (same top-level bypass as any closed card)', () => {
  assert.equal(closedCardGuard(TASK, { status: 'In progress', archived: true }, { 'allow-closed-card': true }), null);
});

test('closedCardGuard: --dry-run / --print-prompt bypass a trashed-page refusal', () => {
  assert.equal(closedCardGuard(TASK, { status: 'In progress', archived: true }, { 'dry-run': true }), null);
  assert.equal(closedCardGuard(TASK, { status: 'In progress', archived: true }, { 'print-prompt': true }), null);
});

// Adversarial review (codex, task #1811): --allow-closed-card only bypasses
// closedCardGuard — predispatch-guard.js's classifyCandidate runs its own
// independent archived check right after and refuses it unless
// --allow-reopen-suspect is ALSO set (card-archived-in-trash never matches
// the `card-status-terminal:${status}` pattern predispatchGuard's
// --allow-closed-card carve-out looks for). A real dispatch onto a trashed
// card therefore needs BOTH flags — this is the same shape a Done+PARKED
// card already required pre-#1811 (closedCardGuard's --allow-closed-card
// clears the status check, but classifyCandidate's parked-marker branch
// still needs --allow-reopen-suspect too), not a new inconsistency. The
// refusal text must say so, since a reader who follows closedCardGuard's
// suggestion literally and adds only --allow-closed-card would otherwise
// hit a second, differently-worded refusal from predispatch-guard.js.
test('closedCardGuard: trashed-page refusal message tells the reader --allow-closed-card alone will not be enough', () => {
  const err = closedCardGuard(TASK, { status: 'In progress', archived: true }, {});
  assert.match(err, /--allow-reopen-suspect/);
});

// ── dispatchClaimGuard (task #1896) ─────────────────────────────────────────
// Pure: the actual acquireClaim() mkdir/EEXIST I/O is scripts/lib/atomic-
// claim.js's job (covered in scripts/lib/dispatch-overlap-check.test.mjs's
// race-simulation cases); this only checks how a claim RESULT becomes a
// refusal (or not).
test('dispatchClaimGuard: claimResult === true is silent (this attempt won the claim)', () => {
  assert.equal(dispatchClaimGuard(TASK, true, {}), null);
});

test('dispatchClaimGuard: claimResult === false (genuinely held elsewhere) refuses, naming the mirror-staleness race', () => {
  const err = dispatchClaimGuard(TASK, false, {});
  assert.match(err, /REFUSING to dispatch #1811/);
  assert.match(err, /mirror-staleness race/);
  assert.match(err, /--force/);
});

test('dispatchClaimGuard: claimResult === \'error\' (unreadable claim meta) fails closed with a distinct message', () => {
  const err = dispatchClaimGuard(TASK, 'error', {});
  assert.match(err, /REFUSING to dispatch #1811/);
  assert.match(err, /claim dir unreadable\/corrupt/);
});

test('dispatchClaimGuard: --force / --dry-run / --print-prompt all bypass it, even on a held claim', () => {
  assert.equal(dispatchClaimGuard(TASK, false, { force: true }), null);
  assert.equal(dispatchClaimGuard(TASK, false, { 'dry-run': true }), null);
  assert.equal(dispatchClaimGuard(TASK, false, { 'print-prompt': true }), null);
  assert.equal(dispatchClaimGuard(TASK, 'error', { force: true }), null);
});

// ── marketingProjectGuard (BRO-2488) ────────────────────────────────────────
// The documented dispatch funnel is "Backlog/Todo, not `· Marketing`, not BSC
// Daily/CANARY" — but no query linear-next.js used ever fetched an issue's
// Linear `project` relation, so the exclusion was invisible to every
// dispatcher. Confirmed live: BRO-128 (project "Marketing/distribution")
// dispatched cleanly via `linear-next.js --id BRO-128 --headless` with no
// refusal. This case fails against that pre-fix behaviour (issue.project
// undefined => guard always returns null => never refuses anything).
test('marketingProjectGuard: a Marketing/distribution-project issue is REFUSED', () => {
  const issue = { identifier: 'BRO-128', project: { name: 'Marketing/distribution' } };
  const err = marketingProjectGuard(issue, {});
  assert.match(err, /BRO-128/);
  assert.match(err, /Marketing\/distribution/);
  assert.match(err, /--force/);
});

test('marketingProjectGuard: an issue with no project (or a non-Marketing project) is ALLOWED', () => {
  assert.equal(marketingProjectGuard({ identifier: 'BRO-1' }, {}), null);
  assert.equal(marketingProjectGuard({ identifier: 'BRO-2', project: { name: 'Infrastructure' } }, {}), null);
});

test('marketingProjectGuard: --force bypasses the refusal', () => {
  const issue = { identifier: 'BRO-128', project: { name: 'Marketing/distribution' } };
  assert.equal(marketingProjectGuard(issue, { force: true }), null);
});
