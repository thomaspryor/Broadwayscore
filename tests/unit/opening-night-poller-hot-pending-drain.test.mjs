/**
 * BRO-7004: Parcel from America's TheaterMania review was found at 02:12Z but had no byline, so it
 * was routed to _pending/ and only drained by the NEXT poller run (~60 min later): first-live missed
 * the 30 min bar. poll_one must drain a press-night show's pending stubs right after polling it and
 * before counting new files, so the promotion counts as a hot find and ends the loop early.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const wf = fs.readFileSync(new URL('../../.github/workflows/opening-night-poller.yml', import.meta.url), 'utf8');

test('poll_one drains the hot show pending stubs before HOT_AFTER is counted', () => {
  const start = wf.indexOf('poll_one() {');
  assert.ok(start > 0, 'poll_one present');
  const body = wf.slice(start, wf.indexOf('LAST_POLL[$SHOW_ID]=$SECONDS', start));
  const drain = body.indexOf('replay-pending-bylines.js --shows="$SHOW_ID"');
  const after = body.indexOf('HOT_AFTER=$(');
  const before = body.indexOf('HOT_BEFORE=$(');
  const created = body.indexOf('CREATED=$(');
  assert.ok(drain > 0, 'per-show drain present');
  assert.ok(before > 0 && before < drain && drain < created && drain < after, 'HOT_BEFORE read before the poll, drain before the new-file counts and HOT_AFTER');
  assert.equal(body.indexOf('replay-pending-bylines.js', drain + 10), -1, 'one drain only');
  assert.match(body.slice(drain - 90, drain), /BD_OPENING_NIGHT=1/);
  assert.match(body.slice(drain, drain + 160), /--skip-empty-body-retry/, 'retry phase must not eat the drain budget');
});

/**
 * BRO-7033 (The Verge, 2026-11-05): a targeted run (show_id input) never wrote `window=` in the
 * Find step, so WINDOW_SHOWS was empty and the drain above never ran for the run that owns a
 * press-night show (BRO-7117). TheaterMania's no-byline stub waited ~50 min for the next run.
 */
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const budgetPath = new URL('../../scripts/lib/poller-loop-budget.js', import.meta.url).pathname;
const { windowShowIds } = require(budgetPath);
const verge = { id: 'the-verge-off-broadway-2026', category: 'off-broadway', openingDate: '2026-11-05', status: 'open' };
const old = { id: 'old-show-2024', category: 'broadway', openingDate: '2024-03-01', status: 'open' };

test('windowShowIds: an Off-Broadway show is in its press-night window when TheaterMania was found', () => {
  assert.deepEqual(windowShowIds([verge.id], [verge, old], new Date('2026-11-06T03:42:00Z')), [verge.id]);
  assert.deepEqual(windowShowIds([verge.id, old.id], [verge, old], new Date('2026-11-06T03:42:00Z')), [verge.id]);
  assert.deepEqual(windowShowIds([verge.id], [verge], new Date('2026-11-05T12:00:00Z')), [], 'before the window');
  assert.deepEqual(windowShowIds([verge.id], [verge], new Date('2026-11-08T12:00:00Z')), [], 'after the window');
  assert.deepEqual(windowShowIds(['not-a-show'], [verge], new Date('2026-11-06T03:42:00Z')), []);
});

test('window CLI prints the in-window ids and fails open to an empty line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7033-'));
  const shows = path.join(dir, 'shows.json');
  fs.writeFileSync(shows, JSON.stringify({ shows: [verge, old] }));
  const run = (...a) => execFileSync('node', [budgetPath, 'window', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  assert.equal(run(verge.id, shows, '2026-11-06T03:42:00Z'), verge.id);
  assert.equal(run(verge.id, shows, '2026-11-08T12:00:00Z'), '');
  assert.equal(run(verge.id, path.join(dir, 'missing.json')), '', 'unreadable shows.json -> empty, exit 0');
  assert.equal(run(verge.id, shows, 'not-a-date'), '', 'bad now -> empty, exit 0');
});

test('targeted Find branch emits window= from the poller-loop-budget window CLI', () => {
  const find = wf.indexOf('if [ -n "$INPUT_SHOW" ]; then');
  assert.ok(find > 0, 'targeted branch present');
  const branch = wf.slice(find, wf.indexOf('else', find));
  const cli = branch.indexOf(['node scripts/lib/poller-loop-budget.js window "$INPUT_SHOW" data', 'shows.json'].join('/'));
  assert.ok(cli > 0, 'targeted branch computes the press-night window');
  assert.match(branch.slice(cli), /echo "window=\$WINDOW" >> \$GITHUB_OUTPUT/, 'and writes it as the window output');
  assert.match(wf, /WINDOW_SHOWS="\$\{\{ steps\.find\.outputs\.window \}\}"/, 'poll loop reads that output');
});
