import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const m = require('./land-mutex.js');
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'land-mutex.js');

const NOW = Date.parse('2026-10-12T02:00:00Z');
const T = (runId, { prio = 1, at = NOW - 60000, attempt = 1, sha = `s${runId}` } = {}) => {
  const ref = m.ticketName({ mainRed: prio === 0, enqueuedAt: at, runId, attempt });
  return { ...m.parseTicket(ref, sha) };
};
const state = (tickets, lockSha) => ({ tickets: [...tickets].sort((a, b) => (a.ref < b.ref ? -1 : 1)), lock: lockSha ? { sha: lockSha } : null });
const me = { runId: '2', attempt: 1 };

test('ticket names round-trip and sort main-red first, then FIFO', () => {
  const ls = [
    `sB\t${m.ticketName({ mainRed: false, enqueuedAt: NOW + 5, runId: '7', attempt: 1 })}`,
    `sA\t${m.ticketName({ mainRed: false, enqueuedAt: NOW, runId: '9', attempt: 2 })}`,
    `sC\t${m.ticketName({ mainRed: true, enqueuedAt: NOW + 9, runId: '3', attempt: 1 })}`,
    `sL\t${m.LOCK_REF}`,
    'junk\trefs/land-mutex/queue/not-a-ticket',
  ].join('\n');
  const s = m.parseLsRemote(ls);
  assert.deepEqual(s.tickets.map((t) => t.runId), ['3', '9', '7']);
  assert.equal(s.tickets[1].attempt, 2);
  assert.equal(s.tickets[1].enqueuedAt, NOW);
  assert.deepEqual(s.lock, { sha: 'sL' });
});

test('no ticket of ours → enqueue; head with no lock → acquire; lock on our ticket → held', () => {
  assert.equal(m.decideStep({ state: state([T('1')]), self: me, now: NOW }).action, 'enqueue');
  assert.equal(m.decideStep({ state: state([T('2'), T('3', { at: NOW })]), self: me, now: NOW }).action, 'acquire');
  assert.equal(m.decideStep({ state: state([T('2')], 's2'), self: me, now: NOW }).action, 'held');
});

test('behind a live head or a live holder → wait, naming the blocker', () => {
  const head = T('1', { at: NOW - 120000 });
  const d = m.decideStep({ state: state([head, T('2')]), self: me, now: NOW });
  assert.equal(d.action, 'wait');
  assert.equal(m.blockerRef(d), head.ref);
  const locked = m.decideStep({ state: state([T('2', { at: NOW - 999999 }), T('5')], 's5'), self: me, now: NOW });
  assert.equal(locked.action, 'wait'); // even at the head, a held lock blocks
  assert.equal(locked.reason, 'locked');
});

test('a blocker stuck past the grace is looked up; a gone head is dropped, a gone holder broken', () => {
  const head = T('1');
  const stuck = { ref: head.ref, since: NOW - m.GRACE_MS };
  assert.equal(m.decideStep({ state: state([head, T('2')]), self: me, stuck, now: NOW }).action, 'check');
  assert.equal(m.decideStep({ state: state([head, T('2')]), self: me, stuck: { ref: head.ref, since: NOW - 1000 }, now: NOW }).action, 'wait');
  const gone = () => 'gone';
  assert.deepEqual(m.decideStep({ state: state([head, T('2')]), self: me, liveness: gone, now: NOW }), { action: 'drop-ticket', ticket: head });
  const b = m.decideStep({ state: state([head, T('2')], head.sha), self: me, liveness: gone, now: NOW });
  assert.equal(b.action, 'break-lock');
  assert.equal(b.sha, head.sha);
  const live = () => 'live';
  assert.equal(m.decideStep({ state: state([head, T('2')], head.sha), self: me, liveness: live, stuck, now: NOW }).action, 'wait');
});

test('an orphaned lock (its ticket gone) is broken only after the grace', () => {
  const s = state([T('2')], 'orphan');
  assert.equal(m.decideStep({ state: s, self: me, now: NOW }).action, 'wait');
  const d = m.decideStep({ state: s, self: me, stuck: { ref: m.LOCK_REF, since: NOW - m.GRACE_MS }, now: NOW });
  assert.deepEqual([d.action, d.sha], ['break-lock', 'orphan']);
});

test('liveness: completed or re-run as a newer attempt is gone; unreadable is gone only past the age cap', () => {
  const t = T('1', { attempt: 1, at: NOW - 60000 });
  assert.equal(m.ticketLiveness(t, { status: 'in_progress', run_attempt: 1 }, { now: NOW }), 'live');
  assert.equal(m.ticketLiveness(t, { status: 'completed', run_attempt: 1 }, { now: NOW }), 'gone');
  assert.equal(m.ticketLiveness(t, { status: 'queued', run_attempt: 2 }, { now: NOW }), 'gone');
  assert.equal(m.ticketLiveness(t, null, { now: NOW }), 'live');
  assert.equal(m.ticketLiveness(T('1', { at: NOW - m.STALE_AGE_MS - 1 }), null, { now: NOW }), 'gone');
});

test('HTTP 404 identifies a missing run; other lookup failures keep the age fallback', () => {
  const { isRefNotFound } = require('./land-retry-on-cancel.js');
  assert.equal(isRefNotFound({ stderr: Buffer.from('gh: Not Found (HTTP 404)') }), true);
  for (const message of ['gh: Forbidden (HTTP 403)', 'gh: rate limit exceeded (HTTP 429)', 'gh: Server Error (HTTP 502)', 'connect ETIMEDOUT', 'Not Found']) {
    assert.equal(isRefNotFound({ stderr: message }), false, message);
  }
});

test('a fresh missing holder is broken; unreadable and in_progress holders keep the lock', () => {
  const holder = T('1', { at: NOW - 1000 });
  for (const [run, expectedLiveness, expectedAction] of [
    [{ status: 'missing' }, 'gone', 'break-lock'],
    [null, 'live', 'wait'],
    [{ status: 'in_progress', run_attempt: 1 }, 'live', 'wait'],
  ]) {
    const verdict = m.ticketLiveness(holder, run, { now: NOW });
    assert.equal(verdict, expectedLiveness);
    const d = m.decideStep({ state: state([holder, T('2')], holder.sha), self: me,
      liveness: (ref) => ref === holder.ref ? verdict : undefined,
      stuck: { ref: holder.ref, since: NOW - m.GRACE_MS }, now: NOW });
    assert.equal(d.action, expectedAction);
    assert.equal(d.reason, expectedAction === 'break-lock' ? 'holder-gone' : 'locked');
    if (d.action === 'break-lock') assert.equal(d.sha, holder.sha);
  }
});

test('poll delay grows to the cap with jitter', () => {
  assert.equal(m.nextPollMs(0, { rand: () => 0.5 }), m.POLL_MIN_MS);
  assert.equal(m.nextPollMs(20, { rand: () => 0.5 }), m.POLL_MAX_MS);
  assert.ok(m.nextPollMs(20, { rand: () => 1 }) <= m.POLL_MAX_MS * 1.2);
});

// ---- the real CLI against a local bare remote: concurrency, FIFO, stale-break ----

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'land-mutex-'));
  const remote = path.join(dir, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  const work = path.join(dir, 'work');
  execFileSync('git', ['init', '-q', work]);
  return { dir, remote, work };
}

const cliEnv = (remote, runId, extra = {}) => ({
  ...process.env, GITHUB_OUTPUT: '', GITHUB_RUN_ID: String(runId), GITHUB_RUN_ATTEMPT: '1', LAND_BRANCH: `land/t-${runId}`,
  LAND_MUTEX_REMOTE: remote, LAND_MUTEX_NO_API: '1', LAND_MUTEX_POLL_SCALE: '0.02', LAND_MUTEX_GRACE_MS: '300', ...extra,
});

function run(args, env, cwd) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env, cwd });
    let out = '';
    p.stdout.on('data', (b) => { out += b; });
    p.stderr.on('data', (b) => { out += b; });
    p.on('close', (code) => resolve({ code, out }));
  });
}

// One lander: acquire, hold a critical section that records overlap, release.
async function lander(ctx, runId, startDelayMs, holdMs, journal) {
  await new Promise((r) => setTimeout(r, startDelayMs));
  const env = cliEnv(ctx.remote, runId);
  const a = await run(['acquire'], env, ctx.work);
  assert.equal(a.code, 0, a.out);
  assert.match(a.out, /holding the landing lock/, a.out);
  appendFileSync(journal, `enter ${runId}\n`);
  await new Promise((r) => setTimeout(r, holdMs));
  appendFileSync(journal, `exit ${runId}\n`);
  const r = await run(['release'], env, ctx.work);
  assert.equal(r.code, 0, r.out);
}

test('CLI: 4 concurrent landers never overlap, land in queue order, and leave no refs behind', { timeout: 60000 }, async () => {
  const ctx = setup();
  const journal = path.join(ctx.dir, 'journal');
  writeFileSync(journal, '');
  try {
    await Promise.all([lander(ctx, 11, 0, 400, journal), lander(ctx, 12, 150, 400, journal), lander(ctx, 13, 300, 400, journal), lander(ctx, 14, 450, 400, journal)]);
    const lines = readFileSync(journal, 'utf8').trim().split('\n');
    let inside = 0;
    for (const l of lines) {
      inside += l.startsWith('enter') ? 1 : -1;
      assert.ok(inside <= 1, `overlap: ${lines.join(' | ')}`);
    }
    assert.deepEqual(lines.filter((l) => l.startsWith('enter')), ['enter 11', 'enter 12', 'enter 13', 'enter 14']);
    assert.equal(execFileSync('git', ['ls-remote', ctx.remote, 'refs/land-mutex/*'], { encoding: 'utf8' }).trim(), '');
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('CLI: a dead holder (lock + ticket left past the age cap) is broken and the waiter proceeds', { timeout: 30000 }, async () => {
  const ctx = setup();
  try {
    const tree = execFileSync('git', ['-C', ctx.work, 'hash-object', '-t', 'tree', '-w', '/dev/null'], { encoding: 'utf8' }).trim();
    const sha = execFileSync('git', ['-C', ctx.work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree, '-m', 'dead'], { encoding: 'utf8' }).trim();
    const dead = m.ticketName({ mainRed: false, enqueuedAt: Date.now() - m.STALE_AGE_MS - 60000, runId: '99', attempt: 1 });
    execFileSync('git', ['-C', ctx.work, 'push', '-q', ctx.remote, `${sha}:${dead}`, `${sha}:${m.LOCK_REF}`]);
    const a = await run(['acquire'], cliEnv(ctx.remote, 21), ctx.work);
    assert.match(a.out, /broke stale lock/, a.out);
    assert.match(a.out, /dropped stale ticket/, a.out);
    assert.match(a.out, /holding the landing lock/, a.out);
    await run(['release'], cliEnv(ctx.remote, 21), ctx.work);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('CLI: HTTP 404 breaks a fresh holder through leased recovery and the waiter proceeds', { timeout: 30000 }, async () => {
  const ctx = setup();
  try {
    const bin = path.join(ctx.dir, 'bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'gh'), '#!/usr/bin/env node\nprocess.stderr.write("gh: Not Found (HTTP 404)\\n"); process.exit(1);\n', { mode: 0o755 });
    const tree = execFileSync('git', ['-C', ctx.work, 'hash-object', '-t', 'tree', '-w', '/dev/null'], { encoding: 'utf8' }).trim();
    const sha = execFileSync('git', ['-C', ctx.work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree, '-m', 'missing run'], { encoding: 'utf8' }).trim();
    const holder = m.ticketName({ mainRed: false, enqueuedAt: Date.now(), runId: '99', attempt: 1 });
    execFileSync('git', ['-C', ctx.work, 'push', '-q', ctx.remote, `${sha}:${holder}`, `${sha}:${m.LOCK_REF}`]);
    const env = cliEnv(ctx.remote, 22, { LAND_MUTEX_NO_API: '0', PATH: `${bin}${path.delimiter}${process.env.PATH}` });
    const a = await run(['acquire'], env, ctx.work);
    assert.equal(a.code, 0, a.out);
    assert.match(a.out, /broke stale lock .* \(holder-gone\)/, a.out);
    assert.match(a.out, /dropped stale ticket/, a.out);
    assert.match(a.out, /holding the landing lock/, a.out);
    const r = await run(['release'], env, ctx.work);
    assert.equal(r.code, 0, r.out);
    assert.equal(execFileSync('git', ['ls-remote', ctx.remote, 'refs/land-mutex/*'], { encoding: 'utf8' }).trim(), '');
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('CLI: an unreachable remote fails open with held=false', { timeout: 60000 }, async () => {
  const ctx = setup();
  const out = path.join(ctx.dir, 'out');
  writeFileSync(out, '');
  try {
    const a = await run(['acquire'], cliEnv(path.join(ctx.dir, 'nope.git'), 31, { GITHUB_OUTPUT: out }), ctx.work);
    assert.equal(a.code, 0);
    assert.match(a.out, /proceeding WITHOUT the landing lock/);
    assert.equal(readFileSync(out, 'utf8').trim(), 'held=false');
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// ---- BRO-5196: parking behind a deep queue ----
const { decideLandRetry } = require('./land-retry-on-cancel.js');
const { decideStrandedRef } = require('./land-stranded-refs.js');
const { decideSweep } = require('./land-queue-backoff.js');

const step = (name, number, conclusion) => ({ name, number, conclusion });
const parkedLand = (extra = []) => ({
  name: 'Land',
  conclusion: 'cancelled',
  steps: [step('Set up job', 1, 'success'), step(m.PARK_STEP_NAME, 2, 'cancelled'), step('Checkout main', 3, 'skipped'), step('Complete job', 9, 'success'), ...extra],
});
const evictedLand = () => ({ name: 'Land', conclusion: 'cancelled', steps: [] });
const checksOk = { name: 'Checks', conclusion: 'success' };
const runOf = (o = {}) => ({ id: 5, status: 'completed', conclusion: 'cancelled', head_branch: 'land/bro-1', head_sha: 'abc', run_attempt: 1, created_at: new Date(NOW - 3600e3).toISOString(), updated_at: new Date(NOW - 3000e3).toISOString(), ...o });

test('isParkedLandJob: only an admit step that ended cancelled with no work after it', () => {
  assert.equal(m.isParkedLandJob(parkedLand()), true);
  assert.equal(m.isParkedLandJob(evictedLand()), false);
  assert.equal(m.isParkedLandJob(null), false);
  // admit passed (normal run) then a later cancel mid-flight: not parked
  assert.equal(m.isParkedLandJob({ steps: [step(m.PARK_STEP_NAME, 2, 'success'), step('Land the branch', 8, 'cancelled')] }), false);
  // work step completed after the admit step cancelled: never a parked job
  assert.equal(m.isParkedLandJob(parkedLand([step('Land the branch', 8, 'success')])), false);
  assert.equal(m.isParkedLandJob(parkedLand([step('Release the landing mutex', 8, 'failure')])), false);
});

test('decideLandRetry resumes a parked job (its set-up-job step succeeded, so a plain eviction rule would refuse it)', () => {
  const jobs = [checksOk, parkedLand()];
  const d = decideLandRetry({ run: runOf(), jobs, branchExists: true, branchTip: 'abc' });
  assert.equal(d.retry, true);
  assert.equal(d.parked, true);
  assert.equal(d.reason, 'land-parked-behind-deep-queue');
  // the same steps without the admit marker is a Land job cancelled mid-flight: refused
  const midFlight = { name: 'Land', conclusion: 'cancelled', steps: [step('Set up job', 1, 'success'), step('Land the branch', 8, 'success')] };
  assert.equal(decideLandRetry({ run: runOf(), jobs: [checksOk, midFlight], branchExists: true, branchTip: 'abc' }).reason, 'land-started-work');
});

test('a parked job gets the parked attempt budget; an eviction keeps the old one', () => {
  const at = (n, land) => decideLandRetry({ run: runOf({ run_attempt: n }), jobs: [checksOk, land], branchExists: true, branchTip: 'abc' });
  assert.equal(at(6, parkedLand()).retry, true);
  assert.equal(at(m.PARKED_MAX_ATTEMPTS - 1, parkedLand()).retry, true);
  assert.equal(at(m.PARKED_MAX_ATTEMPTS, parkedLand()).reason, 'attempts-exhausted');
  assert.equal(at(6, evictedLand()).reason, 'attempts-exhausted');
});

test('the stranded pass leaves a parked run to the sweep instead of escalating it as cancelled mid-flight', () => {
  const now = NOW;
  const base = { tip: 'abc', latestRun: runOf({ run_attempt: 8 }), jobs: [checksOk, parkedLand()], now };
  assert.deepEqual(decideStrandedRef(base), { action: 'none', reason: 'fast-retry-owns' });
  // an eviction at the same attempt is already past the fast window
  assert.notEqual(decideStrandedRef({ ...base, jobs: [checksOk, evictedLand()] }).reason, 'fast-retry-owns');
  assert.equal(decideStrandedRef({ ...base, latestRun: runOf({ run_attempt: m.PARKED_MAX_ATTEMPTS }) }).reason !== 'fast-retry-owns', true);
});

test('the sweep prefilter keeps a parked run past the eviction budget', () => {
  const refs = new Map([['land/bro-1', 'abc']]);
  const d = decideSweep({ cancelledRuns: [runOf({ run_attempt: 9 })], refs, now: NOW });
  assert.equal(d.action, 'inspect');
  assert.equal(decideSweep({ cancelledRuns: [runOf({ run_attempt: m.PARKED_MAX_ATTEMPTS })], refs, now: NOW }).action, 'idle');
});

test('the parked budget stays below the stranded pass budget so ownership never has a gap', () => {
  const { STRANDED_MAX_ATTEMPT } = require('./land-stranded-refs.js');
  assert.ok(m.PARKED_MAX_ATTEMPTS < STRANDED_MAX_ATTEMPT);
  assert.ok(m.PARKED_MAX_ATTEMPTS > require('./land-retry-on-cancel.js').MAX_ATTEMPTS);
});

test('liveTicketCount ignores leaked tickets; parkDepth reads the repo variable', () => {
  const fresh = T('1', { at: NOW - 60000 });
  const leaked = T('2', { at: NOW - m.PARK_TICKET_MAX_AGE_MS - 1000 });
  assert.equal(m.liveTicketCount([fresh, leaked], NOW), 1);
  assert.equal(m.parkDepth({}), m.PARK_DEPTH);
  assert.equal(m.parkDepth({ LAND_MUTEX_PARK_DEPTH: '' }), m.PARK_DEPTH);
  assert.equal(m.parkDepth({ LAND_MUTEX_PARK_DEPTH: '7' }), 7);
  assert.equal(m.parkDepth({ LAND_MUTEX_PARK_DEPTH: '0' }), 0);
  assert.equal(m.parkDepth({ LAND_MUTEX_PARK_DEPTH: 'abc' }), m.PARK_DEPTH);
  assert.equal(m.parkDepth({ LAND_MUTEX_DISABLED: 'true', LAND_MUTEX_PARK_DEPTH: '7' }), 0);
});

test('resumeHeadroom reads the repo variable; resumeSlots fills room, capped, counting unticketed resumes (BRO-6015)', () => {
  assert.equal(m.resumeHeadroom({}), m.RESUME_HEADROOM);
  assert.equal(m.resumeHeadroom({ LAND_MUTEX_RESUME_HEADROOM: '' }), m.RESUME_HEADROOM);
  assert.equal(m.resumeHeadroom({ LAND_MUTEX_RESUME_HEADROOM: '3' }), 3);
  assert.equal(m.resumeHeadroom({ LAND_MUTEX_RESUME_HEADROOM: '0' }), 0);
  assert.equal(m.resumeHeadroom({ LAND_MUTEX_RESUME_HEADROOM: '-1' }), m.RESUME_HEADROOM);
  const q = (n) => Array.from({ length: n }, (_, i) => T(String(100 + i)));
  const slots = (o) => m.resumeSlots({ cap: 4, headroom: 2, now: NOW, ...o });
  assert.equal(slots({ tickets: q(0) }), 2, 'empty queue: at most headroom per sweep');
  assert.equal(slots({ tickets: q(4) }), 2, 'queue at the fresh-push cap still has resume room');
  assert.equal(slots({ tickets: q(5) }), 1);
  assert.equal(slots({ tickets: q(6) }), 0);
  assert.equal(slots({ tickets: q(9) }), 0, 'never negative');
  // A resumed run in flight with no ticket yet takes a slot; a ticketed one is counted once.
  assert.equal(slots({ tickets: q(4), inflightResumedRunIds: ['900'] }), 1);
  assert.equal(slots({ tickets: q(4), inflightResumedRunIds: ['900', 901] }), 0);
  assert.equal(slots({ tickets: q(4), inflightResumedRunIds: ['100', '101'] }), 2, 'already ticketed: not double-counted');
  // A second sweep right after the first resumed 2 sees them in flight and resumes nothing.
  assert.equal(slots({ tickets: q(3), inflightResumedRunIds: ['900', '901'] }), 1);
  assert.equal(slots({ tickets: q(4), inflightResumedRunIds: ['900', '901'] }), 0);
  const leaked = T('7', { at: NOW - m.PARK_TICKET_MAX_AGE_MS - 1000 });
  assert.equal(slots({ tickets: [...q(4), leaked] }), 2, 'leaked tickets do not count');
  assert.equal(slots({ tickets: null }), 1, 'unreadable queue: old one-per-sweep');
  assert.equal(slots({ tickets: q(9), cap: 0 }), 1, 'parking off: old one-per-sweep');
  // Headroom 0 is the rollback: one per sweep while below the cap, never stuck at 0.
  assert.equal(slots({ tickets: q(0), headroom: 0 }), 1);
  assert.equal(slots({ tickets: q(3), headroom: 0 }), 1);
  assert.equal(slots({ tickets: q(4), headroom: 0 }), 0);
});

test('land.yml admit step uses the same resume headroom default and variable as land-mutex.js (BRO-6015)', () => {
  const read = (f) => readFileSync(new URL(`../../.github/workflows/${f}`, import.meta.url), 'utf8');
  const land = read('land.yml');
  const admit = land.slice(land.indexOf(`- name: ${m.PARK_STEP_NAME}`));
  const body = admit.slice(0, admit.indexOf('- name: Checkout main'));
  assert.ok(body.includes('LAND_MUTEX_RESUME_HEADROOM: ${{ vars.LAND_MUTEX_RESUME_HEADROOM }}'));
  assert.ok(body.includes(`headroom="\${LAND_MUTEX_RESUME_HEADROOM:-${m.RESUME_HEADROOM}}"`), 'bash default matches RESUME_HEADROOM');
  assert.match(body, /GITHUB_RUN_ATTEMPT:-1\}" -gt 1 \]; then limit=\$\(\( cap \+ headroom \)\)/);
});

// Review P1 (2026-10-13): the sweep read parkDepth() without the repo variables,
// so a non-default depth made admit and sweep disagree and re-park in a loop.
test('the sweep step gets the same park-depth variables as the admit step', () => {
  const read = (f) => readFileSync(new URL(`../../.github/workflows/${f}`, import.meta.url), 'utf8');
  const land = read('land.yml');
  const sweep = read('land-retry-cancelled.yml');
  for (const v of ['LAND_MUTEX_PARK_DEPTH', 'LAND_MUTEX_DISABLED', 'LAND_MUTEX_RESUME_HEADROOM']) {
    const line = `${v}: \${{ vars.${v} }}`;
    assert.ok(land.includes(line), `land.yml passes ${v}`);
    const step = sweep.slice(sweep.indexOf('- name: Sweep for a stranded Land run'));
    assert.ok(step.slice(0, step.indexOf('run:')).includes(line), `sweep step passes ${v}`);
  }
});

test('the client-side cancel budget covers a parked run (no false REFUSED while the server still resumes it)', () => {
  const lb = require('./land-branch.js');
  assert.ok(lb.MAX_CANCEL_RETRIES === undefined || lb.MAX_CANCEL_RETRIES >= m.PARKED_MAX_ATTEMPTS - 1);
  const d = lb.decideCancelledLandRetry({ landConclusion: 'cancelled', checksConclusion: 'success', remoteTip: 'a', tip: 'a', retriesUsed: m.PARKED_MAX_ATTEMPTS - 2 });
  assert.equal(d.retry, true);
});

// ---- BRO-6291: cancelled during the landing-mutex wait ----
// Steps of job 121404859310 (run 40258680877 attempt 2, 2026-10-26), as the
// jobs API returned them: setup and the always() cleanup steps succeeded,
// "Wait for the landing mutex" was cancelled, "Land the branch" never ran.
const mutexCancelledLand = (landConclusion = 'skipped') => ({
  name: 'Land',
  conclusion: 'cancelled',
  steps: [
    ['Set up job', 'success'], [m.PARK_STEP_NAME, 'success'], ['Checkout main', 'success'], ['Configure git', 'success'],
    ['Setup Node.js', 'success'], ['Install dependencies', 'success'], ['Checkout core data', 'success'],
    ['Generate gitignored manifests', 'success'], ['Wait for the landing mutex', landConclusion === 'skipped' ? 'cancelled' : 'success'],
    ['Form the merge train', landConclusion === 'skipped' ? 'skipped' : 'success'], ['Seed the tsc stamp from the checks job', 'skipped'],
    [m.LAND_STEP_NAME, landConclusion], ["Mark the train's riders landed", 'skipped'], ['Verify ancestry, then delete the land/** ref', 'skipped'],
    ['Alert — landing refused', 'skipped'], ['Commit alert-router ledger changes', 'success'], ['Release the landing mutex', 'success'],
    ['Request a production deploy', 'skipped'], ['Fail the job on a refused landing', 'skipped'], ['Notify on failure', 'skipped'],
    ['Post Setup Node.js', 'skipped'], ['Post Checkout main', 'success'], ['Complete job', 'success'],
  ].map(([name, conclusion], i) => step(name, i + 1, conclusion)),
});

test('landWorkStarted: anchored on the Land the branch step', () => {
  assert.equal(m.landWorkStarted(mutexCancelledLand()), false);
  // cancelled while land.js ran: it may have pushed, so it counts as started
  assert.equal(m.landWorkStarted(mutexCancelledLand('cancelled')), true);
  assert.equal(m.landWorkStarted(mutexCancelledLand('success')), true);
  assert.equal(m.landWorkStarted(mutexCancelledLand('failure')), true);
  assert.equal(m.landWorkStarted({ steps: [step(m.LAND_STEP_NAME, 12, null)].map((s) => ({ ...s, status: 'in_progress' })) }), true);
  // unknown job shape (no Land the branch step): the old any-step rule stays
  assert.equal(m.landWorkStarted({ steps: [step('Set up job', 1, 'success'), step('x', 2, 'cancelled')] }), true);
  assert.equal(m.landWorkStarted({ steps: [step('x', 1, 'cancelled')] }), false);
  assert.equal(m.landWorkStarted(evictedLand()), false);
  assert.equal(m.landWorkStarted(null), false);
});

test('decideLandRetry: a Land job cancelled at the mutex wait, Land the branch skipped, is RETRY', () => {
  const d = decideLandRetry({ run: runOf({ run_attempt: 2 }), jobs: [checksOk, mutexCancelledLand()], branchExists: true, branchTip: 'abc' });
  assert.equal(d.retry, true);
  assert.equal(d.reason, 'land-cancelled-before-landing');
  assert.equal(d.parked, undefined);
  // the same run cancelled while Land the branch ran is never replayed
  assert.equal(decideLandRetry({ run: runOf({ run_attempt: 2 }), jobs: [checksOk, mutexCancelledLand('cancelled')], branchExists: true, branchTip: 'abc' }).reason, 'land-started-work');
  // eviction budget, not the parked one
  assert.equal(decideLandRetry({ run: runOf({ run_attempt: 6 }), jobs: [checksOk, mutexCancelledLand()], branchExists: true, branchTip: 'abc' }).reason, 'attempts-exhausted');
  // a plain queue eviction keeps its reason
  assert.equal(decideLandRetry({ run: runOf(), jobs: [checksOk, evictedLand()], branchExists: true, branchTip: 'abc' }).reason, 'land-cancelled-while-queued');
});

test('decideStrandedRef: a mutex-wait cancel is not escalated as mid-flight; a cancel inside Land the branch is', () => {
  const base = { tip: 'abc', latestRun: runOf({ run_attempt: 2 }), now: NOW };
  assert.notEqual(decideStrandedRef({ ...base, jobs: [checksOk, mutexCancelledLand()] }).reason, 'land-cancelled-mid-flight');
  assert.deepEqual(decideStrandedRef({ ...base, jobs: [checksOk, mutexCancelledLand('cancelled')] }), { action: 'escalate', reason: 'land-cancelled-mid-flight' });
});

test('LAND_STEP_NAME is the land.js step in land.yml (a rename must break this test, not the anchor)', () => {
  const land = readFileSync(new URL('../../.github/workflows/land.yml', import.meta.url), 'utf8');
  // Exact name to end of line, and land.js inside this step (no later `- name:` in between).
  const re = new RegExp(`\\n\\s*- name: ${m.LAND_STEP_NAME}\\n(?:(?!\\s*- name:)[^\\n]*\\n){0,60}?[^\\n]*node scripts/land\\.js`);
  assert.match(land, re);
});

test('a Land job that ran to its deadline is not auto-retried (GitHub reports a timeout as cancelled)', () => {
  const land = readFileSync(new URL('../../.github/workflows/land.yml', import.meta.url), 'utf8');
  const { LAND_JOB_TIMEOUT_MINUTES } = require('./land-retry-on-cancel.js');
  assert.match(land, new RegExp(`\\n  land:\\n(?:(?!\\n  \\w)[\\s\\S])*?timeout-minutes: ${LAND_JOB_TIMEOUT_MINUTES}\\n`));
  const runOf = (o = {}) => ({ conclusion: 'cancelled', head_branch: 'land/x', head_sha: 'abc', run_attempt: 1, ...o });
  const checksOk = { name: 'Checks', conclusion: 'success' };
  const timed = (min) => ({ ...mutexCancelledLand(), started_at: '2026-10-26T03:00:00Z', completed_at: new Date(Date.parse('2026-10-26T03:00:00Z') + min * 60000).toISOString() });
  assert.equal(decideLandRetry({ run: runOf(), jobs: [checksOk, timed(124)], branchExists: true, branchTip: 'abc' }).reason, 'land-timed-out');
  assert.equal(decideLandRetry({ run: runOf(), jobs: [checksOk, timed(40)], branchExists: true, branchTip: 'abc' }).reason, 'land-cancelled-before-landing');
});
