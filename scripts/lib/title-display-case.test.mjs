import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isShoutedTitle,
  toDisplayTitleCase,
  wouldChangeTitle,
  classifyShowTitle,
  needsManualReview,
  KEEP_UPPER,
  AMBIGUOUS_REJECTED,
} = require('./title-display-case.js');

// ── detection ──────────────────────────────────────────────────────────────

test('detects a multi-word shouted title', () => {
  assert.equal(isShoutedTitle('AMERICA, WHO HURT YOU?'), true);
  assert.equal(isShoutedTitle('WHAT THE CONSTITUTION MEANS TO ME'), true);
});

test('leaves short all-caps stylisations alone (SIX, POTUS, FELA!)', () => {
  assert.equal(isShoutedTitle('SIX'), false);
  assert.equal(isShoutedTitle('POTUS'), false);
  assert.equal(isShoutedTitle('FELA!'), false);
  assert.equal(isShoutedTitle('MJ'), false);
});

test('a correctly-cased title is never shouted', () => {
  assert.equal(isShoutedTitle('The Cherry Orchard'), false);
  assert.equal(isShoutedTitle('Death of a Salesman'), false);
});

test('a title in an uncased script is not shouted (regression: Latin-1 letter class)', () => {
  // Before the Unicode fix these passed `letters === letters.toUpperCase()`
  // trivially — there are no cased letters at all — and were "shouted".
  assert.equal(isShoutedTitle('性 別 友 善 廁 所'), false);
  assert.equal(isShoutedTitle('שלוש אחיות בבית'), false);
});

// ── defect 1: ordinary English words must not survive as acronyms ──────────

test('US is the pronoun, not the country (JUST FOR US)', () => {
  assert.equal(toDisplayTitleCase('JUST FOR US'), 'Just for Us');
});

test('LA is the Spanish article, not Los Angeles (MAN OF LA MANCHA)', () => {
  assert.equal(toDisplayTitleCase('MAN OF LA MANCHA'), 'Man of La Mancha');
});

test('the ambiguous tokens stay out of KEEP_UPPER', () => {
  for (const tok of AMBIGUOUS_REJECTED) {
    assert.equal(KEEP_UPPER.has(tok), false, `${tok} must not be in KEEP_UPPER`);
  }
});

test('unambiguous initialisms are still preserved', () => {
  assert.equal(toDisplayTitleCase('A NIGHT AT THE BBC'), 'A Night at the BBC');
  assert.equal(toDisplayTitleCase('THE DC PROJECT'), 'The DC Project');
});

// ── defect 2: roman numerals ───────────────────────────────────────────────

test('roman numerals keep their case (LOUIS XIV RETURNS)', () => {
  assert.equal(toDisplayTitleCase('LOUIS XIV RETURNS'), 'Louis XIV Returns');
  assert.equal(toDisplayTitleCase('HENRY VIII AT HOME'), 'Henry VIII at Home');
});

test('English words that look like roman numerals are NOT uppercased', () => {
  // /^[IVXLCDM]+$/ would have shouted every one of these back at the reader.
  assert.equal(toDisplayTitleCase('THE MIX AND THE MILL'), 'The Mix and the Mill');
  assert.equal(toDisplayTitleCase('A DIM CIVIL LID'), 'A Dim Civil Lid');
});

// ── defect 3: detection vs actionability (permanent-CI-error guard) ────────

test('a shouted title that converts to itself is not actionable', () => {
  // Every token is a KEEP_UPPER acronym, so there is nothing to fix. Gating
  // CI on isShoutedTitle() made this an ERROR the sweep could never clear.
  assert.equal(isShoutedTitle('BBC & RSC'), true);
  assert.equal(toDisplayTitleCase('BBC & RSC'), 'BBC & RSC');
  assert.equal(wouldChangeTitle('BBC & RSC'), false);
});

test('wouldChangeTitle is true exactly when there is work to do', () => {
  assert.equal(wouldChangeTitle('AMERICA, WHO HURT YOU?'), true);
  assert.equal(wouldChangeTitle('The Cherry Orchard'), false);
  assert.equal(wouldChangeTitle('SIX'), false);
});

// ── defect 4: title-level exemption ────────────────────────────────────────

test('classifyShowTitle honours the per-show exemption set', () => {
  const { KEEP_SHOUTED_IDS } = require('./title-display-case.js');
  KEEP_SHOUTED_IDS.add('six-the-musical-test');
  try {
    assert.equal(
      classifyShowTitle('six-the-musical-test', 'SIX THE MUSICAL').action,
      'none',
      'an exempt show is never converted',
    );
    assert.equal(
      classifyShowTitle('some-other-show', 'SIX THE MUSICAL').action,
      'convert',
      'a non-exempt show still converts',
    );
  } finally {
    KEEP_SHOUTED_IDS.delete('six-the-musical-test');
  }
});

test('classifyShowTitle routes the Spanish title to manual review, not a guess', () => {
  const id = 'mas-sabe-el-saulo-por-viejo-off-broadway-2025';
  assert.equal(needsManualReview(id), true);
  assert.equal(classifyShowTitle(id, 'MÁS SABE EL SAULO POR VIEJO...').action, 'manual-review');
});

// ── defect 5: Unicode ──────────────────────────────────────────────────────

test('non-Latin-1 Latin letters survive (ŁÓDŹ, not łÓdź)', () => {
  assert.equal(toDisplayTitleCase('ŁÓDŹ BY NIGHT'), 'Łódź by Night');
});

test('other extended-Latin scripts are cased correctly', () => {
  assert.equal(toDisplayTitleCase('ČESKÝ SEN ŽIJE'), 'Český Sen Žije');
  assert.equal(toDisplayTitleCase('İSTANBUL GECE KUŞU'), 'İstanbul Gece Kuşu');
});

test('a non-letter inside a token does not swallow the next letter', () => {
  assert.equal(toDisplayTitleCase('NODA MAP – 320°F'), 'Noda Map – 320°F');
});

// ── defect 6: apostrophes ──────────────────────────────────────────────────

test("contractions stay lowercase (I'M, not I'M)", () => {
  assert.equal(toDisplayTitleCase("I'M STILL HERE"), "I'm Still Here");
  assert.equal(toDisplayTitleCase("IT'S ONLY A PLAY"), "It's Only a Play");
});

test("possessives stay lowercase (KING'S -> King's)", () => {
  assert.equal(toDisplayTitleCase("THE KING'S SPEECH"), "The King's Speech");
  assert.equal(toDisplayTitleCase("COAL MINER'S DAUGHTER"), "Coal Miner's Daughter");
});

test("name prefixes DO capitalise (O'Neill, D'Angelo, L'Amour)", () => {
  assert.equal(toDisplayTitleCase("THE O'NEILL'S STORY"), "The O'Neill's Story");
  assert.equal(toDisplayTitleCase("D'ANGELO SINGS TONIGHT"), "D'Angelo Sings Tonight");
  assert.equal(toDisplayTitleCase("L'AMOUR IN PARIS"), "L'Amour in Paris");
});

test('curly apostrophes behave the same as straight ones', () => {
  assert.equal(toDisplayTitleCase('THE KING’S SPEECH'), 'The King’s Speech');
  assert.equal(toDisplayTitleCase('I’M STILL HERE'), 'I’m Still Here');
});

// ── previously-alleged defects that were NOT real; pinned so they stay fixed

test('a leading curly quote does not defeat the first-word rule', () => {
  assert.equal(toDisplayTitleCase('“THE GREAT GATSBY” LIVE'), '“The Great Gatsby” Live');
});

test('a closing bracket does not defeat terminal-punctuation detection', () => {
  // "(WHAT?)" ends a clause even though ")" is the last character, so the
  // next word is force-capitalised rather than treated as a minor word.
  assert.equal(toDisplayTitleCase('SO (WHAT?) THE PLAY'), 'So (What?) The Play');
});

// ── general title-case behaviour ───────────────────────────────────────────

test('minor words lowercase except first and last', () => {
  assert.equal(toDisplayTitleCase('WHAT THE CONSTITUTION MEANS TO ME'), 'What the Constitution Means to Me');
  assert.equal(toDisplayTitleCase('DEATH OF A SALESMAN'), 'Death of a Salesman');
});

test('a word after terminal punctuation is force-capitalised', () => {
  assert.equal(toDisplayTitleCase('HAMILTON: AN AMERICAN MUSICAL'), 'Hamilton: An American Musical');
  assert.equal(toDisplayTitleCase('MRS. DOUBTFIRE THE MUSICAL'), 'Mrs. Doubtfire the Musical');
});

test('hyphenated names capitalise on both sides', () => {
  assert.equal(toDisplayTitleCase('IN HONOR OF JEAN-MICHEL BASQUIAT'), 'In Honor of Jean-Michel Basquiat');
});

test('the owner-reported title converts to the house spelling', () => {
  assert.equal(toDisplayTitleCase('AMERICA, WHO HURT YOU?'), 'America, Who Hurt You?');
});

test('non-string and empty input are safe', () => {
  assert.equal(toDisplayTitleCase(null), null);
  assert.equal(toDisplayTitleCase(''), '');
  assert.equal(isShoutedTitle(undefined), false);
  assert.equal(wouldChangeTitle(42), false);
});
