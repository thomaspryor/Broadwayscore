// BRO-6717: child sessions go idle with jobs "still running" and the parent
// never finds out. Fixtures: scripts/lib/fixtures/bro-6518-idle/turns.json
// (RECONSTRUCTED from BRO-6518's two idle turns; see its _note).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const { decide } = require('./child-idle-watch.js');
const { childJobsDecision, parentWatchDecision, childWaitDecision, decideAll } = require('./child-session-wait-guard.js');
const FX = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'bro-6518-idle', 'turns.json'), 'utf8'));
const [TURN1, TURN2] = FX.turns;
const childInput = (turn, extra = {}) => ({ firstPrompt: FX.firstPrompt, env: {}, closing: turn.closing, tools: turn.tools, done: turn.done, ...extra });
const WATCH = (idx, extra = {}) => ({ idx, name: 'Bash', ok: true, taskId: 'bw' + idx,
  input: { command: `node scripts/lib/child-idle-watch.js watch --session ${FX.childSessionId} --minutes 30`, run_in_background: true, ...extra } });
const POLL = { idx: 90, name: 'Bash', ok: true, taskId: 'bpoll', input: { command: 'until [ ! -s /tmp/tic-queue.txt ]; do sleep 120; done', run_in_background: true } };

// ─── Child side (CHILDJOBS) ──────────────────────────────────────────────────
test('BRO-6518 turn 1 (23:52Z Oct 29): KEEP OPEN on jobs, loop + crawl nohup-launched → refused', () => {
  const r = childJobsDecision(childInput(TURN1));
  assert.equal(r.block, true, r.reason);
  // The older CI-only gate let this through: that is the gap.
  assert.equal(childWaitDecision(childInput(TURN1)).block, false);
});

test('BRO-6518 turn 2 (18:17Z Oct 30): a background launcher of a nohup loop, no notice → still refused', () => {
  assert.equal(childJobsDecision(childInput(TURN2)).block, true);
});

test('a live background poll or Monitor passes; a finished or stopped one does not', () => {
  assert.equal(childJobsDecision(childInput(TURN2, { tools: [...TURN2.tools, POLL] })).block, false);
  const mon = { idx: 91, name: 'Monitor', ok: true, taskId: 'm1', input: { command: 'tail -f /tmp/ingest-loop.log' } };
  assert.equal(childJobsDecision(childInput(TURN2, { tools: [...TURN2.tools, mon] })).block, false);
  assert.equal(childJobsDecision(childInput(TURN2, { tools: [...TURN2.tools, POLL], done: ['bpoll'] })).block, true);
});

test('not a child, not KEEP OPEN, nothing pending, or waiting on someone else → not this gate', () => {
  assert.equal(childJobsDecision(childInput(TURN1, { firstPrompt: 'please fix the hub' })).block, false, 'human session');
  assert.equal(childJobsDecision(childInput(TURN1, { firstPrompt: 'x', env: { CLAUDE_PARENT_SESSION_ID: 'session_x' } })).block, true, 'parent id in env marks a child');
  assert.equal(childJobsDecision(childInput(TURN1, { closing: 'Handed the queue to the tic-daily pending queue.\n\nSAFE TO ARCHIVE — the daily workflow drains it.' })).block, false);
  for (const c of [
    'Still running: nothing, the ingest loop finished.\n\nKEEP OPEN — waiting on the parent to pick the next city.',
    'Nothing is still running.\n\nKEEP OPEN — the parent asked me to hold for its review.',
    'Still running: no jobs are running.\n\nKEEP OPEN — waiting on the owner.',
  ]) assert.equal(childJobsDecision(childInput(TURN1, { closing: c })).block, false, c);
});

test('wording variants of a jobs wait are caught', () => {
  for (const c of [
    'KEEP OPEN — the crawl is still going.',
    'KEEP OPEN — waiting on the ingest batches.',
    'Still running: 3 scrapers in flight.\n\nKEEP OPEN — will check back.',
    'NOT SAFE TO EXIT — the backfill is running.',
  ]) assert.equal(childJobsDecision(childInput(TURN1, { closing: c })).block, true, c);
});

// ─── Parent side (CHILDWATCH + child-idle-watch.js) ──────────────────────────
const LIVE = [`session ${FX.childSessionId} "BRO-6498: Chicago local shows backfill"`];

test('parent KEEP OPEN on a live child with no watcher → refused; with a live watcher → passes', () => {
  const base = { closing: FX.parent.closing, tools: [], done: [], liveChildren: LIVE };
  assert.equal(parentWatchDecision(base).block, true);
  assert.equal(parentWatchDecision({ ...base, tools: [WATCH(5)] }).block, false);
  assert.equal(parentWatchDecision({ ...base, tools: [WATCH(5)], done: ['bw5'] }).block, true, 'a watch that already woke must be re-armed');
  assert.equal(parentWatchDecision({ ...base, tools: [POLL] }).block, true, 'another background task is not a child watch');
  assert.equal(parentWatchDecision({ ...base, liveChildren: [] }).block, false, 'child already finished');
  assert.equal(parentWatchDecision({ ...base, closing: 'The child owns it end to end.\n\nSAFE TO ARCHIVE — it lands its own work.' }).block, false);
});

test('decideAll: first blocking gate wins; skipped codes are not evaluated', () => {
  assert.equal(decideAll(childInput(TURN1)).code, 'CHILDJOBS');
  assert.equal(decideAll({ ...childInput(TURN1), skip: ['CHILDJOBS'] }).block, false);
  assert.equal(decideAll({ closing: FX.parent.closing, tools: [], done: [], liveChildren: LIVE }).code, 'CHILDWATCH');
});

test('BRO-6518 parent: idle child with no report is flagged at the first wake past 30 min', () => {
  const idleSince = Date.parse(TURN1.endedAt);
  const at = (min) => decide({ session: FX.parent.getSessionWhileIdle, now: idleSince + min * 60000 });
  // Watch armed when the parent ended its turn; the child idles at 23:52Z.
  const early = at(10);
  assert.equal(early.action, 'rearm');
  assert.equal(early.rearmMinutes, 20, 'next wake lands exactly at the 30 min threshold');
  assert.equal(at(30).action, 'nudge');
  // Worst case the parent wakes 30 min (one watch) after the threshold, never 17h.
  assert.equal(at(17 * 60).action, 'nudge');
});

test('decide: working child rearms; finished, failed or reported children end the watch', () => {
  const s = (bucket, extra = {}) => ({ ccr: { id: FX.childSessionId, status_bucket: `SESSION_STATUS_BUCKET_${bucket}`, updated_at: '2026-10-30T00:00:00Z', ...extra } });
  const now = '2026-10-30T05:00:00Z';
  assert.equal(decide({ session: s('WORKING'), now }).action, 'rearm');
  assert.equal(decide({ session: s('COMPLETED'), now }).action, 'done');
  assert.equal(decide({ session: s('REVIEW_READY'), now }).action, 'done');
  assert.equal(decide({ session: s('FAILED'), now }).action, 'restart');
  assert.equal(decide({ session: s('IDLE'), now, reportedAt: '2026-10-30T00:05:00Z' }).action, 'done');
  assert.equal(decide({ session: s('IDLE'), now, reportedAt: '2026-10-29T20:00:00Z' }).action, 'nudge', 'a report older than the last activity does not count');
  assert.equal(decide({ session: { status_bucket: 'IDLE' }, now }).action, 'nudge', 'no updated_at: nudge rather than wait forever');
});

test('CLI: check reads a saved get_session result; watch validates its arguments', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ciw-'));
  const f = path.join(dir, 's.json');
  fs.writeFileSync(f, JSON.stringify(FX.parent.getSessionWhileIdle));
  const cli = path.join(HERE, 'child-idle-watch.js');
  const r = spawnSync('node', [cli, 'check', '--from-json', f, '--now', '2026-10-30T00:30:00Z'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).action, 'nudge');
  assert.equal(spawnSync('node', [cli, 'watch', '--minutes', '30'], { encoding: 'utf8' }).status, 2, 'no --session');
  assert.equal(spawnSync('node', [cli, 'watch', '--session', 's', '--minutes', '200'], { encoding: 'utf8' }).status, 2, 'past the 2h background cap');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── End to end through the real Stop hook ───────────────────────────────────
const HOOK = path.join(REPO, '.claude', 'hooks', 'verify-edits.sh');
const OTHER_GATES_OFF = { LOOSEENDS_GATE_DISABLE: '1', PASSIVEOFFER_GATE_DISABLE: '1', WAKELESS_GATE_DISABLE: '1',
  CLEARCLOSE_GATE_DISABLE: '1', BOARD_GATE_DISABLED: '1', SHIP_CHECK_COVERAGE_DISABLE: '1' };

function runHook(firstPrompt, calls, closing, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ciw-hook-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ciw-home-'));
  const tp = path.join(dir, 'transcript.jsonl');
  const lines = [JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: firstPrompt }] } })];
  calls.forEach((c, i) => {
    const id = `tu-${i}`;
    lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: c.name, input: c.input }] } }));
    lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: c.result || 'ok' }] } }));
    if (c.notice) lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: c.notice } }));
  });
  fs.writeFileSync(tp, lines.join('\n') + '\n');
  const r = spawnSync('bash', [HOOK], {
    input: JSON.stringify({ transcript_path: tp, session_id: 'ciw-' + process.pid + '-' + Math.random(), stop_hook_active: false, last_assistant_message: closing }),
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, ...OTHER_GATES_OFF, ...env, HOME: home, CLAUDE_PROJECT_DIR: REPO },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  return r;
}
const bgResult = (id) => `Command running in background with ID: ${id}. Output is being written to: /tmp/${id}.output`;
const notice = (id) => `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n</task-notification>`;
const turnCalls = (turn) => turn.tools.map((t) => ({ name: t.name, input: t.input,
  result: t.taskId ? bgResult(t.taskId) : 'ok', notice: t.taskId && turn.done.includes(t.taskId) ? notice(t.taskId) : null }));

test('hook: a BRO-6518 child ending KEEP OPEN with no live background task is refused', { skip: !fs.existsSync(HOOK) && 'no repo hook' }, () => {
  for (const turn of [TURN1, TURN2]) {
    const r = runHook(FX.firstPrompt, turnCalls(turn), turn.closing);
    assert.equal(r.status, 2, `${turn.endedAt}: expected exit 2, got ${r.status}\n${r.stderr.slice(0, 600)}`);
    assert.match(r.stderr, /tic-daily pending queue/);
  }
  const ok = runHook(FX.firstPrompt, [...turnCalls(TURN2), { name: 'Bash', input: POLL.input, result: bgResult('bpoll') }], TURN2.closing);
  assert.equal(ok.status, 0, 'live background poll passes: ' + ok.stderr.slice(0, 400));
  assert.equal(runHook(FX.firstPrompt, turnCalls(TURN1), TURN1.closing, { CHILDJOBS_GATE_DISABLE: '1' }).status, 0, 'kill switch');
});

test('hook: a parent ending KEEP OPEN on a live child needs a child-idle-watch', { skip: !fs.existsSync(HOOK) && 'no repo hook' }, () => {
  const create = { name: 'mcp__Claude_Code_Remote__create_session', input: { title: 'BRO-6518: Chicago backfill', prompt: FX.firstPrompt },
    result: JSON.stringify({ id: FX.childSessionId, title: 'BRO-6518: Chicago backfill' }) };
  const r = runHook('Backfill Chicago (BRO-6498)', [create], FX.parent.closing);
  assert.equal(r.status, 2, r.stderr.slice(0, 600));
  assert.match(r.stderr, /child-idle-watch\.js watch/);
  const watch = { name: 'Bash', input: WATCH(0).input, result: bgResult('bwatch1') };
  assert.equal(runHook('Backfill Chicago (BRO-6498)', [create, watch], FX.parent.closing).status, 0, 'live watch passes');
  assert.equal(runHook('Backfill Chicago (BRO-6498)', [create], FX.parent.closing, { CHILDWATCH_GATE_DISABLE: '1' }).status, 0, 'kill switch');
});
