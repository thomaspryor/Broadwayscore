// BRO-3917: linear-drain-parked must (a) select technically-parked session
// cards as well as auto-filed trackers, and (b) never abort before selecting
// because its checkout-sync gate refused a dirty append-only ledger.
// (b) lives in the shared gate, scripts/lib/sync-audit-checkout.sh, which
// linear-drain-parked.js runs first; its real-git tests are asserted here by
// running that suite, so this file fails if the guard regresses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const lib = require(path.join(HERE, 'linear-drain-parked.js'));

const VERIFY = '\n\nVERIFY: `node --test scripts/lib/linear-drain-parked.test.mjs`\n';
const issue = (n, description, extra = {}) => ({
  identifier: `BRO-${n}`, title: `t${n}`, priority: 2, state: { type: 'backlog' }, description, ...extra,
});

test('auto-filed parked tracker with a safe VERIFY is selected', () => {
  const sel = lib.selectDrainCandidates([issue(1, lib.AUTO_FILED_MARKER + VERIFY)]);
  assert.deepEqual(sel.map((i) => i.identifier), ['BRO-1']);
});

test('a card without a safe VERIFY is never selected', () => {
  assert.deepEqual(lib.selectDrainCandidates([issue(2, lib.AUTO_FILED_MARKER)]), []);
});

test('already-attempted and over-limit candidates are skipped, lowest number first', () => {
  const issues = [3, 4, 5].map((n) => issue(n, lib.AUTO_FILED_MARKER + VERIFY));
  const sel = lib.selectDrainCandidates(issues, { limit: 1, alreadyAttempted: new Set(['BRO-3']) });
  assert.deepEqual(sel.map((i) => i.identifier), ['BRO-4']);
});

test('a started (non-parked-state) issue is not selected', () => {
  const started = issue(6, lib.AUTO_FILED_MARKER + VERIFY, { state: { type: 'started' } });
  assert.deepEqual(lib.selectDrainCandidates([started]), []);
});

test('the sync gate drain-parked runs first survives a dirty ledger with duplicate rows (abort-before-selecting regression)', () => {
  const suite = path.join(HERE, 'sync-audit-checkout.test.mjs');
  assert.ok(fs.existsSync(suite));
  const out = execFileSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=BRO-3917', suite], {
    encoding: 'utf8',
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  });
  assert.match(out, /# pass [1-9]/);
  assert.match(out, /# fail 0/);
});

// BRO-5626: the cloud unpark drain. Reasons taken from live parked cards on 2026-10-18.
const hd = require(path.join(HERE, 'headless-dispatchability.js'));
const TAKEABLE = [
  'triaged from retired Notion backlog (BRO-5297)',
  'Needs its own session: parameterize hard-coded paths, add a test, review and land',
  'shared-infra edit (score-routing.js is in the section-18 review scope) plus a corpus delta measurement',
  'found while fixing BRO-5351; cloud worker queue picks it up',
  'low impact, small follow-up for next session',
  // BRO-5626 parent review of the 108 held cards: these read as holds but are not.
  'small data fix; review stays excluded until moved',
  'cosmetic; dispatch when touching score routing',
  'roadmap refactor, not urgent, no active bug',
  'found by BRO-5336 review; needs masthead lookups per outlet, not an owner decision',
  'needs a profiling pass, no owner input',
  'lowest severity of the three, no spend or opening-night impact',
  'rewrite the 29 humanAction paste-prompts',
  'minor P2s from BRO-4317 ship-check; none changes what ships today',
  'waits until 2026-10-16 for tour reviews to arrive',
  'needs data-repo pending-fix route, found by board worker 2026-10-12',
];
const HELD = [
  'routine audit log',
  'needs live BrightData/ScrapingBee credit spend',
  'mostly edits ~/.claude (private claude-sync repo, Mac only)',
  'Not yet 2+ real instances',
  'needs a live provider test with real keys',
  'needs researched venue URLs plus a PostHog key for the traffic check',
  'needs blind PDF parsing via CI only (TR creds not in cloud containers)',
  'needs a session with data/review-texts attached',
  'this needs a week of per-lane outcomes and its own design',
  'needs live capture during a real opening',
  'waiting on the owner to pick a design',
  'Candidate missing production: add only after validate-show-venue.js confirms (never auto-add)',
  'risky bulk rewrite of shows.json',
  // BRO-5626 ship-check: actions a worker must not take on its own.
  'bulk rescore of 400 reviews after the prompt change',
  'sends the opening-night broadcast email',
  'deletes stale rows from production Supabase',
  'deploy to prod after the migration',
  'depends on BRO-5100 landing first',
  'after BRO-5200 merges',
  'force-push to rewrite history on main',
  'iOS app TestFlight build',
  'dispatch 40 gather runs',
  'costs ScrapingBee credits',
  'edits ~/.claude hooks',
  'once the new aggregator is live',
  'manual check by hand',
  'drop the legacy table',
  'running in 3 cloud sessions started by the BRO-5221 session',
  'nothing to do until then',
  'without owner decision do not run',
  'no owner decision yet',
  'no spend approval yet',
  'Not actionable until the 80th Tony Awards date exists',
  'RECHECK-AFTER: 2099-01-01; must wait until in-flight branches land',
  'waits until 2099-01-01 for tour reviews',
  '',
];

test('BRO-5626: worker-takeable park reasons pass, real blocks and owner holds do not', () => {
  const now = new Date('2026-10-18T12:00:00Z');
  for (const r of TAKEABLE) assert.equal(hd.isWorkerTakeableParkReason(r, now), true, r);
  for (const r of HELD) assert.equal(hd.isWorkerTakeableParkReason(r, now), false, r);
});

test('BRO-5626: block words are word-bounded', () => {
  for (const r of ['fix the tokenizer split', 'monkeypatch removal']) assert.equal(hd.isWorkerTakeableParkReason(r), true, r);
});

test('BRO-5626: every PARKED line must be takeable, machine parks are left to the picker', () => {
  assert.equal(lib.unparkSkipReason(issue(10, `PARKED: ${TAKEABLE[0]}${VERIFY}`)), null);
  assert.equal(lib.unparkSkipReason(issue(11, `PARKED: ${TAKEABLE[0]}\nPARKED: waiting on the owner${VERIFY}`)), 'real-park-reason');
  assert.equal(lib.unparkSkipReason(issue(12, `PARKED: ${lib.AUTO_FILED_MARKER}${VERIFY}`)), 'machine-park');
  assert.equal(lib.unparkSkipReason(issue(13, `no park line${VERIFY}`)), 'no-park-line');
});

test('BRO-5626: unparkSkipReason needs a safe VERIFY, a triaged priority and an open parked state', () => {
  assert.equal(lib.unparkSkipReason(issue(20, `PARKED: ${TAKEABLE[0]}`)), 'no-safe-verify');
  assert.equal(lib.unparkSkipReason(issue(21, `PARKED: ${TAKEABLE[0]}${VERIFY}`, { priority: 0 })), 'untriaged-priority');
  assert.equal(lib.unparkSkipReason(issue(22, `PARKED: ${TAKEABLE[0]}${VERIFY}`, { state: { type: 'started' } })), 'not-parked-state');
  assert.equal(lib.unparkSkipReason(issue(23, `PARKED: ${TAKEABLE[0]}${VERIFY}`, { title: 'iOS app crash on launch' })), 'ios-app-repo');
});

test('BRO-5626: an unparked card is an ordinary Todo card to the picker', () => {
  const cwp = require(path.join(HERE, 'cloud-worker-pick.js'));
  const desc = `Intro\n  PARKED: ${TAKEABLE[0]}\nPARKED: ${TAKEABLE[1]}${VERIFY}`;
  const out = lib.unparkDescription(desc, 'BRO-5626 drain 2026-10-18');
  assert.doesNotMatch(out, /^\s*PARKED\s*:/im);
  assert.match(out, /^ {2}UNPARKED \(BRO-5626 drain 2026-10-18\): triaged from retired Notion backlog/m);
  const moved = issue(30, out, { state: { type: 'unstarted' }, priority: 3, updatedAt: '2026-10-01T00:00:00Z' });
  assert.equal(cwp.headlessUnfitReason(moved), null);
  assert.equal(lib.unparkSkipReason(moved), 'no-park-line');
  // Paused later, it goes back to Backlog as a paused card, not a parked one.
  assert.equal(cwp.isPausedBacklog({ ...moved, state: { type: 'backlog' } }), true);
});

test('BRO-5626: awaiting-owner label and a re-parked card are left alone', () => {
  const desc = `PARKED: ${TAKEABLE[0]}${VERIFY}`;
  assert.equal(lib.unparkSkipReason(issue(40, desc, { labels: { nodes: [{ name: 'awaiting-owner' }] } })), 'awaiting-owner');
  const reparked = `UNPARKED (BRO-5626 drain 2026-10-18): ${TAKEABLE[0]}\nPARKED: ${TAKEABLE[1]}${VERIFY}`;
  assert.equal(lib.unparkSkipReason(issue(41, reparked)), 're-parked');
  const filedTodo = `UNPARKED (BRO-5626 filed in Todo 2026-10-18): ${TAKEABLE[0]}\nPARKED: ${TAKEABLE[1]}${VERIFY}`;
  assert.equal(lib.unparkSkipReason(issue(42, filedTodo)), 're-parked');
});

test('BRO-5626: owner wording in the body and wait reasons hold the card (ported from linear-promote-parked)', () => {
  assert.equal(lib.unparkSkipReason(issue(50, `PARKED: ${TAKEABLE[0]}\n\nDECISION NEEDED: pick a layout${VERIFY}`)), 'owner-text');
  assert.equal(lib.unparkSkipReason(issue(51, `PARKED: ${TAKEABLE[0]}\n\nBlocked on the owner for wording.${VERIFY}`)), 'owner-text');
  for (const r of ['waiting for the BRO-5000 fix', 'after the quota resets', 'in 3 days', 'recheck 2026-11-01', 'wait until Monday']) {
    assert.equal(hd.isWorkerTakeableParkReason(r), false, r);
  }
});

// BRO-2802: the bulk listing omits comments. Hydrate the shortlist before
// applying the same production selection predicate as the CLI.
test('comment-corrected parked cards enter the drain after shortlist hydration', async () => {
  const parked = issue(2802, lib.AUTO_FILED_MARKER + '\nVERIFY: broken command');
  assert.deepEqual(lib.selectDrainCandidates([parked]), []);
  const reads = [];
  const hydrated = await lib.fetchDrainIssuesWithComments([parked], {
    getIssue: async (identifier) => {
      reads.push(identifier);
      return { ...parked, comments: { nodes: [{ body: VERIFY }] } };
    },
  });
  assert.deepEqual(reads, ['BRO-2802']);
  assert.deepEqual(lib.selectDrainCandidates(hydrated).map((i) => i.identifier), ['BRO-2802']);
});

test('drain comment reads skip active issues, owner holds and attempted cards', async () => {
  const cases = [
    issue(1, lib.AUTO_FILED_MARKER, { state: { type: 'started' } }),
    issue(2, 'PARKED: waiting for owner approval'),
    issue(3, lib.AUTO_FILED_MARKER),
    issue(4, 'ordinary backlog'),
    issue(5, 'PARKED: needs a worktree'),
  ];
  const reads = [];
  const hydrated = await lib.fetchDrainIssuesWithComments(cases, {
    alreadyAttempted: new Set(['BRO-3']),
    getIssue: async (id) => { reads.push(id); return { ...cases[4], comments: { nodes: [{ body: VERIFY }] } }; },
  });
  assert.deepEqual(reads, ['BRO-5']);
  assert.deepEqual(lib.selectDrainCandidates(hydrated).map((i) => i.identifier), ['BRO-5']);
});

test('drain rechecks fresh state and fails closed on unreadable comments', async () => {
  const parked = issue(1, lib.AUTO_FILED_MARKER + VERIFY);
  for (const getIssue of [
    async () => null,
    async () => { throw new Error('offline'); },
    async () => ({ ...parked, state: { type: 'started' } }),
    async () => ({ ...parked, comments: { nodes: [{ body: 'VERIFY: owner-judgment' }] } }),
  ]) {
    const hydrated = await lib.fetchDrainIssuesWithComments([parked], { getIssue });
    assert.deepEqual(lib.selectDrainCandidates(hydrated), []);
  }
});

// BRO-6080: mac-only Todo cards (label or MAC-ONLY line) are drain-eligible.
test('BRO-6080: mac-only Todo cards are selected at any triaged priority, with --mac-headless', () => {
  const todo = { type: 'unstarted' };
  const label = { labels: { nodes: [{ name: 'Mac-Only' }] } };
  const line = `MAC-ONLY: renew the Stage cookie from the Mac keychain${VERIFY}`;
  const cards = [
    issue(10, `plain${VERIFY}`, { state: todo, ...label, priority: 4 }),
    issue(11, line, { state: todo, priority: 3 }),
    issue(12, line, { state: todo, priority: 0 }), // untriaged: never
    issue(13, line, { state: { type: 'backlog' } }), // parked/backlog: not this path
    issue(14, `MAC-ONLY: needs the Mac\n\nno verify here`, { state: todo }),
    issue(15, `NO-DISPATCH: hold\n${line}`, { state: todo }),
    issue(16, `${line}\nRun /visual-qa and get the owner's approval before pushing.`, { state: todo }), // a UI card is dispatchable now (BRO-6241)
    issue(17, `plain${VERIFY}`, { state: todo }), // ordinary Todo: cloud's, not the drain's
    issue(18, `Docs mention MAC-ONLY: mid-line${VERIFY}`, { state: todo }),
    issue(22, line, { state: todo, labels: { nodes: [{ name: 'mac-only' }, { name: 'awaiting-owner' }] } }), // owner hold
    issue(23, `**MAC-ONLY:** needs the Mac launchd agent${VERIFY}`, { state: todo, ...label, priority: 1 }),
  ];
  // BRO-10 has the label only (older meaning: hands-on GUI work), so the unattended drain leaves it.
  assert.deepEqual(lib.selectDrainCandidates(cards, { limit: 20 }).map((i) => i.identifier), ['BRO-23', 'BRO-16', 'BRO-11']);
  assert.deepEqual(lib.drainDispatchOpts(cards[1]), { macHeadless: true });
  // An auto-filed tracker keeps its waivers; a MAC-ONLY line adds --mac-headless, a label alone does not.
  assert.deepEqual(lib.drainDispatchOpts(issue(19, lib.AUTO_FILED_MARKER + VERIFY, label)), { allowAutofixFiled: true, allowAutomationParked: true });
  assert.deepEqual(lib.drainDispatchOpts(issue(24, `MAC-ONLY: reads the Mac keychain\n${lib.AUTO_FILED_MARKER}${VERIFY}`, label)),
    { allowAutofixFiled: true, allowAutomationParked: true, macHeadless: true });
});

test('BRO-6080: the comment shortlist includes mac-only Todo cards', async () => {
  const seen = [];
  const cards = [issue(20, `MAC-ONLY: needs the Mac launchd${VERIFY}`, { state: { type: 'unstarted' } }), issue(21, `plain${VERIFY}`, { state: { type: 'unstarted' } })];
  await lib.fetchDrainIssuesWithComments(cards, { getIssue: async (id) => { seen.push(id); return cards.find((c) => c.identifier === id); }, log: () => {} });
  assert.deepEqual(seen, ['BRO-20']);
});
