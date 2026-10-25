// BRO-3521 / BRO-3523 / BRO-3331: core-data copy allowlist + local copy drift.
// require()s the real functions (CLAUDE.md §15).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const LIB = fileURLToPath(new URL('./core-data-files.js', import.meta.url));
const { getLocalCopyFiles, planCoreDataCopy, findStaleCopies } = require(LIB);

test('getLocalCopyFiles parses setup-local-data.sh (includes the 47MB mezzanine file)', () => {
  const files = getLocalCopyFiles();
  assert.ok(files.includes('critic-registry.json'));
  assert.ok(files.includes('mezzanine-productions-raw.json'));
  assert.ok(!files.includes('shows.json'), 'shows.json is a symlink file, not a copy');
});

test('planCoreDataCopy defaults to the live push-core-data CORE_FILES', () => {
  const { copy, skipped } = planCoreDataCopy(['shows.json', 'awards.json', 'stray.json'], { isPublicTracked: () => true });
  assert.deepEqual(copy, ['shows.json', 'awards.json']);
  assert.deepEqual(skipped, ['stray.json']);
});

test('planCoreDataCopy: a stray private copy of a public-tracked file is NOT copied', () => {
  const tracked = new Set(['show-score-urls.json', 'outlet-registry.json', 'awards.json']);
  const { copy, skipped } = planCoreDataCopy(
    ['shows.json', 'show-score-urls.json', 'outlet-registry.json', 'awards.json', 'mezzanine-productions-raw.json'],
    { isPublicTracked: (n) => tracked.has(n) },
  );
  assert.deepEqual(skipped, ['show-score-urls.json', 'outlet-registry.json']);
  // awards.json: public-tracked but deliberately core data (dual-track) -> copied.
  // mezzanine-productions-raw.json: untracked extra -> copied (current behavior kept).
  assert.deepEqual(copy, ['shows.json', 'awards.json', 'mezzanine-productions-raw.json']);
});

test('plan CLI end to end: a mocked private checkout never shadows a tracked public file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'core-data-plan-'));
  const repo = path.join(tmp, 'repo');
  const priv = path.join(tmp, 'private');
  fs.mkdirSync(path.join(repo, 'data'), { recursive: true });
  fs.mkdirSync(priv);
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'data/show-score-urls.json'), '{"public":true}');
  fs.writeFileSync(path.join(repo, 'data/awards.json'), '{}');
  // A nested tracked file with a private-repo name must not block that name.
  fs.mkdirSync(path.join(repo, 'data/sub'));
  fs.writeFileSync(path.join(repo, 'data/sub/extra.json'), '{}');
  execFileSync('git', ['-C', repo, 'add', 'data']);
  for (const f of ['shows.json', 'reviews.json', 'show-score-urls.json', 'awards.json', 'extra.json']) {
    fs.writeFileSync(path.join(priv, f), '{}');
  }
  const out = execFileSync('node', [LIB, 'plan', priv, repo], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.deepEqual(out.trim().split('\n'), ['awards.json', 'extra.json', 'reviews.json', 'shows.json']);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test('findStaleCopies flags a drifted copy, ignores identical, missing and symlinked files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'core-data-stale-'));
  const data = path.join(tmp, 'data');
  const core = path.join(tmp, 'core');
  fs.mkdirSync(data);
  fs.mkdirSync(core);
  fs.writeFileSync(path.join(core, 'critic-registry.json'), '{"v":2}');
  fs.writeFileSync(path.join(data, 'critic-registry.json'), '{"v":1}');
  fs.writeFileSync(path.join(core, 'grosses.json'), '{"same":1}');
  fs.writeFileSync(path.join(data, 'grosses.json'), '{"same":1}');
  fs.writeFileSync(path.join(core, 'awards.json'), '{}'); // no local copy
  fs.writeFileSync(path.join(core, 'shows.json'), '{"v":2}');
  fs.symlinkSync(path.join(core, 'shows.json'), path.join(data, 'shows.json'));
  const stale = findStaleCopies({ dataDir: data, coreDataDir: core, files: ['critic-registry.json', 'grosses.json', 'awards.json', 'shows.json'] });
  assert.deepEqual(stale, ['critic-registry.json']);
  assert.deepEqual(findStaleCopies({ dataDir: data, coreDataDir: path.join(tmp, 'nope') }), []);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test('findStaleCopies: with repoDir, files the repo tracks are excluded (setup-local-data.sh never refreshes them)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'core-data-tracked-'));
  const repo = path.join(tmp, 'repo');
  const data = path.join(repo, 'data');
  const core = path.join(tmp, 'core');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(core);
  for (const [dir, v] of [[data, 0], [core, 1]]) {
    fs.writeFileSync(path.join(dir, 'awards.json'), `{"v":${v}}`);
    fs.writeFileSync(path.join(dir, 'grosses.json'), `{"v":${v}}`);
  }
  execFileSync('git', ['-C', repo, 'init', '-q']);
  execFileSync('git', ['-C', repo, 'add', 'data/awards.json']);
  const files = ['awards.json', 'grosses.json'];
  assert.deepEqual(findStaleCopies({ dataDir: data, coreDataDir: core, files }), ['awards.json', 'grosses.json'], 'no repoDir: nothing excluded');
  assert.deepEqual(findStaleCopies({ dataDir: data, coreDataDir: core, files, repoDir: repo }), ['grosses.json']);
  assert.deepEqual(findStaleCopies({ dataDir: data, coreDataDir: core, files, repoDir: path.join(tmp, 'not-a-repo') }), ['awards.json', 'grosses.json'], 'non-repo fails open to no exclusion');
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test('stale-copies --warn prints session-start.sh\'s warning only when a copy is stale', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'core-data-warn-'));
  const data = path.join(tmp, 'data');
  const core = path.join(tmp, 'core');
  fs.mkdirSync(data);
  fs.mkdirSync(core);
  const run = (dir) => execFileSync('node', [LIB, 'stale-copies', data, dir, '--warn'], { encoding: 'utf8' });
  fs.writeFileSync(path.join(core, 'grosses.json'), '{"v":1}');
  fs.writeFileSync(path.join(data, 'grosses.json'), '{"v":1}');
  assert.equal(run(core), '', 'identical copy: silent');
  assert.equal(run(path.join(tmp, 'nope')), '', 'absent clone: silent (fail-open)');
  fs.writeFileSync(path.join(data, 'grosses.json'), '{"v":0}');
  const out = run(core);
  assert.match(out, /STALE LOCAL CORE-DATA COPY: .* for: grosses\.json/);
  assert.match(out, /setup-local-data\.sh/);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

// BRO-2937: verifyCoreDataCopy — the checkout-core-data canary.
const { verifyCoreDataCopy } = require(LIB);

function coreDataDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-core-'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

// shows.json + reviews.json are always required and must hold rows.
const SOUND = { 'shows.json': '{"shows":[{"id":"a"}]}', 'reviews.json': '{"reviews":[{"id":"r"}]}' };
const BASE = Object.keys(SOUND);
const rm = (t, dir) => t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

test('verifyCoreDataCopy: a complete copy has no problems', (t) => {
  const core = [...BASE, 'opening-night-sent.json'];
  const dir = coreDataDir({ ...SOUND, 'opening-night-sent.json': '{"shows":{}}', 'extra.json': '[]' });
  rm(t, dir);
  assert.deepEqual(verifyCoreDataCopy({ checkoutNames: [...core, 'extra.json'], plannedCopy: [...core, 'extra.json'], coreFiles: core, dataDir: dir }), []);
});

test('verifyCoreDataCopy: a lost core file says restore from history, never seed empty', (t) => {
  const core = [...BASE, 'opening-night-sent.json'];
  const dir = coreDataDir(SOUND);
  rm(t, dir);
  const problems = verifyCoreDataCopy({ checkoutNames: BASE, plannedCopy: BASE, coreFiles: core, dataDir: dir });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /opening-night-sent\.json is required core data but missing from the private core-data repo/);
  assert.match(problems[0], /restore it from that repo's git history.*never seed an empty value/);
});

test('verifyCoreDataCopy: a planned file absent from data/ after the copy is a problem', (t) => {
  const dir = coreDataDir(SOUND);
  rm(t, dir);
  const problems = verifyCoreDataCopy({ checkoutNames: [...BASE, 'extra.json'], plannedCopy: [...BASE, 'extra.json'], coreFiles: BASE, dataDir: dir });
  assert.deepEqual(problems, ['extra.json was planned for copy but is not in data/ after the copy.']);
});

test('verifyCoreDataCopy: a truncated core file fails the JSON parse', (t) => {
  const dir = coreDataDir({ ...SOUND, 'shows.json': '{"shows": [' });
  rm(t, dir);
  const problems = verifyCoreDataCopy({ checkoutNames: BASE, plannedCopy: BASE, coreFiles: BASE, dataDir: dir });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /data\/shows\.json is not valid JSON/);
});

test('verifyCoreDataCopy: shows.json and reviews.json stay required even if CORE_FILES drops them', (t) => {
  const dir = coreDataDir({ 'opening-night-sent.json': '{}' });
  rm(t, dir);
  const problems = verifyCoreDataCopy({ checkoutNames: ['opening-night-sent.json'], plannedCopy: ['opening-night-sent.json'], coreFiles: ['opening-night-sent.json'], dataDir: dir });
  assert.equal(problems.length, 2);
  assert.ok(problems[0].startsWith('shows.json ') && problems[1].startsWith('reviews.json '));
});

for (const [f, body] of [['shows.json', '{}'], ['shows.json', '{"shows":[]}'], ['reviews.json', '{"reviews":[]}'], ['reviews.json', 'null'], ['reviews.json', '[]']]) {
  test(`verifyCoreDataCopy: an emptied ${f} (${body}) is a problem`, (t) => {
    const dir = coreDataDir({ ...SOUND, [f]: body });
    rm(t, dir);
    const problems = verifyCoreDataCopy({ checkoutNames: BASE, plannedCopy: BASE, coreFiles: BASE, dataDir: dir });
    assert.equal(problems.length, 1, problems.join(' | '));
    assert.match(problems[0], new RegExp(`data/${f.replace('.', '\\.')} parses but holds no`));
  });
}

test('verifyCoreDataCopy: a bare-array reviews.json with rows is accepted', (t) => {
  const dir = coreDataDir({ ...SOUND, 'reviews.json': '[{"id":"r"}]' });
  rm(t, dir);
  assert.deepEqual(verifyCoreDataCopy({ checkoutNames: BASE, plannedCopy: BASE, coreFiles: BASE, dataDir: dir }), []);
});

test('verifyCoreDataCopy defaults to the live push-core-data CORE_FILES (19+ names, incl. opening-night-sent.json)', (t) => {
  const dir = coreDataDir({});
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const problems = verifyCoreDataCopy({ checkoutNames: [], plannedCopy: [], dataDir: dir });
  assert.ok(problems.length >= 19, `expected one problem per CORE_FILES name, got ${problems.length}`);
  assert.ok(problems.some((p) => p.startsWith('opening-night-sent.json ')));
});
