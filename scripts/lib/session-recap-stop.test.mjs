// BRO-7985: session-recap-stop.mjs, pure decision plus the real Stop-hook entry (fail-open, capped nudges).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSyncStdinFile } from '../../tests/helpers/spawn-stdin-file.mjs';
import { sessionRecapDecision, parseRecap, ownerMessageCount, MAX_LINES } from './session-recap-stop.mjs';

const ENV = { CLAUDE_CODE_REMOTE: 'true' };
let n = 0;
const use = (name, input, result = 'ok', isError = false) => { const id = `t${++n}`; return [{ kind: 'assistant_tool_use', name, input, id }, { kind: 'tool_result', tool_use_id: id, content: result, isError }]; };
const land = () => use('Bash', { command: 'git push origin HEAD:refs/heads/land/x' });
const owner = (k) => Array.from({ length: k }, (_, i) => ({ kind: 'user_text', text: `owner message ${i}`, synthetic: false, foreignTurn: false }));
const TAIL = 'Still running: nothing.\nYou need to: nothing.\n\nSAFE TO ARCHIVE — done';
const RECAP = 'This session:\nThe archive message now recaps the whole session.\nA check blocks closing without that recap.\n\n';
const decide = (events, lastMessage, env = ENV) => sessionRecapDecision({ lastMessage, events, env });

test('class guard: a long session closing SAFE TO ARCHIVE without a recap blocks (the "Nothing changed since my last message" shape)', () => {
  const m = 'Nothing changed since my last message.\n\n' + TAIL;
  const d = decide([...owner(1), ...land()], m);
  assert.equal(d.decision, 'block'); assert.match(d.message, /Recap missing/);
  assert.match(d.message, /Linear cards/); assert.match(d.message, /land pushes/);
  assert.equal(decide(owner(4), m).decision, 'block', '3+ owner messages is long even with no land push');
});

test('with a recap it allows', () => {
  assert.equal(decide([...owner(1), ...land()], RECAP + TAIL).decision, 'allow');
  assert.equal(decide(owner(3), '**This session:**\n- one thing\n- another\n\n' + TAIL).decision, 'allow', 'bold head and bullets are fine');
  assert.equal(decide(owner(3), 'This session: we fixed the thing.\n\n' + TAIL).decision, 'allow', 'recap text on the head line counts');
});

test('short sessions and non-SAFE endings are exempt', () => {
  const m = 'Nothing changed.\n\n' + TAIL;
  assert.equal(decide(owner(2), m).decision, 'allow', 'nothing landed, 2 owner messages');
  assert.equal(decide([...owner(1), ...land()], 'Waiting.\n\nKEEP OPEN — waiting on a run').decision, 'allow');
  assert.equal(decide([...owner(5), ...land()], 'You need to: pick.\n\nACTION NEEDED FROM YOU — pick one').decision, 'allow');
});

test('owner messages exclude hook feedback, notifications and compaction', () => {
  const ev = [...owner(2),
    { kind: 'user_text', text: 'Stop hook feedback: x', synthetic: true, foreignTurn: false },
    { kind: 'user_text', text: '[SYSTEM NOTIFICATION] x', synthetic: true, foreignTurn: true },
    { kind: 'user_text', text: '   ', synthetic: false, foreignTurn: false }];
  assert.equal(ownerMessageCount(ev), 2);
  assert.equal(decide(ev, 'x\n\n' + TAIL).decision, 'allow');
});

test('recap shape: empty, over 5 lines, ids, paths and hashes block', () => {
  const ev = [...owner(1), ...land()];
  assert.match(decide(ev, 'This session:\n\n' + TAIL).message, /Recap empty/);
  const six = 'This session:\n' + ['a', 'b', 'c', 'd', 'e', 'f'].join('\n') + '\n\n' + TAIL;
  assert.match(decide(ev, six).message, /too long: 6 lines/);
  assert.equal(parseRecap('This session:\n1\n2\n3\n4\n5\n\nStill running: x').lines.length, MAX_LINES);
  assert.match(decide(ev, 'This session:\nFixed BRO-7985 today.\n\n' + TAIL).message, /card id/);
  assert.match(decide(ev, 'This session:\nEdited scripts/lib/x.mjs for it.\n\n' + TAIL).message, /file path/);
  assert.match(decide(ev, 'This session:\nUpdated verify-edits.sh for it.\n\n' + TAIL).message, /file path/);
  assert.match(decide(ev, 'This session:\nLanded as d56d1f35c11 on main.\n\n' + TAIL).message, /commit hash/);
  assert.equal(decide(ev, 'This session:\nAdded and/or removed 1234567 rows, decade defaced.\n\n' + TAIL).decision, 'allow', 'and/or, plain numbers and plain words are not leaks');
});

test('the recap ends at the next owner-format section, even without a blank line', () => {
  assert.deepEqual(parseRecap('This session:\none\ntwo\nStill running: nothing.\nSAFE TO ARCHIVE — x').lines, ['one', 'two']);
  assert.equal(parseRecap('no recap here\nSAFE TO ARCHIVE — x').found, false);
  assert.equal(parseRecap('```\nThis session:\nx\n```\nSAFE TO ARCHIVE — x').found, false, 'fenced code is ignored');
});

test('reviewer blockers: prose "This session is done" is no recap; gate-token lines are not recap lines; backticks leak', () => {
  const ev = [...owner(1), ...land()];
  assert.equal(parseRecap('This session is done.\nSAFE TO ARCHIVE — x').found, false);
  assert.match(decide(ev, 'This session is done.\n\n' + TAIL).message, /Recap missing/);
  const tok = 'This session:\nFixed the score page.\nDISPATCHED: BRO-123 ("x")\nNO-VERIFY: reason here\n\n' + TAIL;
  assert.deepEqual(parseRecap(tok).lines, ['Fixed the score page.']);
  assert.equal(decide(ev, tok).decision, 'allow');
  assert.match(decide(ev, 'This session:\nRan `npm test` for it.\n\n' + TAIL).message, /backticks/);
  assert.equal(decide(ev, 'This session:\nCOVID-19 data was not touched.\n\n' + TAIL).decision, 'allow');
});

test('Codex review: a quoted NO-RECAP does not bypass, and a recap that says nothing changed is refused', () => {
  const ev = [...owner(1), ...land()];
  assert.equal(decide(ev, 'The rule says write NO-RECAP: some reason here to skip.\nplain\n\n' + TAIL).decision, 'block', 'mid-line mention is not a bypass');
  assert.equal(decide(ev, 'NO-RECAP: 123456789\n' + TAIL).decision, 'block', '9 chars is not 10');
  assert.equal(decide(ev, 'NO-RECAP: owner asked for a one-line close\n' + TAIL).decision, 'allow');
  assert.match(decide(ev, 'This session:\nNothing changed since my last message.\n\n' + TAIL).message, /Recap empty/);
  assert.equal(decide(ev, 'This session:\nNothing changed in the live test.\nThe archive recap check was built.\n\n' + TAIL).decision, 'allow', 'one real line is enough');
});

test('kill switch, bypass, non-cloud and missing transcript all allow', () => {
  const ev = [...owner(1), ...land()]; const m = 'plain\n\n' + TAIL;
  assert.equal(decide(ev, m, { ...ENV, SESSION_RECAP_STOP_DISABLE: '1' }).decision, 'allow');
  assert.equal(decide(ev, m, {}).decision, 'allow');
  assert.equal(decide(ev, 'NO-RECAP: owner asked for a one-line close\n' + m).decision, 'allow');
  assert.equal(decide(ev, 'NO-RECAP: short\n' + m).decision, 'block', 'reason must be 10+ chars');
  assert.equal(decide(null, m).decision, 'allow');
});

test('real Stop-hook entry: exit 2 without the recap, 0 with it, 0 with the kill switch, capped nudges', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recap-'));
  const tp = path.join(dir, 't.jsonl');
  const L = (o) => JSON.stringify(o);
  fs.writeFileSync(tp, [
    L({ type: 'user', message: { role: 'user', content: 'please build it' } }),
    L({ type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', id: 'p1', name: 'Bash', input: { command: 'git push origin HEAD:refs/heads/land/x' } }] } }),
    L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'p1', content: 'ok' }] } }),
  ].join('\n'));
  const script = path.join(import.meta.dirname, 'session-recap-stop.mjs');
  const run = (msg, extra = {}) => spawnSyncStdinFile('node', [script, '--stop-hook'], { input: JSON.stringify({ transcript_path: tp, session_id: 's', last_assistant_message: msg }), env: { ...process.env, CLAUDE_CODE_REMOTE: 'true', ...extra }, encoding: 'utf8' });
  const counter = path.join(os.tmpdir(), `session-recap-stop-${createHash('sha1').update(tp).digest('hex').slice(0, 12)}`);
  try {
    const bad = run('Nothing changed.\n\n' + TAIL);
    assert.equal(bad.status, 2, bad.stderr); assert.match(bad.stderr, /Recap missing/);
    assert.equal(run(RECAP + TAIL).status, 0);
    assert.equal(run('Nothing changed.\n\n' + TAIL, { SESSION_RECAP_STOP_DISABLE: '1' }).status, 0);
    assert.equal(run('Nothing changed.\n\n' + TAIL).status, 2, 'block 2 of 3'); assert.equal(run('Nothing changed.\n\n' + TAIL).status, 2, 'block 3 of 3');
    assert.equal(run('Nothing changed.\n\n' + TAIL).status, 0, 'the cap lets the fourth close through');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(counter, { force: true }); }
});

// Replay through the REAL verify-edits.sh Stop hook. The fixture is the opening owner message and the land push of the long
// parent session of BRO-7985 (a real cloud transcript that ended "Nothing changed since my last message").
test('hook replay: [VE:RECAP] blocks the "Nothing changed since my last message" close, passes with a recap, kill switch lets it by', () => {
  const dir = import.meta.dirname;
  const tp = path.join(dir, 'fixtures', 'bro-7985-long-session', 'transcript.jsonl');
  const hook = path.join(dir, '..', '..', '.claude', 'hooks', 'verify-edits.sh');
  const counter = path.join(os.tmpdir(), `session-recap-stop-${createHash('sha1').update(tp).digest('hex').slice(0, 12)}`);
  const off = { ROOT_CAUSE_STOP_DISABLE: '1', EFFECT_PENDING_STOP_DISABLE: '1', RETRO_COVERAGE_STOP_DISABLE: '1', LIVE_RUN_STOP_DISABLE: '1', SKEPTIC_REVIEW_STOP_DISABLE: '1' }; // isolate this gate
  const run = (msg, extra = {}) => spawnSyncStdinFile('bash', [hook], { input: JSON.stringify({ transcript_path: tp, session_id: 's', stop_hook_active: false, last_assistant_message: msg }), env: { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'recap-home-')), CLAUDE_CODE_REMOTE: 'true', ...off, ...extra }, encoding: 'utf8' });
  const CLOSE = '\n\nStill running: nothing.\nYou need to: nothing.\n\nSAFE TO ARCHIVE — everything is finished';
  fs.rmSync(counter, { force: true });
  try {
    const bad = run('Nothing changed since my last message.' + CLOSE);
    assert.equal(bad.status, 2, bad.stderr); assert.match(bad.stderr, /\[VE:RECAP\]/);
    fs.rmSync(counter, { force: true });
    assert.doesNotMatch(run('This session:\nSession messaging no longer asks for approval in the app project.\nA check now fails if that setting goes missing.' + CLOSE).stderr, /\[VE:RECAP\]/);
    fs.rmSync(counter, { force: true });
    assert.doesNotMatch(run('Nothing changed since my last message.' + CLOSE, { SESSION_RECAP_STOP_DISABLE: '1' }).stderr, /\[VE:RECAP\]/);
  } finally { fs.rmSync(counter, { force: true }); }
});
