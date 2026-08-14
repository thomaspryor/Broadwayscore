// scripts/tests/hook-guard-restore.test.mjs
//
// Acceptance test for BRO-193: hook-syntax-guard.sh's restore loop could not
// tell "the guard itself quarantined this by mistake" from "a human renamed
// this on purpose to disable it" — both looked identical to the restore loop
// (any file matching "*.sh.broken-*" that parses and is still referenced in
// settings.json gets restored). That's what happened on 2026-08-06: the owner
// disabled infra-plan-review-gate.sh by hand at ~14:40 to unblock the machine,
// and the guard put it back at 14:52:10 — 12 minutes later, unasked.
//
// The fix (~/.claude/bin/hook-syntax-guard.sh) adds STATE_FILE, a manifest the
// quarantine step writes to when IT performs a quarantine. The restore loop
// now walks that manifest instead of globbing the filesystem, so a
// "*.sh.broken-*" file the guard never created — a human rename, even reusing
// the same suffix out of habit — is invisible to it and stays disabled.
//
// This does NOT reimplement that logic in JS (CLAUDE.md rule 15) — it spawns
// the real script against a sandboxed HOME via HOOK_SYNTAX_GUARD_* env var
// overrides added specifically for this test, exactly the way
// hook-liveness.test.mjs's "(b) on this machine" case gates on whether the
// real ~/.claude is present. The script lives in the separate ~/.claude
// claude-config repo, not this one, so it does not exist on GitHub Actions
// runners — every test below is skipped there, and runs for real on the dev
// machine via `node --test scripts/tests/hook-guard-restore.test.mjs`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GUARD_PATH = path.join(os.homedir(), '.claude', 'bin', 'hook-syntax-guard.sh');
const hasGuard = fs.existsSync(GUARD_PATH);
const skip = !hasGuard && 'hook-syntax-guard.sh lives in the separate ~/.claude claude-config repo (expected in CI)';

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsg-test-'));
  fs.mkdirSync(path.join(dir, 'hooks'));
  return dir;
}

function writeSettings(dir, hookBasename) {
  const settingsPath = path.join(dir, 'settings.json');
  const settings = {
    hooks: {
      PreToolUse: [
        { matcher: 'Edit', hooks: [{ type: 'command', command: `bash $HOME/.claude/hooks/${hookBasename}` }] },
      ],
    },
  };
  fs.writeFileSync(settingsPath, JSON.stringify(settings));
  return settingsPath;
}

function runGuard(dir, extraEnv = {}) {
  execFileSync('bash', [GUARD_PATH], {
    env: {
      ...process.env,
      HOOK_SYNTAX_GUARD_HOOK_DIR: path.join(dir, 'hooks'),
      HOOK_SYNTAX_GUARD_HOOK_DIRS: path.join(dir, 'hooks'),
      HOOK_SYNTAX_GUARD_LOG: path.join(dir, 'guard.log'),
      HOOK_SYNTAX_GUARD_STATE: path.join(dir, 'guard.state'),
      HOOK_SYNTAX_GUARD_SETTINGS: path.join(dir, 'settings.json'),
      HOOK_SYNTAX_GUARD_HEARTBEAT: path.join(dir, 'guard.heartbeat'),
      HOOK_SYNTAX_GUARD_MIN_AGE_SECS: '0',
      HOOK_SYNTAX_GUARD_SETTLE_SECS: '0',
      ...extraEnv,
    },
  });
}

function readState(dir) {
  const p = path.join(dir, 'guard.state');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean) : [];
}

function readLog(dir) {
  const p = path.join(dir, 'guard.log');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

test(
  'a hook the guard itself quarantined (recorded in STATE_FILE) is restored once it parses',
  { skip },
  () => {
    const dir = makeSandbox();
    writeSettings(dir, 'foo.sh');
    const brokenPath = path.join(dir, 'hooks', 'foo.sh.broken-20260101-000000');
    fs.writeFileSync(brokenPath, '#!/bin/bash\necho hi\n');
    fs.chmodSync(brokenPath, 0o755);
    // Simulate: the guard itself moved this out of the active path earlier.
    fs.writeFileSync(path.join(dir, 'guard.state'), brokenPath + '\n');

    runGuard(dir);

    const activePath = path.join(dir, 'hooks', 'foo.sh');
    assert.ok(fs.existsSync(activePath), 'foo.sh should have been restored');
    assert.match(readLog(dir), /RESTORED foo\.sh/);
    assert.deepEqual(readState(dir), [], 'manifest entry should be pruned once resolved');
  }
);

test(
  'a hook a human renamed by hand (never recorded in STATE_FILE) stays disabled across two ticks',
  { skip },
  () => {
    const dir = makeSandbox();
    writeSettings(dir, 'bar.sh');
    const brokenPath = path.join(dir, 'hooks', 'bar.sh.broken-20260101-000000');
    fs.writeFileSync(brokenPath, '#!/bin/bash\necho hi\n');
    fs.chmodSync(brokenPath, 0o755);
    // Deliberately empty manifest: this quarantine-shaped file was never
    // recorded by the guard, i.e. a human (or this test) created it directly.
    fs.writeFileSync(path.join(dir, 'guard.state'), '');

    const activePath = path.join(dir, 'hooks', 'bar.sh');

    runGuard(dir);
    assert.ok(!fs.existsSync(activePath), 'bar.sh must still be disabled after tick 1');

    runGuard(dir);
    assert.ok(!fs.existsSync(activePath), 'bar.sh must still be disabled after tick 2');

    assert.doesNotMatch(readLog(dir), /RESTORED bar\.sh/);
  }
);

test(
  'end to end: a genuinely broken hook is quarantined and recorded, then restored once fixed',
  { skip },
  () => {
    const dir = makeSandbox();
    writeSettings(dir, 'baz.sh');
    const activePath = path.join(dir, 'hooks', 'baz.sh');
    fs.writeFileSync(activePath, '#!/bin/bash\nif [ 1 ]; then\n  echo unterminated\n');
    fs.chmodSync(activePath, 0o755);

    runGuard(dir);

    assert.ok(!fs.existsSync(activePath), 'baz.sh should have been quarantined');
    const state1 = readState(dir);
    assert.equal(state1.length, 1, 'quarantine should record exactly one manifest entry');
    const brokenPath = state1[0];
    assert.match(brokenPath, /baz\.sh\.broken-/);
    assert.ok(fs.existsSync(brokenPath), 'the quarantined sibling should exist on disk');

    // Fix the content in place — represents the quarantine having been overly
    // cautious, or the underlying break getting corrected.
    fs.writeFileSync(brokenPath, '#!/bin/bash\necho fixed\n');

    runGuard(dir);

    assert.ok(fs.existsSync(activePath), 'baz.sh should be restored once its sibling parses');
    assert.deepEqual(readState(dir), [], 'manifest should be empty once resolved');
  }
);

test(
  'a quarantine-shaped file for a hook no longer referenced in settings.json is never restored, guard-recorded or not',
  { skip },
  () => {
    const dir = makeSandbox();
    // settings.json references nothing — simulates the hook being removed
    // from config entirely, not just renamed on disk.
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ hooks: {} }));
    const brokenPath = path.join(dir, 'hooks', 'qux.sh.broken-20260101-000000');
    fs.writeFileSync(brokenPath, '#!/bin/bash\necho hi\n');
    fs.chmodSync(brokenPath, 0o755);
    fs.writeFileSync(path.join(dir, 'guard.state'), brokenPath + '\n');

    runGuard(dir);

    assert.ok(!fs.existsSync(path.join(dir, 'hooks', 'qux.sh')), 'qux.sh must not be restored — settings.json no longer wants it');
  }
);
