// BRO-7839: pins the skeptic review Stop gate (scripts/lib/skeptic-review-stop.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  stopHookDecision, buildReviewInput, codeEditIndices, redact, parseGaps, callReviewer, reviewPrompt,
  bypassReason, roundBudget, blockMessage, digest, main, SKEPTIC_BLOCKING_FROM, MAX_ROUNDS,
  lastSkepticShipCheckIndex, shipCheckReport,
} from './skeptic-review-stop.mjs';

const CLOUD = { CLAUDE_CODE_REMOTE: 'true', OPENAI_API_KEY: 'sk-test-key-not-real-000000', SKEPTIC_REVIEW_LOG: path.join(os.tmpdir(), `skeptic-test-log-${process.pid}.jsonl`) };
const CLAIM = 'Landed the fix.\n\nSAFE TO ARCHIVE — landed and verified';
let n = 0;
const tool = (name, input, result = 'ok', isError = false) => {
  const id = `t${++n}`;
  return [{ kind: 'assistant_tool_use', name, input, id, messageId: `m${id}` }, { kind: 'tool_result', tool_use_id: id, content: result, isError }];
};
const text = (t) => ({ kind: 'assistant_text', text: t, messageId: `m${++n}` });
const editCode = (f = '/home/user/Broadwayscore/.claude/worktrees/x/scripts/lib/foo.js') => tool('Edit', { file_path: f, old_string: 'a', new_string: 'b' });

test('allows outside cloud, with the kill switch, without a close claim, without a transcript', () => {
  const events = [...editCode()];
  assert.equal(stopHookDecision({ lastMessage: CLAIM, events, env: {} }).decision, 'allow');
  assert.equal(stopHookDecision({ lastMessage: CLAIM, events, env: { ...CLOUD, SKEPTIC_REVIEW_STOP_DISABLE: '1' } }).decision, 'allow');
  assert.equal(stopHookDecision({ lastMessage: 'still working', events, env: CLOUD }).decision, 'allow');
  assert.equal(stopHookDecision({ lastMessage: CLAIM, events: [], env: CLOUD }).decision, 'allow');
});

test('reviews a chunk with a code edit; ignores data, memory and scratchpad edits', () => {
  assert.equal(stopHookDecision({ lastMessage: CLAIM, events: [...editCode()], env: CLOUD }).decision, 'review');
  for (const f of ['/home/user/Broadwayscore/data/shows.json', '/home/user/Broadwayscore/memory/x.md', '/tmp/claude-0/x/scratchpad/a.js', '/root/.claude/projects/p/a.js']) {
    assert.equal(stopHookDecision({ lastMessage: CLAIM, events: [...editCode(f)], env: CLOUD }).decision, 'allow', f);
  }
  // A shell edit counts too.
  assert.equal(stopHookDecision({ lastMessage: CLAIM, events: [...tool('Bash', { command: "sed -i 's/a/b/' scripts/lib/foo.js" })], env: CLOUD }).decision, 'review');
});

test('a message deferring proof to a later run is judged like a close', () => {
  const d = stopHookDecision({ lastMessage: "We'll know tomorrow after the nightly run.", events: [...editCode()], env: CLOUD });
  assert.equal(d.decision, 'review');
});

test('chunk key is the last accepted claim (fix edits do not reset the budget); edit key moves with each edit', () => {
  const ev = [...editCode(), text('done\n\nSAFE TO ARCHIVE — first close'), ...editCode()];
  const d1 = stopHookDecision({ lastMessage: CLAIM, events: ev, env: CLOUD });
  const ev2 = [...ev, ...editCode()];
  const d2 = stopHookDecision({ lastMessage: CLAIM, events: ev2, env: CLOUD });
  assert.equal(d1.chunkKey, d2.chunkKey);
  assert.notEqual(d1.editKey, d2.editKey);
  // Only edits after the accepted claim count.
  assert.deepEqual(codeEditIndices(ev, 2), [3]);
});

test('NO-SKEPTIC bypass with a real reason allows; a schedule-only reason does not', () => {
  const ok = [...editCode(), text('NO-SKEPTIC: running it sends real email to 900 subscribers')];
  assert.equal(stopHookDecision({ lastMessage: CLAIM, events: ok, env: CLOUD }).decision, 'allow');
  const sched = [...editCode(), text('NO-SKEPTIC: it only runs on the nightly cron schedule')];
  assert.equal(stopHookDecision({ lastMessage: CLAIM, events: sched, env: CLOUD }).decision, 'review');
  assert.equal(bypassReason([text('NO-SKEPTIC: short')], -1, ''), null);
});

test('redact catches quoted, YAML, JSON, header, query and AWS key forms', () => {
  const s = redact('SCRAPINGBEE_API_KEY="abcd1234efgh5678" BRIGHTDATA_API_TOKEN: tok_abcdef123456 https://x.io/?api_key=qwerty123456 x-api-key: zzzz9999yyyy {"apiKey":"jsonsecret123"} AKIAABCDEFGHIJKLMNOP');
  for (const leak of ['abcd1234efgh5678', 'tok_abcdef123456', 'qwerty123456', 'zzzz9999yyyy', 'jsonsecret123', 'AKIAABCDEFGHIJKLMNOP']) assert.ok(!s.includes(leak), `${leak} leaked: ${s}`);
});

test('redact strips keys, tokens, bearer headers, env assignments and emails', () => {
  const s = redact('OPENAI_API_KEY=sk-proj-abcdefghijklmnop1234 ghp_abcdefghijklmnopqrstuvwxyz12 Authorization: Bearer abcdef0123456789xyz mail owner@example.com AIzaSyA1234567890abcdefghijklmnopqrstuv LINEAR_API_KEY=lin_api_abcdefghijklmnopqrst');
  for (const leak of ['sk-proj-abcdef', 'ghp_abcdef', 'abcdef0123456789xyz', 'owner@example.com', 'AIzaSyA123', 'lin_api_abcdef']) assert.ok(!s.includes(leak), `${leak} leaked: ${s}`);
});

test('buildReviewInput: files, edits, command status and tails, private review text never sent, caps hold', () => {
  const ev = [
    ...editCode(),
    ...tool('Bash', { command: 'node --test scripts/lib/foo.test.mjs' }, '# pass 4\n# fail 0'),
    ...tool('Bash', { command: 'node scripts/foo.js --show=x' }, 'TypeError: boom', true),
    ...tool('Bash', { command: 'cat data/review-texts/hamilton/nyt.json' }, 'SECRET COPYRIGHTED REVIEW TEXT'),
    ...tool('Bash', { command: 'echo $X' }, 'token sk-abcdefghijklmnopqrstuvwx'),
  ];
  const inp = buildReviewInput(ev, -1, CLAIM);
  assert.deepEqual(inp.files, ['scripts/lib/foo.js']);
  assert.equal(inp.commands.length, 4);
  assert.equal(inp.commands[1].ok, false);
  assert.match(inp.commands[0].tail, /pass 4/);
  assert.ok(!JSON.stringify(inp).includes('COPYRIGHTED'));
  assert.ok(!JSON.stringify(inp).includes('sk-abcdefghijklmnop'));
  const many = [];
  for (let i = 0; i < 80; i++) many.push(...tool('Bash', { command: `echo ${i}` }, String(i)));
  const capped = buildReviewInput(many, -1, CLAIM);
  assert.equal(capped.commands.length, 45);
  assert.equal(capped.omittedCommands, 35);
  assert.equal(capped.commands.at(-1).cmd, 'echo 79');
  const big = [];
  for (let i = 0; i < 60; i++) big.push(...tool('Edit', { file_path: `scripts/a${i}.js`, old_string: 'x'.repeat(400), new_string: 'y'.repeat(900) }));
  assert.ok(buildReviewInput(big, -1, CLAIM).edits.join('').length < 16000);
});

test('the prompt carries previous gaps on a re-review and the FAILED marker', () => {
  const inp = buildReviewInput([...editCode(), ...tool('Bash', { command: 'npm test' }, 'fail', true)], -1, CLAIM, [{ what: 'workflow never dispatched', check: 'dispatch it' }]);
  const p = reviewPrompt(inp);
  assert.match(p, /PREVIOUS GAPS/);
  assert.match(p, /workflow never dispatched/);
  assert.match(p, /\[FAILED\] npm test/);
});

test('parseGaps: JSON, fenced JSON, garbage, cap at 6, severity default material', () => {
  assert.deepEqual(parseGaps('{"verdict":"fully_tested","gaps":[]}'), { gaps: [] });
  assert.equal(parseGaps('```json\n{"gaps":[{"what":"x","check":"y"}]}\n```').gaps[0].severity, 'material');
  assert.ok(parseGaps('not json').error);
  assert.ok(parseGaps('{"verdict":"x"}').error);
  const seven = { gaps: Array.from({ length: 7 }, (_, i) => ({ what: `g${i}`, severity: 'minor' })) };
  assert.equal(parseGaps(JSON.stringify(seven)).gaps.length, 6);
});

const fakeFetch = (content, { status = 200, calls = [] } = {}) => async (url, init) => {
  calls.push(JSON.parse(init.body));
  return { ok: status === 200, status, json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) };
};

test('callReviewer: no key and HTTP errors fail with an error (caller fails open); request shape', async () => {
  assert.ok((await callReviewer({ files: [], edits: [], commands: [], claim: '' }, { env: {} })).error);
  assert.ok((await callReviewer({ files: [], edits: [], commands: [], claim: '' }, { env: CLOUD, fetchImpl: fakeFetch('x', { status: 500 }) })).error);
  assert.ok((await callReviewer({ files: [], edits: [], commands: [], claim: '' }, { env: CLOUD, fetchImpl: async () => { throw new Error('net'); } })).error);
  const calls = [];
  const r = await callReviewer({ files: [], edits: [], commands: [], claim: '' }, { env: CLOUD, fetchImpl: fakeFetch('{"gaps":[]}', { calls }) });
  assert.deepEqual(r.gaps, []);
  assert.equal(calls[0].response_format.type, 'json_object');
  assert.ok(calls[0].max_completion_tokens > 0);
});

test('rollout: one round before the blocking date, MAX_ROUNDS from it', () => {
  assert.equal(roundBudget(new Date('2026-11-20T00:00:00Z')), 1);
  assert.equal(roundBudget(new Date(`${SKEPTIC_BLOCKING_FROM}T00:00:00Z`)), MAX_ROUNDS);
  assert.match(blockMessage([{ what: 'w', why: 'y', check: 'c' }], { round: 1, budget: 1 }), /check: c/);
});

// ---- end to end through main(): transcript file, state, budget, fail-open.
function transcriptFile(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skeptic-test-'));
  const p = path.join(dir, 't.jsonl');
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
}
const aTool = (id, name, input) => ({ type: 'assistant', message: { id: `msg_${id}`, content: [{ type: 'tool_use', id, name, input }] } });
const aResult = (id, content, is_error = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } });
const MATERIAL = '{"verdict":"gaps","gaps":[{"what":"never ran the script on real data","why":"only fixtures","check":"node scripts/lib/foo.js --dry-run","severity":"material"}]}';

async function runMain(tp, content, { now = new Date('2026-11-19T12:00:00Z'), calls = [] } = {}) {
  const errs = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { errs.push(String(s)); return true; };
  try {
    const code = await main(['--stop-hook'], { env: CLOUD, now, stdin: JSON.stringify({ transcript_path: tp, last_assistant_message: CLAIM, session_id: 'test' }), fetchImpl: fakeFetch(content, { calls }) });
    return { code, err: errs.join('') };
  } finally { process.stderr.write = orig; }
}

test('main: material gaps block once in the advisory window, then let the same chunk through without another call', async () => {
  const tp = transcriptFile([aTool('e1', 'Edit', { file_path: 'scripts/lib/foo.js', old_string: 'a', new_string: 'b' }), aResult('e1', 'ok')]);
  const calls = [];
  const first = await runMain(tp, MATERIAL, { calls });
  assert.equal(first.code, 2);
  assert.match(first.err, /never ran the script on real data/);
  const second = await runMain(tp, MATERIAL, { calls });
  assert.equal(second.code, 0);
  assert.equal(calls.length, 1, 'an exhausted chunk with no new edits costs no reviewer call');
});

test('main: from the blocking date it re-reviews with the previous gaps and passes when they are closed', async () => {
  const now = new Date(`${SKEPTIC_BLOCKING_FROM}T12:00:00Z`);
  const tp = transcriptFile([aTool('e2', 'Edit', { file_path: 'scripts/lib/bar.js', old_string: 'a', new_string: 'b' }), aResult('e2', 'ok')]);
  const calls = [];
  assert.equal((await runMain(tp, MATERIAL, { now, calls })).code, 2);
  assert.equal((await runMain(tp, '{"verdict":"fully_tested","gaps":[]}', { now, calls })).code, 0);
  assert.match(calls[1].messages[1].content, /PREVIOUS GAPS[\s\S]*never ran the script/);
  // Passed: the same edits are not re-asked.
  assert.equal((await runMain(tp, MATERIAL, { now, calls })).code, 0);
  assert.equal(calls.length, 2);
});

test('main: minor-only gaps pass; reviewer errors fail open', async () => {
  const tp = transcriptFile([aTool('e3', 'Edit', { file_path: 'scripts/lib/baz.js', old_string: 'a', new_string: 'b' }), aResult('e3', 'ok')]);
  assert.equal((await runMain(tp, '{"gaps":[{"what":"naming","severity":"minor"}]}')).code, 0);
  const tp2 = transcriptFile([aTool('e4', 'Edit', { file_path: 'scripts/lib/qux.js', old_string: 'a', new_string: 'b' }), aResult('e4', 'ok')]);
  assert.equal((await runMain(tp2, 'not json at all')).code, 0);
});

test('digest counts outcomes', () => {
  const d = digest([{ outcome: 'block', session: 'a' }, { outcome: 'pass', session: 'a' }, { outcome: 'bypass', session: 'b' }, { outcome: 'error' }, { outcome: 'over-budget' }]);
  assert.deepEqual(d, { reviews: 3, blocked: 1, passed: 1, wouldBlock: 1, bypass: 1, errors: 1, sessions: 2 });
});

test('verify-edits.sh wires the gate (a Mac-master sync must not drop it)', () => {
  const sh = fs.readFileSync(new URL('../../.claude/hooks/verify-edits.sh', import.meta.url), 'utf8');
  assert.match(sh, /SKEPTIC_REVIEW_STOP_DISABLE/);
  assert.match(sh, /skeptic-review-stop\.mjs" --stop-hook/);
  assert.match(sh, /\[VE:SKEPTIC\]/);
});

// ---------------------------------------------------------------- ship-check mode (BRO-7839 steer: reviewer inside /ship-check)
const SHIP = 'node scripts/lib/skeptic-review-stop.mjs --ship-check';

test('backstop: a ship-check skeptic run after the last code edit lets the close through without a call; an edit after it does not', () => {
  const ran = tool('Bash', { command: SHIP }, 'SKEPTIC REVIEW: no material gaps.');
  assert.equal(stopHookDecision({ lastMessage: CLAIM, events: [...editCode(), ...ran], env: CLOUD }).decision, 'allow');
  assert.equal(stopHookDecision({ lastMessage: CLAIM, events: [...editCode(), ...ran, ...editCode()], env: CLOUD }).decision, 'review');
  // A run that printed no verdict (crashed, or only echoed the name) is not coverage.
  const crashed = tool('Bash', { command: SHIP }, 'Error: Cannot find module', true);
  assert.equal(stopHookDecision({ lastMessage: CLAIM, events: [...editCode(), ...crashed], env: CLOUD }).decision, 'review');
  const echoed = tool('Bash', { command: `echo ${SHIP}` }, 'SKEPTIC REVIEW: no material gaps.');
  assert.equal(lastSkepticShipCheckIndex([...editCode(), ...echoed]), -1);
});

test('shipCheckReport: verdict line first, material gaps with checks, minor gaps apart, errors still print the verdict line', () => {
  const r = shipCheckReport({ gaps: [{ what: 'never ran X', why: 'unit only', check: 'node x.js', severity: 'material' }, { what: 'typo', check: '', severity: 'minor' }] });
  assert.match(r, /^SKEPTIC REVIEW: 1 material gap\(s\)/);
  assert.match(r, /1\. never ran X \(unit only\)\n {3}check: node x\.js/);
  assert.match(r, /Minor \(optional\):\n1\. typo/);
  assert.equal(shipCheckReport({ gaps: [] }), 'SKEPTIC REVIEW: no material gaps.');
  assert.match(shipCheckReport({ error: 'no OPENAI_API_KEY' }), /^SKEPTIC REVIEW UNAVAILABLE \(no OPENAI_API_KEY\)/);
});

test('main --ship-check: reads the transcript, reviews only work since the last landed push, prints the verdict, exits 0', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skr-ship-'));
  const tp = path.join(dir, 't.jsonl');
  const line = (o) => JSON.stringify(o);
  const use = (id, name, input) => line({ type: 'assistant', message: { id: `m${id}`, content: [{ type: 'tool_use', id, name, input }] } });
  const out = (id, content) => line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });
  fs.writeFileSync(tp, [
    use('a1', 'Edit', { file_path: '/home/user/Broadwayscore/scripts/lib/old.js', old_string: 'x', new_string: 'y' }), out('a1', 'ok'),
    use('a2', 'Bash', { command: 'git push origin HEAD:refs/heads/land/old' }), out('a2', 'To github.com:o/r.git\n * [new branch] HEAD -> land/old'),
    use('a3', 'Edit', { file_path: '/home/user/Broadwayscore/scripts/lib/new.js', old_string: 'x', new_string: 'y' }), out('a3', 'ok'),
  ].join('\n') + '\n');
  let body = null;
  const fetchImpl = async (_u, init) => { body = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ verdict: 'gaps', gaps: [{ what: 'new.js never ran', check: 'node scripts/lib/new.js', severity: 'material' }] }) } }], usage: {} }) }; };
  const writes = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { writes.push(String(c)); return true; };
  let code;
  try { code = await main(['--ship-check', `--transcript=${tp}`], { env: CLOUD, fetchImpl }); } finally { process.stdout.write = orig; }
  assert.equal(code, 0);
  assert.match(writes.join(''), /^SKEPTIC REVIEW: 1 material gap\(s\)[\s\S]*check: node scripts\/lib\/new\.js/);
  const sent = body.messages.map((m) => m.content).join('\n');
  assert.match(sent, /new\.js/);
  assert.doesNotMatch(sent, /old\.js/, 'work landed before the last push is not re-reviewed');
  // A transcript that is not this session's, or an empty one, never yields a verdict line (fake-pass guard).
  const run = async (args, env) => { const w = []; process.stdout.write = (c) => { w.push(String(c)); return true; }; try { await main(args, { env, fetchImpl }); } finally { process.stdout.write = orig; } return w.join(''); };
  assert.match(await run(['--ship-check', `--transcript=${tp}`], { ...CLOUD, CLAUDE_CODE_SESSION_ID: 'other-session' }), /^SKEPTIC REVIEW UNAVAILABLE \(--transcript is not this session/);
  const empty = path.join(dir, 'empty.jsonl'); fs.writeFileSync(empty, '');
  assert.doesNotMatch(await run(['--ship-check', `--transcript=${empty}`], CLOUD), /^SKEPTIC REVIEW: /m, 'an empty transcript is not a review');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ---------------------------------------------------------------- BRO-7872: the backstop checks the ship-check list was answered
const GAPS1 = 'SKEPTIC REVIEW: 1 material gap(s).\n1. never ran the CLI (unit only)\n   check: node scripts/lib/foo.js --all';

test('BRO-7872: a ship-check list with no answers is not a pass at close (no reviewer call); answering it lets the close through', () => {
  const events = [...editCode(), ...tool('Skill', { skill: 'ship-check' }, 'Launching skill: ship-check'), ...tool('Bash', { command: SHIP }, GAPS1)];
  const d = stopHookDecision({ lastMessage: CLAIM, events, env: CLOUD });
  assert.equal(d.decision, 'unanswered', '3FKM shape: the list was printed and ignored');
  assert.deepEqual(d.unanswered.map((g) => g.n), [1]);
  assert.equal(stopHookDecision({ lastMessage: `GAP 1: not a gap: foo.js --all only reads files the unit test covers end to end\n${CLAIM}`, events, env: CLOUD }).decision, 'allow');
  assert.equal(stopHookDecision({ lastMessage: `${CLAIM}\nNO-SKEPTIC: the reviewer cannot see the owner device run`, events, env: CLOUD }).decision, 'allow', 'bypass still wins');
  assert.equal(stopHookDecision({ lastMessage: CLAIM, events, env: { ...CLOUD, SKEPTIC_GAP_ANSWERS_DISABLE: '1' } }).decision, 'allow', 'kill switch');
});

test('BRO-7872: main --stop-hook blocks an unanswered list within the round budget, never calls the reviewer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skr-unans-'));
  const tp = path.join(dir, 't.jsonl');
  const line = (o) => JSON.stringify(o);
  const use = (id, name, input) => line({ type: 'assistant', message: { id: `m${id}`, content: [{ type: 'tool_use', id, name, input }] } });
  const out = (id, content) => line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });
  fs.writeFileSync(tp, [
    use('b1', 'Edit', { file_path: '/home/user/Broadwayscore/scripts/lib/foo.js', old_string: 'x', new_string: 'y' }), out('b1', 'ok'),
    use('b2', 'Skill', { skill: 'ship-check' }), out('b2', 'Launching skill: ship-check'),
    use('b3', 'Bash', { command: SHIP }), out('b3', GAPS1),
  ].join('\n') + '\n');
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('must not be called'); };
  const errs = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (c) => { errs.push(String(c)); return true; };
  const stdin = JSON.stringify({ transcript_path: tp, last_assistant_message: CLAIM, session_id: 's' });
  const codes = [];
  try { for (let i = 0; i < 6; i++) codes.push(await main(['--stop-hook'], { env: { ...CLOUD, TMPDIR: dir }, fetchImpl, stdin, now: new Date('2026-12-31T00:00:00Z') })); } finally { process.stderr.write = orig; }
  assert.equal(calls, 0);
  assert.equal(codes[0], 2);
  assert.match(errs.join(''), /BRO-7872[\s\S]*gap 1:[\s\S]*GAP <n>: ran/);
  assert.equal(codes[codes.length - 1], 0, 'the round budget runs out: never loops a session');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('BRO-7872: a fresh close review (edits after the ship-check run) is handed the ship-check gaps still unanswered', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skr-prev-'));
  const tp = path.join(dir, 't.jsonl');
  const line = (o) => JSON.stringify(o);
  const use = (id, name, input) => line({ type: 'assistant', message: { id: `m${id}`, content: [{ type: 'tool_use', id, name, input }] } });
  const out = (id, content) => line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });
  fs.writeFileSync(tp, [
    use('c1', 'Edit', { file_path: '/home/user/Broadwayscore/scripts/lib/foo.js', old_string: 'x', new_string: 'y' }), out('c1', 'ok'),
    use('c2', 'Skill', { skill: 'ship-check' }), out('c2', 'Launching skill: ship-check'),
    use('c3', 'Bash', { command: SHIP }), out('c3', GAPS1),
    use('c4', 'Edit', { file_path: '/home/user/Broadwayscore/scripts/lib/foo.js', old_string: 'y', new_string: 'z' }), out('c4', 'ok'),
  ].join('\n') + '\n');
  let prompt = '';
  const fetchImpl = async (_u, init) => { prompt = JSON.stringify(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ verdict: 'pass', gaps: [] }) } }], usage: {} }) }; };
  const code = await main(['--stop-hook'], { env: { ...CLOUD, TMPDIR: dir }, fetchImpl, stdin: JSON.stringify({ transcript_path: tp, last_assistant_message: CLAIM }), now: new Date('2026-12-31T00:00:00Z') });
  assert.equal(code, 0);
  assert.match(prompt, /PREVIOUS GAPS[^"]*never ran the CLI/);
  fs.rmSync(dir, { recursive: true, force: true });
});
