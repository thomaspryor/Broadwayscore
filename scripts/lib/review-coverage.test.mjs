// BRO-5359: review-coverage.mjs — a /ship-check only counts when its reviewers really ran.
// Run: node --test scripts/lib/review-coverage.test.mjs
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSyncStdinFile } from '../../tests/helpers/spawn-stdin-file.mjs';
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
const roadmap = () => tool('mcp__Linear__list_issues', { query: 'fantasy' });
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

// BRO-5430: a real ship-check call was not counted because an apostrophe in its heredoc prompt
// paired with a later quote and erased `$(curl`; and a heredoc that only WROTE a curl line counted.
test('apostrophes in heredoc prompts or quoted strings do not hide a real curl; heredoc text is not a call', () => {
  const covered = (command) => evaluateCoverage(ev(skill(), agent(), tool('Bash', { command }))).complete;
  const heredocPrompt = [
    'P=$(mktemp /tmp/p.XXXXXX); {',
    "cat <<'PROMPT_HEAD'",
    "Find what's brittle. It's a review.",
    "And one more apostrophe: don't.",
    'PROMPT_HEAD',
    'git diff origin/main..HEAD',
    '} > $P',
    'RESP=$(curl -s https://api.openai.com/v1/chat/completions -H "Content-Type: application/json" -d "$(jq -n --rawfile u $P \'{model:"m"}\')")',
    'echo "$RESP" | jq -r .choices[0].message.content',
  ].join('\n');
  assert.equal(covered(heredocPrompt), true, 'odd apostrophes in a heredoc prompt');
  assert.equal(covered('X="it\'s"; RESP=$(curl -s "https://api.openai.com/v1/chat/completions" -d "don\'t")'), true, 'apostrophes inside double quotes around curl');
  assert.equal(covered("cat <<'PROMPT_HEAD' > /tmp/p\nwhat's here\nPROMPT_HEAD\ncat /tmp/p | codex exec --sandbox read-only"), true, 'codex exec after a heredoc');
  const writesOnly = "cat > /tmp/probe.mjs <<'EOF'\nconst x = `curl -s https://api.openai.com/v1/chat/completions -d @b`;\nEOF\nnode /tmp/probe.mjs";
  assert.equal(covered(writesOnly), false, 'a curl line inside a heredoc body is data, not a call');
  // Accepted limit (header): a review run by `bash <<EOF` is not counted.
  assert.equal(covered("bash <<'EOF'\ncurl -s https://api.openai.com/v1/chat/completions -d @x\nEOF"), false);
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
  const run = (command, events) => checkReviewCoverage({ command, cwd: ROOT, targets: landPushTargets(command), env: CLOUD, seams: { events, stats, noLog: true } });
  assert.equal(run(cmd, ev(skill())).decision, 'block');
  assert.equal(run(`${cmd} # NO-LAND-PREFLIGHT: rebase is known to conflict here`, ev(skill())).decision, 'block');
  assert.equal(run(cmd, ev(skill(), agent(), curl())).decision, 'allow');
  assert.equal(checkReviewCoverage({ command: cmd, cwd: ROOT, targets, env: {}, seams: { events: ev(skill()), stats, noLog: true } }), null);
});

test('walkTranscript surfaces is_error on tool results', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-'));
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'boom', is_error: true }, { type: 'tool_result', tool_use_id: 'b', content: 'fine' }] } }) + '\n');
  const [a, b] = walkTranscript(file);
  assert.equal(a.isError, true);
  assert.equal(b.isError, false);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test('findSessionTranscript locates <home>/.claude/projects/*/<id>.jsonl', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-home-'));
  fs.mkdirSync(path.join(home, '.claude', 'projects', 'p1'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'projects', 'p1', 'abc.jsonl'), '');
  assert.ok(findSessionTranscript('abc', home).endsWith('p1/abc.jsonl'));
  assert.equal(findSessionTranscript('zzz', home), null);
  assert.equal(findSessionTranscript('', home), null);
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
  // BRO-6020: SAFE TO ARCHIVE is the current claim (legacy SAFE TO EXIT stays an alias); the hold verdicts never block.
  assert.equal(d({ lastMessage: 'All landed.\n\nSAFE TO ARCHIVE — done.' }), 'block');
  assert.equal(d({ lastMessage: 'All landed.\n\n**SAFE TO ARCHIVE** — done.' }), 'block');
  assert.equal(d({ lastMessage: 'All landed.\n\n- SAFE TO ARCHIVE — done.' }), 'block', 'a bullet must not skip the gate');
  assert.equal(d({ lastMessage: 'All landed.\n\n• SAFE TO ARCHIVE — done.' }), 'block');
  assert.equal(d({ lastMessage: 'Working.\n\nKEEP OPEN — CI still running.' }), 'allow');
  assert.equal(d({ lastMessage: 'DECISION NEEDED: x\n\nACTION NEEDED FROM YOU — answer it.' }), 'allow');
  assert.equal(d({ events: null }), 'allow');
  assert.equal(d({ env: {} }), 'allow');
  assert.equal(d({ env: { ...CLOUD, SHIP_CHECK_COVERAGE_DISABLE: '1' } }), 'allow');
});

test('verify-edits.sh (the Stop hook wired in every cloud container) runs the gate: exit 2 for a thin run, 0 for a full one, 3 blocks then lets go', () => {
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
  const hook = path.join(ROOT, '.claude', 'hooks', 'verify-edits.sh');
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-home-')); // defeats the Mac-master self-skip
  const run = (tr) => spawnSyncStdinFile('bash', [hook], { input: JSON.stringify({ transcript_path: tr, session_id: 'rc-test', last_assistant_message: 'Done.\n\nSAFE TO EXIT' }), encoding: 'utf8', env: { ...process.env, ...CLOUD, HOME: fakeHome, SHIP_CHECK_COVERAGE_DISABLE: '' } });
  const codes = [run(thin), run(thin), run(thin), run(thin)].map((r) => r.status);
  assert.deepEqual(codes.slice(0, 3), [2, 2, 2], 'blocks three times');
  assert.match(run(thin).stderr, /^(?:(?!BLOCKED \(BRO-5359\)).)*$/s, 'after its budget the review-coverage gate stops blocking (other verify-edits gates may still speak)');
  assert.doesNotMatch(run(full).stderr, /BRO-5359/, 'a fully covered chain is not blocked by this gate');
  const first = spawnSyncStdinFile('bash', [hook], { input: JSON.stringify({ transcript_path: thin, session_id: 'rc-test', last_assistant_message: 'Done.\n\nSAFE TO EXIT' }), encoding: 'utf8', env: { ...process.env, ...CLOUD, HOME: fakeHome, SHIP_CHECK_COVERAGE_DISABLE: '' } });
  assert.ok(first.status === 0 || first.status === 2);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  fs.rmSync(fakeHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  for (const f of fs.readdirSync(os.tmpdir())) if (f.startsWith('review-coverage-stop-')) fs.rmSync(path.join(os.tmpdir(), f), { force: true });
});

test('verify-edits.sh keeps the review-coverage call (a Mac-master sync must not silently drop it)', () => {
  const src = fs.readFileSync(path.join(ROOT, '.claude', 'hooks', 'verify-edits.sh'), 'utf8');
  assert.match(src, /review-coverage\.mjs" --stop-hook/);
  assert.match(src, /CLAUDE_CODE_REMOTE:-\}" = "true"/);
  const st = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude', 'settings.json'), 'utf8'));
  assert.ok(st.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command)).some((c) => c.includes('verify-edits.sh')), 'verify-edits.sh is registered as a Stop hook');
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

test('finish chain: a hollow /what-else (one lens, no board search) is flagged', () => {
  const base = fullChain();
  const hollow = [...base, ...ev(skill('what-else')), text('LENSES:\n1. Pattern: found cousins')];
  const p = evaluateChain(hollow).join('|');
  assert.match(p, /1 of 5 numbered lens lines/);
  assert.match(p, /never searched the Linear board/);
  const good = [...base, ...ev(skill('what-else')), roadmap(), res(roadmap()), LENSES];
  const early = [...base, roadmap(), res(roadmap()), ...ev(skill('what-else')), LENSES];
  assert.match(evaluateChain(early).join('|'), /never searched the Linear board/, 'a search before /what-else started does not count');
  const cardLookup = [...base, ...ev(skill('what-else')), LENSES, tool('Bash', { command: 'node scripts/linear-brain.js get BRO-1' }), tool('mcp__Linear__get_issue', { id: 'BRO-1' })];
  assert.match(evaluateChain(cardLookup).join('|'), /never searched the Linear board/, 'fetching one card is not a board search');
  assert.deepEqual(evaluateChain(good), []);
  const viaCli = [...base, ...ev(skill('what-else')), LENSES, tool('Bash', { command: 'node scripts/linear-brain.js find "fantasy"' })];
  assert.deepEqual(evaluateChain(viaCli), [], 'the linear-brain.js find form of the board search (Mac) counts too');
  const oldRoadmap = [...base, ...ev(skill('what-else')), LENSES, tool('mcp__github__issue_read', { method: 'get', owner: 'thomaspryor', repo: 'broadway-scorecard-data', issue_number: 1 }), tool('Bash', { command: 'gh issue view 1 --repo thomaspryor/broadway-scorecard-data --json body' })];
  assert.match(evaluateChain(oldRoadmap).join('|'), /never searched the Linear board/, 'the retired GitHub roadmap read no longer counts');
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
  const base = [...ev(skill('did-it-work')), ...ev(skill(), agent(), curl()), ...ev(skill('what-else')), roadmap(), res(roadmap())];
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
  const withLenses = (t) => [...base, ...ev(skill('what-else')), roadmap(), res(roadmap()), text(t)];
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
  const res1 = checkReviewCoverage({ command: cmd, cwd: ROOT, targets: landPushTargets(cmd), env: CLOUD, seams: { events: full, stats: src, noLog: true } });
  assert.equal(res1.decision, 'block', 'src diff without a build is blocked through checkReviewCoverage');
  assert.match(res1.message, /npm run build/);
  assert.equal(checkReviewCoverage({ command: cmd, cwd: ROOT, targets: landPushTargets(cmd), env: CLOUD, seams: { events: [...full, ...ev(tool('Bash', { command: 'npm run build' }))], stats: src, noLog: true } }).decision, 'allow');
});

test('a push chained after a commit in the same command is still judged (it used to be skipped)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-chain-'));
  const sh = (cwd, c) => spawnSync('bash', ['-c', c], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  const noMaint = 'git config gc.auto 0 && git config gc.autoDetach false && git config maintenance.auto false';
  sh(dir, `git init -q --bare -b main origin.git && (cd origin.git && ${noMaint} && git config receive.autogc false) && git clone -q origin.git work 2>/dev/null; cd work && ${noMaint} && git checkout -q -B main && mkdir -p scripts/lib && echo base > scripts/lib/base.mjs && git add -A && git commit -q -m base && git push -q origin main`);
  const work = path.join(dir, 'work');
  const cmd = 'git add -A && git commit -q -m x && git push origin HEAD:refs/heads/land/bro-1-x';
  const run = (events) => checkReviewCoverage({ command: cmd, cwd: work, targets: landPushTargets(cmd), env: CLOUD, seams: { events, noLog: true } });
  assert.equal(landPushTargets(cmd)[0].push.headMovedBefore, true);
  fs.writeFileSync(path.join(work, 'scripts', 'lib', 'small.mjs'), '// tiny\n'.repeat(5));
  assert.equal(run(ev(skill())).decision, 'skip', '5 untracked lines are under the budget');
  fs.writeFileSync(path.join(work, 'scripts', 'lib', 'big.mjs'), '// a line\n'.repeat(60));
  assert.equal(run(ev(skill())).decision, 'block', 'a chained commit-and-push of 60 new lines with a hollow review is blocked');
  assert.equal(run(ev(skill(), agent(), curl())).decision, 'allow');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test('close-out ordering only counts landings that really ran, and only a real Done', () => {
  const base = fullChain();
  const done = tool('Bash', { command: 'node scripts/linear-brain.js update BRO-1 --state Done --comment x' });
  const mk = (cmd) => tool('Bash', { command: cmd });
  const problem = (events) => evaluateChain(events).join('|');
  const landCmd = 'git push origin HEAD:refs/heads/land/bro-1-x';
  // a dry run, a blocked push (error result) and a push with no result are not landings
  const dry = mk(`${landCmd} --dry-run`);
  assert.deepEqual(evaluateChain([...base, ...ev(done), ...ev(dry)]), [], 'dry run');
  const blocked = mk(landCmd);
  assert.deepEqual(evaluateChain([...base, ...ev(done), blocked, res(blocked, 'LAND BLOCKED', true)]), [], 'blocked by a hook');
  assert.deepEqual(evaluateChain([...base, ...ev(done), mk(landCmd)]), [], 'never got a result');
  // a real landing after the close-out is flagged, even when piped through `tail -n 20`
  const piped = mk(`${landCmd} 2>&1 | tail -n 20`);
  assert.match(problem([...base, ...ev(done), ...ev(piped)]), /close-out was posted before the last landing/, 'tail -n must not read as a dry run');
  assert.match(problem([...base, ...ev(done), ...ev(mk(`git commit -n -q -m x && ${landCmd}`))]), /close-out was posted before/, 'commit -n is not push -n');
  // only a real Done is a close-out: paused, blocked and in-review reports are not
  for (const st of ['paused', 'blocked', 'in-review']) {
    const rep = mk(`node scripts/linear-session.js report --status=${st} --issue=BRO-1`);
    assert.deepEqual(evaluateChain([...base, ...ev(rep), ...ev(mk(landCmd))]), [], `--status=${st}`);
  }
  const doneRep = mk('node scripts/linear-session.js report --status=done --issue=BRO-1');
  assert.match(problem([...base, ...ev(doneRep), ...ev(mk(landCmd))]), /close-out was posted before/, '--status=done counts');
});

test('what-else: the best LENSES block wins over a later bare mention, and any Linear list_issues tool name reads the board', () => {
  const five = ['1. a: b', '2. a: b', '3. a: b', '4. a: b', '5. a: b'].join('\n');
  const rm = (name) => tool(name, { query: 'fantasy' });
  const run = (t, road) => evaluateChain([...fullChain(), ...ev(skill('what-else')), ...ev(road), text(t)]);
  assert.deepEqual(run(`LENSES:\n${five}\n\nLENSES: done, summary below`, rm('mcp__Linear__list_issues')), []);
  assert.deepEqual(run(`LENSES:\n${five}`, rm('mcp__claude_ai_Linear__list_issues')), [], 'prefix differs per container');
  assert.match(run(`LENSES:\n${five}`, tool('mcp__Linear__save_comment', {})).join('|'), /never searched the Linear board/);
  const uuid = '3307c749-7318-4776-9b30-f07de4a6352f';
  assert.deepEqual(run(`LENSES:\n${five}`, rm(`mcp__${uuid}__list_issues`)), [], 'cloud Linear connector uses a UUID tool name (BRO-6030)');
  assert.match(run(`LENSES:\n${five}`, rm('mcp__github__list_issues')).join('|'), /never searched the Linear board/, 'GitHub list_issues is not the board');
  assert.match(run(`LENSES:\n${five}`, rm(`mcp__${uuid}__save_comment`)).join('|'), /never searched the Linear board/);
});

test('what-else: a linear-brain find / linear-next list inside a shell loop or group reads the board (BRO-6030)', () => {
  const five = ['1. a: b', '2. a: b', '3. a: b', '4. a: b', '5. a: b'].join('\n');
  const sh = (command) => tool('Bash', { command });
  const run = (road) => evaluateChain([...fullChain(), ...ev(skill('what-else')), ...ev(road), text(`LENSES:\n${five}`)]);
  for (const c of ['for k in a b; do node scripts/linear-brain.js find "$k"; done', 'if true; then node scripts/linear-next.js --list; fi', '(node scripts/linear-brain.js find x)', 'node scripts/linear-brain.js find x']) {
    assert.deepEqual(run(sh(c)), [], c);
  }
  for (const c of ['{ node scripts/linear-brain.js find x; }', 'if a; then :; else node scripts/linear-brain.js find x; fi']) assert.deepEqual(run(sh(c)), [], c);
  const fake = ['echo node scripts/linear-brain.js find x', 'node scripts/linear-brain.js get BRO-1', 'echo "do node scripts/linear-brain.js find x"', "echo 'then node scripts/linear-next.js --list'",
    'echo "(node scripts/linear-brain.js find x)"', 'echo {node scripts/linear-brain.js find x}', '# do node scripts/linear-brain.js find x', 'cat <<EOF\nnode scripts/linear-brain.js find x\nEOF',
    'git commit -m "fix\nnode scripts/linear-brain.js find x"', 'echo do-linear-brain.js find x'];
  for (const c of fake) {
    assert.match(run(sh(c)).join('|'), /never searched the Linear board/, c);
  }
});


test('pendingGatedStats sizes a chained push like an unchained one: against the merge base, tracked edits included', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-pend-'));
  const sh = (cwd, c) => spawnSync('bash', ['-c', c], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  const noMaint = 'git config gc.auto 0 && git config gc.autoDetach false && git config maintenance.auto false';
  const publish = ['git', 'push', '-q', 'origin', 'main'].join(' ');
  sh(dir, `git init -q --bare -b main origin.git && (cd origin.git && ${noMaint} && git config receive.autogc false) && git clone -q origin.git work 2>/dev/null; cd work && ${noMaint} && git checkout -q -B main && mkdir -p scripts/lib && seq 1 40 > scripts/lib/tracked.mjs && git add -A && git commit -q -m base && ${publish}; cd .. && git clone -q origin.git other 2>/dev/null; true`);
  const work = path.join(dir, 'work');
  const other = path.join(dir, 'other');
  // another session lands 100 lines on main AFTER this branch point, so the branch is now behind main
  sh(other, `${noMaint} && git checkout -q -B main origin/main 2>/dev/null; seq 1 100 > scripts/lib/landed-by-someone-else.mjs && git add -A && git commit -q -m other && ${publish}`);
  sh(work, 'git fetch -q origin');
  const cmd = 'git add -A && git commit -q -m x && git push origin HEAD:refs/heads/land/bro-1-x';
  const run = (events) => checkReviewCoverage({ command: cmd, cwd: work, targets: landPushTargets(cmd), env: CLOUD, seams: { events, noLog: true } });
  // a one-line tracked edit (2 changed lines): the 100 lines main gained while we were behind must NOT be charged to this push
  fs.writeFileSync(path.join(work, 'scripts', 'lib', 'tracked.mjs'), ['changed', ...Array.from({ length: 39 }, (_, i) => String(i + 2))].join('\n') + '\n');
  assert.equal(run(ev(skill())).decision, 'skip', 'a small edit on a branch behind main stays under the budget');
  fs.writeFileSync(path.join(work, 'scripts', 'lib', 'tracked.mjs'), Array.from({ length: 80 }, (_, i) => `// line ${i}`).join('\n') + '\n');
  assert.equal(run(ev(skill())).decision, 'block', 'a large tracked edit is counted');
  assert.equal(run(ev(skill(), agent(), curl())).decision, 'allow');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
