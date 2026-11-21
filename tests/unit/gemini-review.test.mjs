// BRO-7987: Gemini as a repo-reading code reviewer. Before this, /plan-review's
// Gemini leg was a bare generateContent curl with only the plan text (Gemini
// could not open a file) and /ship-check had no Gemini leg at all.
//
// Two traps this file guards:
//  1. `--approval-mode plan` alone is not read-only headless: the CLI's
//     non-interactive policy auto-allows exit_plan_mode, and a probe then wrote
//     two files. scripts/gemini/review-policy.toml must allow only read tools and
//     deny '*', and the wrapper must refuse a run that changed the tree.
//  2. A probe saw gemini-2.5-pro cite file:line it never opened. The wrapper
//     counts real reads and labels a zero-read review as unverified.
// Plus a class guard: review skills reach Gemini only through the wrapper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'gemini', 'review.js');
const lib = require(SCRIPT);

// ---------- pure helpers ----------

test('installDecision: cloud installs a missing or off-pin CLI, the Mac never installs', () => {
  assert.equal(lib.installDecision({ have: '', pin: '0.70.0', remote: true }), 'install');
  assert.equal(lib.installDecision({ have: '0.69.0', pin: '0.70.0', remote: true }), 'install');
  assert.equal(lib.installDecision({ have: '0.70.0', pin: '0.70.0', remote: true }), 'use');
  assert.equal(lib.installDecision({ have: '', pin: '0.70.0', remote: false }), 'missing');
  assert.equal(lib.installDecision({ have: '0.50.0', pin: '0.70.0', remote: false }), 'use');
});

test('buildArgs: headless, plan mode, the read-only policy, JSON output', () => {
  const a = lib.buildArgs({ model: 'gemini-2.5-pro', policy: '/p.toml' });
  const at = (flag) => a[a.indexOf(flag) + 1];
  assert.ok(a.includes('--skip-trust'));
  assert.equal(at('--approval-mode'), 'plan');
  assert.equal(at('--policy'), '/p.toml');
  assert.equal(at('-m'), 'gemini-2.5-pro');
  assert.equal(at('-o'), 'json');
  assert.ok(a.includes('-p'));
  assert.ok(!a.includes('--yolo') && !a.includes('-y'));
});

const cliJson = ({ response = 'Finding at a.js:1', reads = 2, models = { 'gemini-2.5-pro': { prompt: 1000, cached: 400, candidates: 50, thoughts: 20 } } } = {}) => JSON.stringify({
  session_id: 's',
  response,
  stats: {
    models: Object.fromEntries(Object.entries(models).map(([m, t]) => [m, { tokens: t }])),
    tools: { byName: { read_file: { count: reads, success: reads, fail: 0 }, write_file: { count: 1, success: 0, fail: 1 } } },
  },
});

test('parseCliJson: response, read count, usage mapped to usageMetadata; tolerates a warning prefix', () => {
  const p = lib.parseCliJson('Warning: 256-color support not detected.\n' + cliJson());
  assert.equal(p.response, 'Finding at a.js:1');
  assert.equal(p.reads, 2, 'a failed write_file is not a read');
  assert.deepEqual(p.usage, [{ model: 'gemini-2.5-pro', usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 50, thoughtsTokenCount: 20, cachedContentTokenCount: 400 } }]);
});

test('parseCliJson: error JSON, no JSON and broken JSON are errors, never a review', () => {
  assert.match(lib.parseCliJson(JSON.stringify({ error: { message: 'API key not valid' } })).error, /API key not valid/);
  assert.match(lib.parseCliJson('plain text').error, /no JSON/);
  assert.match(lib.parseCliJson('{"response": ').error, /unparseable/);
});

test('treeChanges: reports added and removed porcelain entries', () => {
  assert.deepEqual(lib.treeChanges(' M a.js\0', ' M a.js\0'), []);
  assert.deepEqual(lib.treeChanges(' M a.js\0', ' M a.js\0?? new.txt\0'), ['new.txt']);
  assert.deepEqual(lib.treeChanges('?? x\0', ''), ['x']);
});

// ---------- the policy file ----------

test('review-policy.toml allows only read tools and denies everything else', () => {
  const toml = fs.readFileSync(lib.POLICY, 'utf8').replace(/^\s*#.*$/gm, '');
  const rules = toml.split('[[rule]]').slice(1).map((r) => ({
    tools: [...(r.match(/toolName\s*=\s*(\[[^\]]*\]|"[^"]*")/) || [, ''])[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]),
    decision: (r.match(/decision\s*=\s*"(\w+)"/) || [])[1],
    priority: Number((r.match(/priority\s*=\s*(\d+)/) || [])[1]),
    modes: /\bmodes\s*=/.test(r),
  }));
  const allows = rules.filter((r) => r.decision === 'allow');
  const denyAll = rules.filter((r) => r.decision === 'deny' && r.tools.includes('*'));
  assert.equal(denyAll.length, 1, 'exactly one deny-all rule');
  assert.equal(denyAll[0].modes, false, 'the deny-all must apply in every mode, not only plan');
  const okTools = new Set([...lib.READ_TOOLS, 'update_topic']);
  for (const r of allows) {
    for (const t of r.tools) assert.ok(okTools.has(t), `policy allows non-read tool ${t}`);
    assert.ok(r.priority > denyAll[0].priority, 'read allow-list must outrank the deny-all');
  }
  assert.ok(allows.some((r) => r.tools.includes('read_file')), 'read_file must be allowed or Gemini cannot read the repo');
});

// ---------- the wrapper, against a fake gemini/npm ----------

function sandbox({ geminiVersion = '0.70.0', fakeJson = cliJson(), fakeJson2 = null, fakeExit = 0, writeFile = false, installTo = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-review-'));
  const bin = path.join(dir, 'bin');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(bin); fs.mkdirSync(repo);
  spawnSync('git', ['init', '-q'], { cwd: repo });
  const ver = path.join(dir, 'version');
  if (geminiVersion) fs.writeFileSync(ver, geminiVersion);
  fs.writeFileSync(path.join(dir, 'out.json'), fakeJson);
  if (fakeJson2) fs.writeFileSync(path.join(dir, 'out2.json'), fakeJson2);
  const geminiPath = path.join(bin, 'gemini');
  fs.writeFileSync(geminiPath, `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then [ -s "${ver}" ] || exit 127; cat "${ver}"; exit 0; fi
printf '%s\\n' "$*" >> "${dir}/argv"
cat > "${dir}/stdin"
${writeFile ? 'echo x > leaked.txt' : ''}
echo "Warning: 256-color support not detected." >&2
if [ -s "${dir}/calls" ] && [ -s "${dir}/out2.json" ]; then cat "${dir}/out2.json"; else cat "${dir}/out.json"; fi
echo 1 >> "${dir}/calls"
exit ${fakeExit}
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'npm'), `#!/usr/bin/env bash
echo "$*" >> "${dir}/npm-calls"
${installTo ? `echo "${installTo}" > "${ver}"` : 'exit 1'}
`, { mode: 0o755 });
  return { dir, repo, geminiPath, ledger: path.join(dir, 'ledger.jsonl') };
}

function run(sb, { env = {}, input = 'Review this diff.' } = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, '--caller=test'], {
    cwd: sb.repo, input, encoding: 'utf8',
    env: { PATH: `${path.dirname(sb.geminiPath)}:${process.env.PATH}`, HOME: sb.dir, GEMINI_API_KEY: 'test-key',
      GEMINI_CLI_BIN: sb.geminiPath, LLM_SESSION_LEDGER_PATH: sb.ledger, ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const npmCalls = (sb) => (fs.existsSync(path.join(sb.dir, 'npm-calls')) ? fs.readFileSync(path.join(sb.dir, 'npm-calls'), 'utf8') : '');

test('wrapper: a good run prints the review, passes the policy, and logs spend', () => {
  const sb = sandbox();
  const r = run(sb, { env: { CLAUDE_CODE_REMOTE: 'true' } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), 'Finding at a.js:1');
  assert.match(r.err, /GEMINI-REVIEW: ok model=gemini-2\.5-flash reads=2$/m, 'default model is Flash, no retry when it read files');
  const argv = fs.readFileSync(path.join(sb.dir, 'argv'), 'utf8');
  assert.match(argv, /--approval-mode plan --policy \S+review-policy\.toml/);
  assert.equal(fs.readFileSync(path.join(sb.dir, 'stdin'), 'utf8'), 'Review this diff.');
  const row = JSON.parse(fs.readFileSync(sb.ledger, 'utf8').trim().split('\n').pop());
  assert.equal(row.provider, 'gemini');
  assert.equal(row.model, 'gemini-2.5-pro');
  assert.equal(row.inputTokens, 1000);
  assert.equal(npmCalls(sb), '', 'the pinned CLI is already there, no install');
  assert.doesNotMatch(r.out + r.err, /test-key/, 'never prints the key');
});

test('wrapper: no API key is MISSING (exit 3) and runs nothing', () => {
  const sb = sandbox();
  const r = run(sb, { env: { GEMINI_API_KEY: '' } });
  assert.equal(r.code, 3);
  assert.match(r.err, /^MISSING: GEMINI_API_KEY/);
  assert.ok(!fs.existsSync(path.join(sb.dir, 'argv')));
});

test('wrapper: a run that changes the working tree is UNSAFE (exit 4), no review printed', () => {
  const sb = sandbox({ writeFile: true });
  const r = run(sb, { env: { CLAUDE_CODE_REMOTE: 'true' } });
  assert.equal(r.code, 4);
  assert.match(r.err, /^UNSAFE: .*leaked\.txt/);
  assert.equal(r.out, '');
});

test('wrapper: a review that opened no files is retried once, then labelled unverified', () => {
  const sb = sandbox({ fakeJson: cliJson({ reads: 0 }) });
  const r = run(sb, { env: { CLAUDE_CODE_REMOTE: 'true' } });
  assert.equal(r.code, 0);
  assert.ok(r.out.startsWith(lib.NO_READS_HEADER), r.out);
  assert.match(r.err, /GEMINI-REVIEW: no-reads .*retried=1/);
  const argv = fs.readFileSync(path.join(sb.dir, 'argv'), 'utf8');
  assert.equal(argv.trim().split('\n').length, 2, 'exactly one retry');
  assert.ok(argv.includes('previous answer was rejected'), 'the retry says why');
});

test('wrapper: a retry that reads files is a normal review', () => {
  const sb = sandbox({ fakeJson: cliJson({ reads: 0, response: 'unverified' }), fakeJson2: cliJson({ reads: 3, response: 'read it' }) });
  const r = run(sb, { env: { CLAUDE_CODE_REMOTE: 'true' } });
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), 'read it');
  assert.match(r.err, /GEMINI-REVIEW: ok .*reads=3 retried=1/);
  assert.equal(fs.readFileSync(sb.ledger, 'utf8').trim().split('\n').length, 2, 'both attempts are logged as spend');
});

test('wrapper: CLI failure and empty response are FAILED/EMPTY (exit 1), never a pass', () => {
  const failed = run(sandbox({ fakeJson: JSON.stringify({ error: { message: 'quota exceeded' } }), fakeExit: 1 }), { env: { CLAUDE_CODE_REMOTE: 'true' } });
  assert.equal(failed.code, 1);
  assert.match(failed.err, /^FAILED: .*quota exceeded/);
  const empty = run(sandbox({ fakeJson: cliJson({ response: '' }) }), { env: { CLAUDE_CODE_REMOTE: 'true' } });
  assert.equal(empty.code, 1);
  assert.match(empty.err, /^EMPTY:/);
});

test('wrapper: cloud installs the pin when the CLI is off-pin, MISSING when npm fails', () => {
  const ok = sandbox({ geminiVersion: '0.60.0', installTo: lib.PIN });
  const r = run(ok, { env: { CLAUDE_CODE_REMOTE: 'true' } });
  assert.equal(r.code, 0, r.err);
  assert.match(npmCalls(ok), new RegExp(`@google/gemini-cli@${lib.PIN.replace(/\./g, '\\.')}`));
  const bad = sandbox({ geminiVersion: '' });
  const r2 = run(bad, { env: { CLAUDE_CODE_REMOTE: 'true' } });
  assert.equal(r2.code, 3);
  assert.match(r2.err, /^MISSING: npm install/);
});

test('wrapper: the Mac never installs; a missing CLI is MISSING', () => {
  const sb = sandbox({ geminiVersion: '' });
  const r = run(sb, { env: { CLAUDE_CODE_REMOTE: '' } });
  assert.equal(r.code, 3);
  assert.match(r.err, /^MISSING: no gemini CLI/);
  assert.equal(npmCalls(sb), '');
});

// ---------- class guard over the review skills ----------

function skillFiles() {
  const out = [];
  const cmdDir = path.join(ROOT, '.claude', 'commands');
  for (const f of fs.readdirSync(cmdDir)) if (f.endsWith('.md')) out.push(path.join(cmdDir, f));
  const skillDir = path.join(ROOT, '.claude', 'skills');
  if (fs.existsSync(skillDir)) for (const d of fs.readdirSync(skillDir)) {
    const p = path.join(skillDir, d, 'SKILL.md');
    if (fs.existsSync(p)) out.push(p);
  }
  return out;
}

test('skills never run the gemini CLI directly; they go through scripts/gemini/review.js', () => {
  const offenders = [];
  for (const f of skillFiles()) {
    const text = fs.readFileSync(f, 'utf8');
    // a bare CLI invocation: `gemini -p`, `gemini --approval-mode`, `| gemini ` etc.
    if (/(^|[|;&(]\s*|\s)gemini\s+(-p\b|-m\b|--(approval-mode|yolo|prompt|model|policy|skip-trust))/m.test(text)) offenders.push(path.relative(ROOT, f));
  }
  assert.deepEqual(offenders, [], 'run Gemini through scripts/gemini/review.js (read-only policy, tree check, spend log)');
});

test('/plan-review and /ship-check use the repo-reading Gemini reviewer', () => {
  for (const name of ['plan-review', 'ship-check']) {
    const text = fs.readFileSync(path.join(ROOT, '.claude', 'commands', `${name}.md`), 'utf8');
    assert.match(text, /node scripts\/gemini\/review\.js --caller=/, `${name} must call the Gemini wrapper`);
    assert.doesNotMatch(text, /Gemini does NOT have codebase access/, `${name} still says Gemini cannot read the code`);
  }
});
