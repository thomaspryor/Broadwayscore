// BRO-2211: hook subtraction guard. Repo hooks grew 10 -> 19 files (2026-08-17 -> 10-01)
// while the V1-V3 overhaul stalled. Root cause of the stall: ~/.claude/bin/overhaul-driver.sh
// polls Notion-era task files (856/867/868/869) that no longer exist, so every tick logs a
// blank state and no-ops. Retired Notion => retire/replace that driver, never re-add Notion hooks.
// To raise a ceiling below, justify the new hook in the commit message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = path.join(ROOT, '.claude', 'hooks');
const MAX_HOOK_FILES = 18; // top-level hook scripts (was 19 before BRO-2211)
const MAX_HOOK_LINES = 5200; // all hook files incl. lib/ (was 5030 before BRO-2211)

const topLevel = readdirSync(HOOKS, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
const settings = readFileSync(path.join(ROOT, '.claude', 'settings.json'), 'utf8');

test('every top-level repo hook is wired in .claude/settings.json (no orphans)', () => {
  const orphans = topLevel.filter((f) => !settings.includes(f));
  assert.deepEqual(orphans, [], `orphan hooks (delete or wire): ${orphans.join(', ')}`);
});

test('retired Notion hook stays deleted', () => {
  assert.equal(existsSync(path.join(HOOKS, 'notion-create-block.sh')), false);
});

test('hook file/line budget does not regrow', () => {
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const lines = walk(HOOKS).reduce((n, f) => n + readFileSync(f, 'utf8').split('\n').length, 0);
  assert.ok(topLevel.length <= MAX_HOOK_FILES, `${topLevel.length} hook files > ${MAX_HOOK_FILES}`);
  assert.ok(lines <= MAX_HOOK_LINES, `${lines} hook lines > ${MAX_HOOK_LINES}`);
});
