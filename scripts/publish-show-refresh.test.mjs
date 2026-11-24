// Tests for scripts/publish-show-refresh.ts (BRO-8214). Runs under tsx
// (tests/unit-test-manifest-tsx.txt). The planner is tested in
// scripts/lib/show-refresh/publish-plan.test.mjs; the real-data dry-run is the A6 replay.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, readFlagged, loadManifest, main, DEFAULT_MANIFEST_URL } from './publish-show-refresh.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'publish-show-refresh-'));
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

test('readFlagged reads whitespace-separated ids; a missing file is no flags', () => {
  const dir = tmp();
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

test('an unusable or unreachable manifest exits 0 with outcome manifest-unusable', async () => {
  const dir = tmp();
  const report = path.join(dir, 'r.json');
  const code = await quiet(() => main([`--manifest=${path.join(dir, 'missing.json')}`, `--report=${report}`], {}));
  assert.equal(code, 0);
  assert.equal(JSON.parse(fs.readFileSync(report, 'utf8')).outcome, 'manifest-unusable');
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ schema: 1, invalid: true }));
  assert.equal(await quiet(() => main([`--manifest=${bad}`, `--report=${report}`], {})), 0);
  assert.equal(JSON.parse(fs.readFileSync(report, 'utf8')).outcome, 'manifest-unusable');
});

test('--write exits 2 in L1: refused outside CI, not enabled inside it', async () => {
  const dir = tmp();
  const report = path.join(dir, 'r.json');
  assert.equal(await quiet(() => main(['--write', `--report=${report}`], {})), 2);
  assert.match(JSON.parse(fs.readFileSync(report, 'utf8')).reason, /outside GitHub Actions/);
  assert.equal(await quiet(() => main(['--write', `--report=${report}`], { GITHUB_ACTIONS: 'true' })), 2);
  assert.match(JSON.parse(fs.readFileSync(report, 'utf8')).reason, /not enabled in L1/);
  assert.equal(await quiet(() => main(['--bogus'], {})), 2);
});
