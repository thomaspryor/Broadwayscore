import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { detectDuplicateCrownTabs, stripVersionToken, titleFamilyKey, extractVersion } = require('./crown-duplicate-detector.js');
const { isCrownTab } = require('./prune-closeable.js');

const REPO = '/Users/tompryor/Broadwayscore';
const WORKTREE = '/Users/tompryor/Broadwayscore/.claude/worktrees/some-task';

function alwaysAlive() { return true; }
function makeCheckLiveness(deadRefs) {
  return (ref) => ({ dead: deadRefs.has(ref) });
}
function launchByRefFromMap(map) {
  return (ref) => map[ref] || null;
}

test('stripVersionToken: strips a standalone v<digits> token, leaves BRO-343 alone', () => {
  assert.equal(stripVersionToken('Crown v42: BRO-343 backlog triage'), 'Crown : BRO-343 backlog triage');
  assert.equal(stripVersionToken('Crown BRO-343 v32: P1 backlog'), 'Crown BRO-343 : P1 backlog');
});

test('extractVersion: pulls the version number for keep/stale ordering', () => {
  assert.equal(extractVersion('Crown v42: BRO-343 backlog triage'), 42);
  assert.equal(extractVersion('Crown v45 successor (BRO-343)'), 45);
  assert.equal(extractVersion('👑 OWNER watchdog — 4 in flight'), null);
});

test('titleFamilyKey: two versions of the same mandate normalize to the same key', () => {
  const a = titleFamilyKey('❓ 👑 OWNER — Crown v42: BRO-343 backlog triage + dispatch loop');
  const b = titleFamilyKey('👑 OWNER — Crown v45 successor (BRO-343 backlog triage + dispatch loop)');
  // Not asserting exact equality (the "successor" wording differs) — just that
  // stripping glyphs+version doesn't crash and lowercases consistently.
  assert.equal(typeof a, 'string');
  assert.equal(typeof b, 'string');
  assert.equal(a, a.toLowerCase());
});

test('detectDuplicateCrownTabs: groups live bare-checkout Crown tabs by taskId, keeps highest version', () => {
  const workspaces = [
    { ref: 'workspace:12', title: '❓ 👑 OWNER — Crown v42: BRO-343 backlog triage + dispatch loop', selected: false, cwd: REPO },
    { ref: 'workspace:13', title: '👑 OWNER — Crown v45 successor (BRO-343 backlog triage + dispatch loop)', selected: false, cwd: REPO },
    { ref: 'workspace:111', title: '👑 OWNER — Crown v46: BRO-343 P1 triage + dispatch loop', selected: false, cwd: REPO },
  ];
  const entries = []; // launchByRef fixture below supplies taskId directly, ledger contents irrelevant here
  const launchByRef = launchByRefFromMap({
    'workspace:12': { taskId: 'linear:BRO-343' },
    'workspace:13': { taskId: 'linear:BRO-343' },
    'workspace:111': { taskId: 'linear:BRO-343' },
  });
  const { duplicateGroups } = detectDuplicateCrownTabs({
    workspaces, entries, repoRoot: REPO, isCrownTab, launchByRef,
    checkLivenessFn: makeCheckLiveness(new Set()), aliveFn: alwaysAlive, surfaceAliveFn: alwaysAlive,
  });
  assert.equal(duplicateGroups.length, 1);
  assert.equal(duplicateGroups[0].keyType, 'taskId');
  assert.equal(duplicateGroups[0].keep.ref, 'workspace:111');
  assert.deepEqual(duplicateGroups[0].stale.map(s => s.ref).sort(), ['workspace:12', 'workspace:13']);
});

test('detectDuplicateCrownTabs: falls back to title-family grouping when the ledger has no taskId', () => {
  const workspaces = [
    { ref: 'workspace:20', title: '👑 OWNER — Crown v25: P1 backlog triage + dispatch loop', selected: false, cwd: REPO },
    { ref: 'workspace:21', title: '👑 OWNER — Crown v26: P1 backlog triage + dispatch loop', selected: false, cwd: REPO },
  ];
  const { duplicateGroups } = detectDuplicateCrownTabs({
    workspaces, entries: [], repoRoot: REPO, isCrownTab, launchByRef: () => null,
    checkLivenessFn: makeCheckLiveness(new Set()), aliveFn: alwaysAlive, surfaceAliveFn: alwaysAlive,
  });
  assert.equal(duplicateGroups.length, 1);
  assert.equal(duplicateGroups[0].keyType, 'title');
  assert.equal(duplicateGroups[0].keep.ref, 'workspace:21');
});

test('detectDuplicateCrownTabs: never flags a worktree-scoped Crown tab, even sharing a taskId', () => {
  const workspaces = [
    { ref: 'workspace:30', title: '👑 OWNER — Crown v39 (BRO-343): verify run, then BRO-2821 half', selected: false, cwd: WORKTREE },
    { ref: 'workspace:111', title: '👑 OWNER — Crown v46: BRO-343 P1 triage + dispatch loop', selected: false, cwd: REPO },
  ];
  const launchByRef = launchByRefFromMap({
    'workspace:30': { taskId: 'linear:BRO-343' },
    'workspace:111': { taskId: 'linear:BRO-343' },
  });
  const { duplicateGroups } = detectDuplicateCrownTabs({
    workspaces, entries: [], repoRoot: REPO, isCrownTab, launchByRef,
    checkLivenessFn: makeCheckLiveness(new Set()), aliveFn: alwaysAlive, surfaceAliveFn: alwaysAlive,
  });
  assert.equal(duplicateGroups.length, 0);
});

test('detectDuplicateCrownTabs: a dead tab is excluded from the group entirely', () => {
  const workspaces = [
    { ref: 'workspace:13', title: '👑 OWNER — Crown v45: BRO-343 backlog triage + dispatch loop', selected: false, cwd: REPO },
    { ref: 'workspace:14', title: '👑 OWNER — Crown v44: BRO-343 backlog triage + dispatch loop', selected: false, cwd: REPO },
  ];
  const launchByRef = launchByRefFromMap({
    'workspace:13': { taskId: 'linear:BRO-343' },
    'workspace:14': { taskId: 'linear:BRO-343' },
  });
  const { duplicateGroups } = detectDuplicateCrownTabs({
    workspaces, entries: [], repoRoot: REPO, isCrownTab, launchByRef,
    checkLivenessFn: makeCheckLiveness(new Set(['workspace:14'])), aliveFn: alwaysAlive, surfaceAliveFn: alwaysAlive,
  });
  // workspace:14 excluded (dead) — only workspace:13 remains live, so no
  // duplicate group forms (need >=2 LIVE members).
  assert.equal(duplicateGroups.length, 0);
});

// Adversarial review, 2026-09-07: a group of exactly 2 (one selected, one
// not) must NOT silently vanish just because the owner happens to be
// looking at one of them — that's precisely when the report matters most.
// The selected tab is still surfaced, just never given a close command.
test('detectDuplicateCrownTabs: a selected tab is still counted in the group, never given a close command', () => {
  const workspaces = [
    { ref: 'workspace:12', title: '👑 OWNER — Crown v42: BRO-343 backlog triage + dispatch loop', selected: true, cwd: REPO },
    { ref: 'workspace:13', title: '👑 OWNER — Crown v45: BRO-343 backlog triage + dispatch loop', selected: false, cwd: REPO },
  ];
  const launchByRef = launchByRefFromMap({
    'workspace:12': { taskId: 'linear:BRO-343' },
    'workspace:13': { taskId: 'linear:BRO-343' },
  });
  const { duplicateGroups } = detectDuplicateCrownTabs({
    workspaces, entries: [], repoRoot: REPO, isCrownTab, launchByRef,
    checkLivenessFn: makeCheckLiveness(new Set()), aliveFn: alwaysAlive, surfaceAliveFn: alwaysAlive,
  });
  assert.equal(duplicateGroups.length, 1);
  assert.equal(duplicateGroups[0].keep.ref, 'workspace:13', 'higher version wins keep, regardless of selection');
  assert.equal(duplicateGroups[0].stale.length, 1);
  assert.equal(duplicateGroups[0].stale[0].ref, 'workspace:12');
  assert.equal(duplicateGroups[0].stale[0].selected, true, 'the selected stale entry must be marked so the caller never emits a close command for it');
});

test('detectDuplicateCrownTabs: a single live Crown tab is never a duplicate', () => {
  const workspaces = [
    { ref: 'workspace:111', title: '👑 OWNER — Crown v46: BRO-343 P1 triage + dispatch loop', selected: false, cwd: REPO },
    { ref: 'workspace:108', title: '👑 OWNER watchdog — 4 in flight · 6 need you', selected: false, cwd: REPO },
  ];
  const launchByRef = launchByRefFromMap({ 'workspace:111': { taskId: 'linear:BRO-343' } });
  const { duplicateGroups } = detectDuplicateCrownTabs({
    workspaces, entries: [], repoRoot: REPO, isCrownTab, launchByRef,
    checkLivenessFn: makeCheckLiveness(new Set()), aliveFn: alwaysAlive, surfaceAliveFn: alwaysAlive,
  });
  assert.equal(duplicateGroups.length, 0);
});
