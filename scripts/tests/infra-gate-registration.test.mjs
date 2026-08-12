// scripts/tests/infra-gate-registration.test.mjs
//
// Acceptance test for task #1094: nothing detects the #1079 infra-review gate
// being unregistered or deleted (vacuous-gate class — the same shape #1063 /
// #1066-#1069 closed for corpus audits).
//
// Per CLAUDE.md rule 15 this require()s the REAL decision functions from
// scripts/lib/infra-gate-registration-check.js — it does not restate them.
//
// Two kinds of coverage here, deliberately kept separate:
//
//  (a) FIXTURE tests — build a temp ~/.claude-shaped directory with the
//      registration entry/hook PRESENT, then with it REMOVED, and assert the
//      checker's verdict flips. This is the literal acceptance criterion
//      ("the test must FAIL when the settings.json entry is removed or the
//      hook file is missing, and PASS when both are present — proven by
//      running it in both states"), and it is fully portable: it never reads
//      this machine's real ~/.claude, so it runs the same in CI as on the Mac.
//
//  (b) LIVE MACHINE tests — run the checks against the REAL ~/.claude on
//      whatever machine executes this file, including the synthetic-block
//      probe that actually RUNS the hook (not just looks at it — a check that
//      only looks at files is the vacuous-gate bug this card exists to
//      prevent). These only make sense on a machine with the hook system
//      installed (the Mac); they skip cleanly everywhere else, mirroring
//      scripts/lib/claude-auth-health.js's precedent for machine-local
//      conditions CI structurally cannot see.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const check = require('../lib/infra-gate-registration-check.js');

const {
  checkSettingsRegistration,
  checkHookFileExists,
  checkScopeLibOnOrigin,
  probeSyntheticBlock,
  runInfraGateRegistrationCheck,
  buildAlertPayload,
} = check;

const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'infra-gate-registration-test-'));
}

const REGISTERED_SETTINGS = {
  hooks: {
    PreToolUse: [
      {
        matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash',
        hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/infra-plan-review-gate.sh' }],
      },
    ],
  },
};

const UNREGISTERED_SETTINGS = {
  hooks: {
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/some-other-gate.sh' }],
      },
    ],
  },
};

// ── (a) fixture tests: portable, deterministic, run everywhere ──────────────

test('(a) checkSettingsRegistration PASSES when a PreToolUse entry references the hook', () => {
  const dir = makeTmpDir();
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify(REGISTERED_SETTINGS));
  const r = checkSettingsRegistration({ settingsPath });
  assert.equal(r.ok, true, r.detail);
});

test('(a) checkSettingsRegistration FAILS when the PreToolUse entry is removed', () => {
  const dir = makeTmpDir();
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify(UNREGISTERED_SETTINGS));
  const r = checkSettingsRegistration({ settingsPath });
  assert.equal(r.ok, false);
  assert.match(r.detail, /no PreToolUse entry references/);
});

test('(a) checkSettingsRegistration FAILS when settings.json does not exist', () => {
  const dir = makeTmpDir();
  const r = checkSettingsRegistration({ settingsPath: path.join(dir, 'nope.json') });
  assert.equal(r.ok, false);
  assert.match(r.detail, /not found/);
});

test('(a) checkSettingsRegistration FAILS when a matching entry exists but its matcher does not cover Edit+Bash', () => {
  // The exact gap a ship-check reviewer flagged: a command referencing the
  // hook is not enough on its own if the matcher was narrowed (e.g. to
  // 'Read') — real edits/shell writes would fail-open while this looked
  // registered.
  const dir = makeTmpDir();
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/infra-plan-review-gate.sh' }] }] },
  }));
  const r = checkSettingsRegistration({ settingsPath });
  assert.equal(r.ok, false);
  assert.match(r.detail, /does not cover both Edit and Bash/);
});

test('(a) checkSettingsRegistration FAILS on unparseable settings.json', () => {
  const dir = makeTmpDir();
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, '{not json');
  const r = checkSettingsRegistration({ settingsPath });
  assert.equal(r.ok, false);
  assert.match(r.detail, /unparseable/);
});

test('(a) checkHookFileExists PASSES when the hook file is present and non-empty', () => {
  const dir = makeTmpDir();
  const hookPath = path.join(dir, 'infra-plan-review-gate.sh');
  fs.writeFileSync(hookPath, '#!/usr/bin/env bash\nexit 0\n');
  const r = checkHookFileExists({ hookPath });
  assert.equal(r.ok, true, r.detail);
});

test('(a) checkHookFileExists FAILS when the hook file is missing', () => {
  const dir = makeTmpDir();
  const r = checkHookFileExists({ hookPath: path.join(dir, 'gone.sh') });
  assert.equal(r.ok, false);
  assert.match(r.detail, /missing/);
});

test('(a) checkHookFileExists FAILS when the hook file exists but is empty', () => {
  const dir = makeTmpDir();
  const hookPath = path.join(dir, 'infra-plan-review-gate.sh');
  fs.writeFileSync(hookPath, '');
  const r = checkHookFileExists({ hookPath });
  assert.equal(r.ok, false);
  assert.match(r.detail, /empty/);
});

test('(a) runInfraGateRegistrationCheck FAILS end-to-end when the fixture home has no registration or hook', () => {
  const homeDir = makeTmpDir();
  // no .claude/settings.json, no .claude/hooks/ at all
  const result = runInfraGateRegistrationCheck({ homeDir, repoRoot: REPO_ROOT, sessionId: `test-${randomUUID()}` });
  assert.equal(result.ok, false);
  assert.equal(result.checks.settings.ok, false);
  assert.equal(result.checks.hook.ok, false);
  assert.match(result.summary, /FAILED/);
});

test('(a) runInfraGateRegistrationCheck FAILS end-to-end when the settings entry is removed but the hook file still exists', () => {
  // The specific regression this card is about: someone rewrites
  // settings.json (or a merge drops the PreToolUse entry) while the hook file
  // itself is untouched. File-presence-only checks would miss this entirely.
  const homeDir = makeTmpDir();
  fs.mkdirSync(path.join(homeDir, '.claude', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.claude', 'settings.json'), JSON.stringify(UNREGISTERED_SETTINGS));
  fs.writeFileSync(path.join(homeDir, '.claude', 'hooks', 'infra-plan-review-gate.sh'), '#!/usr/bin/env bash\nexit 0\n');
  const result = runInfraGateRegistrationCheck({ homeDir, repoRoot: REPO_ROOT, sessionId: `test-${randomUUID()}` });
  assert.equal(result.ok, false);
  assert.equal(result.checks.settings.ok, false);
  assert.equal(result.checks.hook.ok, true, 'the hook file itself is fine — only the registration is missing');
});

test('(a) buildAlertPayload is routeAlert-shaped: digest disposition, error severity, stable conditionKey', () => {
  const result = { ok: false, summary: 'boom', checks: { probe: { ok: false } } };
  const payload = buildAlertPayload(result);
  assert.equal(payload.disposition, 'digest');
  assert.equal(payload.severity, 'error');
  assert.equal(payload.conditionKey, 'infra-gate-registration:broken');
  assert.ok(payload.title && payload.description && payload.hint);
});

test('(a) probeSyntheticBlock interprets exit 2 as blocked (ok=true) — portable fixture, no real hook needed', () => {
  const dir = makeTmpDir();
  const hookPath = path.join(dir, 'fake-gate.sh');
  fs.writeFileSync(hookPath, '#!/usr/bin/env bash\ncat >/dev/null\nexit 2\n');
  fs.chmodSync(hookPath, 0o755);
  const r = probeSyntheticBlock({ hookPath, repoRoot: REPO_ROOT, sessionId: `test-${randomUUID()}` });
  assert.equal(r.exitCode, 2);
  assert.equal(r.ok, true, r.detail);
});

test('(a) probeSyntheticBlock interprets exit 0 (allowed) as NOT blocked (ok=false) — this is the regression this task exists to catch', () => {
  const dir = makeTmpDir();
  const hookPath = path.join(dir, 'fake-gate.sh');
  fs.writeFileSync(hookPath, '#!/usr/bin/env bash\ncat >/dev/null\nexit 0\n');
  fs.chmodSync(hookPath, 0o755);
  const r = probeSyntheticBlock({ hookPath, repoRoot: REPO_ROOT, sessionId: `test-${randomUUID()}` });
  assert.equal(r.exitCode, 0);
  assert.equal(r.ok, false, r.detail);
  assert.match(r.detail, /did NOT block/);
});

test('(a) probeSyntheticBlock reports not-ok on a script that exits with an unrelated non-2 code', () => {
  const dir = makeTmpDir();
  const hookPath = path.join(dir, 'fake-gate.sh');
  fs.writeFileSync(hookPath, '#!/usr/bin/env bash\ncat >/dev/null\nexit 1\n');
  fs.chmodSync(hookPath, 0o755);
  const r = probeSyntheticBlock({ hookPath, repoRoot: REPO_ROOT, sessionId: `test-${randomUUID()}` });
  assert.equal(r.exitCode, 1);
  assert.equal(r.ok, false);
});

test('(a) probeSyntheticBlock detects a stale DEFAULT_PROBE_TARGET instead of misreporting the gate as broken', () => {
  // If a future scope edit reclassifies DEFAULT_PROBE_TARGET out of the
  // 'critical' tier, the hook correctly stops blocking it (exit 0/warn) —
  // that is NOT evidence the gate is broken. probeSyntheticBlock must catch
  // this itself by re-classifying the target against the live scope lib.
  const fakeRepo = makeTmpDir();
  fs.mkdirSync(path.join(fakeRepo, 'scripts', 'lib'), { recursive: true });
  fs.writeFileSync(
    path.join(fakeRepo, 'scripts', 'lib', 'infra-review-scope.js'),
    "module.exports = { classifyPath: () => ({ inScope: true, tier: 'shared' }) };\n"
  );
  const hookPath = path.join(fakeRepo, 'fake-gate.sh');
  fs.writeFileSync(hookPath, '#!/usr/bin/env bash\ncat >/dev/null\nexit 2\n'); // would look healthy if run
  fs.chmodSync(hookPath, 0o755);
  const r = probeSyntheticBlock({ hookPath, repoRoot: fakeRepo, sessionId: `test-${randomUUID()}` });
  assert.equal(r.ok, false);
  assert.equal(r.staleTarget, true);
  assert.match(r.detail, /no longer classifies as 'critical'/);
});

// ── (b) live-machine tests: only meaningful where ~/.claude is installed ────

const REAL_HOME = os.homedir();
const hasClaudeHooksDir = fs.existsSync(path.join(REAL_HOME, '.claude', 'hooks'));

test(
  '(b) on this machine, the real gate is registered and the hook file is present',
  { skip: !hasClaudeHooksDir && 'no ~/.claude/hooks on this machine (expected in CI)' },
  () => {
    const settingsPath = path.join(REAL_HOME, check.SETTINGS_REL_PATH);
    const hookPath = path.join(REAL_HOME, check.HOOK_REL_PATH);
    const settingsResult = checkSettingsRegistration({ settingsPath });
    const hookResult = checkHookFileExists({ hookPath });
    assert.equal(settingsResult.ok, true, settingsResult.detail);
    assert.equal(hookResult.ok, true, hookResult.detail);
  }
);

// A checkout with NO origin/main ref (what actions/checkout produces on a
// pull_request event: fetch-depth 1 of refs/pull/<n>/merge) must come back
// inconclusive, not failed. Reporting it as a violation turned every PR's Unit
// Tests job red no matter what the PR changed — PR #573, run 31563016374.
test('(a) a checkout with no origin/main ref is inconclusive, not a violation', () => {
  const fakeRepo = makeTmpDir();
  const { spawnSync } = require('node:child_process');
  spawnSync('git', ['init', '-q'], { cwd: fakeRepo });
  const r = checkScopeLibOnOrigin({ repoRoot: fakeRepo });
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.inconclusive, true, r.detail);
  assert.match(r.detail, /no origin\/main ref/);
  fs.rmSync(fakeRepo, { recursive: true, force: true });
});

test(
  '(b) scripts/lib/infra-review-scope.js is present on origin/main',
  { skip: !fs.existsSync(path.join(REPO_ROOT, '.git')) && 'not a git checkout' },
  () => {
    const r = checkScopeLibOnOrigin({ repoRoot: REPO_ROOT });
    assert.equal(r.ok, true, r.detail);
  }
);

test(
  '(b) SYNTHETIC-BLOCK PROBE: the real hook actually blocks a critical-infra edit for an unrecorded session (exit 2) — not just present, RUNNING',
  { skip: !hasClaudeHooksDir && 'no ~/.claude/hooks on this machine (expected in CI)' },
  () => {
    const hookPath = path.join(REAL_HOME, check.HOOK_REL_PATH);
    const r = probeSyntheticBlock({
      hookPath,
      repoRoot: REPO_ROOT,
      sessionId: `infra-gate-registration-test-${randomUUID()}`,
    });
    assert.equal(r.exitCode, 2, r.detail);
    assert.equal(r.ok, true, r.detail);
  }
);

test(
  '(b) runInfraGateRegistrationCheck PASSES end-to-end against the real machine state',
  { skip: !hasClaudeHooksDir && 'no ~/.claude/hooks on this machine (expected in CI)' },
  () => {
    const result = runInfraGateRegistrationCheck({ repoRoot: REPO_ROOT, sessionId: `infra-gate-registration-test-${randomUUID()}` });
    assert.equal(result.ok, true, result.summary);
    for (const [name, c] of Object.entries(result.checks)) {
      assert.equal(c.ok, true, `${name}: ${c.detail}`);
    }
  }
);
