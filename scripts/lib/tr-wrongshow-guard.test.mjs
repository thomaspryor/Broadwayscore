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

// Same review with the single title mention pushed past the opening: the
// 2-mention floor still applies here, so roundup corroboration is still the
// only rescue (the #1227 path).
const BARCELONA_MIDTEXT = `
A fitful romance under a false name. ${'The play circles its two leads in the dark. '.repeat(10)}
Bess Wohl's Barcelona leans hard on its twist.
`;

const SIX_REVIEW = `
Six the Musical review — the queens are back

Six returns to the West End with its pop-concert energy undimmed. Six
sisters, six queens, six killer numbers — the show still lands every beat.
`;

test('checkWrongShowMentionGuard: single-word common-word title with 1 mention fails the raw heuristic', () => {
  const show = { title: 'Barcelona' };
  const result = checkWrongShowMentionGuard(show, BARCELONA_MIDTEXT);
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
  const mentionCheck = checkWrongShowMentionGuard(show, BARCELONA_MIDTEXT);
  assert.equal(mentionCheck.fails, true, 'precondition: the raw heuristic still false-rejects');

  const roundupRows = [{ outlet: 'Guardian', critic: 'Chris Wiegand', stars: 2 }];
  const corroborated = isCorroboratedByRoundup('Guardian', 'Chris Wiegand', roundupRows);
  assert.equal(corroborated, true, 'the extractor should NOT skip this review once corroborated');
});

// 2026-09-24: the daily TR run dropped real Golden Boy (Daily Mail, Times,
// Spectator), Avenue Q, Beetlejuice and The Children reviews as "wrong-show
// (only 1 title mention)". A proper-name title in the opening now suffices.
test('proper-name title in the opening passes with one mention (Golden Boy / Avenue Q / The Children)', () => {
  const cases = [
    ['Golden Boy', "PATRICK MARMION. JOSH O'Connor has an unusual conflict of interest in Clifford Odets' 1937 drama Golden Boy: play the violin or become a prize boxer."],
    ['Avenue Q', 'AVENUE Q, Shaftesbury Theatre. The puppets are back and ruder than ever.'],
    ['The Children', "Lucy Kirkwood's The Children returns to the stage with a nuclear engineer couple."],
  ];
  for (const [title, text] of cases) {
    const r = checkWrongShowMentionGuard({ title }, text);
    assert.equal(r.fails, false, `${title} should pass`);
    assert.equal(r.openingProperName, true);
  }
});

test('proper-name rule does not rescue short titles, generic lowercase prose, or a late mention', () => {
  assert.equal(checkWrongShowMentionGuard({ title: 'Cats' }, 'Cats review. The show purrs along.').fails, true);
  assert.equal(checkWrongShowMentionGuard({ title: 'The Children' }, 'A Matilda review: the children steal it.').fails, true);
  const late = 'A boxing drama. ' + 'The cast is strong. '.repeat(30) + 'Golden Boy it is not.';
  assert.equal(checkWrongShowMentionGuard({ title: 'Golden Boy' }, late).fails, true);
});

test('single-word titles need ALL CAPS or quotes; hyphen/possessive and punctuation handled', () => {
  const g = (title, text) => checkWrongShowMentionGuard({ title }, text).fails;
  assert.equal(g('Company', 'The Royal Shakespeare Company revival of Twelfth Night is fun.'), true);
  assert.equal(g('Chicago', 'This Chicago-born playwright returns.'), true);
  assert.equal(g('Beetlejuice', 'BEETLEJUICE, Prince Edward Theatre. Loud and silly.'), false);
  assert.equal(g('Beetlejuice', "The musical 'Beetlejuice' arrives in London."), false);
  assert.equal(g('Golden Boy', "Golden Boy's revival at the Almeida is a knockout."), true);
  assert.equal(g('Oh, Mary!', 'Oh Mary! transfers from Broadway with Cole Escola.'), false);
  assert.equal(g('Les Misérables', 'LES MISERABLES at the Sondheim is as grand as ever.'), false);
});

test('review round 2: caps possessive, quoted-with-comma, words split across lines', () => {
  const g = (title, text) => checkWrongShowMentionGuard({ title }, text).fails;
  assert.equal(g('Golden Boy', "GOLDEN BOY'S revival is loud."), true);
  assert.equal(g('Beetlejuice', '“Beetlejuice,” the new musical, arrives.'), false);
  assert.equal(g('Golden Boy', 'Golden.\n\n\n\nBoy was the old headline.'), true);
});

// BRO-4152 (2026-09-24 TR sweep): under-6-char and single-word titles were
// dropped even when the review opens "[Title] is/opens/remains ..." — the
// exact Daily Mail/Theatre Record house style confirmed in real saved
// reviews (Crazy For You, The Story). A leading-position match now rescues
// these regardless of title length, gated on a substantive continuation so
// a bare headline label can't slide through under the same rule.
test('title as the review\'s literal first word(s) rescues under-6-char and single-word titles', () => {
  const g = (title, text) => checkWrongShowMentionGuard({ title }, text).fails;
  assert.equal(g('Mass', 'Mass is a blistering hour of new writing at the Almeida.'), false);
  assert.equal(g('Pride', 'Pride opens with a burst of colour and noise on the Southbank.'), false);
  assert.equal(g('Relics', 'Relics is a haunting exploration of grief and memory.'), false);
  assert.equal(g('Arcadia', "Arcadia remains one of Stoppard's finest achievements."), false);
});

test('leading-position rule still rejects bare headline labels and non-leading mentions', () => {
  const g = (title, text) => checkWrongShowMentionGuard({ title }, text).fails;
  // "Cats review." is a bare headline label (1-word continuation) — must not
  // rescue just because the title happens to lead the text.
  assert.equal(g('Cats', 'Cats review. The show purrs along.'), true);
  // Title present but not leading — the fallback still requires position 0.
  assert.equal(g('Mass', 'A blistering hour of new writing. Mass is what they call it.'), true);
  // Possessive directly after the title at position 0 still excluded.
  assert.equal(g('Mass', "Mass's revival at the Almeida is a knockout of a play tonight."), true);
});
