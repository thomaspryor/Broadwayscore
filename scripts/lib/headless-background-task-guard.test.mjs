// BRO-2741 acceptance test. A headless job that ends its turn while a
// background task is live has it killed at teardown, yet exits 0. The earlier
// "fail the job on any kill row" detection was reverted (eca80447ea4: 64 of 65
// logs with a kill row were healthy CI waits), so this guard only RECORDS the
// fact and must never change ok/stage. Drives the real runClaudeCli against a
// fake `claude` replaying rows shaped like job linear:BRO-2718-mtk78sto's log.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runClaudeCli, parseStreamLine } = require('./claude-cli.js');
const { summarizeKilledTasks, killedTasksLedgerFields, MAX_TASKS, MAX_DESC } = require('./headless-background-task-guard.js');

const START = JSON.stringify({ type: 'system', subtype: 'task_started', task_id: 'byh99e9v5', description: "timeout 1700 node scripts/enrich-card-acceptance.js --limit 200 --note 'it's big'", is_backgrounded: true, session_id: 's-bg' });
const KILLED = '{"type":"system","subtype":"task_updated","task_id":"byh99e9v5","patch":{"status":"killed","end_time":1788360028309},"session_id":"s-bg"}';
const RESULT = JSON.stringify({ type: 'result', is_error: false, result: 'Batch 2 is running in the background', session_id: 's-bg', total_cost_usd: 0.8 });

async function run(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-guard-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(path.join(dir, 'stream.jsonl'), lines.join('\n') + '\n');
  fs.writeFileSync(bin, `#!/bin/sh\ncat >/dev/null\ncat '${dir}/stream.jsonl'\n`, { mode: 0o755 });
  try {
    return await runClaudeCli({ prompt: 'x', cwd: dir, env: { CLAUDE_BIN: bin }, timeoutMs: 20000, graceMs: 1000 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('teardown kill after the result is recorded and the job stays ok (BRO-2741)', async () => {
  const r = await run([START, RESULT, KILLED]);
  assert.equal(r.ok, true, 'must NOT fail the job: that detection was reverted');
  assert.equal(r.stage, null);
  assert.deepEqual(r.killedTasks, [{ id: 'byh99e9v5', description: START && JSON.parse(START).description, backgrounded: true }]);
});

test('a kill BEFORE the result is the worker\'s own cleanup and is not recorded', async () => {
  const r = await run([START, KILLED, RESULT]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.killedTasks, []);
});

test('duplicate kill rows count once; kill with no task_started falls back to null description', async () => {
  const r = await run([RESULT, KILLED, KILLED]);
  assert.equal(r.killedTasks.length, 1);
  assert.equal(r.killedTasks[0].description, null);
  assert.equal(r.killedTasks[0].backgrounded, false);
});

test('healthy job: killedTasks is an empty array and the ledger fragment is empty', async () => {
  const r = await run([RESULT]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.killedTasks, []);
  assert.deepEqual(killedTasksLedgerFields(r.killedTasks), {});
});

test('parseStreamLine: only patch.status=killed flags; other transitions and patchless rows do not', () => {
  for (const status of ['running', 'completed']) {
    const l = JSON.stringify({ type: 'system', subtype: 'task_updated', task_id: 't', patch: { status } });
    assert.equal(parseStreamLine(l).killedTaskId, null);
  }
  assert.equal(parseStreamLine('{"type":"system","subtype":"task_updated","task_id":"t"}').killedTaskId, null);
  assert.equal(parseStreamLine(KILLED).killedTaskId, 'byh99e9v5');
});

test('summarizeKilledTasks: caps count and length, collapses whitespace, flags CI waits as advisory', () => {
  const many = Array.from({ length: MAX_TASKS + 5 }, (_, i) => ({ id: `t${i}`, description: 'x'.repeat(500), backgrounded: true }));
  const s = summarizeKilledTasks(many);
  assert.equal(s.length, MAX_TASKS);
  assert.equal(s[0].description.length, MAX_DESC);
  const w = summarizeKilledTasks([
    { id: 'a', description: 'bash scripts/lib/wait-for-run.sh 123', backgrounded: true },
    { id: 'b', description: 'node scripts/enrich-card-acceptance.js\n--limit 200', backgrounded: true },
  ]);
  assert.equal(w[0].wait, true);
  assert.equal(w[1].wait, false);
  assert.equal(w[1].description, 'node scripts/enrich-card-acceptance.js --limit 200');
  assert.deepEqual(summarizeKilledTasks(undefined), []);
});

test('ledger fragment carries the full count even when the summary is capped', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, description: 'd', backgrounded: true }));
  const f = killedTasksLedgerFields(many);
  assert.equal(f.killedBackgroundTaskCount, 12);
  assert.equal(f.killedBackgroundTasks.length, MAX_TASKS);
});

test('a kill between two result events is mid-session, not teardown (BRO-2741 review)', async () => {
  // Background-task notifications start new turns, so one run can emit several
  // result events. Only kills after the FINAL result count.
  const r = await run([START, RESULT, KILLED, RESULT]);
  assert.deepEqual(r.killedTasks, []);
  const r2 = await run([START, RESULT, KILLED, RESULT, KILLED]);
  assert.equal(r2.killedTasks.length, 1);
});

test('inline credentials in a task description are redacted before reaching the ledger', () => {
  const [t] = summarizeKilledTasks([{ id: 'a', description: 'OPENAI_API_KEY=sk-abc123 node x.js --token=zzz', backgrounded: true }]);
  assert.ok(!/sk-abc123|zzz/.test(t.description), t.description);
  assert.match(t.description, /\[redacted\] node x\.js/);
});
