import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// BRO-2736: "Gather Review Data" repeat-failure alert (electra-persona-
// west-end-2026, 27 failures 2026-09-01→04, all "Commit rebuilt
// reviews.json"). Root cause (e.g. run 33910221902): during a high-
// concurrency opening-night burst (many shows' Gather Review Data runs
// racing to push the same core-data repo), the "rebuild" job's "Commit
// rebuilt reviews.json" step used push-with-retry.sh's shared 240s
// PUSH_DEADLINE_SEC default, which only fits ~1-2 real
// fetch-rebase-conflict-merge cycles under this repo's churn (task #458)
// before giving up — confirmed live: 2 attempts, "overall deadline 240s
// exceeded". data/reviews.json is intentionally excluded from the Git
// Data API fallback (task #1792 — a whole-file overlay could silently
// drop a concurrent writer's edit to a different show), so the local
// fetch+rebase+push loop is the only path and needed a bigger budget, not
// a faster escape hatch — the same class already fixed on
// rebuild-reviews.yml's equivalent step (card #1891/#1842).
//
// This test reads the real workflow YAML so a future edit that quietly
// drops the override (e.g. a copy-paste of the step without its env:
// block) fails here instead of waiting for the next opening-night burst.

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'gather-reviews.yml');
const workflowText = fs.readFileSync(workflowPath, 'utf8');

function extractStep(text, stepName) {
  const re = new RegExp(`- name:\\s*${stepName}[\\s\\S]*?(?=\\n {6}- name:|\\n {4}- name:|$)`);
  return re.exec(text)?.[0] ?? null;
}

test('workflow: "Commit rebuilt reviews.json" overrides PUSH_DEADLINE_SEC well above the 240s shared default', () => {
  const step = extractStep(workflowText, 'Commit rebuilt reviews\\.json');
  assert.ok(step, 'could not locate the "Commit rebuilt reviews.json" step body');

  const m = /PUSH_DEADLINE_SEC:\s*'?(\d+)'?/.exec(step);
  assert.ok(m, 'expected a PUSH_DEADLINE_SEC env override on this step — without it, high-concurrency opening-night bursts exhaust the shared 240s default after only 1-2 real retry cycles');
  const deadlineSec = Number(m[1]);
  assert.ok(deadlineSec >= 900, `PUSH_DEADLINE_SEC=${deadlineSec} is below the 900s floor that gave this step enough real fetch-rebase-merge cycles to survive the observed contention (BRO-2736)`);
});

test('workflow: "Commit rebuilt reviews.json" calls push-with-retry.sh with a retry budget sized to the raised deadline', () => {
  const step = extractStep(workflowText, 'Commit rebuilt reviews\\.json');
  assert.ok(step, 'could not locate the "Commit rebuilt reviews.json" step body');

  const m = /bash scripts\/lib\/push-with-retry\.sh(?:\s+(\d+))?/.exec(step);
  assert.ok(m, 'expected a push-with-retry.sh invocation in this step');
  const maxRetries = Number(m[1] ?? 7);
  assert.ok(maxRetries >= 25, `push-with-retry.sh MAX_RETRIES=${maxRetries} is below the 25-attempt floor (task #1842's own live-verified budget: ~725s of backoff under a 900s deadline) — too low a retry count would still exhaust PUSH_DEADLINE_SEC's real cycles well before the wall-clock budget does`);
});

test('workflow: "rebuild" job has no step-level timeout-minutes shorter than the raised PUSH_DEADLINE_SEC', () => {
  const step = extractStep(workflowText, 'Commit rebuilt reviews\\.json');
  assert.ok(step, 'could not locate the "Commit rebuilt reviews.json" step body');

  const timeoutMatch = /timeout-minutes:\s*(\d+)/.exec(step);
  if (timeoutMatch) {
    const timeoutSec = Number(timeoutMatch[1]) * 60;
    assert.ok(timeoutSec >= 900, `step timeout-minutes (${timeoutMatch[1]}m) would kill the step before push-with-retry.sh's own 900s+ deadline can exit gracefully`);
  }
});
