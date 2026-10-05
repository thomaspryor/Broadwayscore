// BRO-2764: generic-title shows need a second corroborating signal at candidate time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildTokenDocFreq, isGenericTitle, checkGenericTitleCandidate, _resetCachesForTest,
} = require('../../scripts/lib/generic-title-matching.js');
const { validateSerpCandidate } = require('../../scripts/lib/serp-candidate-validator.js');

// Hermetic corpus: "story"/"love" are common title tokens; the rest are distinctive.
const shows = [
  ...['West Side', 'Love', 'A Ghost', 'Toy', 'Fairy', 'Bear', 'Big Fish', 'True', 'Winters', 'Ghost', 'Untold'].map(w => ({ title: `${w} Story` })),
  ...['Sweet', 'Crazy', 'First', 'Puppy', 'Brotherly', 'Young', 'Tough', 'Real', 'Endless', 'Lost'].map(w => ({ title: `${w} Love` })),
  { title: 'Hamilton' }, { title: 'Wicked' }, { title: 'A Christmas Carol' }, { title: 'Christmas Spectacular' },
];
const df = buildTokenDocFreq(shows);
_resetCachesForTest(df);

const THE_STORY = {
  id: 'the-story-west-end-2026', title: 'The Story', category: 'west-end',
  venue: 'National Theatre (Olivier)',
  cast: [{ name: 'Letitia Wright' }, { name: 'Lorraine Toussaint' }, { name: 'Wilf Scolding' }],
  creativeNames: ['Tracey Scott Wilson', 'Clint Dyer'],
};

const c = (url, title, snippet = '') => ({ url, title, snippet });
// Junk: verified other works from the BRO-2764 evidence.
const JUNK = [
  c('https://www.radiotimes.com/tv/toy-story-5-release-date', 'Toy Story 5 release date', 'The story continues'),
  c('https://www.theguardian.com/tv/menendez', 'Monsters: the Lyle and Erik Menendez Story review'),
  c('https://www.telegraph.co.uk/theatre/222-a-ghost-story', '222 A Ghost Story review'),
  c('https://www.telegraph.co.uk/books/non-fiction/reds-paul-mason-review-communism-history', 'Reds by Paul Mason review', 'The story of communism'),
  c('https://www.theguardian.com/stage/kemah-bob-love-child', 'Kemah Bob: Love Child review', 'Edinburgh fringe, the story of'),
  c('https://www.theartsdesk.com/angels-in-america-edinburgh', 'Angels in America, Edinburgh review'),
  c('https://www.huffpost.com/entry/celebrity-story', 'Celebrity couple story'),
  c('https://www.indiewire.com/festival-news-the-story', 'Festival lineup: the story so far'),
  c('https://www.thestage.co.uk/reviews/the-bowie-story', 'The Bowie Story review'),
  c('https://www.timeout.com/london/theatre/a-christmas-carol-review', 'A Christmas Carol review', 'The story of Scrooge'),
  c('https://www.nytimes.com/breaking-the-story-review', 'Breaking the Story review', 'New York'),
  c('https://www.thestage.co.uk/reviews/946-the-amazing-story', '946: The Amazing Story review'),
];
// Real coverage of the National Theatre production.
const REAL = [
  c('https://www.theguardian.com/stage/2026/sep/03/the-story-review-olivier', 'The Story review', 'Letitia Wright stars in Tracey Scott Wilson’s newsroom drama.'),
  c('https://www.telegraph.co.uk/theatre/the-story-review', 'The Story review', 'Clint Dyer directs at the National Theatre.'),
  c('https://www.thetimes.com/culture/the-story-national-theatre-review', 'The Story at the Olivier review'),
  c('https://www.independent.co.uk/arts/the-story-review', 'The Story review', 'Lorraine Toussaint is magnetic.'),
  c('https://www.whatsonstage.com/the-story-review', 'The Story review', 'Tracey Scott Wilson’s play.'),
];

test('computes generic flag from title-token commonality, not a list', () => {
  assert.equal(isGenericTitle('The Story', df), true);
  assert.equal(isGenericTitle('Love', df), true);
  assert.equal(isGenericTitle('Hamilton', df), false);
  assert.equal(isGenericTitle('Wicked', df), false);
  assert.equal(isGenericTitle('A Christmas Carol', df), false);
});

test('The Story: corroboration filter rejects unrelated candidates and keeps real ones', () => {
  const verdicts = [
    ...JUNK.map(cand => ({ expectOk: false, ok: checkGenericTitleCandidate({ show: THE_STORY, candidate: cand, df }).ok })),
    ...REAL.map(cand => ({ expectOk: true, ok: checkGenericTitleCandidate({ show: THE_STORY, candidate: cand, df }).ok })),
  ];
  const correct = verdicts.filter(v => v.ok === v.expectOk).length;
  const accuracy = correct / verdicts.length;
  assert.ok(accuracy > 0.8, `accuracy ${accuracy}`);
  assert.equal(JUNK.filter(cand => checkGenericTitleCandidate({ show: THE_STORY, candidate: cand, df }).ok).length, 0);
  assert.equal(REAL.filter(cand => !checkGenericTitleCandidate({ show: THE_STORY, candidate: cand, df }).ok).length, 0);
});

test('each signal (venue, cast, director) alone is sufficient', () => {
  const only = (patch) => ({ id: 'x', title: 'The Story', category: 'west-end', venue: '', cast: [{ name: 'Nobody Known' }], creativeNames: [], ...patch });
  const cand = (t) => c('https://example.com/the-story-review', 'The Story review', t);
  assert.equal(checkGenericTitleCandidate({ show: only({ venue: 'National Theatre (Olivier)' }), candidate: cand('at the Olivier'), df }).signal, 'venue');
  assert.equal(checkGenericTitleCandidate({ show: only({ cast: [{ name: 'Letitia Wright' }] }), candidate: cand('Letitia Wright shines'), df }).signal, 'cast');
  assert.equal(checkGenericTitleCandidate({ show: only({ creativeNames: ['Clint Dyer'] }), candidate: cand('directed by Clint Dyer'), df }).signal, 'creative');
  assert.equal(checkGenericTitleCandidate({ show: only({ venue: 'National Theatre (Olivier)', cast: [{ name: 'Letitia Wright' }] }), candidate: cand('nothing relevant'), df }).ok, false);
});

test('non-generic titles are untouched', () => {
  const show = { id: 'hamilton-2015', title: 'Hamilton', category: 'broadway', venue: 'Richard Rodgers Theatre', cast: [] };
  assert.equal(checkGenericTitleCandidate({ show, candidate: c('https://x.com/a', 'Anything'), df }).ok, true);
});

test('validateSerpCandidate wires the gate for a real shows.json generic title', () => {
  const bad = validateSerpCandidate({ show: THE_STORY, candidate: JUNK[0] });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'generic-title-uncorroborated');
  assert.equal(validateSerpCandidate({ show: THE_STORY, candidate: REAL[0] }).ok, true);
});

test('venue-name core and slash-separated venues corroborate; no-people shows fail open', () => {
  const cand = (t) => c('https://example.com/the-story-review', 'The Story review', t);
  const show = (patch) => ({ id: 'x', title: 'The Story', category: 'west-end', cast: [{ name: 'Nobody Known' }], creativeNames: [], ...patch });
  assert.equal(checkGenericTitleCandidate({ show: show({ venue: 'Garrick Theatre' }), candidate: cand('at the Garrick'), df }).signal, 'venue');
  assert.equal(checkGenericTitleCandidate({ show: show({ venue: 'Roundabout Theatre Company/Laura Pels Theatre' }), candidate: cand('Laura Pels Theatre'), df }).signal, 'venue');
  assert.equal(checkGenericTitleCandidate({ show: show({ cast: [], venue: 'Garrick Theatre' }), candidate: cand('unrelated'), df }).ok, true);
});
