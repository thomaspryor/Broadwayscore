import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseReviewPost, matchPostToShow } = require('./loureviews-match.js');

// Fixture: a slice of shows.json. Includes UK-market entries the poller should
// match AND historical same-title Broadway entries it must NOT match (because
// LouReviews only covers UK stage — the market restriction is the FP guard).
const SHOWS = [
  { id: 'the-p-word-off-west-end-2026', title: 'The P Word', category: 'off-west-end' },
  { id: 'avenue-q-west-end-2026', title: 'Avenue Q', category: 'west-end' },
  { id: 'kinky-boots-the-musical-west-end-2026', title: 'Kinky Boots The Musical', category: 'west-end' },
  { id: 'les-liaisons-dangereuses-west-end-2026', title: 'Les Liaisons Dangereuses', category: 'west-end' },
  { id: 'into-the-woods-west-end-2025', title: 'Into The Woods', category: 'off-west-end' },
  { id: 'six-the-musical-west-end-2021', title: 'SIX The Musical', category: 'west-end' },
  { id: 'broken-glass-west-end-2026', title: 'Broken Glass', category: 'off-west-end' },
  { id: 'john-proctor-is-the-villain-west-end-2026', title: 'John Proctor is the Villain', category: 'west-end' },
  // Historical Broadway decoys sharing a title — must never match.
  { id: 'company-1993', title: 'Company', category: 'broadway' },
  { id: 'saint-joan-1977', title: 'Saint Joan', category: 'broadway' },
  { id: 'our-town-2024', title: 'Our Town', category: 'broadway' },
  { id: 'teeth-n-smiles-west-end-2026', title: "Teeth 'n' Smiles", category: 'west-end' },
  // Distinct-production decoy: shares only the weak word "back".
  { id: 'back-to-the-future-west-end-2021', title: 'Back to the Future', category: 'west-end' },
];

test('parseReviewPost: accepts single-show stage reviews and strips venue/company', () => {
  assert.deepEqual(parseReviewPost('Play review: The P Word at Bush Theatre'), { showTitle: 'The P Word' });
  assert.deepEqual(parseReviewPost('Musical review: Avenue Q at Shaftesbury Theatre'), { showTitle: 'Avenue Q' });
  assert.deepEqual(parseReviewPost('Musical review: Company by Sedos'), { showTitle: 'Company' });
  assert.deepEqual(parseReviewPost('Play review: Saint Joan at Arches Lane Theatre'), { showTitle: 'Saint Joan' });
  assert.equal(parseReviewPost('Musical review: SIX at Vaudeville Theatre').showTitle, 'SIX');
  // Trailing "(Venue)" stripped, but a leading/embedded parenthetical in the
  // title itself is preserved (anchored trailing-bracket strip).
  assert.equal(parseReviewPost('Play review: Hamlet (Bristol Old Vic)').showTitle, 'Hamlet');
  assert.equal(parseReviewPost('Play review: (This Is Not A) Happy Room at Soho').showTitle, '(This Is Not A) Happy Room');
});

test('parseReviewPost: rejects non-stage reviews, previews, interviews, roundups', () => {
  assert.equal(parseReviewPost('Film review: Unbroken – The Untold Story'), null);
  assert.equal(parseReviewPost('Home media review: Children’s Film Foundation Bumper Box Vol 6'), null);
  assert.equal(parseReviewPost('Digital play review: Othello (Theatre Royal Haymarket)'), null);
  assert.equal(parseReviewPost('Female theatre reviewers project: Caroline'), null);
  assert.equal(parseReviewPost('Edinburgh Fringe preview: Dean Friedman'), null);
  assert.equal(parseReviewPost('Event preview: 10th anniversary of the Creative Women Forum'), null);
  assert.equal(parseReviewPost('Brighton Fringe reviews: Evangeline, and The Shape of Things Undone'), null);
});

test('matchPostToShow: matches UK productions', () => {
  const cases = [
    ['Play review: The P Word at Bush Theatre', 'the-p-word-off-west-end-2026'],
    ['Musical review: Avenue Q at Shaftesbury Theatre', 'avenue-q-west-end-2026'],
    ['Musical review: Kinky Boots at London Coliseum', 'kinky-boots-the-musical-west-end-2026'],
    ['Play review: Les Liaisons Dangereuses at National Theatre', 'les-liaisons-dangereuses-west-end-2026'],
    ['Musical review: Into The Woods at Bridge Theatre', 'into-the-woods-west-end-2025'],
    ['Musical review: SIX at Vaudeville Theatre', 'six-the-musical-west-end-2021'],
    ['Play review: Broken Glass at Young Vic', 'broken-glass-west-end-2026'],
    ['Play review: John Proctor is the Villain at Royal Court', 'john-proctor-is-the-villain-west-end-2026'],
    ["Play review: Teeth 'n' Smiles at Crucible Theatre", 'teeth-n-smiles-west-end-2026'],
  ];
  for (const [title, expected] of cases) {
    const parsed = parseReviewPost(title);
    assert.ok(parsed, `should parse: ${title}`);
    const m = matchPostToShow(parsed.showTitle, SHOWS);
    assert.ok(m, `should match: ${title}`);
    assert.equal(m.showId, expected, `${title} -> ${m && m.showId}`);
  }
});

test('matchPostToShow: rejects amateur/regional same-title shows (Broadway decoys excluded by market)', () => {
  // These only exist in our DB as historical Broadway — must NOT match.
  for (const title of [
    'Musical review: Company by Sedos',
    'Play review: Saint Joan at Arches Lane Theatre',
    'Play review: Our Town at Rose Theatre Kingston',
  ]) {
    const parsed = parseReviewPost(title);
    assert.ok(parsed, `should parse: ${title}`);
    assert.equal(matchPostToShow(parsed.showTitle, SHOWS), null, `should NOT match: ${title}`);
  }
});

test('matchPostToShow: weak shared word does not match a distinct production', () => {
  // "I'll Be Back" shares only "back" with "Back to the Future" — must not match.
  const parsed = parseReviewPost("Comedy review: I'll Be Back at Soho Theatre")
    || parseReviewPost("Play review: I'll Be Back at Soho Theatre");
  assert.ok(parsed);
  assert.equal(matchPostToShow(parsed.showTitle, SHOWS), null);
});
