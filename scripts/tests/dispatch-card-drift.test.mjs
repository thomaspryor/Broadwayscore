/**
 * dispatch-card-drift.test.mjs — card #1009.
 *
 * Proves the detector answers the question the 2026-08-04 #1002 incident asked
 * and nobody could: is the session in workspace:156 running the card Notion
 * currently shows? Every function under test is require()d from the real
 * scripts/lib module (CLAUDE.md §15) — no logic is reimplemented here, so a
 * production change that breaks the decision breaks this test.
 */

import { test, describe, afterEach } from 'node:test';
// Same class as tests/unit/linear-next.test.mjs: this file stubs process.exit,
// but code under test can also signal failure with `process.exitCode = 1`,
// which a per-test finally cannot restore because it lives on the runner's own
// process. node --test then fails the whole FILE with no named failing subtest.
// Resetting after each test clears only that leak; a genuinely failing test
// still fails the file (verified).
afterEach(() => {
  process.exitCode = 0;
});

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB_PATH = path.join(HERE, '..', 'lib', 'dispatch-card-drift.js');

const drift = require(LIB_PATH);
const { computeContentHash } = require(path.join(HERE, '..', 'lib', 'attempt-memory.js'));
const closeTimeVerify = require(path.join(HERE, '..', 'lib', 'close-time-verify.js'));

const CARD = { name: 'P1: fix the thing that breaks overnight', notes: '## Acceptance criteria\n`node --test scripts/tests/thing.test.mjs`' };
const CORRECTED = { ...CARD, notes: `${CARD.notes}\nCORRECTION: the bar above was unreachable; use the 3-case bar instead.` };

const launchOf = (over = {}) => ({
  ts: '2026-08-05T10:00:00.000Z',
  event: 'launch',
  taskId: '4242',
  subject: CARD.name,
  workspaceRef: 'workspace:200',
  notionId: 'abc-123',
  contentHash: drift.computeCardContentHash(CARD),
  ...over,
});

describe('drift detection (acceptance criteria a + b)', () => {
  test('(a) a card edited AFTER launch is detected as drifted by dispatch-time hash vs current hash', () => {
    const launch = launchOf();
    const d = drift.detectDrift({ launch, card: CORRECTED, cardLastEditedAt: '2026-08-05T10:07:00.000Z' });

    assert.equal(d.drifted, true);
    assert.equal(d.status, drift.STATUS.DRIFTED);
    assert.equal(d.signal, drift.SIGNALS.HASH_MISMATCH);
    assert.equal(d.confidence, 'exact', 'a hash comparison is proof, not a guess');
    assert.equal(d.dispatchHash, drift.computeCardContentHash(CARD));
    assert.equal(d.currentHash, drift.computeCardContentHash(CORRECTED));
    assert.notEqual(d.dispatchHash, d.currentHash);
    assert.equal(d.taskId, '4242');
    assert.equal(d.workspaceRef, 'workspace:200');
  });

  test('(b) an unedited card reports no drift — including when Notion bumped last_edited_time', () => {
    const launch = launchOf();
    const d = drift.detectDrift({ launch, card: CARD, cardLastEditedAt: '2026-08-05T18:00:00.000Z' });

    assert.equal(d.drifted, false);
    assert.equal(d.status, drift.STATUS.NO_DRIFT);
    assert.equal(d.signal, null);
    // The property edit (status flip, tag, a sync write) moved last_edited_time
    // hours later. The WORK TEXT is identical, so this must not cry wolf.
    assert.equal(d.dispatchHash, d.currentHash);
  });

  test('a title-only edit drifts too — the triage/dispatch text is the title as much as the notes', () => {
    const d = drift.detectDrift({ launch: launchOf(), card: { ...CARD, name: 'P1: fix the OTHER thing' } });
    assert.equal(d.drifted, true);
    assert.equal(d.signal, drift.SIGNALS.HASH_MISMATCH);
  });

  test('an unreadable current card reports unknown, never no-drift', () => {
    const d = drift.detectDrift({ launch: launchOf(), card: null });
    assert.equal(d.status, drift.STATUS.UNKNOWN);
    assert.equal(d.drifted, false);
    assert.match(d.reason, /unavailable/);
  });

  test('the hash survives the JSON round-trip between the two card readers', () => {
    // bsc-next hashes a card parsed from `notion-brain get` stdout; notion-brain's
    // own close gate hashes the loadCard() object directly. Same fields, but the
    // first crosses JSON.stringify/parse — if that ever changed the hash, every
    // unchanged card would read as drifted and close-time verify would refuse
    // real closes (the top ship-check hypothesis; this pins it shut).
    const viaStdout = JSON.parse(JSON.stringify({ ...CARD, id: 'abc', lastEditedAt: '2026-08-05T10:00:00.000Z' }));
    assert.equal(drift.computeCardContentHash(viaStdout), drift.computeCardContentHash(CARD));
  });

  test('the hash is the SAME function the autonomous loop already uses (one card, one hash)', () => {
    assert.equal(drift.computeCardContentHash(CARD), computeContentHash({ name: CARD.name, notes: CARD.notes }));
    // Task-mirror field names (subject/description) hash identically to a card.
    assert.equal(
      drift.computeCardContentHash({ subject: CARD.name, description: CARD.notes }),
      drift.computeCardContentHash(CARD)
    );
  });
});

describe('(c) the detector is a pure function in scripts/lib, require()d not copied', () => {
  test('it lives in scripts/lib and exports plain functions', () => {
    assert.ok(fs.existsSync(LIB_PATH), 'scripts/lib/dispatch-card-drift.js must exist');
    for (const fn of ['computeCardContentHash', 'inFlightLaunches', 'detectDrift', 'driftReport', 'summarizeDrift', 'formatAmendMessage', 'amendEntry']) {
      assert.equal(typeof drift[fn], 'function', `${fn} must be exported`);
    }
  });

  test('it is pure: no fs, no child_process, no network in the module source', () => {
    const src = fs.readFileSync(LIB_PATH, 'utf8');
    for (const forbidden of ["require('fs')", "require('child_process')", "require('https')", 'fetch(']) {
      assert.ok(!src.includes(forbidden), `dispatch-card-drift.js must stay pure — found ${forbidden}`);
    }
  });

  test('detectDrift is deterministic and does not mutate its inputs', () => {
    const launch = launchOf();
    const frozenCard = Object.freeze({ ...CORRECTED });
    const a = drift.detectDrift({ launch, card: frozenCard });
    const b = drift.detectDrift({ launch, card: frozenCard });
    assert.deepEqual(a, b);
    assert.equal(launch.contentHash, drift.computeCardContentHash(CARD));
  });

  test('detectDrift refuses to guess when handed no launch entry', () => {
    assert.throws(() => drift.detectDrift({ card: CARD }), /requires the dispatch-ledger launch entry/);
  });
});

describe('the real 2026-08-04 #1002 case', () => {
  // VERBATIM line 898 of data/audit/dispatch-ledger.jsonl (the ledger is
  // gitignored, so it is pinned here — the cross-check below asserts this copy
  // still matches the real file whenever the file is present locally).
  const LEDGER_LINE_1002 = '{"ts":"2026-08-04T04:03:37.470Z","event":"launch","taskId":"1002","subject":"P0: Drive main to GREEN and prove it — 4 concurrent test.yml failures, 6 orphaned cards, 0 live sessions","workspaceRef":"workspace:156","model":"opus","verifyCmd":"node --test scripts/tests/tm-gap-links.test.mjs","verifyReason":null,"allowUnverifiable":null,"notionId":"3b2637c5-416f-81ac-8469-c6dc8731ad51","adoptedLate":null}';
  const launch1002 = JSON.parse(LEDGER_LINE_1002);
  // The six-reviewer plan-review corrected the card's acceptance criteria ~04:10,
  // ~6.5 minutes after the 04:03:37 launch.
  const CORRECTED_AT = '2026-08-04T04:10:00.000Z';

  test('the real launch entry carries NO contentHash — this feature did not exist yet', () => {
    assert.equal(launch1002.contentHash, undefined);
    assert.equal(launch1002.workspaceRef, 'workspace:156');
    assert.equal(launch1002.ts, '2026-08-04T04:03:37.470Z');
  });

  test('the mid-flight correction IS detected, via the legacy edited-after-dispatch signal', () => {
    const d = drift.detectDrift({ launch: launch1002, card: null, cardLastEditedAt: CORRECTED_AT });
    assert.equal(d.drifted, true, 'the session in workspace:156 was running superseded instructions');
    assert.equal(d.signal, drift.SIGNALS.EDITED_AFTER);
    assert.equal(d.confidence, 'weak', 'no hash existed at dispatch — timestamps only, so it warns, never blocks');
    assert.match(d.reason, /6 min AFTER dispatch/);
  });

  test('the same card touched at dispatch time (status flip) is NOT called drift', () => {
    const d = drift.detectDrift({ launch: launch1002, card: null, cardLastEditedAt: '2026-08-04T04:04:20.000Z' });
    assert.equal(d.drifted, false);
    assert.equal(d.status, drift.STATUS.NO_DRIFT);
  });

  test('had the launch been stamped (post-fix), the same correction is proven, not suspected', () => {
    const stamped = { ...launch1002, contentHash: drift.computeCardContentHash(CARD) };
    const d = drift.detectDrift({ launch: stamped, card: CORRECTED, cardLastEditedAt: CORRECTED_AT });
    assert.equal(d.confidence, 'exact');
    assert.equal(d.signal, drift.SIGNALS.HASH_MISMATCH);
  });

  test('the pinned fixture still matches the real ledger line, when the ledger is present', () => {
    const ledgerPath = path.join(HERE, '..', '..', 'data', 'audit', 'dispatch-ledger.jsonl');
    if (!fs.existsSync(ledgerPath)) return; // gitignored — absent in CI by design
    const real = fs.readFileSync(ledgerPath, 'utf8').split('\n')
      .find(l => l.includes('"ts":"2026-08-04T04:03:37.470Z"'));
    if (!real) return; // ledger rotated past it; the pinned copy above is the record
    assert.equal(real.trim(), LEDGER_LINE_1002, 'pinned #1002 fixture drifted from the real ledger line');
  });
});

describe('in-flight scoping', () => {
  const base = [
    { ts: '2026-08-05T10:00:00.000Z', event: 'launch', taskId: '1', workspaceRef: 'workspace:1', contentHash: 'aaaa' },
    { ts: '2026-08-05T11:00:00.000Z', event: 'launch', taskId: '2', workspaceRef: 'workspace:2', contentHash: 'bbbb' },
  ];
  const now = Date.parse('2026-08-05T12:00:00.000Z');

  test('a launch with no terminal breadcrumb is in flight', () => {
    const live = drift.inFlightLaunches(base, { now });
    assert.deepEqual(live.map(l => l.taskId), ['1', '2']);
  });

  test('a pruned/dead/vanished workspace drops out', () => {
    for (const ev of ['prune-closed', 'dead', 'vanished']) {
      const live = drift.inFlightLaunches(
        [...base, { ts: '2026-08-05T11:30:00.000Z', event: ev, taskId: '1', workspaceRef: 'workspace:1' }], { now }
      );
      assert.deepEqual(live.map(l => l.taskId), ['2'], `${ev} must end a launch`);
    }
  });

  test('a headless job end drops out even though job events carry no workspaceRef', () => {
    const entries = [
      { ts: '2026-08-05T10:00:00.000Z', event: 'launch', taskId: '9', workspaceRef: 'headless:9' },
      { ts: '2026-08-05T10:40:00.000Z', event: 'job-done', taskId: '9' },
    ];
    assert.deepEqual(drift.inFlightLaunches(entries, { now }), []);
  });

  test('a death BEFORE this launch (recycled workspace ref) does not end it', () => {
    const entries = [
      { ts: '2026-08-04T09:00:00.000Z', event: 'dead', taskId: '77', workspaceRef: 'workspace:1' },
      ...base,
    ];
    assert.deepEqual(drift.inFlightLaunches(entries, { now }).map(l => l.taskId), ['1', '2']);
  });

  test('a re-dispatch supersedes the older launch for the same task', () => {
    const entries = [...base, { ts: '2026-08-05T11:45:00.000Z', event: 'launch', taskId: '1', workspaceRef: 'workspace:3', contentHash: 'cccc' }];
    const live = drift.inFlightLaunches(entries, { now });
    assert.equal(live.find(l => l.taskId === '1').workspaceRef, 'workspace:3');
    assert.equal(live.filter(l => l.taskId === '1').length, 1);
  });

  test('stale launches age out of the watcher window', () => {
    const live = drift.inFlightLaunches(base, { now: Date.parse('2026-08-20T00:00:00.000Z') });
    assert.deepEqual(live, []);
    const all = drift.inFlightLaunches(base, { now: Date.parse('2026-08-20T00:00:00.000Z'), maxAgeMs: null });
    assert.equal(all.length, 2, 'null disables the cutoff for explicit, task-named callers (--amend)');
  });

  test('driftReport reports unknown for a task whose card fetch failed — not silence', () => {
    const rows = drift.driftReport({ entries: base, cards: { 1: { ...CARD } }, now });
    assert.equal(rows.length, 2);
    assert.equal(rows.find(r => r.taskId === '2').status, drift.STATUS.UNKNOWN);
    const s = drift.summarizeDrift(rows);
    assert.equal(s.unknown, 1);
    assert.match(s.line, /in-flight session/);
  });
});

describe('amend clears drift only when it actually reached the session', () => {
  const launch = launchOf();
  const currentHash = drift.computeCardContentHash(CORRECTED);
  const amendOf = (over = {}) => ({
    ts: '2026-08-05T10:20:00.000Z', event: 'amend', taskId: '4242',
    workspaceRef: 'workspace:200', contentHash: currentHash, delivered: true, ...over,
  });

  test('a delivered amend carrying the current text clears it', () => {
    const d = drift.detectDrift({ launch, card: CORRECTED, amendments: [launch, amendOf()] });
    assert.equal(d.status, drift.STATUS.AMENDED);
    assert.equal(d.drifted, false);
    assert.equal(d.amendedAt, '2026-08-05T10:20:00.000Z');
  });

  test('an UNDELIVERED amend does not — that is the "corrected on paper only" state', () => {
    const d = drift.detectDrift({ launch, card: CORRECTED, amendments: [launch, amendOf({ delivered: false, note: 'headless job' })] });
    assert.equal(d.status, drift.STATUS.DRIFTED);
    assert.equal(d.drifted, true);
    assert.match(d.reason, /NOT delivered/);
  });

  test('an amend of an EARLIER correction does not clear a later one', () => {
    const stale = amendOf({ contentHash: 'staleeeeeeeeeeee' });
    const d = drift.detectDrift({ launch, card: CORRECTED, amendments: [launch, stale] });
    assert.equal(d.status, drift.STATUS.DRIFTED);
    assert.match(d.reason, /stale text/);
  });

  test('an amend written BEFORE this launch (previous dispatch of the task) is ignored', () => {
    const old = amendOf({ ts: '2026-08-01T00:00:00.000Z' });
    const d = drift.detectDrift({ launch, card: CORRECTED, amendments: [old, launch] });
    assert.equal(d.status, drift.STATUS.DRIFTED);
  });

  test('amendEntry produces a ledger-shaped line', () => {
    const e = drift.amendEntry({ taskId: 7, workspaceRef: 'workspace:5', contentHash: 'deadbeefdeadbeef', delivered: true, signal: 'hash-mismatch' });
    assert.equal(e.event, 'amend');
    assert.equal(e.taskId, '7');
    assert.equal(e.delivered, true);
    // dispatch-ledger.appendEntry requires event + taskId; both present and stringy.
    assert.equal(typeof e.taskId, 'string');
  });
});

describe('the correction message is safe to type into a cmux prompt', () => {
  const d = drift.detectDrift({ launch: launchOf(), card: CORRECTED, cardLastEditedAt: '2026-08-05T10:07:00.000Z' });

  test('it is a single line — a newline would submit the message half-typed', () => {
    const msg = drift.formatAmendMessage({ launch: launchOf(), card: CORRECTED, drift: d });
    assert.ok(!/[\r\n]/.test(msg), 'no raw newlines');
    assert.ok(!msg.includes('\\'), 'no backslashes — cmux reads a literal \\n as Enter');
    assert.match(msg, /CARD CORRECTED SINCE DISPATCH/);
    assert.match(msg, /#4242/);
    assert.match(msg, /notion-brain\.js get abc-123/);
  });

  test('multi-line card bodies are flattened, not dropped', () => {
    const multi = { ...CARD, notes: 'line one\nline two\r\nline three' };
    const msg = drift.formatAmendMessage({ launch: launchOf(), card: multi, drift: d });
    assert.ok(!/[\r\n]/.test(msg));
    for (const frag of ['line one', 'line two', 'line three']) assert.ok(msg.includes(frag), `${frag} must survive`);
  });

  test('a forced re-delivery of an UNCHANGED card does not claim the session is stale', () => {
    const clean = drift.detectDrift({ launch: launchOf(), card: CARD });
    const msg = drift.formatAmendMessage({ launch: launchOf(), card: CARD, drift: clean });
    assert.ok(!msg.includes('CARD CORRECTED SINCE DISPATCH'), 'no false staleness claim');
    assert.match(msg, /CARD RE-DELIVERED/);
  });

  test('a huge card body is truncated with a pointer to the full card', () => {
    const huge = { ...CARD, notes: 'x'.repeat(20000) };
    const msg = drift.formatAmendMessage({ launch: launchOf(), card: huge, drift: d, maxChars: 1200 });
    assert.ok(msg.length <= 1300, `message stayed bounded (${msg.length})`);
    assert.match(msg, /truncated/);
    assert.match(msg, /notion-brain\.js get/);
  });
});

describe('delivery safety: never type into the wrong session, or the wrong moment', () => {
  const bscNext = require(path.join(HERE, '..', 'bsc-next.js'));
  const launch = { ts: '2026-08-05T10:00:00.000Z', event: 'launch', taskId: '4242', subject: CARD.name, workspaceRef: 'workspace:200', notionId: 'abc-123', contentHash: drift.computeCardContentHash(CARD) };
  const liveTitle = `🤖🔮 Data·${CARD.name}`.slice(0, 60);

  const runAmend = (over = {}) => {
    const sent = [];
    const appended = [];
    const opts = {
      readLedgerEntries: () => [launch],
      appendLedgerEntry: (e) => { appended.push(e); return e; },
      fetchCard: () => CORRECTED,
      sendToWorkspace: (ref, text) => { sent.push({ ref, text }); },
      listWorkspaces: () => [{ ref: 'workspace:200', title: liveTitle }],
      readScreen: () => 'ctx 31% │ worktree │ ⏵⏵ bypass permissions on',
      ...over,
    };
    let exitCode = null;
    const realExit = process.exit;
    process.exit = (c) => { exitCode = c; throw new Error('EXIT'); };
    try { bscNext.runAmend({ id: '4242', subject: CARD.name }, { force: false }, opts); }
    catch (e) { if (e.message !== 'EXIT') throw e; }
    finally { process.exit = realExit; }
    return { sent, appended, exitCode };
  };

  test('a healthy live session gets the correction', () => {
    const { sent, appended } = runAmend();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].ref, 'workspace:200');
    assert.equal(appended[0].event, 'amend');
    assert.equal(appended[0].delivered, true);
  });

  test('a recycled workspace ref (title no longer this task) is NOT typed into', () => {
    const { sent, appended, exitCode } = runAmend({
      listWorkspaces: () => [{ ref: 'workspace:200', title: '🤖🔮 Infra·Somebody else\'s completely different task' }],
    });
    assert.equal(sent.length, 0, 'refused to type into a stranger session');
    assert.equal(appended[0].delivered, false);
    assert.match(appended[0].note, /recycled|no longer carries/);
    assert.equal(exitCode, 1, 'exits non-zero so the caller knows it did not land');
  });

  test('a closed/renumbered workspace (ref absent from the list) is NOT typed into', () => {
    const { sent, appended } = runAmend({ listWorkspaces: () => [{ ref: 'workspace:7', title: liveTitle }] });
    assert.equal(sent.length, 0);
    assert.equal(appended[0].delivered, false);
  });

  test('a cmux list failure fails CLOSED — no delivery on uncertainty', () => {
    const { sent, appended } = runAmend({ listWorkspaces: () => { throw new Error('socket busy'); } });
    assert.equal(sent.length, 0);
    assert.equal(appended[0].delivered, false);
  });

  test('a short-titled card is still deliverable (the 20-char matcher would refuse forever)', () => {
    const shortLaunch = { ...launch, subject: 'Fix the poller' };
    const { sent } = runAmend({
      readLedgerEntries: () => [shortLaunch],
      listWorkspaces: () => [{ ref: 'workspace:200', title: '🤖🔮 Data·Fix the poller' }],
    });
    assert.equal(sent.length, 1);
  });

  test('a session at a permission dialog is NOT typed into (keystrokes would answer it)', () => {
    const dialog = 'Do you want to proceed?\n❯ 1. Yes\n  2. Yes, and don\'t ask again\n  3. No, and tell Claude what to do differently';
    const { sent, appended } = runAmend({ readScreen: () => dialog });
    assert.equal(sent.length, 0);
    assert.match(appended[0].note, /selection\/permission prompt/);
  });

  test('looksUnsafeToType: dialogs yes, ordinary prompts no', () => {
    assert.equal(drift.looksUnsafeToType('Do you want to proceed?\n❯ 1. Yes\n  2. No'), true);
    assert.equal(drift.looksUnsafeToType('Overwrite file? (y/n)'), true);
    assert.equal(drift.looksUnsafeToType('Do you want to proceed?'), true);
    assert.equal(drift.looksUnsafeToType('❯ SELFTEST PROBE — a queued user message'), false, 'the normal prompt arrow is not a dialog');
    assert.equal(drift.looksUnsafeToType('✻ Thinking… │ ctx 31% │ ⏵⏵ bypass permissions on'), false);
    assert.equal(drift.looksUnsafeToType(''), false, 'an unreadable screen is handled by the other guards, not this one');
  });

  test('looksUnsafeToType does NOT fire on a healthy session whose scrollback QUOTES a dialog', () => {
    // Verbatim from `cmux read-screen --workspace workspace:198` on 2026-08-05,
    // while this very session was editing the test above. The first version of
    // this guard refused to deliver here — the screen was showing a diff of the
    // fixture string, not a live dialog. A live dialog renders at the bottom,
    // on its own line; quoted text does neither.
    const realScreen = [
      "    383    test('a session at a permission dialog is NOT typed into (keystrokes would answer it)', () => {",
      `    384      const dialog = 'Do you want to proceed?\\n❯ 1. Yes\\n  2. Yes, and don\\'t ask again\\n  3. No';`,
      '    385      const { sent, appended } = runAmend({ readScreen: () => dialog });',
      '',
      '  Running 7 shell commands…',
      '  ⎿  $ cmux read-screen --workspace workspace:198 --lines 60 | tail -30',
      '',
      '✳ Working on card #1009 (24m 50s · ↓ 92.8k tokens)',
      '                                                            Now using usage credits',
      '────────────────────────────────────────────────────────────────────────────────',
      '❯ ',
      '────────────────────────────────────────────────────────────────────────────────',
      '  🔮 OPUS │ ctx 53% │ worktree-dispatch-card-drift-1009',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
    ].join('\n');
    assert.equal(drift.looksUnsafeToType(realScreen), false, 'quoted dialog text in the scrollback is not a live dialog');
  });

  test('a real dialog at the bottom of a busy screen still blocks', () => {
    const busyThenDialog = [
      'lots of transcript above', 'more transcript', 'and more',
      'Edit file scripts/lib/foo.js?',
      '❯ 1. Yes',
      '  2. Yes, and don\'t ask again this session',
      '  3. No, and tell Claude what to do differently',
    ].join('\n');
    assert.equal(drift.looksUnsafeToType(busyThenDialog), true);
  });
});

describe('watcher policy: throttle + delivery selection', () => {
  const now = Date.parse('2026-08-05T12:00:00.000Z');

  test('the first pass runs; a pass within the interval does not', () => {
    assert.equal(drift.shouldRunDriftPass([], { now }), true);
    const fresh = [{ ts: '2026-08-05T11:45:00.000Z', kind: drift.DRIFT_PASS_EVENT }];
    assert.equal(drift.shouldRunDriftPass(fresh, { now }), false, '15 min ago — under the 30 min interval');
    const stale = [{ ts: '2026-08-05T11:00:00.000Z', kind: drift.DRIFT_PASS_EVENT }];
    assert.equal(drift.shouldRunDriftPass(stale, { now }), true, '60 min ago — due');
  });

  test('unrelated reconcile report lines never count as a pass', () => {
    const other = [{ ts: '2026-08-05T11:59:00.000Z', kind: 'flagless-revived' }];
    assert.equal(drift.shouldRunDriftPass(other, { now }), true);
  });

  test('only hash-proven drift is auto-delivered; weak drift is report-only', () => {
    const exact = { status: drift.STATUS.DRIFTED, confidence: 'exact', workspaceRef: 'workspace:1', taskId: '1' };
    const weak = { status: drift.STATUS.DRIFTED, confidence: 'weak', workspaceRef: 'workspace:2', taskId: '2' };
    const clean = { status: drift.STATUS.NO_DRIFT, confidence: null, workspaceRef: 'workspace:3', taskId: '3' };
    const sel = drift.selectDriftDeliveries([exact, weak, clean]);
    assert.deepEqual(sel.deliver.map(r => r.taskId), ['1']);
    assert.deepEqual(sel.reportOnly.map(r => r.taskId), ['2']);
    assert.equal(sel.deferred.length, 0);
  });

  test('a backlog of drifted sessions is spread across ticks, not sprayed at cmux', () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({
      status: drift.STATUS.DRIFTED, confidence: 'exact', workspaceRef: `workspace:${i}`, taskId: String(i),
    }));
    const sel = drift.selectDriftDeliveries(rows);
    assert.equal(sel.deliver.length, drift.MAX_DELIVERIES_PER_TICK);
    assert.equal(sel.deferred.length, 7 - drift.MAX_DELIVERIES_PER_TICK);
  });
});

describe('the reconcile tick wires the detector to the delivery path', () => {
  const reconcile = require(path.join(HERE, '..', 'bsc-reconcile.js'));
  const now = Date.parse('2026-08-05T12:00:00.000Z');
  const launch = { ts: '2026-08-05T10:00:00.000Z', event: 'launch', taskId: '4242', workspaceRef: 'workspace:200', notionId: 'abc-123', contentHash: drift.computeCardContentHash(CARD) };

  const run = (over = {}) => {
    const reported = [];
    const amended = [];
    const res = reconcile.reconcileCardDrift({
      deps: {
        now,
        readLedgerEntriesFn: () => [launch],
        readReportFn: () => [],
        fetchCardFn: () => CORRECTED,
        amendFn: (taskId) => { amended.push(String(taskId)); return { ok: true, detail: 'delivered' }; },
        reportFn: (line) => reported.push(line),
        ...over,
      },
    });
    return { res, reported, amended };
  };

  test('a corrected in-flight card gets its correction delivered', () => {
    const { res, reported, amended } = run();
    assert.equal(res.skipped, false);
    assert.deepEqual(amended, ['4242'], 'bsc-next --amend was invoked for the drifted task');
    assert.equal(res.delivered.length, 1);
    assert.ok(reported.some(l => l.kind === 'card-drift-delivered'));
    assert.ok(reported.some(l => l.kind === drift.DRIFT_PASS_EVENT), 'pass is stamped so the throttle advances');
  });

  test('an unchanged card delivers nothing', () => {
    const { res, amended } = run({ fetchCardFn: () => CARD });
    assert.deepEqual(amended, []);
    assert.equal(res.drifted.length, 0);
  });

  test('an unreachable session is reported as still running the ORIGINAL instructions', () => {
    const { res, reported } = run({ amendFn: () => ({ ok: false, detail: 'headless job — no channel' }) });
    assert.equal(res.delivered.length, 0);
    const fail = reported.find(l => l.kind === 'card-drift-delivery-failed');
    assert.ok(fail, 'a failed delivery is surfaced, not swallowed');
    assert.match(fail.detail, /still running the ORIGINAL instructions/);
  });

  test('the pass is skipped (zero Notion reads) inside the throttle window', () => {
    let fetches = 0;
    const { res } = run({
      readReportFn: () => [{ ts: '2026-08-05T11:50:00.000Z', kind: drift.DRIFT_PASS_EVENT }],
      fetchCardFn: () => { fetches++; return CORRECTED; },
    });
    assert.equal(res.skipped, true);
    assert.equal(fetches, 0);
  });

  test('dry-run reports what it would deliver and calls nothing', () => {
    const reported = [];
    const amended = [];
    reconcile.reconcileCardDrift({
      dryRun: true,
      deps: {
        now,
        readLedgerEntriesFn: () => [launch],
        readReportFn: () => [],
        fetchCardFn: () => CORRECTED,
        amendFn: (taskId) => { amended.push(taskId); return { ok: true, detail: '' }; },
        reportFn: (line) => reported.push(line),
      },
    });
    assert.deepEqual(amended, []);
    assert.ok(reported.some(l => l.kind === 'card-drift-would-deliver'));
  });
});

describe('close-time guard: a card its session never saw cannot close on the new criteria', () => {
  const dispatch = { verifyCmd: 'node --test scripts/tests/thing.test.mjs', allowUnverifiable: false, verifyReason: null, taskId: '4242', matchedBy: 'notionId', entry: launchOf() };
  const exact = drift.detectDrift({ launch: launchOf(), card: CORRECTED });
  const weak = drift.detectDrift({ launch: { ...launchOf(), contentHash: undefined }, card: null, cardLastEditedAt: '2026-08-05T11:00:00.000Z' });

  test('proven drift REFUSES the close, even when the card\'s own command passes', () => {
    const decision = closeTimeVerify.decideClose({ dispatch, verifyResult: { status: 'pass' }, drift: exact });
    assert.equal(decision.allowed, false);
    assert.equal(decision.verdict, closeTimeVerify.VERDICTS.DRIFTED);
    assert.match(decision.message, /--id 4242 --amend/, 'names the exact command that fixes it');
  });

  test('suspected (timestamp-only) drift warns and closes — it must not deadlock the backlog', () => {
    assert.equal(weak.confidence, 'weak');
    const decision = closeTimeVerify.decideClose({ dispatch, verifyResult: { status: 'pass' }, drift: weak });
    assert.equal(decision.allowed, true);
    assert.equal(decision.warn, true);
  });

  test('a delivered amend un-blocks the close', () => {
    const amended = drift.detectDrift({
      launch: launchOf(), card: CORRECTED,
      amendments: [launchOf(), { ts: '2026-08-05T10:20:00.000Z', event: 'amend', taskId: '4242', workspaceRef: 'workspace:200', contentHash: drift.computeCardContentHash(CORRECTED), delivered: true }],
    });
    const decision = closeTimeVerify.decideClose({ dispatch, verifyResult: { status: 'pass' }, drift: amended });
    assert.equal(decision.allowed, true);
    assert.equal(decision.verdict, closeTimeVerify.VERDICTS.PASS);
  });

  test('--force / env bypass still wins (fail-open contract of the whole close gate)', () => {
    const forced = closeTimeVerify.decideClose({ dispatch, verifyResult: null, drift: exact, bypassReason: 'owner says the work covers the corrected criteria' });
    assert.equal(forced.allowed, true);
    assert.equal(forced.verdict, closeTimeVerify.VERDICTS.BYPASSED);
    const disabled = closeTimeVerify.decideClose({ dispatch, verifyResult: null, drift: exact, disabled: true });
    assert.equal(disabled.allowed, true);
  });

  test('no drift argument at all behaves exactly as before this card', () => {
    const decision = closeTimeVerify.decideClose({ dispatch, verifyResult: { status: 'pass' } });
    assert.equal(decision.allowed, true);
    assert.equal(decision.verdict, closeTimeVerify.VERDICTS.PASS);
  });
});
