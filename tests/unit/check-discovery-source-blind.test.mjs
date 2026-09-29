// S4-T3 (2026 data audit, BRO-4204): update-show-status goes red when a
// discovery source is blind. Requires the REAL decision function (CLAUDE.md
// §15), runs the real CLI against fixtures, and pins the workflow wiring —
// a separate discovery-source-blind job (needs: update-shows, if: always())
// runs it with no continue-on-error, NOTHING depends on that job, the four
// downstream jobs keep gating on update-shows exactly as before, and the
// coverage guard step keeps its continue-on-error so status flips still run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'check-discovery-source-blind.js');
const { evaluateDiscoveryBlindness, WATCHED_SOURCES } = require('../../scripts/check-discovery-source-blind.js');
const { ZERO_STREAK_ALERT_THRESHOLD } = require('../../scripts/lib/discovery-source-coverage.js');
const yaml = require('js-yaml');

const src = (lastCount, zeroStreak) => ({ lastCount, zeroStreak, totalRuns: 25, lastNonZeroAt: zeroStreak ? null : '2026-09-28T16:39:01.569Z', lastRunAt: '2026-09-28T16:39:01.569Z' });

// Healthy: every watched source contributed this run.
const HEALTHY = {
  sources: {
    todaytix: src(213, 0), playbillBroadway: src(24, 0), playbillOB: src(36, 0), obVenueListings: src(64, 0),
    todaytixWE: src(145, 0), olt: src(40, 0), theatremonkey: src(35, 0), londonTheatre: src(51, 0),
    oweVenues: src(92, 0), showScoreCandidates: src(1, 0),
  },
  updatedAt: '2026-09-28T16:39:01.569Z',
};

// The shape of the LIVE file on 2026-09-28: three watched sources at 22-24
// consecutive zero-candidate runs while every run stayed green.
const LIVE_SHAPE = {
  sources: {
    ...HEALTHY.sources,
    playbillBroadway: { ...src(0, 24), lastNonZeroAt: '2026-08-14T03:01:01.985Z' },
    olt: src(0, 23),
    theatremonkey: src(0, 23),
  },
  updatedAt: '2026-09-28T16:39:01.569Z',
};

test('watched sources are the three S4-T3 names + TheaterMania OB (BRO-4381) and the threshold is the lib\'s (3)', () => {
  assert.deepEqual(WATCHED_SOURCES, ['playbillBroadway', 'olt', 'theatremonkey', 'theatermaniaOB']);
  assert.equal(ZERO_STREAK_ALERT_THRESHOLD, 3);
});

test('BRO-4381: a blind Off-Broadway guard (TheaterMania) is a blindness signal; a healthy one is not', () => {
  const coverage = { sources: { theatermaniaOB: { zeroStreak: 0 } } };
  const blind = evaluateDiscoveryBlindness({ coverage, guardState: null, obGuardState: { guard: { blind: true, reason: '300 rows but none current', at: 'x' } } });
  assert.equal(blind.blind, true);
  assert.match(blind.reasons.join('\n'), /Off-Broadway source-coverage guard is blind/);
  const ok = evaluateDiscoveryBlindness({ coverage, guardState: null, obGuardState: { guard: { blind: false, count: 6 } } });
  assert.equal(ok.blind, false);
  const streak = evaluateDiscoveryBlindness({ coverage: { sources: { theatermaniaOB: { zeroStreak: 3 } } }, guardState: null });
  assert.match(streak.reasons.join('\n'), /theatermaniaOB: 0 candidates for 3/);
});

test('healthy coverage + healthy guard → not blind', () => {
  assert.deepEqual(evaluateDiscoveryBlindness({ coverage: HEALTHY, guardState: { guard: { blind: false, count: 0 } } }), { blind: false, reasons: [] });
  assert.deepEqual(evaluateDiscoveryBlindness({ coverage: HEALTHY, guardState: null }), { blind: false, reasons: [] });
  assert.deepEqual(evaluateDiscoveryBlindness({ coverage: HEALTHY, guardState: {} }), { blind: false, reasons: [] });
});

test('the live 2026-09-28 shape (streaks 22-24) → blind, naming all three sources', () => {
  const v = evaluateDiscoveryBlindness({ coverage: LIVE_SHAPE, guardState: null });
  assert.equal(v.blind, true);
  assert.equal(v.reasons.length, 3);
  assert.match(v.reasons[0], /^playbillBroadway: 0 candidates for 24 consecutive runs/);
  assert.match(v.reasons[1], /^olt: 0 candidates for 23 consecutive runs/);
  assert.match(v.reasons[2], /^theatremonkey: 0 candidates for 23 consecutive runs/);
});

test('threshold boundary: streak 2 is not blind, streak 3 is; an unwatched source never trips it', () => {
  const two = { sources: { ...HEALTHY.sources, olt: src(0, 2) } };
  assert.equal(evaluateDiscoveryBlindness({ coverage: two, guardState: null }).blind, false);
  const three = { sources: { ...HEALTHY.sources, olt: src(0, 3) } };
  assert.equal(evaluateDiscoveryBlindness({ coverage: three, guardState: null }).blind, true);
  const unwatched = { sources: { ...HEALTHY.sources, showScoreCandidates: src(0, 40) } };
  assert.equal(evaluateDiscoveryBlindness({ coverage: unwatched, guardState: null }).blind, false);
});

test('guard.blind: true alone → blind (the S4-T2 rotted record)', () => {
  const v = evaluateDiscoveryBlindness({ coverage: HEALTHY, guardState: { guard: { blind: true, count: null, reason: 'rotted', at: '2026-09-28T08:00:00.000Z' } } });
  assert.equal(v.blind, true);
  assert.equal(v.reasons.length, 1);
  assert.match(v.reasons[0], /coverage guard is blind \(rotted at 2026-09-28T08:00:00.000Z\)/);
});

test('missing/unparseable coverage file → blind (fails closed)', () => {
  const v = evaluateDiscoveryBlindness({ coverage: null, guardState: null });
  assert.equal(v.blind, true);
  assert.match(v.reasons[0], /failing closed/);
  assert.equal(evaluateDiscoveryBlindness({ coverage: { updatedAt: 'x' }, guardState: null }).blind, true);
});

function runCli(coverage, guardState) {
  const dir = mkdtempSync(join(tmpdir(), 'bsc-blind-'));
  try {
    const args = [SCRIPT];
    if (coverage !== undefined) {
      const p = join(dir, 'coverage.json');
      writeFileSync(p, JSON.stringify(coverage));
      args.push(`--coverage=${p}`);
    } else {
      args.push(`--coverage=${join(dir, 'does-not-exist.json')}`);
    }
    const sp = join(dir, 'state.json');
    writeFileSync(sp, JSON.stringify(guardState ?? {}));
    args.push(`--state=${sp}`);
    return spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('CLI: healthy fixture exits 0', () => {
  const r = runCli(HEALTHY, { guard: { blind: false, count: 0 } });
  assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /all below the 3-run zero-streak threshold/);
});

test('CLI: the live file shape (streaks 22-24) exits 1 with a ::error:: naming the sources', () => {
  const r = runCli(LIVE_SHAPE, {});
  assert.equal(r.status, 1, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stderr, /::error::3 discovery blindness signal/);
  assert.match(r.stderr, /playbillBroadway: 0 candidates for 24 consecutive runs/);
  assert.match(r.stderr, /theatremonkey/);
});

test('CLI: blind guard state alone exits 1; missing coverage file exits 1', () => {
  assert.equal(runCli(HEALTHY, { guard: { blind: true, count: null, reason: 'rotted', at: 't' } }).status, 1);
  assert.equal(runCli(undefined, {}).status, 1);
});

test('CLI: --help exits 0 without reading anything', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--help'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /check-discovery-source-blind\.js/);
});

// Workflow wiring: this is what makes the RUN red without touching the
// pipeline. Parsed, not grepped.
const SCRIPT_RE = /node scripts\/check-discovery-source-blind\.js/;
const needsOf = (job) => (Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : []);

test('update-show-status.yml: a separate discovery-source-blind job (needs: update-shows, if: always()) runs the check with no continue-on-error', () => {
  const wf = yaml.load(readFileSync(join(ROOT, '.github', 'workflows', 'update-show-status.yml'), 'utf8'));
  const job = wf.jobs['discovery-source-blind'];
  assert.ok(job, 'discovery-source-blind job must exist');
  assert.deepEqual(needsOf(job), ['update-shows']);
  assert.equal(String(job.if), 'always()', 'the verdict must run even when update-shows failed');
  assert.equal(job['continue-on-error'], undefined, 'the job must be able to fail the run');

  const step = job.steps.find(s => SCRIPT_RE.test(s.run || ''));
  assert.ok(step, 'the job must run scripts/check-discovery-source-blind.js');
  assert.equal(step.name, 'Fail if a discovery source is blind');
  assert.equal(step['continue-on-error'], undefined, 'the verdict step must be able to fail the job');
  assert.ok(!/\|\|\s*true/.test(step.run), 'the verdict must not be swallowed with || true');

  // The two audit files it reads are tracked in this repo, and `ref: main`
  // makes the checkout see the streaks update-shows just committed rather
  // than the trigger commit's stale copy (same reason catchup-zero-review-shows
  // checks out main).
  const checkout = job.steps.find(s => /actions\/checkout@/.test(s.uses || ''));
  assert.ok(checkout, 'the job must check out the repo');
  assert.equal(checkout.with && checkout.with.ref, 'main');
});

test('update-show-status.yml: the blind check is NOT a step of update-shows, and the coverage guard keeps continue-on-error', () => {
  const wf = yaml.load(readFileSync(join(ROOT, '.github', 'workflows', 'update-show-status.yml'), 'utf8'));
  const steps = wf.jobs['update-shows'].steps;
  assert.equal(
    steps.find(s => SCRIPT_RE.test(s.run || '')),
    undefined,
    'a failing blind check inside update-shows would skip every downstream job that needs its success (owner decision 2026-09-28)'
  );
  const guard = steps.find(s => s.name === 'Check Broadway source coverage');
  assert.ok(guard, 'coverage guard step still present');
  assert.equal(guard['continue-on-error'], true, 'the guard step must keep continue-on-error so status flips still run (S4-T3)');
});

test('update-show-status.yml: nothing depends on discovery-source-blind, and the downstream jobs gate on update-shows exactly as before', () => {
  const wf = yaml.load(readFileSync(join(ROOT, '.github', 'workflows', 'update-show-status.yml'), 'utf8'));
  for (const [name, job] of Object.entries(wf.jobs)) {
    assert.ok(!needsOf(job).includes('discovery-source-blind'), `${name} must not need discovery-source-blind — a blind source would then skip it`);
  }
  // Pinned verbatim: these four are what a blind source must NOT switch off.
  const ci = wf.jobs['create-issue'];
  assert.deepEqual(needsOf(ci), ['update-shows']);
  assert.ok(!/discovery-source-blind|always\(\)/.test(String(ci.if)), 'create-issue keeps its implicit success() gate on update-shows');
  const tda = wf.jobs['trigger-data-agent'];
  assert.deepEqual(needsOf(tda), ['update-shows']);
  assert.ok(!/discovery-source-blind|always\(\)/.test(String(tda.if)), 'trigger-data-agent keeps its implicit success() gate on update-shows');
  for (const name of ['catchup-zero-review-shows', 'check-opening-night-readiness']) {
    assert.deepEqual(needsOf(wf.jobs[name]), ['update-shows']);
    assert.equal(String(wf.jobs[name].if).trim(), "always() && needs.update-shows.result == 'success'", `${name} gate unchanged`);
  }
  const alert = wf.jobs['alert-on-failure'];
  assert.deepEqual(needsOf(alert), ['update-shows']);
  assert.equal(String(alert.if).trim(), 'failure()', 'alert-on-failure semantics unchanged');
});
