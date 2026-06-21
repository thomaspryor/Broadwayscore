import { test } from 'node:test';
import assert from 'node:assert/strict';
import pkg from './synopsis-validation.js';
const {
  isValidSynopsis,
  isPlaceholderSynopsis,
  isStaleSynopsis,
  classifyBadSynopsis,
  detectRefusalPattern,
} = pkg;

const PLACEHOLDER_1536 =
  "1536 is a stage play written by Ava Pickett. It had its world premiere at London's Almeida Theatre in 2025. It's scheduled to transfer to the West End in 2026.";
const REAL_1536 =
  "Set in a field in rural Essex in the summer of 1536, three young women meet to trade gossip as word arrives of Anne Boleyn's execution, and the distant violence seeps into their own lives.";

// --- placeholder detection ---
test('isPlaceholderSynopsis flags the 1536-style production-history placeholder', () => {
  assert.equal(isPlaceholderSynopsis(PLACEHOLDER_1536), true);
});

test('isPlaceholderSynopsis flags bare attribution ("is a play written by X.")', () => {
  assert.equal(
    isPlaceholderSynopsis('The Hills of California is a play written by British playwright Jez Butterworth.'),
    true
  );
});

// ship-check follow-up 2026-06-21: assert the exact stale cases the tightened
// anchor MUST still catch (Codex flagged missing coverage of the boundary).
test('isStaleSynopsis catches the canonical "transfer to the West End in YYYY" stale form', () => {
  assert.equal(isStaleSynopsis({ status: 'open', synopsis: "It's scheduled to transfer to the West End in 2026." }), true);
  assert.equal(isStaleSynopsis({ status: 'now-playing', synopsis: 'The production will open at the Lyttelton Theatre next month.' }), true);
});

test('isPlaceholderSynopsis flags opener + production history (dana-h shape)', () => {
  assert.equal(
    isPlaceholderSynopsis('Dana H. is a play written by Lucas Hnath. It premiered on Broadway in 2021, winning two Tony Awards.'),
    true
  );
});

// The critical false-positive guard: a GOOD synopsis that happens to open with
// "is a play written by X about [plot]" must NOT be flagged (this is what made
// the LLM backfill reject its own output, 2026-06-21).
test('isPlaceholderSynopsis does NOT flag "is a play written by X about [plot]"', () => {
  const good =
    'John Proctor Is the Villain is a stage play written by Kimberly Belflower, a revisionist take on The Crucible centering on a group of modern-day high school students in rural Georgia who reckon with the play as a #MeToo reckoning unfolds in their own classroom.';
  assert.equal(isPlaceholderSynopsis(good), false);
  assert.equal(isValidSynopsis(good), true);
});

test('isPlaceholderSynopsis does not flag plot text mentioning a play-within', () => {
  assert.equal(
    isPlaceholderSynopsis('A failed actor stages a play written by his late wife to win back his daughter.'),
    false
  );
});

// ship-check 2026-06-21: a GOOD short synopsis with the opener + a plot signal
// must NOT be flagged (bare-attribution length rule was too aggressive).
test('isPlaceholderSynopsis does NOT flag short "written by X about [plot]"', () => {
  const good = 'The Guest is a play written by Jane Doe about a grieving son who returns home to confront his father.';
  assert.equal(isPlaceholderSynopsis(good), false);
  assert.equal(isValidSynopsis(good), true);
});

test('isPlaceholderSynopsis does NOT flag short "written by X, set in [place]"', () => {
  assert.equal(isPlaceholderSynopsis('Tiny is a musical written by Y, set in 1920s Paris.'), false);
});

test('isValidSynopsis rejects placeholders', () => {
  assert.equal(isValidSynopsis(PLACEHOLDER_1536), false);
});

test('isValidSynopsis accepts a real plot synopsis', () => {
  assert.equal(isValidSynopsis(REAL_1536), true);
});

// --- stale future-tense detection (status-aware) ---
test('isStaleSynopsis flags future-tense transfer copy on an open show', () => {
  assert.equal(
    isStaleSynopsis({ status: 'open', synopsis: 'A new drama that is scheduled to transfer to the West End this year.' }),
    true
  );
});

test('isStaleSynopsis does NOT flag the same copy on an upcoming show', () => {
  assert.equal(
    isStaleSynopsis({ status: 'upcoming', synopsis: 'A new drama that is scheduled to transfer to the West End this year.' }),
    false
  );
});

// ship-check 2026-06-21: plot verbs must not trip stale — only true theatrical
// transfer/premiere language anchored to a market/theatre/year does.
test('isStaleSynopsis does NOT flag plot-verb future tense on an open show', () => {
  assert.equal(isStaleSynopsis({ status: 'open', synopsis: 'Two lovers decide they will run away together before dawn.' }), false);
  assert.equal(isStaleSynopsis({ status: 'open', synopsis: 'A producer insists the show will open in Chicago before coming home.' }), false);
  assert.equal(isStaleSynopsis({ status: 'closed', synopsis: 'A chorus girl dreams she will play the lead one day.' }), false);
});

// --- classifyBadSynopsis (single source of truth) ---
test('classifyBadSynopsis labels missing / placeholder / stale / refusal / ok', () => {
  assert.deepEqual(classifyBadSynopsis({ synopsis: '' }), { bad: true, reason: 'missing' });
  assert.deepEqual(classifyBadSynopsis({ synopsis: 'Too short.' }), { bad: true, reason: 'missing' });
  assert.equal(classifyBadSynopsis({ status: 'open', synopsis: PLACEHOLDER_1536 }).reason, 'placeholder');
  assert.equal(
    classifyBadSynopsis({ status: 'open', synopsis: 'A drama that will transfer to Broadway next season after a hit regional run.' }).reason,
    'stale'
  );
  assert.equal(
    classifyBadSynopsis({ synopsis: 'I do not have enough information about the specific plot of this show to provide a factual synopsis.' }).reason,
    'refusal'
  );
  assert.deepEqual(classifyBadSynopsis({ status: 'open', synopsis: REAL_1536 }), { bad: false, reason: null });
});

// --- existing refusal detection still works ---
test('detectRefusalPattern still catches LLM refusals', () => {
  assert.notEqual(detectRefusalPattern('I do not have enough information about this show.'), null);
  assert.equal(detectRefusalPattern(REAL_1536), null);
});
