// BRO-2226 acceptance test: "Bright Data is over its $2.50/day alarm line on
// 17 of 17 recorded days, nobody owns it." Locks in the two decisions this
// card's investigation reached, both via the real exported functions (never
// re-implemented logic — CLAUDE.md rule 15):
//
// 1. FIXED: scripts/lib/autonomous-data-verify.js's Tier-2 verifier for the
//    'missing-show' data-card class was running
//    `validate-show-venue.js --all-provisional --fail-on-mismatch` on EVERY
//    single missing-show card attempt — re-validating all ~40 provisional
//    shows in shows.json against Playbill each time instead of just the ONE
//    show that specific card added. data/audit/scraper-spend-ledger.jsonl
//    confirmed this made validate-show-venue.js the #1 or #2 Bright Data
//    caller on every day visible in the ledger (188-825 req/day). Fixed by
//    deriving the added show id(s) from the diff itself
//    (showIdsFromShowsJsonDiff in autonomous-data-workdir.js) and targeting
//    `--show=<addedId>` per added show — same Playbill cross-check, applied
//    to the one show that changed instead of the whole provisional backlog.
//
// 2. NOT CHANGED: scripts/config/provider-spend-thresholds.json's
//    brightdataDailyUsd stays at 2.5. The fix above doesn't close the gap on
//    its own (BD volume is still several thousand req/day across other
//    legitimate callers) — see that file's _comment for the full reasoning.
//    This is an owner-policy call per check-provider-spend.js's own
//    decisionPrompt, not something a dispatched session should silently
//    3x. The test below locks the number (so a future session doesn't
//    quietly "fix the alarm" by raising it) and requires the _comment to
//    keep citing BRO-2226's reasoning.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { showIdsFromShowsJsonDiff } = require('../lib/autonomous-data-workdir.js');
const { verifierArgvFor } = require('../lib/autonomous-data-verify.js');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// Same throwaway bare-origin + clone fixture shape as
// autonomous-data-workdir.test.mjs — never touches the real private repo.
function makeFixtureRepo(seedShowsJson) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-2226-fixture-'));
  const bare = path.join(tmp, 'origin.git');
  const clone = path.join(tmp, 'clone');
  git(tmp, ['init', '--bare', '-b', 'main', bare]);
  git(tmp, ['clone', bare, clone]);
  git(clone, ['config', 'user.email', 'test@example.com']);
  git(clone, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(clone, 'shows.json'), JSON.stringify(seedShowsJson));
  git(clone, ['add', '-A']);
  git(clone, ['commit', '-q', '-m', 'seed']);
  git(clone, ['push', 'origin', 'main']);
  return { tmp, clone };
}

test('showIdsFromShowsJsonDiff: identifies exactly the show(s) added since origin/main, not pre-existing ones', () => {
  const { clone } = makeFixtureRepo([
    { id: 'hamilton-2015', title: 'Hamilton' },
    { id: 'wicked-2003', title: 'Wicked' },
  ]);
  // Simulate the implementer's commit on the branch worktree: adds one show,
  // leaves the other two untouched (the missing-show rule: "add exactly one
  // new show entry — never edit an existing one").
  fs.writeFileSync(path.join(clone, 'shows.json'), JSON.stringify([
    { id: 'hamilton-2015', title: 'Hamilton' },
    { id: 'wicked-2003', title: 'Wicked' },
    { id: 'new-show-off-broadway-2026', title: 'New Show' },
  ]));
  git(clone, ['add', '-A']);
  git(clone, ['commit', '-q', '-m', 'auto: add new-show-off-broadway-2026']);

  assert.deepEqual(showIdsFromShowsJsonDiff(clone), ['new-show-off-broadway-2026']);
});

test('showIdsFromShowsJsonDiff: handles the real private-repo shape ({shows: [...]}, not a bare array)', () => {
  const { clone } = makeFixtureRepo({ _meta: { updatedAt: '2026-01-01' }, shows: [{ id: 'hamilton-2015' }] });
  fs.writeFileSync(path.join(clone, 'shows.json'), JSON.stringify({
    _meta: { updatedAt: '2026-01-01' },
    shows: [{ id: 'hamilton-2015' }, { id: 'new-show-off-broadway-2026' }],
  }));
  git(clone, ['add', '-A']);
  git(clone, ['commit', '-q', '-m', 'auto: add new-show-off-broadway-2026']);
  assert.deepEqual(showIdsFromShowsJsonDiff(clone), ['new-show-off-broadway-2026']);
});

test('showIdsFromShowsJsonDiff: origin/main has no shows.json (e.g. unfetched ref) widens to every current id — documented, not silently changed', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-2226-noorigin-'));
  const clone = path.join(tmp, 'clone');
  git(tmp, ['init', '-b', 'main', clone]);
  git(clone, ['config', 'user.email', 'test@example.com']);
  git(clone, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(clone, 'shows.json'), JSON.stringify([{ id: 'hamilton-2015' }]));
  git(clone, ['add', '-A']);
  git(clone, ['commit', '-q', '-m', 'no origin remote at all']);
  // No 'origin' remote configured — `git show origin/main:shows.json` fails,
  // so `before` stays empty and every current id reads as "added". This is
  // the correct degrade-safe direction for the real caller (a genuinely
  // fresh/unfetched worktree is not the missing-show steady state), but it's
  // worth locking in explicitly so a future change to the failure branch is
  // a deliberate decision, not a silent behavior shift.
  assert.deepEqual(showIdsFromShowsJsonDiff(clone), ['hamilton-2015']);
});

test('showIdsFromShowsJsonDiff: no diff from origin/main yields no ids (empty-diff path is handled upstream, not here)', () => {
  const { clone } = makeFixtureRepo([{ id: 'hamilton-2015', title: 'Hamilton' }]);
  assert.deepEqual(showIdsFromShowsJsonDiff(clone), []);
});

test('showIdsFromShowsJsonDiff: unreadable/malformed shows.json degrades to empty ids, not a throw', () => {
  const { clone } = makeFixtureRepo([{ id: 'hamilton-2015', title: 'Hamilton' }]);
  fs.writeFileSync(path.join(clone, 'shows.json'), '{not valid json');
  git(clone, ['add', '-A']);
  git(clone, ['commit', '-q', '-m', 'corrupt']);
  assert.deepEqual(showIdsFromShowsJsonDiff(clone), []);
});

test('BRO-2226 fix: verifierArgvFor(missing-show) targets --show=<addedId> instead of re-scanning the whole provisional backlog', () => {
  const checks = verifierArgvFor('missing-show', { dataDir: '/tmp/scratch/data', showIds: ['new-show-off-broadway-2026'] });
  assert.equal(checks.length, 1);
  assert.match(checks[0].name, /--show=new-show-off-broadway-2026/);
  const argv = checks[0].argv;
  assert.ok(argv.some((a) => a.includes('validate-show-venue.js')));
  assert.ok(argv.includes('--show=new-show-off-broadway-2026'));
  assert.ok(argv.includes('--fail-on-mismatch'));
  assert.ok(argv.includes('--data-dir=/tmp/scratch/data'));
  // The whole point of the fix: must NOT fall back to scanning every
  // provisional show for a diff where the added show is known.
  assert.ok(!argv.includes('--all-provisional'));
});

test('BRO-2226 fix: multiple added showIds each get their own --show= verifier call', () => {
  const checks = verifierArgvFor('missing-show', { dataDir: '/tmp/x', showIds: ['show-a-2026', 'show-b-2026'] });
  assert.equal(checks.length, 2);
  assert.ok(checks[0].argv.includes('--show=show-a-2026'));
  assert.ok(checks[1].argv.includes('--show=show-b-2026'));
});

test('safety net preserved: zero resolvable showIds falls back to --all-provisional rather than skipping validation', () => {
  const checks = verifierArgvFor('missing-show', { dataDir: '/tmp/scratch/data', showIds: [] });
  assert.equal(checks.length, 1);
  assert.ok(checks[0].argv.includes('--all-provisional'));
  assert.ok(checks[0].argv.includes('--fail-on-mismatch'));
  assert.ok(checks[0].argv.includes('--data-dir=/tmp/scratch/data'));
});

test('BRO-2226 decision: brightdataDailyUsd threshold is NOT silently raised — genuine overspend, not a stale alarm line', () => {
  const thresholdsPath = path.join(REPO, 'scripts', 'config', 'provider-spend-thresholds.json');
  const thresholds = JSON.parse(fs.readFileSync(thresholdsPath, 'utf8'));
  // Locks the owner-approved 2026-07-30 number. A future session that wants
  // to change this must update BOTH the number and the _comment reasoning
  // below — not just silently 3x it to make the daily alarm stop firing.
  assert.equal(thresholds.brightdataDailyUsd, 2.5);
  assert.match(thresholds._comment, /BRO-2226/);
  assert.match(thresholds._comment, /owner/i);
});
