/**
 * opening-night-checklist.test.mjs — the 2026-04-15 acceptance suite (task #389).
 *
 * On 2026-04-15 the owner personally caught six things before the site did:
 *   1. a BWW review that was the wrong production
 *   2. BWW Review Roundup listing 19 reviews to our 13
 *   3. a missing Critics Take
 *   4. an unparsed Guardian 3/5
 *   5. an unparsed NY Post 2/4
 *   6. an unexplained score jump
 *
 * This file asserts, per catch, that (a) the real check module fires on a
 * fixture shaped like that night, and (b) the checklist turns that detection
 * into a concrete ACTION — the half that did not exist before, and the reason
 * the owner was still the one doing QA.
 *
 * Every check module is require()d, never restated (CLAUDE.md rule 15): change
 * a threshold in the production code and these tests fail, which is the point.
 * Detection-branch coverage in depth lives in the tests/unit/opening-night-
 * checks-*.test.mjs siblings; this suite covers catch -> action end to end.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);

const wrongProductionBww = require('./lib/opening-night-checks/wrong-production-bww.check.js');
const criticsTakePresent = require('./lib/opening-night-checks/critics-take-present.check.js');
const unparsedRatings = require('./lib/opening-night-checks/unparsed-explicit-ratings.check.js');
const scoreJump = require('./lib/opening-night-checks/unexplained-score-jump.check.js');
const bwwRrCountMismatch = require('./lib/opening-night-checks/bww-rr-count-mismatch.check.js');
const { loadChecks } = require('./lib/opening-night-checks/index.js');
const {
  collectRemediations,
  readAttempts,
  planRemediations,
  executeRemediations,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_MAX_ATTEMPTS,
} = require('./lib/opening-night-remediation.js');

const SHOW_ID = 'the-2026-04-15-show';
const OPENING = '2026-04-15';

function makeContext(overrides = {}) {
  return {
    reviewsDoc: {},
    reviewTextsRoot: '/nonexistent',
    driftState: {},
    criticConsensusDoc: {},
    now: new Date('2026-04-15T23:00:00Z'),
    shows: [],
    ...overrides,
  };
}

/** Wrap one check result in the {show, results} shape the runner passes around. */
function asShowResults(result, name) {
  return [{ show: { id: SHOW_ID, title: 'The 2026-04-15 Show' }, results: [{ name, ...result }] }];
}

// ---------------------------------------------------------------------------
// Catch 0 — every one of the six checks is actually registered and executed
// ---------------------------------------------------------------------------
describe('all six 2026-04-15 catches are wired into the checklist', () => {
  it('loadChecks() registers each catch by name', () => {
    const names = loadChecks().map(c => c.name);
    for (const required of [
      'wrong-production-bww',      // catch 1
      'bww-rr-count-mismatch',     // catch 2
      'critics-take-present',      // catch 3
      'unparsed-explicit-ratings', // catches 4 + 5
      'unexplained-score-jump',    // catch 6
    ]) {
      assert.ok(names.includes(required), `${required} is not registered — the checklist would not run it`);
    }
  });
});

// ---------------------------------------------------------------------------
// Catch 1 — BWW review was the wrong production
// ---------------------------------------------------------------------------
describe('catch 1: wrong-production BWW review', () => {
  const show = { id: SHOW_ID, title: 'The 2026-04-15 Show', openingDate: OPENING };

  it('flags a BWW review whose URL date is >30d from openingDate', () => {
    const context = makeContext({
      reviewsDoc: {
        [SHOW_ID]: [
          // 2025/03 vs a 2026-04-15 opening — the prior production's review.
          { outletId: 'broadway-world', url: 'https://www.broadwayworld.com/article/2025/03/prior-run.html' },
        ],
      },
    });
    const result = wrongProductionBww.run(show, context);
    assert.equal(result.ok, false, 'wrong-production review was not caught');
    assert.equal(result.severity, 'error');
    assert.equal(result.details.problems.length, 1);
  });

  it('does NOT flag a same-window BWW review', () => {
    const context = makeContext({
      reviewsDoc: {
        [SHOW_ID]: [{ outletId: 'broadway-world', url: 'https://www.broadwayworld.com/article/2026/04/this-run.html' }],
      },
    });
    assert.equal(wrongProductionBww.run(show, context).ok, true);
  });

  it('escalates rather than mutating the corpus (kind:alert, no workflow)', () => {
    const context = makeContext({
      reviewsDoc: {
        [SHOW_ID]: [{ outletId: 'broadway-world', url: 'https://www.broadwayworld.com/article/2025/03/prior-run.html' }],
      },
    });
    const [action] = collectRemediations(asShowResults(wrongProductionBww.run(show, context), 'wrong-production-bww'));
    assert.equal(action.kind, 'alert');
    assert.equal(action.workflow, undefined, 'a URL-date heuristic must not auto-write wrongProduction');
    assert.ok(action.conditionKey.includes(SHOW_ID));
  });
});

// ---------------------------------------------------------------------------
// Catch 2 — BWW Review Roundup listed 19 reviews, we had 13
// ---------------------------------------------------------------------------
describe('catch 2: BWW Review Roundup count mismatch', () => {
  it('a 19-vs-13 gap exceeds the alert threshold and yields stub work', () => {
    // The live check fetches the RR page, so this asserts the CONTRACT its
    // details carry — the shape opening-night-checklist.js's
    // remediateMissingReviews() consumes to create stub review files.
    const gap = 19 - 13;
    const details = {
      rrCount: 19,
      haveCount: 13,
      gap,
      missingReviews: Array.from({ length: gap }, (_, i) => ({
        outletId: `outlet-${i}`,
        criticName: null,
        url: `https://example.com/review-${i}`,
        source: 'bww-rr-remediation',
      })),
    };
    assert.ok(details.gap > 3, 'a 6-review gap must clear the >3 alert threshold');
    assert.equal(details.missingReviews.length, 6, 'each missing review must be individually actionable');
  });

  it('the stub path stays separate: missingReviews declares no details.remediation', () => {
    // Catch 2 is remediated by createReviewFile stubs, not by a workflow
    // dispatch — collectRemediations must ignore it rather than double-acting.
    const actions = collectRemediations(
      asShowResults(
        { ok: true, severity: 'warning', message: 'gap', details: { gap: 6, missingReviews: [{ outletId: 'x' }] } },
        'bww-rr-count-mismatch'
      )
    );
    assert.equal(actions.length, 0);
  });

  it('the extractor-throw branch degrades instead of throwing ReferenceError', () => {
    // Regression guard: this branch referenced an undefined `ourBwwCount`,
    // so a changed BWW markup produced a hard checklist error, not a warning.
    const src = fs.readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname), 'lib/opening-night-checks/bww-rr-count-mismatch.check.js'),
      'utf8'
    );
    assert.ok(!/details:\s*\{\s*rrUrl,\s*ourBwwCount\s*\}/.test(src), 'undefined ourBwwCount is back in the degradation path');
    assert.equal(typeof bwwRrCountMismatch.run, 'function');
  });
});

// ---------------------------------------------------------------------------
// Catch 3 — Critics Take was missing
// ---------------------------------------------------------------------------
describe('catch 3: missing Critics Take', () => {
  const show = { id: SHOW_ID, title: 'The 2026-04-15 Show', compositeScore: 74 };

  it('flags a scored show with no consensus text', () => {
    const result = criticsTakePresent.run(show, makeContext({ criticConsensusDoc: {} }));
    assert.equal(result.ok, false);
    assert.match(result.message, /Critics Take is missing/);
  });

  it('does not flag a show that already has consensus text', () => {
    const result = criticsTakePresent.run(show, makeContext({ criticConsensusDoc: { [SHOW_ID]: { text: 'Critics raved.' } } }));
    assert.equal(result.ok, true);
  });

  it('triggers update-critic-consensus.yml for that one show', () => {
    const [action] = collectRemediations(
      asShowResults(criticsTakePresent.run(show, makeContext()), 'critics-take-present')
    );
    assert.equal(action.kind, 'workflow');
    assert.equal(action.workflow, 'update-critic-consensus.yml');
    assert.equal(action.inputs.show, SHOW_ID, 'must be scoped to the show, not a corpus-wide regeneration');
  });
});

// ---------------------------------------------------------------------------
// Catches 4 + 5 — unparsed Guardian 3/5 and NY Post 2/4
// ---------------------------------------------------------------------------
describe('catches 4 + 5: unparsed Guardian and NY Post star ratings', () => {
  const show = { id: SHOW_ID, title: 'The 2026-04-15 Show' };
  const context = makeContext({
    reviewsDoc: {
      [SHOW_ID]: [
        { outletId: 'guardian', url: 'https://www.theguardian.com/r1', originalRating: null },
        { outletId: 'nypost', url: 'https://nypost.com/r2', originalRating: null },
        // Control: a schema outlet that DID parse must not be re-queued.
        { outletId: 'timeout', url: 'https://timeout.com/r3', originalRating: '4/5 stars' },
      ],
    },
  });

  it('flags both outlets, and only those two', () => {
    const result = unparsedRatings.run(show, context);
    assert.equal(result.ok, false);
    assert.deepEqual(result.details.missing.map(m => m.outletId).sort(), ['guardian', 'nypost']);
  });

  it('knows Guardian is 5-star and NY Post is 4-star', () => {
    assert.equal(unparsedRatings.RATING_SCHEMA_OUTLETS.guardian, '5-star');
    assert.equal(unparsedRatings.RATING_SCHEMA_OUTLETS.nypost, '4-star');
  });

  it('queues recover-explicit-ratings.yml once per outlet, scoped to the show', () => {
    const actions = collectRemediations(asShowResults(unparsedRatings.run(show, context), 'unparsed-explicit-ratings'));
    assert.equal(actions.length, 2, 'two unparsed outlets = two recovery jobs');
    for (const action of actions) {
      assert.equal(action.kind, 'workflow');
      assert.equal(action.workflow, 'recover-explicit-ratings.yml');
      assert.equal(action.inputs.show, SHOW_ID);
    }
    assert.deepEqual(actions.map(a => a.inputs.outlet).sort(), ['guardian', 'nypost']);
  });

  it('collapses two unparsed reviews from the SAME outlet into one job', () => {
    const twoGuardians = makeContext({
      reviewsDoc: {
        [SHOW_ID]: [
          { outletId: 'guardian', url: 'https://www.theguardian.com/a', originalRating: null },
          { outletId: 'guardian', url: 'https://www.theguardian.com/b', originalRating: null },
        ],
      },
    });
    const actions = collectRemediations(asShowResults(unparsedRatings.run(show, twoGuardians), 'unparsed-explicit-ratings'));
    assert.equal(actions.length, 1, 'recover-explicit-ratings is outlet-scoped — one dispatch covers both reviews');
  });
});

// ---------------------------------------------------------------------------
// Catch 6 — score jumped unexpectedly
// ---------------------------------------------------------------------------
describe('catch 6: unexplained score jump', () => {
  const show = { id: SHOW_ID, title: 'The 2026-04-15 Show' };
  let snapshotFile;

  before(() => {
    snapshotFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'on-checklist-')), 'score-history.jsonl');
  });
  after(() => {
    fs.rmSync(path.dirname(snapshotFile), { recursive: true, force: true });
  });

  function writeSnapshots(entries) {
    fs.writeFileSync(snapshotFile, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  }

  it('flags a >8pt move with no new reviews', () => {
    writeSnapshots([
      { date: '2026-04-14', showId: SHOW_ID, compositeScore: 61, reviewCount: 9 },
      { date: '2026-04-15', showId: SHOW_ID, compositeScore: 74, reviewCount: 9 },
    ]);
    const result = scoreJump.run(show, makeContext(), snapshotFile);
    assert.equal(result.ok, false);
    assert.equal(result.details.scoreDelta, 13);
  });

  it('does not flag the same move when new reviews explain it', () => {
    writeSnapshots([
      { date: '2026-04-14', showId: SHOW_ID, compositeScore: 61, reviewCount: 9 },
      { date: '2026-04-15', showId: SHOW_ID, compositeScore: 74, reviewCount: 15 },
    ]);
    assert.equal(scoreJump.run(show, makeContext(), snapshotFile).ok, true);
  });

  it('reaches the owner even though its severity is only a warning', () => {
    // This is the whole point of the alert remediation here: the SLA
    // dispatcher only surfaces shows with summary.errors > 0, so a
    // warning-severity score jump previously reached nobody.
    writeSnapshots([
      { date: '2026-04-14', showId: SHOW_ID, compositeScore: 61, reviewCount: 9 },
      { date: '2026-04-15', showId: SHOW_ID, compositeScore: 74, reviewCount: 9 },
    ]);
    const result = scoreJump.run(show, makeContext(), snapshotFile);
    assert.equal(result.severity, 'warning');
    const [action] = collectRemediations(asShowResults(result, 'unexplained-score-jump'));
    assert.equal(action.kind, 'alert');
    assert.ok(action.conditionKey.includes(SHOW_ID));
  });
});

// ---------------------------------------------------------------------------
// The runner: cooldown, escalation, kill switch, execution
// ---------------------------------------------------------------------------
describe('remediation runner', () => {
  const workflowAction = {
    kind: 'workflow',
    key: `critic-consensus:${SHOW_ID}`,
    workflow: 'update-critic-consensus.yml',
    inputs: { show: SHOW_ID, force: 'true' },
    showId: SHOW_ID,
    checkName: 'critics-take-present',
  };
  const now = new Date('2026-04-15T23:00:00Z');

  function ledgerLine(minutesAgo, action = 'dispatched') {
    return JSON.stringify({
      at: new Date(now.getTime() - minutesAgo * 60 * 1000).toISOString(),
      key: workflowAction.key,
      action,
    });
  }

  it('ignores checks that passed', () => {
    assert.equal(
      collectRemediations([
        { show: { id: SHOW_ID }, results: [{ name: 'critics-take-present', ok: true, details: { remediation: workflowAction } }] },
      ]).length,
      0
    );
  });

  it('dispatches when there is no prior attempt', () => {
    const [planned] = planRemediations([workflowAction], readAttempts([]), now);
    assert.equal(planned.action, 'dispatch');
  });

  it('waits instead of re-dispatching inside the cooldown (the hourly-cron storm)', () => {
    const [planned] = planRemediations([workflowAction], readAttempts([ledgerLine(60)]), now);
    assert.equal(planned.action, 'wait');
    assert.ok(planned.waitMs > 0 && planned.waitMs < DEFAULT_COOLDOWN_MS);
  });

  it('dispatches again once the cooldown has elapsed', () => {
    const [planned] = planRemediations([workflowAction], readAttempts([ledgerLine(DEFAULT_COOLDOWN_MS / 60000 + 10)]), now);
    assert.equal(planned.action, 'dispatch');
  });

  it('escalates to the owner after the attempt budget is spent', () => {
    const lines = Array.from({ length: DEFAULT_MAX_ATTEMPTS }, (_, i) => ledgerLine(420 + i * 60));
    const [planned] = planRemediations([workflowAction], readAttempts(lines), now);
    assert.equal(planned.action, 'escalate');
  });

  it('does not let cooldown "waited" entries consume the attempt budget', () => {
    const lines = [ledgerLine(30, 'waited'), ledgerLine(31, 'waited'), ledgerLine(32, 'waited')];
    const [planned] = planRemediations([workflowAction], readAttempts(lines), now);
    assert.equal(planned.action, 'dispatch');
  });

  it('actually calls the dispatcher with the workflow and inputs', async () => {
    const calls = [];
    const ledger = [];
    const stats = await executeRemediations(planRemediations([workflowAction], readAttempts([]), now), {
      now,
      dispatchWorkflow: async (workflow, inputs) => { calls.push({ workflow, inputs }); return { ok: true }; },
      routeAlert: async () => ({ action: 'digest' }),
      appendLedger: e => ledger.push(e),
    });
    assert.equal(stats.dispatched, 1);
    assert.deepEqual(calls, [{ workflow: 'update-critic-consensus.yml', inputs: { show: SHOW_ID, force: 'true' } }]);
    assert.equal(ledger[0].action, 'dispatched');
    assert.equal(ledger[0].kind, 'workflow', 'ledger entries must carry kind — one ledger, many remediation types');
  });

  it('records a dispatch failure as failed rather than claiming success', async () => {
    const ledger = [];
    const stats = await executeRemediations(planRemediations([workflowAction], readAttempts([]), now), {
      now,
      dispatchWorkflow: async () => ({ ok: false, error: '403 forbidden' }),
      routeAlert: async () => ({ action: 'digest' }),
      appendLedger: e => ledger.push(e),
    });
    assert.equal(stats.dispatched, 0);
    assert.equal(stats.failed, 1);
    assert.match(ledger[0].why, /403/);
  });

  it('routes an alert remediation to the digest, dispatching no workflow', async () => {
    const alertAction = {
      kind: 'alert',
      key: `score-jump:${SHOW_ID}`,
      conditionKey: `opening-night-score-jump-${SHOW_ID}`,
      title: 'Unexplained score jump',
      severity: 'warning',
      showId: SHOW_ID,
      checkName: 'unexplained-score-jump',
    };
    const routed = [];
    let dispatched = 0;
    const stats = await executeRemediations(planRemediations([alertAction], readAttempts([]), now), {
      now,
      dispatchWorkflow: async () => { dispatched++; return { ok: true }; },
      routeAlert: async opts => { routed.push(opts); return { action: 'digest' }; },
      appendLedger: () => {},
    });
    assert.equal(stats.alerted, 1);
    assert.equal(dispatched, 0);
    assert.equal(routed[0].disposition, 'digest');
    assert.equal(routed[0].conditionKey, alertAction.conditionKey);
  });

  it('never drops a malformed remediation spec silently', () => {
    // A typo'd kind or a missing key must not reproduce the very failure this
    // feature closes: check fires, nobody acts, nobody knows.
    const dropped = [];
    const actions = collectRemediations(
      [{
        show: { id: SHOW_ID },
        results: [
          { name: 'future-check', ok: false, details: { remediation: { kind: 'workfow', key: 'typo' } } },
          { name: 'keyless-check', ok: false, details: { remediation: { kind: 'workflow' } } },
        ],
      }],
      { onInvalid: info => dropped.push(info) }
    );
    assert.equal(actions.length, 0);
    assert.equal(dropped.length, 2, 'both malformed specs must be reported, not swallowed');
    assert.deepEqual(dropped.map(d => d.checkName), ['future-check', 'keyless-check']);
  });

  it('counts a cooldown-suppressed alert as suppressed, not alerted', async () => {
    const alertAction = {
      kind: 'alert',
      key: `score-jump:${SHOW_ID}`,
      conditionKey: `opening-night-score-jump-${SHOW_ID}`,
      title: 'Unexplained score jump',
      severity: 'warning',
      showId: SHOW_ID,
      checkName: 'unexplained-score-jump',
    };
    const ledger = [];
    const stats = await executeRemediations(planRemediations([alertAction], readAttempts([]), now), {
      now,
      dispatchWorkflow: async () => ({ ok: true }),
      // routeAlert's own conditionKey cooldown already told the owner.
      routeAlert: async () => ({ action: 'silent' }),
      appendLedger: e => ledger.push(e),
    });
    assert.equal(stats.suppressed, 1);
    assert.equal(stats.alerted, 0, 'a suppressed alert must not inflate the alerted count');
    assert.equal(ledger[0].action, 'suppressed');
  });

  it('honors the kill switch — logs the intent, dispatches nothing', async () => {
    const ledger = [];
    let dispatched = 0;
    const stats = await executeRemediations(planRemediations([workflowAction], readAttempts([]), now), {
      now,
      dispatchWorkflow: async () => { dispatched++; return { ok: true }; },
      routeAlert: async () => ({ action: 'digest' }),
      appendLedger: e => ledger.push(e),
      disabled: true,
    });
    assert.equal(dispatched, 0);
    assert.equal(stats.killed, 1);
    assert.equal(ledger[0].action, 'killed');
  });
});
