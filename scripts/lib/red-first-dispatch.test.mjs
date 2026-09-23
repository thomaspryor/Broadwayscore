import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  DAILY_CAP, ATTEMPT_COOLDOWN_MS, FOLLOW_UP_MARKER,
  countDispatchesToday, conditionKeyFromIssue, isRedFirstCandidateIssue,
  selectRedFirstCandidates, decideCardFollowUp, followUpCommentBody, runRedFirstPass,
} = require('./red-first-dispatch.js');
const { DISPATCH_AT_FILING_MARKER, AUTO_FILED_MARKER } = require('./linear-drain-parked.js');

const NOW = Date.parse('2026-09-23T12:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

// A card exactly as owner-alert-router.js dispatchCard() files it under
// dispatchAtFiling (provenance line + BRO-3907 VERIFY line).
const redCard = (n, { key = `test-yml:red:Unit Tests:${String(n).padStart(8, '0')}`, stateType = 'unstarted', verify = 'VERIFY: `node scripts/run-unit-tests.js`' } = {}) => ({
  identifier: `BRO-${n}`,
  title: `main test.yml red: Unit Tests / Run unit tests — "t${n}"`,
  state: { name: stateType === 'unstarted' ? 'Todo' : stateType, type: stateType },
  description: `${DISPATCH_AT_FILING_MARKER} (BRO-4054; condition: ${key}). The Mac-side red-first pass dispatches it.\n\n## Problem\nmain is red.\n\n## Acceptance criteria\n${verify}\n`,
});

test('conditionKeyFromIssue reads the conditionKey out of the provenance line', () => {
  assert.equal(conditionKeyFromIssue(redCard(1)), 'test-yml:red:Unit Tests:00000001');
  assert.equal(conditionKeyFromIssue({ description: 'no marker here' }), null);
});

test('isRedFirstCandidateIssue: marker + backlog/unstarted only; the PARKED family and started/terminal states are never candidates', () => {
  assert.ok(isRedFirstCandidateIssue(redCard(1)));
  assert.ok(isRedFirstCandidateIssue(redCard(1, { stateType: 'backlog' })));
  assert.equal(isRedFirstCandidateIssue(redCard(1, { stateType: 'started' })), false);
  assert.equal(isRedFirstCandidateIssue(redCard(1, { stateType: 'completed' })), false);
  const parked = { ...redCard(2), description: `PARKED: ${AUTO_FILED_MARKER} (condition: test-yml:red:X:1)\n\n## Acceptance criteria\nVERIFY: \`node scripts/run-unit-tests.js\`` };
  assert.equal(isRedFirstCandidateIssue(parked), false, 'the parked drain owns the PARKED family — no double selection');
  // And the two markers never overlap, or linear-drain-parked would select ours.
  assert.equal(DISPATCH_AT_FILING_MARKER.includes(AUTO_FILED_MARKER), false);
});

test('cap: at most DAILY_CAP dispatches per UTC day, counted from the journal; refusals/skips never count', () => {
  const journal = [
    ...Array.from({ length: DAILY_CAP - 1 }, (_, i) => ({ ts: ago((i + 1) * 30 * 60 * 1000), event: 'dispatch', identifier: `BRO-${100 + i}` })),
    { ts: ago(30 * 60 * 1000), event: 'refused', identifier: 'BRO-200' },
    { ts: ago(30 * 60 * 1000), event: 'skip', identifier: 'BRO-201' },
    // yesterday's dispatches do not count toward today
    { ts: new Date(NOW - 26 * 60 * 60 * 1000).toISOString(), event: 'dispatch', identifier: 'BRO-50' },
  ];
  assert.equal(countDispatchesToday(journal, NOW), DAILY_CAP - 1);
  const issues = [redCard(301), redCard(302), redCard(303)];
  const r = selectRedFirstCandidates(issues, { journal, now: NOW });
  assert.equal(r.remaining, 1);
  assert.deepEqual(r.candidates.map((i) => i.identifier), ['BRO-301']);
  assert.deepEqual(r.skipped.filter((s) => s.reason === 'cap-reached').map((s) => s.identifier), ['BRO-302', 'BRO-303']);
  // cap exhausted → nothing, even with eligible cards
  const full = [...journal, { ts: ago(1000), event: 'dispatch', identifier: 'BRO-999' }];
  assert.deepEqual(selectRedFirstCandidates(issues, { journal: full, now: NOW }).candidates, []);
});

test('dedupe: a live dispatch-ledger job, a recent attempt, or a missing safe VERIFY command skips the card', () => {
  const issues = [redCard(401), redCard(402), redCard(403, { verify: 'VERIFY: owner-judgment' }), redCard(404)];
  const journal = [{ ts: ago(ATTEMPT_COOLDOWN_MS / 2), event: 'dispatch', identifier: 'BRO-402' }];
  const r = selectRedFirstCandidates(issues, { journal, openJobTaskIds: new Set(['linear:BRO-401']), now: NOW });
  assert.deepEqual(r.candidates.map((i) => i.identifier), ['BRO-404']);
  assert.deepEqual(
    Object.fromEntries(r.skipped.map((s) => [s.identifier, s.reason])),
    { 'BRO-401': 'live-job', 'BRO-402': 'recent-attempt:dispatch', 'BRO-403': 'no-safe-verify' },
  );
  // once the cooldown has elapsed the card is eligible again
  const old = [{ ts: ago(ATTEMPT_COOLDOWN_MS + 1000), event: 'dispatch', identifier: 'BRO-402' }];
  assert.ok(selectRedFirstCandidates(issues, { journal: old, now: NOW }).candidates.some((i) => i.identifier === 'BRO-402'));
});

test('ordering: candidates are filing order (lowest issue number first) regardless of list order', () => {
  const r = selectRedFirstCandidates([redCard(503), redCard(501), redCard(502)], { now: NOW });
  assert.deepEqual(r.candidates.map((i) => i.identifier), ['BRO-501', 'BRO-502', 'BRO-503']);
});

test('decideCardFollowUp: never touches a card while a job is live; cancels only never-dispatched cards', () => {
  const base = { conditionStatus: 'resolved', issueStateType: 'backlog' };
  assert.equal(decideCardFollowUp({ ...base, dispatched: true, live: true }), 'leave', 'not-resolved-while-live');
  assert.equal(decideCardFollowUp({ ...base, dispatched: false, live: true }), 'leave', 'live wins even if the dispatch stamp is missing');
  assert.equal(decideCardFollowUp({ ...base, dispatched: true, live: false }), 'comment');
  assert.equal(decideCardFollowUp({ ...base, dispatched: false, live: false }), 'cancel');
  assert.equal(decideCardFollowUp({ ...base, conditionStatus: 'open', dispatched: false, live: false }), 'none', 'an open condition is not stale');
  for (const t of ['completed', 'canceled', 'duplicate']) {
    assert.equal(decideCardFollowUp({ ...base, issueStateType: t, dispatched: false, live: false }), 'none', `terminal state ${t}`);
  }
  assert.equal(decideCardFollowUp({ ...base, issueStateType: 'started', dispatched: false, live: false }), 'leave', 'In Progress with no dispatch signal is attended work — never cancel');
  assert.equal(decideCardFollowUp({ ...base, issueStateType: 'started', dispatched: true, live: false }), 'comment');
});

test('followUpCommentBody carries the idempotency marker and names the condition', () => {
  const body = followUpCommentBody({ action: 'cancel', conditionKey: 'test-yml:red:J:abc', resolvedAt: '2026-09-23T03:10:28.986Z', resolveReason: 'job-green' });
  assert.ok(body.startsWith(FOLLOW_UP_MARKER));
  assert.match(body, /test-yml:red:J:abc/);
  assert.match(body, /canceled/);
});

// End-to-end through the real runRedFirstPass with every I/O seam injected:
// this is the "live proof" shape — three stale never-dispatched cards get
// canceled, a card with a live job is left alone, a Done card is untouched,
// and a fresh red card is dispatched exactly once and journaled.
test('runRedFirstPass: dispatches the open red card, cancels stale never-dispatched cards, leaves the live one', async () => {
  const journal = [];
  const dispatched = [];
  const updates = [];
  const resolvedAt = ago(2 * 60 * 60 * 1000);
  const tracked = { conditions: {
    'test-yml:red:E2E Tests:c2df710e': { status: 'resolved', resolvedAt, linearIdentifier: 'BRO-3883' },
    'test-yml:red:E2E Tests:9455d1f4': { status: 'resolved', resolvedAt, linearIdentifier: 'BRO-3893' },
    'test-yml:red:Unit Tests:0858c92a': { status: 'resolved', resolvedAt, linearIdentifier: 'BRO-3935' },
    'test-yml:red:E2E Tests:c58b7c79': { status: 'resolved', resolvedAt, linearIdentifier: 'BRO-3977' },
    'test-yml:red:Unit Tests:90b00144': { status: 'resolved', resolvedAt, linearIdentifier: 'BRO-3991' },
    'test-yml:red:Unit Tests:deadbeef': { status: 'open', linearIdentifier: 'BRO-4100', dispatch: { requestedAt: ago(60000) } },
    'health-check:Cookies': { status: 'resolved', resolvedAt, linearIdentifier: 'BRO-1' },
  } };
  const parkedRed = (n) => ({ identifier: `BRO-${n}`, title: `main test.yml red: x${n}`, state: { name: 'Backlog', type: 'backlog' }, description: `PARKED: ${AUTO_FILED_MARKER} (condition: k)\n\n## Acceptance criteria\nVERIFY: \`node scripts/run-unit-tests.js\``, comments: { nodes: [] } });
  const open = [parkedRed(3883), parkedRed(3893), parkedRed(3935), parkedRed(3991), { ...redCard(4100, { key: 'test-yml:red:Unit Tests:deadbeef' }), comments: { nodes: [] } }];
  const byId = new Map(open.map((i) => [i.identifier, i]));
  const deps = {
    listOpenIssues: async () => open,
    getIssue: async (id) => byId.get(id) || null,
    openJobTaskIds: () => new Set(['linear:BRO-3991']),
    readJournal: () => journal.slice(),
    appendJournal: (row) => journal.push({ ts: new Date(NOW).toISOString(), ...row }),
    readTrackedLedger: () => tracked,
    dispatch: (id) => dispatched.push(id),
    updateIssue: (id, args) => updates.push({ id, args }),
  };
  const summary = await runRedFirstPass({ now: NOW, log: () => {}, deps });
  assert.deepEqual(summary.dispatched, ['BRO-4100']);
  assert.deepEqual(dispatched, ['BRO-4100']);
  assert.ok(journal.some((r) => r.event === 'dispatch' && r.identifier === 'BRO-4100' && r.conditionKey === 'test-yml:red:Unit Tests:deadbeef'));
  const byIdAction = Object.fromEntries(summary.followUps.map((f) => [f.identifier, f.action]));
  assert.deepEqual(byIdAction, { 'BRO-3883': 'cancel', 'BRO-3893': 'cancel', 'BRO-3935': 'cancel', 'BRO-3991': 'leave' });
  assert.deepEqual(updates.map((u) => u.id), ['BRO-3883', 'BRO-3893', 'BRO-3935']);
  for (const u of updates) {
    assert.ok(u.args.includes('--state') && u.args.includes('Canceled') && u.args.includes('--cancel-reason'));
    assert.ok(u.args[u.args.indexOf('--comment') + 1].startsWith(FOLLOW_UP_MARKER));
  }
  assert.equal(summary.followUps.some((f) => f.identifier === 'BRO-3977'), false, 'a Done card is not open — no follow-up');
  assert.ok(journal.some((r) => r.event === 'follow-up' && r.identifier === 'BRO-3977' && r.action === 'none'), 'closed cards are remembered so they are not re-fetched every tick');
  assert.ok(journal.some((r) => r.event === 'follow-up' && r.identifier === 'BRO-3883' && r.action === 'cancel'));

  // Second tick: idempotent — nothing dispatched (cooldown), nothing re-canceled.
  const again = await runRedFirstPass({ now: NOW + 60000, log: () => {}, deps });
  assert.deepEqual(again.dispatched, []);
  assert.ok(again.skipped.some((s) => s.identifier === 'BRO-4100' && s.reason.startsWith('recent-attempt')));
  assert.equal(updates.length, 3);
});

test('runRedFirstPass: an unresolved "Dispatched ..." comment (another machine) dedupes even with no local journal/ledger signal', async () => {
  const card = { ...redCard(4200), comments: { nodes: [{ body: 'Dispatched abc123 to headless:linear:BRO-4200 at 2026-09-23T11:00:00Z (headless)', createdAt: ago(60000) }] } };
  const dispatched = [];
  const summary = await runRedFirstPass({ now: NOW, log: () => {}, deps: {
    listOpenIssues: async () => [card], getIssue: async () => card, openJobTaskIds: () => new Set(),
    readJournal: () => [], appendJournal: () => {}, readTrackedLedger: () => ({ conditions: {} }),
    dispatch: (id) => dispatched.push(id), updateIssue: () => {},
  } });
  assert.deepEqual(dispatched, []);
  assert.ok(summary.skipped.some((s) => s.identifier === 'BRO-4200' && s.reason === 'dispatched-comment'));
});

test('runRedFirstPass: a resolved card that was dispatched but whose job finished gets one comment, not a cancel', async () => {
  const resolvedAt = ago(60 * 60 * 1000);
  const card = { ...redCard(4300), comments: { nodes: [{ body: 'Dispatched abc to headless:linear:BRO-4300 at x (headless)', createdAt: ago(3600000) }] } };
  const updates = [];
  const journal = [];
  const deps = {
    listOpenIssues: async () => [card], getIssue: async () => card, openJobTaskIds: () => new Set(),
    readJournal: () => journal.slice(), appendJournal: (r) => journal.push({ ts: new Date(NOW).toISOString(), ...r }),
    readTrackedLedger: () => ({ conditions: { 'test-yml:red:Unit Tests:00004300': { status: 'resolved', resolvedAt, linearIdentifier: 'BRO-4300' } } }),
    dispatch: () => { throw new Error('must not dispatch a card with a dispatched comment'); }, updateIssue: (id, args) => updates.push({ id, args }),
  };
  const summary = await runRedFirstPass({ now: NOW, log: () => {}, deps });
  assert.deepEqual(summary.followUps.map((f) => [f.identifier, f.action]), [['BRO-4300', 'comment']]);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].args.includes('--state'), false, 'comment only — the job outcome path owns the close');
  // an existing follow-up comment on the thread (other machine) short-circuits
  card.comments.nodes.push({ body: `${FOLLOW_UP_MARKER} already`, createdAt: ago(1000) });
  const again = await runRedFirstPass({ now: NOW, log: () => {}, deps: { ...deps, readJournal: () => [] } });
  assert.deepEqual(again.followUps, []);
  assert.equal(updates.length, 1);
});

test('runRedFirstPass: dry-run selects and decides but spawns, journals and mutates nothing', async () => {
  const journal = [];
  const summary = await runRedFirstPass({ dryRun: true, now: NOW, log: () => {}, deps: {
    listOpenIssues: async () => [{ ...redCard(4400), comments: { nodes: [] } }], getIssue: async (id) => ({ ...redCard(4400), comments: { nodes: [] } }),
    openJobTaskIds: () => new Set(), readJournal: () => journal, appendJournal: (r) => journal.push(r),
    readTrackedLedger: () => ({ conditions: {} }),
    dispatch: () => { throw new Error('dry-run must not spawn'); }, updateIssue: () => { throw new Error('dry-run must not mutate'); },
  } });
  assert.deepEqual(summary.dispatched, ['BRO-4400']);
  assert.deepEqual(journal, []);
});

test('runRedFirstPass honors the kill switches without touching Linear', async () => {
  for (const flag of ['RED_FIRST_DISABLED', 'LINEAR_NEXT_DISABLED']) {
    process.env[flag] = '1';
    try {
      const summary = await runRedFirstPass({ log: () => {}, deps: { listOpenIssues: async () => { throw new Error('must not list'); } } });
      assert.equal(summary.disabled, flag);
    } finally {
      delete process.env[flag];
    }
  }
});
