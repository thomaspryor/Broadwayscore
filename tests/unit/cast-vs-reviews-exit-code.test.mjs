// BRO-5860: audit-cast-vs-reviews.js runs in the daily corpus-drift monitor.
// Its exit code is the monitor's verdict, so "could not run" (no review-texts,
// every show insufficient) must be 2, never a clean 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { auditExitCode } = require('../../scripts/lib/cast-review-crosscheck.js');

test('nothing checkable is a crash (2), not a pass', () => {
  assert.equal(auditExitCode({ checked: 0, contradicted: 0, strict: true }), 2);
  assert.equal(auditExitCode({ checked: 0, contradicted: 0 }), 2);
});

test('--show=ID with an insufficient show is not a crash', () => {
  assert.equal(auditExitCode({ checked: 0, contradicted: 0, strict: true, single: true }), 0);
});

test('--strict trips on any contradicted show', () => {
  assert.equal(auditExitCode({ checked: 918, contradicted: 0, strict: true }), 0);
  assert.equal(auditExitCode({ checked: 918, contradicted: 1, strict: true }), 1);
});

test('without --strict the audit is report-only', () => {
  assert.equal(auditExitCode({ checked: 918, contradicted: 40 }), 0);
});

// The CLI path, end to end on a fixture.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), '../../scripts/audit-cast-vs-reviews.js');
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvr-'));
  const body = 'A review of the play. '.repeat(80);
  const shows = ['a', 'b'].map((id) => ({ id, title: id, cast: [{ name: 'Zelda Quimby' }, { name: 'Horace Pettibone' }] }));
  fs.writeFileSync(path.join(dir, 'shows.json'), JSON.stringify({ shows }));
  for (const s of shows) {
    fs.mkdirSync(path.join(dir, 'rt', s.id), { recursive: true });
    for (const o of ['nyt', 'vulture', 'variety']) fs.writeFileSync(path.join(dir, 'rt', s.id, `${o}.json`), JSON.stringify({ outletId: o, fullText: body, contentTier: 'complete' }));
  }
  return dir;
}
const run = (dir, ...a) => spawnSync(process.execPath, [SCRIPT, `--shows=${dir}/shows.json`, `--reviews=${dir}/rt`, ...a], { encoding: 'utf8' });

test('CLI: contradicted fixture trips --strict, report-only without it', () => {
  const dir = fixture();
  const base = run(dir);
  assert.match(base.stdout, /2 shows checked/);
  assert.equal(base.status, 0);
  assert.equal(run(dir, '--strict').status, 1);
});

test('CLI: unknown --show, missing shows.json, empty review-texts are could-not-run (2)', () => {
  const dir = fixture();
  assert.equal(run(dir, '--show=nope').status, 2);
  assert.equal(spawnSync(process.execPath, [SCRIPT, `--shows=${dir}/none.json`], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [SCRIPT, `--shows=${dir}/shows.json`, `--reviews=${dir}/empty`, '--strict'], { encoding: 'utf8' }).status, 2);
});
