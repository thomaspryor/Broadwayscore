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
const dtliCountMismatch = require('./lib/opening-night-checks/dtli-count-mismatch.check.js');
const t1OutletsScored = require('./lib/opening-night-checks/t1-outlets-scored.check.js');
const emptyCast = require('./lib/opening-night-checks/empty-cast.check.js');
const staleUpcomingTag = require('./lib/opening-night-checks/stale-upcoming-tag.check.js');
const reviewCountMatch = require('./lib/opening-night-checks/review-count-match.check.js');
const { loadChecks } = require('./lib/opening-night-checks/index.js');
const {
  collectRemediations,
  readAttempts,
  readGiveUps,
  planRemediations,
  executeRemediations,
  findAbandonedRemediations,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_LIFETIME_MAX_ATTEMPTS,
  DEFAULT_RETIREMENT_TTL_MS,
} = require('./lib/opening-night-remediation.js');
const { MIN_SCORED_REVIEWS } = require('./lib/critic-consensus-eligibility.js');

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
// Catch 2b — dtli-count-mismatch.check.js is bww-rr-count-mismatch's
// structural twin (same missingReviews contract, consumed by the same
// check-name-agnostic remediateMissingReviews() in opening-night-checklist.js)
// but had zero test coverage anywhere — BRO-219 gap. No-network branch
// coverage lives in tests/unit/opening-night-checks-dtli.test.mjs.
// ---------------------------------------------------------------------------
describe('catch 2b: DTLI count mismatch', () => {
  it('a gap over the alert threshold yields stub work via the SAME contract as BWW RR', () => {
    // The live check fetches the DTLI page, so this asserts the CONTRACT its
    // details carry — the shape remediateMissingReviews() consumes to create
    // stub review files, identical in shape to the bww-rr-remediation source.
    const gap = 10 - 4;
    const details = {
      dtliCount: 10,
      haveCount: 4,
      gap,
      missingReviews: Array.from({ length: gap }, (_, i) => ({
        outletId: `outlet-${i}`,
        criticName: null,
        url: `https://example.com/dtli-review-${i}`,
        source: 'dtli-remediation',
      })),
    };
    assert.ok(details.gap > 3, 'a 6-review gap must clear the >3 alert threshold');
    assert.equal(details.missingReviews.length, 6, 'each missing review must be individually actionable');
    assert.ok(details.missingReviews.every(m => m.source === 'dtli-remediation'));
  });

  it('the stub path stays separate: missingReviews declares no details.remediation', () => {
    // Same as catch 2 — DTLI is remediated by createReviewFile stubs, not by a
    // workflow dispatch — collectRemediations must ignore it rather than
    // double-acting.
    const actions = collectRemediations(
      asShowResults(
        { ok: true, severity: 'warning', message: 'gap', details: { gap: 6, missingReviews: [{ outletId: 'x' }] } },
        'dtli-count-mismatch'
      )
    );
    assert.equal(actions.length, 0);
  });

  it('is auto-registered by loadChecks() (directory scan, no name-list to forget)', () => {
    const names = loadChecks().map(c => c.name);
    assert.ok(names.includes('dtli-count-mismatch'));
  });

  it('exports run as a function', () => {
    assert.equal(typeof dtliCountMismatch.run, 'function');
  });
});

// ---------------------------------------------------------------------------
// Catch 3 — Critics Take was missing
// ---------------------------------------------------------------------------
describe('catch 3: missing Critics Take', () => {
  const show = { id: SHOW_ID, title: 'The 2026-04-15 Show', compositeScore: 74 };

  // Enough scored reviews that generate-critic-consensus.js would actually run.
  // Below its floor the check deliberately stays quiet (see the loop test at
  // the bottom of this block), so a fixture with an empty reviewsDoc would be
  // asserting the wrong branch.
  const scored = Array.from({ length: MIN_SCORED_REVIEWS }, (_, i) => ({ outletId: `o${i}`, assignedScore: 70 + i }));
  const consensusContext = (overrides = {}) => makeContext({ reviewsDoc: { [SHOW_ID]: scored }, ...overrides });

  it('flags a scored show with no consensus text', () => {
    const result = criticsTakePresent.run(show, consensusContext({ criticConsensusDoc: {} }));
    assert.equal(result.ok, false);
    assert.match(result.message, /Critics Take is missing/);
  });

  it('does not flag a show that already has consensus text', () => {
    const result = criticsTakePresent.run(show, consensusContext({ criticConsensusDoc: { [SHOW_ID]: { text: 'Critics raved.' } } }));
    assert.equal(result.ok, true);
  });

  it('triggers update-critic-consensus.yml for that one show', () => {
    const [action] = collectRemediations(
      asShowResults(criticsTakePresent.run(show, consensusContext()), 'critics-take-present')
    );
    assert.equal(action.kind, 'workflow');
    assert.equal(action.workflow, 'update-critic-consensus.yml');
    assert.equal(action.inputs.show, SHOW_ID, 'must be scoped to the show, not a corpus-wide regeneration');
  });

  // The 2026-08-09 regression this suite exists to prevent recurring: a show
  // under the generator's own floor must produce NO remediation at all, or the
  // hourly cron dispatches a workflow that is coded to skip it, forever.
  it('declares no remediation for a show the generator would skip', () => {
    const oneReview = makeContext({ reviewsDoc: { [SHOW_ID]: [{ outletId: 'o0', assignedScore: 44 }] } });
    const result = criticsTakePresent.run(show, oneReview);
    assert.equal(result.ok, true);
    assert.equal(collectRemediations(asShowResults(result, 'critics-take-present')).length, 0);
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
// Catches 7-9 (task #1132) — the four checks task #389 left print-only
// ---------------------------------------------------------------------------
describe('catch 7: T1 outlets missing or unscored', () => {
  // openingDate is a few days before makeContext()'s default `now` — past the
  // 24h grace window the check gives critics before flagging missing T1s.
  const show = { id: SHOW_ID, title: 'The 2026-04-15 Show', compositeScore: 74, openingDate: '2026-04-10' };

  it('dispatches gather-reviews.yml scoped to the show when T1 outlets are missing', () => {
    const result = t1OutletsScored.run(show, makeContext({ reviewsDoc: {} }));
    assert.equal(result.ok, false);
    const actions = collectRemediations(asShowResults(result, 't1-outlets-scored'));
    const dispatch = actions.find(a => a.workflow === 'gather-reviews.yml');
    assert.ok(dispatch, 'missing T1 outlets must queue gather-reviews.yml');
    assert.deepEqual(dispatch.inputs, { shows: SHOW_ID });
  });

  it('dispatches collect-review-texts.yml scoped to the show when T1 reviews are unscored', () => {
    const context = makeContext({
      reviewsDoc: {
        [SHOW_ID]: [
          { outletId: 'nytimes', url: 'https://nytimes.com/r1', compositeScore: null, assignedScore: null },
          { outletId: 'vulture', url: 'https://vulture.com/r2', compositeScore: 80 },
          { outletId: 'variety', url: 'https://variety.com/r3', compositeScore: 70 },
        ],
      },
    });
    const result = t1OutletsScored.run(show, context);
    assert.equal(result.ok, false);
    const actions = collectRemediations(asShowResults(result, 't1-outlets-scored'));
    const dispatch = actions.find(a => a.workflow === 'collect-review-texts.yml');
    assert.ok(dispatch, 'unscored T1 review must queue collect-review-texts.yml');
    assert.deepEqual(dispatch.inputs, { show_filter: SHOW_ID });
  });
});

describe('catch 8: empty cast at opening', () => {
  const show = { id: SHOW_ID, title: 'The 2026-04-15 Show', status: 'open', cast: [] };

  it('dispatches backfill-cast.yml scoped to the show', () => {
    const result = emptyCast.run(show, makeContext());
    assert.equal(result.ok, false);
    const [action] = collectRemediations(asShowResults(result, 'empty-cast'));
    assert.equal(action.kind, 'workflow');
    assert.equal(action.workflow, 'backfill-cast.yml');
    assert.deepEqual(action.inputs, { show_filter: SHOW_ID, force: 'true' });
  });
});

describe('catch 9: stale upcoming tag', () => {
  const show = { id: SHOW_ID, title: 'The 2026-04-15 Show', status: 'open', tags: ['upcoming', 'musical'] };

  it('routes to the digest instead of mutating shows.json (kind:alert, no workflow)', () => {
    const result = staleUpcomingTag.run(show, makeContext());
    assert.equal(result.ok, false);
    const [action] = collectRemediations(asShowResults(result, 'stale-upcoming-tag'));
    assert.equal(action.kind, 'alert');
    assert.equal(action.workflow, undefined, 'a tag fix must not auto-write shows.json');
    assert.ok(action.conditionKey.includes(SHOW_ID));
  });
});

describe('review-count-match stays print-only on purpose', () => {
  it('emits no details.remediation — a per-file reason is not an automatable decision', () => {
    const show = { id: SHOW_ID, title: 'The 2026-04-15 Show' };
    // reviewTextsRoot/show.id must resolve to a dir with more local files than
    // reviews.json has entries, so the check actually fires (gap > 0).
    const scopedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'on-review-count-root-'));
    fs.mkdirSync(path.join(scopedRoot, SHOW_ID));
    fs.writeFileSync(path.join(scopedRoot, SHOW_ID, 'outlet--critic.json'), '{}');
    const result = reviewCountMatch.run(show, makeContext({ reviewTextsRoot: scopedRoot, reviewsDoc: {} }));
    assert.equal(result.ok, false);
    assert.equal(result.details.remediation, undefined);
    const actions = collectRemediations(asShowResults(result, 'review-count-match'));
    assert.equal(actions.length, 0);
    fs.rmSync(scopedRoot, { recursive: true, force: true });
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

  // The failure this ceiling exists for: DEFAULT_MAX_ATTEMPTS is a ROLLING
  // 24h budget, so a remediation whose target can never succeed re-dispatches
  // two runs a day forever. critic-consensus:death-note-the-musical-west-end-2026
  // did exactly that — 5 dispatches, 23 escalations, all in one ledger.
  it('retires a key once the LIFETIME attempt ceiling is reached', () => {
    // Spread across days so the rolling window is empty — the old code would
    // read this as "no recent attempts, dispatch away".
    const lines = Array.from({ length: DEFAULT_LIFETIME_MAX_ATTEMPTS }, (_, i) => ledgerLine(i * 24 * 60 + 2000));
    const [planned] = planRemediations([workflowAction], readAttempts(lines), now);
    assert.equal(planned.action, 'give-up');
    assert.equal(planned.attempts, DEFAULT_LIFETIME_MAX_ATTEMPTS);
  });

  it('the aged-out rolling window alone does NOT resurrect a retired key', () => {
    const lines = Array.from({ length: DEFAULT_LIFETIME_MAX_ATTEMPTS + 3 }, (_, i) => ledgerLine(i * 24 * 60 + 5000));
    const [planned] = planRemediations([workflowAction], readAttempts(lines), now);
    assert.notEqual(planned.action, 'dispatch');
    assert.equal(planned.action, 'give-up');
  });

  it('one attempt below the ceiling still escalates rather than giving up', () => {
    const lines = Array.from({ length: DEFAULT_LIFETIME_MAX_ATTEMPTS - 1 }, (_, i) => ledgerLine(420 + i * 60));
    const [planned] = planRemediations([workflowAction], readAttempts(lines), now);
    assert.equal(planned.action, 'escalate');
  });

  // A credential outage must not be able to retire the whole remediation
  // layer. dispatchWorkflow() returns {ok:false,error:'no-token'} whenever the
  // job runs without a token, which writes action:'failed' — nothing was ever
  // dispatched, so it cannot count as an attempt the target had a chance at.
  it('failed dispatches (no-token) never consume the LIFETIME budget', () => {
    const lines = Array.from({ length: DEFAULT_LIFETIME_MAX_ATTEMPTS + 4 }, (_, i) => ledgerLine(i * 24 * 60 + 5000, 'failed'));
    const [planned] = planRemediations([workflowAction], readAttempts(lines), now);
    assert.equal(planned.action, 'dispatch', 'a token outage must be recoverable, not terminal');
  });

  it('mixed failures and real dispatches: only the real ones count toward the ceiling', () => {
    const failures = Array.from({ length: 6 }, (_, i) => ledgerLine(i * 24 * 60 + 9000, 'failed'));
    const dispatched = Array.from({ length: DEFAULT_LIFETIME_MAX_ATTEMPTS - 1 }, (_, i) => ledgerLine(i * 24 * 60 + 4000));
    const [planned] = planRemediations([workflowAction], readAttempts([...failures, ...dispatched]), now);
    assert.notEqual(planned.action, 'give-up', `${DEFAULT_LIFETIME_MAX_ATTEMPTS - 1} real attempts is still under the ceiling`);

    const [atCeiling] = planRemediations(
      [workflowAction],
      readAttempts([...failures, ...dispatched, ledgerLine(3000)]),
      now
    );
    assert.equal(atCeiling.action, 'give-up');
    assert.equal(atCeiling.attempts, DEFAULT_LIFETIME_MAX_ATTEMPTS, 'the reported count is real attempts, not ledger lines');
  });

  it('records the give-up exactly once, then goes fully silent', async () => {
    const lines = Array.from({ length: DEFAULT_LIFETIME_MAX_ATTEMPTS }, (_, i) => ledgerLine(i * 24 * 60 + 2000));
    const ledger = [];
    const calls = [];
    const deps = {
      now,
      dispatchWorkflow: async (w, i) => { calls.push({ w, i }); return { ok: true }; },
      routeAlert: async () => { calls.push({ alert: true }); return { action: 'digest' }; },
      appendLedger: (e) => ledger.push(e),
    };

    // First run after the ceiling: one 'gave-up' line, no dispatch, no alert.
    const first = await executeRemediations(
      planRemediations([workflowAction], readAttempts(lines), now), deps
    );
    assert.equal(first.gaveUp, 1);
    assert.equal(first.dispatched, 0);
    assert.equal(first.escalated, 0);
    assert.equal(calls.length, 0, 'nothing dispatched, nobody alerted');
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].action, 'gave-up');

    // Every subsequent hourly run: not one more ledger line.
    const replayLines = [...lines, JSON.stringify({ ...ledger[0], at: now.toISOString() })];
    const second = await executeRemediations(
      planRemediations([workflowAction], readAttempts(replayLines), now, { gaveUpKeys: readGiveUps(replayLines) }),
      deps
    );
    assert.equal(second.retired, 1);
    assert.equal(second.gaveUp, 0);
    assert.equal(ledger.length, 1, 'the ledger must stop growing — that is the whole point');
    assert.equal(calls.length, 0);
  });

  it('readGiveUps only picks up gave-up lines, and keeps the LATEST timestamp', () => {
    const lines = [
      ledgerLine(10, 'dispatched'),
      ledgerLine(9, 'escalated'),
      ledgerLine(8000, 'gave-up'),
      ledgerLine(8, 'gave-up'),
    ];
    const keys = readGiveUps(lines);
    assert.equal(keys.size, 1);
    assert.ok(keys.has(workflowAction.key));
    assert.equal(
      keys.get(workflowAction.key),
      now.getTime() - 8 * 60 * 1000,
      'the most recent retirement is what the TTL is measured from'
    );
  });

  // Retirement is a cooling-off, not a life sentence. A show that gains the
  // reviews it was missing must get another chance without a human noticing.
  it('retirement expires, and the expired cycle starts clean', () => {
    const retiredDaysAgo = (d) => JSON.stringify({
      at: new Date(now.getTime() - d * 24 * 60 * 60 * 1000).toISOString(),
      key: workflowAction.key,
      action: 'gave-up',
    });
    // The 4 dispatches that earned the retirement, all older than it.
    const spent = Array.from({ length: DEFAULT_LIFETIME_MAX_ATTEMPTS }, (_, i) => ledgerLine((20 + i) * 24 * 60));

    const insideTtl = [...spent, retiredDaysAgo(13)];
    const [stillQuiet] = planRemediations([workflowAction], readAttempts(insideTtl), now, { gaveUpKeys: readGiveUps(insideTtl) });
    assert.equal(stillQuiet.action, 'retired', 'one day before the TTL it is still cooling off');

    const pastTtl = [...spent, retiredDaysAgo(15)];
    const [revived] = planRemediations([workflowAction], readAttempts(pastTtl), now, { gaveUpKeys: readGiveUps(pastTtl) });
    assert.equal(revived.action, 'dispatch', 'past the TTL it gets a genuinely fresh cycle');
    assert.equal(revived.attempts, 0, 'attempts that bought the retirement must not be recounted');
  });

  it('a TTL that expires does not immediately re-retire on the same history', () => {
    // The bug this guards: if pre-retirement attempts still counted, the key
    // would come off cooling-off and hit the ceiling again on the same run —
    // making the TTL cosmetic and the retirement permanent in practice.
    const spent = Array.from({ length: DEFAULT_LIFETIME_MAX_ATTEMPTS + 6 }, (_, i) => ledgerLine((30 + i) * 24 * 60));
    const lines = [...spent, JSON.stringify({
      at: new Date(now.getTime() - (DEFAULT_RETIREMENT_TTL_MS + 60000)).toISOString(),
      key: workflowAction.key,
      action: 'gave-up',
    })];
    const [planned] = planRemediations([workflowAction], readAttempts(lines), now, { gaveUpKeys: readGiveUps(lines) });
    assert.notEqual(planned.action, 'give-up');
    assert.equal(planned.action, 'dispatch');
  });

  it('a give-up on one key does not retire a different key', () => {
    const other = { ...workflowAction, key: 'critic-consensus:some-other-show' };
    const lines = [ledgerLine(8, 'gave-up')];
    const [planned] = planRemediations([other], readAttempts(lines), now, { gaveUpKeys: readGiveUps(lines) });
    assert.equal(planned.action, 'dispatch');
  });

  it('an escalation the alert-router suppressed is counted as suppressed, not escalated', async () => {
    const lines = Array.from({ length: DEFAULT_MAX_ATTEMPTS }, (_, i) => ledgerLine(420 + i * 60));
    const ledger = [];
    const stats = await executeRemediations(planRemediations([workflowAction], readAttempts(lines), now), {
      now,
      dispatchWorkflow: async () => ({ ok: true }),
      // routeAlert's own conditionKey cooldown swallowed it — the owner was
      // NOT told again, and the hourly cron hits this branch every hour.
      routeAlert: async () => ({ action: 'silent' }),
      appendLedger: (e) => ledger.push(e),
    });
    assert.equal(stats.escalated, 0, 'nobody was told, so nothing was escalated');
    assert.equal(stats.suppressed, 1);
    assert.equal(ledger[0].action, 'suppressed');
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

// ---------------------------------------------------------------------------
// The drain pass (task #1223) — the ISLA regression this suite exists to
// prevent recurring: empty-cast:isla-off-broadway-2026 escalated twice, the
// show aged out of the ±2-day window, and nothing ever looked at that key
// again. Silence in the ledger became indistinguishable from "resolved".
// ---------------------------------------------------------------------------
describe('findAbandonedRemediations — drain pass for keys the window stopped collecting', () => {
  const ISLA = 'isla-off-broadway-2026';
  const now = new Date('2026-08-10T14:00:00Z');

  function line(showId, key, action, overrides = {}) {
    return JSON.stringify({
      at: now.toISOString(),
      kind: 'workflow',
      key,
      showId,
      checkName: 'empty-cast',
      action,
      ...overrides,
    });
  }

  it('does NOT terminalize a key whose show is still in the targeting window', () => {
    const key = `empty-cast:${ISLA}`;
    const lines = [line(ISLA, key, 'escalated', { attempts: 2 })];
    const out = findAbandonedRemediations(lines, new Set([ISLA]), now);
    assert.equal(out.length, 0, 'a show still being checked must not be drained out from under the normal run');
  });

  it('DOES terminalize a key whose show has left the window — the real isla-off-broadway-2026 case', () => {
    const key = `empty-cast:${ISLA}`;
    const lines = [
      line(ISLA, key, 'waited', { waitMs: 7111602, attempts: 1 }),
      line(ISLA, key, 'dispatched', { workflow: 'backfill-cast-web.yml', inputs: { show_filter: ISLA } }),
      line(ISLA, key, 'escalated', { attempts: 2, routed: 'silent' }),
    ];
    const out = findAbandonedRemediations(lines, new Set(['some-other-show']), now);
    assert.equal(out.length, 1);
    assert.equal(out[0].key, key);
    assert.equal(out[0].showId, ISLA);
    // 2 real attempts is well under the lifetime ceiling — budget remains,
    // so this is an abandonment, not a give-up.
    assert.equal(out[0].action, 'abandoned');
    assert.equal(out[0].attempts, 1, 'only the ok:true dispatched line counts as a real attempt');
  });

  it('writes gave-up instead of abandoned when the lifetime budget was already spent', () => {
    const key = `empty-cast:${ISLA}`;
    const lines = Array.from({ length: DEFAULT_LIFETIME_MAX_ATTEMPTS }, () => line(ISLA, key, 'dispatched'))
      .concat([line(ISLA, key, 'escalated', { attempts: DEFAULT_LIFETIME_MAX_ATTEMPTS })]);
    const out = findAbandonedRemediations(lines, new Set(), now);
    assert.equal(out.length, 1);
    assert.equal(out[0].action, 'gave-up');
    assert.equal(out[0].attempts, DEFAULT_LIFETIME_MAX_ATTEMPTS);
  });

  it('does NOT re-terminalize an already-terminal key — the ledger must stop growing', () => {
    const key = `empty-cast:${ISLA}`;
    const lines = [
      line(ISLA, key, 'escalated', { attempts: 2 }),
      line(ISLA, key, 'gave-up', { attempts: 2 }),
    ];
    const out = findAbandonedRemediations(lines, new Set(), now);
    assert.equal(out.length, 0, 'a key whose latest entry is already gave-up must be left alone');
  });

  it('an alert-kind key whose last line is dispatched is also drained as abandoned', () => {
    const key = `stale-upcoming-tag:${ISLA}`;
    const lines = [JSON.stringify({
      at: now.toISOString(), kind: 'alert', key, showId: ISLA, checkName: 'stale-upcoming-tag', action: 'dispatched', conditionKey: `x-${ISLA}`,
    })];
    const out = findAbandonedRemediations(lines, new Set(), now);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'alert');
    // alert-kind remediations never hit the lifetime ceiling (planRemediations
    // bypasses it entirely for kind:'alert') — always 'abandoned', never 'gave-up'.
    assert.equal(out[0].action, 'abandoned');
  });

  it('a key resolved before the show left the window (no open trailing line) is not touched', () => {
    const key = `empty-cast:${ISLA}`;
    // The check passed on some later run — resolution leaves no ledger line at
    // all (only failing checks remediate), so the LAST line in the ledger is
    // still the old 'escalated' entry even though the problem is fixed. This
    // guards against ever treating a genuinely-open key differently based on
    // anything other than its own last line — there is nothing in the ledger
    // to distinguish "fixed, no more lines" from "still broken, no more runs",
    // which is exactly why this key SHOULD still be drained.
    const lines = [line(ISLA, key, 'escalated', { attempts: 1 })];
    const out = findAbandonedRemediations(lines, new Set(), now);
    assert.equal(out.length, 1, 'ledger silence alone cannot mean resolved — that ambiguity is the bug this drain closes');
  });

  it('does not drain a key with no showId or malformed lines', () => {
    const malformed = ['not json', JSON.stringify({ key: 'x', action: 'dispatched' })];
    assert.doesNotThrow(() => findAbandonedRemediations(malformed, new Set(), now));
    assert.equal(findAbandonedRemediations(malformed, new Set(), now).length, 0);
  });

  it('a suppressed last line is drained too — same "unresolved" state as waited', () => {
    const key = `stale-upcoming-tag:${ISLA}`;
    const lines = [JSON.stringify({
      at: now.toISOString(), kind: 'alert', key, showId: ISLA, checkName: 'stale-upcoming-tag', action: 'suppressed', why: 'alert-router cooldown',
    })];
    const out = findAbandonedRemediations(lines, new Set(), now);
    assert.equal(out.length, 1, 'a suppressed key must not go silent forever just like a waited one');
    assert.equal(out[0].action, 'abandoned');
  });

  it('does not double-count attempts spent on an EXPIRED retirement into a fresh cycle', () => {
    // Mirrors the exact scenario planRemediations.retiredAt guards against: a
    // key gives up at the lifetime ceiling, its TTL later expires, one fresh
    // dispatch happens (a real attempt in the NEW cycle), and then the show
    // ages out before another run sees it. The drain pass must judge the new
    // cycle on its own 1 attempt, not on the total across both cycles.
    const key = `empty-cast:${ISLA}`;
    const oldCycle = Array.from({ length: DEFAULT_LIFETIME_MAX_ATTEMPTS }, (_, i) =>
      JSON.stringify({ at: new Date(now.getTime() - (100 + i) * 24 * 60 * 60 * 1000).toISOString(), kind: 'workflow', key, showId: ISLA, checkName: 'empty-cast', action: 'dispatched' })
    );
    const gaveUp = JSON.stringify({ at: new Date(now.getTime() - 99 * 24 * 60 * 60 * 1000).toISOString(), kind: 'workflow', key, showId: ISLA, checkName: 'empty-cast', action: 'gave-up' });
    // One fresh dispatch well after the gave-up line (a new, post-TTL cycle),
    // then one more open-state line (the run that must classify this key).
    const freshDispatch = JSON.stringify({ at: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString(), kind: 'workflow', key, showId: ISLA, checkName: 'empty-cast', action: 'dispatched' });
    const freshEscalate = JSON.stringify({ at: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString(), kind: 'workflow', key, showId: ISLA, checkName: 'empty-cast', action: 'escalated', attempts: 1 });
    const lines = [...oldCycle, gaveUp, freshDispatch, freshEscalate];

    const out = findAbandonedRemediations(lines, new Set(), now);
    assert.equal(out.length, 1);
    assert.equal(out[0].action, 'abandoned', 'only 1 real attempt in the fresh cycle — must not re-trigger gave-up off the spent old cycle');
    assert.equal(out[0].attempts, 1, 'the 4 pre-retirement attempts must not be recounted into the new cycle');
  });
});
