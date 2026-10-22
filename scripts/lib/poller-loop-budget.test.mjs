import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { loadWorkflow, findStep } from '../../tests/helpers/workflow-push-timeout.mjs';
const { rotateShows, showTimeoutSec } = createRequire(import.meta.url)('./poller-loop-budget.js');

test('rotateShows rotates by seed, wraps, drops empties', () => {
  assert.deepEqual(rotateShows(['a', 'b', 'c'], 0), ['a', 'b', 'c']);
  assert.deepEqual(rotateShows(['a', 'b', 'c'], 4), ['b', 'c', 'a']);
  assert.deepEqual(rotateShows(['a', '', 'b'], 1), ['b', 'a']);
  assert.deepEqual(rotateShows([], 3), []);
  // priority head is never rotated
  assert.deepEqual(rotateShows(['n1', 'n2', 'a', 'b', 'c'], 1, 2), ['n1', 'n2', 'b', 'c', 'a']);
  assert.deepEqual(rotateShows(['n1', 'n2'], 5, 8), ['n1', 'n2']);
  assert.deepEqual(rotateShows(['a', 'b'], 'x'), ['a', 'b']);
});

test('showTimeoutSec caps per show, clamps to remaining, stops when too little left', () => {
  assert.equal(showTimeoutSec(4000), 600);
  assert.equal(showTimeoutSec(300), 300);
  assert.equal(showTimeoutSec(239), 0);
  assert.equal(showTimeoutSec(240), 240);
  assert.equal(showTimeoutSec(-5), 0);
  assert.equal(showTimeoutSec(NaN), 0);
});

test('CLI matches the functions', () => {
  const run = (...a) => execFileSync('node', ['scripts/lib/poller-loop-budget.js', ...a], { encoding: 'utf8' }).trim();
  assert.equal(run('rotate', 'a,b,c', '1'), 'b,c,a');
  assert.equal(run('timeout', '300'), '300');
  assert.equal(run('timeout', '50'), '0');
  assert.equal(run('rotate', 'n,a,b,c', '1', '1'), 'n,b,c,a');
});

test('poller loop is budgeted; budget + pre-loop setup leave room for the post-poll stages inside the job timeout', () => {
  const wf = loadWorkflow('opening-night-poller.yml');
  const step = findStep(wf, 'poll', 'Run poller for each show');
  const budget = Number(step.env.POLL_LOOP_BUDGET_SEC);
  assert.ok(budget > 0, 'POLL_LOOP_BUDGET_SEC must be set');
  const jobSec = wf.jobs.poll['timeout-minutes'] * 60;
  // pre-loop (checkout, installs, drain <=8 min) ~ 20 min worst case; post-loop
  // collect 12 + score ~10 + fast_path rebuild 15 + deploy wait 9 + rest ~ 55 min.
  assert.ok(jobSec - 20 * 60 - budget >= 55 * 60, `loop budget ${budget}s leaves too little of the ${jobSec}s job`);
  assert.match(step.run, /poller-loop-budget\.js timeout/);
  assert.match(step.run, /poller-loop-budget\.js rotate/);
  assert.match(step.run, /SKIPPED_SHOWS="\$SKIPPED_SHOWS \$SHOW_ID"\n\s+continue/);
  assert.ok(Number(step.env.POLL_PRIORITY_SHOWS) > 0);
  assert.match(step.run, /KEEP_FRONT="\$POLL_PRIORITY_SHOWS"/);
  assert.match(step.run, /POLLER_RC" -eq 124/);
  // GATHER_TOTAL must only count shows actually polled: the budget check skips
  // before poll_one, which is the only place GATHER_TOTAL is incremented
  const loop = step.run.slice(step.run.indexOf('for SHOW_ID in "${SHOW_ARRAY[@]}"; do'));
  assert.ok(loop.indexOf('\n              continue') < loop.indexOf('poll_one "$SHOW_ID"'));
  const fn = step.run.slice(step.run.indexOf('poll_one() {'), step.run.indexOf('for SHOW_ID in "${SHOW_ARRAY[@]}"; do'));
  assert.match(fn, /GATHER_TOTAL=\$\(\(GATHER_TOTAL \+ 1\)\)/);
});

const { orderPollShows, pollTier } = createRequire(import.meta.url)('./poller-loop-budget.js');

// The 2026-10-21 Broadway poller list (shows.json values at the time).
const NIGHT_860 = [
  { id: 'phyl', category: 'off-broadway', status: 'previews', openingDate: '2026-10-22' },
  { id: 'imaginary-invalid', category: 'broadway', status: 'previews', openingDate: '2026-10-22' },
  { id: 'queeney-todd', category: 'off-broadway', status: 'upcoming', openingDate: '2026-10-22' },
  { id: 'benjamin-button', category: 'off-broadway', status: 'open', openingDate: '2026-10-21' },
  { id: 'billy-crystal-860', category: 'broadway', status: 'open', openingDate: '2026-10-21' },
  { id: 'jest-to-impress', category: 'off-broadway', status: 'open', openingDate: '2026-10-21' },
  { id: 'king-of-the-yees', category: 'off-broadway', status: 'open', openingDate: '2026-10-20' },
  { id: 'fish', category: 'off-broadway', status: 'open', openingDate: '2026-10-11' },
  { id: 'stuck', category: 'off-broadway', status: 'previews', openingDate: null },
];

test('orderPollShows: tonight\'s Broadway opener first, next-day openers last (9pm ET = 01:00Z next UTC day)', () => {
  const r = orderPollShows(NIGHT_860, new Date('2026-10-22T01:01:00Z'));
  assert.equal(r.order[0], 'billy-crystal-860');
  assert.deepEqual(r.hot, ['billy-crystal-860']);
  // shows dated Oct 22 have not opened in New York yet: they go after every past opener
  const firstFuture = r.order.indexOf('imaginary-invalid');
  for (const past of ['benjamin-button', 'jest-to-impress', 'king-of-the-yees', 'fish']) {
    assert.ok(r.order.indexOf(past) < firstFuture, `${past} should precede next-day openers`);
  }
  assert.equal(r.order[r.order.length - 1], 'stuck');
  assert.equal(r.front, 4); // 860, button, jest (tonight) + king (in its window, last night)
});

test('orderPollShows: the morning after, last night\'s opener still leads but is no longer hot (8h span)', () => {
  const r = orderPollShows(NIGHT_860, new Date('2026-10-22T14:00:00Z')); // 10am ET Oct 22
  assert.equal(r.order[0], 'billy-crystal-860');
  assert.deepEqual(r.hot, []);
  // still hot at 00:59 ET (04:59Z), not at 01:01 ET
  assert.deepEqual(orderPollShows(NIGHT_860, new Date('2026-10-22T04:59:00Z')).hot, ['billy-crystal-860']);
  assert.deepEqual(orderPollShows(NIGHT_860, new Date('2026-10-22T05:01:00Z')).hot, []);
  assert.equal(pollTier(NIGHT_860[1], new Date('2026-10-22T14:00:00Z')), 1);
  assert.equal(pollTier(NIGHT_860[1], new Date('2026-10-22T22:00:00Z')), 0); // 6pm ET opening night
});

test('orderPollShows: before the press-night window opens nothing is hot', () => {
  const r = orderPollShows(NIGHT_860, new Date('2026-10-21T19:00:00Z')); // 3pm ET opening day
  assert.ok(!r.hot.includes('billy-crystal-860'));
  assert.equal(pollTier(NIGHT_860[4], new Date('2026-10-21T19:00:00Z')), 1);
});

test('orderPollShows: West End uses London time; main stage before Off within a tier; hot capped at 3', () => {
  const now = new Date('2026-10-21T20:30:00Z'); // 21:30 BST
  const shows = [
    { id: 'owe', category: 'off-west-end', openingDate: '2026-10-21' },
    { id: 'we', category: 'west-end', openingDate: '2026-10-21' },
    { id: 'bw-old', category: 'broadway', openingDate: '2026-10-01' },
  ];
  const r = orderPollShows(shows, now);
  assert.deepEqual(r.order, ['we', 'owe', 'bw-old']);
  assert.deepEqual(r.hot, ['we']);
  const many = ['a', 'b', 'c', 'd'].map((id) => ({ id, category: 'broadway', openingDate: '2026-10-21' }));
  assert.equal(orderPollShows(many, new Date('2026-10-22T02:30:00Z')).hot.length, 3);
});

test('poll loop re-polls press-night shows and can end early to publish them', () => {
  const wf = loadWorkflow('opening-night-poller.yml');
  const step = findStep(wf, 'poll', 'Run poller for each show');
  assert.ok(Number(step.env.HOT_REPOLL_SEC) >= 300, 'HOT_REPOLL_SEC must be set (seconds)');
  assert.match(step.run, /HOT_SHOWS="\$\{\{ steps\.find\.outputs\.hot \}\}"/);
  assert.match(step.run, /poll_one "\$HOT_ID" "\$HOT_TIMEOUT"/);
  assert.match(step.run, /HOT_NEW" = "true" \] && \[ "\$POLLED" -ge "\$FRONT" \]/);
  assert.ok(Number(step.env.HOT_MAX_REPOLLS) >= 1, 'HOT_MAX_REPOLLS caps re-polls per run');
  assert.match(step.run, /REPOLLS\[\$HOT_ID\]:-0\}" -lt "\$HOT_MAX_REPOLLS"/);
  // front shows are never rotated out of the head
  assert.match(step.run, /poller-loop-budget\.js rotate .*"\$KEEP_FRONT"/);
  // only brand-new (untracked) files count as new press-night reviews
  assert.match(step.run, /grep -c '\^\?\?'/);
  const find = findStep(wf, 'poll', 'Find shows to poll');
  assert.match(find.run, /orderPollShows\(opened, now\)/);
  assert.match(find.run, /echo "hot=\$HOT" >> \$GITHUB_OUTPUT/);
});
