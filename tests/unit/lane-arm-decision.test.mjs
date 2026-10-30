// BRO-6619 (cutover card 3): only a rehearsal on a recorded fixture arms a real publish, and the lane hash covers the
// scorer, the night entry, the live workflow and the Browserbase route. Real functions only (CLAUDE.md section 15).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rh = require('../../scripts/lib/opening-night-lane/rehearsal.js');
const driver = require('../../scripts/lib/opening-night-lane/driver.js');

const ROOT = path.join(import.meta.dirname, '..', '..');
const NOW = Date.parse('2026-10-30T12:00:00Z');
const rec = (over = {}) => ({ at: '2026-10-29T12:00:00Z', pass: true, checked: 34, laneHash: 'abc', kind: 'recorded', ...over });

test('a synthetic rehearsal alone does not arm; a recorded one does', () => {
  assert.deepEqual(rh.armDecision(rec({ kind: 'synthetic' }), { now: NOW, laneHash: 'abc' }), { arm: false, reason: 'no-recorded-rehearsal' });
  assert.deepEqual(rh.armDecision(rec(), { now: NOW, laneHash: 'abc' }), { arm: true, reason: 'last-rehearsal-passed' });
});

test('an unknown, missing or misspelt kind fails closed', () => {
  for (const kind of [undefined, null, '', 'Recorded', 'replay', 'synthetic ', 1]) {
    assert.equal(rh.armDecision(rec({ kind }), { now: NOW, laneHash: 'abc' }).reason, 'no-recorded-rehearsal', String(kind));
  }
});

test('a recorded rehearsal still has to pass, be fresh and match the lane code', () => {
  assert.equal(rh.armDecision(rec({ pass: false }), { now: NOW }).reason, 'last-rehearsal-failed');
  assert.equal(rh.armDecision(rec({ at: '2026-10-01T00:00:00Z' }), { now: NOW }).reason, 'rehearsal-stale');
  assert.equal(rh.armDecision(rec(), { now: NOW, laneHash: 'other' }).reason, 'lane-changed-since-rehearsal');
});

test('the recorded record has its own file, so the weekly synthetic run cannot overwrite it', () => {
  assert.equal(path.relative(ROOT, rh.rehearsalRecordFile(ROOT, 'synthetic')), 'data/audit/lane-rehearsal.json');
  assert.equal(path.relative(ROOT, rh.rehearsalRecordFile(ROOT, 'recorded')), 'data/audit/lane-rehearsal-recorded.json');
  assert.throws(() => rh.rehearsalRecordFile(ROOT, '../x'), /bad record kind/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro6619r-'));
  try {
    const recorded = rh.rehearsalRecordFile(dir, 'recorded');
    rh.recordRehearsal(recorded, { pass: true, verdict: { checked: 22, failures: [] } }, { kind: 'recorded', laneHash: 'abc', at: NOW });
    rh.recordRehearsal(rh.rehearsalRecordFile(dir, 'synthetic'), { pass: true, verdict: { checked: 34, failures: [] } }, { kind: 'synthetic', laneHash: 'abc', at: NOW });
    assert.equal(rh.readRehearsalRecord(recorded).kind, 'recorded');
    assert.equal(rh.armDecision(rh.readRehearsalRecord(recorded), { now: NOW, laneHash: 'abc' }).arm, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

test('the night entry and the arm-check CLI read the recorded record', () => {
  assert.match(fs.readFileSync(path.join(ROOT, 'scripts', 'opening-night-lane.js'), 'utf8'), /rehearsalRecordFile\(repoDir, 'recorded'\)/);
  assert.match(fs.readFileSync(path.join(ROOT, 'scripts', 'opening-night-lane-rehearse.js'), 'utf8'), /readRehearsalRecord\(arg\('--record', ARM_RECORD\)\)/);
});

test('a no-recorded-rehearsal refusal does not tell the owner to rerun the synthetic rehearsal', async () => {
  const pages = [];
  const out = await driver.runProductionLane({
    show: { id: 'x-2026' }, night: '2026-10-30', holder: 'h',
    deps: { armCheck: async () => ({ arm: false, reason: 'no-recorded-rehearsal' }), page: async (p) => { pages.push(p); }, claim: async () => assert.fail('must not claim'), heartbeat: async () => ({ ok: true }), release: async () => ({ ok: true }), runNight: async () => assert.fail('must not run'), log: () => {} },
  });
  assert.equal(out.exit, 3);
  assert.equal(pages.length, 1);
  assert.match(pages[0].description, /recorded from a real opening/);
  assert.doesNotMatch(pages[0].description, /--rehearse/);
});

test('the real lane hash covers the scorer, its llm-scoring imports, both entries, the live workflow and the Browserbase route', () => {
  const files = rh.laneCodeFiles().map((f) => path.relative(ROOT, f));
  for (const f of [...rh.LANE_EXTRA_FILES, rh.LANE_SCORER_ROOT, 'scripts/llm-scoring/config.ts', 'scripts/llm-scoring/ensemble.ts', 'scripts/lib/opening-night-lane/browserbase-fetch.js']) {
    assert.ok(files.includes(f), `${f} must be in the lane hash`);
  }
  for (const f of ['scripts/opening-night-lane-shadow.js', 'scripts/lib/opening-night-lane-shadow.js', 'scripts/lib/owner-alert-router.js']) {
    assert.ok(!files.includes(f), `${f} must stay out of the lane hash`);
  }
});

test('changing ensemble-scorer.ts, a prompt it imports, the entry script or the live workflow changes the lane hash', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bro6619h-'));
  try {
    // Mirror exactly the hashed files at their repo-relative paths: same relative paths and bytes, same hash.
    for (const f of rh.laneCodeFiles()) {
      const dest = path.join(tmp, path.relative(ROOT, f));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(f, dest);
    }
    const lane = path.join(tmp, 'scripts', 'lib', 'opening-night-lane');
    assert.equal(rh.laneCodeHash(lane), rh.laneCodeHash(), 'the mirror hashes like the real tree');
    for (const rel of [rh.LANE_SCORER_ROOT, 'scripts/llm-scoring/config.ts', 'scripts/opening-night-lane.js', '.github/workflows/opening-night-lane-live.yml', 'scripts/lib/opening-night-lane/browserbase-fetch.js']) {
      const before = rh.laneCodeHash(lane);
      fs.appendFileSync(path.join(tmp, rel), '\n// edit\n');
      assert.notEqual(rh.laneCodeHash(lane), before, `editing ${rel} must change the lane hash`);
    }
    const before = rh.laneCodeHash(lane);
    fs.writeFileSync(path.join(tmp, 'scripts', 'opening-night-lane-shadow.js'), '// shadow edit');
    assert.equal(rh.laneCodeHash(lane), before, 'a shadow entry edit does not disarm');
  } finally { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }); }
});

test('the scorer walk follows every relative .ts import form, and nothing outside its folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro6619t-'));
  try {
    const lane = path.join(root, 'scripts', 'lib', 'opening-night-lane');
    const llm = path.join(root, 'scripts', 'llm-scoring');
    fs.mkdirSync(lane, { recursive: true });
    fs.mkdirSync(llm, { recursive: true });
    fs.writeFileSync(path.join(lane, 'a.js'), 'module.exports = 1;');
    fs.writeFileSync(path.join(llm, 'ensemble-scorer.ts'), [
      "import { A } from './a';", 'import type { B } from "./b";', "export { C } from './c';", "import './d';", "const x = require('../lib/excluded');",
    ].join('\n'));
    for (const n of ['a', 'b', 'c', 'd']) fs.writeFileSync(path.join(llm, `${n}.ts`), `export const ${n.toUpperCase()} = 1;`);
    fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts', 'lib', 'excluded.js'), 'module.exports = 1;');
    const files = rh.laneCodeFiles(lane).map((f) => path.relative(root, f));
    assert.deepEqual(files, ['scripts/lib/opening-night-lane/a.js', ...['a', 'b', 'c', 'd'].map((n) => `scripts/llm-scoring/${n}.ts`), 'scripts/llm-scoring/ensemble-scorer.ts'].sort());
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});
