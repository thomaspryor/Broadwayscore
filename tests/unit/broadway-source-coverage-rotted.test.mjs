// S4-T2 (2026 data audit, BRO-4204): the Broadway source-coverage guard
// honours checkSilentRot()'s 'rotted' verdict — blind state written, gaps
// file left alone, exit 1 — instead of publishing a fake "0 gaps". Requires
// the REAL decision function (CLAUDE.md §15) and then runs the real script
// end-to-end against an empty-entries fixture, driving the real rot check via
// PLAYBILL_BROADWAY_LAST_SUCCESS_PATH so nothing under data/ is touched.

import { test } from 'node:test';
import { realNowMs } from '../helpers/clock-shift.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'check-broadway-source-coverage.js');
const { decideCoverageOutcome, buildGuardState } = require('../../scripts/check-broadway-source-coverage.js');

test('decideCoverageOutcome: rotted → blind, exit 1, no gaps write', () => {
  assert.deepEqual(decideCoverageOutcome('rotted'), { blind: true, exitCode: 1, writeGaps: false, reason: 'rotted' });
});

test('decideCoverageOutcome: ok / grace → not blind, exit 0, gaps written (grace is still a transient)', () => {
  assert.deepEqual(decideCoverageOutcome('ok'), { blind: false, exitCode: 0, writeGaps: true, reason: 'ok' });
  assert.deepEqual(decideCoverageOutcome('grace'), { blind: false, exitCode: 0, writeGaps: true, reason: 'grace' });
});

test('buildGuardState records {blind, count} under `guard` and preserves the first-seen ledger', () => {
  const prev = { 'playbill-broadway-schedule:some title': { firstSeen: '2026-09-01T00:00:00.000Z', title: 'Some Title' } };
  const blind = buildGuardState(prev, { blind: true, count: null, reason: 'rotted', nowIso: '2026-09-28T00:00:00.000Z' });
  assert.deepEqual(blind.guard, { blind: true, count: null, reason: 'rotted', at: '2026-09-28T00:00:00.000Z' });
  assert.deepEqual(blind['playbill-broadway-schedule:some title'], prev['playbill-broadway-schedule:some title']);
  assert.notEqual(blind, prev, 'must not mutate the input');
  assert.equal(prev.guard, undefined);

  // A healthy run clears the flag and stamps the real count.
  const healthy = buildGuardState(blind, { blind: false, count: 2, reason: 'ok', nowIso: '2026-09-29T00:00:00.000Z' });
  assert.deepEqual(healthy.guard, { blind: false, count: 2, reason: 'ok', at: '2026-09-29T00:00:00.000Z' });
  assert.equal(buildGuardState(null, { blind: false, count: 0, reason: 'ok', nowIso: 't' }).guard.count, 0);
});

test('end-to-end: empty-entries fixture + stale last-success → exit 1, state guard.blind: true / count: null, gaps file NOT written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bsc-coverage-rotted-'));
  try {
    const fixture = join(dir, 'fixture.json');
    // Full-size HTML (>= SILENT_ROT_HTML_THRESHOLD of 5000) with 0 parsed
    // (real clock: the child script is not clock-shifted)
    // entries is the rot signature; a last success 3 days ago is past the
    // 24h grace window, so checkSilentRot() itself returns 'rotted'.
    writeFileSync(fixture, JSON.stringify({ entries: [], html: '<html>' + 'x'.repeat(6000) + '</html>' }));
    const lastSuccess = join(dir, 'last-success.json');
    writeFileSync(lastSuccess, JSON.stringify({ timestamp: new Date(realNowMs() - 3 * 24 * 3600 * 1000).toISOString(), entryCount: 24 }));
    const auditDir = join(dir, 'audit');
    // Pre-existing first-seen ledger must survive the blind write.
    writeFileSync(join(dir, 'state-seed.json'), '');

    const r = spawnSync(process.execPath, [SCRIPT, `--fixture=${fixture}`, `--audit-dir=${auditDir}`], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, PLAYBILL_BROADWAY_LAST_SUCCESS_PATH: lastSuccess },
    });

    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.match(r.stderr, /BLIND/);
    const statePath = join(auditDir, 'broadway-source-coverage-state.json');
    assert.ok(existsSync(statePath), 'state file must be written on a blind run');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.guard.blind, true);
    assert.equal(state.guard.count, null);
    assert.equal(state.guard.reason, 'rotted');
    assert.ok(!existsSync(join(auditDir, 'broadway-source-coverage-gaps.json')), 'gaps file must NOT be written on a blind run');
    // The real rot check must not have advanced the last-success stamp.
    assert.equal(JSON.parse(readFileSync(lastSuccess, 'utf8')).entryCount, 24);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('end-to-end: --dry-run on a rotted fixture still exits 1 but writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bsc-coverage-rotted-dry-'));
  try {
    const fixture = join(dir, 'fixture.json');
    writeFileSync(fixture, JSON.stringify({ entries: [], html: 'x'.repeat(6000) }));
    const lastSuccess = join(dir, 'last-success.json');
    writeFileSync(lastSuccess, JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', entryCount: 10 }));
    const auditDir = join(dir, 'audit');
    const r = spawnSync(process.execPath, [SCRIPT, '--dry-run', `--fixture=${fixture}`, `--audit-dir=${auditDir}`], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, PLAYBILL_BROADWAY_LAST_SUCCESS_PATH: lastSuccess },
    });
    assert.equal(r.status, 1, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.ok(!existsSync(auditDir), '--dry-run must not create the audit dir');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
