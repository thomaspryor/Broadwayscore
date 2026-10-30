// BRO-6663: the morning-after import turns an encrypted lane recording (workflow artifact) into a durable plaintext copy in
// the private repo that the recorded-night loader replays with no key. Fixtures are real recordings made with the lane's own recorder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rec = require('../../scripts/lib/opening-night-lane/fetch-recording.js');
const { loadRecording, replayFetchFrom } = require('../../scripts/lib/lane-recorded-nights/recording-night.js');
const imp = require('../../scripts/lib/lane-recorded-nights/recording-import.js');

const ENV = { LANE_RECORDING_KEY: 'k1', REVIEW_TEXTS_TOKEN: 'tok' };
const KEY = rec.keyFromEnv(ENV);
const encryptWith = (key, text) => { // same format as the recorder: iv(12) + tag(16) + ciphertext
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bro6663-'));
const PAGE_A = '<html><a href="https://x.example/review">SECRET-ROUNDUP-A</a></html>';
const PAGE_B = '<html><a href="https://x.example/review2">SECRET-ROUNDUP-B</a></html>';

/** Record a small night into <base>/<nested...> the way an uploaded artifact nests it. */
async function makeArtifact({ nested = ['_temp', 'shadow', 'recording'], key = KEY, pages = [PAGE_A, PAGE_B], opts = {} } = {}) {
  const base = tmp();
  const dir = path.join(base, ...nested);
  let clock = 1000;
  const r = rec.createFetchRecorder({ dir, key, now: () => clock, ...opts });
  let i = 0;
  const f = r.wrapFetchText(async () => pages[i++ % pages.length]);
  await f('https://agg.example/one');
  clock += 120000; await f('https://agg.example/two');
  return base;
}
const meta = (artifactId = 1) => ({ artifactId, artifactName: 'lane-shadow-demo-2026-11-08', runId: 9, headBranch: 'main' });
const base = { show: 'demo', night: '2026-11-08', kind: 'shadow' };
const cands = (env = ENV) => imp.candidateKeys(env);
const allFiles = (d) => fs.readdirSync(d, { recursive: true }).map((f) => path.join(d, f)).filter((f) => fs.statSync(f).isFile());

test('imports a nested artifact: decrypts, lands in the archive layout, and the loader replays it with no key', async () => {
  const src = await makeArtifact();
  const root = tmp();
  const r = imp.importRecording({ srcDir: src, root, ...base, candidates: cands(), meta: meta() });
  assert.equal(r.status, 'imported');
  const dest = path.join(root, 'demo', '2026-11-08', 'shadow');
  assert.ok(fs.existsSync(path.join(dest, 'fetches.jsonl')));
  assert.ok(allFiles(path.join(dest, 'pages')).every((f) => f.endsWith('.html.gz')));
  const m = JSON.parse(fs.readFileSync(path.join(dest, 'meta.json'), 'utf8'));
  assert.equal(m.keyId, 'key');
  assert.equal(m.artifactId, 1);
  assert.equal(m.pages, 2);
  assert.ok(!JSON.stringify(m).includes(KEY.toString('hex')), 'meta carries no key material');
  const loaded = loadRecording(dest);
  let clock = 0;
  const fetch = replayFetchFrom(loaded, { now: () => clock, startMs: 0 });
  assert.equal((await fetch('https://agg.example/one')).content, PAGE_A);
  clock = 120000;
  assert.equal((await fetch('https://agg.example/two')).content, PAGE_B);
  const v = await imp.verifyArchive(root);
  assert.deepEqual(v.failures, []);
  assert.equal(v.nights[0].replayed, 2);
});

test('the same artifact again is skipped; a new artifact with fewer pages is refused; one with at least as many replaces', async () => {
  const root = tmp();
  const full = await makeArtifact();
  assert.equal(imp.importRecording({ srcDir: full, root, ...base, candidates: cands(), meta: meta(1) }).status, 'imported');
  assert.equal(imp.importRecording({ srcDir: full, root, ...base, candidates: cands(), meta: meta(1) }).status, 'skipped-same');
  const thin = await makeArtifact({ pages: [PAGE_A] });
  const s = imp.importRecording({ srcDir: thin, root, ...base, candidates: cands(), meta: meta(2) });
  assert.equal(s.status, 'skipped-smaller');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'demo/2026-11-08/shadow/meta.json'), 'utf8')).artifactId, 1);
  const again = await makeArtifact();
  const r = imp.importRecording({ srcDir: again, root, ...base, candidates: cands(), meta: meta(3) });
  assert.equal(r.status, 'imported');
  assert.equal(r.replaced, true);
});

test('keys: an old rotated key still decrypts; a wrong set is undecryptable with a stable set id', async () => {
  const old = rec.keyFromEnv({ REVIEW_TEXTS_TOKEN: 'old-token' });
  const src = await makeArtifact({ key: old });
  const root = tmp();
  const bad = imp.importRecording({ srcDir: src, root, ...base, candidates: cands(), meta: meta() });
  assert.equal(bad.status, 'undecryptable');
  assert.equal(bad.candidateSet, imp.candidateSetId(cands()));
  assert.notEqual(imp.candidateSetId(cands()), imp.candidateSetId(cands({ ...ENV, LANE_RECORDING_OLD_KEYS: 'token:old-token' })));
  const ok = imp.importRecording({ srcDir: src, root, ...base, candidates: cands({ ...ENV, LANE_RECORDING_OLD_KEYS: 'token:old-token' }), meta: meta() });
  assert.equal(ok.status, 'imported');
  assert.equal(ok.keyId, 'old-1');
  assert.equal(fs.existsSync(path.join(root, 'demo/2026-11-08/shadow.importing')), false);
  assert.equal(imp.importRecording({ srcDir: src, root: tmp(), ...base, candidates: [], meta: meta() }).status, 'no-keys');
});

test('a tampered page is rejected and nothing is written; errors name no page text', async () => {
  const src = await makeArtifact();
  const root = tmp();
  const pageFile = allFiles(src).find((f) => f.endsWith('.enc'));
  const buf = fs.readFileSync(pageFile); buf[buf.length - 1] ^= 1; fs.writeFileSync(pageFile, buf);
  const r = imp.importRecording({ srcDir: src, root, ...base, candidates: cands(), meta: meta() });
  assert.ok(['undecryptable', 'error'].includes(r.status));
  assert.ok(!JSON.stringify(r).includes('SECRET'));
  assert.equal(fs.existsSync(path.join(root, 'demo')), false);
});

test('a page whose body does not match its hash name is an integrity error', async () => {
  const src = await makeArtifact();
  const root = tmp();
  const pageFile = allFiles(src).find((f) => f.endsWith('.enc'));
  fs.writeFileSync(pageFile, encryptWith(KEY, 'different body'));
  const r = imp.importRecording({ srcDir: src, root, ...base, candidates: cands(), meta: meta() });
  assert.equal(r.status, 'error');
  assert.match(r.detail, /hash/);
});

test('no recording and two recordings in one artifact', async () => {
  assert.equal(imp.importRecording({ srcDir: tmp(), root: tmp(), ...base, candidates: cands() }).status, 'no-recording');
  const one = await makeArtifact();
  const two = await makeArtifact({ nested: ['other'] });
  fs.cpSync(two, one, { recursive: true });
  assert.equal(imp.importRecording({ srcDir: one, root: tmp(), ...base, candidates: cands() }).status, 'error');
});

test('a recording with no stored bodies (date-checks only) imports with keyId none and needs no key', async () => {
  const src = tmp();
  const dir = path.join(src, 'recording');
  fs.mkdirSync(path.join(dir, 'pages'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'fetches.jsonl'), `${JSON.stringify({ t: 0, url: 'https://o.example/a', kind: 'date-check', status: 'ok', publishDate: '2026-11-08T20:00:00Z' })}\n`);
  const r = imp.importRecording({ srcDir: src, root: tmp(), ...base, candidates: [], meta: meta() });
  assert.equal(r.status, 'imported');
  assert.equal(r.keyId, 'none');
});

test('budgets: a night or the whole root over its byte budget is refused, nothing written', async () => {
  const src = await makeArtifact();
  const root = tmp();
  assert.equal(imp.importRecording({ srcDir: src, root, ...base, candidates: cands(), meta: meta(), maxNightBytes: 10 }).status, 'over-budget');
  assert.equal(imp.importRecording({ srcDir: src, root, ...base, candidates: cands(), meta: meta(), maxTotalBytes: 10 }).status, 'over-budget');
  assert.equal(fs.existsSync(path.join(root, 'demo')), false);
});

test('retention keeps the newest nights per show', async () => {
  const root = tmp();
  for (const n of ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04']) fs.mkdirSync(path.join(root, 'demo', n, 'shadow'), { recursive: true });
  assert.deepEqual(imp.applyRetention(root, 2), ['demo/2026-11-01', 'demo/2026-11-02']);
  assert.deepEqual(fs.readdirSync(path.join(root, 'demo')).sort(), ['2026-11-03', '2026-11-04']);
});

test('artifact names parse to show, night and kind', () => {
  assert.deepEqual(imp.parseArtifactName('lane-shadow-the-imaginary-invalid-2026-11-08'), { kind: 'shadow', show: 'the-imaginary-invalid', night: '2026-11-08' });
  assert.deepEqual(imp.parseArtifactName('lane-recording-demo-2026-11-09'), { kind: 'recording', show: 'demo', night: '2026-11-09' });
  assert.equal(imp.parseArtifactName('something-else'), null);
});

test('assertPrivateDest refuses a non-ignored path inside the public worktree and accepts outside or ignored ones', () => {
  const inside = path.join(process.cwd(), 'tests', 'unit', '__bro6663_plaintext__');
  try {
    assert.throws(() => imp.assertPrivateDest(inside), /not git-ignored/);
    assert.ok(imp.assertPrivateDest(tmp()));
    const ignored = path.join(process.cwd(), 'data', 'lane-recordings');
    assert.ok(imp.assertPrivateDest(ignored));
  } finally {
    fs.rmSync(inside, { recursive: true, force: true });
    try { fs.rmdirSync(path.join(process.cwd(), 'data', 'lane-recordings')); } catch { /* not empty or absent */ }
  }
});

// ---- CLI ----
import { spawnSync } from 'node:child_process';
const cli = (args, env = {}) => spawnSync(process.execPath, ['scripts/lane-recording-import.js', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });

test('CLI: imports a fixture, replays it (--verify), exits 78 with no key, and prints no page text', async () => {
  const src = await makeArtifact();
  const root = tmp();
  const args = [`--archive=${root}`, `--from=${src}`, '--show=demo', '--night=2026-11-08', '--kind=shadow', '--artifact-id=5'];
  const none = cli(args);
  assert.equal(none.status, 78, none.stdout + none.stderr);
  assert.equal(fs.existsSync(path.join(root, 'demo')), false);
  const ok = cli(args, ENV);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /imported demo 2026-11-08 shadow: 2 pages/);
  assert.ok(!(ok.stdout + ok.stderr).includes('SECRET'), 'no page text in output');
  assert.ok(!(ok.stdout + ok.stderr).includes(ENV.REVIEW_TEXTS_TOKEN), 'no secret in output');
  const spaced = cli(['--archive', root, '--verify']);
  assert.equal(spaced.status, 0, 'space-separated flag form (used by the workflow) works: ' + spaced.stdout + spaced.stderr);
  const v = cli([`--archive=${root}`, '--verify']);
  assert.equal(v.status, 0, v.stdout + v.stderr);
  assert.match(v.stdout, /verify demo\/2026-11-08\/shadow: 2\/2 bodies replayed/);
  assert.equal(cli(args, ENV).status, 0, 'a second run is a no-op');
});

test('CLI: an undecryptable recording fails once and is quiet-skipped until the key set changes', async () => {
  const src = await makeArtifact({ key: rec.keyFromEnv({ LANE_RECORDING_KEY: 'lost' }) });
  const root = tmp();
  const args = [`--archive=${root}`, `--from=${src}`, '--show=demo', '--night=2026-11-08', '--kind=shadow', '--artifact-id=7'];
  const first = cli(args, ENV);
  assert.equal(first.status, 1);
  assert.match(first.stdout, /no available key decrypts/);
  assert.ok(fs.existsSync(path.join(root, '_undecryptable', 'shadow-demo-2026-11-08.json')));
});

test('discoverArtifacts: newest non-expired main artifact per lane name inside the lookback, stops paging past it', () => {
  const { discoverArtifacts } = require('../../scripts/lane-recording-import.js');
  const now = Date.parse('2026-11-09T12:00:00Z');
  const art = (id, name, created, over = {}) => ({ id, name, created_at: created, expired: false, workflow_run: { id: id * 10, head_branch: 'main' }, ...over });
  const pages = [
    { artifacts: [art(5, 'lane-shadow-demo-2026-11-08', '2026-11-09T06:00:00Z'), art(4, 'lane-shadow-demo-2026-11-08', '2026-11-09T05:00:00Z'), art(3, 'lane-recording-demo-2026-11-08', '2026-11-09T04:00:00Z', { expired: true }),
      art(2, 'lane-recording-demo-2026-11-08', '2026-11-09T03:00:00Z', { workflow_run: { id: 1, head_branch: 'feature' } }), art(9, 'other-artifact', '2026-11-09T02:00:00Z')] },
    { artifacts: [art(1, 'lane-recording-old-2026-09-01', '2026-09-01T00:00:00Z')] },
    { artifacts: [art(0, 'lane-shadow-never-2026-09-01', '2026-09-01T00:00:00Z')] },
  ];
  let calls = 0;
  const got = discoverArtifacts({ repo: 'o/r', lookbackDays: 30, now: () => now, ghApi: () => JSON.stringify(pages[calls++]) });
  assert.deepEqual(got.map((a) => a.id), [5]);
  assert.equal(calls, 2, 'stopped after the page that crossed the cutoff');
});
