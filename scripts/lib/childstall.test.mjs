// CHILDSTALL (BRO-7183): a create_session child (prompt has a REPORT-BACK:
// line) must not end a turn with nothing live and nothing sent to @parent.
// Unit replays of the decision in child-session-wait-guard.js, then end-to-end
// runs of the real .claude/hooks/verify-edits.sh on transcript fixtures built
// from the two real cases:
//   BRO-6854 child session_01RUGH9nZ4r2135i1PwwSwzP, last turn 2026-11-03T03:50:58Z:
//     "I'm continuing with the rest of the Boston pipeline ... KEEP OPEN —
//     Boston is mid-build", no live task (an old background Bash with no
//     completion notice made WAKELESS read it as live), idle 6 days.
//   BRO-6833 child session_01RUGH9nqhU4ZVLF1pwXcViK, ~2026-11-02T14:40Z: the
//     final report went out through SendMessage, which never reaches the parent.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSyncStdinFile } from '../../tests/helpers/spawn-stdin-file.mjs';

const { childStallDecision, decideAll } = createRequire(import.meta.url)('./child-session-wait-guard.js');
const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');
const HOOK = path.join(REPO_ROOT, '.claude', 'hooks', 'verify-edits.sh');

const CHILD_PROMPT = 'BRO-6854: launch San Diego and Boston\nBUDGET: 6h\nREPORT-BACK: as your very last action, call mcp__claude-code-remote__send_message with session_id "@parent".\n';
const STALL_AT = Date.parse('2026-11-03T03:50:58Z');
const MIN = 60000;
const bash = (idx, command, extra = {}, more = {}) => ({ idx, name: 'Bash', input: { command, ...extra }, ok: true, ...more });
const send = (idx, message, more = {}) => ({ idx, name: 'mcp__claude-code-remote__send_message', input: { session_id: '@parent', message }, ok: true, ...more });

// BRO-6854's final turn: an old background run poller (no completion notice,
// long past its timeout), a foreground scoring dispatch, then the stop.
const bro6854 = {
  firstPrompt: CHILD_PROMPT, env: {}, reportBack: true, stall: true, keepOpen: true, now: STALL_AT,
  anchor: -1, done: [],
  tools: [
    bash(4, 'node scripts/lib/wait-for-land.js land/bro-6854-sd 60', { run_in_background: true }, { taskId: 'bq1', startedAt: STALL_AT - 150 * MIN }),
    bash(9, 'gh workflow run llm-scoring.yml -f show=boston'),
  ],
};

test('BRO-6854 replay: stop with nothing live and no report is blocked', () => {
  const r = childStallDecision(bro6854);
  assert.equal(r.block, true);
  assert.equal(decideAll({ ...bro6854, keepOpen: false }).code, 'CHILDSTALL');
});
test('a REPORT-BACK send_message to @parent passes', () => {
  assert.equal(childStallDecision({ ...bro6854, tools: [...bro6854.tools, send(10, 'REPORT-BACK BRO-6854: landed abc123')] }).block, false);
});
test('a status ping naming the card, or a URL with ?, is not a report (reviewer P1)', () => {
  assert.equal(childStallDecision({ ...bro6854, tools: [...bro6854.tools, send(10, 'BRO-6854: SD landed, starting Boston')] }).block, true);
  assert.equal(childStallDecision({ ...bro6854, tools: [...bro6854.tools, send(10, 'run https://x/runs?id=9 green')] }).block, true);
});
test('a live background Agent, PR watch or trigger passes (otherLive)', () => {
  assert.equal(childStallDecision({ ...bro6854, otherLive: true }).block, false);
});
test('an owner question to @parent passes (the reply wakes the child)', () => {
  assert.equal(childStallDecision({ ...bro6854, tools: [...bro6854.tools, send(10, 'DECISION NEEDED: launch Boston with 40 shows or wait?')] }).block, false);
});
test('a status note to @parent with no report or question does not pass', () => {
  assert.equal(childStallDecision({ ...bro6854, tools: [...bro6854.tools, send(10, 'Boston still building')] }).block, true);
});
test('a denied send_message (PreToolUse refusal) does not count', () => {
  assert.equal(childStallDecision({ ...bro6854, tools: [...bro6854.tools, send(10, 'REPORT-BACK BRO-6854: x', { ok: false })] }).block, true);
});
test('send_message to another session does not count; to the parent by id does', () => {
  const other = { ...send(10, 'REPORT-BACK BRO-6854: x'), input: { session_id: 'session_01OTHERxxxxxxxx', message: 'REPORT-BACK BRO-6854: x' } };
  assert.equal(childStallDecision({ ...bro6854, tools: [...bro6854.tools, other] }).block, true);
  assert.equal(childStallDecision({ ...bro6854, parentIds: ['session_01OTHERxxxxxxxx'], tools: [...bro6854.tools, other] }).block, false);
});
test('the Claude_Code_Remote spelling of send_message counts', () => {
  const t = { ...send(10, 'REPORT-BACK BRO-6854: x'), name: 'mcp__Claude_Code_Remote__send_message' };
  assert.equal(childStallDecision({ ...bro6854, tools: [...bro6854.tools, t] }).block, false);
});
test('BRO-6833 replay: report sent with SendMessage is blocked and names the tool', () => {
  const sm = { idx: 10, name: 'SendMessage', input: { to: 'parent', message: 'REPORT-BACK BRO-6833: done' }, ok: true };
  const r = childStallDecision({ ...bro6854, tools: [...bro6854.tools, sm] });
  assert.equal(r.block, true);
  assert.equal(r.wrongTool, true);
  assert.equal(decideAll({ ...bro6854, tools: [...bro6854.tools, sm] }).wrongTool, true);
});
test('a just-started Monitor passes; one with a completion notice does not', () => {
  const mon = { idx: 10, name: 'Monitor', input: { command: 'until done; do sleep 30; done' }, ok: true, taskId: 'm1', startedAt: STALL_AT - MIN };
  assert.equal(childStallDecision({ ...bro6854, tools: [...bro6854.tools, mon] }).block, false);
  assert.equal(childStallDecision({ ...bro6854, tools: [...bro6854.tools, mon], done: ['m1'] }).block, true);
});
test('a just-started background poll passes; a detached nohup launcher does not', () => {
  const poll = bash(10, 'gh run view 123 --json status', { run_in_background: true, timeout: 7200000 }, { taskId: 'p1', startedAt: STALL_AT - 5 * MIN });
  assert.equal(childStallDecision({ ...bro6854, tools: [...bro6854.tools, poll] }).block, false);
  const nohup = bash(10, 'nohup node ingest.js &', { run_in_background: true }, { taskId: 'p2', startedAt: STALL_AT - MIN });
  assert.equal(childStallDecision({ ...bro6854, tools: [...bro6854.tools, nohup] }).block, true);
});
test('a foreground Bash moved to the background counts while within 30 min', () => {
  const moved = (age) => bash(10, 'git push -u origin bro-6854-plan', {}, {
    taskId: 'bz72', startedAt: STALL_AT - age,
    result: 'Command did not complete within its 170s timeout and was moved to the background (ID: bz72ajdmk).' });
  assert.equal(childStallDecision({ ...bro6854, tools: [...bro6854.tools, moved(3 * MIN)] }).block, false);
  assert.equal(childStallDecision({ ...bro6854, tools: [...bro6854.tools, moved(45 * MIN)] }).block, true);
});
test("a report sent before the parent's latest message does not cover later work", () => {
  const tools = [...bro6854.tools, send(10, 'REPORT-BACK BRO-6854: SD done')];
  assert.equal(childStallDecision({ ...bro6854, tools, anchor: 12 }).block, true);
  assert.equal(childStallDecision({ ...bro6854, tools: [...tools, send(14, 'REPORT-BACK BRO-6854: Boston done')], anchor: 12 }).block, false);
});
test('not a REPORT-BACK child, or no child marker, or NO-VERIFY: passes', () => {
  assert.equal(childStallDecision({ ...bro6854, reportBack: false }).block, false);
  assert.equal(childStallDecision({ ...bro6854, firstPrompt: 'REPORT-BACK: please' }).block, false);
  assert.equal(childStallDecision({ ...bro6854, noVerify: true }).block, false);
});
test('decideAll: CHILDSTALL only when stall is set; skip honored; keepOpen false skips the older gates', () => {
  assert.equal(decideAll({ ...bro6854, stall: false, keepOpen: false }).block, false);
  assert.equal(decideAll({ ...bro6854, skip: ['CHILDSTALL'], keepOpen: false }).block, false);
  assert.match(decideAll({ ...bro6854, keepOpen: false, tools: [...bro6854.tools, send(10, 'REPORT-BACK BRO-6854: x')] }).reason, /^CHILDSTALL: /);
});

// ─── End to end: the real hook on transcript fixtures ───────────────────────
// The hook compares against the real clock, so e2e fixtures are relative to now.
const E2E_NOW = Date.now();
const ts = (minBefore) => new Date(E2E_NOW - minBefore * MIN).toISOString();
const userStr = (content, extra = {}) => ({ type: 'user', timestamp: ts(200), message: { role: 'user', content }, ...extra });
const toolUse = (id, name, input, min) => ({ type: 'assistant', timestamp: ts(min), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const toolRes = (id, text, min, isError = false) => ({ type: 'user', timestamp: ts(min), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] } });
const say = (text, min) => ({ type: 'assistant', timestamp: ts(min), message: { role: 'assistant', content: [{ type: 'text', text }] } });
const CLOSING = "I'm continuing with the rest of the Boston pipeline.\n\nStill running: the Boston scoring run on GitHub.\nYou need to: Nothing needed from you.\n\nKEEP OPEN — Boston is mid-build.";

function bro6854Transcript(extra = []) {
  return [
    userStr(CHILD_PROMPT),
    toolUse('t1', 'Bash', { command: 'node scripts/lib/wait-for-land.js land/bro-6854-sd 60', run_in_background: true }, 150),
    toolRes('t1', 'Command running in background with ID: bq1abc. Output is being written to: /tmp/x', 150),
    toolUse('t2', 'Bash', { command: 'gh workflow run llm-scoring.yml -f show=boston' }, 2),
    toolRes('t2', 'Created workflow_dispatch event', 2),
    ...extra,
  ];
}

function runHook(lines, env = {}, lastMsg = CLOSING) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'childstall-'));
  const tp = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(tp, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const r = spawnSyncStdinFile('bash', [HOOK], {
    input: JSON.stringify({ transcript_path: tp, session_id: 'childstall-test', stop_hook_active: false, last_assistant_message: lastMsg }),
    encoding: 'utf8',
    env: { ...process.env, HOME: dir, CLAUDE_CODE_REMOTE: 'true', BOARD_GATE_DISABLED: '1', SHIP_CHECK_COVERAGE_DISABLE: '1', ...env },
    timeout: 60000,
    killSignal: 'SIGKILL',
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: r.status, stderr: r.stderr || '' };
}
const STALL_MSG = /child session with no human/;

test('e2e: the BRO-6854 stop is blocked by CHILDSTALL', () => {
  const r = runHook(bro6854Transcript());
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, STALL_MSG);
});
test('e2e: a stop right after a REPORT-BACK send_message passes', () => {
  const r = runHook(bro6854Transcript([
    toolUse('t3', 'mcp__claude-code-remote__send_message', { session_id: '@parent', message: 'REPORT-BACK BRO-6854: landed, run https://x' }, 1),
    toolRes('t3', '{"delivered":true}', 1),
  ]), {}, 'Report sent to the parent.\n\nNothing is still running.\nNothing needed from you.\n\nSAFE TO ARCHIVE — the work landed and the parent has the report.');
  assert.doesNotMatch(r.stderr, STALL_MSG);
});
test('e2e: a stop with a just-started background Monitor passes', () => {
  const r = runHook(bro6854Transcript([
    toolUse('t3', 'Monitor', { command: 'until gh run view 9 --json status | grep -q completed; do sleep 60; done' }, 1),
    toolRes('t3', 'Monitor started (task b1o3zfo7b, expires in 10m unless the source ends first)', 1),
  ]));
  assert.doesNotMatch(r.stderr, STALL_MSG);
});
test('e2e: BRO-6833 shape (report via SendMessage) is blocked and names the tool', () => {
  const r = runHook(bro6854Transcript([
    toolUse('t3', 'SendMessage', { to: 'parent', message: 'REPORT-BACK BRO-6833: done' }, 1),
    toolRes('t3', 'Message sent', 1),
  ]));
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /SendMessage was used/);
});
test('e2e: Stop-hook feedback after a question to @parent does not reset the turn', () => {
  const r = runHook(bro6854Transcript([
    toolUse('t3', 'mcp__claude-code-remote__send_message', { session_id: '@parent', message: 'Which city first?' }, 1),
    toolRes('t3', '{"delivered":true}', 1),
    userStr('Stop hook feedback:\n[command hook 2]: There are 3 unpushed commit(s).', { isMeta: true }),
  ]));
  assert.doesNotMatch(r.stderr, STALL_MSG);
});
test("e2e: a report before the parent's ReadNotifications message is stale", () => {
  const r = runHook(bro6854Transcript([
    toolUse('t3', 'mcp__claude-code-remote__send_message', { session_id: '@parent', message: 'REPORT-BACK BRO-6854: SD done' }, 1),
    toolRes('t3', '{"delivered":true}', 1),
    toolUse('t4', 'ReadNotifications', {}, 1),
    toolRes('t4', '<cross-session-message from-session="session_01RUGH9ofwN3mfkzprugvLhL">\nParent here. Resume Boston.\n</cross-session-message>', 1),
  ]));
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, STALL_MSG);
});
test('e2e: kill switch, and a non-child session is not CHILDSTALL-gated', () => {
  assert.doesNotMatch(runHook(bro6854Transcript(), { CHILDSTALL_GATE_DISABLE: '1' }).stderr, STALL_MSG);
  const plain = bro6854Transcript();
  plain[0] = userStr('Fix the Boston page.');
  assert.doesNotMatch(runHook(plain).stderr, STALL_MSG);
});

// ─── Reviewer findings (ship-check, BRO-7183) ───────────────────────────────
test('e2e: a parent prompt quoting the REPORT-BACK template (no BUDGET line) keeps WAKELESS', () => {
  const r = runHook([
    userStr('Start a worker; its prompt needs a line\nREPORT-BACK: send_message @parent'),
    toolUse('t2', 'Bash', { command: 'gh workflow run llm-scoring.yml' }, 2),
    toolRes('t2', 'Created workflow_dispatch event', 2),
  ]);
  assert.doesNotMatch(r.stderr, STALL_MSG);
  assert.match(r.stderr, /nothing will wake it/);
});
test('e2e: a background Agent still working passes', () => {
  const r = runHook(bro6854Transcript([
    toolUse('t3', 'Agent', { description: 'review', prompt: 'review the diff', run_in_background: true }, 1),
    toolRes('t3', 'Async agent launched successfully. agentId: a1b2c3d4 The agent is working in the background.', 1),
  ]));
  assert.doesNotMatch(r.stderr, STALL_MSG);
});
test('e2e: a parent message delivered mid-turn (queued_command attachment) moves the anchor', () => {
  const r = runHook(bro6854Transcript([
    toolUse('t3', 'mcp__claude-code-remote__send_message', { session_id: '@parent', message: 'REPORT-BACK BRO-6854: SD done' }, 1),
    toolRes('t3', '{"delivered":true}', 1),
    { type: 'attachment', timestamp: ts(1), attachment: { type: 'queued_command',
      prompt: '<cross-session-message from-session="session_01RUGH9ofwN3mfkzprugvLhL">\nResume Boston.\n</cross-session-message>' } },
  ]));
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, STALL_MSG);
});
