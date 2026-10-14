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
import { evaluateCoverage, evaluateChain, landGateDecision, stopHookDecision, findRuns, findSessionTranscript } from './review-coverage.mjs';
import { checkReviewCoverage } from './land-preflight.mjs';
import { landPushTargets } from './push-command.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'scripts', 'lib', 'review-coverage.mjs');

let n = 0;
const tool = (name, input) => ({ kind: 'assistant_tool_use', name, input, id: `t${++n}` });
const res = (u, content = 'Findings: no blockers, three suggestions listed below.', isError = false) => ({ kind: 'tool_result', tool_use_id: u.id, content, isError });
const skill = (s = 'ship-check') => tool('Skill', { skill: s });
const agent = (prompt = 'Review this diff for correctness and design problems. '.repeat(8)) => tool('Agent', { subagent_type: 'review-panelist', prompt });
const curl = () => tool('Bash', { command: 'curl -s https://api.openai.com/v1/chat/completions -H "Authorization: Bearer $K" -d @/tmp/x' });
const ev = (...pairs) => pairs.flatMap((u) => [u, res(u)]);
const CLOUD = { CLAUDE_CODE_REMOTE: 'true' };
const text = (t) => ({ kind: 'assistant_text', text: t });
const TESTED = text('\u2501\u2501\u2501 TESTED \u2501\u2501\u2501\nReal data: yes');
const LENSES = text('LENSES:\n1. Pattern: grepped x -> clean\n2. Edges: read y -> empty\n3. User impact: z -> empty\n4. Data: q -> spark\n5. Compounding: w -> empty');
const roadmap = () => tool('mcp__github__issue_read', { method: 'get', owner: 'thomaspryor', repo: 'broadway-scorecard-data', issue_number: 1 });
// did-it-work (with its TESTED block) then a fully covered ship-check
const fullChain = () => [...ev(skill('did-it-work')), TESTED, ...ev(skill(), agent(), curl())];

test('no ship-check run: incomplete', () => {
  const c = evaluateCoverage(ev(tool('Bash', { command: 'ls' })));
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
  const codex = tool('Bash', { command: 'cat p | codex exec --sandbox read-only -C "$PWD"' });
  assert.equal(evaluateCoverage(ev(skill('code-review'), agent(), codex)).complete, true);
});

test('reviewers launched BEFORE the skill call do not count', () => {
  assert.equal(evaluateCoverage(ev(agent(), curl(), skill())).complete, false);
});

test('a grep for the host, or a curl that errored, is not a review', () => {
  const grep = tool('Bash', { command: 'grep -rn api.openai.com scripts/' });
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
  const read = tool('Read', { file_path: '/x/.claude/commands/ship-check.md' });
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
  const full = fullChain();
  const done = 'All landed.\n\nSAFE TO EXIT';
  const d = (o) => stopHookDecision({ lastMessage: done, events: thin, env: CLOUD, ...o }).decision;
  assert.equal(d({}), 'block');
  assert.equal(d({ events: full }), 'allow');
  assert.equal(d({ lastMessage: 'Working.\n\nNOT SAFE TO EXIT' }), 'allow');
  const dwiThin = [...ev(skill('did-it-work')), TESTED, ...thin]; // chain fine, ship-check reviewers missing
  assert.equal(d({ events: dwiThin }), 'block');
  assert.equal(d({ events: dwiThin, lastMessage: 'No review needed.\nNO-SHIP-CHECK: reviewers cannot run in this container\n\nSAFE TO EXIT' }), 'allow');
  assert.equal(d({ lastMessage: 'NO-SHIP-CHECK: reviewers cannot run in this container\n\nSAFE TO EXIT' }), 'block', 'one bypass must not waive did-it-work');
  assert.equal(d({ lastMessage: 'NO-SHIP-CHECK: short\n\nSAFE TO EXIT' }), 'block');
  assert.equal(d({ events: ev(tool('Bash', { command: 'ls' })) }), 'allow', 'no strong run: verify-edits asks for the review itself');
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
  const dwi = use1('d1', 'Skill', { skill: 'did-it-work' }) + out1('d1', 'ok') + row('assistant', [{ type: 'text', text: '\u2501\u2501\u2501 TESTED \u2501\u2501\u2501' }]);
  fs.writeFileSync(full, dwi + base + use1('a1', 'Agent', { subagent_type: 'review-panelist', prompt: 'Review the diff carefully for wedge risks and silent failures. '.repeat(6) }) + out1('a1', 'Findings: nothing blocking in the diff, two warnings.') + use1('b1', 'Bash', { command: 'curl -s https://api.openai.com/v1/chat/completions -d @/tmp/req.json' }) + out1('b1', 'Findings: the gate fails open on a missing transcript, which is fine.'));
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

test('code-review is trusted: it neither needs the reviewers nor resets an earlier full ship-check', () => {
  assert.equal(evaluateCoverage(ev(skill('code-review'))).complete, true);
  assert.equal(evaluateCoverage(ev(skill(), agent(), curl(), skill('code-review'))).complete, true);
  assert.equal(evaluateCoverage(ev(skill(), skill('code-review'))).complete, true, 'a later code-review covers a thin ship-check');
});

test('cheap fakes do not count as the reviewers', () => {
  const run = (a, b) => evaluateCoverage(ev(skill(), a, b)).complete;
  const echo = tool('Bash', { command: 'echo curl https://api.openai.com/v1/chat/completions -d x' });
  const models = tool('Bash', { command: 'curl -s https://api.openai.com/v1/models' });
  assert.equal(run(agent(), echo), false, 'echo is not a call');
  assert.equal(run(agent(), models), false, 'a models listing is not a review');
  assert.equal(run(agent('say ok'), curl()), false, 'a one-word prompt is not a review');
  const empty = tool('Bash', { command: 'curl -s https://api.openai.com/v1/chat/completions -d @/tmp/x' });
  assert.equal(evaluateCoverage([...ev(skill(), agent()), empty, res(empty, 'null')]).complete, false, 'null response');
  assert.equal(evaluateCoverage([...ev(skill(), agent()), empty, res(empty, '{"error":{"message":"bad key"}}')]).complete, false, 'error payload');
  const multi = tool('Bash', { command: 'echo key; P=$(mktemp)\ncurl -s https://api.openai.com/v1/chat/completions -H "Authorization: Bearer $K" -d "$(jq -n x)" | jq -r .a' });
  assert.equal(run(agent(), multi), true, 'the skill\'s real multi-line command counts');
});

test('stop hook: bold SAFE TO EXIT is matched; the 10-char message bypass is documented behavior', () => {
  const thin = ev(skill());
  assert.equal(stopHookDecision({ lastMessage: 'Done.\n\n**SAFE TO EXIT**', events: thin, env: CLOUD }).decision, 'block');
});

test('finish chain: did-it-work must have run and printed its TESTED block', () => {
  const noDwi = ev(skill(), agent(), curl());
  assert.match(evaluateChain(noDwi).join('|'), /did-it-work was never run/);
  assert.match(evaluateChain([...ev(skill('did-it-work')), ...noDwi]).join('|'), /no TESTED block/);
  assert.deepEqual(evaluateChain(fullChain()), []);
  assert.deepEqual(evaluateChain(noDwi, { lastMessage: 'NO-DID-IT-WORK: pure hook revert, nothing to run\n\nSAFE TO EXIT' }), []);
});

test('finish chain: a hollow /what-else (one lens, no roadmap read) is flagged', () => {
  const base = fullChain();
  const hollow = [...base, ...ev(skill('what-else')), text('LENSES:\n1. Pattern: found cousins')];
  const p = evaluateChain(hollow).join('|');
  assert.match(p, /1 of 5 numbered lens lines/);
  assert.match(p, /never read the real roadmap/);
  const good = [...base, roadmap(), res(roadmap()), ...ev(skill('what-else')), LENSES];
  assert.deepEqual(evaluateChain(good), []);
  const viaGh = [...base, ...ev(skill('what-else')), LENSES, tool('Bash', { command: 'gh issue view 1 --repo thomaspryor/broadway-scorecard-data --json body' })];
  assert.deepEqual(evaluateChain(viaGh), [], 'the gh form of the roadmap read (Mac) counts too');
  const wrongRepo = [...base, ...ev(skill('what-else')), LENSES, tool('mcp__github__issue_read', { method: 'get', owner: 'thomaspryor', repo: 'broadwayscore', issue_number: 1 })];
  assert.match(evaluateChain(wrongRepo).join('|'), /never read the real roadmap/);
});

test('finish chain: a Linear close-out posted before the last landing is flagged', () => {
  const done = tool('Bash', { command: 'node scripts/linear-brain.js update BRO-1 --state Done --comment x' });
  const land = tool('Bash', { command: 'git push origin HEAD:refs/heads/land/bro-1-x' });
  const base = fullChain();
  assert.match(evaluateChain([...base, done, res(done), land, res(land)]).join('|'), /close-out was posted before the last landing/);
  assert.deepEqual(evaluateChain([...base, land, res(land), done, res(done)]), []);
  assert.deepEqual(evaluateChain([...base, done, res(done), land, res(land)], { lastMessage: 'NO-WRAP-UP: closed by hand after the landing\n\nSAFE TO EXIT' }), []);
});

test('stop hook: a LENSES/TESTED block that only exists in the closing message (not yet flushed) counts', () => {
  const base = [...ev(skill('did-it-work')), ...ev(skill(), agent(), curl()), roadmap(), res(roadmap()), ...ev(skill('what-else'))];
  const closing = '\u2501\u2501\u2501 TESTED \u2501\u2501\u2501\n```\nLENSES:\n1. a: b\n2. a: b\n3. a: b\n4. a: b\n5. a: b\n```\n\nSAFE TO EXIT';
  assert.equal(stopHookDecision({ lastMessage: closing, events: base, env: CLOUD }).decision, 'allow');
  assert.equal(stopHookDecision({ lastMessage: 'Done.\n\nSAFE TO EXIT', events: base, env: CLOUD }).decision, 'block');
});

test('general-purpose reviewer accepted when it has a real review prompt; a build is required only for src/ diffs', () => {
  const gp = tool('Agent', { subagent_type: 'general-purpose', prompt: 'Please review this diff for bugs and design problems in the changed files. '.repeat(5) });
  assert.equal(evaluateCoverage(ev(skill(), gp, curl())).complete, true);
  const chatty = tool('Agent', { subagent_type: 'general-purpose', prompt: 'Tell me a long story about theatre. '.repeat(10) });
  assert.equal(evaluateCoverage(ev(skill(), chatty, curl())).complete, false, 'a long prompt that is not a review does not count');
  const build = tool('Bash', { command: 'NEXT_PUBLIC_FEATURES=criticPages npm run build 2>&1 | tail -30' });
  const full = ev(skill(), agent(), curl());
  assert.equal(evaluateCoverage(full, { requireBuild: true }).complete, false);
  assert.match(evaluateCoverage(full, { requireBuild: true }).missing[0], /npm run build/);
  assert.equal(evaluateCoverage([...full, ...ev(build)], { requireBuild: true }).complete, true);
  assert.equal(evaluateCoverage([...full, ...ev(tool('Bash', { command: 'echo npm run build' }))], { requireBuild: true }).complete, false);
  const gate = { command: 'git push origin HEAD:refs/heads/land/x', gatedLines: 90, env: CLOUD, events: full };
  assert.equal(landGateDecision({ ...gate, touchesSrc: false }).decision, 'allow');
  assert.equal(landGateDecision({ ...gate, touchesSrc: true }).decision, 'block');
});

test('review-ship-check ship-check findings: honest formats are not blocked', () => {
  const base = fullChain();
  const withLenses = (t) => [...base, roadmap(), res(roadmap()), ...ev(skill('what-else')), text(t)];
  const five = ['1. a: b', '2. a: b', '3. a: b', '4. a: b', '5. a: b'];
  assert.deepEqual(evaluateChain(withLenses(`LENSES:\n${five.join('\n')}`)), []);
  assert.deepEqual(evaluateChain(withLenses(`**LENSES:**\n${five.map((l) => l.replace('. ', ') ')).join('\n')}`)), [], '1) numbering');
  assert.deepEqual(evaluateChain(withLenses(`I will print the LENSES: block now.\n\nLENSES:\n${five.map((l) => `**${l.slice(0, 2)}**${l.slice(2)}`).join('\n')}`)), [], 'earlier mention + bold numbers');
  assert.match(evaluateChain(withLenses('LENSES:\n1. a: b\n\nOther notes:\n- one\n- two\n- three\n- four\n\nSummary:\n2. x\n3. y\n4. z\n5. w')).join('|'), /of 5 numbered lens lines/, 'numbered summary far below the block does not count');
  assert.deepEqual(evaluateChain(withLenses('LENSES:\n1. a: b\n   wrapped line one\n   wrapped line two\n2. a: b\n3. a: b\n   wrapped\n4. a: b\n5. a: b')), [], 'wrapped items count');
  for (const g of ['\u2550\u2550\u2550 TESTED \u2550\u2550\u2550', '\u2500\u2500 TESTED', '**TESTED**', '## TESTED', 'TESTED:']) {
    assert.deepEqual(evaluateChain([...ev(skill('did-it-work')), text(g), ...ev(skill(), agent(), curl())]), [], g);
  }
});

test('review-ship-check findings: preview is not a review, pushes that delete land refs are not landings, fallbacks count', () => {
  const preview = tool('Agent', { subagent_type: 'general-purpose', prompt: 'Take a screenshot of the local preview page and describe the layout in detail. '.repeat(4) });
  assert.equal(evaluateCoverage(ev(skill(), preview, curl())).complete, false);
  const done = tool('Bash', { command: 'node scripts/linear-brain.js update BRO-1 --state=Done' });
  const land = tool('Bash', { command: 'git push origin HEAD:refs/heads/land/bro-1-x' });
  const del = tool('Bash', { command: 'git push origin --delete land/bro-1-x' });
  assert.deepEqual(evaluateChain([...fullChain(), land, res(land), done, res(done), del, res(del)]), [], 'cleanup after the close-out');
  // did-it-work failing with Unknown skill, then read by hand
  const s = skill('did-it-work');
  const read = tool('Read', { file_path: '/x/.claude/commands/did-it-work.md' });
  const events = [s, res(s, 'Unknown skill: did-it-work', true), read, res(read), TESTED, ...ev(skill(), agent(), curl())];
  assert.deepEqual(evaluateChain(events), []);
});

test('review-ship-check findings: build recognition, code-review-only sessions, counter reset on a completed chain', () => {
  const full = ev(skill(), agent(), curl());
  for (const c of ['timeout 900 npm run build', 'time npm run build 2>&1 | tail -5', 'bash -c "cd x && npm run build"', 'NEXT_PUBLIC_A=1 npx next build']) {
    assert.equal(evaluateCoverage([...ev(tool('Bash', { command: c })), ...full], { requireBuild: true }).complete, true, `${c} (a build before the skill call counts)`);
  }
  const cr = ev(skill('code-review'));
  assert.equal(stopHookDecision({ lastMessage: 'Reviewed.\n\nSAFE TO EXIT', events: cr, env: CLOUD }).decision, 'allow', 'pure code-review is not held to the ship-check chain');
  const src = { files: [{ path: 'src/lib/x.ts', added: 40, deleted: 0 }], totalLines: 40 };
  const cmd = 'git push origin HEAD:refs/heads/land/bro-1-x';
  const res1 = checkReviewCoverage({ command: cmd, cwd: ROOT, targets: landPushTargets(cmd), env: CLOUD, seams: { events: full, stats: src } });
  assert.equal(res1.decision, 'block', 'src diff without a build is blocked through checkReviewCoverage');
  assert.match(res1.message, /npm run build/);
  assert.equal(checkReviewCoverage({ command: cmd, cwd: ROOT, targets: landPushTargets(cmd), env: CLOUD, seams: { events: [...full, ...ev(tool('Bash', { command: 'npm run build' }))], stats: src } }).decision, 'allow');
});
