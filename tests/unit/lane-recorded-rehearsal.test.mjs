// BRO-5201 S4-T3: the recorded rehearsal. Real nights replay through the production wiring and are graded like a press
// night; the fixtures must match the archived aggregator pages. No archive is a loud skip that records nothing, never a
// pass. The archive is private, so these tests build a stand-in archive holding only the URLs (no article text).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const recorded = require('../../scripts/lib/lane-recorded-nights/index.js');
const CLI = path.join(path.dirname(new URL(import.meta.url).pathname), '../../scripts/opening-night-lane-rehearse.js');

/** A stand-in archive: one aggregator page per night listing the fixture's aggregator-sourced URLs, minus `drop`. */
function archive(drop = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5201-archive-'));
  for (const night of recorded.NIGHTS) {
    fs.mkdirSync(path.join(dir, 'dtli'), { recursive: true });
    const links = night.urls().filter((u) => !drop.includes(u)).map((u) => `<a href="${u}">r</a>`).join('\n');
    fs.writeFileSync(path.join(dir, 'dtli', `${night.show}.html`), `<html><body>${links}</body></html>`);
  }
  return dir;
}

test('no archive: skipped, never a pass', async () => {
  const r = await recorded.runRecordedRehearsal({ archiveDir: path.join(os.tmpdir(), 'bro5201-no-such-archive') });
  assert.equal(r.skipped, true);
  assert.notEqual(r.pass, true);
});

test('an archive with no page for one of the nights is a skip, not a pass', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5201-archive-'));
  try {
    const r = await recorded.runRecordedRehearsal({ archiveDir: dir });
    assert.equal(r.skipped, true);
    assert.match(r.reason, /no archived aggregator page for a-few-good-men-2026/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('both real nights replay and grade same-night PASS when the fixtures match the archive', async () => {
  const dir = archive();
  try {
    const r = await recorded.runRecordedRehearsal({ archiveDir: dir });
    assert.equal(r.pass, true, JSON.stringify(r.verdict.failures));
    assert.deepEqual(r.nights.map((n) => [n.show, n.sameNight]), [['a-few-good-men-2026', 'pass'], ['the-imaginary-invalid-2026', 'pass']]);
    assert.ok(r.verdict.checked >= 40, `checked ${r.verdict.checked}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a fixture URL missing from the archived pages fails provenance', async () => {
  const gone = recorded.NIGHTS[0].urls().find((u) => u.includes('deadline.com'));
  const dir = archive([gone]);
  try {
    const r = await recorded.runRecordedRehearsal({ archiveDir: dir });
    assert.equal(r.pass, false);
    assert.equal(r.verdict.failures.length, 1);
    assert.equal(r.verdict.failures[0].check, 'provenance');
    assert.ok(r.verdict.failures[0].detail.includes(gone));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a night that fails same-night completeness or reports a lane problem fails the rehearsal', async () => {
  const dir = archive();
  try {
    const night = { ...recorded.NIGHTS[0], replay: async () => ({ live: [{}], graded: { sameNight: { status: 'fail', detail: 'not live at +2h: wsj' }, runProblems: ['publish error: push rejected'], verdict: 'FAIL', sourceErrors: [] } }) };
    const r = await recorded.runRecordedRehearsal({ archiveDir: dir, nights: [night] });
    assert.equal(r.pass, false);
    assert.deepEqual(r.verdict.failures.map((f) => f.check), ['same-night-completeness', 'lane-run']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: no archive prints SKIPPED, exits 78 and writes no record', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5201-cli-'));
  try {
    const out = path.join(dir, 'lane-rehearsal-recorded.json');
    const r = spawnSync(process.execPath, [CLI, '--rehearse', '--fixture', 'recorded', '--archive', path.join(dir, 'missing'), '--out', out], { encoding: 'utf8' });
    assert.equal(r.status, 78, r.stderr);
    assert.match(r.stderr, /SKIPPED: .*not a pass/);
    assert.equal(fs.existsSync(out), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: a passing recorded rehearsal writes a recorded record the arm check accepts', () => {
  const dir = archive();
  try {
    const out = path.join(dir, 'lane-rehearsal-recorded.json');
    const r = spawnSync(process.execPath, [CLI, '--rehearse', '--fixture', 'recorded', '--archive', dir, '--out', out], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr.slice(-2000));
    const rec = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(rec.kind, 'recorded');
    assert.equal(rec.pass, true);
    const arm = spawnSync(process.execPath, [CLI, '--arm-check', '--record', out], { encoding: 'utf8' });
    assert.equal(arm.status, 0, arm.stdout);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
