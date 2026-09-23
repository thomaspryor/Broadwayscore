// TESTS-VS-DERIVED-DATA-EXEMPT: purely structural — asserts on
// .github/workflows/gather-reviews.yml's own YAML text (a push-retry env
// override), never reads data/reviews.json or any other derived data file.
// "reviews.json" appears only inside step names/comments being matched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// BRO-2736: "Gather Review Data" repeat-failure alert (electra-persona-
// west-end-2026, 27 failures 2026-09-01→04, all "Commit rebuilt
// reviews.json"). Root cause (e.g. run 33910221902): the step's
// `git add data/audit/` routinely picks up per-show state files never
// registered for the Git Data API fallback (e.g.
// data/audit/poller-backoff/{show-id}.json, written by
// opening-night-poller.js) — any single unregistered data/audit/ path
// disqualifies the whole commit from that fast path (NOT a
// data/reviews.json NEVER_FALLBACK case, despite the step's name — this
// step never stages data/reviews.json), forcing the slow local
// fetch+rebase+push loop. Under a high-concurrency opening-night burst
// (several shows' pollers writing that directory at once) the shared 240s
// PUSH_DEADLINE_SEC default only fit ~1-2 real fetch-rebase-conflict-merge
// cycles (task #458) before giving up — confirmed live: 2 attempts,
// "overall deadline 240s exceeded". Fixed with the same
// PUSH_DEADLINE_SEC=900 / MAX_RETRIES=25 budget already shipped on
// rebuild-reviews.yml's equivalent step (card #1891/#1842).
//
// This test reads the real workflow YAML so a future edit that quietly
// drops the override (e.g. a copy-paste of the step without its env:
// block) fails here instead of waiting for the next opening-night burst.

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'gather-reviews.yml');
const workflowText = fs.readFileSync(workflowPath, 'utf8');

// Requires "- name:" to immediately follow a newline plus pure whitespace
// (\s* cannot cross a "#"), so a commented-out step
// (`# - name: Commit rebuilt reviews.json`) can never be mistaken for the
// live one (ship-check/Codex adversarial finding, BRO-2736). No `m` flag —
// `$` must mean true end-of-string here, not end-of-the-first-line, or the
// lazy `[\s\S]*?` stops after just the "- name:" line itself.
function extractStep(text, stepName) {
  const re = new RegExp(`\\n\\s*- name:\\s*${stepName}[\\s\\S]*?(?=\\n {6}- name:|\\n {4}- name:|$)`);
  return re.exec(text)?.[0] ?? null;
}

const step = extractStep(workflowText, 'Commit rebuilt reviews\\.json');

test('workflow: "Commit rebuilt reviews.json" overrides PUSH_DEADLINE_SEC well above the 240s shared default', () => {
  assert.ok(step, 'could not locate the "Commit rebuilt reviews.json" step body');

  const m = /^\s*PUSH_DEADLINE_SEC:\s*'?(\d+)'?/m.exec(step);
  assert.ok(m, 'expected a PUSH_DEADLINE_SEC env override on this step — without it, high-concurrency opening-night bursts exhaust the shared 240s default after only 1-2 real retry cycles');
  const deadlineSec = Number(m[1]);
  assert.ok(deadlineSec >= 900, `PUSH_DEADLINE_SEC=${deadlineSec} is below the 900s floor that gave this step enough real fetch-rebase-merge cycles to survive the observed contention (BRO-2736)`);
});

test('workflow: "Commit rebuilt reviews.json" calls push-with-retry.sh with a retry budget sized to the raised deadline', () => {
  assert.ok(step, 'could not locate the "Commit rebuilt reviews.json" step body');

  const m = /^\s*bash scripts\/lib\/push-with-retry\.sh(?:\s+(\d+))?/m.exec(step);
  assert.ok(m, 'expected a push-with-retry.sh invocation in this step');
  const maxRetries = Number(m[1] ?? 7);
  assert.ok(maxRetries >= 25, `push-with-retry.sh MAX_RETRIES=${maxRetries} is below the 25-attempt floor (task #1842's own live-verified budget: ~725s of backoff under a 900s deadline) — too low a retry count would still exhaust PUSH_DEADLINE_SEC's real cycles well before the wall-clock budget does`);
});

test('workflow: no step-level timeout-minutes on this step is shorter than its own configured PUSH_DEADLINE_SEC', () => {
  assert.ok(step, 'could not locate the "Commit rebuilt reviews.json" step body');

  const deadlineMatch = /^\s*PUSH_DEADLINE_SEC:\s*'?(\d+)'?/m.exec(step);
  const timeoutMatch = /^\s*timeout-minutes:\s*(\d+)/m.exec(step);
  if (timeoutMatch) {
    // Compares against THIS step's own configured deadline (not a hardcoded
    // constant) so the test stays correct if the deadline is ever tuned —
    // ship-check/Codex adversarial finding, BRO-2736.
    const deadlineSec = deadlineMatch ? Number(deadlineMatch[1]) : 240;
    const timeoutSec = Number(timeoutMatch[1]) * 60;
    assert.ok(timeoutSec >= deadlineSec, `step timeout-minutes (${timeoutMatch[1]}m = ${timeoutSec}s) is shorter than PUSH_DEADLINE_SEC (${deadlineSec}s) — the step would be killed before push-with-retry.sh's own deadline can exit gracefully`);
  }
});
