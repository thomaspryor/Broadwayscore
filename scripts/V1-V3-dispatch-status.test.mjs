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
const MAX_HOOK_FILES = 20; // BRO-6276: +1 file, land-cancel-guard.sh (refuses cancelling another session's Land run, from Bash and from the MCP actions tool). Repo-only with no master twin, the github-main-guard.sh pattern: a guard that must hold everywhere cannot ride a file that self-skips to its ~/.claude master. BRO-5926: +1 file, pr-write-guard.sh. The PR refusal had to LEAVE pre-push-review-gate.sh: that file self-skips to its ~/.claude master, which has no PR check, so the guard was dead on the Mac. A guard that must hold everywhere needs a repo-only file with no master twin (the github-main-guard.sh pattern) — merging it into an existing hook is what caused the bug.
const MAX_HOOK_LINES = 5725; // BRO-6546: +2 in verify-edits.sh for the LOOSEENDS admitted-skip arms (haven't/didn't split, your-call negatable); BRO-6546: +4 in verify-edits.sh for the 'ping me and I'll look' offer arm in PASSIVEOFFER; BRO-6546: +2 in verify-edits.sh for the bare-imperative merge-ask pattern ("Merge #1170 first"); BRO-6546: +68 in verify-edits.sh for the PASSIVEOFFER Stop gate (owner 2026-10-29: sessions ended on "say the word" / "shall I" offers instead of landing and building); one regex plus a quote/negation filter, no new file; BRO-6539: +5 in verify-edits.sh calling decision-restate.js --stop-hook (logic stays in scripts/lib); BRO-6276: +78 for land-cancel-guard.sh (see MAX_HOOK_FILES), plus +5 that 6b199a62d (BRO-419 pre-push-visual-gate.sh) landed without raising the ceiling, which left main red on this test; BRO-6088: +2 in block-prompting-remote-tools.sh calling scripts/plan-only-create-session-hook.js (advisory when a plan-only session starts a session; logic stays in scripts/lib); BRO-5926: +68 net (pr-write-guard.sh, less the block deleted from pre-push-review-gate.sh); BRO-5915: +32 net (pre-push-review-gate.sh calls lib/pr-command.mjs, github-main-guard.sh refuses MCP create_pull_request, verify-edits.sh counts only real PR creates + imperative merge asks): sessions left PRs parked on the owner; parsing stays in scripts/lib; BRO-5910: +23 net in verify-edits.sh for the CLEARCLOSE Stop gate (owner 2026-10-22: sessions must end with a plain, complete closing block); BRO-5881: +121 in verify-edits.sh for the LOOSEENDS and WAKELESS Stop gates (owner 2026-10-22: false SAFE claims and NOT SAFE waits nothing wakes), net of the INFLIGHT/OPENWORK parse they now share; BRO-5844: +8 in pre-push-visual-gate.sh calling lib/visual-text-only-diff.js --filter (classifier stays out of hooks/); BRO-5359: +9 review-coverage gate call in verify-edits.sh (the one Stop hook wired in every cloud container); BRO-5228: +9 create_session model guard (an omitted model inherited the parent's Opus); BRO-5221: +lib/home-hook-runner.sh (multi-repo sessions ran no hooks at all); BRO-2394: +3 in github-main-guard.sh calling scripts/lib/mcp-push-visual-gate.sh (the logic stays out of hooks/)

// Retired hooks whose script must STAY: old cloud snapshots still call them, so they are unregistered but never
// deleted (scripts/tests/cloud-settings-guards.test.mjs asserts the same).
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
