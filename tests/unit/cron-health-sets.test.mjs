// BRO-2771 follow-up — scripts/lib/cron-health-sets.sh.
//
// These drive the REAL shell functions the workflow sources (CLAUDE.md rule 15),
// not a re-implementation, so a change to the set arithmetic fails here.
//
// The regression they exist for: a cron whose run-history query FAILED is absent
// from the stale list, because its health could not be determined. Absence was
// indistinguishable from health, so it was reported RECOVERED — resolving its
// cron-health and cron-health-chronic alert conditions and resetting its
// consecutive-stale streak to zero. An API failure every other day would then keep
// the 3-consecutive-day chronic escalation permanently out of reach for a cron that
// is still dead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HELPER = path.join(REPO_ROOT, 'scripts', 'lib', 'cron-health-sets.sh');

/**
 * Run the real shell helpers over one scenario.
 * @param {{failures?: string, queryFailed?: string, prevStale?: string}} input
 * @returns {{newlyStale: string[], recovered: string[], persistStale: string[]}}
 */
function computeSets({ failures = '', queryFailed = '', prevStale = '' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-health-sets-'));
  try {
    const driver = path.join(dir, 'driver.sh');
    fs.writeFileSync(driver, [
      '#!/usr/bin/env bash',
      `. "${HELPER}"`,
      'CURRENT_STALE=$(stale_names_from_failures "$1")',
      'PREV_STALE=$(normalize_names "$3")',
      'UNKNOWN=$(normalize_names "$2")',
      'compute_cron_health_sets "$CURRENT_STALE" "$PREV_STALE" "$UNKNOWN"',
      '',
    ].join('\n'));

    const out = execFileSync('bash', [driver, failures, queryFailed, prevStale], { encoding: 'utf8' });
    const [a = '', b = '', c = ''] = out.split(/^--$/m);
    const lines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean);
    return { newlyStale: lines(a), recovered: lines(b), persistStale: lines(c) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a query-failed cron that was already stale is NOT reported recovered', () => {
  // This is the regression. Reporting it recovered resolves its alert conditions
  // and resets its chronic-stale streak, for a cron that is still dead.
  const r = computeSets({ failures: '', queryFailed: 'Rebuild Reviews\n', prevStale: 'Rebuild Reviews' });
  assert.deepEqual(r.recovered, [], 'an unknown-health cron must never be reported recovered');
});

test('a query-failed cron that was already stale KEEPS its persisted staleness', () => {
  // Preserving it in the state file is what keeps the consecutive-stale streak
  // alive across an API blip, so the 3-day chronic escalation stays reachable.
  const r = computeSets({ failures: '', queryFailed: 'Rebuild Reviews\n', prevStale: 'Rebuild Reviews' });
  assert.deepEqual(r.persistStale, ['Rebuild Reviews']);
});

test('a query-failed cron is never redispatched on a guess', () => {
  // NEWLY_STALE drives the one-shot self-heal redispatch. An unknown cron must not
  // appear there — we did not establish that it is stale.
  const r = computeSets({ failures: '', queryFailed: 'Rebuild Reviews\n', prevStale: 'Rebuild Reviews' });
  assert.deepEqual(r.newlyStale, []);
});

test('a genuinely recovered cron is still reported recovered', () => {
  const r = computeSets({ failures: '', queryFailed: '', prevStale: 'Rebuild Reviews' });
  assert.deepEqual(r.recovered, ['Rebuild Reviews']);
  assert.deepEqual(r.persistStale, []);
});

test('a still-stale cron is neither recovered nor newly stale', () => {
  const r = computeSets({
    failures: '❌ Rebuild Reviews: Last SUCCESS 99h ago (max 36h)',
    prevStale: 'Rebuild Reviews',
  });
  assert.deepEqual(r.recovered, []);
  assert.deepEqual(r.newlyStale, []);
  assert.deepEqual(r.persistStale, ['Rebuild Reviews']);
});

test('a newly stale cron is detected so the one-shot redispatch still fires', () => {
  const r = computeSets({ failures: '❌ Social Pulse: Last SUCCESS 99h ago (max 36h)' });
  assert.deepEqual(r.newlyStale, ['Social Pulse']);
  assert.deepEqual(r.persistStale, ['Social Pulse']);
});

test('a query-failed cron with no prior staleness is not INVENTED as stale', () => {
  // Unknown means unknown in both directions: we must not manufacture staleness
  // for a cron that was healthy last cycle.
  const r = computeSets({ queryFailed: 'Social Pulse\n' });
  assert.deepEqual(r.persistStale, []);
  assert.deepEqual(r.newlyStale, []);
  assert.deepEqual(r.recovered, []);
});

test('recovered, unknown-but-previously-stale and still-stale stay separate', () => {
  const r = computeSets({
    failures: '❌ Rebuild Reviews: Last SUCCESS 99h ago (max 36h)',
    queryFailed: 'Social Pulse\n',
    prevStale: 'Rebuild Reviews\nSocial Pulse\nTony Awards',
  });
  assert.deepEqual(r.recovered, ['Tony Awards']);
  assert.deepEqual(r.persistStale, ['Rebuild Reviews', 'Social Pulse']);
  assert.deepEqual(r.newlyStale, []);
});

/**
 * Call one exported shell function directly.
 * @param {string} fn
 * @param {string} arg
 * @returns {string}
 */
function callFn(fn, arg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-health-fn-'));
  try {
    const driver = path.join(dir, 'd.sh');
    fs.writeFileSync(driver, `#!/usr/bin/env bash\n. "${HELPER}"\n${fn} "$1"\n`);
    return execFileSync('bash', [driver, arg], { encoding: 'utf8' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('normalize_names does NOT split a name containing a comma', () => {
  // It used to `tr ',' '\n'`. A friendly name with a comma then became two bogus
  // tokens, the prev-stale intersection missed, and that cron was reported
  // RECOVERED — reintroducing the exact bug this file prevents.
  const out = callFn('normalize_names', 'Weekly Grosses, Cumulative\n').split('\n').filter(Boolean);
  assert.deepEqual(out, ['Weekly Grosses, Cumulative'], 'a comma inside a name must not split it');
});

test('normalize_names still splits on newlines, trims, dedupes and sorts', () => {
  const out = callFn('normalize_names', '  b  \na\n\nb\n').split('\n').filter(Boolean);
  assert.deepEqual(out, ['a', 'b']);
});

test('join_names renders "a, b, c" and not paste\'s rotating-delimiter output', () => {
  // `paste -sd ', '` treats the delimiter as a LIST used in ROTATION, emitting
  // "a,b c". Caught live on real cron names before this shipped.
  const out = callFn('join_names', 'Rebuild Reviews\nUpdate Lottery/Rush\nCheck Arm Yield (dead-arm detector)').trim();
  assert.equal(out, 'Rebuild Reviews, Update Lottery/Rush, Check Arm Yield (dead-arm detector)');
});

test('join_names on empty input produces nothing', () => {
  assert.equal(callFn('join_names', '').trim(), '');
});

test('the workflow sources the helper rather than inlining the set arithmetic', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/check-cron-health.yml'), 'utf8');
  assert.match(src, /^\s*\.\s+scripts\/lib\/cron-health-sets\.sh\s*$/m, 'workflow must source the helper');
  assert.match(src, /compute_cron_health_sets\s+"\$CURRENT_STALE"/, 'workflow must call the helper');
  // The state file must be written from the PERSIST set, not the raw stale set —
  // that is what carries an unknown cron's streak across the blip.
  assert.match(src, /CURRENT_STALE="\$PERSIST_STALE"/, 'state file must be written from PERSIST_STALE');
});
