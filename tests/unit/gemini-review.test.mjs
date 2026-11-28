// BRO-7987 / BRO-8160: the Gemini code reviewer for /ship-check and /plan-review.
//
// BRO-8160 replaced the agentic Gemini CLI (each tool turn re-sent the whole conversation, about
// $190 a day) with one generateContent request carrying a packed bundle of the code under review.
// This file guards:
//  1. the bundle: changed files (renamed, deleted, uncommitted), windows for big files, callers,
//     and what is never sent (untracked files, secret-looking names, binaries);
//  2. the budget: what does not fit is listed as OMITTED, never silently dropped;
//  3. the request loop: retries, the thinking fallback, empty and blocked answers, the deadline;
//  4. the status line the land gate counts (review-coverage.mjs geminiReviewOk) and the spend row;
//  5. the skills reach Gemini only through the wrapper and no longer name CLI file tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { geminiReviewOk } from '../../scripts/lib/review-coverage.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'gemini', 'review.js');
const lib = require(SCRIPT);
const bundleLib = require(path.join(ROOT, 'scripts', 'gemini', 'review-bundle.js'));

const sh = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

/** A repo whose branch renames, deletes, adds, edits a big file, edits a tracked .env, and has an uncommitted edit. */
function fixtureRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-bundle-'));
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.email', 't@t');
  sh(repo, 'config', 'user.name', 't');
  const w = (p, s) => { fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true }); fs.writeFileSync(path.join(repo, p), s); };
  w('lib/a.js', 'function addOne(n) {\n  return n + 1;\n}\nmodule.exports = { addOne };\n');
  w('lib/b.js', "const { addOne } = require('./a');\nconsole.log(addOne(1));\n");
  w('lib/big.js', Array.from({ length: 3000 }, (_, i) => `const line${i} = ${i}; // padding padding padding`).join('\n') + '\n');
  w('lib/d.js', 'module.exports = 4;\n');
  w('lib/e.js', 'module.exports = 5; // renamed later\n'.repeat(5));
  w('.env', 'API_KEY=base-value\n');
  fs.writeFileSync(path.join(repo, 'img.bin'), Buffer.from([0, 1, 2, 0, 255]));
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-qm', 'base');
  sh(repo, 'checkout', '-qb', 'feature');
  w('lib/a.js', 'function addOne(n, step) {\n  return n + step;\n}\nmodule.exports = { addOne };\n');
  w('lib/c.js', "exports.makeThing = () => 'new';\n");
  const big = fs.readFileSync(path.join(repo, 'lib/big.js'), 'utf8').split('\n');
  big[1999] = 'const line1999 = 0; // PLANTED CHANGE';
  w('lib/big.js', big.join('\n'));
  fs.rmSync(path.join(repo, 'lib/d.js'));
  sh(repo, 'mv', 'lib/e.js', 'lib/f.js');
  w('.env', 'API_KEY=SUPER-SECRET-VALUE\n');
  fs.writeFileSync(path.join(repo, 'img.bin'), Buffer.from([0, 9, 9, 0, 255]));
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-qm', 'feature');
  w('lib/c.js', "exports.makeThing = () => 'UNCOMMITTED-EDIT';\n"); // tracked, not committed
  w('notes-untracked.js', 'UNTRACKED-TEXT\n'); // never sent
  return repo;
}

// ---------- bundle helpers ----------

test('parseNameStatus: modify, add, delete and rename (new path kept, old path noted)', () => {
  const z = ['M', 'lib/a.js', 'A', 'lib/c.js', 'D', 'lib/d.js', 'R100', 'lib/e.js', 'lib/f.js', ''].join('\0');
  assert.deepEqual(bundleLib.parseNameStatus(z), [
    { status: 'M', path: 'lib/a.js' }, { status: 'A', path: 'lib/c.js' }, { status: 'D', path: 'lib/d.js' },
    { status: 'R', from: 'lib/e.js', path: 'lib/f.js' },
  ]);
});

test('parseHunks: new-file line ranges, a pure deletion is one line, a deleted file has none', () => {
  const diff = ['--- a/x.js', '+++ b/x.js', '@@ -3,2 +3,4 @@', '@@ -10 +12 @@', '@@ -20,3 +23,0 @@', '--- a/gone.js', '+++ /dev/null', '@@ -1,3 +0,0 @@'].join('\n');
  const m = bundleLib.parseHunks(diff);
  assert.deepEqual(m.get('x.js'), [[3, 6], [12, 12], [23, 23]]);
  assert.equal(m.has('gone.js'), false);
});

test('definedNames: functions, consts, exports, classes and methods from added and removed lines; keywords and headers skipped', () => {
  const diff = ['+function parseThing(a) {', '+const MAX_ROWS = 3;', '+exports.helperOne = 1;', '+export async function loadAll() {}',
    '+class Widget {}', '+  render(props) {', '+  if (x) {', '-function removedOne() {}', '+++ b/file.js', '+function -Ocat() {}'].join('\n');
  const names = bundleLib.definedNames(diff);
  for (const n of ['parseThing', 'MAX_ROWS', 'helperOne', 'loadAll', 'Widget', 'render', 'removedOne']) assert.ok(names.includes(n), n);
  for (const n of ['if']) assert.ok(!names.includes(n), n);
  assert.ok(names.every((n) => !n.startsWith('-')), 'a name can never start with a dash (git grep option injection)');
});

test('pathsFromPrompt: only tracked files, ./ and :line and punctuation stripped, option-looking tokens ignored', () => {
  const tracked = new Set(['scripts/a.js', 'docs/x.md']);
  const got = bundleLib.pathsFromPrompt('Edit ./scripts/a.js:12, then `docs/x.md`. Also scripts/missing.js and --output=scripts/a.js', tracked);
  assert.deepEqual(got, ['scripts/a.js', 'docs/x.md']);
});

test('windows: pads, merges overlapping ranges, numbers lines from the real file', () => {
  const text = Array.from({ length: 50 }, (_, i) => `L${i + 1}`).join('\n');
  const out = bundleLib.windows(text, [[10, 10], [14, 15], [45, 45]], 2);
  assert.match(out, /^ 8: L8\n/);
  assert.match(out, /17: L17\n\.\.\.\n43: L43/);
  assert.match(out, /47: L47$/);
});

test('isSecretPath: key, env and secret-named data files are never sent; source files are', () => {
  for (const p of ['.env', 'a/.env.local', 'x/server.pem', 'id_ed25519', 'secrets.json', 'config/credentials', 'gh-token.txt', '.npmrc'])
    assert.equal(bundleLib.isSecretPath(p), true, p);
  for (const p of ['scripts/lib/token-budget.js', 'src/password-reset.tsx', 'scripts/a.js', 'docs/secret-handling.md'])
    assert.equal(bundleLib.isSecretPath(p), false, p);
});

// ---------- buildBundle against a real repo ----------

test('buildBundle --base: changed, added, renamed and uncommitted files attached; deleted listed; secrets, binaries and untracked files never sent', () => {
  const repo = fixtureRepo();
  const b = bundleLib.buildBundle({ cwd: repo, base: 'main' });
  assert.ok(!b.error, b.error);
  for (const p of ['lib/a.js', 'lib/c.js', 'lib/f.js']) assert.ok(b.given.includes(p), `${p} attached whole`);
  assert.deepEqual(b.partial, ['lib/big.js'], 'a big file gets windows around its change');
  assert.match(b.text, /=== FILE lib\/big\.js \(3000 lines; changed lines 2000; only the changed parts are shown\) ===/);
  assert.match(b.text, /2000: const line1999 = 0; \/\/ PLANTED CHANGE/);
  assert.doesNotMatch(b.text, /line10 = 10;/, 'parts of the big file far from the change stay out');
  assert.match(b.text, /DELETED by this change \(see the diff\): lib\/d\.js/);
  assert.match(b.text, /UNCOMMITTED-EDIT/, 'uncommitted edits to tracked files are reviewed');
  assert.doesNotMatch(b.text, /SUPER-SECRET-VALUE/, 'a tracked .env is never sent');
  assert.doesNotMatch(b.text, /UNTRACKED-TEXT/, 'untracked files are never sent');
  const omitted = Object.fromEntries(b.omitted.map((o) => [o.path, o.why]));
  assert.match(omitted['.env'], /secret/);
  assert.match(omitted['notes-untracked.js'], /untracked, never sent/, 'an untracked file is named so the model can say it was not checked');
  assert.equal(omitted['img.bin'], 'binary');
  assert.match(b.text, /OMITTED \(not given to you; list each under NOT CHECKED\): .*\.env/);
  assert.match(b.text, /changed lines 1-2/, 'changed line ranges are named for whole files too');
});

test('buildBundle: callers of a changed name in untouched files are attached', () => {
  const repo = fixtureRepo();
  const b = bundleLib.buildBundle({ cwd: repo, base: 'main' });
  assert.match(b.text, /=== USES ELSEWHERE[^\n]*\n-- uses of addOne --\nlib\/b\.js:1:const \{ addOne \} = require/);
  assert.ok(b.callerLines >= 2);
});

test('buildBundle: a small budget omits files visibly (never silently); budget 0 attaches nothing', () => {
  const repo = fixtureRepo();
  const tight = bundleLib.buildBundle({ cwd: repo, base: 'main', budgetChars: 400 });
  assert.ok(tight.omitted.some((o) => o.why === 'did not fit the review budget'));
  assert.match(tight.text, /OMITTED[^\n]*did not fit the review budget/);
  const none = bundleLib.buildBundle({ cwd: repo, base: 'main', budgetChars: 0 });
  assert.deepEqual([none.given, none.partial], [[], []]);
  assert.match(none.text, /No repository files were attached/);
});

test('buildBundle: a changed file over the whole-file size cap is sent as windows, an unchanged one is not', () => {
  const repo = fixtureRepo();
  const big = Array.from({ length: 12000 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n') + '\n';
  fs.writeFileSync(path.join(repo, 'huge.yml'), big);
  fs.writeFileSync(path.join(repo, 'huge2.yml'), big);
  sh(repo, 'add', '-A'); sh(repo, 'commit', '-qm', 'huge');
  sh(repo, 'branch', '-f', 'hugebase');
  fs.writeFileSync(path.join(repo, 'huge.yml'), big.replace('line 6000 ', 'line 6000 CHANGED '));
  sh(repo, 'commit', '-qam', 'edit huge');
  assert.ok(fs.statSync(path.join(repo, 'huge.yml')).size > bundleLib.MAX_FILE_BYTES);
  const b = bundleLib.buildBundle({ cwd: repo, base: 'hugebase' });
  assert.deepEqual(b.partial, ['huge.yml']);
  assert.match(b.text, /CHANGED/);
  const p = bundleLib.buildBundle({ cwd: repo, prompt: 'see huge2.yml' });
  assert.equal(p.omitted.find((o) => o.path === 'huge2.yml').why, 'over 200KB');
});

test('parseHunks: quoted paths, an added line that reads like a header, a deletion at the top', () => {
  const diff = [
    'diff --git "a/sp ace.js" "b/sp ace.js"', '--- "a/sp ace.js"', '+++ "b/sp ace.js"', '@@ -3 +3 @@', '-x', '+y',
    'diff --git a/caf\\303\\251.js b/caf\\303\\251.js', '--- "a/caf\\303\\251.js"', '+++ "b/caf\\303\\251.js"', '@@ -1,0 +1 @@', '+a',
    'diff --git a/n.js b/n.js', '--- a/n.js', '+++ b/n.js', '@@ -1 +1 @@', '-old', '+++ counter', '@@ -9 +9 @@', '-p', '+q',
    'diff --git a/top.js b/top.js', '--- a/top.js', '+++ b/top.js', '@@ -1,2 +0,0 @@', '-gone', '-gone',
  ].join('\n');
  const h = bundleLib.parseHunks(diff);
  assert.deepEqual(h.get('sp ace.js'), [[3, 3]]);
  assert.deepEqual(h.get('caf\u00e9.js'), [[1, 1]]);
  assert.deepEqual(h.get('n.js'), [[1, 1], [9, 9]], 'an added "++ counter" line is content, not a new file');
  assert.ok(!h.has('counter'));
  assert.deepEqual(h.get('top.js'), [[1, 1]], 'a deletion at the top is reported at line 1, not 0');
});

test('isSecretPath: key, env and account files by name; code files with such words are not', () => {
  for (const p of ['.envrc', 'a/.pgpass', 'gcp-service-account.json', 'firebase-adminsdk-abc.json', 'config/apikey.txt', 'auth.json', 'x.kdbx', 'k.p12', 'putty.ppk', '.env.local'])
    assert.ok(bundleLib.isSecretPath(p), p);
  for (const p of ['scripts/lib/token-budget.js', 'src/lib/auth.ts', 'scripts/lib/service-account-check.js', 'README.md'])
    assert.ok(!bundleLib.isSecretPath(p), p);
});

test('buildBundle: an empty tracked file is attached, line counts ignore the final newline, git grep takes names literally', () => {
  const repo = fixtureRepo();
  fs.writeFileSync(path.join(repo, 'empty.js'), '');
  fs.writeFileSync(path.join(repo, 'dollar.js'), 'function get$Value() { return 1; }\n');
  fs.writeFileSync(path.join(repo, 'use.js'), 'get$Value();\nconst x = 2;\n');
  sh(repo, 'add', '-A'); sh(repo, 'commit', '-qm', 'base2'); sh(repo, 'branch', '-f', 'b2');
  fs.writeFileSync(path.join(repo, 'dollar.js'), 'function get$Value() { return 2; }\n');
  fs.appendFileSync(path.join(repo, 'empty.js'), '');
  sh(repo, 'commit', '-qam', 'edit');
  const b = bundleLib.buildBundle({ cwd: repo, base: 'b2' });
  assert.match(b.text, /=== FILE dollar\.js \(1 lines; changed lines 1\) ===/);
  assert.match(b.text, /use\.js:1:get\$Value\(\);/, 'a name with $ is found by its callers');
  const p = bundleLib.buildBundle({ cwd: repo, prompt: 'see empty.js and Dockerfile-less --file=dollar.js' });
  assert.ok(p.given.includes('empty.js'), 'an empty file is attached, not omitted with no reason');
  assert.ok(p.given.includes('dollar.js'), 'a path after = is found');
  assert.ok(p.omitted.every((o) => o.why), 'every omission has a reason');
});

test('buildBundle: plan mode names the files past the 40-file limit instead of dropping them', () => {
  const repo = fixtureRepo();
  for (let i = 0; i < 45; i++) fs.writeFileSync(path.join(repo, `p${i}.js`), `${i}\n`);
  sh(repo, 'add', '-A'); sh(repo, 'commit', '-qm', 'many');
  const b = bundleLib.buildBundle({ cwd: repo, prompt: Array.from({ length: 45 }, (_, i) => `p${i}.js`).join(' ') });
  assert.equal(b.given.length, 40);
  assert.equal(b.omitted.filter((o) => /past the first 40/.test(o.why)).length, 5);
});

test('buildBundle: code claims the budget before tests and docs, even when the test change is bigger', () => {
  assert.deepEqual(['README.md', 'tests/unit/x.test.mjs', 'scripts/lib/y.js', '.agents/skills/a/SKILL.md', 'src/a.spec.ts'].map(bundleLib.fillRank), [2, 1, 0, 2, 1]);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gemrank-'));
  sh(repo, 'init', '-q', '-b', 'main'); sh(repo, 'config', 'user.email', 't@t'); sh(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'seed.txt'), 'x\n'); sh(repo, 'add', '-A'); sh(repo, 'commit', '-qm', 'seed');
  fs.mkdirSync(path.join(repo, 'tests'));
  fs.writeFileSync(path.join(repo, 'tests', 'big.test.mjs'), Array.from({ length: 15 }, (_, i) => `t${i}();`).join('\n') + '\n');
  fs.writeFileSync(path.join(repo, 'code.js'), 'module.exports = 1;\n');
  sh(repo, 'add', '-A'); sh(repo, 'commit', '-qm', 'rank');
  // The budget holds either file alone, not both; the test file is the bigger change.
  const b = bundleLib.buildBundle({ cwd: repo, base: 'main~1', budgetChars: 260 });
  assert.deepEqual(b.given, ['code.js']);
  assert.ok(b.omitted.some((o) => o.path === 'tests/big.test.mjs'));
});

test('buildBundle: the OMITTED list is capped so a huge change cannot bloat the request', () => {
  const repo = fixtureRepo();
  for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(repo, `gen${i}.js`), `module.exports = ${i};\n`);
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-qm', 'many');
  const b = bundleLib.buildBundle({ cwd: repo, base: 'main', budgetChars: 0 });
  assert.ok(b.omitted.length > 60);
  const line = b.text.split('\n').find((l) => l.startsWith('OMITTED'));
  assert.equal((line.match(/did not fit the review budget|secret|binary/g) || []).length, 40);
  assert.match(line, new RegExp(`and ${b.omitted.length - 40} more files`));
});

test('buildBundle: a base that does not resolve is an error; no base attaches the files the prompt names', () => {
  const repo = fixtureRepo();
  assert.match(bundleLib.buildBundle({ cwd: repo, base: 'no-such-ref' }).error, /does not resolve/);
  const plan = bundleLib.buildBundle({ cwd: repo, prompt: 'Step 1 edits lib/b.js and lib/a.js; .env stays; notes-untracked.js is new.' });
  assert.deepEqual(plan.given, ['lib/b.js', 'lib/a.js']);
  assert.doesNotMatch(plan.text, /SUPER-SECRET-VALUE|UNTRACKED-TEXT/);
  assert.doesNotMatch(plan.text, /USES ELSEWHERE/);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-'));
  assert.match(bundleLib.buildBundle({ cwd: outside, prompt: 'x' }).error, /not inside a git repository/);
});

// ---------- request loop ----------

const reply = (text, extra = {}) => ({ candidates: [{ content: { parts: [{ text: 'hidden reasoning', thought: true }, { text }] }, finishReason: 'STOP', ...extra }], usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 200, candidatesTokenCount: 50, thoughtsTokenCount: 450 } });
function fakeFetch(steps) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const s = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (s === 'throw') throw new Error('socket hang up');
    // AbortSignal.timeout's timer does not hold the event loop open (a real socket does), so hold it here.
    if (s === 'hang') return new Promise((_, rej) => { const hold = setInterval(() => {}, 100); init.signal.addEventListener('abort', () => { clearInterval(hold); rej(Object.assign(new Error('aborted'), { name: 'TimeoutError' })); }); });
    return { ok: s.status === 200, status: s.status, json: async () => s.body };
  };
  fn.calls = calls;
  return fn;
}
const run = (steps, o = {}) => {
  const f = fakeFetch(steps);
  let failed = 0;
  return lib.review({ text: 'p', model: 'm', key: 'k', deadline: Date.now() + (o.ms || 60_000), thinking: 'medium', fetchImpl: f, onFailedCall: () => failed++, sleepImpl: async () => {} })
    .then((r) => ({ r, calls: f.calls, failed }));
};

test('buildRequest / parseResponse: thinking level and output cap sent; thought parts dropped; thoughts billed as output', () => {
  const body = lib.buildRequest('hi');
  assert.deepEqual(body.generationConfig, { maxOutputTokens: lib.MAX_OUTPUT_TOKENS, thinkingConfig: { thinkingLevel: 'medium' } });
  assert.equal(lib.buildRequest('hi', { thinking: null }).generationConfig.thinkingConfig, undefined);
  const p = lib.parseResponse(reply('the review'));
  assert.equal(p.text, 'the review');
  assert.deepEqual(p.usage, { prompt: 1000, cached: 200, output: 500 });
});

test('review: a good answer on the first call', async () => {
  const { r, calls, failed } = await run([{ status: 200, body: reply('ok review') }]);
  assert.equal(r.parsed.text, 'ok review');
  assert.equal(calls.length, 1);
  assert.equal(failed, 0);
  assert.match(calls[0].url, /\/models\/m:generateContent$/);
});

test('review: 503 and a dropped connection are retried and each failed call is logged', async () => {
  const { r, calls, failed } = await run([{ status: 503, body: {} }, 'throw', { status: 200, body: reply('late review') }]);
  assert.equal(r.parsed.text, 'late review');
  assert.equal(calls.length, 3);
  assert.equal(failed, 2);
});

test('review: a server error that never clears is FAILED after 4 calls, not a pass', async () => {
  const { r, calls } = await run([{ status: 500, body: { error: { message: 'boom' } } }]);
  assert.match(r.fail, /HTTP 500: boom/);
  assert.equal(calls.length, 4);
});

test('review: a 400 about thinking retries once without a thinking setting', async () => {
  const { r, calls } = await run([{ status: 400, body: { error: { message: 'thinkingLevel is not supported' } } }, { status: 200, body: reply('fine') }]);
  assert.equal(r.parsed.text, 'fine');
  assert.equal(calls[1].body.generationConfig.thinkingConfig, undefined);
  assert.equal(r.thinking, 'default');
});

test('review: any other 400 fails at once', async () => {
  const { r, calls } = await run([{ status: 400, body: { error: { message: 'request too large' } } }]);
  assert.match(r.fail, /HTTP 400: request too large/);
  assert.equal(calls.length, 1);
});

test('review: an empty answer cut at the token limit retries once on low thinking, then is EMPTY', async () => {
  const cut = { status: 200, body: { candidates: [{ content: { parts: [{ text: 'x', thought: true }] }, finishReason: 'MAX_TOKENS' }] } };
  const a = await run([cut, { status: 200, body: reply('short') }]);
  assert.equal(a.r.parsed.text, 'short');
  assert.equal(a.calls[1].body.generationConfig.thinkingConfig.thinkingLevel, 'low');
  const b = await run([cut]);
  assert.equal(b.r.empty, true);
  assert.equal(b.calls.length, 2);
});

test('review: a blocked prompt or a SAFETY/RECITATION stop with no text is EMPTY, never a review', async () => {
  const blocked = await run([{ status: 200, body: { promptFeedback: { blockReason: 'SAFETY' } } }]);
  assert.match(blocked.r.fail, /blocked by Gemini \(SAFETY\)/);
  const recit = await run([{ status: 200, body: { candidates: [{ finishReason: 'RECITATION' }] } }]);
  assert.match(recit.r.fail, /no answer text \(finishReason RECITATION\)/);
  assert.equal(recit.r.empty, true);
});

test('review: a request that hangs is cut at the deadline', async () => {
  const t0 = Date.now();
  const { r, failed } = await run(['hang'], { ms: 1500 });
  assert.match(r.fail, /timed out/);
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(failed, 1, 'a timed-out call may still be billed, so it is logged');
});

// ---------- the CLI, end to end with a stubbed fetch ----------

function cli(repo, { input = 'Review this change.', args = [], env = {}, replyBody = reply('* lib/a.js:2 finding\n\nNOT CHECKED: nothing'), status = 200 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-cli-'));
  const stub = path.join(dir, 'stub.cjs');
  fs.writeFileSync(stub, `const fs = require('fs');
globalThis.fetch = async (url, init) => {
  fs.appendFileSync(${JSON.stringify(path.join(dir, 'sent'))}, init.body + '\\n');
  return new Response(${JSON.stringify(JSON.stringify(replyBody))}, { status: ${status}, headers: { 'content-type': 'application/json' } });
};`);
  const ledger = path.join(dir, 'ledger.jsonl');
  const r = spawnSync(process.execPath, ['-r', stub, SCRIPT, '--caller=test', ...args], {
    cwd: repo, input, encoding: 'utf8',
    env: { ...process.env, GEMINI_API_KEY: 'test-key', GEMINI_USAGE_LEDGER_PATH: ledger, LLM_SESSION_LEDGER_PATH: '', GEMINI_REVIEW_MODEL: '', GEMINI_REVIEW_THINKING: '', ...env },
  });
  const sent = fs.existsSync(path.join(dir, 'sent')) ? fs.readFileSync(path.join(dir, 'sent'), 'utf8') : '';
  return { code: r.status, out: r.stdout, err: r.stderr, sent, ledger: fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8') : '' };
}

test('cli: a good run prints the review, a status line the land gate counts, and a spend row', () => {
  const repo = fixtureRepo();
  const r = cli(repo, { args: ['--base=main'] });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /lib\/a\.js:2 finding/);
  assert.match(r.err, /^GEMINI-REVIEW: ok model=gemini-3\.8-flash reads=4 partial=1 unbundled=3 callers=\d+ tokens=1500 usd=\d+\.\d{4} thinking=medium$/m);
  assert.equal(geminiReviewOk(`${r.out}\n${r.err}`), true, 'review-coverage.mjs must count this run');
  const sent = JSON.parse(r.sent.trim().split('\n')[0]);
  const text = sent.contents[0].parts[0].text;
  assert.match(text, /^Review this change\.\n\n=== REPOSITORY CONTEXT/);
  assert.match(text, /function addOne\(n, step\)/);
  assert.doesNotMatch(r.sent, /SUPER-SECRET-VALUE|UNTRACKED-TEXT/);
  assert.doesNotMatch(r.err + r.out, /test-key/, 'the API key is never printed');
  const row = JSON.parse(r.ledger.trim().split('\n').pop());
  assert.equal(row.provider, 'gemini');
  assert.equal(row.inputTokens, 1000);
});

test('cli: no files attached prints the unverified header, and the land gate does not count it', () => {
  const repo = fixtureRepo();
  const r = cli(repo, { input: 'A plan that names no files.' });
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.startsWith(lib.NO_READS_HEADER));
  assert.match(r.err, /^GEMINI-REVIEW: no-reads model=\S+ reads=0 /m);
  assert.equal(geminiReviewOk(`${r.out}\n${r.err}`), false);
});

test('cli: no key is MISSING (exit 3); no prompt, a bad flag or a bad base is FAILED (exit 1); nothing is sent', () => {
  const repo = fixtureRepo();
  const cases = [
    [{ env: { GEMINI_API_KEY: '' } }, 3, /^MISSING: GEMINI_API_KEY is not set$/m],
    [{ input: '  ' }, 1, /^FAILED: no prompt on stdin$/m],
    [{ args: ['--timeout-sec=abc'] }, 1, /^FAILED: --timeout-sec must be a positive number/m],
    [{ args: ['--budget-chars=-5'] }, 1, /^FAILED: --budget-chars/m],
    [{ args: ['--base=nope'] }, 1, /^FAILED: could not build the review bundle: base ref 'nope'/m],
  ];
  for (const [o, code, re] of cases) {
    const r = cli(repo, o);
    assert.equal(r.code, code, `${JSON.stringify(o)}: ${r.err}`);
    assert.match(r.err, re);
    assert.equal(r.out, '');
    assert.equal(r.sent, '', 'no request on a refused run');
  }
});

test('cli: an HTTP error is FAILED with no review; a 5xx (may have run) is logged as unknown spend, a 4xx (refused) is not', () => {
  const repo = fixtureRepo();
  const r = cli(repo, { args: ['--base=main'], status: 403, replyBody: { error: { message: 'API key not valid' } } });
  assert.equal(r.code, 1);
  assert.match(r.err, /^FAILED: Gemini HTTP 403: API key not valid$/m);
  assert.equal(r.out, '');
  assert.equal(geminiReviewOk(r.err), false);
  assert.equal(r.ledger.trim(), '', 'a refused 4xx call is not billed, so no spend row');
  const r5 = cli(repo, { args: ['--base=main', '--timeout-sec=3'], status: 500, replyBody: { error: { message: 'boom' } } });
  assert.equal(r5.code, 1);
  const rows = r5.ledger.trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(rows.length >= 1 && rows.every((x) => x.unknownCalls === 1), 'each 5xx attempt is logged as an unknown-size call');
});

test('redactSecretDiffs: a secret-named file\'s diff never reaches the request; other sections and cut markers stay', () => {
  const prompt = ['HEAD', 'diff --git a/lib/a.js b/lib/a.js', '+ok', 'diff --git a/.env b/.env', '+KEY=SUPER-SECRET', 'diff --git a/x/gcp-service-account.json b/x/gcp-service-account.json', '+{"private_key":"S2"}', '', '=== UNCOMMITTED CHANGES ===', 'diff --git a/lib/b.js b/lib/b.js', '+fine'].join('\n');
  const { text, dropped } = lib.redactSecretDiffs(prompt);
  assert.deepEqual(dropped, ['.env', 'x/gcp-service-account.json']);
  assert.doesNotMatch(text, /SUPER-SECRET|S2/);
  assert.match(text, /\+ok/); assert.match(text, /\+fine/); assert.match(text, /=== UNCOMMITTED CHANGES ===/);
  assert.match(text, /diff withheld: the name looks like a secret/);
});

test('cli: a review where more changed files were left out than attached is `partial`, which the land gate does not count', () => {
  const repo = fixtureRepo();
  const r = cli(repo, { args: ['--base=main', '--budget-chars=300'] });
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /^GEMINI-REVIEW: partial model=/m);
  assert.equal(geminiReviewOk(`${r.out}\n${r.err}`), false);
});

// ---------- class guard over the review skills ----------


function skillFiles() {
  const out = [];
  const walk = (d, ok) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'worktrees') walk(p, ok); } else if (ok(e.name)) out.push(p);
    }
  };
  walk(path.join(ROOT, '.claude', 'commands'), (n) => n.endsWith('.md'));
  walk(path.join(ROOT, '.claude', 'skills'), (n) => n === 'SKILL.md');
  walk(path.join(ROOT, '.claude', 'hooks'), (n) => /\.(sh|js|mjs)$/.test(n));
  walk(path.join(ROOT, 'scripts'), (n) => n.endsWith('.sh'));
  return out;
}

// A shell-position gemini call: start of line, or after | ; & ( && ||, optionally via npx/$GEMINI_BIN.
const DIRECT_GEMINI = /(^|[|;&(`]|\$\()\s*(?:npx\s+(?:-y\s+)?@google\/gemini-cli(?:@\S+)?|"?\$\{?GEMINI_(?:BIN|CLI_BIN)\}?"?|gemini)\s+(-p\b|-m\b|-y\b|--(approval-mode|yolo|prompt|model|policy|skip-trust)\b)/m;

test('the direct-gemini detector: catches shell calls, ignores prose', () => {
  for (const bad of ['gemini -p "x"', 'cat f | gemini --approval-mode plan', 'npx @google/gemini-cli@0.70.0 -p hi', '"$GEMINI_BIN" -m flash', 'x && gemini --yolo'])
    assert.match(bad, DIRECT_GEMINI, bad);
  for (const ok of ['Gemini -p is not used here', 'the gemini --policy flag loads a file', 'node scripts/gemini/review.js --caller=x'])
    assert.doesNotMatch(ok, DIRECT_GEMINI, ok);
});

test('skills never run the gemini CLI directly; they go through scripts/gemini/review.js', () => {
  const offenders = [];
  for (const f of skillFiles()) {
    if (DIRECT_GEMINI.test(fs.readFileSync(f, 'utf8'))) offenders.push(path.relative(ROOT, f));
  }
  assert.deepEqual(offenders, [], 'run Gemini through scripts/gemini/review.js (bundle, budget, spend log)');
});

test('/plan-review and /ship-check use the repo-reading Gemini reviewer', () => {
  for (const name of ['plan-review', 'ship-check']) {
    const text = fs.readFileSync(path.join(ROOT, '.claude', 'commands', `${name}.md`), 'utf8');
    assert.match(text, /node scripts\/gemini\/review\.js --caller=/, `${name} must call the Gemini wrapper`);
    assert.doesNotMatch(text, /Gemini does NOT have codebase access/, `${name} still says Gemini cannot read the code`);
  }
});

test('the Gemini prompts in /plan-review and /ship-check name no CLI file tools; ship-check passes --base', () => {
  // The model has no tools now: telling it to "open files with read_file" invites invented reads.
  const docs = [
    ['.claude/commands/ship-check.md', true], ['.claude/commands/plan-review.md', false],
    ['.agents/skills/ship-check/SKILL.md', true], ['.agents/skills/plan-review/SKILL.md', false],
  ];
  for (const [rel, wantsBase] of docs) {
    const f = path.join(ROOT, rel);
    if (!fs.existsSync(f)) continue;
    const text = fs.readFileSync(f, 'utf8');
    const i = text.indexOf('node scripts/gemini/review.js --caller=');
    assert.ok(i > 0, `${rel} calls the wrapper`);
    const block = text.slice(text.lastIndexOf('```bash', i), i);
    assert.doesNotMatch(block, /read_file|grep_search|list_directory|file tools/, `${rel}: the Gemini prompt still names CLI file tools`);
    if (wantsBase) assert.match(text.slice(i, i + 200), /--base="\$BASE"/, `${rel}: ship-check must pass --base so the changed files are attached`);
  }
});

// ---------- opt-in live check (costs about $0.05; GEMINI_LIVE_TEST=1) ----------

test('live: one bundled request catches a planted inverted condition with a caller in another file', { skip: process.env.GEMINI_LIVE_TEST !== '1' || !process.env.GEMINI_API_KEY }, () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-live-'));
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.email', 't@t');
  sh(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'limits.js'), 'function isOverLimit(used, limit) {\n  return used > limit;\n}\nmodule.exports = { isOverLimit };\n');
  fs.writeFileSync(path.join(repo, 'spend.js'), "const { isOverLimit } = require('./limits');\nif (isOverLimit(todaySpend(), 25)) stopAllJobs();\n");
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-qm', 'base');
  sh(repo, 'checkout', '-qb', 'f');
  fs.writeFileSync(path.join(repo, 'limits.js'), '// Tidy: early return.\nfunction isOverLimit(used, limit) {\n  if (used < limit) return true;\n  return false;\n}\nmodule.exports = { isOverLimit };\n');
  sh(repo, 'commit', '-qam', 'tidy');
  const diff = sh(repo, 'diff', 'main...HEAD');
  const r = spawnSync(process.execPath, [SCRIPT, '--caller=live-test', '--base=main', '--timeout-sec=300'], { cwd: repo, input: `Review this diff for correctness bugs. Cite file:line.\n\n${diff}`, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /limits\.js:3/);
  assert.match(r.stdout, /invert|revers|opposite|backwards|<|less than/i);
});

test('BRO-8160 acceptance: the default bundle budget keeps one review request under 200K input tokens', () => {
  // ~4 chars/token; leaves 80K tokens of headroom for the caller's prompt and diff.
  assert.ok(bundleLib.DEFAULT_BUDGET_CHARS / 4 <= 120_000, `budget ${bundleLib.DEFAULT_BUDGET_CHARS} chars exceeds 120K tokens`);
});
