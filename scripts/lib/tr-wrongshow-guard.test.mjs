/**
 * Regression test for card #1227: TR's wrong-show mention-count guard
 * false-rejected 6 real T1/T2 reviews of "Barcelona" (barcelona-west-end-2024)
 * because the single-word, common-word title rarely repeats in prose that
 * mostly says "the play"/"the production". Per CLAUDE.md rule 15 this
 * require()s the real predicates — no logic is copied.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  checkWrongShowMentionGuard,
  checkFilmTvGuard,
  isCorroboratedByRoundup,
} = require('./tr-wrongshow-guard.js');

// Real Guardian review prose style: the show title appears once (near the
// top) and the rest refers to "the play"/"it" — this is the exact shape
// that lost guardian--chris-wiegand in run 31394858905.
const BARCELONA_REVIEW = `
Barcelona review — a fitful romance under a false name

Bartlett Sher's revival of Bess Wohl's two-hander opens with a one-night stand
that curdles fast. The play is at its best when the two actors are simply
circling each other in the dark; the production leans hard on its twist, and
not every scene earns the tension it reaches for. Still, a sharp, tightly
wound 80 minutes.
`;

const SIX_REVIEW = `
Six the Musical review — the queens are back

Six returns to the West End with its pop-concert energy undimmed. Six
sisters, six queens, six killer numbers — the show still lands every beat.
`;

test('checkWrongShowMentionGuard: single-word common-word title with 1 mention fails the raw heuristic', () => {
  const show = { title: 'Barcelona' };
  const result = checkWrongShowMentionGuard(show, BARCELONA_REVIEW);
  assert.equal(result.fails, true);
  assert.equal(result.mentions, 1);
  assert.equal(result.minMentions, 2);
});

test('checkWrongShowMentionGuard: multi-word distinctive title with 1+ mentions passes', () => {
  const show = { title: 'Six the Musical' };
  const result = checkWrongShowMentionGuard(show, SIX_REVIEW);
  assert.equal(result.fails, false);
});

test('checkFilmTvGuard: flags a film/TV signal phrase', () => {
  const text = 'Also in cinemas this month is the Dr Strangelove adaptation.';
  const result = checkFilmTvGuard(text);
  assert.equal(result.fails, true);
});

test('checkFilmTvGuard: clean theatre review passes', () => {
  const result = checkFilmTvGuard(BARCELONA_REVIEW);
  assert.equal(result.fails, false);
});

test('isCorroboratedByRoundup: matching critic+outlet in an independent roundup corroborates', () => {
  const rows = [
    { outlet: 'Guardian', critic: 'Chris Wiegand', stars: 2 },
    { outlet: 'Financial Times', critic: 'Sarah Hemming', stars: 3 },
  ];
  assert.equal(isCorroboratedByRoundup('Guardian', 'Chris Wiegand', rows), true);
});

test('isCorroboratedByRoundup: outlet alias variants still match (The Guardian vs Guardian)', () => {
  const rows = [{ outlet: 'The Guardian', critic: 'Chris Wiegand', stars: 2 }];
  assert.equal(isCorroboratedByRoundup('Guardian', 'Chris Wiegand', rows), true);
});

test('isCorroboratedByRoundup: no matching row does not corroborate', () => {
  const rows = [{ outlet: 'Financial Times', critic: 'Sarah Hemming', stars: 3 }];
  assert.equal(isCorroboratedByRoundup('Guardian', 'Chris Wiegand', rows), false);
});

test('isCorroboratedByRoundup: empty/missing roundup never corroborates', () => {
  assert.equal(isCorroboratedByRoundup('Guardian', 'Chris Wiegand', []), false);
  assert.equal(isCorroboratedByRoundup('Guardian', 'Chris Wiegand', null), false);
});

test('isCorroboratedByRoundup: table-format rows (critic always "Unknown") still corroborate on outlet match', () => {
  // wet-roundup-discover.js's table-format parser (tried first) never resolves
  // a critic name — every row comes back critic:'Unknown'. Corroboration must
  // not silently no-op for these; outlet alone is still independent evidence
  // since the row is already title-scoped to this show.
  const tableFormatRows = [
    { outlet: 'Guardian', stars: 2, critic: 'Unknown' },
    { outlet: 'Financial Times', stars: 3, critic: 'Unknown' },
  ];
  assert.equal(isCorroboratedByRoundup('Guardian', 'Chris Wiegand', tableFormatRows), true);
  assert.equal(isCorroboratedByRoundup('The Stage', 'Tom Wicker', tableFormatRows), false);
});

test('isCorroboratedByRoundup: an unresolved REVIEW-side critic never corroborates on outlet alone', () => {
  // A misfiled/unattributed TR review (critic byline missing or unparseable)
  // must not slide through just because the outlet happens to have SOME
  // reviewer in the roundup — that's a materially weaker claim than the
  // WET-side 'Unknown' case above, which is a known parser limitation, not a
  // missing signal about this specific review.
  const rows = [{ outlet: 'Guardian', critic: 'Chris Wiegand', stars: 2 }];
  assert.equal(isCorroboratedByRoundup('Guardian', null, rows), false);
  assert.equal(isCorroboratedByRoundup('Guardian', '', rows), false);
});

test('end-to-end shape: Barcelona guardian review fails the raw guard but is rescued by roundup corroboration', () => {
  const show = { title: 'Barcelona' };
  const mentionCheck = checkWrongShowMentionGuard(show, BARCELONA_REVIEW);
  assert.equal(mentionCheck.fails, true, 'precondition: the raw heuristic still false-rejects');

  const roundupRows = [{ outlet: 'Guardian', critic: 'Chris Wiegand', stars: 2 }];
  const corroborated = isCorroboratedByRoundup('Guardian', 'Chris Wiegand', roundupRows);
  assert.equal(corroborated, true, 'the extractor should NOT skip this review once corroborated');
});
