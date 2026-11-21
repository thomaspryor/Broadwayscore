// BRO-7101: live-data lane. Rule fixtures, marker parsing, the collector's
// lane split, and the runtime tracer end to end on throwaway test files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const L = require('../../scripts/live-data-lane.js');
const P = require('../../scripts/lib/live-data-paths.js');
const C = require('../../scripts/lib/unit-test-collection.js');
const HOOK = path.join(ROOT, 'scripts/lib/live-data-read-hook.mjs');

const git = {
  tracked: new Set(['data/venue-complexes.json', 'data/audit/ledger.json', 'data/audit/foo-baseline.json']),
  trackedDirs: new Set(['data/audit']),
};

test('rule: direct read of any data file is live; a baseline is not', () => {
  assert.match(L.liveReason({ path: 'data/venue-complexes.json', direct: true }, git), /read by the test/);
  assert.equal(L.liveReason({ path: 'data/audit/foo-baseline.json', direct: true }, git), null);
  assert.equal(L.liveReason({ path: 'data', direct: true }, git), null, 'listing data/ itself asserts nothing');
});

test('rule: a library read is live only for hot paths', () => {
  assert.equal(L.liveReason({ path: 'data/venue-complexes.json', direct: false }, git), null, 'tracked config table');
  assert.match(L.liveReason({ path: 'data/shows.json', direct: false }, git), /untracked core data/);
  assert.match(L.liveReason({ path: 'data/review-texts/x/y.json', direct: false }, git), /untracked/);
  assert.match(L.liveReason({ path: 'data/audit/ledger.json', direct: false }, git), /bot ledger/);
  assert.equal(L.liveReason({ path: 'data/audit/foo-baseline.json', direct: false }, git), null);
  assert.equal(L.isHotPath('data/audit', git), true, 'audit dir listing is a ledger read');
});

test('classify + check: undeclared live fails, declared-but-clean is stale', () => {
  const v = L.classify([
    { test: 'a.test.mjs', path: 'data/shows.json', direct: false },
    { test: 'b.test.mjs', path: 'data/venue-complexes.json', direct: false },
    { test: 'c.test.mjs', path: 'data/venue-complexes.json', direct: false },
    { test: 'd.test.mjs', path: 'data/shows.json', direct: true },
  ], git);
  assert.equal(v.get('a.test.mjs').live, true);
  assert.equal(v.get('b.test.mjs').live, false);
  const declared = (t) => t === 'c.test.mjs' || t === 'd.test.mjs';
  const r = L.check(v, declared);
  assert.deepEqual(r.undeclared.map((u) => u.test), ['a.test.mjs']);
  assert.deepEqual(r.stale, ['c.test.mjs']);
  assert.deepEqual(L.check(v, declared, ['b.test.mjs']).undeclared, [], 'scope limits the judgement');
});

test('marker: parsed in the first 40 lines only; -live-data name counts; insert keeps shebang', () => {
  assert.equal(P.hasLaneMarker('// LIVE-DATA-LANE: x\n'), true);
  assert.equal(P.hasLaneMarker(' * LIVE-DATA-LANE: x'), true);
  assert.equal(P.hasLaneMarker(`${'\n'.repeat(45)}// LIVE-DATA-LANE: x`), false);
  assert.equal(P.hasLaneMarker('const s = "LIVE-DATA-LANE: not a comment";'), false);
  assert.equal(P.isDeclaredLive('tests/unit/foo-live-data.test.mjs', ''), true);
  assert.equal(P.isDeclaredLive('tests/unit/live-data-routing.test.mjs', ''), false);
  const m = L.withMarker('#!/usr/bin/env node\nx\n', ['data/shows.json (untracked core data)']);
  assert.ok(m.startsWith('#!/usr/bin/env node\n// LIVE-DATA-LANE: reads data/shows.json'));
  assert.equal(P.hasLaneMarker(m), true);
});

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-lane-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}

test('collector lanes: blocking + live partition the land batch; live also takes quarantined/verify files', () => {
  const root = tree({
    'tests/unit/a.test.mjs': '',
    'tests/unit/b.test.mjs': '// LIVE-DATA-LANE: reads data/shows.json\n',
    'tests/unit/c-live-data.test.mjs': '',
    'tests/unit/q.test.mjs': '// LIVE-DATA-LANE: quarantined\n',
    'scripts/verify-x.test.mjs': '// LIVE-DATA-LANE: probe\n',
    'tests/unit/t.test.ts': '// LIVE-DATA-LANE: tsx runner\n',
    'tests/unit-test-manifest-tsx.txt': 'tests/unit/t.test.ts\n',
  });
  try {
    const excluded = new Map([['tests/unit/q.test.mjs', 'quarantined for the test']]);
    const all = C.collectLane(root, 'all', { excluded });
    const blocking = C.collectLane(root, 'blocking', { excluded });
    const live = C.collectLane(root, 'live');
    assert.deepEqual(all, ['tests/unit/a.test.mjs', 'tests/unit/b.test.mjs', 'tests/unit/c-live-data.test.mjs']);
    assert.deepEqual(blocking, ['tests/unit/a.test.mjs']);
    assert.deepEqual(live, ['scripts/verify-x.test.mjs', 'tests/unit/b.test.mjs', 'tests/unit/c-live-data.test.mjs', 'tests/unit/q.test.mjs']);
    for (const f of all) assert.ok(blocking.includes(f) !== live.includes(f), `${f} is in exactly one lane`);
    assert.throws(() => C.collectLane(root, 'nope'), /unknown lane/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('real repo: blocking + live cover the land batch with no overlap, blocking keeps the floor', () => {
  const all = C.collectLane(ROOT, 'all');
  const blocking = new Set(C.collectLane(ROOT, 'blocking'));
  const live = new Set(C.collectLane(ROOT, 'live'));
  assert.ok(blocking.size >= C.MIN_NODE_BATCH, `blocking batch ${blocking.size} under MIN_NODE_BATCH`);
  for (const f of all) assert.ok(blocking.has(f) !== live.has(f), `${f} must be in exactly one lane`);
});

test('filter CLI keeps tsx / scripts-lib lists in their lane', () => {
  const root = tree({ 'x.test.mjs': '// LIVE-DATA-LANE: y\n', 'y.test.mjs': '' });
  try {
    assert.deepEqual(L.filterLane(['x.test.mjs', 'y.test.mjs'], 'live', root), ['x.test.mjs']);
    assert.deepEqual(L.filterLane(['x.test.mjs', 'y.test.mjs'], 'blocking', root), ['y.test.mjs']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// A nested `node --test` under this runner's NODE_TEST_CONTEXT reports into
// the parent instead of running its files normally; strip it (and any tracer
// already active, when this file itself runs traced).
function cleanEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const k of ['NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'LIVE_DATA_TEST']) delete env[k];
  if (!extra.LIVE_DATA_READ_LOG) delete env.LIVE_DATA_READ_LOG;
  return env;
}

test('tracer end to end: direct fs, ESM JSON import, library read and a spawned child', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-trace-'));
  const log = path.join(dir, 'reads.jsonl');
  const dataFile = path.join(ROOT, 'data/venue-complexes.json');
  const lib = path.join(dir, 'lib.cjs'); // a "library": not a test file, not under tests/
  fs.writeFileSync(lib, `module.exports = () => require('fs').readFileSync(${JSON.stringify(dataFile)}, 'utf8');\n`);
  const t1 = path.join(dir, 'direct.test.mjs');
  fs.writeFileSync(t1, [
    "import { readFileSync } from 'node:fs';",
    `readFileSync(${JSON.stringify(dataFile)}, 'utf8');`,
    "import { test } from 'node:test'; test('ok', () => {});",
  ].join('\n'));
  const t2 = path.join(dir, 'esm.test.mjs');
  fs.writeFileSync(t2, `import j from ${JSON.stringify(dataFile)} with { type: 'json' };\nimport { test } from 'node:test'; test('ok', () => { void j; });\n`);
  const t3 = path.join(dir, 'lib.test.mjs');
  fs.writeFileSync(t3, `import { createRequire } from 'node:module';\nconst r = createRequire(import.meta.url);\nr(${JSON.stringify(lib)})();\nimport { test } from 'node:test'; test('ok', () => {});\n`);
  const t4 = path.join(dir, 'spawn.test.mjs');
  fs.writeFileSync(t4, `import { execFileSync } from 'node:child_process';\nexecFileSync(process.execPath, [${JSON.stringify(lib)}.replace(/lib\\.cjs$/, 'run.cjs')]);\nimport { test } from 'node:test'; test('ok', () => {});\n`);
  fs.writeFileSync(path.join(dir, 'run.cjs'), `require(${JSON.stringify(lib)})();\n`);
  try {
    const r = spawnSync(process.execPath, ['--import', HOOK, '--test', '--test-reporter=dot', t1, t2, t3, t4], {
      cwd: ROOT, encoding: 'utf8', env: cleanEnv({ LIVE_DATA_READ_LOG: log }),
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const recs = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const by = (name) => recs.filter((x) => x.test.endsWith(name) && x.path === 'data/venue-complexes.json');
    assert.ok(by('direct.test.mjs').some((x) => x.direct), 'named ESM fs import, called by the test = direct');
    assert.ok(by('esm.test.mjs').some((x) => x.direct), 'JSON import by the test = direct');
    assert.ok(by('lib.test.mjs').length && by('lib.test.mjs').every((x) => !x.direct), 'library read = indirect');
    assert.ok(by('spawn.test.mjs').length && by('spawn.test.mjs').every((x) => !x.direct), 'child process read charged to the test, indirect');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('tracer is inert without LIVE_DATA_READ_LOG', () => {
  const r = spawnSync(process.execPath, ['--import', HOOK, '-e', "require('fs').readFileSync('package.json'); console.log(process.env.NODE_OPTIONS || '')"], {
    cwd: ROOT, encoding: 'utf8', env: cleanEnv({}),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '', 'does not propagate itself when off');
});

test('verify-changed: only changed files a unit batch runs, routed to their runner', () => {
  const batches = { node: new Set(['tests/unit/a.test.mjs', 'scripts/lib/b.test.mjs']), tsx: new Set(['tests/unit/t.test.ts']) };
  const r = L.changedUnitTests([
    'tests/unit/a.test.mjs', 'scripts/lib/b.test.mjs', 'tests/unit/t.test.ts',
    'tests/e2e/x.spec.ts', 'scripts/foo.js', 'tests/unit/orphan.test.mjs',
  ], batches);
  assert.deepEqual(r, { node: ['tests/unit/a.test.mjs', 'scripts/lib/b.test.mjs'], tsx: ['tests/unit/t.test.ts'] });
});

test('verify-changed CLI: nothing changed vs HEAD exits 0; land gauntlet wires it advisory', () => {
  const r = spawnSync(process.execPath, ['scripts/live-data-lane.js', '--verify-changed', '--base=HEAD'], { cwd: ROOT, encoding: 'utf8', env: cleanEnv({}) });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /0 changed unit test file/);
  const g = fs.readFileSync(path.join(ROOT, 'scripts/lib/land-gauntlet.sh'), 'utf8');
  assert.match(g, /\[ -f scripts\/live-data-lane\.js \][^\n]*\n\s*lwgate live-data-lane node scripts\/live-data-lane\.js --verify-changed --base="\$LAND_BASE"/);
});

test('verify-changed CLI: a bad base warns and exits 0 when advisory, fails when blocking', () => {
  const adv = spawnSync(process.execPath, ['scripts/live-data-lane.js', '--verify-changed', '--base=no-such-ref-bro7101'], { cwd: ROOT, encoding: 'utf8', env: cleanEnv({}) });
  assert.equal(adv.status, 0, adv.stdout + adv.stderr);
  assert.match(adv.stdout, /::warning::live-data-lane: cannot diff/);
  const blk = spawnSync(process.execPath, ['scripts/live-data-lane.js', '--verify-changed', '--base=no-such-ref-bro7101'], { cwd: ROOT, encoding: 'utf8', env: cleanEnv({ LAND_LIVE_DATA_LANE_BLOCKING: '1' }) });
  assert.equal(blk.status, 1, blk.stdout + blk.stderr);
  assert.match(blk.stdout, /::error::live-data-lane: cannot diff/);
});

test('live lane skips EXCLUDED files that run at their own test.yml step or are acceptance shims', () => {
  assert.equal(C.runsElsewhere('BRO-2778 — DOES run in CI at its own serial test.yml step. It writes stubs'), true);
  assert.equal(C.runsElsewhere('BRO-2778 — DOES run in CI, by design, at its own test.yml step ("Run scraper-cookie-wiring tests")'), true);
  assert.equal(C.runsElsewhere('BRO-4776 acceptance shim: imports tour-runtime-coverage.test.mjs'), true);
  assert.equal(C.runsElsewhere('BRO-3425 — runs in check-corpus-drift.yml (data-health), not test.yml'), false);
  assert.equal(C.runsElsewhere(undefined), false);
  const live = new Set(C.collectLane(ROOT, 'live'));
  for (const f of ['tests/unit/opening-night-checks-skeleton.test.mjs', 'tests/unit/scraper-cookie-wiring.test.mjs', 'tests/unit/tour-runtime-source-agreement.test.mjs']) {
    assert.equal(live.has(f), false, `${f} runs elsewhere; the live lane must not run it a second time`);
  }
  assert.equal(live.has('tests/unit/tour-runtime-coverage.test.mjs'), true);
});

test('check-corpus-drift live step: each lane source is exit-checked and floored, and both TAP runs need a summary', () => {
  const y = fs.readFileSync(path.join(ROOT, '.github/workflows/check-corpus-drift.yml'), 'utf8');
  assert.doesNotMatch(y, /mapfile -t node_live < <\(node scripts\/lib\/unit-test-collection\.js/, 'process substitution discards the collector exit code');
  assert.match(y, /unit_live=\$\(lane_src unit-collector \d+ node scripts\/lib\/unit-test-collection\.js --lane=live\) \|\| exit 1/);
  assert.match(y, /lib_live=\$\(lane_src scripts\/lib \d+ /);
  assert.match(y, /tsx_out=\$\(lane_src tsx-manifest \d+ /);
  assert.match(y, /grep -q '\^# tests \[0-9\]' "\$RUNNER_TEMP\/live-data-tsx\.tap"/);
});
