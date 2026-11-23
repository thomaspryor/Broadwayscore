/**
 * BRO-5299: the ensemble wrong_production check must not reject a review of a
 * RETURN engagement just because the show also played an earlier declared run.
 *
 * Case: the-comedy-about-spies-west-end-2026 (Adelphi, 2026) declares the 2025
 * Noel Coward run as a prior run (inheritReviews:false). A 2026 review saying
 * the show is "celebrating its return to the West End" was rejected as
 * wrong_production against the 2025 run. The gate is an LLM, so the decision
 * lives in the prompt context; this test drives the real context builders and
 * asserts the return-engagement rule is present AND the earlier-staging rule
 * (2025 reviews stay excluded) is intact. No LLM call is made.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
process.env.TS_NODE_PROJECT = new URL('../../scripts/tsconfig.json', import.meta.url).pathname;
require('ts-node/register');

const { buildPriorRunsNote } = require('../../scripts/lib/prior-runs-note');
const { buildScoringInput } = require('../../scripts/llm-scoring/input-builder');

const PRIOR_RUNS = [{
  openingDate: '2025-04-14',
  closingDate: '2025-08-03',
  venue: 'Noël Coward Theatre',
  note: 'Original run before the 2026 Adelphi return engagement',
  inheritReviews: false,
}];

const RETURN_REVIEW = 'The Comedy About Spies is celebrating its return to the West End, and the Adelphi Theatre '.repeat(1)
  + 'is the perfect home for its farce. '.repeat(20);

describe('prior-runs note: return engagement', () => {
  test('no priorRuns or only junk entries -> no note', () => {
    assert.equal(buildPriorRunsNote(undefined), null);
    assert.equal(buildPriorRunsNote([]), null);
    assert.equal(buildPriorRunsNote([null, 'x', 3]), null);
  });

  test('note names the earlier run and carries the return-engagement rule', () => {
    const note = buildPriorRunsNote(PRIOR_RUNS);
    assert.match(note, /No[ëe]l Coward Theatre \(2025-04-14 to 2025-08-03; review window 2025-04-14 to 2025-08-10\)/);
    assert.match(note, /RETURN ENGAGEMENT/);
    assert.match(note, /return, transfer or revival/i);
    assert.match(note, /Do NOT flag it wrong_production merely because the show also played the earlier run/);
  });

  test('earlier-staging exclusion is intact (2025 reviews still wrong_production)', () => {
    const note = buildPriorRunsNote(PRIOR_RUNS);
    assert.match(note, /Any other staging .* is wrong_production/);
    assert.doesNotMatch(note, /for the declared earlier run only, flag it/, 'must not reject reviews of a declared run that matches a listed venue and date range');
    // BRO-8093: an inheritReviews:false run is listed as a SEPARATE production, never as this one.
    assert.match(note, /SEPARATE production[^.]*No[ëe]l Coward/);
    assert.doesNotMatch(note, /This same production also played/);
  });

  test('buildScoringInput for the Adelphi return review includes the rule and the publish date', () => {
    const built = buildScoringInput({
      showId: 'the-comedy-about-spies-west-end-2026',
      showTitle: 'The Comedy About Spies',
      category: 'west-end',
      venue: 'Adelphi Theatre',
      publishDate: '2026-08-07',
      priorRuns: PRIOR_RUNS,
      fullText: RETURN_REVIEW,
    });
    assert.match(built.context, /Adelphi Theatre/);
    assert.match(built.context, /RETURN ENGAGEMENT/);
    assert.match(built.context, /Review published: 2026-08-07/);
  });

  test('no priorRuns -> no return rule (shows without prior runs unaffected)', () => {
    const built = buildScoringInput({
      showTitle: 'The Comedy About Spies',
      category: 'west-end',
      venue: 'Adelphi Theatre',
      fullText: RETURN_REVIEW,
    });
    assert.doesNotMatch(built.context, /RETURN ENGAGEMENT/);
  });
});

// BRO-8093: mexodus-off-broadway-2026 declares Audible's Minetta Lane run as a
// prior run (it transferred to the Daryl Roth). The ensemble rejected a
// 2025-10-04 Minetta Lane review as wrong_production because its note, unlike
// the collector's content-verifier hint, never said a declared-run review IS
// this production and overrides the rubric's "reject transfer productions".
describe('prior-runs note: declared earlier run of the same production (BRO-8093)', () => {
  const { DECLARED_RUN_AFFIRMATION } = require('../../scripts/lib/prior-runs-note');
  const { buildPriorRunHint } = require('../../scripts/lib/content-verifier.js');
  const MEXODUS_RUNS = [{ openingDate: '2025-09-09', venue: 'Minetta Lane Theatre' }];

  test('ensemble note affirms a declared-run review IS this production and overrides the transfer rule', () => {
    const note = buildPriorRunsNote(MEXODUS_RUNS);
    assert.match(note, /This same production also played declared earlier runs\/tour legs: Minetta Lane Theatre \(2025-09-09 to unknown; review window 2025-09-09 to 2026-03-08\)/);
    assert.ok(note.includes(DECLARED_RUN_AFFIRMATION), 'ensemble note must carry the shared affirmation');
    assert.match(note, /IS a review of THIS production: do NOT reject it as wrong_production/);
    assert.match(note, /transfer or earlier venue a different production/);
    assert.match(note, /outside every listed window is not covered/);
  });

  test('ensemble note and content-verifier hint share the same affirmation (no drift)', () => {
    assert.ok(buildPriorRunHint(MEXODUS_RUNS, null).includes(DECLARED_RUN_AFFIRMATION), 'content-verifier hint must carry the shared affirmation');
    assert.ok(buildPriorRunsNote(MEXODUS_RUNS).includes(DECLARED_RUN_AFFIRMATION));
  });

  test('buildScoringInput for the mexodus Minetta Lane review carries the affirmation', () => {
    const built = buildScoringInput({
      showId: 'mexodus-off-broadway-2026', showTitle: 'Mexodus', category: 'off-broadway',
      venue: 'Daryl Roth Theatre', publishDate: '2025-10-04', priorRuns: MEXODUS_RUNS,
      fullText: 'Mexodus at Audible\'s Minetta Lane Theater is a thrilling two-man musical. '.repeat(20),
    });
    assert.ok(built.context.includes(DECLARED_RUN_AFFIRMATION));
    assert.match(built.context, /Review published: 2025-10-04/);
  });

  test('a mix of inherited + opt-out runs lists each under the right heading', () => {
    const note = buildPriorRunsNote([
      { venue: 'Barbican', openingDate: '2022-10-08', closingDate: '2023-01-21' },
      { venue: 'Noel Coward', openingDate: '2025-04-14', closingDate: '2025-08-03', inheritReviews: false },
    ]);
    assert.match(note, /This same production also played declared earlier runs\/tour legs: Barbican \(2022-10-08 to 2023-01-21; review window 2022-10-08 to 2023-01-28\)\./);
    assert.match(note, /SEPARATE production[^:]*: Noel Coward/);
  });
});

// BRO-8093 ship-check: the window printed to the model must be exactly the one
// the deterministic guards (isWithinPriorRun) use, at both edges.
test('prompt review window matches isWithinPriorRun at both edges', () => {
  const { isWithinPriorRun, priorRunWindow } = require('../../scripts/lib/wrong-production-autoclear.js');
  for (const run of [
    { openingDate: '2025-09-09', venue: 'Minetta Lane Theatre' },
    { openingDate: '2022-10-08', closingDate: '2023-01-21', venue: 'Barbican' },
  ]) {
    const w = priorRunWindow(run);
    assert.ok(buildPriorRunsNote([run]).includes(`review window ${w.from} to ${w.to}`));
    const day = (iso, d) => new Date(Date.parse(iso) + d * 86400000).toISOString().slice(0, 10);
    assert.equal(isWithinPriorRun(w.from, [run]), true);
    assert.equal(isWithinPriorRun(w.to, [run]), true);
    assert.equal(isWithinPriorRun(day(w.from, -1), [run]), false);
    assert.equal(isWithinPriorRun(day(w.to, 1), [run]), false);
  }
});
