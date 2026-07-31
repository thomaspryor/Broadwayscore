import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { launchDecision, activeWindows, LAUNCH_INFLIGHT_GRACE_SEC } from '../../scripts/lib/opening-night-windows.js';

// Card #650: the launcher previously opened a cmux workspace to run the
// monitor — cmux refuses connections from launchd-parented process ancestry
// ("Access denied — only processes started inside cmux can connect" /
// broken-pipe on list-workspaces/new-workspace), which is why the launcher
// launched a session 0/344 times. The fix runs the monitor headless via
// scripts/lib/opening-night-monitor.js (a thin wrapper around the shared
// scripts/lib/claude-cli.js primitive already used by autonomous-run.js and
// bsc-runner.js under this exact launchd ancestry) and never touches cmux at
// all. This is a structural regression guard — it fails if the launcher ever
// re-imports the ancestry-sensitive cmux path, not just if it's called.
test('launcher never imports the cmux launch/workspace modules', () => {
  const src = readFileSync(new URL('../../scripts/opening-night-monitor-launch.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /require\(['"]\.\/lib\/cmux-launch\.js['"]\)/, 'launcher must not require cmux-launch.js — that is the ancestry-sensitive path card #650 removed');
  assert.doesNotMatch(src, /require\(['"]\.\/lib\/cmux-workspaces\.js['"]\)/, 'launcher must not require cmux-workspaces.js — no cmux workspace exists to probe in the headless design');
  assert.match(src, /require\(['"]\.\/lib\/opening-night-monitor\.js['"]\)/, 'launcher must run the pass through the headless wrapper');
});

// Adversarial ship-check finding (2026-07-30): a lock that needs reclaiming
// means the PREVIOUS pass's node process died mid-flight (SIGKILL/OOM/sleep)
// before it ever reached its own success/failure write. Without counting
// that as a failure, a string of process-level crashes could reclaim forever
// (every ~90 min, HEARTBEAT_STALE_MIN) without ever reaching
// MAX_ATTEMPTS_PER_NIGHT and paging the owner — the exact silent-forever
// failure mode this regression guard exists to catch.
test('reclaim-and-launch counts the abandoned attempt as a consecutive failure', () => {
  const src = readFileSync(new URL('../../scripts/opening-night-monitor-launch.js', import.meta.url), 'utf8');
  const reclaimBlock = src.slice(src.indexOf("if (decision.action === 'reclaim-and-launch') {"));
  const nextBlockEnd = reclaimBlock.indexOf('\n  }\n');
  const block = reclaimBlock.slice(0, nextBlockEnd);
  assert.match(block, /consecutiveFailures:\s*\(nightState\.consecutiveFailures\s*\|\|\s*0\)\s*\+\s*1/, 'reclaim-and-launch must increment consecutiveFailures for the abandoned attempt');
  assert.match(block, /writeNightState\(key,\s*nightState\)/, 'the incremented consecutiveFailures must be persisted before the new attempt proceeds');
});

// Adversarial ship-check finding (2026-07-30, independent Claude review): the
// cmux-era design's ONLY total-spend cap was MAX_ATTEMPTS_PER_NIGHT (3 raw
// launches, regardless of success) — an "external brake" its own comment in
// opening-night-windows.js calls out because the session can't be trusted to
// self-police $. Card #650's redesign passes consecutiveFailures (which
// resets to 0 on every success) as attemptsTonight, so a mostly-successful
// night has NO cap at all — up to ~90 opus passes across the ~31h window.
// This guard fails if the launcher's own external $ brake is ever removed.
test('a nightly USD spend cap overrides launch/reclaim-and-launch independently of launchDecision', () => {
  const src = readFileSync(new URL('../../scripts/opening-night-monitor-launch.js', import.meta.url), 'utf8');
  assert.match(src, /const NIGHTLY_USD_CAP\s*=\s*\d/, 'expected a NIGHTLY_USD_CAP constant — the external spend brake');
  const overrideBlock = src.slice(src.indexOf('let decision = launchDecision(state);'), src.indexOf("if (opts['dry-run'])"));
  assert.match(overrideBlock, /decision\.action === 'launch' \|\| decision\.action === 'reclaim-and-launch'/, 'the spend cap must gate BOTH launch and reclaim-and-launch — either one starts a real pass');
  assert.match(overrideBlock, /nightState\.usdTonight[\s\S]{0,40}>=\s*NIGHTLY_USD_CAP/, 'must compare accumulated usdTonight against the cap');
  assert.match(overrideBlock, /action:\s*'escalate'/, 'exceeding the cap must escalate (page + stop), not silently skip');
});

test('usdTonight accumulates across passes on both the success and failure write-back paths', () => {
  const src = readFileSync(new URL('../../scripts/opening-night-monitor-launch.js', import.meta.url), 'utf8');
  const usdTonightLine = src.split('\n').find(l => l.includes('const usdTonight ='));
  assert.ok(usdTonightLine, 'expected a usdTonight accumulator computed once before both outcome branches');
  assert.match(usdTonightLine, /nightState\.usdTonight \|\| 0/, 'must add onto the running total, not overwrite it');
  assert.match(usdTonightLine, /result\.usd \|\| 0/, "must add THIS pass's spend");
  // Both writeNightState calls after the pass resolves must persist usdTonight.
  const postPassSrc = src.slice(src.indexOf('const usdTonight ='));
  const writeCallStarts = [...postPassSrc.matchAll(/writeNightState\(key,/g)];
  assert.ok(writeCallStarts.length >= 2, `expected a writeNightState call on both the failure and success paths, found ${writeCallStarts.length}`);
  for (const m of writeCallStarts) {
    const snippet = postPassSrc.slice(m.index, m.index + 250);
    assert.match(snippet, /usdTonight/, `writeNightState call must persist usdTonight: ${snippet.slice(0, 100)}...`);
  }
});

// Independently verified live: .env has ANTHROPIC_API_KEY set, and
// load-env.js (required at the top of this file for RESEND_API_KEY/
// OWNER_EMAIL, task #457) pulls the WHOLE .env into process.env — including
// that key. claude-cli.js's strippedEnv forwards ANTHROPIC_API_KEY if
// present, which would silently bill headless passes pay-per-token instead
// of the Mac's subscription OAuth login (autonomous-run.js never hits this:
// its launchd wrapper only greps a single field out of .env, never sources
// the whole file).
test('the headless pass explicitly clears ANTHROPIC_API_KEY so it bills the subscription login, not the API key', () => {
  const src = readFileSync(new URL('../../scripts/opening-night-monitor-launch.js', import.meta.url), 'utf8');
  const callStart = src.indexOf('const result = await runMonitorPass({');
  const callBlock = src.slice(callStart, src.indexOf('logFile:', callStart) + 100);
  assert.match(callBlock, /ANTHROPIC_API_KEY:\s*['"]{2}/, 'runMonitorPass must clear ANTHROPIC_API_KEY (empty string) to avoid the leaked .env key for this spawn only');
});

// monitor-v2.md instructs the IN-PASS session to send its own parity/
// escalation report via routeAlert (owner-alert-router.js), which needs
// RESEND_API_KEY/OWNER_EMAIL. strippedEnv's fixed allowlist in claude-cli.js
// does not include either, so without explicit forwarding here the report
// would silently no-op inside the spawned child on every real opening night
// — the exact failure class #457 already fixed for the launcher's own
// alerts (commit 288e31efd69), but not yet for the pass it launches.
test('the headless pass forwards RESEND_API_KEY and OWNER_EMAIL so the in-pass report email can send', () => {
  const src = readFileSync(new URL('../../scripts/opening-night-monitor-launch.js', import.meta.url), 'utf8');
  const callStart = src.indexOf('const result = await runMonitorPass({');
  const callBlock = src.slice(callStart, src.indexOf('logFile:', callStart) + 100);
  assert.match(callBlock, /RESEND_API_KEY:\s*process\.env\.RESEND_API_KEY/, 'runMonitorPass must forward RESEND_API_KEY from the launcher process into the spawned child');
  assert.match(callBlock, /OWNER_EMAIL:\s*process\.env\.OWNER_EMAIL/, 'runMonitorPass must forward OWNER_EMAIL from the launcher process into the spawned child');
});

// Card #568: LOCK_DIR is the atomic test-and-set (mkdir, before the launch
// even starts) but LOCK_META is only written AFTER launchCmuxSession()
// resolves — up to verifyTimeoutSec(90) x 2 attempts + lateAdoptSec(60) =
// ~240s later. A concurrent tick that lands inside that gap sees
// lockExists=true, metaExists=false, claudeAlive=false — the exact same
// shape as a launch that died before ever writing meta. Without a lock-age
// signal, launchDecision can't tell "still launching" from "long dead" and
// reclaims a still-in-flight session out from under it.
//
// heartbeatAgeMin is deliberately set to a large-but-realistic number here,
// not null: HEARTBEAT is a single global file a prior night's session
// already wrote and nothing deletes, so in production it is essentially
// never null — an earlier version of this fix keyed off
// heartbeatAgeMin===null and was unreachable as a result (ship-check
// finding). metaExists is the signal that actually distinguishes in-flight
// from pre-meta-dead.
test('a launch actively in flight (fresh lock, no meta.json yet) is NOT reclaimed', () => {
  const windows = activeWindows(
    [{ id: 'giant-2026', category: 'broadway', openingDate: '2026-07-30' }],
    new Date('2026-07-30T22:00:00Z'),
  );
  const d = launchDecision({
    windows, killSwitch: false, lockExists: true,
    heartbeatAgeMin: 2880, claudeAlive: false, attemptsTonight: 0,
    lockAgeSec: 10, // fresh lock — well inside the grace window
    metaExists: false,
  });
  assert.notEqual(d.action, 'reclaim-and-launch');
  assert.equal(d.action, 'skip');
});

test('a lock that outlived the grace window with no meta.json IS reclaimed', () => {
  const windows = activeWindows(
    [{ id: 'giant-2026', category: 'broadway', openingDate: '2026-07-30' }],
    new Date('2026-07-30T22:00:00Z'),
  );
  const d = launchDecision({
    windows, killSwitch: false, lockExists: true,
    heartbeatAgeMin: 2880, claudeAlive: false, attemptsTonight: 0,
    lockAgeSec: LAUNCH_INFLIGHT_GRACE_SEC + 30,
    metaExists: false,
  });
  assert.equal(d.action, 'reclaim-and-launch');
});

// Guards the launcher's own wiring: main() must actually compute and pass
// lockAgeSec + metaExists into launchDecision's state, or the grace window
// above is dead code that never fires against real ticks (same silent-
// revert risk as the claudeAlive guard above).
test('launcher state object passes lockAgeSec through to launchDecision', () => {
  const src = readFileSync(new URL('../../scripts/opening-night-monitor-launch.js', import.meta.url), 'utf8');
  const lockAgeLine = src.split('\n').find(l => l.includes('lockAgeSec:'));
  assert.ok(lockAgeLine, 'expected a `lockAgeSec:` field in the state object literal');
  assert.match(lockAgeLine, /lockAgeSec\(\)/, 'lockAgeSec must be computed from LOCK_DIR birthtime, not hardcoded/omitted');
});

test('launcher state object passes metaExists through to launchDecision', () => {
  const src = readFileSync(new URL('../../scripts/opening-night-monitor-launch.js', import.meta.url), 'utf8');
  const metaExistsLine = src.split('\n').find(l => l.includes('metaExists:'));
  assert.ok(metaExistsLine, 'expected a `metaExists:` field in the state object literal — the in-flight grace window must key off whether THIS lock instance has written meta.json, not the global (never-null-in-practice) heartbeat file');
});

// Regression guard: the in-flight check must never key off heartbeatAgeMin,
// even indirectly — that was the exact bug an earlier version of this fix
// shipped with (heartbeatAgeMin is realistically never null in production).
test('lockAgeSec is computed from birthtime, not mtime (mtime is reset by unrelated writes into the lock dir)', () => {
  const src = readFileSync(new URL('../../scripts/opening-night-monitor-launch.js', import.meta.url), 'utf8');
  const lockAgeFn = src.slice(src.indexOf('function lockAgeSec'), src.indexOf('function lockAgeSec') + 300);
  assert.match(lockAgeFn, /birthtimeMs/, 'lockAgeSec must use birthtimeMs, not mtimeMs');
});
