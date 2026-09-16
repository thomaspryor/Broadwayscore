/**
 * Unit tests for BRO-1397 — prior-run review display: label run/date and
 * suppress former-cast pull-quotes.
 *
 * Covers:
 *  - excerptMentionsFormerCast (scripts/lib/excerpt-validation.js) — the
 *    selectBestExcerpt() guard that suppresses a candidate quote naming a
 *    departed cast member from a returning production's earlier run.
 *  - getPriorRunLabel (scripts/lib/prior-run-label.js) — the display label
 *    ("2022 Gielgud run") shown on a review that belongs to that window.
 *
 * Fixture mirrors the real bug (BRO-1397): To Kill a Mockingbird West End
 * 2026 re-includes reviews from its 2022 Gielgud run, whose former lead
 * (Rafe Spall) isn't in the 2026 cast (Richard Coyle).
 *
 * Run: node --test tests/unit/prior-run-review-display.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { excerptMentionsFormerCast } = require('../../scripts/lib/excerpt-validation');
const { getPriorRunLabel } = require('../../scripts/lib/prior-run-label');

const SHOW = {
  id: 'to-kill-a-mockingbird-west-end-2026',
  title: 'To Kill a Mockingbird',
  venue: "Wyndham's Theatre",
  cast: [
    { name: 'Richard Coyle', role: 'Atticus Finch' },
    { name: 'Evie Hargreaves', role: 'Mayella Ewell' },
    { name: 'Stephen Boxer', role: 'Judge Taylor' },
  ],
  creativeTeam: [
    { name: 'Bartlett Sher', role: 'Director' },
    { name: 'Aaron Sorkin', role: 'Playwright' },
  ],
  priorRuns: [
    { openingDate: '2022-03-01', closingDate: '2023-05-31', venue: 'Gielgud Theatre' },
  ],
};

// A show with no priorRuns declared at all — the guard must never engage.
const SHOW_NO_PRIOR_RUNS = { ...SHOW, priorRuns: undefined };

describe('excerptMentionsFormerCast', () => {
  it('flags a full-name mention of a former lead near the current role name', () => {
    const excerpt = 'Rafe Spall is sensational as Atticus Finch.';
    // The candidate excerpt itself is one of the scanned fields (mirrors a
    // real review file, where llmPullQuote is both the candidate AND part
    // of the file's own evidence) — "Atticus Finch" sits right next to
    // "Rafe Spall", the positive role-proximity signal the guard requires.
    const reviewData = { publishDate: '2022-04-01', llmPullQuote: excerpt };
    const res = excerptMentionsFormerCast(
      excerpt,
      { show: SHOW, reviewDate: '2022-04-01', reviewData }
    );
    assert.strictEqual(res.mentionsFormerCast, true);
  });

  it('flags a bare-surname mention using file-local evidence from fullText', () => {
    const reviewData = {
      publishDate: '2022-04-04',
      fullText: 'a tremendous performance from Rafe Spall inheriting the screen role as Atticus Finch.',
    };
    const res = excerptMentionsFormerCast(
      'Spall handles moral outrage with an understated command that invites empathy for this man on all fronts.',
      { show: SHOW, reviewDate: '2022-04-04', reviewData }
    );
    assert.strictEqual(res.mentionsFormerCast, true);
    assert.strictEqual(res.name, 'spall');
  });

  it('does not flag a current cast member mention outside any priorRuns window', () => {
    const reviewData = { publishDate: '2026-07-01', fullText: '' };
    const res = excerptMentionsFormerCast(
      "Richard Coyle's Atticus is a beacon of goodness.",
      { show: SHOW, reviewDate: '2026-07-01', reviewData }
    );
    assert.strictEqual(res.mentionsFormerCast, false);
  });

  it('does not flag a current cast member mention even INSIDE a priorRuns window', () => {
    // publishDate sits inside the 2022 window, and the excerpt itself sits
    // right next to a role name — the same positive-evidence shape that
    // flags a former lead. This must stay unflagged because the mentioned
    // person IS in show.cast, exercising buildSafeNameTokens' exclusion
    // rather than just the isWithinPriorRun early-exit.
    const excerpt = "Richard Coyle is sensational as Atticus Finch.";
    const reviewData = { publishDate: '2022-04-01', llmPullQuote: excerpt };
    const res = excerptMentionsFormerCast(
      excerpt,
      { show: SHOW, reviewDate: '2022-04-01', reviewData }
    );
    assert.strictEqual(res.mentionsFormerCast, false);
  });

  it('flags a hyphenated former-cast surname (UK/West End casts commonly hyphenate)', () => {
    const reviewData = {
      publishDate: '2022-04-04',
      fullText: 'a tremendous performance from Rafe Lloyd-Webber inheriting the screen role as Atticus Finch.',
    };
    const res = excerptMentionsFormerCast(
      'Lloyd-Webber handles moral outrage with an understated command.',
      { show: SHOW, reviewDate: '2022-04-04', reviewData }
    );
    assert.strictEqual(res.mentionsFormerCast, true);
    assert.strictEqual(res.name, 'lloyd-webber');
  });

  it('does not flag the creative team (director/writer persist across runs)', () => {
    const reviewData = { publishDate: '2022-04-01', fullText: '' };
    const res = excerptMentionsFormerCast(
      'Aaron Sorkin finds effective ways in his confident adaptation, working with director Bartlett Sher.',
      { show: SHOW, reviewDate: '2022-04-01', reviewData }
    );
    assert.strictEqual(res.mentionsFormerCast, false);
  });

  it('does not flag the literary source author even when a role name is nearby', () => {
    const reviewData = {
      publishDate: '2022-04-01',
      fullText: "a stage version of Harper Lee's 1960 novel, with Atticus Finch at its centre.",
    };
    const res = excerptMentionsFormerCast(
      "Harper Lee's 1960 novel To Kill a Mockingbird, finally here at the Gielgud from Broadway.",
      { show: SHOW, reviewDate: '2022-04-01', reviewData }
    );
    assert.strictEqual(res.mentionsFormerCast, false);
  });

  it('never flags a review outside any declared priorRuns window', () => {
    const reviewData = {
      publishDate: '2026-07-03',
      fullText: 'First seen in London in 2022 with Rafe Spall in the lead. Now with Richard Coyle.',
    };
    const res = excerptMentionsFormerCast(
      'Rafe Spall in the lead and then Matthew Modine — now with Richard Coyle.',
      { show: SHOW, reviewDate: '2026-07-03', reviewData }
    );
    assert.strictEqual(res.mentionsFormerCast, false);
  });

  it('never flags anything when the show declares no priorRuns', () => {
    const reviewData = { publishDate: '2022-04-01', fullText: '' };
    const res = excerptMentionsFormerCast(
      'Rafe Spall is stunning in new take on classic',
      { show: SHOW_NO_PRIOR_RUNS, reviewDate: '2022-04-01', reviewData }
    );
    assert.strictEqual(res.mentionsFormerCast, false);
  });

  it('returns false for a null/empty excerpt', () => {
    assert.strictEqual(
      excerptMentionsFormerCast(null, { show: SHOW, reviewDate: '2022-04-01', reviewData: {} }).mentionsFormerCast,
      false
    );
    assert.strictEqual(
      excerptMentionsFormerCast('', { show: SHOW, reviewDate: '2022-04-01', reviewData: {} }).mentionsFormerCast,
      false
    );
  });
});

describe('getPriorRunLabel', () => {
  it('labels a review inside the priorRuns window with year + venue', () => {
    assert.strictEqual(
      getPriorRunLabel(SHOW.priorRuns, '2022-04-01'),
      '2022 Gielgud run'
    );
  });

  it('returns null for a review outside any priorRuns window', () => {
    assert.strictEqual(getPriorRunLabel(SHOW.priorRuns, '2026-07-01'), null);
  });

  it('returns null when priorRuns is missing/empty', () => {
    assert.strictEqual(getPriorRunLabel(undefined, '2022-04-01'), null);
    assert.strictEqual(getPriorRunLabel([], '2022-04-01'), null);
  });

  it('falls back to a bare year label when the prior run has no venue', () => {
    const runs = [{ openingDate: '2019-01-01', closingDate: '2019-06-01' }];
    assert.strictEqual(getPriorRunLabel(runs, '2019-03-01'), '2019 run');
  });
});
