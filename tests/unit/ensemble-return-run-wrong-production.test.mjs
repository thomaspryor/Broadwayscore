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
    assert.match(note, /No[ëe]l Coward Theatre \(2025-04-14 to 2025-08-03\)/);
    assert.match(note, /RETURN ENGAGEMENT/);
    assert.match(note, /return, transfer or revival/i);
    assert.match(note, /Do NOT flag it wrong_production merely because the show also played the earlier run/);
  });

  test('earlier-staging exclusion is intact (2025 reviews still wrong_production)', () => {
    const note = buildPriorRunsNote(PRIOR_RUNS);
    assert.match(note, /Any other staging .* is wrong_production/);
    assert.doesNotMatch(note, /for the declared earlier run only, flag it/, 'must not reject reviews of a declared run that matches a listed venue and date range');
    assert.match(note, /matches a listed venue AND falls within that leg's date range/);
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
