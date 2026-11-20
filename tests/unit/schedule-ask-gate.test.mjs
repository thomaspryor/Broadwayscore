// BRO-7880 SCHEDULEASK: a closing that asks the owner to approve or "yes" a
// schedule is blocked (a NOT-BEFORE card needs no tap), and such an ask no
// longer satisfies WAKELESS. Real DECISION NEEDED blocks still pass.
// End-to-end runs of the real .claude/hooks/verify-edits.sh. Closings 1 and 3
// are taken from the parent session of BRO-7880 (session_01RUGH9pQDbF8D9VevmMzP6j,
// 2026-11-20), which ended "ACTION NEEDED FROM YOU: reply yes, schedule it".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSyncStdinFile } from '../helpers/spawn-stdin-file.mjs';

const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');
const HOOK = path.join(REPO_ROOT, '.claude', 'hooks', 'verify-edits.sh');
const T0 = Date.now() - 5 * 60000; // live-wait detection reads the clock
const ts = (min) => new Date(T0 + min * 60000).toISOString();
const user = (text) => ({ type: 'user', timestamp: ts(0), message: { role: 'user', content: text } });
const toolUse = (id, name, input, min) => ({ type: 'assistant', timestamp: ts(min), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const toolRes = (id, text, min) => ({ type: 'user', timestamp: ts(min), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });

function runHook(closing, extra = [], env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedask-'));
  const tp = path.join(dir, 'transcript.jsonl');
  const lines = [user('Audit the skeptic reviewer and tell me what it found.'), ...extra];
  fs.writeFileSync(tp, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const r = spawnSyncStdinFile('bash', [HOOK], {
    input: JSON.stringify({ transcript_path: tp, session_id: 'schedask-test', stop_hook_active: false, last_assistant_message: closing }),
    encoding: 'utf8',
    env: { ...process.env, HOME: dir, CLAUDE_CODE_REMOTE: 'true', BOARD_GATE_DISABLED: '1', SHIP_CHECK_COVERAGE_DISABLE: '1', ...env },
    timeout: 60000,
    killSignal: 'SIGKILL',
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: r.status, stderr: r.stderr || '' };
}
const SCHED = /asks the owner to approve or say yes to a schedule/;
const WAKELESS = /nothing will wake it to check/;

const ASKS = [
  // Real: BRO-7880 parent session closing.
  'The audit should run after a day of real use.\n\nYou need to: reply yes and I will schedule it for tomorrow 01:40 UTC.\n\nACTION NEEDED FROM YOU: reply yes, schedule it',
  'Nothing is still running.\nYou need to: approve the scheduled task prompt on your phone.\n\nACTION NEEDED FROM YOU — approve the check-in reminder.',
  'Still running: nothing.\nYou need to: tap Allow on the create_trigger prompt so the check runs tonight.\n\nKEEP OPEN — waiting on your approval of the trigger.',
  'Want me to set up a reminder for tomorrow?\n\nACTION NEEDED FROM YOU — say yes to the wake-up.',
];
for (const [i, c] of ASKS.entries()) {
  test(`a schedule ask is blocked (${i + 1})`, () => {
    const r = runHook(c);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, SCHED);
    assert.match(r.stderr, /--not-before/);
  });
}

test('the kill switch and NO-VERIFY let it through this gate', () => {
  assert.doesNotMatch(runHook(ASKS[0], [], { SCHEDULEASK_GATE_DISABLE: '1' }).stderr, SCHED);
  assert.doesNotMatch(runHook(`${ASKS[0]}\nNO-VERIFY: owner asked for this routine in this message`).stderr, SCHED);
});

const PASSES = [
  // Real (BRO-7880 parent, 2026-11-20T03:46Z): a report that QUOTES the old ask is not an ask.
  'Each change has to be run against real past sessions:\n\n1. Scheduling fix: replay real past sessions. This session\'s "reply yes to schedule it" must now be blocked. A real money question must still go through to you.\n\nNothing needed from you.\n\nKEEP OPEN: waiting on the two workers; background watchers wake this session when either reports back.',
  // A real money/taste decision.
  'The new lane would cost about $40 a night in scraping.\n\nDECISION NEEDED: turn on the paid fetch fallback for West End press nights?\nWhy this is your call: it spends money every night.\nOption A — turn it on: catches 3 more reviews a night / about $40 a night.\nOption B — leave it off: free / misses those reviews.\nMy recommendation: A because the reviews are the product.\nDefault: stays off.\n\nACTION NEEDED FROM YOU — pick A or B.',
  // Describing the rule is not an ask.
  'Filed a held card for the audit; a board worker takes it after 01:40 UTC tomorrow. I did not ask you to approve a schedule.\n\nNothing is still running.\nNothing needed from you.\n\nSAFE TO ARCHIVE — the check is on the board.',
  'Never ask the owner to approve a schedule; the hook text now says so.\n\nNothing is still running.\nNothing needed from you.\n\nSAFE TO ARCHIVE — landed and verified.',
];
for (const [i, c] of PASSES.entries()) {
  test(`not a schedule ask (${i + 1})`, () => {
    assert.doesNotMatch(runHook(c).stderr, SCHED);
  });
}

test('KEEP OPEN with a live background wait passes WAKELESS and SCHEDULEASK', () => {
  const live = [
    toolUse('b1', 'Bash', { command: 'node scripts/lib/wait-for-land.js land/x 60 --prod', run_in_background: true, timeout: 7200000 }, 1),
    toolRes('b1', 'Command running in background with ID: bx1. Output is being written to: /tmp/x', 1),
  ];
  const r = runHook('The change is landing.\n\nStill running: the land run, a background wait wakes me when it ends.\nNothing needed from you.\n\nKEEP OPEN — waiting on the land run; the background wait wakes this session.', live);
  assert.doesNotMatch(r.stderr, SCHED);
  assert.doesNotMatch(r.stderr, WAKELESS);
});

test('a schedule ask no longer counts as an owner ask for WAKELESS', () => {
  // With SCHEDULEASK off, the old shape (KEEP OPEN + "You need to: approve the trigger", nothing armed) must hit WAKELESS.
  const r = runHook(ASKS[2], [], { SCHEDULEASK_GATE_DISABLE: '1' });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, WAKELESS);
});
