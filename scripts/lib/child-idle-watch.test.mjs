// scripts/lib/child-idle-watch.test.mjs (BRO-6717)
//
// BRO-6518's child session ended two turns claiming work was still running
// with nothing in its own session to wake it, and sat idle 17h, then 19h,
// while its parent waited on a report-back that never came. The closings and
// tool shapes below are the real ones from that transcript (trimmed).
//
// Child side: pure stopDecision cases, then the REAL Stop hook
// (.claude/hooks/verify-edits.sh, gate CHILDIDLE) run on transcripts of the
// two idle turns (BLOCK) and the 17:25Z turn that had a live Monitor (ALLOW).
// Parent side: childCheck on real get_session records (trimmed), and the
// `arm` timer actually exiting so a run_in_background parent is woken.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { spawnSyncStdinFile } from '../../tests/helpers/spawn-stdin-file.mjs';
import {
  stopDecision, claimsRunningWork, childCheck, parseSession, armDelayMs, IDLE_MINUTES, WORKING_RECHECK_MINUTES,
} from './child-idle-watch.mjs';

const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');
const HOOK = path.join(REPO_ROOT, '.claude', 'hooks', 'verify-edits.sh');
const CLI = path.join(REPO_ROOT, 'scripts', 'lib', 'child-idle-watch.mjs');

// ─── Real BRO-6518 closings ─────────────────────────────────────────────────
const CHILD_PROMPT = 'You are the worker for Linear card BRO-6518 (P1).\nDone means: ...\nBUDGET: 6h.\nREPORT-BACK: send_message @parent.';
// 2026-10-30T18:17:27Z, then idle until 2026-10-31T13:49Z.
const CLOSE_1817 = 'Chicago is done: the hub fix is live and 1,735 reviews are linked. Still going in the background: the review ingest for the Chicago shows (about 207 of 483 started) and the scoring that follows it.\n\nYou need to: nothing.\n\nKEEP OPEN — the review ingest and scoring are still running; I keep polling, then report the score count to the parent and start 2021-2023.';
// 2026-10-29T23:52:55Z, then idle until 2026-10-30T17:01Z.
const CLOSE_2352 = 'The land finished and the hub page is live.\n\nStill running: review scoring, the older-show crawl and the review-ingest dispatcher. I can\'t tell yet what wakes me when they finish, so I\'ll check back on them.\n\nNothing needed from you.\n\nKEEP OPEN — it waits on the review scoring and the older-show crawl, and I\'ll check back on them.';
// 2026-10-30T17:25Z: a Monitor "wait for hub land" was live. Correct.
const CLOSE_1725 = 'The hub fix is landing now.\n\nStill running: the land run for the hub fix.\n\nYou need to: nothing.\n\nKEEP OPEN — the hub land run is in progress; its Monitor wakes me when it finishes.';
const lastLine = (t) => t.trim().split('\n').pop();

// ─── Pure: stopDecision / claimsRunningWork ─────────────────────────────────
test('stopDecision: both BRO-6518 idle closings with nothing live → block', () => {
  for (const c of [CLOSE_1817, CLOSE_2352]) {
    const r = stopDecision({ firstPrompt: CHILD_PROMPT, closing: c, lastLine: lastLine(c), live: { waits: [], agents: [] } });
    assert.equal(r.block, true, r.reason);
  }
});

test('stopDecision: a live wait or background agent in this session → allow', () => {
  const base = { firstPrompt: CHILD_PROMPT, closing: CLOSE_1725, lastLine: lastLine(CLOSE_1725) };
  assert.equal(stopDecision({ ...base, live: { waits: ['Monitor "wait for hub land"'] } }).block, false);
  assert.equal(stopDecision({ ...base, live: { agents: ['Agent "scan" [a1b2c3]'] } }).block, false);
});

test('stopDecision: not a child session, NO-VERIFY, or no running-work claim → allow', () => {
  const c = CLOSE_1817;
  assert.equal(stopDecision({ firstPrompt: 'fix the homepage', closing: c, lastLine: lastLine(c) }).block, false, 'owner session');
  assert.equal(stopDecision({ firstPrompt: 'x', env: { CLAUDE_PARENT_SESSION_ID: 'session_01abc' }, closing: c, lastLine: lastLine(c) }).block, true, 'parent env marks a child');
  assert.equal(stopDecision({ firstPrompt: CHILD_PROMPT, closing: c + '\nNO-VERIFY: ingest is a workflow', lastLine: lastLine(c) }).block, false, 'NO-VERIFY');
  const done = 'Landed and verified.\n\nNothing is still running.\n\nNothing needed from you.\n\nSAFE TO ARCHIVE — done.';
  assert.equal(stopDecision({ firstPrompt: CHILD_PROMPT, closing: done, lastLine: lastLine(done) }).block, false);
});

test('claimsRunningWork: verdict or a non-empty Still running: line', () => {
  assert.equal(claimsRunningWork('x', 'KEEP OPEN — waiting').claims, true);
  assert.equal(claimsRunningWork('x', 'NOT SAFE TO EXIT — waiting').claims, true);
  // The hand-off the block message asks for: SAFE + a Still running line naming what owns the work.
  assert.equal(claimsRunningWork('Still running: tic-daily finishes the queue overnight.\n\nSAFE TO ARCHIVE — handed off', 'SAFE TO ARCHIVE — handed off').claims, false, 'SAFE hand-off');
  assert.equal(claimsRunningWork('Still running: the crawl.\n\nNothing needed from you.', '').claims, true, 'no verdict + running line claims');
  for (const none of ['Still running: nothing.', 'Still running: none', 'Still running: nothing here', 'Nothing is still running.',
    '**Still running:** nothing', '**Still running**: none', 'Still running: -', 'Still running: —', 'Still running: (none)', 'Still running: no.', 'Still running: n/a']) {
    assert.equal(claimsRunningWork(none + '\n\nYou need to: nothing.', 'You need to: nothing.').claims, false, none);
  }
  assert.equal(claimsRunningWork('**Still running:** the crawl', '').claims, true, 'bold running line still claims');
});

// ─── End to end through the real Stop hook ──────────────────────────────────
const WRITTEN = new Set();
after(() => {
  for (const t of WRITTEN) {
    const sum = spawnSync('bash', ['-c', 'printf "%s" "$1" | cksum | cut -d" " -f1', '_', t], { encoding: 'utf8' }).stdout.trim();
    fs.rmSync(`/tmp/verify-edits-chain-${sum}`, { force: true, recursive: true });
    fs.rmSync(path.dirname(t), { force: true, recursive: true });
  }
});

const tool = (name, input, result = 'ok') => ({ name, input, result, id: `tu-${randomUUID()}` });
const notice = (text) => ({ notice: text });
function transcript(items, firstPrompt = CHILD_PROMPT) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'child-idle-'));
  const p = path.join(dir, 'transcript.jsonl');
  WRITTEN.add(p);
  const lines = [JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: firstPrompt }] } })];
  for (const it of items) {
    if (it.notice) { lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: it.notice } })); continue; }
    lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: it.id, name: it.name, input: it.input }] } }));
    lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: it.id, content: it.result }] } }));
  }
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}
// Every other closing gate off, so only CHILDIDLE decides.
const OTHERS_OFF = Object.fromEntries(['BOARD_GATE_DISABLED', 'CARD_GATE_DISABLE', 'CHILDWAIT_GATE_DISABLE', 'CLEARCLOSE_GATE_DISABLE',
  'CLOUD_CHAIN_GATE_DISABLE', 'INFLIGHT_GATE_DISABLE', 'LOOSEENDS_GATE_DISABLE', 'OPENWORK_GATE_DISABLE', 'PASSIVEOFFER_GATE_DISABLE',
  'PR_FOLLOWTHROUGH_GATE_DISABLE', 'SESSION_STATUS_GATE_DISABLE', 'WAKELESS_GATE_DISABLE', 'WRAPUP_GATE_DISABLE', 'SHIP_CHECK_COVERAGE_DISABLE']
  .map((k) => [k, '1']));
function runHook(t, lastMsg, env = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'child-idle-home-'));
  try {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.endsWith('PARENT_SESSION_ID')));
    const r = spawnSyncStdinFile('bash', [HOOK], {
      input: JSON.stringify({ transcript_path: t, session_id: `ci-${randomUUID()}`, stop_hook_active: false, last_assistant_message: lastMsg }),
      encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL',
      env: { ...clean, ...OTHERS_OFF, CHILDIDLE_GATE_DISABLE: '0', ...env, HOME: home },
    });
    return { status: r.status, stderr: r.stderr || '' };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}
const isChildIdleBlock = (r) => r.status === 2 && /nothing running in THIS session will wake it/.test(r.stderr);

// Real result shapes: run_in_background Bash, Monitor receipt, their end notices.
const bgBash = (id, cmd, desc) => tool('Bash', { command: cmd, run_in_background: true, timeout: 7200000, description: desc },
  `Command running in background with ID: ${id}. Output is being written to: /tmp/claude-0/p/s/tasks/${id}.output`);
const bgDone = (id, desc) => notice(`<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_${id}</tool-use-id>\n<output-file>/tmp/claude-0/p/s/tasks/${id}.output</output-file>\n<status>completed</status>\n<summary>Background command "${desc}" completed (exit code 0)</summary>\n</task-notification>`);
const monitor = (id, desc) => tool('Monitor', { command: 'until [ -s /tmp/out ]; do sleep 30; done; cat /tmp/out', description: desc },
  `Monitor started (task ${id}, expires in 1800s). You will be notified on each event. Keep working; do not poll or sleep.`);
const monitorEvent = (id, desc) => notice(`<task-notification>\n<task-id>${id}</task-id>\n<summary>Monitor event: "${desc}"</summary>\n<event>queued</event>\n</task-notification>`);
const monitorEnded = (id, desc) => notice(`<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_${id}</tool-use-id>\n<output-file>/tmp/claude-0/p/s/tasks/${id}.output</output-file>\n<status>completed</status>\n<summary>Monitor "${desc}" stream ended</summary>\n</task-notification>`);
const detachedIngest = tool('Bash', { command: 'setsid nohup bash /tmp/claude-0/probe/ingest-all.sh > /tmp/claude-0/probe/ingest.log 2>&1 &', description: 'start Chicago review ingest' }, '');

test('hook: BRO-6518 18:17Z replay (three finished Monitors + a setsid ingest) → CHILDIDLE blocks', () => {
  const t = transcript([
    detachedIngest,
    monitor('bm1a7x2q0', 'wait for ingest batch 1'), monitorEvent('bm1a7x2q0', 'wait for ingest batch 1'), monitorEnded('bm1a7x2q0', 'wait for ingest batch 1'),
    monitor('bm2b8y3r1', 'wait for hub land'), monitorEnded('bm2b8y3r1', 'wait for hub land'),
    monitor('bm3c9z4s2', 'wait for scoring batch'), monitorEnded('bm3c9z4s2', 'wait for scoring batch'),
    tool('Bash', { command: 'tail -3 /tmp/claude-0/probe/ingest.log' }, '207/483 started'),
  ]);
  const r = runHook(t, CLOSE_1817);
  assert.ok(isChildIdleBlock(r), `expected CHILDIDLE block, got ${r.status}: ${r.stderr.slice(0, 400)}`);
  assert.match(r.stderr, /tic-daily|workflow/, 'names the durable hand-off');
});

test('hook: BRO-6518 23:52Z replay (woken by its land wait, then only foreground checks) → CHILDIDLE blocks', () => {
  const t = transcript([
    monitor('bp0q1r2s3', 'wait for live-site probe output'), monitorEnded('bp0q1r2s3', 'wait for live-site probe output'),
    detachedIngest,
    bgBash('b22wybefn', 'node scripts/lib/wait-for-land.js land/bro-6518-hub 60 --prod', 'wait for land'),
    bgDone('b22wybefn', 'wait for land'),
    tool('Bash', { command: 'tail -20 /tmp/claude-0/land-wait.log' }, 'LANDED'),
    tool('Bash', { command: 'pgrep -af "crawl|ingest"' }, '4242 bash /tmp/claude-0/probe/ingest-all.sh'),
  ]);
  const r = runHook(t, CLOSE_2352);
  assert.ok(isChildIdleBlock(r), `expected CHILDIDLE block, got ${r.status}: ${r.stderr.slice(0, 400)}`);
});

test('hook: 17:25Z shape (Monitor still live) → allowed; a Monitor event line does not end it', () => {
  const t = transcript([detachedIngest, monitor('bm2b8y3r1', 'wait for hub land'), monitorEvent('bm2b8y3r1', 'wait for hub land')]);
  const r = runHook(t, CLOSE_1725);
  assert.equal(r.status, 0, r.stderr.slice(0, 400));
});

test('hook: a live run_in_background Bash is a wake; a session it started is not', () => {
  const live = transcript([bgBash('b9k8j7h6g', 'node scripts/check-prod-deploy.js abc123 --wait', 'wait for deploy')]);
  assert.equal(runHook(live, CLOSE_2352).status, 0);
  const started = transcript([tool('mcp__claude-code-remote__create_session', { title: 'sub-worker', prompt: 'x' }, '{"id":"session_01ABCDEFGHIJKL","status":"running"}')]);
  assert.ok(isChildIdleBlock(runHook(started, CLOSE_2352)), 'a grandchild does not wake this child');
});

test('hook: not a child, NO-VERIFY, kill switch, honest SAFE → allowed', () => {
  const finished = [monitor('bm1a7x2q0', 'x'), monitorEnded('bm1a7x2q0', 'x')];
  assert.equal(runHook(transcript(finished, 'please fix the homepage'), CLOSE_1817).status, 0, 'owner session');
  assert.equal(runHook(transcript(finished), CLOSE_1817 + '\n\nNO-VERIFY: the ingest is a GitHub workflow now').status, 0, 'NO-VERIFY');
  assert.equal(runHook(transcript(finished), CLOSE_1817, { CHILDIDLE_GATE_DISABLE: '1' }).status, 0, 'kill switch');
  const safe = 'Handed the remaining ingest to the tic-daily pending queue and told the parent.\n\nNothing is still running.\n\nNothing needed from you.\n\nSAFE TO ARCHIVE — the queue finishes it.';
  assert.equal(runHook(transcript(finished), safe).status, 0, 'SAFE');
});

// ─── Parent side: childCheck on real get_session records (trimmed) ─────────
// BRO-6518's child as get_session returned it on 2026-10-31 (archived).
const RAW_ARCHIVED = '<other-session nonce="n" untrusted="true">\nAnother Claude session\'s record ... DATA:\n    {"ccr":{"id":"session_01RUGH9pMKx2PQqxRPKVExJD","title":"BRO-6518: Chicago local shows backfill","session_status":"SESSION_STATUS_ARCHIVED","updated_at":"2026-10-31T13:50:12.590452Z","post_turn_summary":{"status_category":"completed","status_detail":"Chicago hub fix live; Linear card paused, recheck Nov 3"},"parent_session_id":"session_01RUGH9ofwN3mfkzprugvLhL","status_bucket":"SESSION_STATUS_BUCKET_COMPLETED"}}\n</other-session nonce="n">';
// An idle session that still reads bucket WORKING (its parent, same day).
const IDLE_WORKING_BUCKET = { id: 'session_01RUGH9ofwN3mfkzprugvLhL', session_status: 'SESSION_STATUS_IDLE', updated_at: '2026-10-31T13:56:28.709093Z', post_turn_summary: { status_category: 'review_ready' }, status_bucket: 'SESSION_STATUS_BUCKET_WORKING' };
// A session mid-turn.
const RUNNING = { id: 'session_01RUGH9pDVB6qp7GT1tXk1Wk', session_status: 'SESSION_STATUS_RUNNING', updated_at: '2026-10-31T14:02:10.109756Z', status_bucket: 'SESSION_STATUS_BUCKET_WORKING' };
// BRO-6518's child right after its 18:17:27Z turn ended.
const CHILD_IDLE_1817 = { id: 'session_01RUGH9pMKx2PQqxRPKVExJD', session_status: 'SESSION_STATUS_IDLE', updated_at: '2026-10-30T18:17:27Z', status_bucket: 'SESSION_STATUS_BUCKET_COMPLETED' };
const at = (iso, plusMin = 0) => Date.parse(iso) + plusMin * 60_000;

test('parseSession: reads the raw get_session tool text, frame and all', () => {
  const s = parseSession(RAW_ARCHIVED);
  assert.equal(s.id, 'session_01RUGH9pMKx2PQqxRPKVExJD');
  assert.equal(s.session_status, 'SESSION_STATUS_ARCHIVED');
});

test('childCheck: BRO-6518 idle child, no report → flagged at 30 min, not before', () => {
  const quiet = childCheck({ session: CHILD_IDLE_1817, now: at('2026-10-30T18:17:27Z', 10) });
  assert.equal(quiet.verdict, 'quiet');
  assert.equal(quiet.act, false);
  assert.equal(Date.parse(quiet.nextWakeAt), at('2026-10-30T18:17:27Z', IDLE_MINUTES), 're-arm lands exactly 30 min after it went quiet');
  const late = childCheck({ session: CHILD_IDLE_1817, now: at('2026-10-30T18:17:27Z', IDLE_MINUTES) });
  assert.equal(late.verdict, 'idle-no-report');
  assert.equal(late.act, true);
  assert.match(late.say, /send_message/);
});

test('childCheck: idle with bucket WORKING is idle, not working (real 2026-10-31 shape)', () => {
  const r = childCheck({ session: IDLE_WORKING_BUCKET, now: at('2026-10-31T13:56:28Z', 45) });
  assert.equal(r.verdict, 'idle-no-report');
});

test('childCheck: running → re-arm in 20 min; reported after its last turn → act on the report', () => {
  const now = at('2026-10-31T14:02:10Z', 1);
  const w = childCheck({ session: RUNNING, now });
  assert.equal(w.verdict, 'working');
  assert.equal(Date.parse(w.nextWakeAt), now + WORKING_RECHECK_MINUTES * 60_000);
  const rep = childCheck({ session: CHILD_IDLE_1817, now: at('2026-10-30T18:17:27Z', 90), lastReportAt: '2026-10-30T18:17:40Z' });
  assert.equal(rep.verdict, 'reported');
  assert.equal(rep.act, false);
  const stale = childCheck({ session: CHILD_IDLE_1817, now: at('2026-10-30T18:17:27Z', 90), lastReportAt: '2026-10-30T12:00:00Z' });
  assert.equal(stale.verdict, 'idle-no-report', 'a report from an earlier turn does not cover this one');
});

test('childCheck: unknown live status is not idle; a report made minutes before its last activity counts', () => {
  const now = at('2026-10-31T13:56:28Z', 90);
  assert.equal(childCheck({ session: { ...IDLE_WORKING_BUCKET, session_status: 'SESSION_STATUS_QUEUED' }, now }).verdict, 'working');
  const rep = new Date(Date.parse('2026-10-31T13:56:28Z') - 8 * 60_000).toISOString();
  assert.equal(childCheck({ session: IDLE_WORKING_BUCKET, now, lastReportAt: rep }).verdict, 'reported', 'wrap-up after the report');
  const old = new Date(Date.parse('2026-10-31T13:56:28Z') - 40 * 60_000).toISOString();
  assert.equal(childCheck({ session: IDLE_WORKING_BUCKET, now, lastReportAt: old }).verdict, 'idle-no-report', 'report long before more work');
});

test('parseSession: a brace in the frame before the record; check: bad file exits 2', () => {
  assert.equal(parseSession('note {see below}\n{"ccr":{"id":"session_x1234567890"}}').id, 'session_x1234567890');
  const r = spawnSync('node', [CLI, 'check', '--session-json', '/nonexistent/x.json'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});

test('childCheck: archived, failed, blocked', () => {
  assert.equal(childCheck({ session: parseSession(RAW_ARCHIVED) }).verdict, 'gone');
  assert.equal(childCheck({ session: parseSession(RAW_ARCHIVED), lastReportAt: '2026-10-31T13:49:00Z' }).verdict, 'reported');
  assert.equal(childCheck({ session: { ...CHILD_IDLE_1817, status_bucket: 'SESSION_STATUS_BUCKET_FAILED' } }).verdict, 'failed');
  assert.equal(childCheck({ session: { ...RUNNING, status_bucket: 'SESSION_STATUS_BUCKET_BLOCKED' } }).verdict, 'blocked');
});

test('a parent watching an idle child is woken within 30 min (worst case: child goes idle right after a check)', () => {
  // Check at T sees it running; the child goes idle at T+1s. Next wake at
  // T+20; that check sees it quiet and re-arms to idle+30; that wake flags it.
  const T = at('2026-10-30T17:47:27Z');
  const first = childCheck({ session: { ...CHILD_IDLE_1817, session_status: 'SESSION_STATUS_RUNNING', updated_at: '2026-10-30T17:47:27Z' }, now: T });
  const idleAt = T + 1000;
  const second = childCheck({ session: { ...CHILD_IDLE_1817, updated_at: new Date(idleAt).toISOString() }, now: Date.parse(first.nextWakeAt) });
  assert.equal(second.verdict, 'quiet');
  const third = childCheck({ session: { ...CHILD_IDLE_1817, updated_at: new Date(idleAt).toISOString() }, now: Date.parse(second.nextWakeAt) });
  assert.equal(third.verdict, 'idle-no-report');
  assert.ok(Date.parse(second.nextWakeAt) - idleAt <= IDLE_MINUTES * 60_000 + 1000, 'flagged within 30 min of going idle');
});

// ─── CLI ────────────────────────────────────────────────────────────────────
test('armDelayMs: --until, --minutes, clamped to [2, 110] min', () => {
  const now = Date.parse('2026-10-31T14:00:00Z');
  assert.equal(armDelayMs(['--until', '2026-10-31T14:30:00Z'], now), 30 * 60_000);
  assert.equal(armDelayMs(['--minutes', '5'], now), 5 * 60_000);
  assert.equal(armDelayMs(['--minutes', '0'], now), 2 * 60_000);
  assert.equal(armDelayMs(['--until', '2026-11-02T00:00:00Z'], now), 110 * 60_000);
});

test('CLI arm: rejects a bad child id; check: exit 3 when the parent must act, rearm command otherwise', () => {
  const bad = spawnSync('node', [CLI, 'arm', '--child', 'x; rm -rf /'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'child-idle-cli-'));
  try {
    const f = path.join(dir, 's.json');
    fs.writeFileSync(f, RAW_ARCHIVED);
    const act = spawnSync('node', [CLI, 'check', '--session-json', f], { encoding: 'utf8' });
    assert.equal(act.status, 3, act.stderr);
    assert.equal(JSON.parse(act.stdout).verdict, 'gone');
    fs.writeFileSync(f, JSON.stringify({ ...RUNNING, updated_at: new Date().toISOString() }));
    const ok = spawnSync('node', [CLI, 'check', '--session-json', f], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(JSON.parse(ok.stdout).rearm, /^node scripts\/lib\/child-idle-watch\.mjs arm --child session_01RUGH9pDVB6qp7GT1tXk1Wk --until /);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI stop-decision: fails open on bad input', () => {
  const r = spawnSync('node', [CLI, 'stop-decision'], { input: 'not json', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).block, false);
});
