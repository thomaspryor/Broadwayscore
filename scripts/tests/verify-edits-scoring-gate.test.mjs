// scripts/tests/verify-edits-scoring-gate.test.mjs
//
// BRO-5270: the scoring-delta Stop gate in .claude/hooks/verify-edits.sh.
// Before this, the gate (a) watched 5 of the ~20 files scoring-delta.js
// replays, and (b) judged a run by scraping its output for failure markers,
// so `scoring-delta.js | tail`, `--json`, `2>/dev/null`, a later
// test-temporal-override-regression run or a bare `grep scoring-delta`
// all passed a session whose real run exited 2. Now scoring-delta.js stamps
// its exit code (scripts/lib/scoring-watchlists.js) and the hook reads it.
//
// Pattern follows verify-edits-cloud-session-gates.test.mjs: pipe a real Stop
// payload into the REAL repo hook and read its exit code (0 allowed, 2 BLOCKED).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSyncStdinFile } from '../../tests/helpers/spawn-stdin-file.mjs';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');
const HOOK = path.join(REPO_ROOT, '.claude', 'hooks', 'verify-edits.sh');
const watch = require('../lib/scoring-watchlists.js');
const delta = require('../scoring-delta.js');

const DIRS = [];
after(() => {
  for (const d of DIRS) {
    const t = path.join(d, 'transcript', `${path.basename(d)}.jsonl`);
    fs.rmSync(`/tmp/verify-edits-chain-${execSync(`printf '%s' '${t}' | cksum`).toString().split(' ')[0]}`, { force: true });
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// stampFile()/readStamps() resolve the stamp dir from the env at call time.
function inStampDir(dir, fn) {
  const saved = process.env.SCORING_DELTA_STAMP_DIR;
  process.env.SCORING_DELTA_STAMP_DIR = dir;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.SCORING_DELTA_STAMP_DIR; else process.env.SCORING_DELTA_STAMP_DIR = saved;
  }
}

const ago = (s) => new Date(Date.now() - s * 1000).toISOString();
const edit = (rel) => ({ name: 'Edit', input: { file_path: `/work/repo/${rel}`, old_string: 'a', new_string: 'b' } });
const bash = (command, result = 'ok', isError = false) => ({ name: 'Bash', input: { command }, result, isError });
const SHIP_CHECK = { name: 'Skill', input: { skill: 'ship-check' } };

// One fixture = a session id, a transcript of tool calls (each result stamped
// `ts`), and the stamps scoring-delta.js would have appended for it.
function fixture(calls, stamps = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 've-scoring-'));
  DIRS.push(dir);
  const sid = path.basename(dir);
  const stampDir = path.join(dir, 'stamps');
  fs.mkdirSync(stampDir);
  inStampDir(stampDir, () => { for (const s of stamps) fs.appendFileSync(watch.stampFile(sid), JSON.stringify(s) + '\n'); });
  const lines = [JSON.stringify({ type: 'user', timestamp: ago(600), message: { role: 'user', content: [{ type: 'text', text: 'do the work' }] } })];
  for (const c of calls) {
    const id = `tu-${randomUUID()}`;
    lines.push(JSON.stringify({ type: 'assistant', timestamp: c.ts, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: c.name, input: c.input }] } }));
    lines.push(JSON.stringify({ type: 'user', timestamp: c.ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: c.result ?? 'ok', ...(c.isError ? { is_error: true } : {}) }] } }));
  }
  fs.mkdirSync(path.join(dir, 'transcript'));
  const transcript = path.join(dir, 'transcript', `${sid}.jsonl`);
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
  return { transcript, stampDir, sid };
}

function runHook({ transcript, stampDir }, lastMsg = 'Done.') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 've-scoring-home-'));
  try {
    const r = spawnSyncStdinFile('bash', [HOOK], {
      input: JSON.stringify({ transcript_path: transcript, session_id: 'x', stop_hook_active: false, last_assistant_message: lastMsg }),
      encoding: 'utf8',
      env: { ...process.env, HOME: home, SCORING_DELTA_STAMP_DIR: stampDir, BOARD_GATE_DISABLED: '1',
        SESSION_STATUS_GATE_DISABLE: '1', CLOUD_CHAIN_GATE_DISABLE: '1', VISUAL_QA_DISABLE: '1' },
      timeout: 20_000,
    });
    return { status: r.status, stderr: r.stderr || '' };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const blocked = (r, re, msg) => {
  assert.equal(r.status, 2, `${msg}: expected BLOCKED, got ${r.status}. stderr: ${r.stderr.slice(0, 400)}`);
  if (re) assert.match(r.stderr, re, msg);
};
const allowed = (r, msg) => assert.equal(r.status, 0, `${msg}: expected allowed, got ${r.status}. stderr: ${r.stderr.slice(0, 400)}`);

const TQ = 'scripts/lib/text-quality.js';
const RG = 'scripts/lib/review-guards.js';
const stamp = (s, exitCode, changed, extra = {}) => ({ ts: ago(s), exitCode, base: 'HEAD', changed, dataFlagChanges: 0, ...extra });

test('acceptance: text-quality.js edit + scoring-delta exit 2 is blocked with the §13 A/B instruction', () => {
  const f = fixture([{ ...edit(TQ), ts: ago(300) }, { ...bash('node scripts/scoring-delta.js | tail -3'), ts: ago(200) }, { ...SHIP_CHECK, ts: ago(100) }],
    [stamp(200, 2, [TQ])]);
  blocked(runHook(f), /§13 A\/B/, 'piped exit-2 run');
});

test('acceptance: a later test-temporal-override-regression run does not wash out the exit 2', () => {
  const f = fixture([{ ...edit(TQ), ts: ago(300) }, { ...bash('node scripts/scoring-delta.js --json'), ts: ago(200) },
    { ...bash('node scripts/test-temporal-override-regression.js', 'PASS'), ts: ago(150) }, { ...SHIP_CHECK, ts: ago(100) }],
  [stamp(200, 2, [TQ])]);
  blocked(runHook(f), /§13 A\/B/, 'exit 2 then temporal-override');
});

test('grep scoring-delta / no run at all is blocked', () => {
  const f = fixture([{ ...edit('scripts/lib/score-routing.js'), ts: ago(300) }, { ...bash('grep -n scoring-delta CLAUDE.md'), ts: ago(200) }, { ...SHIP_CHECK, ts: ago(100) }]);
  blocked(runHook(f), /without a counterfactual/, 'grep only');
});

test('a clean exit-0 run that measured the edited file passes', () => {
  const f = fixture([{ ...edit(RG), ts: ago(300) }, { ...bash('node scripts/scoring-delta.js 2>&1 | tail -5'), ts: ago(200) }, { ...SHIP_CHECK, ts: ago(100) }],
    [stamp(200, 0, [RG])]);
  allowed(runHook(f), 'clean run');
});

test('a run from before the edit does not count', () => {
  const f = fixture([{ ...edit(RG), ts: ago(100) }, { ...SHIP_CHECK, ts: ago(50) }], [stamp(200, 0, [RG])]);
  blocked(runHook(f), /without a counterfactual/, 'stale stamp');
});

test('exit 0 that did not see the file (--base=HEAD after commit) is blocked as unmeasured', () => {
  const f = fixture([{ ...edit(RG), ts: ago(300) }, { ...SHIP_CHECK, ts: ago(100) }], [stamp(200, 0, [])]);
  blocked(runHook(f), /--base=origin\/main/, 'nothing to check');
});

test('the latest run decides: exit 1 (missing data) then a clean re-run passes', () => {
  const f = fixture([{ ...edit(RG), ts: ago(300) }, { ...SHIP_CHECK, ts: ago(100) }], [stamp(250, 1, []), stamp(200, 0, [RG])]);
  allowed(runHook(f), 'exit 1 then exit 0');
  const g = fixture([{ ...edit(RG), ts: ago(300) }, { ...SHIP_CHECK, ts: ago(100) }], [stamp(200, 1, [])]);
  blocked(runHook(g), /errored/, 'exit 1 alone');
});

test('an earlier watched edit is still gated after a later unrelated edit', () => {
  const f = fixture([{ ...edit(TQ), ts: ago(300) }, { ...edit('scripts/some-other.js'), ts: ago(250) },
    { ...bash('node scripts/some-other.js'), ts: ago(200) }, { ...SHIP_CHECK, ts: ago(100) }]);
  blocked(runHook(f), /text-quality\.js/, 'earlier watched edit');
});

test('a scoring pass no longer skips the later gates: an unverified later edit still blocks', () => {
  const f = fixture([{ ...edit(RG), ts: ago(300) }, { ...edit('scripts/other-tool.js'), ts: ago(250) }, { ...SHIP_CHECK, ts: ago(100) }],
    [stamp(200, 0, [RG])]);
  blocked(runHook(f), /unverified edit to `other-tool\.js`/, 'later unverified edit');
});

test('NO-VERIFY in the current turn still waives the gate', () => {
  const f = fixture([{ ...edit(TQ), ts: ago(300) }, { ...SHIP_CHECK, ts: ago(100) }], [stamp(200, 2, [TQ])]);
  allowed(runHook(f, 'NO-VERIFY: A/B re-score of 120 reviews, bucket shift 1.2%, mean drift 0.4.'), 'NO-VERIFY');
});

test('drift: the hook gates every file scoring-delta.js watches', () => {
  const all = [...new Set([...delta.INCLUSION_FILES, ...delta.SCORE_VALUE_FILES, ...delta.LLM_INPUT_FILES])];
  assert.deepEqual([...new Set([...watch.INCLUSION_FILES, ...watch.SCORE_VALUE_FILES])].sort(), all.sort(), 'scoring-delta.js re-exports the shared lists');
  assert.ok(all.length >= 20, `watchlist shrank to ${all.length}`);
  for (const rel of all) {
    const f = fixture([{ ...edit(rel), ts: ago(300) }, { ...bash(`node --check ${rel}`), ts: ago(200) }, { ...SHIP_CHECK, ts: ago(100) }]);
    blocked(runHook(f), /scoring|counterfactual/, `edit to ${rel}`);
  }
});

test('scoring-delta.js stamps its real exit code (exit 1 on a bad base), and --help leaves none', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 've-scoring-real-'));
  DIRS.push(dir);
  const env = { ...process.env, SCORING_DELTA_STAMP_DIR: dir, CLAUDE_CODE_SESSION_ID: 'real-run' };
  spawnSync('node', [path.join(REPO_ROOT, 'scripts/scoring-delta.js'), '--help'], { env, cwd: REPO_ROOT });
  assert.equal(inStampDir(dir, () => watch.readStamps('real-run')).length, 0, 'no stamp from --help');
  const r = spawnSync('node', [path.join(REPO_ROOT, 'scripts/scoring-delta.js'), '--base=no-such-ref-bro5270', '--json'], { env, cwd: REPO_ROOT });
  assert.equal(r.status, 1);
  const stamps = inStampDir(dir, () => watch.readStamps('real-run'));
  assert.equal(stamps.length, 1);
  assert.equal(stamps[0].exitCode, 1);
  assert.equal(stamps[0].base, 'no-such-ref-bro5270');
});
