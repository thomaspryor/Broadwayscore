// BRO-7103: recurrence detector rules. Requires the real modules (§15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rc = require('./recurrence-classes.js');
const det = require('../recurrence-detector.js');
const { checkLinearDoneTransition, recurrenceWarning } = require('./linear-done-gate.js');
const { startNowUnpickableReason, pickCloudCard } = require('./cloud-worker-pick.js');
const { isSafeCheckCommand } = require('./check-paths.js');

const NOW = Date.parse('2026-11-07T12:00:00Z');
const DAY = 864e5;
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();
let n = 1000;
const card = (title, daysAgo, extra = {}) => ({
  identifier: `BRO-${n++}`, title, createdAt: iso(daysAgo), state: { type: 'unstarted' }, description: '', ...extra,
});
const done = (title, daysAgo, doneDaysAgo, extra = {}) => card(title, daysAgo, {
  state: { type: 'completed' }, completedAt: iso(doneDaysAgo), ...extra,
});
const classesOf = (cards, ledger = null) => rc.detectClasses(cards, ledger, { now: NOW });
const only = (m) => { assert.equal(m.size, 1); return [...m.values()][0]; };

test('3 cards of one problem in 30 days is a recurring class', () => {
  const cls = only(classesOf([
    done('Opening night poller failed', 20, 19),
    done('Opening night poller failed', 10, 9),
    card('Opening night poller failed', 2),
  ]));
  assert.equal(cls.recurring, true);
  assert.equal(cls.inWindow, 3);
  assert.equal(cls.rootCause, null);
});

test('2 cards is not recurring; cards outside the window do not count', () => {
  const cls = only(classesOf([
    done('Bright Data breaker tripped', 45, 44),
    done('Bright Data breaker tripped', 20, 19),
    card('Bright Data breaker tripped', 2),
  ]));
  assert.equal(cls.inWindow, 2);
  assert.equal(cls.recurring, false);
});

test('canary cards are expected repeats and never recurring', () => {
  const cls = only(classesOf([1, 5, 9, 13].map((d) => done('[E2E Canary] alert chain test', d, d - 0.5))));
  assert.ok(cls.expected && /canary/.test(cls.expected));
  assert.equal(cls.recurring, false);
});

test('every EXPECTED_REPEATS entry matches a real title shape', () => {
  const titles = [
    '[E2E Canary] alert chain test',
    'Opening-night audit 2026-11-05',
    'Week in review: Nov 2',
    'Land dependabot PR #412',
    'Commercial scorecard corrections part 3',
    'Commercial data: pending review (4 rows)',
  ];
  for (const e of rc.EXPECTED_REPEATS) assert.ok(titles.some((t) => e.re.test(t)), `no title for ${e.re}`);
  assert.equal(rc.expectedRepeatReason('Morning digest did not arrive'), null);
});

test('main-red classes reuse BRO-3425, including filer-prefixed titles', () => {
  const cls = only(classesOf([
    done('Main test.yml red: unit tests', 20, 19),
    done('BSC Daily: main test.yml red: unit tests', 12, 11),
    card('Main test.yml red: unit tests', 2),
  ]));
  assert.equal(cls.rootCause, 'BRO-3425');
  assert.equal(rc.overrideRootCause([{ title: 'Review gap: missing cited review' }]), null);
});

test('marker card is the root cause and is never its own instance', () => {
  const key = rc.classKey('Opening night poller failed');
  const root = card('Root cause: "Opening night poller failed" keeps coming back', 1, { description: `x\n${rc.markerLine(key)}`, state: { type: 'started' } });
  const cls = only(classesOf([
    done('Opening night poller failed', 20, 19), done('Opening night poller failed', 10, 9), card('Opening night poller failed', 2), root,
  ]));
  assert.equal(cls.rootCause, root.identifier);
  assert.ok(!cls.instances.includes(root));
  assert.deepEqual(cls.extraRootCauses, []);
});

test('a root card matches by listed-instance overlap after a key change', () => {
  const a = done('Opening night poller failed', 20, 19);
  const b = done('Opening night poller failed', 10, 9);
  const c = card('Opening night poller failed', 2);
  const root = card('Root cause: old name', 1, {
    description: `- ${a.identifier}\n- ${b.identifier}\n<!-- root-cause-class: v0:some old key -->`,
  });
  assert.equal(only(classesOf([a, b, c, root])).rootCause, root.identifier);
});

test('two exact-marker root cards are reported as a duplicate', () => {
  const key = rc.classKey('Opening night poller failed');
  const r1 = card('Root 1', 3, { description: rc.markerLine(key) });
  const r2 = card('Root 2', 1, { description: rc.markerLine(key) });
  const cls = only(classesOf([done('Opening night poller failed', 20, 19), done('Opening night poller failed', 10, 9), card('Opening night poller failed', 2), r1, r2]));
  assert.equal(cls.rootCause, r1.identifier);
  assert.deepEqual(cls.extraRootCauses, [r2.identifier]);
});

test('ledger reopen needs a recorded resolve before the new incident', () => {
  const first = '2026-10-01T00:00:00Z';
  const reopened = { conditions: { k: { firstSeen: first, incidentOpenedAt: iso(3), resolvedAt: iso(5) } } };
  const quietGap = { conditions: { k: { firstSeen: first, incidentOpenedAt: iso(3) } } };
  assert.equal(rc.ledgerReopens(reopened).length, 1);
  assert.equal(rc.ledgerReopens(quietGap).length, 0);
});

test('a reopen makes a 1-card class recurring and overrides suspect', () => {
  const c = done('Cron stale: weekly grosses', 10, 9);
  const ledger = { conditions: { k: { firstSeen: iso(10), incidentOpenedAt: iso(3), resolvedAt: iso(5), linearIdentifier: c.identifier } } };
  const cls = only(classesOf([c], ledger));
  assert.equal(cls.recurring, true);
  assert.equal(cls.reopens.length, 1);
});

test('suspect classes: all canceled, or all within 24h', () => {
  const canceled = only(classesOf([1, 5, 9].map((d) => card('Watchdog parked redispatch', d, { state: { type: 'canceled' }, canceledAt: iso(d) }))));
  assert.match(canceled.suspect, /canceled/);
  assert.equal(canceled.recurring, false);
  const burst = only(classesOf([0.1, 0.2, 0.3].map((d) => card('Reddit post ready', 2 + d))));
  assert.match(burst.suspect, /24 hours/);
  assert.equal(burst.recurring, false);
});

test('prevention claims: failed when the class came back, unclaimed counted apart', () => {
  const a = done('Opening night poller failed', 20, 18);
  const b = done('Opening night poller failed', 15, 14);
  const c = card('Opening night poller failed', 2);
  const cls = only(classesOf([a, b, c]));
  const claims = rc.checkPreventionClaims(cls, { [a.identifier]: ['Outcome\nPREVENTION: retry guard + test ; cousins: none'] });
  const ca = claims.find((x) => x.card === a.identifier);
  const cb = claims.find((x) => x.card === b.identifier);
  assert.equal(ca.failed, true);
  assert.equal(ca.recurredAs, b.identifier);
  assert.match(ca.claim, /retry guard/);
  assert.equal(cb.claim, null);
  assert.equal(cb.failed, false);
  assert.deepEqual(rc.preventionLines('- **PREVENTION:** x\nfoo\nPREVENTION: y'), ['x', 'y']);
});

test('workKind and rootCauseShare', () => {
  const inst = [done('Opening night poller failed', 20, 3), done('Opening night poller failed', 10, 2), card('Opening night poller failed', 2)];
  const sys = done('Add West End lottery page', 6, 1);
  const root = done('Root', 6, 1, { description: rc.markerLine('k') });
  const canary = done('[E2E Canary] alert chain', 3, 1);
  const cards = [...inst, sys, root, canary];
  const classes = classesOf(cards);
  assert.equal(rc.workKind(inst[0], classes), 'instance');
  assert.equal(rc.workKind(sys, classes), 'system');
  assert.equal(rc.workKind(root, classes), 'root-cause');
  const share = rc.rootCauseShare(cards, classes, { from: NOW - 7 * DAY, to: NOW });
  assert.equal(share.total, 4); // canary left out
  assert.equal(share.share, 50);
});

const SNAP = {
  generatedAt: new Date(NOW - 3600e3).toISOString(),
  instances: { 'BRO-1': { rootCause: 'BRO-9', classKey: 'opening night poller failed' } },
  classes: [{ key: 'opening night poller failed', rootCause: 'BRO-9', rootCauseState: 'started', rootCauseStartedAt: new Date(NOW - 2 * 864e5).toISOString() }],
};

test('close warning names the root card and the blocking date; silent once linked', () => {
  const w = rc.recurrenceCloseWarning('BRO-1', SNAP);
  assert.match(w, /BRO-9/);
  assert.match(w, new RegExp(rc.CLOSE_GATE_BLOCKING_FROM));
  assert.equal(rc.recurrenceCloseWarning('BRO-1', SNAP, ['BRO-9']), null);
  assert.equal(rc.recurrenceCloseWarning('BRO-2', SNAP), null);
  assert.equal(rc.recurrenceCloseWarning('BRO-1', null), null);
});

test('done gate: warning added, allowed never changed, comment naming root silences it', () => {
  const base = { targetStateType: 'completed', identifier: 'BRO-1', recurrenceSnapshot: SNAP, description: '', commentText: 'PR-EVIDENCE: merged deployed checked (https://x)' };
  const r = checkLinearDoneTransition(base);
  const r0 = checkLinearDoneTransition({ ...base, recurrenceSnapshot: null });
  assert.equal(r.allowed, r0.allowed);
  assert.match(r.warning, /BRO-9/);
  assert.equal(recurrenceWarning({ ...base, commentText: 'fixed via BRO-9' }), null);
  assert.equal(recurrenceWarning({ ...base, identifier: undefined }), null);
});

test('routing: started root skips the instance; P0 and stale snapshot never do', () => {
  assert.equal(rc.rootCauseRouteReason({ identifier: 'BRO-1', priority: 3 }, SNAP, NOW), 'routed-to-root-cause');
  assert.equal(rc.rootCauseRouteReason({ identifier: 'BRO-1', priority: 1 }, SNAP, NOW), null);
  assert.equal(rc.rootCauseRouteReason({ identifier: 'BRO-1', priority: 2 }, SNAP, NOW), null, 'High (main red) is never held back');
  const noStart = { ...SNAP, classes: [{ ...SNAP.classes[0], rootCauseStartedAt: null }] };
  assert.equal(rc.rootCauseRouteReason({ identifier: 'BRO-1', priority: 3 }, noStart, NOW), null, 'no start time: no endless hold');
  assert.equal(rc.rootCauseRouteReason({ identifier: 'BRO-1', priority: 3 }, SNAP, NOW + 3 * DAY), null);
  const paused = { ...SNAP, classes: [{ ...SNAP.classes[0], rootCauseState: 'backlog' }] };
  assert.equal(rc.rootCauseRouteReason({ identifier: 'BRO-1', priority: 3 }, paused, NOW), null);
  const todoNew = { ...SNAP, classes: [{ ...SNAP.classes[0], rootCauseState: 'unstarted', rootCauseStartedNow: true, rootCauseCreatedAt: iso(1) }] };
  assert.equal(rc.rootCauseRouteReason({ identifier: 'BRO-1', priority: 3 }, todoNew, NOW), 'routed-to-root-cause');
  const todoOld = { ...SNAP, classes: [{ ...todoNew.classes[0], rootCauseCreatedAt: iso(3) }] };
  assert.equal(rc.rootCauseRouteReason({ identifier: 'BRO-1', priority: 3 }, todoOld, NOW), null);
});

test('pickCloudCard counts routed instances under routed-to-root-cause', () => {
  const iss = { identifier: 'BRO-1', title: 'Opening night poller failed', priority: 3, state: { type: 'unstarted' }, description: '' };
  const r = pickCloudCard([iss], { nowMs: NOW, recurrence: SNAP });
  assert.equal(r.skipped['routed-to-root-cause'], 1);
  const r0 = pickCloudCard([iss], { nowMs: NOW, recurrence: null });
  assert.equal(r0.skipped['routed-to-root-cause'], undefined);
});

test('improvementLine states the share and the class count', () => {
  const line = rc.improvementLine({ share: { thisWeek: { share: 72.6, total: 351 }, lastWeek: { share: 79.4 } }, recurringCount: 31, withRootCause: 7, preventions: { failed: 2 } });
  assert.match(line, /73% of the 351 cards/);
  assert.match(line, /31 problems keep coming back; 7 have a card/);
  assert.match(line, /24 more/);
  assert.match(line, /2 fixes claimed/);
  assert.doesNotMatch(line, /—/);
  assert.equal(rc.improvementLine(null), null);
});

test('buildSnapshot + root card text pass the picker and the safe-check allowlist', () => {
  const cards = [
    done('Opening night poller failed for "Some Show" (3 reviews)', 20, 19),
    done('Opening night poller failed for "Other Show" (5 reviews)', 10, 9),
    card('Opening night poller failed for "Third Show" (1 reviews)', 2),
    card('[E2E Canary] alert chain', 1), card('[E2E Canary] alert chain', 4), card('[E2E Canary] alert chain', 8),
  ];
  const snap = det.buildSnapshot({ cards, ledger: null, now: NOW, complete: true });
  assert.equal(snap.recurringCount, 1);
  assert.equal(snap.withRootCause, 0);
  assert.equal(snap.expected.length, 1);
  const cls = snap.classes[0];
  const title = det.rootCardTitle(cls);
  const desc = det.rootCardDescription(cls);
  assert.doesNotMatch(title, /Some Show|Third Show/);
  assert.match(title, /3 cards in 30 days/);
  assert.equal(startNowUnpickableReason({ title, description: desc, priority: 2, mode: 'dispatch' }), null);
  const verify = desc.match(/^VERIFY: (.+)$/m)[1];
  assert.ok(isSafeCheckCommand(verify), verify);
  assert.ok(isSafeCheckCommand('node scripts/recurrence-detector.js --check'));
  assert.ok(!isSafeCheckCommand('node scripts/recurrence-detector.js --apply'));
  assert.ok(!isSafeCheckCommand('node scripts/recurrence-detector.js --check-class x;rm -rf / --quiet'));
  assert.doesNotMatch(desc, /DECISION NEEDED/);
  assert.doesNotMatch(desc, /RECHECK[- ]AFTER\s*:/);
  assert.equal(rc.rootCauseMarker(desc).key, cls.key);
});

test('comment-by-number query can include archived cards (old Done cards are auto-archived)', () => {
  const { buildIssueCommentsByNumberQuery } = require('./linear-dispatch.js');
  assert.doesNotMatch(buildIssueCommentsByNumberQuery(), /includeArchived/);
  assert.match(buildIssueCommentsByNumberQuery({ includeArchived: true }), /issues\(first: 50, includeArchived: true, filter:/);
  const src = require('node:fs').readFileSync(new URL('../recurrence-detector.js', import.meta.url), 'utf8');
  assert.match(src, /listIssueComments\([^)]*includeArchived: true/);
});

test('a class that comes back after its root card closed is surfaced, not silenced', () => {
  const inst = [{ identifier: 'BRO-1', createdAt: '2026-10-01T00:00:00Z' }, { identifier: 'BRO-2', createdAt: '2026-10-20T00:00:00Z' }];
  const done = { state: { type: 'completed' }, completedAt: '2026-10-10T00:00:00Z' };
  assert.deepEqual(rc.recurredAfterRootClosed(done, inst), ['BRO-2']);
  assert.deepEqual(rc.recurredAfterRootClosed({ state: { type: 'canceled' }, canceledAt: '2026-09-01T00:00:00Z' }, inst), ['BRO-1', 'BRO-2']);
  assert.deepEqual(rc.recurredAfterRootClosed({ state: { type: 'started' } }, inst), []);
  assert.deepEqual(rc.recurredAfterRootClosed(null, inst), []);
  const line = rc.improvementLine({ share: { thisWeek: { share: 50, total: 2 }, lastWeek: {} }, recurringCount: 1, withRootCause: 1, classes: [{ recurredAfterRootClosed: ['BRO-2'] }] });
  assert.match(line, /1 problem came back after the card fixing the cause was closed/);
});

test('marker is a plain line (Linear drops HTML comments); the old comment form still parses', () => {
  const line = rc.markerLine('opening night poller failed');
  assert.ok(!line.includes('<!--'));
  assert.deepEqual(rc.rootCauseMarker(`START-NOW: x\n\n${line}\n`), { version: 'v1', key: 'opening night poller failed' });
  assert.deepEqual(rc.rootCauseMarker('a\n<!-- root-cause-class: v0:some old key -->'), { version: 'v0', key: 'some old key' });
  assert.equal(rc.rootCauseMarker('prose that mentions root-cause-class: in a sentence'), null);
  assert.ok(det.rootCardDescription({ key: 'k', slug: 'k', reasons: ['3 cards'], instances: ['BRO-1'] }).includes(line.replace('opening night poller failed', 'k')));
});

test('status comments name their cases on line one, so a rerun never repeats them', () => {
  const body = det.statusComment(['BRO-11', 'BRO-12'], false);
  assert.ok(body.startsWith(`${rc.STATUS_COMMENT_MARKER} BRO-11, BRO-12\n`));
  assert.match(det.statusComment(['BRO-13'], true), /fix did not hold/);
  const seen = det.alreadyNoted([{ body }, { body: 'a person said BRO-99' }]);
  assert.deepEqual([...seen].sort(), ['BRO-11', 'BRO-12']);
});

test('a root card In Progress for more than 14 days stops holding its cases back', () => {
  const started = (d) => ({ ...SNAP, classes: [{ ...SNAP.classes[0], rootCauseState: 'started', rootCauseStartedAt: iso(d) }] });
  assert.equal(rc.rootCauseRouteReason({ identifier: 'BRO-1', priority: 3 }, started(3), NOW), 'routed-to-root-cause');
  assert.equal(rc.rootCauseRouteReason({ identifier: 'BRO-1', priority: 3 }, started(20), NOW), null);
});

test('a routed START-NOW card says why it was held back', () => {
  const iss = { identifier: 'BRO-1', title: 'Opening night poller failed', priority: 3, state: { type: 'unstarted' }, description: 'START-NOW: go' };
  const r = pickCloudCard([iss], { nowMs: NOW, recurrence: SNAP });
  assert.equal(r.startNowSkipped['BRO-1'], 'routed-to-root-cause');
});

test('declared close answers move the share: full ROOT-CAUSE block counts as root-cause, NO-ROOT-CAUSE as a spot fix', () => {
  const a = done('Widget page shows wrong totals', 3, 1);
  const b = done('Gizmo crashes on load', 3, 1);
  const classes = rc.detectClasses([a, b], { conditions: {} }, { now: NOW, windowDays: 30 });
  const block = 'ROOT-CAUSE: totals summed the wrong field\nCLASS-GUARD: scripts/lib/totals.test.mjs\nRED-THEN-GREEN: failed with the fix reverted, passed with it\nCOUSINS: searched other sum sites, none';
  const r = rc.rootCauseShare([a, b], classes, { from: NOW - 7 * DAY, to: NOW + DAY, commentsById: { [a.identifier]: [block], [b.identifier]: ['NO-ROOT-CAUSE: one-off bad upstream file'] } });
  assert.deepEqual([r['root-cause'], r.instance, r.share], [1, 1, 50]);
});

test('improvementLine adds the independent sample share while it is fresh', () => {
  const base = { share: { thisWeek: { share: 70, total: 100 }, lastWeek: null }, recurringCount: 3, withRootCause: 1 };
  const S = { generatedAt: new Date().toISOString(), graded: 8, rootCause: 3, spot: 5, share: 37.5, calibrationOk: true };
  const fresh = rc.improvementLine({ ...base, sample: S });
  assert.match(fresh, /independent check of 8 fixes .* found 3 of 8 fixed the cause/);
  const stale = rc.improvementLine({ ...base, sample: { ...S, generatedAt: '2026-01-01T00:00:00Z' } });
  assert.ok(!/independent/.test(stale));
  const thin = rc.improvementLine({ ...base, sample: { ...S, graded: 8, rootCause: 1, spot: 1, share: 50 } });
  assert.ok(!/independent/.test(thin), 'fewer than 4 decided grades publish nothing');
  const unchecked = rc.improvementLine({ ...base, sample: { ...S, calibrationOk: undefined } });
  assert.ok(!/independent/.test(unchecked), 'no anchor checked: withheld');
  const drifted = rc.improvementLine({ ...base, sample: { ...S, calibrationOk: false } });
  assert.ok(!/independent/.test(drifted), 'a drifted grader does not publish a share');
});

test('done gate refuses an unlinked instance close after the blocking date, fresh snapshot only, rollback wins', () => {
  const at = Date.parse(`${rc.CLOSE_GATE_BLOCKING_FROM}T06:00:00Z`);
  const fresh = { ...SNAP, generatedAt: new Date(at - 36e5).toISOString() };
  const base = { targetStateType: 'completed', identifier: 'BRO-1', recurrenceSnapshot: fresh, description: '', commentText: 'PR-EVIDENCE: merged deployed checked (https://x)', nowMs: at };
  assert.equal(recurrenceWarning({ ...base, nowMs: at - 2 * DAY }).blocking, false);
  const r = recurrenceWarning(base);
  assert.equal(r.blocking, true);
  assert.match(r.message, /rollback: RECURRENCE_CLOSE_GATE=advisory/);
  assert.equal(recurrenceWarning({ ...base, commentText: 'root fix in BRO-9' }), null);
  assert.equal(recurrenceWarning({ ...base, recurrenceSnapshot: { ...fresh, generatedAt: new Date(at - 3 * DAY).toISOString() } }).blocking, false, 'a stale snapshot fails open');
  // Full gate: a refusal that is already in place keeps its own verdict; otherwise ours applies.
  const ok = { ...base, description: 'PR-EVIDENCE: merged deployed checked (https://github.com/thomaspryor/Broadwayscore/commit/abcdef12345)', commentText: '', verifyEvidence: () => ({ verified: true, reason: 'on main', checked: [] }) };
  const g = checkLinearDoneTransition(ok);
  assert.deepEqual([g.allowed, g.verdict], [false, 'root-cause-not-named']);
  assert.equal(checkLinearDoneTransition({ ...ok, nowMs: at - 2 * DAY }).allowed, true, 'advisory before the date');
  assert.equal(rc.recurrenceCloseBlocking(fresh, at, { RECURRENCE_CLOSE_GATE: 'advisory' }), false);
});

// ---------- BRO-7105 follow-ups ----------

test('BRO-7105: differently titled cards that fixed the same files join one class', () => {
  const a = done('Roundup listed review not captured for giant', 20, 19);
  const b = done('Roundup listed review not captured for cats', 12, 11);
  const c = done('BWW roundup parser drops critic', 5, 4);
  const noise = done('Homepage hero spacing', 6, 5);
  const files = new Map([
    [a.identifier, ['scripts/gather-reviews.js', 'scripts/lib/roundup-parse.js']],
    [b.identifier, ['scripts/gather-reviews.js', 'scripts/lib/roundup-parse.js']],
    [c.identifier, ['scripts/lib/roundup-parse.js', 'scripts/gather-reviews.js', 'scripts/lib/roundup-parse.test.mjs']],
    [noise.identifier, ['src/app/page.tsx']],
  ]);
  const without = rc.detectClasses([a, b, c, noise], null, { now: NOW });
  assert.ok(![...without.values()].some((x) => x.recurring), 'titles alone: no class reaches 3');
  const withFiles = rc.detectClasses([a, b, c, noise], null, { now: NOW, filesById: files });
  const rec = [...withFiles.values()].filter((x) => x.recurring);
  assert.equal(rec.length, 1);
  assert.equal(rec[0].inWindow, 3);
  assert.deepEqual(rec[0].instances.map((x) => x.identifier).sort(), [a, b, c].map((x) => x.identifier).sort());
  assert.ok(rec[0].mergedFrom.length >= 1);
  assert.ok([...withFiles.values()].some((x) => x.instances.includes(noise) && !x.recurring), 'unrelated card stays apart');
});

test('BRO-7105: hub files and data/docs never join classes', () => {
  const cards = [];
  const files = new Map();
  // 30 unrelated cards all touching a hub file plus their own file.
  for (let i = 0; i < 30; i++) {
    const x = done(`Unrelated problem number ${['alpha', 'beta', 'gamma', 'delta', 'eps'][i % 5]} ${i}`, 10 + (i % 5), 9);
    cards.push(x);
    files.set(x.identifier, ['scripts/lib/linear-client.js', `scripts/own-${i}.js`]);
  }
  const m = rc.detectClasses(cards, null, { now: NOW, filesById: files });
  assert.ok(![...m.values()].some((x) => x.mergedFrom), 'a shared hub file is not a signal');
  const log = '\0BRO-1: fix x\n\ndata/shows.json\ndocs/a.md\nscripts/a.js\n\0Revert "BRO-2: y"\n\nscripts/b.js\n\0BRO-3 BRO-4: z\n\npackage.json\n';
  const f = rc.filesByCardFromLog(log);
  assert.deepEqual(f.get('BRO-1'), ['scripts/a.js']);
  assert.equal(f.has('BRO-2'), false, 'reverts skipped');
  assert.equal(f.has('BRO-3'), false, 'noise-only commit gives no files');
});

test('BRO-7105: an absorbed class keeps its root card and its --check-class key', () => {
  const root = card('Root cause: roundup parser', 200, { description: rc.markerLine('roundup parser drops critic') + '\n' });
  const a = done('Roundup listed review not captured', 20, 19);
  const b = done('Roundup listed review not captured', 12, 11);
  const c = done('Roundup parser drops critic', 5, 4);
  const files = new Map([[a.identifier, ['scripts/x.js', 'scripts/y.js']], [b.identifier, ['scripts/x.js', 'scripts/y.js']], [c.identifier, ['scripts/x.js', 'scripts/y.js']]]);
  const classes = rc.detectClasses([root, a, b, c], null, { now: NOW, filesById: files });
  const rec = [...classes.values()].find((x) => x.recurring);
  assert.equal(rec.rootCause, root.identifier, 'marker of the absorbed key still matches, no second root card');
  const snap = det.buildSnapshot({ cards: [root, a, b, c], ledger: null, now: NOW, complete: true, filesById: files });
  const keys = Object.keys(snap.lastSeenByKey);
  assert.ok(keys.includes(rec.key) && rec.mergedFrom.every((k) => keys.includes(k)));
  assert.ok(rec.mergedFrom.every((k) => snap.knownKeys.includes(k)));
});

test('BRO-7105: root-card lookup has no date window', async () => {
  const calls = [];
  const old = { identifier: 'BRO-1', title: 'old root', updatedAt: '2024-01-01T00:00:00Z', description: rc.markerLine('k') };
  const lc = {
    async listIssuesByProvenance(o) { calls.push(o); return [old].filter((c) => c.updatedAt >= o.since); },
    async getIssue() { return null; },
  };
  const got = await det.fetchRootCards([], lc);
  assert.ok(got.some((c) => c.identifier === 'BRO-1'), 'a root card untouched for two years is still found');
  assert.equal(calls[0].since, det.ROOT_LOOKUP_SINCE);
  assert.ok(Date.parse(calls[0].since) <= Date.parse('2000-01-01'));
});

test('BRO-7105: --apply refuses outside CI unless --force-local', () => {
  assert.match(det.applyRefusal({}, ['node', 'x', '--apply']), /CI only/);
  assert.equal(det.applyRefusal({ GITHUB_ACTIONS: 'true' }, ['node', 'x', '--apply']), null);
  assert.equal(det.applyRefusal({}, ['node', 'x', '--apply', '--force-local']), null);
  assert.equal(det.applyRefusal({}, ['node', 'x']), null, 'dry run is never refused');
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env }; delete env.GITHUB_ACTIONS;
  const r = spawnSync(process.execPath, [new URL('../recurrence-detector.js', import.meta.url).pathname, '--apply', '--input', '/dev/null'], { env, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /refusing/);
});

test('BRO-7105: loadFilesById deepens a shallow clone and survives git failing', () => {
  const calls = [];
  const exec = (args) => {
    calls.push(args[0]);
    if (args[0] === 'rev-parse') return 'true\n';
    if (args[0] === 'fetch') return '';
    return '\0BRO-9: fix\n\nscripts/a.js\n';
  };
  assert.deepEqual(det.loadFilesById(30, { exec }).get('BRO-9'), ['scripts/a.js']);
  assert.deepEqual(calls, ['rev-parse', 'fetch', 'log']);
  assert.equal(det.loadFilesById(30, { exec: () => { throw new Error('no git'); } }), null);
});

test('BRO-7105: only fix cards feed the files signal', () => {
  const fix = done('Fix opening night poller crash', 5, 4);
  const feat = done('Add opening night poller dashboard', 5, 4);
  const all = new Map([[fix.identifier, ['scripts/a.js', 'scripts/b.js']], [feat.identifier, ['scripts/a.js', 'scripts/b.js']]]);
  assert.deepEqual([...det.fixCardFiles([fix, feat], all).keys()], [fix.identifier]);
});

test('BRO-7105: one shared file is not enough, and joins never chain', () => {
  const a = done('Alpha problem one', 10, 9); const b = done('Beta problem two', 8, 7); const c = done('Gamma problem three', 6, 5);
  const one = rc.detectClasses([a, b], null, { now: NOW, filesById: new Map([[a.identifier, ['scripts/x.js']], [b.identifier, ['scripts/x.js']]]) });
  assert.equal(one.size, 2, 'a single shared file joins nothing');
  // a~b share {x,y}, b~c share {y,z}: a and c are not alike, so no chain.
  const m = rc.detectClasses([a, b, c], null, { now: NOW, filesById: new Map([
    [a.identifier, ['scripts/w.js', 'scripts/x.js', 'scripts/y.js']],
    [b.identifier, ['scripts/x.js', 'scripts/y.js', 'scripts/z.js']],
    [c.identifier, ['scripts/y.js', 'scripts/z.js', 'scripts/v.js']]]) });
  assert.ok(![...m.values()].some((x) => x.instances.length === 3), 'no class of 3 by chaining');
});
