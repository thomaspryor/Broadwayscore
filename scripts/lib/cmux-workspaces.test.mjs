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

test('pruneDone: skips waiting-at-prompt tabs; closes only dead ones; throw = alive', () => {
  const cw = require('./cmux-workspaces.js');
  const calls = [];
  const { closed, skipped } = cw.pruneDone({
    listWorkspaces: () => [
      { ref: 'workspace:1', title: '✅ waiting tab' },
      { ref: 'workspace:2', title: '✅ dead tab' },
      { ref: 'workspace:3', title: '✅ cmux-error tab' },
      { ref: 'workspace:4', title: 'unmarked live tab' },
    ],
    claudeAliveIn: ref => {
      if (ref === 'workspace:1') return true;             // waiting at prompt
      if (ref === 'workspace:2') return false;            // truly dead
      throw new Error('socket busy');                     // transient error
    },
    // Second signal also confirms dead — isolates this test to the primary
    // (claudeAliveIn) seam; the #559 disagreement case gets its own test below.
    terminalSurfaceAliveIn: () => false,
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
      { ref: 'workspace:1', title: '✅ desynced tab (primary says dead, surface says alive)' },
      { ref: 'workspace:2', title: '✅ truly dead tab (both signals agree)' },
    ],
    claudeAliveIn: () => false, // primary registry: both look dead
    terminalSurfaceAliveIn: ref => ref === 'workspace:1', // surface registry disagrees on workspace:1
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

test('pruneDone: non-🤖 ✅ tab with live claude stays skipped (owner-driven protection unchanged), and claudeMidTurnIn is never called', () => {
  const cw = require('./cmux-workspaces.js');
  const calls = [];
  const { closed, skipped } = cw.pruneDone({
    listWorkspaces: () => [{ ref: 'workspace:1', title: '✅ Redesign show pages' }],
    claudeAliveIn: () => true,
    terminalSurfaceAliveIn: () => true,
    claudeMidTurnIn: () => { throw new Error('must not be called for non-auto titles'); },
    closeWorkspace: ref => calls.push(ref),
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(closed, []);
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
