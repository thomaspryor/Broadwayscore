import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  classifyVenueSuffix,
  stripVenueSuffix,
  hasVenueSuffix,
  buildVenueVocabulary,
  venuesOverlap,
  isTokenSubsequence,
} = require('./title-venue-suffix.js');

const strip = (title, venue, vocab) =>
  stripVenueSuffix(title, { venue, venueVocabulary: vocab });

// ── oracle 1: the show's own venue ─────────────────────────────────────────

test('strips the venue the owner reported by name', () => {
  assert.equal(strip('The Cherry Orchard (Park Avenue Armory)', 'Park Avenue Armory'), 'The Cherry Orchard');
});

test('strips when the parenthetical is a PREFIX of the stored venue', () => {
  assert.equal(strip('La Distance (BAM)', 'BAM Harvey Theater'), 'La Distance');
  assert.equal(strip('David Copperfield (59E59 Theaters)', '59E59 Theaters, Theater A'), 'David Copperfield');
});

test('strips when the stored venue is a PREFIX of the parenthetical', () => {
  // venue: "Richmond", title: "(Richmond Theatre)"
  assert.equal(strip("Abigail's Party (Richmond Theatre)", 'Richmond'), "Abigail's Party");
});

test('handles punctuated venue names (A.R.T. New York)', () => {
  assert.equal(
    strip('Aftermath (A.R.T. New York)', 'A.R.T./New York Theatres – Mezzanine Theatre'),
    'Aftermath',
  );
});

test('case and spacing differences do not matter', () => {
  assert.equal(strip('Cable Street (59e59)', '59E59 Theaters (Theater A)'), 'Cable Street');
});

// ── oracle 2: some other show's venue ──────────────────────────────────────

test('a venue known only from elsewhere in the corpus still matches', () => {
  const vocab = buildVenueVocabulary([{ venue: 'Soho Playhouse' }]);
  assert.equal(strip('Some Play (Soho Playhouse)', null, vocab), 'Some Play');
});

// ── oracle 3: venue vocabulary word ────────────────────────────────────────

test('strips Luna Stage, which neither venue oracle can see', () => {
  // The stored venue is 59E59; "Luna Stage" is the show's ORIGINATING
  // theatre in New Jersey. Oracle 1 and 2 both miss it — this is the exact
  // row the first audit classified as "leave alone".
  assert.equal(
    strip('Mrs. Stern Wanders the Prussian State Library (Luna Stage)', '59E59 Theaters (Theater A)'),
    'Mrs. Stern Wanders the Prussian State Library',
  );
});

test('strips a producing company', () => {
  assert.equal(
    strip('Monte Cristo (The York Theatre Company)', "Theatre at St. Jean's"),
    'Monte Cristo',
  );
});

test('reports which oracle fired', () => {
  assert.equal(classifyVenueSuffix('X Play (Park Avenue Armory)', { venue: 'Park Avenue Armory' }).oracle, 'own-venue');
  assert.equal(classifyVenueSuffix('X Play (Luna Stage)', { venue: 'Elsewhere' }).oracle, 'venue-word');
});

// ── the parentheticals that MUST survive ───────────────────────────────────

const KEEP = [
  ['Two Strangers (Carry a Cake Across New York)', 'Longacre Theatre'],
  ['Escape: 6 Ways to Get Away (1)', 'Circle in the Square Theatre'],
  ['Escape: 6 Ways to Get Away (2)', 'Circle in the Square Theatre'],
  ['Antigone (This Play I Read in High School)', 'The Public Theater'],
  ['R.O.I (Return On Investment)', 'Hampstead Theatre Downstairs'],
  ['My Son’s A Queer (But What Can You Do?)', 'Apollo Theatre'],
  ['The Body of Mary: A Play in Three Acts (of God)', 'The Gym at Judson'],
  ['Rosie Jones: Anyone But Me (WIP)', 'The Maria Theatre'],
];

for (const [title, venue] of KEEP) {
  test(`leaves the real title intact: ${title}`, () => {
    assert.equal(strip(title, venue), title, 'must not be stripped');
    assert.equal(hasVenueSuffix(title, { venue }), false);
  });
}

test('a title with no trailing parenthetical is untouched', () => {
  assert.equal(strip('Death of a Salesman', 'Hudson Theatre'), 'Death of a Salesman');
});

test('nested or mid-title parentheses are not treated as a suffix', () => {
  assert.equal(strip('A Play (With (Nested)) Parens', 'Some Theatre'), 'A Play (With (Nested)) Parens');
});

test('never strips down to an empty or letterless title', () => {
  assert.equal(strip('(Park Avenue Armory)', 'Park Avenue Armory'), '(Park Avenue Armory)');
  assert.equal(strip('123 (Park Avenue Armory)', 'Park Avenue Armory'), '123 (Park Avenue Armory)');
});

// ── the weakest oracle must not eat a real title ───────────────────────────

test('a parenthetical opening with a preposition is a phrase, not a venue', () => {
  // "stage" is in VENUE_WORDS, so without the leading-function-word guard
  // this loses its subtitle. Adversarial review produced this exact example.
  assert.equal(strip('A Life (On Stage)', 'Some Theatre'), 'A Life (On Stage)');
  assert.equal(strip('The Song (With a Band)', 'Some Theatre'), 'The Song (With a Band)');
});

test('but an article-led venue or company name IS still stripped', () => {
  assert.equal(strip('Monte Cristo (The York Theatre Company)', "Theatre at St. Jean's"), 'Monte Cristo');
  assert.equal(strip('A Play (A Contemporary Theatre)', 'Elsewhere'), 'A Play');
});

test('the evidence-based oracles are NOT gated by the leading-word guard', () => {
  // If the parenthetical really is this show's venue, a leading preposition
  // is irrelevant — we have proof, not a vocabulary guess.
  assert.equal(strip('A Play (At The Armory)', 'At The Armory'), 'A Play');
});

test('per-show and per-title exemptions suppress a strip', () => {
  const { KEEP_PAREN_IDS, KEEP_PAREN_TITLES } = require('./title-venue-suffix.js');
  KEEP_PAREN_IDS.add('keep-me-1');
  KEEP_PAREN_TITLES.add('keepsake (luna stage)');
  try {
    assert.equal(
      classifyVenueSuffix('Anything (Luna Stage)', { id: 'keep-me-1', venue: 'X' }).action, 'none');
    assert.equal(
      classifyVenueSuffix('Keepsake (Luna Stage)', { venue: 'X' }).action, 'none',
      'title-keyed exemption works with no id — the ingestion case');
  } finally {
    KEEP_PAREN_IDS.delete('keep-me-1');
    KEEP_PAREN_TITLES.delete('keepsake (luna stage)');
  }
});

// ── token matching, not substring matching ─────────────────────────────────

test('token matching does not fire on a substring of a longer word', () => {
  // "art" inside "Hart Theatre" must NOT count as a venue match.
  assert.equal(venuesOverlap('art', 'Hart Theatre'), false);
  assert.equal(strip('Something (Art)', 'Hart Theatre'), 'Something (Art)');
});

test('token matching requires a CONTIGUOUS run', () => {
  assert.equal(isTokenSubsequence(['a', 'b'], ['a', 'b', 'c']), true);
  assert.equal(isTokenSubsequence(['a', 'c'], ['a', 'b', 'c']), false);
  assert.equal(isTokenSubsequence(['b', 'c'], ['a', 'b', 'c']), true);
});

test('a parenthetical shorter than the floor is never a venue', () => {
  assert.equal(strip('Part One (II)', 'II Theatre'), 'Part One (II)');
});

// ── vocabulary builder ─────────────────────────────────────────────────────

test('buildVenueVocabulary dedupes and drops stubs', () => {
  const vocab = buildVenueVocabulary([
    { venue: 'Soho Playhouse' },
    { venue: 'Soho Playhouse' },
    { venue: 'NA' },
    { venue: '' },
    {},
    null,
  ]);
  assert.deepEqual(vocab, ['Soho Playhouse']);
});

test('non-string and empty input are safe', () => {
  assert.equal(classifyVenueSuffix(null).action, 'none');
  assert.equal(classifyVenueSuffix('').action, 'none');
  assert.equal(classifyVenueSuffix(undefined).action, 'none');
});
