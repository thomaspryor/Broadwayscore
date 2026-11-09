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
    bash(9, 'gh workflow run llm-ensemble-score.yml -f show_id=boston'),
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
    toolUse('t2', 'Bash', { command: 'gh workflow run llm-ensemble-score.yml -f show_id=boston' }, 2),
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
    toolUse('t2', 'Bash', { command: 'gh workflow run llm-ensemble-score.yml' }, 2),
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
test('e2e (cousin): WAKELESS no longer counts a background Bash past its timeout as live', () => {
  const plain = bro6854Transcript();
  plain[0] = userStr('Fix the Boston page.');
  assert.match(runHook(plain).stderr, /nothing will wake it/);
  const fresh = bro6854Transcript([
    toolUse('t3', 'Bash', { command: 'gh run view 9', run_in_background: true, timeout: 7200000 }, 5),
    toolRes('t3', 'Command running in background with ID: bfresh1. Output is being written to: /tmp/y', 5),
  ]);
  fresh[0] = userStr('Fix the Boston page.');
  assert.doesNotMatch(runHook(fresh).stderr, /nothing will wake it/);
});

// WAKEPROMISE (BRO-7183 phase 2): a closing that promises later action with no verdict line.
const PROMISE_MSG = /promises later action/;
function promiseRun(lastMsg, extra = [], env = {}) {
  const lines = bro6854Transcript(extra);
  lines[0] = userStr('Fix the Boston page.');
  return runHook(lines, { CLAUDE_CODE_REMOTE: '', PROMISE_GATE_MODE: 'block', ...env }, lastMsg);
}
test('e2e: BRO-7074 shape ("I\'ll check back", nothing live, no verdict) is blocked in block mode', () => {
  const r = promiseRun("Kicked off the scoring run. I'll check back once it finishes and post the results.");
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, PROMISE_MSG);
});
test('e2e: WAKEPROMISE is log-only by default', () => {
  const r = promiseRun("Kicked off the scoring run. I'll check back once it finishes.", [], { PROMISE_GATE_MODE: 'advisory' });
  assert.doesNotMatch(r.stderr, PROMISE_MSG);
});
test('e2e: a promise with a live background poller passes', () => {
  const r = promiseRun("I'm monitoring the run and will post results.", [
    toolUse('t3', 'Bash', { command: 'gh run view 9', run_in_background: true, timeout: 7200000 }, 5),
    toolRes('t3', 'Command running in background with ID: bfresh1. Output is being written to: /tmp/y', 5),
  ]);
  assert.doesNotMatch(r.stderr, PROMISE_MSG);
});
test('e2e: owner question, third-person description, and a done report are not promises', () => {
  assert.doesNotMatch(promiseRun("The page is fixed. I'll continue once you confirm the copy, OK?").stderr, PROMISE_MSG);
  assert.doesNotMatch(promiseRun('The board worker will continue with the next card on its own schedule.').stderr, PROMISE_MSG);
  assert.doesNotMatch(promiseRun('Fixed the Boston page and verified it live.').stderr, PROMISE_MSG);
});

// OPENCLAIM (BRO-7183 phase 2): a no-human routine leaving a card it claimed this firing open.
const OC_MSG = /claimed a card this firing that is still open/;
const ROUTINE = 'Read docs/cloud-routines/board-workers.md and follow it.';
const claimT = (id = 'BRO-7074', min = 30) => [
  toolUse('c1', 'Bash', { command: `node scripts/linear-session.js claim --issue=${id}` }, min),
  toolRes('c1', `claimed ${id}`, min)];
function ocRun(extra, env = {}, prompt = ROUTINE) {
  return runHook([userStr(prompt), ...extra], { CLAUDE_CODE_REMOTE: '', OPENCLAIM_GATE_MODE: 'block', ...env },
    'Board worker firing done: worked one card.');
}
test('OPENCLAIM unit: claim then close passes; claim alone blocks; a human session is out of scope', () => {
  const G = createRequire(import.meta.url)('./child-session-wait-guard.js');
  const bash = (idx, command, result = '') => ({ idx, name: 'Bash', ok: true, input: { command }, result });
  const claim = bash(1, 'node scripts/linear-session.js claim --issue=BRO-7074');
  assert.equal(G.openClaimDecision({ firstPrompt: ROUTINE, tools: [claim] }).block, true);
  assert.deepEqual(G.openClaimDecision({ firstPrompt: ROUTINE, tools: [claim] }).cards, ['BRO-7074']);
  assert.equal(G.openClaimDecision({ firstPrompt: ROUTINE, tools: [claim, bash(2, 'node scripts/linear-brain.js update BRO-7074 --state Done')] }).block, false);
  assert.equal(G.openClaimDecision({ firstPrompt: ROUTINE, tools: [claim, bash(2, 'node scripts/linear-session.js report --issue=BRO-7074 --status=paused --summary=x')] }).block, false);
  assert.equal(G.openClaimDecision({ firstPrompt: ROUTINE, tools: [claim, { idx: 2, name: 'mcp__x__save_issue', ok: true, input: { id: 'BRO-7074', state: 'Paused' } }] }).block, false);
  assert.equal(G.openClaimDecision({ firstPrompt: ROUTINE, tools: [claim, { idx: 2, name: 'mcp__claude-code-remote__create_session', ok: true, input: {} }] }).block, false);
  assert.equal(G.openClaimDecision({ firstPrompt: 'Fix the Boston page.', tools: [claim] }).block, false);
  // a --self create: the id comes from the command's output
  assert.deepEqual(G.openClaimDecision({ firstPrompt: ROUTINE, tools: [bash(1, 'node scripts/linear-brain.js create "x" --self', 'Created BRO-7200 https://linear.app/x')] }).cards, ['BRO-7200']);
  // scoped to the latest firing: a claim before the anchor does not count
  assert.equal(G.openClaimDecision({ firstPrompt: ROUTINE, tools: [claim], ocAnchor: 5 }).block, false);
});
test('e2e: BRO-7074 shape (routine claims, ends with the card open) blocks in block mode, logs by default', () => {
  const r = ocRun(claimT());
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, OC_MSG);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-home-'));
  const r2 = ocRun(claimT(), { OPENCLAIM_GATE_MODE: 'advisory', HOME: home });
  assert.doesNotMatch(r2.stderr, OC_MSG);
  const rows = fs.readFileSync(path.join(home, '.claude', 'state', 'open-claim-advisory.jsonl'), 'utf8').trim().split('\n');
  assert.deepEqual(JSON.parse(rows[0]).cards, ['BRO-7074']);
});
test('e2e: routine that moved its card to Paused, or has a live poller, passes', () => {
  assert.doesNotMatch(ocRun([...claimT(), toolUse('c2', 'Bash', { command: 'node scripts/linear-brain.js update BRO-7074 --state Paused' }, 20), toolRes('c2', 'ok', 20)]).stderr, OC_MSG);
  assert.doesNotMatch(ocRun([...claimT(), toolUse('c3', 'Bash', { command: 'node scripts/lib/wait-for-land.js land/x 60', run_in_background: true, timeout: 7200000 }, 5),
    toolRes('c3', 'Command running in background with ID: boc1. Output is being written to: /tmp/y', 5)]).stderr, OC_MSG);
});
test('OPENCLAIM review fixes: routine marker is a directive, claim --title counts, save_issue closes only with a closing state', () => {
  const G = createRequire(import.meta.url)('./child-session-wait-guard.js');
  const claim = { idx: 1, name: 'Bash', ok: true, input: { command: 'node scripts/linear-session.js claim --issue=BRO-7074' } };
  assert.equal(G.openClaimDecision({ firstPrompt: 'Can you explain what docs/cloud-routines/board-workers.md does?', tools: [claim] }).block, false);
  assert.equal(G.openClaimDecision({ firstPrompt: 'New board-workers firing. Read docs/cloud-routines/board-workers.md on origin/main (git fetch first) and follow it exactly.', tools: [claim] }).block, true);
  assert.deepEqual(G.openClaimDecision({ firstPrompt: ROUTINE, tools: [{ idx: 1, name: 'Bash', ok: true, input: { command: 'node scripts/linear-session.js claim --title "Fix x"' }, result: 'claimed BRO-7300' }] }).cards, ['BRO-7300']);
  assert.equal(G.openClaimDecision({ firstPrompt: ROUTINE, tools: [{ ...claim, input: { command: 'node scripts/Linear-Session.js CLAIM --issue=bro-7074' } }] }).block, true);
  const save = (input) => ({ idx: 2, name: 'mcp__x__save_issue', ok: true, input });
  assert.equal(G.openClaimDecision({ firstPrompt: ROUTINE, tools: [claim, save({ id: 'BRO-7074', state: 'In Progress' })] }).block, true);
  assert.equal(G.openClaimDecision({ firstPrompt: ROUTINE, tools: [claim, save({ id: 'BRO-7074', state: 'Done' })] }).block, false);
});
test('e2e: a later routine firing in the same session anchors OPENCLAIM at that firing', () => {
  const FIRING = 'New board-workers firing. Read docs/cloud-routines/board-workers.md on origin/main (git fetch first) and follow it exactly.';
  // Card claimed in an earlier firing, then a new firing that claims nothing: not this firing's card.
  assert.doesNotMatch(ocRun([...claimT('BRO-7074', 200), userStr(FIRING)], {}, FIRING).stderr, OC_MSG);
  assert.match(ocRun([userStr(FIRING), ...claimT('BRO-7075', 10)], {}, FIRING).stderr, OC_MSG);
});
test('WAKEPROMISE review fixes: curly apostrophe matches, bare "continue"/"monitor" do not', () => {
  assert.match(promiseRun('Kicked off the run. I’ll check back once it finishes.').stderr, PROMISE_MSG);
  assert.doesNotMatch(promiseRun("Done. If you want, I'll continue polishing the copy next time.").stderr, PROMISE_MSG);
  assert.doesNotMatch(promiseRun("Fixed it. I'll monitor-proof the script in a later card.").stderr, PROMISE_MSG);
  assert.match(promiseRun("Started the deploy. I'll monitor the run and report.").stderr, PROMISE_MSG);
});

test('routine marker covers live routine prompts (weekly retro "read and follow"), not a human ask or a one-shot', () => {
  const { NO_HUMAN_RE: R } = createRequire(import.meta.url)('./child-session-wait-guard.js');
  assert.equal(R.test('New board-workers firing. You are running in a fresh session with no human watching.'), true);
  assert.equal(R.test('New daily worker-check firing. Earlier firings are finished. No human is watching.'), true);
  assert.equal(R.test('Scheduled job: weekly retrospective. Then read and follow docs/cloud-routines/weekly-retro.md in that repo exactly.'), true);
  assert.equal(R.test('Please fix the header on the show page'), false);
  assert.equal(R.test('Can you explain what docs/cloud-routines/board-workers.md does?'), false);
});

// BRO-7195: the Mac global gate (scripts/lib/stall-stop-gate.js, run from ~/.claude/settings.json Stop by
// ~/.claude/hooks/stall-stop-gate.sh) gives WAKEPROMISE to a session in ANY repo, not just this one.
// End to end: a scratch git repo outside Broadwayscore, a real transcript file, the real CLI.
const MAC_GATE = path.join(REPO_ROOT, 'scripts', 'lib', 'stall-stop-gate.js');
function macGateRun(lines, { cwd, home, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7195-tx-'));
  const tp = path.join(dir, 'session.jsonl');
  fs.writeFileSync(tp, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return spawnSyncStdinFile('node', [MAC_GATE, '--stop-hook'], { encoding: 'utf8', cwd, timeout: 30000,
    input: JSON.stringify({ session_id: 'bro7195-e2e', transcript_path: tp, cwd, stop_hook_active: false, hook_event_name: 'Stop' }),
    env: { ...process.env, HOME: home, WAKEPROMISE_GATE_DISABLE: '', STALL_STOP_GATE_MODE: '', ...env } });
}
const macHuman = (text) => ({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: text } });
const macSay = (text) => ({ type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text }] } });
const scratchRepo = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7195-scratch-repo-'));
  fs.mkdirSync(path.join(d, '.git'));
  return d;
};

test('BRO-7195 e2e: a Mac session in a scratch repo ending "I will check back" with nothing running is blocked, once per turn', () => {
  const cwd = scratchRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7195-home-'));
  const tx = [macHuman('Bump the dependency and push.'), macSay('Pushed the bump. I will check back once CI finishes.')];
  const r = macGateRun(tx, { cwd, home });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /WAKEPROMISE \(BRO-7195\)/);
  const again = macGateRun(tx, { cwd, home });
  assert.equal(again.status, 0, 'a second stop in the same human turn must pass (no block loop)');
  const ledger = fs.readFileSync(path.join(home, '.claude', 'state', 'wake-promise-advisory.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(ledger.map((x) => [x.source, x.blocked]), [['global', true], ['global', false]]);
  // A new human turn gets the gate again.
  assert.equal(macGateRun([...tx, macHuman('and the other repo?'), macSay("Started it. I'll report back.")], { cwd, home }).status, 2);
});

test('BRO-7195 e2e: the Mac gate passes live work, advisory mode and the kill switch, and covers Broadwayscore too', () => {
  const cwd = scratchRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7195-home-'));
  const live = [macHuman('run it'),
    { type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test', run_in_background: true } }] } },
    { type: 'user', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Command running in background with ID: bk9q2x7ma. Output is being written to: /tmp/o' }] } },
    macSay("Tests are running. I'll check back when they finish.")];
  assert.equal(macGateRun(live, { cwd, home }).status, 0);
  const idle = [macHuman('x'), macSay('Done for now. I will check back later.')];
  assert.equal(macGateRun(idle, { cwd, home, env: { STALL_STOP_GATE_MODE: 'advisory' } }).status, 0);
  assert.equal(macGateRun(idle, { cwd, home, env: { WAKEPROMISE_GATE_DISABLE: '1' } }).status, 0);
  // On the Mac the repo verify-edits.sh self-skips (a global copy exists) and that copy has no WAKEPROMISE.
  assert.equal(macGateRun(idle, { cwd: REPO_ROOT, home: fs.mkdtempSync(path.join(os.tmpdir(), 'bro7195-home-')) }).status, 2);
  // The harness's last_assistant_message wins over a transcript that has not flushed the closing yet.
  const unflushed = [macHuman('x'), macSay('Working on it.')];
  const r = spawnSyncStdinFile('node', [MAC_GATE, '--stop-hook'], { encoding: 'utf8', cwd, timeout: 30000,
    input: JSON.stringify({ session_id: 'bro7195-flush', transcript_path: (() => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bro7195-tx-')), 't.jsonl'); fs.writeFileSync(f, unflushed.map((l) => JSON.stringify(l)).join('\n') + '\n'); return f; })(),
      cwd, last_assistant_message: 'Pushed. I will check back once CI finishes.' }),
    env: { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'bro7195-home-')), WAKEPROMISE_GATE_DISABLE: '', STALL_STOP_GATE_MODE: '' } });
  assert.equal(r.status, 2, r.stderr);
  assert.equal(macGateRun(idle, { cwd, home }).status, 2);
});
