import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const core = require('../lib/dispatch-watchdog-core.js');
const { ensureAutoTitle } = require('../lib/workspace-naming.js');

const NOW = Date.parse('2026-08-06T15:00:00Z');
const T = m => new Date(NOW - m * 60000).toISOString();

function task(id, status, priLine) {
  return [String(id), {
    id: String(id), subject: `Fix thing ${id}`, status,
    description: priLine ? `[notion:abc-${id}] ${priLine} · Not started · no-category\nbody` : 'native task',
  }];
}
const titles = pairs => new Map(pairs);
const LIVE = titles([['workspace:1', '🤖⚡ Data·something'], ['workspace:99', '🤖 Site·other']]);

test('ledger-confirmed dead launch with open task is retryable', () => {
  const entries = [
    { ts: T(60), event: 'launch', taskId: '10', subject: 'Fix thing 10', workspaceRef: 'workspace:5' },
    { ts: T(30), event: 'dead', taskId: '10', workspaceRef: 'workspace:5' },
  ];
  const plan = core.planSweep(entries, new Map([task(10, 'in_progress')]), { now: NOW, liveTitles: LIVE });
  assert.equal(plan.retryable.length, 1);
  assert.equal(plan.toDispatch[0].taskId, '10');
});

test('#1154: an owner-judgment card that died is NEVER retried (retry bypasses actionable())', () => {
  // The Sarah check-in shape: launched once, session died, then re-dispatched
  // by dead-session recovery — which goes through `bsc-next --id` and so skips
  // the pick filter entirely. The P0/P1 backlog sweep alone does not cover it.
  const marked = [String(12), {
    id: '12',
    subject: 'Sarah check-in: growth plan progress and metrics report',
    status: 'in_progress',
    description: '[notion:abc-12] P2 Later · Not started · Admin\nDue 2026-05-23. Ask Sarah for status.\n\nVERIFY: owner-judgment (owner must read the report)',
  }];
  const entries = [
    { ts: T(60), event: 'launch', taskId: '12', subject: 'Sarah check-in', workspaceRef: 'workspace:7' },
    { ts: T(30), event: 'dead', taskId: '12', workspaceRef: 'workspace:7' },
  ];
  const plan = core.planSweep(entries, new Map([marked]), { now: NOW, liveTitles: LIVE });
  assert.equal(plan.retryable.length, 0, 'owner-judgment card must not be retryable');
  assert.equal(plan.toDispatch.filter(d => d.taskId === '12').length, 0, 'and must never be dispatched');

  // Control: identical ledger, identical Admin category, marker removed -> retried.
  const control = [String(12), { ...marked[1], description: marked[1].description.replace(/VERIFY:\s*owner-judgment/i, 'VERIFY: nothing') }];
  const plan2 = core.planSweep(entries, new Map([control]), { now: NOW, liveTitles: LIVE });
  assert.equal(plan2.retryable.length, 1, 'without the marker the same card IS retryable');
});

test('vanished (owner-closed) is never retried — terminal reason matters', () => {
  const entries = [
    { ts: T(60), event: 'launch', taskId: '11', subject: 's', workspaceRef: 'workspace:6' },
    { ts: T(30), event: 'vanished', taskId: '11', workspaceRef: 'workspace:6' },
    { ts: T(29), event: 'dead', taskId: '11', workspaceRef: 'workspace:6' }, // older dead exists too
  ];
  // most recent terminal is 'dead' here — reorder so vanished is last
  entries[1].ts = T(20);
  const plan = core.planSweep(entries, new Map([task(11, 'in_progress')]), { now: NOW, liveTitles: LIVE });
  assert.equal(plan.retryable.length, 0);
  assert.equal(plan.toPark.length, 0);
});

test('completed task is landed — not in flight, not retried', () => {
  const entries = [{ ts: T(60), event: 'launch', taskId: '12', subject: 's', workspaceRef: 'workspace:7' }];
  const plan = core.planSweep(entries, new Map([task(12, 'completed')]), { now: NOW, liveTitles: LIVE });
  assert.equal(plan.inFlight.length, 0);
  assert.equal(plan.toDispatch.length, 0);
});

test('open launch with open task is in flight; not re-dispatched', () => {
  const entries = [{ ts: T(10), event: 'launch', taskId: '13', subject: 's', workspaceRef: 'workspace:1' }];
  const plan = core.planSweep(entries, new Map([task(13, 'in_progress')]), { now: NOW, liveTitles: LIVE });
  assert.equal(plan.inFlight.length, 1);
  assert.equal(plan.inFlight[0].listed, true);
  assert.equal(plan.toDispatch.length, 0);
});

// Card #1233: 2 infra-only deaths (paired unverified launch — cmux's terminal
// surface never rendered) must NOT park a task; the substantive cap only
// counts substantive deaths. But a task that fails to even boot
// INFRA_DEAD_ATTEMPT_LIMIT times in a row (cmux itself looks wedged) still
// must park eventually — and the parked item must carry reason:'infra' with
// deaths reflecting the INFRA count, not 0, or the owner-facing message in
// dispatch-watchdog.js reads "parked after 0 dead dispatch attempts" (ship-
// check catch on the first cut of this fix).
test('2 infra-only deaths do not park; INFRA_DEAD_ATTEMPT_LIMIT infra deaths in a row park with reason:infra and a non-zero death count', () => {
  // Shape-1 classification (dispatch-attempts.js foldAttempts) only checks
  // that the paired launch is unverified AND within PAIR_WINDOW_MS of the
  // dead row — not which one was written first. Real bsc-next writes 'dead'
  // then the paired 'launch' ~1-2ms later; this fixture writes launch then
  // dead ~50ms later, which is equally a valid shape-1 pair for
  // classification purposes AND satisfies lastTerminalEventForTask's
  // separate, pre-existing requirement that a task's terminal event land
  // at-or-after its last launch (unrelated to card #1233 — every OTHER
  // passing test in this file already relies on launch-before-dead
  // ordering for exactly this reason).
  const infraPair = (ref, launchM, deadM) => ([
    { ts: T(launchM), event: 'launch', taskId: '15', subject: 's', workspaceRef: ref, unverified: true },
    { ts: T(deadM), event: 'dead', taskId: '15', workspaceRef: ref, failureReason: 'command injection never ran' },
  ]);
  const twoInfra = [...infraPair('workspace:20', 90, 89.9999), ...infraPair('workspace:21', 80, 79.9999)];
  const planTwo = core.planSweep(twoInfra, new Map([task(15, 'in_progress')]), { now: NOW, liveTitles: LIVE });
  assert.equal(planTwo.toPark.length, 0, '2 infra deaths must not park');

  const tenInfra = [];
  for (let i = 0; i < 10; i++) tenInfra.push(...infraPair(`workspace:${30 + i}`, 90 - i, 90 - i - 0.0001));
  const planTen = core.planSweep(tenInfra, new Map([task(15, 'in_progress')]), { now: NOW, liveTitles: LIVE });
  assert.equal(planTen.toPark.length, 1, '10 infra deaths in a row must still park (wedged-host ceiling)');
  assert.equal(planTen.toPark[0].reason, 'infra');
  assert.equal(planTen.toPark[0].deaths, 10, 'deaths must reflect the infra count, never 0, for the owner-facing message');
});

test('DEAD_ATTEMPT_LIMIT deaths -> park once; parked card never re-parks or re-dispatches across 100 sweeps (pre-mortem P0)', () => {
  const entries = [
    { ts: T(90), event: 'launch', taskId: '14', subject: 's', workspaceRef: 'workspace:8' },
    { ts: T(80), event: 'dead', taskId: '14', workspaceRef: 'workspace:8' },
    { ts: T(70), event: 'launch', taskId: '14', subject: 's', workspaceRef: 'workspace:9' },
    { ts: T(60), event: 'dead', taskId: '14', workspaceRef: 'workspace:9' },
  ];
  const tasks = new Map([task(14, 'in_progress')]);
  const first = core.planSweep(entries, tasks, { now: NOW, liveTitles: LIVE });
  assert.equal(first.toPark.length, 1, 'first sweep parks');
  assert.equal(first.toDispatch.length, 0);
  // CLI appends the park event; every later sweep must be silent about #14
  entries.push({ ts: T(59), event: core.WATCHDOG_EVENTS.PARK, taskId: '14' });
  for (let i = 0; i < 100; i++) {
    const p = core.planSweep(entries, tasks, { now: NOW, liveTitles: LIVE });
    assert.equal(p.toPark.length, 0, `sweep ${i} re-parked`);
    assert.equal(p.toDispatch.length, 0);
  }
});

test('a fresh launch clears a watchdog park (self-healing, same rule as vanished-park)', () => {
  const entries = [
    { ts: T(90), event: 'launch', taskId: '15', subject: 's', workspaceRef: 'workspace:8' },
    { ts: T(80), event: core.WATCHDOG_EVENTS.PARK, taskId: '15' },
    { ts: T(70), event: 'launch', taskId: '15', subject: 's', workspaceRef: 'workspace:9' },
  ];
  assert.equal(core.watchdogParkedIds(entries).has('15'), false);
});

test('undispatched P0/P1 pending cards queue, P0 first; marketing/human cards excluded', () => {
  const tasks = new Map([
    task(20, 'pending', 'P1 Now'),
    task(19, 'pending', 'P0 Now'),
    ['21', { id: '21', subject: 'Email volunteers', status: 'pending', description: '[notion:x] P1 Now · Not started · Marketing\n' }],
    task(22, 'pending', 'P2 Later'),
  ]);
  const plan = core.planSweep([], tasks, { now: NOW, liveTitles: LIVE });
  assert.deepEqual(plan.p01Queue.map(q => q.taskId), ['19', '20']);
  assert.deepEqual(plan.toDispatch.map(q => q.taskId), ['19', '20']);
});

test('caps: day budget and concurrency hold dispatches and are reported', () => {
  const entries = [];
  for (let i = 0; i < core.CAPS.perDay; i++) {
    entries.push({ ts: new Date(NOW - i * 1000).toISOString(), event: core.WATCHDOG_EVENTS.REDISPATCH, taskId: String(100 + i) });
  }
  const plan = core.planSweep(entries, new Map([task(30, 'pending', 'P1 Now')]), { now: NOW, liveTitles: LIVE });
  assert.equal(plan.toDispatch.length, 0);
  assert.ok(plan.budgets.holds.some(h => h.includes('day budget')));
});

test('cmux unobservable (null or empty listing) = report-only, zero dispatches', () => {
  const entries = [
    { ts: T(60), event: 'launch', taskId: '10', subject: 's', workspaceRef: 'workspace:5' },
    { ts: T(30), event: 'dead', taskId: '10', workspaceRef: 'workspace:5' },
  ];
  for (const lt of [null, new Map()]) {
    const plan = core.planSweep(entries, new Map([task(10, 'pending')]), { now: NOW, liveTitles: lt });
    assert.equal(plan.cmuxObserved, false);
    assert.equal(plan.toDispatch.length, 0);
    assert.ok(plan.budgets.holds.some(h => h.includes('cmux unobservable')));
  }
});

test('dispatch kill-switch = visibility only', () => {
  const entries = [
    { ts: T(60), event: 'launch', taskId: '10', subject: 's', workspaceRef: 'workspace:5' },
    { ts: T(30), event: 'dead', taskId: '10', workspaceRef: 'workspace:5' },
  ];
  const plan = core.planSweep(entries, new Map([task(10, 'pending')]), { now: NOW, liveTitles: LIVE, dispatchEnabled: false });
  assert.equal(plan.toDispatch.length, 0);
  assert.equal(plan.retryable.length, 1, 'still classified — only the action is held');
});

test('tab title carries counts and the upd HH:MM freshness cue', () => {
  const plan = core.planSweep([], new Map(), { now: NOW, liveTitles: LIVE });
  const title = core.tabTitle(plan);
  assert.match(title, /^👑 OWNER watchdog — 0 in flight · 0 need you · upd \d{2}:\d{2}$/);
});

test('recheck failures count toward needsYou and render in the narrative', () => {
  const plan = core.planSweep([], new Map(), {
    now: NOW, liveTitles: LIVE,
    recheckFailures: [{ notionId: 'n1', taskSubject: 'Broken card', ts: T(60) }],
  });
  assert.equal(plan.needsYou, 1);
  assert.match(core.renderNarrative(plan), /acceptance recheck FAILED/);
});

// ── BRO-2318: leaky launcher, independent of detectLauncherOutage ──────────
test('a leaky launcher (~1-in-3 injection deaths, always followed by a success) holds and counts toward needsYou even though outage.recovered is true', () => {
  const pattern = ['dead', 'ok', 'ok', 'dead', 'ok', 'ok', 'dead', 'ok', 'ok'];
  const entries = [];
  pattern.forEach((kind, i) => {
    const w = `workspace:${900 + i}`;
    const ts = T(24 - i * 3); // spread across the last 24min, oldest first
    if (kind === 'dead') {
      entries.push({ ts, event: 'dead', taskId: String(900 + i), workspaceRef: w, failureReason: 'command injection never ran (no wrapper process appeared)' });
      entries.push({ ts, event: 'launch', taskId: String(900 + i), workspaceRef: w, unverified: true });
    } else {
      entries.push({ ts, event: 'launch', taskId: String(900 + i), workspaceRef: w });
    }
  });
  const plan = core.planSweep(entries, new Map(), { now: NOW, liveTitles: LIVE });
  assert.equal(plan.outage.outage, false, 'sanity: not enough deaths inside the 30min outage lookback to alarm on its own terms');
  assert.equal(plan.outage.recovered, true, 'sanity: this is exactly the "recovered" shape the outage detector is blind to');
  assert.equal(plan.failureRate.leaking, true);
  assert.ok(plan.budgets.holds.some(h => /leaking/.test(h)));
  assert.equal(plan.needsYou >= 1, true);
});

test('taskPriority parses bridge line and subject fallback', () => {
  assert.equal(core.taskPriority({ description: '[notion:x] P0 Now · In progress · Admin' }), 'P0');
  assert.equal(core.taskPriority({ description: 'native', subject: 'P1: fix it' }), 'P1');
  assert.equal(core.taskPriority({ description: 'native', subject: 'fix it' }), null);
});

// ── Card #1564: the redispatch loop ────────────────────────────────────────
// executeSweep journals its REDISPATCH claim BEFORE spawning the child
// bsc-next, but a child REFUSED by a guard (closed card, PARKED, REOPEN-
// SUSPECT) journals nothing at all. planSweep never read its own claims back,
// so it re-picked the same task on every ~90s sweep. Live: 2026-08-19
// 14:02-14:09Z, twelve consecutive claims across only #1759 and #586 spent the
// entire perDay budget in eight minutes for zero launches.
test('#1564: a claim that never launched is not re-claimed every sweep, and does not starve the budget', () => {
  const entries = [];
  const tasks = new Map([
    task(20, 'pending', 'P1 Now'),   // the card whose child will always refuse
    task(21, 'pending', 'P1 Now'),   // a healthy card queued behind it
  ]);
  let now = NOW;
  const claims = {};
  for (let sweep = 0; sweep < 20; sweep++) {
    const plan = core.planSweep(entries, tasks, { now, liveTitles: LIVE });
    for (const d of plan.toDispatch) {
      claims[d.taskId] = (claims[d.taskId] || 0) + 1;
      // A refused child writes ONLY the claim — no 'launch', no 'dead'.
      entries.push({ ts: new Date(now).toISOString(), event: 'watchdog-redispatch', taskId: d.taskId, kind: 'p01-backlog' });
    }
    now += 92 * 1000;               // the real sweep period
  }
  assert.equal(claims['20'], 1, 'the refused card must be claimed exactly once, not once per sweep');
  assert.equal(claims['21'], 1, 'and the healthy card behind it must still get its dispatch');
});

test('#1564: a landed launch re-arms the task — a later dead launch is still retryable', () => {
  const entries = [
    { ts: T(120), event: 'watchdog-redispatch', taskId: '22', kind: 'p01-backlog' },
    { ts: T(118), event: 'launch', taskId: '22', subject: 'Fix thing 22', workspaceRef: 'workspace:8' },
    { ts: T(30), event: 'dead', taskId: '22', workspaceRef: 'workspace:8' },
  ];
  const plan = core.planSweep(entries, new Map([task(22, 'in_progress')]), { now: NOW, liveTitles: LIVE });
  assert.equal(plan.retryable.length, 1, 'the claim landed, so the dead session is retryable as before');
  assert.equal(plan.toDispatch[0].taskId, '22');
});

test('#1564: an unlanded claim re-arms by itself after REDISPATCH_REARM_MS', () => {
  const tasks = new Map([task(23, 'pending', 'P1 Now')]);
  const stale = [{ ts: new Date(NOW - core.REDISPATCH_REARM_MS - 60000).toISOString(), event: 'watchdog-redispatch', taskId: '23', kind: 'p01-backlog' }];
  assert.equal(core.planSweep(stale, tasks, { now: NOW, liveTitles: LIVE }).toDispatch.length, 1,
    'a day-old unlanded claim must not suppress forever — a transient failure has to retry');

  const fresh = [{ ts: T(60), event: 'watchdog-redispatch', taskId: '23', kind: 'p01-backlog' }];
  assert.equal(core.planSweep(fresh, tasks, { now: NOW, liveTitles: LIVE }).toDispatch.length, 0,
    'but an hour-old one still suppresses');
});

test('#1564: the retry path is suppressed too, not just the P0/P1 backlog', () => {
  const entries = [
    { ts: T(300), event: 'launch', taskId: '24', subject: 'Fix thing 24', workspaceRef: 'workspace:9' },
    { ts: T(280), event: 'dead', taskId: '24', workspaceRef: 'workspace:9' },
    { ts: T(60), event: 'watchdog-redispatch', taskId: '24', kind: 'retry' },
  ];
  const plan = core.planSweep(entries, new Map([task(24, 'in_progress')]), { now: NOW, liveTitles: LIVE });
  assert.equal(plan.toDispatch.length, 0, 'a retry claim that never landed must not re-fire every sweep');
  assert.equal(plan.awaitingClaim.length, 1, 'and it must be surfaced to the owner, not silently dropped');
  assert.match(core.renderNarrative(plan), /could not start/);
  // Suppressed cards leave p01Queue/retryable, so if they did not also land in
  // needsYou the tab title would read "0 need you" over a shrinking backlog.
  assert.ok(plan.needsYou >= 1, 'a suppressed card must count toward needsYou');
  assert.match(core.renderNarrative(plan), /bsc-next\.js --id 24 --force/, 'and must name the command that re-arms it');
});

test('#1564: a claim younger than the boot grace suppresses but is NOT labelled a failure', () => {
  // A launch takes minutes and sweeps run every 92s, so labelling immediately
  // announced every healthy dispatch as "could not start" first (ship-check P1).
  const entries = [{ ts: T(2), event: 'watchdog-redispatch', taskId: '27', kind: 'p01-backlog' }];
  const tasks = new Map([task(27, 'pending', 'P1 Now')]);
  const booting = core.planSweep(entries, tasks, { now: NOW, liveTitles: LIVE });
  assert.equal(booting.toDispatch.length, 0, 'still suppressed — that is the duplicate guard');
  assert.equal(booting.awaitingClaim.length, 0, 'but not yet called a failure');
  assert.equal(booting.needsYou, 0);

  const older = [{ ts: new Date(NOW - core.CLAIM_LABEL_GRACE_MS - 60000).toISOString(), event: 'watchdog-redispatch', taskId: '27', kind: 'p01-backlog' }];
  assert.equal(core.planSweep(older, tasks, { now: NOW, liveTitles: LIVE }).awaitingClaim.length, 1,
    'past the grace window it IS a failure the owner must see');
});

test('#1564: a wedged launcher (claims, and nothing launching fleet-wide) holds dispatch instead of stalling silently', () => {
  // cmux-launch returns ok:false with NO workspaceRef when the CLI is missing,
  // the auth preflight fails, or new-workspace exits non-zero — and
  // failedLaunchEntries() returns [] for a ref-less failure, so NOTHING is
  // journaled. Every claim then looks like a guard refusal and
  // detectLauncherOutage (which keys on 'dead' rows) is blind. (ship-check P0)
  const old = m => new Date(NOW - m * 60000).toISOString();
  const tasks = new Map([
    task(40, 'pending', 'P1 Now'), task(41, 'pending', 'P1 Now'),
    task(42, 'pending', 'P1 Now'), task(43, 'pending', 'P1 Now'),
  ]);
  const wedged = [
    { ts: old(90), event: 'watchdog-redispatch', taskId: '40', kind: 'p01-backlog' },
    { ts: old(80), event: 'watchdog-redispatch', taskId: '41', kind: 'p01-backlog' },
    { ts: old(70), event: 'watchdog-redispatch', taskId: '42', kind: 'p01-backlog' },
  ];
  const plan = core.planSweep(wedged, tasks, { now: NOW, liveTitles: LIVE });
  assert.equal(plan.awaitingClaim.length, 3);
  assert.ok(plan.budgets.holds.some(h => /launcher itself looks wedged/.test(h)),
    'three claims and zero launches anywhere = the launcher, not the cards');
  assert.equal(plan.toDispatch.length, 0, 'and dispatching holds rather than burning more claims');

  // Control: the SAME three stuck claims, but other work is still launching —
  // that is three genuinely refused cards, not an outage. Must not hold.
  const refusedRun = [
    ...wedged,
    { ts: old(5), event: 'launch', taskId: '43', subject: 'Fix thing 43', workspaceRef: 'workspace:1' },
  ];
  const plan2 = core.planSweep(refusedRun, tasks, { now: NOW, liveTitles: LIVE });
  assert.equal(plan2.awaitingClaim.length, 3);
  assert.ok(!plan2.budgets.holds.some(h => /launcher itself looks wedged/.test(h)),
    'a fresh launch elsewhere proves the launcher works');
});

test('#1564: out-of-order ledger appends are judged by timestamp, not file position', () => {
  // Nothing serialises writes to the ledger across processes, so a row can
  // land after newer ones. Last-in-file-order would read the OLD launch as
  // "latest" and wrongly suppress a card whose newer launch already landed.
  const entries = [
    { ts: T(10), event: 'launch', taskId: '28', subject: 'Fix thing 28', workspaceRef: 'workspace:1' },
    { ts: T(60), event: 'watchdog-redispatch', taskId: '28', kind: 'retry' },
    { ts: T(300), event: 'launch', taskId: '28', subject: 'Fix thing 28', workspaceRef: 'workspace:2' }, // stale, appended late
  ];
  assert.equal(core.watchdogClaimPending(entries, NOW).has('28'), false,
    'the T(10) launch is newer than the T(60) claim — the claim landed');
});

test('#1564: a claim whose child is still booting is not re-picked (duplicate-workspace guard)', () => {
  // A launch legitimately takes minutes; the next sweep is 92s later. Before
  // this fix that window re-picked the task and produced the duplicate
  // workspace PAIRS the card reported (77+81, 78+82, 65+67).
  const entries = [{ ts: T(1), event: 'watchdog-redispatch', taskId: '25', kind: 'p01-backlog' }];
  const plan = core.planSweep(entries, new Map([task(25, 'pending', 'P1 Now')]), { now: NOW, liveTitles: LIVE });
  assert.equal(plan.toDispatch.length, 0, 'no second dispatch while the first child is still booting');
});

test('#1564: watchdogClaimPending ignores rows with no taskId, the watchdog marker, and unparseable timestamps', () => {
  const entries = [
    { ts: T(5), event: 'watchdog-redispatch', taskId: null },
    { ts: T(5), event: 'watchdog-redispatch' },
    { ts: T(5), event: 'watchdog-resurrect', taskId: 'watchdog', workspaceRef: 'workspace:537' },
    { ts: 'not-a-timestamp', event: 'watchdog-redispatch', taskId: '99' },
    { event: 'watchdog-redispatch', taskId: '98' },            // no ts at all
    { ts: T(5), event: 'watchdog-redispatch', taskId: 26 },     // numeric id, as some rows carry
  ];
  const pending = core.watchdogClaimPending(entries, NOW);
  // Assert membership, not iteration order — Set/Map order is insertion order
  // and would make this pass or fail for the wrong reason.
  assert.equal(pending.size, 1);
  assert.ok(pending.has('26'), 'numeric task ids are normalised to strings');
  for (const bad of ['null', 'undefined', 'watchdog', '99', '98']) {
    assert.ok(!pending.has(bad), `${bad} must never become a task id`);
  }
});

test('ensureAutoTitle: bare titles get glyphs, glyphed titles pass through', () => {
  assert.equal(ensureAutoTitle('Fix the thing', 'sonnet'), '🤖⚡ Fix the thing');
  assert.equal(ensureAutoTitle('🤖🧠 Data·already fine', 'fable'), '🤖🧠 Data·already fine');
  assert.equal(ensureAutoTitle('👑 OWNER — mandate', 'opus'), '👑 OWNER — mandate');
  assert.equal(ensureAutoTitle('', 'haiku'), '🤖🪶 untitled dispatch');
});
