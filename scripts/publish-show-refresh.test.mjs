// Tests for scripts/publish-show-refresh.ts (BRO-8214). Runs under tsx
// (tests/unit-test-manifest-tsx.txt). The planner is tested in
// scripts/lib/show-refresh/publish-plan.test.mjs; the real-data dry-run is the A6 replay.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import './lib/show-refresh/revalidate-queue.test.mjs'; // BRO-8410: queue tests ride this file's VERIFY run
import { parseArgs, readFlagged, loadManifest, main, codeMatchOf, rebuildStepAllowed, sliceCodeClosure, SLICE_ENTRY_POINTS, CLOSURE_ALWAYS, DEFAULT_MANIFEST_URL } from './publish-show-refresh.ts';

import tmpLib from './lib/tmpdir-for-tests.js';
const tmp = (t) => tmpLib.makeTmpDir(t, 'publish-show-refresh-');
const quiet = async (fn) => {
  const { log, error } = console;
  console.log = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.log = log; console.error = error; }
};

test('parseArgs: dry-run by default, the workflow flags, and typos refused', () => {
  const d = parseArgs([]);
  assert.equal(d.mode, 'dry-run');
  assert.equal(d.manifest, DEFAULT_MANIFEST_URL);
  assert.equal(d.parity, false);
  assert.equal(d.cap, 40);
  const a = parseArgs(['--dry-run', '--report=/r.json', '--manifest=m.json', '--flagged-file=f', '--rebuild-step', '--parity=all', '--cap=3']);
  assert.deepEqual([a.report, a.manifest, a.flaggedFile, a.rebuildStep, a.parity, a.cap], ['/r.json', 'm.json', 'f', true, 'all', 3]);
  assert.equal(parseArgs(['--parity']).parity, 'targets');
  assert.equal(parseArgs(['--write']).mode, 'write');
  assert.throws(() => parseArgs(['--dryrun']), /unknown argument/);
  assert.throws(() => parseArgs(['--dry-run', '--write']), /exclusive/);
  assert.throws(() => parseArgs(['--report']), /needs a value/);
  assert.throws(() => parseArgs(['--cap=-1']), /cap/);
});

test('readFlagged reads whitespace-separated ids; a missing file is no flags', (t) => {
  const dir = tmp(t);
  const f = path.join(dir, 'flagged.txt');
  fs.writeFileSync(f, 'a b\nc\n\n');
  assert.deepEqual([...readFlagged(f)], ['a', 'b', 'c']);
  assert.equal(readFlagged(path.join(dir, 'nope')).size, 0);
  assert.equal(readFlagged(null).size, 0);
});

test('loadManifest never throws: a 404 URL and a missing file come back as errors', async () => {
  const r404 = await loadManifest('https://example.invalid/m', async () => new Response('nope', { status: 404 }));
  assert.equal(r404.manifest, null);
  assert.match(r404.error, /HTTP 404/);
  const missing = await loadManifest('/no/such/manifest.json');
  assert.equal(missing.manifest, null);
  assert.ok(missing.error);
});

test('an unusable or unreachable manifest exits 0 with outcome manifest-unusable', async (t) => {
  const dir = tmp(t);
  const report = path.join(dir, 'r.json');
  const code = await quiet(() => main([`--manifest=${path.join(dir, 'missing.json')}`, `--report=${report}`], {}));
  assert.equal(code, 0);
  assert.equal(JSON.parse(fs.readFileSync(report, 'utf8')).outcome, 'manifest-unusable');
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ schema: 1, invalid: true }));
  assert.equal(await quiet(() => main([`--manifest=${bad}`, `--report=${report}`], {})), 0);
  assert.equal(JSON.parse(fs.readFileSync(report, 'utf8')).outcome, 'manifest-unusable');
});

test('--write exits 2 outside CI or without the service key; unusable manifest in CI exits 0 with no write', async (t) => {
  const dir = tmp(t);
  const report = path.join(dir, 'r.json');
  assert.equal(await quiet(() => main(['--write', `--report=${report}`], {})), 2);
  assert.match(JSON.parse(fs.readFileSync(report, 'utf8')).reason, /outside GitHub Actions/);
  assert.equal(await quiet(() => main(['--write', `--report=${report}`], { GITHUB_ACTIONS: 'true' })), 2);
  assert.match(JSON.parse(fs.readFileSync(report, 'utf8')).reason, /SUPABASE_SERVICE_ROLE_KEY/);
  const ciEnv = { GITHUB_ACTIONS: 'true', SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE_KEY: 'x' };
  assert.equal(await quiet(() => main(['--write', `--manifest=${path.join(dir, 'missing.json')}`, `--report=${report}`], ciEnv)), 0);
  const r = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.equal(r.outcome, 'manifest-unusable');
  assert.equal(r.mode, 'write');
  assert.equal(await quiet(() => main(['--bogus'], {})), 2);
});

test('--write refuses (code-mismatch, exit 0, nothing written) unless the code is the deployed commit', async (t) => {
  const dir = tmp(t);
  const report = path.join(dir, 'r.json');
  const man = path.join(dir, 'm.json');
  const shaA = 'a'.repeat(40);
  const ciEnv = { GITHUB_ACTIONS: 'true', SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE_KEY: 'x' };
  fs.writeFileSync(man, JSON.stringify({ schema: 1, manifestId: 'm1', buildInstant: Date.now(), buildDate: '2026-11-24', publicSha: shaA, dataShas: {}, shows: {} }));
  assert.equal(await quiet(() => main(['--write', `--manifest=${man}`, `--report=${report}`], { ...ciEnv, PUBLISH_CODE_SHA: 'b'.repeat(40) })), 0);
  let r = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.equal(r.outcome, 'code-mismatch');
  assert.equal(r.publicSha, shaA);
  // A manifest with no publicSha can never be written from.
  fs.writeFileSync(man, JSON.stringify({ schema: 1, manifestId: 'm1', buildInstant: Date.now(), buildDate: '2026-11-24', dataShas: {}, shows: {} }));
  assert.equal(await quiet(() => main(['--write', `--manifest=${man}`, `--report=${report}`], { ...ciEnv, PUBLISH_CODE_SHA: shaA })), 0);
  r = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.equal(r.outcome, 'code-mismatch');
});

test('codeMatchOf: data-only commits since the deploy match; a code change or an unknown commit does not', (t) => {
  const dir = tmp(t);
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  git('init', '-q');
  git('config', 'user.email', 't@example.invalid'); git('config', 'user.name', 't');
  const commit = (file, body) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), body); git('add', '-A'); git('commit', '-qm', file); return git('rev-parse', 'HEAD'); };
  const deployed = commit('scripts/a.js', '1');
  const env = { PUBLISH_CODE_FETCH: '0', PUBLISH_CODE_CLOSURE: '0' };
  assert.deepEqual([codeMatchOf(env, deployed, dir).match, codeMatchOf(env, deployed, dir).how], [true, 'same commit']);
  commit('data/shows.json', '{}');
  const dataOnly = codeMatchOf(env, deployed, dir);
  assert.equal(dataOnly.match, true);
  assert.match(dataOnly.how, /no code change/);
  // Bot-committed data under src/ is data, not code.
  commit('src/config/genre-tags.json', '{}');
  commit('src/config/onboarding-tour-art.json', '{}');
  assert.equal(codeMatchOf(env, deployed, dir).match, true);
  commit('src/page.tsx', 'x');
  const changed = codeMatchOf(env, deployed, dir);
  assert.equal(changed.match, false);
  assert.match(changed.how, /code changed/);
  const unknown = codeMatchOf(env, 'f'.repeat(40), dir);
  assert.equal(unknown.match, false);
  assert.match(unknown.how, /cannot compare/);
  assert.equal(codeMatchOf(env, null, dir).match, false);
  assert.equal(codeMatchOf(env, 'not-a-sha', dir).match, false);
  // A pinned HEAD never shells out.
  assert.equal(codeMatchOf({ PUBLISH_CODE_SHA: 'b'.repeat(40) }, deployed, dir).match, false);
});

test('--rebuild-step needs SHOW_REFRESH_SAFE=true (the staleness verdict)', () => {
  assert.equal(rebuildStepAllowed({ SHOW_REFRESH_SAFE: 'true' }), true);
  for (const v of [undefined, '', 'false', 'TRUE', '1']) assert.equal(rebuildStepAllowed({ SHOW_REFRESH_SAFE: v }), false);
});

test('workflows: only rebuild-fast passes --rebuild-step, in a step gated on the rebuild, the staleness verdict and the push', async () => {
  const yaml = (await import('js-yaml')).default;
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '.github', 'workflows');
  const hits = [];
  for (const f of fs.readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    if (!text.includes('publish-show-refresh.ts')) continue;
    const wf = yaml.load(text);
    for (const job of Object.values(wf.jobs || {})) {
      for (const step of job.steps || []) {
        if (typeof step.run === 'string' && step.run.includes('publish-show-refresh.ts') && step.run.includes('--rebuild-step')) hits.push({ f, step });
      }
    }
  }
  assert.deepEqual(hits.map((h) => h.f), ['rebuild-fast.yml']);
  const { step } = hits[0];
  for (const cond of ["steps.rebuild.outcome == 'success'", "steps.staleness.outputs.safe_to_publish == 'true'", "steps.push-core-data.outcome == 'success'"]) {
    assert.ok(String(step.if).includes(cond), `gate missing ${cond}`);
  }
  assert.equal(step.env.SHOW_REFRESH_SAFE, '${{ steps.staleness.outputs.safe_to_publish }}');
  assert.equal(step['continue-on-error'], true);
});

test('workflows: writes are on unless SHOW_REFRESH_PUBLISH_WRITES=off; a manual dispatch obeys its write input only', async () => {
  const yaml = (await import('js-yaml')).default;
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '.github', 'workflows');
  const writeEnv = (f, pred) => {
    const wf = yaml.load(fs.readFileSync(path.join(dir, f), 'utf8'));
    const steps = Object.values(wf.jobs).flatMap((j) => j.steps || []).filter((st) => typeof st.run === 'string' && st.run.includes('publish-show-refresh.ts') && pred(st));
    assert.equal(steps.length, 1, `${f}: one publish step`);
    return steps[0].env.WRITE;
  };
  assert.equal(writeEnv('rebuild-fast.yml', (st) => st.run.includes('--rebuild-step')), "${{ vars.SHOW_REFRESH_PUBLISH_WRITES != 'off' && 'true' || 'false' }}");
  // BRO-8233: evaluate the backstop's WRITE expression over a truth table instead of pinning its text.
  // GitHub's `&&`/`||`/`==` on these operands behave like JS (missing inputs are null, never 'true').
  const expr = writeEnv('publish-show-refresh.yml', () => true).replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  const evalWrite = (ctx) => new Function('github', 'inputs', 'vars', `return (${expr});`)(
    { event_name: ctx.event }, { write: ctx.write ?? null, redispatched: ctx.redispatched ?? null }, { SHOW_REFRESH_PUBLISH_WRITES: ctx.writesVar ?? '' });
  const cases = [
    [{ event: 'schedule' }, 'true'],
    [{ event: 'workflow_run' }, 'true'],
    [{ event: 'schedule', writesVar: 'off' }, 'false'],
    [{ event: 'workflow_run', writesVar: 'false' }, 'true'],
    [{ event: 'workflow_dispatch', write: false, redispatched: '' }, 'false'],
    [{ event: 'workflow_dispatch', write: true, redispatched: '' }, 'true'],
    [{ event: 'workflow_dispatch', write: true, redispatched: '', writesVar: 'off' }, 'true'],
    // cron-redispatch.js / check-cron-health self-heal send only redispatched=true: behave like schedule.
    [{ event: 'workflow_dispatch', write: false, redispatched: 'true' }, 'true'],
    [{ event: 'workflow_dispatch', write: false, redispatched: 'true', writesVar: 'off' }, 'false'],
    [{ event: 'workflow_dispatch', write: true, redispatched: 'true', writesVar: 'off' }, 'false'],
  ];
  for (const [ctx, want] of cases) assert.equal(evalWrite(ctx), want, JSON.stringify(ctx));
});

test('publish-show-refresh.yml: the DISABLED switch gates work steps, not the job, so a disabled run stays green for check-cron-health', async () => {
  const yaml = (await import('js-yaml')).default;
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '.github', 'workflows');
  const wf = yaml.load(fs.readFileSync(path.join(dir, 'publish-show-refresh.yml'), 'utf8'));
  const job = wf.jobs.publish;
  assert.equal(job.if, undefined, 'no job-level if: a run whose only job is skipped is not a success');
  for (const name of ['Setup node', 'Checkout core data', 'Publish', 'Upload report']) {
    const st = job.steps.find((x) => x.name === name);
    assert.ok(st && String(st.if).includes("vars.SHOW_REFRESH_PUBLISH_DISABLED != 'true'"), `${name} gated on SHOW_REFRESH_PUBLISH_DISABLED`);
  }
  assert.ok(wf.on.workflow_dispatch.inputs.redispatched, 'opted into cron-redispatch');
});

test('sliceCodeClosure: the slice computation\'s own imports, not every script; none in a dir without the code', (t) => {
  const c = sliceCodeClosure();
  assert.ok(Array.isArray(c), 'closure computed in the repo');
  for (const f of [...SLICE_ENTRY_POINTS, 'scripts/lib/show-refresh/publish-plan.js', 'scripts/lib/show-refresh/manifest.js', 'scripts/lib/resolve-blog-show-id.js']) assert.ok(c.includes(f), `closure has ${f}`);
  for (const f of ['scripts/lib/prod-data-parity.js', 'scripts/rebuild-all-reviews.js']) assert.ok(!c.includes(f), `closure leaves out ${f}`);
  assert.ok(c.every((f) => !f.startsWith('data/') && !f.includes('node_modules')), 'no data or dependencies');
  // Runtime-read config is not in the import graph, so code-dir JSON is always compared.
  assert.ok(CLOSURE_ALWAYS.includes(':(glob)src/**/*.json') && CLOSURE_ALWAYS.includes(':(glob)scripts/**/*.json'));
  // Outside the repo the closure cannot be computed: the caller uses the coarse diff.
  assert.equal(sliceCodeClosure(tmp(t)), null);
});
