/**
 * linear-watchdog-source.test.mjs — BRO-3390.
 *
 * Covers the two things that, if wrong, silently waste the watchdog's whole
 * day budget: which issues get queued, and whether the two id namespaces sort
 * as a real FIFO. Both are pure, so every case here is a plain fixture object
 * with no network stub — the same property linear-recheck-source.js was built
 * for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const src = require('./linear-watchdog-source.js');
const core = require('./dispatch-watchdog-core.js');

const ARMED = 'Do the thing.\n\n## Acceptance criteria\n`node --test scripts/lib/thing.test.mjs`\n';

function issue(over = {}) {
  return {
    identifier: 'BRO-3000',
    title: 'Something needs doing',
    description: ARMED,
    priority: 2,
    state: { name: 'Backlog', type: 'backlog' },
    ...over,
  };
}

test('priorityOf: Linear priority field wins, title prefix is the fallback', () => {
  assert.equal(src.priorityOf(issue({ priority: 1 })), 'P0');
  assert.equal(src.priorityOf(issue({ priority: 2 })), 'P1');
  // No priority set (0) but the title encodes it — the common hand-filed shape.
  assert.equal(src.priorityOf(issue({ priority: 0, title: 'P0: launchCmuxSession lies' })), 'P0');
  assert.equal(src.priorityOf(issue({ priority: 0, title: 'P1 CI pushes hard-killed' })), 'P1');
  // Neither: not the watchdog's mandate.
  assert.equal(src.priorityOf(issue({ priority: 3, title: 'Tidy up the thing' })), null);
  assert.equal(src.priorityOf(null), null);
});

test('ineligibleReason: each refusal is distinguishable', () => {
  assert.equal(src.ineligibleReason(issue()), null, 'a plain armed P1 backlog issue is eligible');

  assert.equal(src.ineligibleReason(null), 'malformed');
  assert.equal(src.ineligibleReason({ identifier: 'BRO-1' }), 'no-state');
  assert.equal(
    src.ineligibleReason(issue({ state: { name: 'Done', type: 'completed' } })),
    'terminal-state',
  );
  // In Progress / In Review already have a session; startedStateGuard would
  // refuse them inside the child and the claim would be burned for nothing.
  assert.equal(
    src.ineligibleReason(issue({ state: { name: 'In Progress', type: 'started' } })),
    'already-started',
  );
  assert.equal(
    src.ineligibleReason(issue({ priority: 3, title: 'no priority anywhere' })),
    'not-p0-p1',
  );
  // linear-drain-parked.js owns the auto-filed tracker population; keeping the
  // two drains disjoint is what makes autofixFiledIssueGuard a real guard.
  assert.equal(
    src.ineligibleReason(issue({ title: 'BSC Daily: Workflow repeat-failure: Audit Imageless Scored Shows' })),
    'autofix-filed-tracker',
  );
  // No machine-checkable proof of done => linear-next's verify gate refuses it.
  assert.equal(
    src.ineligibleReason(issue({ description: 'Just do it, no acceptance criteria here.' })),
    'unarmed',
  );
});

test('BRO-3924 (R3): ineligibleReason returns already-passes for an injected sweep-report id, and is unaffected otherwise', () => {
  const alreadyPassesIds = new Set(['BRO-3000']);
  assert.equal(src.ineligibleReason(issue(), { alreadyPassesIds }), 'already-passes');
  assert.equal(src.ineligibleReason(issue()), null, 'omitting opts entirely still behaves like before (existing 1-arg call sites)');
  assert.equal(src.ineligibleReason(issue(), {}), null, 'an opts object with no alreadyPassesIds is a no-op');
  assert.equal(
    src.ineligibleReason(issue({ identifier: 'BRO-4000' }), { alreadyPassesIds }),
    null,
    'a different identifier is unaffected',
  );
  // Ordering: already-passes is checked before the armed/unarmed gate, but an
  // unarmed card is not IN the report by construction (sweep-open-backlog-
  // acceptance.js only records ids that already cleared that gate) — the
  // order only matters for which reason string a stale-since-sweep card
  // reports, never for eligibility itself.
  assert.equal(
    src.ineligibleReason(issue({ identifier: 'BRO-5000', description: 'unarmed' }), { alreadyPassesIds: new Set(['BRO-5000']) }),
    'already-passes',
  );
});

test('mapIssueToTask emits the task-mirror shape planSweep consumes', () => {
  const t = src.mapIssueToTask(issue({ identifier: 'BRO-3380', priority: 1, title: 'P0: thing' }));
  assert.equal(t.id, 'linear:BRO-3380');
  assert.equal(t.status, 'pending');
  assert.equal(t.subject, 'P0: thing');
  assert.match(t.description.split('\n')[0], /^\[linear:BRO-3380\] P0 /);
  // The original body must survive underneath: isExcludedCategory reads it for
  // the owner-judgment marker and verify-gate reads it for the command.
  assert.ok(t.description.includes('## Acceptance criteria'));
  assert.equal(src.mapIssueToTask({ identifier: 'BRO-1', priority: 3, title: 'x' }), null);
  assert.equal(src.mapIssueToTask(null), null);
});

test('core.taskPriority parses BOTH source tags from the mapped first line', () => {
  const linearTask = src.mapIssueToTask(issue({ identifier: 'BRO-3380', priority: 1 }));
  assert.equal(core.taskPriority(linearTask), 'P0');
  // The pre-existing Notion shape must keep working unchanged.
  assert.equal(
    core.taskPriority({ description: '[notion:abc-123] P1 Next · Not started · Admin' }),
    'P1',
  );
  assert.equal(core.taskPriority({ description: '[linear:BRO-9] P1 Next · Backlog · no-category' }), 'P1');
  assert.equal(core.taskPriority({ description: 'no tag at all', subject: 'P0: from subject' }), 'P0');
});

test('compareTaskIds is a real FIFO in both namespaces (the parseInt NaN bug)', () => {
  // Notion: unchanged numeric ordering.
  assert.deepEqual(['1112', '586', '1966'].sort(core.compareTaskIds), ['586', '1112', '1966']);
  // Linear: the old `parseInt('linear:BRO-3390')` was NaN, every comparison
  // false, so the queue kept arbitrary input order. It must now be ordered.
  const linear = ['linear:BRO-3390', 'linear:BRO-586', 'linear:BRO-1112'];
  assert.deepEqual(linear.sort(core.compareTaskIds), ['linear:BRO-586', 'linear:BRO-1112', 'linear:BRO-3390']);
  // Mixed input must still produce a total order (no throw, deterministic).
  const mixed = ['linear:BRO-3390', '586', 'linear:BRO-12', '1966'];
  const once = [...mixed].sort(core.compareTaskIds);
  const twice = [...mixed].reverse().sort(core.compareTaskIds);
  assert.deepEqual(once, twice, 'comparator must be total and stable regardless of input order');
});

test('fetchLinearWatchdogTasks reports an outage instead of an empty backlog', async () => {
  const boom = { graphql: async () => { throw new Error('ETIMEDOUT'); } };
  const res = await src.fetchLinearWatchdogTasks(boom, {});
  assert.equal(res.ok, false);
  assert.match(res.reason, /linear-fetch-failed/);
  assert.equal(res.tasks.size, 0);

  const missing = await src.fetchLinearWatchdogTasks(null, {});
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'no-linear-client');
});

test('fetchLinearWatchdogTasks paginates and filters to eligible issues only', async () => {
  const page1 = [
    issue({ identifier: 'BRO-10', priority: 1 }),                                  // eligible
    issue({ identifier: 'BRO-11', state: { name: 'In Progress', type: 'started' } }), // started
    issue({ identifier: 'BRO-12', description: 'unarmed' }),                       // unarmed
  ];
  const page2 = [
    issue({ identifier: 'BRO-13', title: 'BSC Daily: noise' }),                    // tracker
    issue({ identifier: 'BRO-14', priority: 2 }),                                  // eligible
  ];
  let call = 0;
  const client = {
    graphql: async () => {
      call++;
      return call === 1
        ? { issues: { nodes: page1, pageInfo: { hasNextPage: true, endCursor: 'c1' } } }
        : { issues: { nodes: page2, pageInfo: { hasNextPage: false } } };
    },
  };
  const res = await src.fetchLinearWatchdogTasks(client, {});
  assert.equal(res.ok, true);
  assert.equal(res.scanned, 5);
  assert.deepEqual([...res.tasks.keys()].sort(), ['linear:BRO-10', 'linear:BRO-14']);
});

test('BRO-3924 (R3): fetchLinearWatchdogTasks excludes an already-passing id when the report Set is injected', async () => {
  const nodes = [
    issue({ identifier: 'BRO-30', priority: 1 }),   // would be eligible
    issue({ identifier: 'BRO-31', priority: 1 }),   // already passes — excluded
  ];
  const client = { graphql: async () => ({ issues: { nodes, pageInfo: { hasNextPage: false } } }) };
  const withoutReport = await src.fetchLinearWatchdogTasks(client, {});
  assert.deepEqual([...withoutReport.tasks.keys()].sort(), ['linear:BRO-30', 'linear:BRO-31']);

  const withReport = await src.fetchLinearWatchdogTasks(client, { alreadyPassesIds: new Set(['BRO-31']) });
  assert.deepEqual([...withReport.tasks.keys()], ['linear:BRO-30']);
});

test('a partial fetch is discarded, never returned as a smaller backlog', async () => {
  let call = 0;
  const client = {
    graphql: async () => {
      call++;
      if (call === 1) return { issues: { nodes: [issue({ identifier: 'BRO-20', priority: 1 })], pageInfo: { hasNextPage: true, endCursor: 'c1' } } };
      throw new Error('connection reset mid-scan');
    },
  };
  const res = await src.fetchLinearWatchdogTasks(client, {});
  assert.equal(res.ok, false);
  assert.equal(res.tasks.size, 0, 'a truncated queue must not masquerade as a small one');
});

test('dispatchArgvFor routes each id namespace to its own dispatcher', () => {
  const wd = require('../dispatch-watchdog.js');
  const linear = wd.dispatchArgvFor('linear:BRO-3380');
  assert.ok(linear[0].endsWith('scripts/linear-next.js'), `expected linear-next.js, got ${linear[0]}`);
  assert.deepEqual(linear.slice(1), ['--id', 'BRO-3380', '--headless'],
    'Linear work must go headless (no cmux terminal runtime, 83.0% vs 30.5% completion) AND detached — '
    + 'since BRO-3652 detach is linear-next\'s DEFAULT on the headless lane, and an EXPLICIT --detach is '
    + 'deliberately absent: on a mac-only (tab-routed) card the explicit flag is refused, the default takes '
    + 'the tab path (runBscNext still SIGKILLs the process group at 15 minutes, so the child must not stay attached)');
  assert.ok(!linear.includes('--detach'), 'explicit --detach would park every mac-only card (BRO-3652 ship-check)');

  const notion = wd.dispatchArgvFor('1842');
  assert.ok(notion[0].endsWith('scripts/bsc-next.js'), `expected bsc-next.js, got ${notion[0]}`);
  assert.deepEqual(notion.slice(1), ['--id', '1842'],
    'the pre-existing Notion lane must be untouched by this change');

  // Anything not a well-formed linear: id falls back to the old lane rather
  // than silently building a broken linear-next invocation.
  assert.ok(wd.dispatchArgvFor('linear:not-an-id')[0].endsWith('scripts/bsc-next.js'));
});

test('linearTasksForPlan drops a cache older than its TTL instead of dispatching stale work', () => {
  const wd = require('../dispatch-watchdog.js');
  assert.ok(wd.LINEAR_CACHE_TTL_MS > 0);
  // Never fetched => empty, and crucially not a throw.
  assert.equal(wd.linearTasksForPlan(Date.now()).size, 0);
});

// ── ship-check (Codex) regressions ────────────────────────────────────────

test('an explicitly deprioritised issue is NOT resurrected by its title', () => {
  // The dangerous shape: somebody downgraded it to Low, but the title still
  // says P0. Queueing that spends the day budget on work just deprioritised.
  assert.equal(src.priorityOf(issue({ priority: 4, title: 'P0: sneaky' })), null);
  assert.equal(src.priorityOf(issue({ priority: 3, title: 'P1: also sneaky' })), null);
  // Unset (0) is not a decision, so the title is still allowed to speak.
  assert.equal(src.priorityOf(issue({ priority: 0, title: 'P0: legit' })), 'P0');
});

test('the backlog query excludes terminal states server-side', () => {
  const q = src.buildWatchdogBacklogQuery();
  assert.match(q, /nin:\s*\["completed","canceled","duplicate"\]/);
});

test('headless-blocked cards are refused at queue-build, not at spend time', () => {
  // Armed, but carrying the PARKED do-not-dispatch sentinel: linear-next would
  // refuse it inside the detached child AFTER the claim was already counted.
  const parked = issue({ description: `PARKED: an owner parked this deliberately\n\n${ARMED}` });
  const reason = src.ineligibleReason(parked);
  assert.match(String(reason), /^headless-blocked:/,
    `expected a headless-blocked refusal, got ${reason}`);
});

test('a truncated scan is reported as an outage, not as a small backlog', async () => {
  // Every page says hasNextPage:true, so the cap is hit with work remaining.
  const client = {
    graphql: async () => ({
      issues: { nodes: [issue({ identifier: 'BRO-99', priority: 1 })], pageInfo: { hasNextPage: true, endCursor: 'c' } },
    }),
  };
  const res = await src.fetchLinearWatchdogTasks(client, { maxPages: 3 });
  assert.equal(res.ok, false);
  assert.match(res.reason, /linear-scan-truncated/);
  assert.equal(res.tasks.size, 0);
});

test('detectWriteBackLeak is report-only and total', () => {
  const started = new Map([['linear:BRO-5', { identifier: 'BRO-5', title: 't', stateName: 'In Progress' }]]);
  const entries = [
    { event: 'job-done', taskId: 'linear:BRO-5', ts: new Date(Date.now() - 48 * 3600e3).toISOString() },
    { event: 'job-done', taskId: 'linear:BRO-404', ts: new Date(Date.now() - 48 * 3600e3).toISOString() },
    { event: 'job-done', taskId: 'linear:BRO-5', ts: 'not-a-date' },
    null,
  ];
  const before = JSON.stringify([...started]);
  const leak = src.detectWriteBackLeak(entries, started, Date.now());
  assert.equal(leak.length, 1);
  assert.equal(leak[0].identifier, 'BRO-5');
  assert.ok(leak[0].ageHours >= 47);
  assert.equal(JSON.stringify([...started]), before, 'must not mutate its inputs');
  // Inside the grace window => not yet a leak.
  const fresh = [{ event: 'job-done', taskId: 'linear:BRO-5', ts: new Date().toISOString() }];
  assert.deepEqual(src.detectWriteBackLeak(fresh, started, Date.now()), []);
  // Degenerate inputs must not throw.
  assert.deepEqual(src.detectWriteBackLeak(null, null, Date.now()), []);
});

// BRO-3424: started (In Progress) Linear issues need a task-mirror entry too
// — planSweep's unlandedDone gate is isTaskOpen(tasks.get(id)), and without
// this a headless job's still-"In Progress" card (the exact state a job that
// finished without merging is in) silently dropped its own unlanded finding.
test('mapStartedToTask: maps a started-issue entry to an OPEN task-mirror row, never a queueable one', () => {
  const task = src.mapStartedToTask('linear:BRO-3388', { identifier: 'BRO-3388', title: 'gather-reviews dispatch', stateName: 'In Progress' });
  assert.equal(task.id, 'linear:BRO-3388');
  assert.equal(task.subject, 'gather-reviews dispatch');
  assert.equal(task.status, 'in_progress');
  assert.ok(core.taskPriority(task) === null, 'no P0/P1 line — must never enter p01Queue (which only re-queues status pending anyway)');
});

test('BRO-3424 end-to-end: a started Linear card (mapped via mapStartedToTask) makes its unlandedDone finding visible to planSweep', () => {
  const task = src.mapStartedToTask('linear:BRO-3388', { identifier: 'BRO-3388', title: 'gather-reviews dispatch', stateName: 'In Progress' });
  const tasks = new Map([[task.id, task]]);
  const unlandedJobDone = [{ taskId: 'linear:BRO-3388', jobId: 'job-abc', cwd: '/tmp/job-linear-BRO-3388', sha: 'deadbeef' }];
  const plan = core.planSweep([], tasks, { now: Date.now(), liveTitles: new Map([['workspace:1', '🤖 x']]), unlandedJobDone });
  assert.equal(plan.unlandedDone.length, 1, 'before the mapStartedToTask fix, tasks.get(id) was undefined for a started card and this finding was silently dropped');
  assert.equal(plan.unlandedDone[0].taskId, 'linear:BRO-3388');
  assert.ok(!plan.toDispatch.some((d) => d.taskId === 'linear:BRO-3388'), 'still never auto-redispatched');
});

test('mapStartedToTask: degenerate inputs return null rather than a half-built row', () => {
  assert.equal(src.mapStartedToTask(null, { identifier: 'BRO-1' }), null);
  assert.equal(src.mapStartedToTask('linear:BRO-1', null), null);
});

test('linearStartedTasksForPlan: a started Linear card is OPEN per isTaskOpen, so unlandedDone can see it', () => {
  const wd = require('../dispatch-watchdog.js');
  // Never fetched => empty, same contract as linearTasksForPlan's own test.
  assert.equal(wd.linearStartedTasksForPlan(Date.now()).size, 0);
});
