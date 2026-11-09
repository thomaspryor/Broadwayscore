// stall-stop-gate.js (BRO-7195): WAKEPROMISE for Mac sessions outside Broadwayscore.
// Unit tests of the decision and liveness parse, plus a pattern-parity check against the repo
// hook (both must read wake-promise-patterns.json and match the same way).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const G = require('./stall-stop-gate.js');
const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');

const T0 = Date.parse('2026-11-08T12:00:00Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();
const human = (text, min = 0) => ({ type: 'user', timestamp: at(min), message: { role: 'user', content: text } });
const say = (text, min) => ({ type: 'assistant', timestamp: at(min), message: { content: [{ type: 'text', text }] } });
const call = (id, name, input, min) => ({ type: 'assistant', timestamp: at(min), message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, content, min) => ({ type: 'user', timestamp: at(min), message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });
const notice = (toolUseId, taskId, min, status = 'completed') => human(`<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n</task-notification>`, min);
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const decide = (rows, nowMin = 30) => {
  const p = G.parseTranscript(jsonl(rows));
  return G.wakePromiseDecision({ closing: p.closing, live: G.liveWork({ ...p, nowMs: T0 + nowMin * 60000 }) });
};
const bgBash = (id, task, min) => [call(id, 'Bash', { command: 'npm test', run_in_background: true }, min),
  result(id, `Command running in background with ID: ${task}. Output is being written to: /tmp/x`, min)];

test('the acceptance case: "I will check back" with nothing running is blocked', () => {
  const d = decide([human('fix the flaky test'), say('Pushed the fix. I will check back once CI finishes.', 5)]);
  assert.equal(d.block, true);
  assert.match(d.phrase, /I will check back/);
});

test('a live background Bash (no completion notice) passes', () => {
  assert.equal(decide([human('go'), ...bgBash('t1', 'bq1x7k2m9', 1), say("Tests are running. I'll check back when they finish.", 2)]).block, false);
});

test('a background Bash that already notified is not live', () => {
  const rows = [human('go'), ...bgBash('t1', 'bq1x7k2m9', 1), notice('t1', 'bq1x7k2m9', 3), say("Done. I'll check back later.", 4)];
  assert.equal(decide(rows).block, true);
});

test('a TaskStop on the task id ends it', () => {
  const rows = [human('go'), ...bgBash('t1', 'bq1x7k2m9', 1), call('t2', 'TaskStop', { task_id: 'bq1x7k2m9' }, 2), result('t2', 'stopped', 2), say("I'll check back.", 3)];
  assert.equal(decide(rows).block, true);
});

test('a background task long past its timeout is not live', () => {
  const rows = [human('go'), ...bgBash('t1', 'bq1x7k2m9', 1), say("I'll keep an eye on it.", 2)];
  assert.equal(decide(rows, 1 + 3 * 60).block, true);
  assert.equal(decide(rows, 30).block, false);
});

test('a Monitor <event> is progress, not completion', () => {
  const rows = [human('go'), call('m1', 'Monitor', { command: 'until x; do sleep 2; done' }, 1), result('m1', 'Monitor started (task mon1abcd)', 1),
    human('<task-notification>\n<task-id>mon1abcd</task-id>\n<event>tick</event>\n</task-notification>', 2), say("I'm monitoring the deploy.", 3)];
  assert.equal(decide(rows).block, false);
});

test('a ScheduleWakeup armed in an EARLIER turn still counts until it fires (reviewer blocker 4)', () => {
  const rows = [human('loop'), call('w1', 'ScheduleWakeup', { delaySeconds: 1800, prompt: 'x', reason: 'ci' }, 1), result('w1', 'scheduled', 1),
    say('ok', 2), human('status?', 5), say("I'll check back on it.", 6)];
  assert.equal(decide(rows, 10).block, false);
  assert.equal(decide(rows, 60).block, true); // fired long ago and nothing re-armed
});

test('a background Agent with no report yet is live; a foreground report is not', () => {
  const bg = [human('go'), call('a1', 'Agent', { prompt: 'review', description: 'r' }, 1), result('a1', 'Async agent launched successfully. agentId: ag1abcde', 1), say("I'll report back when the review lands.", 2)];
  assert.equal(decide(bg).block, false);
  assert.equal(decide(bg, 1 + 7 * 60).block, true, 'a background agent silent 6h+ is not live');
  // Codex review: a foreground agent with the flag omitted and a long (truncated) report is not live.
  const longFg = [human('go'), call('a1', 'Agent', { prompt: 'review', description: 'r' }, 1), result('a1', 'x'.repeat(5000) + ' <usage>', 3), say("I'll report back.", 4)];
  assert.equal(decide(longFg).block, true);
  const fg = [human('go'), call('a1', 'Agent', { prompt: 'review', description: 'r', run_in_background: false }, 1), result('a1', 'Findings... agentId: ag1 <usage>subagent_tokens: 5</usage>', 3), say("I'll report back.", 4)];
  assert.equal(decide(fg).block, true);
});

test('exempt: a question, DECISION NEEDED, "You need to:", NO-VERIFY:, a quoted phrase', () => {
  const base = [human('go')];
  assert.equal(decide([...base, say("I'll check back after.\n\nShould I also bump the version?", 1)]).block, false);
  assert.equal(decide([...base, say("I'll follow up.\nDECISION NEEDED: pick a name", 1)]).block, false);
  assert.equal(decide([...base, say("I'll follow up.\nYou need to: approve the email", 1)]).block, false);
  assert.equal(decide([...base, say("I'll follow up.\nYou need to: nothing", 1)]).block, true);
  assert.equal(decide([...base, say("I'll follow up.\nNO-VERIFY: describing the old behaviour", 1)]).block, false);
  assert.equal(decide([...base, say('Sessions used to end with "I\'ll check back" and nothing armed.', 1)]).block, false);
});

test('only the final closing counts: a promise before later tool calls is not the closing', () => {
  const rows = [human('go'), say("I'll check back after the build.", 1), call('b', 'Bash', { command: 'npm run build' }, 2), result('b', 'ok', 3), say('Build passed; all done.', 4)];
  assert.equal(decide(rows).block, false);
});

test('pattern parity: the repo hook and this gate read the same pattern file and agree', () => {
  const hook = fs.readFileSync(path.join(REPO_ROOT, '.claude', 'hooks', 'verify-edits.sh'), 'utf8');
  assert.match(hook, /wake-promise-patterns\.json/, 'verify-edits.sh must load the shared pattern, not a private copy');
  assert.doesNotMatch(hook, /_PROMISE_RE = re\.compile\(r"/, 'an inline Python copy of the promise regex came back');
  const corpus = ["I'll check back", 'I will report back', 'I’m continuing with Boston', 'once it lands I\'ll merge', 'the routine will continue', "I'll fix it now", 'I am going to keep monitoring', "I'm watching for the deploy"];
  const py = spawnSync('python3', ['-c', `import json,re,sys\np=json.load(open(sys.argv[1]))['promise']\nprint(json.dumps([bool(re.search(p,s,re.I)) for s in json.loads(sys.argv[2])]))`,
    path.join(REPO_ROOT, 'scripts', 'lib', 'wake-promise-patterns.json'), JSON.stringify(corpus)], { encoding: 'utf8' });
  assert.equal(py.status, 0, py.stderr);
  assert.deepEqual(JSON.parse(py.stdout), corpus.map((s) => G.PROMISE_RE.test(s)));
  assert.deepEqual(corpus.map((s) => G.PROMISE_RE.test(s)), [true, true, true, true, false, false, true, true]);
});

test('a URL with ? in the last paragraph is not a question', () => {
  assert.equal(decide([human('go'), say("I'll check back.\n\nRun: https://github.com/x/actions/runs?id=9", 1)]).block, true);
});
