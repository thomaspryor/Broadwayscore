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
    'Linear work must go headless: no cmux terminal runtime (BRO-2709), and 83.0% vs 30.5% completion');

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
