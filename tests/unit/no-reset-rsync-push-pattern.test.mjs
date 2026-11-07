/**
 * Regression guard for Beaches 2026-04-22 opening-night postmortem #8.
 *
 * The pattern `git reset --hard origin/main && rsync local→repo` silently
 * wipes CI-added fields (llmScore, ensembleData, etc.) that landed between
 * our last pull and our attempted push. It was used interactively to
 * escape push rejections during Beaches and wiped ~5 fresh LLM scores.
 *
 * This test scans all shell scripts and workflow YAMLs for files that
 * combine BOTH tokens — new files that do must either use a safe pattern
 * (see scripts/lib/safe-sync-review-texts.sh) or join the allowlist with
 * a clear justification.
 *
 * Run: node --test tests/unit/no-reset-rsync-push-pattern.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

// Files allowed to contain BOTH tokens because their uses are disjoint
// (reset on one repo, rsync on an unrelated path). Each entry needs a
// one-line justification.
const ALLOWLIST = new Map([
  [
    'scripts/setup-local-data.sh',
    'reset --hard on core-data clone; rsync copies into local data dir — neither is a push path',
  ],
  [
    'scripts/lib/safe-sync-review-texts.sh',
    'The safe replacement. Mentions the bad pattern only in warning text.',
  ],
]);

const WALK_DIRS = ['scripts', '.github'];
const EXT_ALLOW = new Set(['.sh', '.yml', '.yaml']);

// Require BOTH tokens to trigger. `reset --hard origin` is the specific
// form that resets against the remote (the dangerous escape hatch); `reset
// --hard HEAD` and friends don't match. `rsync ` with the trailing space
// skips any incidental mentions in documentation.
const RE_RESET = /\breset\s+--hard\s+origin/;
const RE_RSYNC = /\brsync\s/;

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (EXT_ALLOW.has(path.extname(entry.name))) acc.push(full);
  }
  return acc;
}

test('no script combines `reset --hard origin` with `rsync` (outside the allowlist)', () => {
  const files = [];
  for (const d of WALK_DIRS) {
    const abs = path.join(repoRoot, d);
    if (fs.existsSync(abs)) walk(abs, files);
  }

  const offenders = [];
  for (const file of files) {
    const rel = path.relative(repoRoot, file);
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (!RE_RESET.test(content) || !RE_RSYNC.test(content)) continue;
    if (ALLOWLIST.has(rel)) continue;
    offenders.push(rel);
  }

  assert.deepEqual(offenders, [],
    `These files combine 'reset --hard origin' with 'rsync' — the pattern that ` +
    `silently wiped 5 LLM scores during Beaches 2026-04-22. Either:\n` +
    ` 1. Rewrite to use 'git pull --rebase' (see scripts/lib/safe-sync-review-texts.sh), or\n` +
    ` 2. Add the file to the ALLOWLIST in this test with a justification.`);
});

test('ALLOWLIST entries still exist on disk', () => {
  for (const rel of ALLOWLIST.keys()) {
    const abs = path.join(repoRoot, rel);
    assert.ok(fs.existsSync(abs), `ALLOWLIST refers to missing file: ${rel}`);
  }
});
