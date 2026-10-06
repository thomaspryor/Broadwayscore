// BRO-2211: hook subtraction guard for the repo's .claude/hooks directory.
//
// The session-cost overhaul (V1-V3: queue-first dispatch, hook subtraction) stalled while hooks grew. This test is the
// part of V3 that a repo test can enforce: the hook set may not regrow past a ceiling, and every hook must be wired or
// explicitly retired. Lowering the ceilings when a hook is removed ratchets the set down; raising one needs the
// justification in the commit message.
//
// What it does NOT cover: ~/.claude/bin/overhaul-driver.sh (the thing that was supposed to dispatch V1-V3 twice a day)
// lives on the Mac outside this repo, so whether its attempts still no-op is a Mac-side check (BRO-2211 follow-up).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = path.join(ROOT, '.claude', 'hooks');

// Measured on main 2026-10-06: 18 top-level hook scripts, 5049 lines across all hook files including lib/.
const MAX_HOOK_FILES = 18;
const MAX_HOOK_LINES = 5100;

// Retired hooks whose script must STAY: old cloud snapshots still call them, so they are unregistered but never
// deleted (scripts/tests/cloud-settings-guards.test.mjs asserts the same; .claude/CLOUD.md documents it).
const RETIRED_KEPT = ['notion-create-block.sh'];

const topLevel = readdirSync(HOOKS, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
const settings = readFileSync(path.join(ROOT, '.claude', 'settings.json'), 'utf8');

const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);

test('every top-level repo hook is wired in .claude/settings.json, except the retired ones kept for old snapshots', () => {
  const orphans = topLevel.filter((f) => !RETIRED_KEPT.includes(f) && !settings.includes(f));
  assert.deepEqual(orphans, [], `orphan hooks (wire them or delete them): ${orphans.join(', ')}`);
});

test('retired hooks stay unregistered and their scripts stay on disk', () => {
  for (const f of RETIRED_KEPT) {
    assert.equal(settings.includes(f), false, `${f} is retired and must not be re-registered`);
    assert.equal(existsSync(path.join(HOOKS, f)), true, `${f} must stay on disk: old cloud snapshots still call it`);
  }
});

test('hook file and line budget does not regrow', () => {
  const lines = walk(HOOKS).reduce((n, f) => n + readFileSync(f, 'utf8').split('\n').length, 0);
  assert.ok(topLevel.length <= MAX_HOOK_FILES, `${topLevel.length} top-level hook files > ceiling ${MAX_HOOK_FILES}: delete or merge one, or justify raising the ceiling in the commit message`);
  assert.ok(lines <= MAX_HOOK_LINES, `${lines} hook lines > ceiling ${MAX_HOOK_LINES}: trim a hook, or justify raising the ceiling in the commit message`);
});

test('the ceilings are tight: within 5% of the real size, so they cannot hide a regrowth', () => {
  const lines = walk(HOOKS).reduce((n, f) => n + readFileSync(f, 'utf8').split('\n').length, 0);
  assert.ok(MAX_HOOK_FILES - topLevel.length <= 1, `ceiling ${MAX_HOOK_FILES} is loose for ${topLevel.length} files: lower MAX_HOOK_FILES`);
  assert.ok(MAX_HOOK_LINES <= lines * 1.05, `ceiling ${MAX_HOOK_LINES} is loose for ${lines} lines: lower MAX_HOOK_LINES to ratchet the set down`);
});
