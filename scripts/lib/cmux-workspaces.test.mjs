import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseWorkspaces, isDoneTitle, hasRunningClaude, hasLiveClaude, hasPaneRow, isNotFoundError } = require('./cmux-workspaces.js');

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

// Captured from `cmux list-panes --workspace <ref>` (2026-07-26)
test('hasPaneRow: detects a pane row; empty/no-pane output is not alive', () => {
  assert.equal(hasPaneRow('* pane:107  [1 surface]  [focused]'), true);
  assert.equal(hasPaneRow(''), false);
  assert.equal(hasPaneRow('no panes here'), false);
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
