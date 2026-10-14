// BRO-5359: review-coverage.mjs — a /ship-check only counts when its reviewers really ran.
// Run: node --test scripts/lib/review-coverage.test.mjs
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkTranscript } from './transcript-scan.mjs';
import { evaluateCoverage, landGateDecision, stopHookDecision, findRuns, findSessionTranscript } from './review-coverage.mjs';
import { checkReviewCoverage } from './land-preflight.mjs';
import { landPushTargets } from './push-command.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'scripts', 'lib', 'review-coverage.mjs');

let n = 0;
const use = (name, input) => ({ kind: 'assistant_tool_use', name, input, id: `t${++n}` });
const res = (u, content = 'ok', isError = false) => ({ kind: 'tool_result', tool_use_id: u.id, content, isError });
const skill = (s = 'ship-check') => use('Skill', { skill: s });
const agent = () => use('Agent', { subagent_type: 'review-panelist', prompt: 'review' });
const curl = () => use('Bash', { command: 'curl -s https://api.openai.com/v1/chat/completions -H "Authorization: Bearer $K" -d @/tmp/x' });
const ev = (...pairs) => pairs.flatMap((u) => [u, res(u)]);
const CLOUD = { CLAUDE_CODE_REMOTE: 'true' };

test('no ship-check run: incomplete', () => {
  const c = evaluateCoverage(ev(use('Bash', { command: 'ls' })));
  assert.equal(c.ran, false);
  assert.equal(c.complete, false);
});

test('skill call alone (the reported failure): incomplete, names both missing reviewers', () => {
  const c = evaluateCoverage(ev(skill()));
  assert.equal(c.ran, true);
  assert.equal(c.complete, false);
  assert.equal(c.missing.length, 2);
});

test('only the external reviewer ran (gpt mini only): still incomplete', () => {
  const c = evaluateCoverage(ev(skill(), curl()));
  assert.equal(c.complete, false);
  assert.match(c.missing[0], /review-panelist/);
});

test('review-panelist plus external reviewer after the skill: complete, with evidence', () => {
  const c = evaluateCoverage(ev(skill(), agent(), curl()));
  assert.equal(c.complete, true);
  assert.match(c.evidence.outputsHash, /^[0-9a-f]{64}$/);
  assert.ok(c.evidence.invocationId);
  assert.equal(c.evidence.checks.length, 2);
});

test('codex exec counts as the external reviewer; code-review counts as a strong run', () => {
  const codex = use('Bash', { command: 'cat p | codex exec --sandbox read-only -C "$PWD"' });
  assert.equal(evaluateCoverage(ev(skill('code-review'), agent(), codex)).complete, true);
});

test('reviewers launched BEFORE the skill call do not count', () => {
  assert.equal(evaluateCoverage(ev(agent(), curl(), skill())).complete, false);
});

test('a grep for the host, or a curl that errored, is not a review', () => {
  const grep = use('Bash', { command: 'grep -rn api.openai.com scripts/' });
  assert.equal(evaluateCoverage(ev(skill(), agent(), grep)).complete, false);
  const [s, a, bad] = [skill(), agent(), curl()];
  assert.equal(evaluateCoverage([s, res(s), a, res(a), bad, res(bad, 'HTTP 401', true)]).complete, false);
});

test('an Agent call that never got a result does not count', () => {
  const a = agent();
  const s = skill();
  assert.equal(evaluateCoverage([s, res(s), a, ...ev(curl())]).complete, false);
});

test('failed Skill call plus reading the command file by hand counts as the run', () => {
  const s = skill();
  const read = use('Read', { file_path: '/x/.claude/commands/ship-check.md' });
  const events = [s, res(s, 'Unknown skill: ship-check', true), read, res(read), ...ev(agent(), curl())];
  assert.equal(findRuns(events).length, 1);
  assert.equal(evaluateCoverage(events).complete, true);
  assert.equal(findRuns([s, res(s, 'Unknown skill', true)]).length, 0);
});

test('typed slash command counts as a run', () => {
  const typed = { kind: 'user_text', text: '<command-name>/ship-check</command-name>' };
  assert.equal(evaluateCoverage([typed, ...ev(agent(), curl())]).complete, true);
});

test('land gate: allow / skip / block matrix', () => {
  const full = ev(skill(), agent(), curl());
  const thin = ev(skill());
  const base = { command: 'git push origin HEAD:refs/heads/land/x', gatedLines: 200, budget: 30, env: CLOUD };
  assert.equal(landGateDecision({ ...base, events: full }).decision, 'allow');
  assert.equal(landGateDecision({ ...base, events: thin }).decision, 'block');
  assert.match(landGateDecision({ ...base, events: thin }).message, /review-panelist/);
  assert.equal(landGateDecision({ ...base, events: thin, gatedLines: 30 }).decision, 'skip');
  assert.equal(landGateDecision({ ...base, events: null }).decision, 'skip');
  assert.equal(landGateDecision({ ...base, events: thin, env: {} }).decision, 'skip');
  assert.equal(landGateDecision({ ...base, events: thin, env: { ...CLOUD, SHIP_CHECK_LAND_GATE_DISABLE: '1' } }).decision, 'skip');
  assert.equal(landGateDecision({ ...base, events: thin, command: `${base.command} # NO-SHIP-CHECK: reviewers cannot run here` }).decision, 'allow');
  assert.equal(landGateDecision({ ...base, events: thin, command: `${base.command} # NO-SHIP-CHECK: short` }).decision, 'block');
});

test('checkReviewCoverage: blocks a thin review, ignores NO-LAND-PREFLIGHT, passes a full one', () => {
  const cmd = 'git push origin HEAD:refs/heads/land/bro-1-x';
  const targets = landPushTargets(cmd);
  assert.equal(targets.length, 1);
  const stats = { files: [], totalLines: 120 };
  const run = (command, events) => checkReviewCoverage({ command, cwd: ROOT, targets: landPushTargets(command), env: CLOUD, seams: { events, stats } });
  assert.equal(run(cmd, ev(skill())).decision, 'block');
  assert.equal(run(`${cmd} # NO-LAND-PREFLIGHT: rebase is known to conflict here`, ev(skill())).decision, 'block');
  assert.equal(run(cmd, ev(skill(), agent(), curl())).decision, 'allow');
  assert.equal(checkReviewCoverage({ command: cmd, cwd: ROOT, targets, env: {}, seams: { events: ev(skill()), stats } }), null);
});

test('walkTranscript surfaces is_error on tool results', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-'));
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'boom', is_error: true }, { type: 'tool_result', tool_use_id: 'b', content: 'fine' }] } }) + '\n');
  const [a, b] = walkTranscript(file);
  assert.equal(a.isError, true);
  assert.equal(b.isError, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI on a real JSONL transcript: thin run exits 3 and --record refuses; missing file exits 2', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-'));
  const file = path.join(dir, 's.jsonl');
  const line = (o) => JSON.stringify(o) + '\n';
  fs.writeFileSync(
    file,
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', id: 's1', input: { skill: 'ship-check' } }] } }) +
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 's1', content: 'Launching skill' }] } }),
  );
  const r = spawnSync('node', [CLI, `--transcript=${file}`, '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 3);
  assert.equal(JSON.parse(r.stdout).complete, false);
  const rec = spawnSync('node', [CLI, '--record', `--transcript=${file}`], { encoding: 'utf8' });
  assert.equal(rec.status, 3);
  assert.match(rec.stderr, /NOT recording a pass/);
  assert.equal(spawnSync('node', [CLI, `--transcript=${dir}/nope.jsonl`], { encoding: 'utf8' }).status, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('findSessionTranscript locates <home>/.claude/projects/*/<id>.jsonl', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-home-'));
  fs.mkdirSync(path.join(home, '.claude', 'projects', 'p1'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'projects', 'p1', 'abc.jsonl'), '');
  assert.ok(findSessionTranscript('abc', home).endsWith('p1/abc.jsonl'));
  assert.equal(findSessionTranscript('zzz', home), null);
  assert.equal(findSessionTranscript('', home), null);
  fs.rmSync(home, { recursive: true, force: true });
});

test('stop hook decision: only a SAFE TO EXIT after an uncovered ship-check blocks', () => {
  const thin = ev(skill());
  const full = ev(skill(), agent(), curl());
  const done = 'All landed.\n\nSAFE TO EXIT';
  const d = (o) => stopHookDecision({ lastMessage: done, events: thin, env: CLOUD, ...o }).decision;
  assert.equal(d({}), 'block');
  assert.equal(d({ events: full }), 'allow');
  assert.equal(d({ lastMessage: 'Working.\n\nNOT SAFE TO EXIT' }), 'allow');
  assert.equal(d({ lastMessage: 'No review needed.\nNO-SHIP-CHECK: reviewers cannot run in this container\n\nSAFE TO EXIT' }), 'allow');
  assert.equal(d({ lastMessage: 'NO-SHIP-CHECK: short\n\nSAFE TO EXIT' }), 'block');
  assert.equal(d({ events: ev(use('Bash', { command: 'ls' })) }), 'allow', 'no strong run: verify-edits asks for the review itself');
  assert.equal(d({ events: null }), 'allow');
  assert.equal(d({ env: {} }), 'allow');
  assert.equal(d({ env: { ...CLOUD, SHIP_CHECK_COVERAGE_DISABLE: '1' } }), 'allow');
});

test('stop hook wrapper: exit 2 for a thin run, 0 for a full one, blocks stop after 3 tries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-stop-'));
  const row = (type, content) => JSON.stringify({ type, message: { content } }) + '\n';
  const use1 = (id, name, input) => row('assistant', [{ type: 'tool_use', name, id, input }]);
  const out1 = (id, c) => row('user', [{ type: 'tool_result', tool_use_id: id, content: c }]);
  const thin = path.join(dir, 'thin.jsonl');
  const full = path.join(dir, 'full.jsonl');
  const base = use1('s1', 'Skill', { skill: 'ship-check' }) + out1('s1', 'ok');
  fs.writeFileSync(thin, base);
  fs.writeFileSync(full, base + use1('a1', 'Agent', { subagent_type: 'review-panelist' }) + out1('a1', 'done') + use1('b1', 'Bash', { command: 'curl -s https://api.openai.com/v1/x' }) + out1('b1', '{}'));
  const hook = path.join(ROOT, '.claude', 'hooks', 'stop-review-coverage.sh');
  const run = (t) => spawnSync('bash', [hook], { input: JSON.stringify({ transcript_path: t, last_assistant_message: 'Done.\n\nSAFE TO EXIT' }), encoding: 'utf8', env: { ...process.env, ...CLOUD, SHIP_CHECK_COVERAGE_DISABLE: '' } });
  assert.equal(run(full).status, 0);
  const codes = [run(thin).status, run(thin).status, run(thin).status, run(thin).status];
  assert.deepEqual(codes, [2, 2, 2, 0], 'blocks three times, then lets the session end rather than loop');
  assert.match(run(thin).stderr + '', /^$|BLOCKED/);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const f of fs.readdirSync(os.tmpdir())) if (f.startsWith('review-coverage-stop-')) fs.rmSync(path.join(os.tmpdir(), f), { force: true });
});

test('settings.json registers the stop hook beside verify-edits', () => {
  const st = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude', 'settings.json'), 'utf8'));
  const cmds = st.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(cmds.some((c) => c.includes('verify-edits.sh')));
  assert.ok(cmds.some((c) => c.includes('stop-review-coverage.sh')));
});
