// predispatch-guard.test.mjs — one case per numbered failure mode from
// Notion 3c0637c5-416f-8165 (task #1794), the recurring-bug history of the
// scratchpad predispatch-check.sh/pd_meta.py/pd_cmd.py trio this module
// replaces:
//   1. fleet-probe grep self-matched its own argv
//   2. notion-brain.js `search` truncates notes ~1690 chars — must use `get`
//   3. a 'Not started' card whose notes open PARKED: was treated as OK
//   4. the acceptance-command regex missed multi-file `node --test a b`
//   5. Done/Paused cards need a REOPEN-SUSPECT verdict, not silent OK/skip
//   6. the Notion-URL uuid extractor broke on a slug containing an underscore
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { classifyCandidate, resolveNotionUuid, REVIEW_STATUSES, predispatchGuard } = require('./predispatch-guard.js');

const MODULE_PATH = fileURLToPath(new URL('./predispatch-guard.js', import.meta.url));

// ── failure mode 1: fleet-probe self-match ─────────────────────────────────
// The old scratchpad tool shelled out to `ps`/`grep` to check for another
// live crown session and matched its own argv/its own grep invocation row.
// This module's fix is structural, not a smarter filter: it never shells out
// to a process list at all. Assert that directly against the source, so a
// future edit that reintroduces a child_process-based fleet probe here fails
// this test instead of silently reintroducing the bug class.
test('failure mode 1: module never shells out to a process list (structural fix)', () => {
  const src = readFileSync(MODULE_PATH, 'utf8');
  assert.ok(!/require\(\s*['"]child_process['"]\s*\)/.test(src), 'must not require child_process');
  assert.ok(!/\bexecSync\b|\bspawnSync\b|\bexecFileSync\b/.test(src), 'must not shell out at all');
});

// ── failure mode 2: must resolve via get, not search (structural) ──────────
// notion-brain.js `search` truncates notes ~1690 chars, silently dropping
// '## Acceptance criteria'. classifyCandidate must still find the acceptance
// command when the FULL (untruncated) notes are supplied — proving its
// correctness doesn't depend on where the notes came from, and documenting
// why the CLI wrapper must always call `get <uuid>`, never `search`.
test('failure mode 2: finds acceptance command in full-length notes past the search-truncation point', () => {
  const filler = 'Context paragraph explaining background and history. '.repeat(60); // > 1690 chars
  assert.ok(filler.length > 1690, 'fixture must exceed the search-truncation length to be meaningful');
  const notes = `## Problem\n${filler}\n\n## Acceptance criteria\n\`node --test scripts/lib/predispatch-guard.test.mjs\` passes.`;
  const result = classifyCandidate({ card: { name: 'Long card', status: 'Not started', notes } });
  assert.equal(result.verdict, 'CHECK-FIRST');
  assert.equal(result.acceptanceCommand, 'node --test scripts/lib/predispatch-guard.test.mjs');
});

// ── failure mode 3: PARKED marker overrides status ──────────────────────────
test('failure mode 3: PARKED: notes override a Not started status', () => {
  const result = classifyCandidate({
    card: { name: 'Parked card', status: 'Not started', notes: 'PARKED: waiting on owner decision about market scope.' },
  });
  assert.equal(result.verdict, 'DO-NOT-DISPATCH');
  assert.ok(result.flags.includes('parked-marker-in-notes'));
});

// ── failure mode 4: multi-file `node --test` acceptance command ────────────
test('failure mode 4: extracts a multi-file node --test acceptance command', () => {
  const notes = '## Acceptance criteria\n`node --test tests/unit/a.test.mjs tests/unit/b.test.mjs` passes.';
  const result = classifyCandidate({ card: { name: 'Multi-file card', status: 'In progress', notes } });
  assert.equal(result.verdict, 'CHECK-FIRST');
  assert.equal(result.acceptanceCommand, 'node --test tests/unit/a.test.mjs tests/unit/b.test.mjs');
});

test('OK-TO-DISPATCH when notes name no runnable acceptance command', () => {
  const result = classifyCandidate({ card: { name: 'Prose-only card', status: 'Not started', notes: '## Acceptance criteria\nLooks right on the live site.' } });
  assert.equal(result.verdict, 'OK-TO-DISPATCH');
});

// ── failure mode 5: REOPEN-SUSPECT vs plain DO-NOT-DISPATCH ────────────────
test('failure mode 5: Done card with completedDate + long outcome + sha is REOPEN-SUSPECT', () => {
  const result = classifyCandidate({
    card: {
      name: 'Finished card',
      status: 'Done',
      notes: '## Problem\nSomething.\n## Acceptance criteria\nShip it.',
      completedDate: '2026-08-10',
      outcome: 'Fixed the underlying race condition in the push retry loop and verified with a 20x repeat run. Landed at commit a1b2c3d4e5f.',
    },
  });
  assert.equal(result.verdict, 'REOPEN-SUSPECT');
  assert.ok(result.flags.includes('completed-with-outcome-and-sha'));
});

// ── #1798 regression: the falsely-reopened case, status 'Not started' ──────
// This is the case the REOPEN-SUSPECT check exists to catch: a card falsely
// reopened by reconcile-dead-completions (status flipped back to 'Not
// started') while still carrying completedDate + a substantial outcome + a
// git sha from when it actually shipped. Gating the check inside the
// REVIEW_STATUSES branch made it unreachable for this exact case — it only
// ever fired for cards that were ALREADY terminal, which the next line would
// have caught anyway.
test('#1798 regression: Not started card with completedDate + long outcome + sha is REOPEN-SUSPECT', () => {
  const result = classifyCandidate({
    card: {
      name: 'Falsely reopened card',
      status: 'Not started',
      notes: '## Problem\nSomething.\n## Acceptance criteria\nShip it.',
      completedDate: '2026-08-18',
      outcome: 'Fixed the underlying race condition in the push retry loop and verified with a 20x repeat run. Landed at commit 4d721c8000d.',
    },
  });
  assert.equal(result.verdict, 'REOPEN-SUSPECT');
  assert.ok(result.flags.includes('completed-with-outcome-and-sha'));
});

test('failure mode 5 (negative): Done card with no outcome/sha is plain DO-NOT-DISPATCH', () => {
  const result = classifyCandidate({ card: { name: 'Old card', status: 'Done', notes: '', completedDate: '2026-01-01', outcome: '' } });
  assert.equal(result.verdict, 'DO-NOT-DISPATCH');
  assert.ok(result.flags.some((f) => f.startsWith('card-status-terminal:')));
});

test('Paused card groups with Done for REOPEN-SUSPECT purposes', () => {
  assert.ok(REVIEW_STATUSES.has('Paused'));
  assert.ok(REVIEW_STATUSES.has('Done'));
  const result = classifyCandidate({ card: { name: 'Paused card', status: 'Paused', notes: '', completedDate: null, outcome: '' } });
  assert.equal(result.verdict, 'DO-NOT-DISPATCH');
});

// ── overlap: PARKED marker must win even on a terminal-status card ─────────
// (second-opinion review, 2026-08-18: no case previously covered the
// intersection of the PARKED check and the REOPEN-SUSPECT branch.)
test('PARKED: in notes wins even when status is also terminal (Done)', () => {
  const result = classifyCandidate({
    card: {
      name: 'Done but reparked',
      status: 'Done',
      notes: 'PARKED: reopened by mistake, owner asked to leave alone.',
      completedDate: '2026-08-10',
      outcome: 'Fixed at commit a1b2c3d4e5f, long outcome text describing the fix in detail here.',
    },
  });
  assert.equal(result.verdict, 'DO-NOT-DISPATCH');
  assert.ok(result.flags.includes('parked-marker-in-notes'));
});

// ── failure mode 6: uuid resolution survives an underscore in the slug ─────
test('failure mode 6: resolveNotionUuid finds the trailing uuid despite an underscore in the slug', () => {
  const url = 'https://app.notion.com/p/P0-marks-HEAD_TRUSTED_CLEAN-false-on-the-audit-3c0637c5416f816589bde7df0ecebe41';
  assert.equal(resolveNotionUuid(url), '3c0637c5416f816589bde7df0ecebe41');
});

test('resolveNotionUuid returns null when no 32-hex run is present', () => {
  assert.equal(resolveNotionUuid('https://app.notion.com/p/no-uuid-here'), null);
  assert.equal(resolveNotionUuid(null), null);
});

test('resolveNotionUuid takes the LAST 32-hex run when more than one appears', () => {
  const text = 'unrelated 00000000000000000000000000000000 text ... real 3c0637c5416f816589bde7df0ecebe41';
  assert.equal(resolveNotionUuid(text), '3c0637c5416f816589bde7df0ecebe41');
});

// ── task #1811: trashed pages (archived/in_trash) keep their Status property
// untouched, so every check above that branches on `status` would otherwise
// wave a trashed card through ────────────────────────────────────────────────
test('classifyCandidate: trashed page + "In progress" status is DO-NOT-DISPATCH', () => {
  const result = classifyCandidate({ card: { status: 'In progress', archived: true } });
  assert.equal(result.verdict, 'DO-NOT-DISPATCH');
  assert.ok(result.flags.includes('card-archived-in-trash'));
});

test('classifyCandidate: trashed page + "Not started" status is DO-NOT-DISPATCH', () => {
  const result = classifyCandidate({ card: { status: 'Not started', archived: true } });
  assert.equal(result.verdict, 'DO-NOT-DISPATCH');
  assert.ok(result.flags.includes('card-archived-in-trash'));
});

test('classifyCandidate: live (non-trashed) "In progress" card is unaffected — OK-TO-DISPATCH', () => {
  const result = classifyCandidate({ card: { status: 'In progress', archived: false, notes: '' } });
  assert.equal(result.verdict, 'OK-TO-DISPATCH');
});

test('classifyCandidate: archived flag absent (real Notion payloads before this fix, or non-formatCard callers) behaves as not-trashed', () => {
  const result = classifyCandidate({ card: { status: 'Not started', notes: '' } });
  assert.equal(result.verdict, 'OK-TO-DISPATCH');
});

test('predispatchGuard: trashed page is refused even with a non-terminal status, names the real cause', () => {
  const err = predispatchGuard({ id: '1811' }, { status: 'In progress', archived: true }, {});
  assert.match(err, /REFUSING to dispatch #1811/);
  assert.match(err, /card-archived-in-trash/);
  assert.match(err, /moved to the trash/);
});

test('predispatchGuard: --allow-closed-card does NOT bypass a trashed-page refusal (needs --allow-reopen-suspect, same as PARKED/REOPEN-SUSPECT)', () => {
  const err = predispatchGuard({ id: '1811' }, { status: 'In progress', archived: true }, { 'allow-closed-card': true });
  assert.match(err, /REFUSING to dispatch #1811/);
});

test('predispatchGuard: --allow-reopen-suspect bypasses a trashed-page refusal', () => {
  assert.equal(predispatchGuard({ id: '1811' }, { status: 'In progress', archived: true }, { 'allow-reopen-suspect': true }), null);
});

// ── input validation ────────────────────────────────────────────────────────
test('classifyCandidate throws on a missing/malformed card', () => {
  assert.throws(() => classifyCandidate({}), TypeError);
  assert.throws(() => classifyCandidate({ card: null }), TypeError);
});

// ── predispatchGuard (task #1800: the dispatch-path caller) ────────────────
// classifyCandidate itself is unchanged by task #1800 — these cover the new
// wrapper's own refusal/bypass contract, independent of bsc-next.js wiring
// (that integration is covered separately in bsc-next.test.mjs).
const REOPEN_SUSPECT_CARD = { status: 'Not started', completedDate: '2026-08-14', outcome: 'A'.repeat(50) + ' commit 4ab855fc30f' };
const PARKED_CARD = { status: 'Not started', notes: 'PARKED: waiting on owner' };
const OK_CARD = { status: 'Not started', notes: 'do the thing' };
const TASK = { id: '999', subject: 'test task' };

test('predispatchGuard: refuses a REOPEN-SUSPECT card', () => {
  const err = predispatchGuard(TASK, REOPEN_SUSPECT_CARD, {});
  assert.match(err, /REFUSING to dispatch #999/);
  assert.match(err, /REOPEN-SUSPECT/);
  assert.match(err, /--allow-reopen-suspect/);
});

test('predispatchGuard: refuses a PARKED-marker card (DO-NOT-DISPATCH)', () => {
  const err = predispatchGuard(TASK, PARKED_CARD, {});
  assert.match(err, /REFUSING to dispatch #999/);
  assert.match(err, /DO-NOT-DISPATCH/);
});

test('predispatchGuard: silent for an OK-TO-DISPATCH card', () => {
  assert.equal(predispatchGuard(TASK, OK_CARD, {}), null);
});

test('predispatchGuard: silent for a CHECK-FIRST card (advisory only, matches predispatch-check.js exit-code contract)', () => {
  const card = { status: 'Not started', notes: '## Acceptance criteria\n`node --test scripts/foo.test.mjs`' };
  const result = classifyCandidate({ card, task: TASK });
  assert.equal(result.verdict, 'CHECK-FIRST');
  assert.equal(predispatchGuard(TASK, card, {}), null);
});

test('predispatchGuard: card == null (degraded fetch) is an honest unknown, never a refusal', () => {
  assert.equal(predispatchGuard(TASK, null, {}), null);
});

test('predispatchGuard: --allow-reopen-suspect bypasses a REOPEN-SUSPECT refusal', () => {
  assert.equal(predispatchGuard(TASK, REOPEN_SUSPECT_CARD, { 'allow-reopen-suspect': true }), null);
});

test('predispatchGuard: --allow-reopen-suspect bypasses a PARKED-marker refusal too', () => {
  assert.equal(predispatchGuard(TASK, PARKED_CARD, { 'allow-reopen-suspect': true }), null);
});

test('predispatchGuard: --dry-run / --print-prompt bypass even a REOPEN-SUSPECT card (no side effects to gate)', () => {
  assert.equal(predispatchGuard(TASK, REOPEN_SUSPECT_CARD, { 'dry-run': true }), null);
  assert.equal(predispatchGuard(TASK, REOPEN_SUSPECT_CARD, { 'print-prompt': true }), null);
});

test('predispatchGuard: --force does NOT bypass — same philosophy as closedCardGuard\'s --allow-closed-card, not the general-purpose flag', () => {
  const err = predispatchGuard(TASK, REOPEN_SUSPECT_CARD, { force: true });
  assert.match(err, /REFUSING to dispatch #999/);
});

// ── --allow-closed-card overlap (regression coverage: this shipped broken —
// see git history for the fix — --allow-closed-card must ALSO cover the
// plain-terminal-status DO-NOT-DISPATCH case, since that is the exact same
// refusal class closedCardGuard already gates behind that flag. A caller who
// already typed --allow-closed-card must not be asked for a second flag.) ──
test('predispatchGuard: --allow-closed-card bypasses a plain terminal-status (Done) DO-NOT-DISPATCH', () => {
  const card = { status: 'Done' };
  const result = classifyCandidate({ card, task: TASK });
  assert.equal(result.verdict, 'DO-NOT-DISPATCH');
  assert.equal(predispatchGuard(TASK, card, { 'allow-closed-card': true }), null);
});

test('predispatchGuard: --allow-closed-card does NOT bypass a PARKED-marker refusal (different refusal class)', () => {
  const err = predispatchGuard(TASK, PARKED_CARD, { 'allow-closed-card': true });
  assert.match(err, /REFUSING to dispatch #999/);
});

test('predispatchGuard: --allow-closed-card does NOT bypass a REOPEN-SUSPECT refusal (different refusal class)', () => {
  const err = predispatchGuard(TASK, REOPEN_SUSPECT_CARD, { 'allow-closed-card': true });
  assert.match(err, /REFUSING to dispatch #999/);
});

test('predispatchGuard: --allow-closed-card does NOT bypass a Paused-status DO-NOT-DISPATCH (closedCardGuard never treats Paused as closed either)', () => {
  const card = { status: 'Paused' };
  const result = classifyCandidate({ card, task: TASK });
  assert.equal(result.verdict, 'DO-NOT-DISPATCH');
  const err = predispatchGuard(TASK, card, { 'allow-closed-card': true });
  assert.match(err, /REFUSING to dispatch #999/);
});
