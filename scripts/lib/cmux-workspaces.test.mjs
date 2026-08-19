import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseWorkspaces, isDoneTitle, hasRunningClaude, hasLiveClaude, hasClaudeChrome, isNotFoundError } = require('./cmux-workspaces.js');

// Captured from `cmux list-workspaces` 2026-07-12 (cmux 0.64.6)
const LIST_SAMPLE = `  workspace:2  ⠂ Box office card improvements
  workspace:36  Autonomous loop — Sprint 2
* workspace:31  Build: Autonomous nightly loop (v4) — 5 sprints  [selected]
  workspace:39  wrap-up skill: DEFERRED items should dispatch via
  workspace:27  ✳ CC improvements
  workspace:15  ✅ Backup check
`;

test('parseWorkspaces extracts ref, title, selected from real output', () => {
  const ws = parseWorkspaces(LIST_SAMPLE);
  assert.equal(ws.length, 6);
  assert.deepEqual(ws[0], { ref: 'workspace:2', title: '⠂ Box office card improvements', selected: false });
  assert.equal(ws[2].ref, 'workspace:31');
  assert.equal(ws[2].selected, true);
  assert.equal(ws[2].title, 'Build: Autonomous nightly loop (v4) — 5 sprints');
  assert.equal(ws[5].title, '✅ Backup check');
});

test('parseWorkspaces ignores non-workspace lines', () => {
  assert.deepEqual(parseWorkspaces('no workspaces\n\n'), []);
});

test('isDoneTitle: leading ✅ (with or without activity glyph) is done', () => {
  assert.equal(isDoneTitle('✅ Backup check'), true);
  assert.equal(isDoneTitle('⠂ ✅ finished thing'), true);   // spinner prefix from cmux
  assert.equal(isDoneTitle('✳ ✅ done'), true);
});

test('isDoneTitle: un-marked and mid-title ✅ are NOT done', () => {
  assert.equal(isDoneTitle('Build: Autonomous nightly loop'), false);
  assert.equal(isDoneTitle('⠂ Box office card improvements'), false);
  assert.equal(isDoneTitle('Fix the ✅ checkmark rendering bug'), false);
});

// Captured from `cmux top --workspace workspace:39 --processes --format tsv`
const TOP_RUNNING = `5.9\t532185088\t11\tworkspace\tworkspace:39\twindow:1\twrap-up skill
5.8\t527663104\t7\ttag\tworkspace:366F394E:tag:claude_code\tworkspace:39\tRunning
5.8\t432324608\t1\tprocess\t22146\tworkspace:366F394E:tag:claude_code\t2.1.207`;

const TOP_IDLE = `0.1\t5321850\t2\tworkspace\tworkspace:12\twindow:1\tRedesign show pages
0.0\t2605056\t1\tprocess\t47468\tworkspace:12\tzsh`;

test('hasRunningClaude: detects the claude_code Running tag row', () => {
  assert.equal(hasRunningClaude(TOP_RUNNING), true);
  assert.equal(hasRunningClaude(TOP_IDLE), false);
  assert.equal(hasRunningClaude(''), false);
});

// Captured from `cmux top --workspace workspace:194 --processes --format tsv`
// 2026-07-21 (cmux 0.64.17): a claude WAITING at the prompt — tag row present,
// status column empty. This is the shape prune wrongly closed as "idle".
const TOP_WAITING = `2.7\t955809792\t6\tworkspace\tworkspace:194\twindow:1\tData·iOS design proposals
2.7\t944504832\t3\ttag\tworkspace:CD32EC51-13AE-49DF-9921-4FF9F8382FB0:tag:claude_code\tworkspace:194\t
2.7\t570261504\t1\tprocess\t78491\tworkspace:CD32EC51-13AE-49DF-9921-4FF9F8382FB0:tag:claude_code\t2.1.216`;

test('hasLiveClaude: waiting-at-prompt claude (no status) counts as LIVE', () => {
  assert.equal(hasLiveClaude(TOP_WAITING), true);
  // 2026-07-21 incident guard: the Running-only check must NOT treat it as
  // running — the two predicates intentionally diverge on this shape, and
  // pruneDone must use the live one.
  assert.equal(hasRunningClaude(TOP_WAITING), false);
});

test('hasLiveClaude: running claude is live; dead workspace is not', () => {
  assert.equal(hasLiveClaude(TOP_RUNNING), true);
  assert.equal(hasLiveClaude(TOP_IDLE), false);
  assert.equal(hasLiveClaude(''), false);
});

test('hasLiveClaude: column-exact — title mentioning claude_code is not a tag row', () => {
  const titleTrap = `5.9\t1\t2\tworkspace\tworkspace:9\twindow:1\tRunning tag:claude_code experiments`;
  assert.equal(hasLiveClaude(titleTrap), false);
});

test('hasLiveClaude: stale tag row with NO process rows is NOT live (prunable)', () => {
  // Hypothetical crash leftover: tag survives, processes gone. Prune must
  // still be able to sweep it (codex ship-check finding, 2026-07-21).
  const staleTag = `2.7\t1\t0\ttag\tworkspace:X:tag:claude_code\tworkspace:9\t`;
  assert.equal(hasLiveClaude(staleTag), false);
});

test('hasLiveClaude: other agents (codex tag) do not count as a live claude', () => {
  const codexOnly = `2.7\t1\t1\ttag\tworkspace:X:tag:codex\tworkspace:9\t
2.7\t1\t1\tprocess\t123\tworkspace:X:tag:codex\tcodex`;
  assert.equal(hasLiveClaude(codexOnly), false);
});

test('pruneDone: skips mid-turn tabs; closes only dead ones; throw = alive', () => {
  const cw = require('./cmux-workspaces.js');
  const calls = [];
  const { closed, skipped } = cw.pruneDone({
    listWorkspaces: () => [
      { ref: 'workspace:1', title: '✅ 🤖 waiting tab' },
      { ref: 'workspace:2', title: '✅ 🤖 dead tab' },
      { ref: 'workspace:3', title: '✅ 🤖 cmux-error tab' },
      { ref: 'workspace:4', title: 'unmarked live tab' },
    ],
    claudeAliveIn: ref => {
      if (ref === 'workspace:1') return true;             // live
      if (ref === 'workspace:2') return false;            // truly dead
      throw new Error('socket busy');                     // transient error
    },
    // Second signal also confirms dead — isolates this test to the primary
    // (claudeAliveIn) seam; the #559 disagreement case gets its own test below.
    terminalSurfaceAliveIn: () => false,
    claudeMidTurnIn: () => true, // workspace:1 is mid-turn → protected
    closeWorkspace: ref => calls.push(ref),
  });
  assert.deepEqual(calls, ['workspace:2']);
  assert.deepEqual(closed.map(w => w.ref), ['workspace:2']);
  // the throw path must NOT close: seam throws → pruneDone must treat as alive
  assert.deepEqual(skipped.map(w => w.ref).sort(), ['workspace:1', 'workspace:3']);
});

// Card #559: claudeAliveIn queries only cmux's tag/process registry. Card
// #548 proved that registry can desync from cmux's separate terminal-surface
// registry (list-panes/capture-pane/read-screen). #548 was the desync
// showing up as a false POSITIVE on the launch-verify path; this is the same
// desync on the close path, in the opposite (and more dangerous) direction —
// the tag registry falsely reports "dead" while the surface registry (and
// possibly a human) says the workspace is still there. pruneDone must not
// close on the primary signal alone.
test('pruneDone: does NOT close when the second independent signal says alive, even though claudeAliveIn alone said not-alive', () => {
  const cw = require('./cmux-workspaces.js');
  const calls = [];
  const { closed, skipped } = cw.pruneDone({
    listWorkspaces: () => [
      { ref: 'workspace:1', title: '✅ 🤖 desynced tab (primary says dead, surface says alive)' },
      { ref: 'workspace:2', title: '✅ 🤖 truly dead tab (both signals agree)' },
    ],
    claudeAliveIn: () => false, // primary registry: both look dead
    terminalSurfaceAliveIn: ref => ref === 'workspace:1', // surface registry disagrees on workspace:1
    // Seam added 2026-08-09. Without it this test read the REAL cmux socket for
    // the fake refs below, so its result depended on whether cmux was installed:
    // on CI (no cmux) claudeMidTurnIn throws and pruneDone's documented
    // "any error defaults isRunning to true" fail-safe skipped workspace:1 —
    // the behaviour under test. On a developer machine with cmux running it
    // returned false for the nonexistent ref, workspace:1 read as live-and-idle,
    // and pruneDone closed it, failing the assertion for an environmental
    // reason. Injecting the throw pins the fail-safe path explicitly and makes
    // the test deterministic in both environments; the assertions are unchanged.
    claudeMidTurnIn: () => { throw new Error('no cmux socket'); },
    closeWorkspace: ref => calls.push(ref),
  });
  assert.deepEqual(calls, ['workspace:2']);
  assert.deepEqual(closed.map(w => w.ref), ['workspace:2']);
  assert.deepEqual(skipped.map(w => w.ref), ['workspace:1']);
});

// Captured from `cmux read-screen --workspace <ref>` on 4 different LIVE
// workspaces, 2026-07-26 — the persistent status bar Claude Code renders
// for the whole session (model glyph + ctx% + branch + repo).
const SCREEN_ALIVE_BYPASS = `
────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────
  🔮 OPUS │ ctx 54% │ main │ Broadwayscore
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
`;
const SCREEN_ALIVE_UNANSWERED = `
  🔮 OPUS │ ctx ? │ main │ Broadwayscore
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`;
const SCREEN_DEAD_BARE_SHELL = `
tompryor@Mac-Studio Broadwayscore %
`;
// Captured live, 2026-07-26: cmux inserts a "⚠" high-context warning glyph
// BEFORE the "│" once ctx crosses ~75% — 3 of 18 real workspaces on this
// machine had this shape. An earlier regex version required "│" to
// immediately follow the percentage and false-negatived on all 3 (caught by
// a second-pass adversarial review). Anchoring on the separator BEFORE "ctx"
// instead (stable across all samples) fixes it.
const SCREEN_ALIVE_HIGH_CTX_WARNING = `
  🔮 OPUS │ ctx 89%⚠ │ r2-cold-backup-setup │ buffer-token-leak-cleanup
  ⏵⏵ bypass permissions on
`;
// "ctx" as the LAST status-bar field (no trailing "│ branch │ repo") — also
// observed live.
const SCREEN_ALIVE_CTX_LAST_FIELD = `
  🔮 OPUS │ ctx 8%
`;

test('hasClaudeChrome: detects the persistent ctx status bar; a bare shell prompt is not alive', () => {
  assert.equal(hasClaudeChrome(SCREEN_ALIVE_BYPASS), true);
  assert.equal(hasClaudeChrome(SCREEN_ALIVE_UNANSWERED), true); // "ctx ?" before first response
  assert.equal(hasClaudeChrome(SCREEN_ALIVE_HIGH_CTX_WARNING), true); // "⚠" glyph before the "│"
  assert.equal(hasClaudeChrome(SCREEN_ALIVE_CTX_LAST_FIELD), true); // no trailing "│" at all
  assert.equal(hasClaudeChrome(SCREEN_DEAD_BARE_SHELL), false);
  assert.equal(hasClaudeChrome(''), false);
});

// Verified live against a genuinely closed workspace ref, 2026-07-26:
// `cmux list-panes --workspace workspace:1` -> exit 1,
// stderr "Error: not_found: Workspace not found"
test('isNotFoundError: not_found confirms dead; any other message is uncertainty', () => {
  assert.equal(isNotFoundError('Command failed: ...\nError: not_found: Workspace not found\n'), true);
  assert.equal(isNotFoundError('Error: not_found: Pane or workspace not found'), true);
  assert.equal(isNotFoundError('Command failed: socket timeout'), false);
  assert.equal(isNotFoundError(''), false);
  assert.equal(isNotFoundError(undefined), false);
  // Card #1829: the shape actually thrown by a live cmux for a workspace
  // whose pane never rendered — a DIFFERENT error-type prefix
  // (internal_error, not not_found) with the confirmation only in the
  // message text. The regex above (pre-fix) missed this and made
  // terminalSurfaceAliveIn report "alive" for 7/7 dead cmux-tab dispatches
  // on 2026-08-19 that this exact error came from.
  assert.equal(isNotFoundError('Command failed: cmux read-screen --workspace workspace:866\nError: internal_error: ERROR: Terminal surface not found\n'), true);
  assert.equal(isNotFoundError('internal_error: ERROR: Terminal surface not found'), true);
  assert.equal(isNotFoundError('Error: internal_error: ERROR: Workspace not found'), true);
});

test('pruneDone: second-signal throw = alive (never close on uncertainty from either signal)', () => {
  const cw = require('./cmux-workspaces.js');
  const calls = [];
  const { closed, skipped } = cw.pruneDone({
    listWorkspaces: () => [{ ref: 'workspace:1', title: '✅ surface-check-errors tab' }],
    claudeAliveIn: () => false,
    terminalSurfaceAliveIn: () => { throw new Error('socket busy'); },
    closeWorkspace: ref => calls.push(ref),
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(closed, []);
  assert.deepEqual(skipped.map(w => w.ref), ['workspace:1']);
});

// Card #567: opening-night-monitor-launch.js's claudeAlive computation must
// go through checkLiveness (both signals), not claudeAliveIn alone — same
// registry-desync false-negative class as #559/#564, here feeding
// launchDecision's 'reclaim-and-launch' path (duplicate babysitter launch).
test('computeClaudeAlive: no meta/workspaceRef → not alive', () => {
  const cw = require('./cmux-workspaces.js');
  assert.equal(cw.computeClaudeAlive(null), false);
  assert.equal(cw.computeClaudeAlive({}), false);
});

test('computeClaudeAlive: both signals agree dead → not alive', () => {
  const cw = require('./cmux-workspaces.js');
  const alive = cw.computeClaudeAlive({ workspaceRef: 'workspace:1' }, {
    claudeAliveIn: () => false,
    terminalSurfaceAliveIn: () => false,
  });
  assert.equal(alive, false);
});

test('computeClaudeAlive: primary registry says dead but surface registry says alive → alive (the #559/#564/#567 desync)', () => {
  const cw = require('./cmux-workspaces.js');
  const alive = cw.computeClaudeAlive({ workspaceRef: 'workspace:1' }, {
    claudeAliveIn: () => false,
    terminalSurfaceAliveIn: () => true,
  });
  assert.equal(alive, true, 'a bare claudeAliveIn()-only check would wrongly report not-alive here');
});

test('computeClaudeAlive: primary registry says alive → alive without consulting surface signal', () => {
  const cw = require('./cmux-workspaces.js');
  const alive = cw.computeClaudeAlive({ workspaceRef: 'workspace:1' }, {
    claudeAliveIn: () => true,
    terminalSurfaceAliveIn: () => { throw new Error('should not be called'); },
  });
  assert.equal(alive, true);
});

// Card #709 (owner-approved 2026-07-31): pruneDone integration for the
// auto-dispatch idle-close exception. See scripts/lib/prune-closeable.js
// for the pure predicate these cases exercise.
test('pruneDone: closes ✅🤖 tab idle at the prompt (live claude, not mid-turn)', () => {
  const cw = require('./cmux-workspaces.js');
  const calls = [];
  const { closed, skipped } = cw.pruneDone({
    listWorkspaces: () => [{ ref: 'workspace:1', title: '✅ 🤖⚡ Infra·bsc-prune fix' }],
    claudeAliveIn: () => true, // live (waiting at prompt or running)
    terminalSurfaceAliveIn: () => true,
    claudeMidTurnIn: () => false, // idle at the prompt, not mid-turn
    closeWorkspace: ref => calls.push(ref),
  });
  assert.deepEqual(calls, ['workspace:1']);
  assert.deepEqual(closed.map(w => w.ref), ['workspace:1']);
  assert.deepEqual(skipped, []);
});

// Owner escalation 2026-08-02 (scheduled auto-prune tick): the currently
// SELECTED workspace is never closed, even when every other signal says
// closeable — the owner is often selected on a ✅🤖 tab precisely to read
// its final summary, and yanking it mid-read is the 2026-07-15 "closed
// while typing" incident class. A later tick closes it once focus moves.
test('pruneDone: never closes the selected workspace, even a closeable ✅🤖 idle one', () => {
  const cw = require('./cmux-workspaces.js');
  const calls = [];
  const { closed, skipped } = cw.pruneDone({
    listWorkspaces: () => [
      { ref: 'workspace:1', title: '✅ 🤖⚡ Infra·selected tab', selected: true },
      { ref: 'workspace:2', title: '✅ 🤖⚡ Infra·background tab', selected: false },
    ],
    claudeAliveIn: () => true,
    terminalSurfaceAliveIn: () => true,
    claudeMidTurnIn: () => false, // both idle at the prompt
    closeWorkspace: ref => calls.push(ref),
  });
  assert.deepEqual(calls, ['workspace:2']);
  assert.deepEqual(closed.map(w => w.ref), ['workspace:2']);
  assert.deepEqual(skipped.map(w => w.ref), ['workspace:1']);
});

// TOCTOU guard (adversarial review 2026-08-02): the top-of-sweep selected
// flag is a snapshot; pruneDone must re-list immediately before the
// destructive close and skip a workspace the owner has since clicked into.
test('pruneDone: re-checks selection just before close — a workspace selected mid-sweep is not closed', () => {
  const cw = require('./cmux-workspaces.js');
  const calls = [];
  let listCalls = 0;
  const { closed, skipped } = cw.pruneDone({
    listWorkspaces: () => {
      listCalls++;
      // First listing (sweep start): not selected. Later listings (pre-close
      // re-check): the owner has clicked into it.
      return [{ ref: 'workspace:1', title: '✅ 🤖⚡ Infra·tab', selected: listCalls > 1 }];
    },
    claudeAliveIn: () => true,
    terminalSurfaceAliveIn: () => true,
    claudeMidTurnIn: () => false,
    closeWorkspace: ref => calls.push(ref),
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(closed, []);
  assert.deepEqual(skipped.map(w => w.ref), ['workspace:1']);
});

test('pruneDone: pre-close re-list error = uncertainty = skip, never close', () => {
  const cw = require('./cmux-workspaces.js');
  const calls = [];
  let listCalls = 0;
  const { closed, skipped } = cw.pruneDone({
    listWorkspaces: () => {
      listCalls++;
      if (listCalls > 1) throw new Error('socket busy');
      return [{ ref: 'workspace:1', title: '✅ 🤖⚡ Infra·tab', selected: false }];
    },
    claudeAliveIn: () => true,
    terminalSurfaceAliveIn: () => true,
    claudeMidTurnIn: () => false,
    closeWorkspace: ref => calls.push(ref),
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(skipped.map(w => w.ref), ['workspace:1']);
});

test('pruneDone: skips ✅🤖 tab that is mid-turn (running)', () => {
  const cw = require('./cmux-workspaces.js');
  const calls = [];
  const { closed, skipped } = cw.pruneDone({
    listWorkspaces: () => [{ ref: 'workspace:1', title: '✅ 🤖⚡ Infra·bsc-prune fix' }],
    claudeAliveIn: () => true,
    terminalSurfaceAliveIn: () => true,
    claudeMidTurnIn: () => true, // mid-turn
    closeWorkspace: ref => calls.push(ref),
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(closed, []);
  assert.deepEqual(skipped.map(w => w.ref), ['workspace:1']);
});

// ship-check catch (2026-07-31): a transient cmux error querying mid-turn
// status must fail safe to "busy, don't close" — never silently read as
// "idle" the way the legacy claudeRunningIn helper did (it swallowed errors
// and returned false). This proves pruneDone's own catch treats a throw
// from the seam as isRunning=true.
test('pruneDone: skips ✅🤖 tab when claudeMidTurnIn throws (uncertainty must never look like idle)', () => {
  const cw = require('./cmux-workspaces.js');
  const calls = [];
  const { closed, skipped } = cw.pruneDone({
    listWorkspaces: () => [{ ref: 'workspace:1', title: '✅ 🤖⚡ Infra·bsc-prune fix' }],
    claudeAliveIn: () => true,
    terminalSurfaceAliveIn: () => true,
    claudeMidTurnIn: () => { throw new Error('socket busy'); },
    closeWorkspace: ref => calls.push(ref),
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(closed, []);
  assert.deepEqual(skipped.map(w => w.ref), ['workspace:1']);
});

// Owner rule #3 (2026-08-02, supersedes same-day escalation #2): auto-close
// is limited to 🤖 auto-dispatched tabs. Owner-opened ✅ tabs are never
// closed autonomously — idle, mid-turn, or dead.
test('pruneDone: non-🤖 ✅ tab idle at the prompt is SKIPPED (owner rule 2026-08-02: 🤖-only)', () => {
  const cw = require('./cmux-workspaces.js');
  const calls = [];
  const { closed, skipped } = cw.pruneDone({
    listWorkspaces: () => [{ ref: 'workspace:1', title: '✅ Redesign show pages', selected: false }],
    claudeAliveIn: () => true,
    terminalSurfaceAliveIn: () => true,
    claudeMidTurnIn: () => false,
    closeWorkspace: ref => calls.push(ref),
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(closed, []);
  assert.deepEqual(skipped.map(w => w.ref), ['workspace:1']);
});

test('pruneDone: non-🤖 ✅ tab with a fully DEAD claude is still skipped (owner-opened tabs are hands-off)', () => {
  const cw = require('./cmux-workspaces.js');
  const calls = [];
  const { closed, skipped } = cw.pruneDone({
    listWorkspaces: () => [{ ref: 'workspace:1', title: '✅ Redesign show pages', selected: false }],
    claudeAliveIn: () => false,
    terminalSurfaceAliveIn: () => false,
    closeWorkspace: ref => calls.push(ref),
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(closed, []);
  assert.deepEqual(skipped.map(w => w.ref), ['workspace:1']);
});

test('pruneDone: non-🤖 ✅ tab mid-turn stays skipped', () => {
  const cw = require('./cmux-workspaces.js');
  const calls = [];
  const { closed, skipped } = cw.pruneDone({
    listWorkspaces: () => [{ ref: 'workspace:1', title: '✅ Redesign show pages' }],
    claudeAliveIn: () => true,
    terminalSurfaceAliveIn: () => true,
    claudeMidTurnIn: () => true,
    closeWorkspace: ref => calls.push(ref),
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(skipped.map(w => w.ref), ['workspace:1']);
});

// ── Ledger-trust fallback for a lost 🤖 glyph (card #971) ───────────────────
// A dispatched session that renames its tab mid-work (common: status-
// reflecting renames) drops the 🤖 marker. Before this fix, pruneDone read
// isAutoDispatched from the title alone, so such a tab was misclassified as
// owner-opened and never auto-closed even after it ✅-marked and went
// idle/dead (owner incident 2026-08-03, task #950's workspace). pruneDone
// must now also trust an unreconciled dispatch-ledger launch record.
test('pruneDone: closes a ✅ tab with no 🤖 glyph when the dispatch ledger has an unreconciled launch for its ref', () => {
  const cw = require('./cmux-workspaces.js');
  const calls = [];
  const { closed, skipped } = cw.pruneDone({
    listWorkspaces: () => [{ ref: 'workspace:117', title: '✅⚡ Infra·visual-qa is feature-flag blind' }],
    claudeAliveIn: () => true, // idle at the prompt
    terminalSurfaceAliveIn: () => true,
    claudeMidTurnIn: () => false,
    readLedgerEntries: () => [
      { event: 'launch', taskId: '950', subject: 'visual-qa is feature-flag blind', workspaceRef: 'workspace:117', ts: '2026-08-03T14:41:00.000Z' },
    ],
    closeWorkspace: ref => calls.push(ref),
  });
  assert.deepEqual(calls, ['workspace:117']);
  assert.deepEqual(closed.map(w => w.ref), ['workspace:117']);
  assert.deepEqual(skipped, []);
});

test('pruneDone: a ✅ tab with neither the 🤖 glyph nor a ledger launch stays hands-off', () => {
  const cw = require('./cmux-workspaces.js');
  const calls = [];
  const { closed, skipped } = cw.pruneDone({
    listWorkspaces: () => [{ ref: 'workspace:1', title: '✅ Redesign show pages' }],
    claudeAliveIn: () => true,
    terminalSurfaceAliveIn: () => true,
    claudeMidTurnIn: () => false,
    readLedgerEntries: () => [],
    closeWorkspace: ref => calls.push(ref),
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(closed, []);
  assert.deepEqual(skipped.map(w => w.ref), ['workspace:1']);
});

// Recycled-ref safety (card 3b1637c5): a reconciled (terminal-event-closed)
// launch record must NOT make an unrelated owner-opened tab under the same
// recycled ref closeable.
test('pruneDone: a reconciled ledger launch (terminal event recorded) does not make an un-glyphed ✅ tab closeable', () => {
  const cw = require('./cmux-workspaces.js');
  const calls = [];
  const { closed, skipped } = cw.pruneDone({
    listWorkspaces: () => [{ ref: 'workspace:5', title: '✅ Owner-opened after a ref recycle' }],
    claudeAliveIn: () => true,
    terminalSurfaceAliveIn: () => true,
    claudeMidTurnIn: () => false,
    readLedgerEntries: () => [
      { event: 'launch', taskId: '1', subject: 'old task', workspaceRef: 'workspace:5', ts: '2026-08-01T00:00:00.000Z' },
      { event: 'dead', taskId: '1', workspaceRef: 'workspace:5', ts: '2026-08-01T01:00:00.000Z' },
    ],
    closeWorkspace: ref => calls.push(ref),
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(closed, []);
  assert.deepEqual(skipped.map(w => w.ref), ['workspace:5']);
});

// A ledger read failure must fail closed to title-only detection, never
// throw the whole sweep.
test('pruneDone: a readLedgerEntries failure fails closed (title-only detection, sweep still completes)', () => {
  const cw = require('./cmux-workspaces.js');
  const calls = [];
  const { closed, skipped } = cw.pruneDone({
    listWorkspaces: () => [{ ref: 'workspace:1', title: '✅ Redesign show pages' }],
    claudeAliveIn: () => true,
    terminalSurfaceAliveIn: () => true,
    claudeMidTurnIn: () => false,
    readLedgerEntries: () => { throw new Error('ledger file busy'); },
    closeWorkspace: ref => calls.push(ref),
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(skipped.map(w => w.ref), ['workspace:1']);
});

test('hasRunningClaude: column-exact — no substring false positives', () => {
  // Status other than exactly "Running" on the tag row
  const notRunning = `5.8\t1\t1\ttag\tworkspace:X:tag:claude_code\tworkspace:9\tNotRunning`;
  assert.equal(hasRunningClaude(notRunning), false);
  // Workspace TITLE containing "Running" + claude_code elsewhere in line
  const titleTrap = `5.9\t1\t2\tworkspace\tworkspace:9\twindow:1\tRunning tag:claude_code experiments`;
  assert.equal(hasRunningClaude(titleTrap), false);
  // Trailing whitespace after Running still matches (cmux pads tsv)
  const padded = `5.8\t1\t1\ttag\tworkspace:X:tag:claude_code\tworkspace:9\tRunning\t\t`;
  assert.equal(hasRunningClaude(padded), true);
});
