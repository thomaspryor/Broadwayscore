import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isRoundupOrMegathread,
  isGenericTitle,
  buildAudienceSearchQueries,
} = require('./reddit-post-filters.js');

test('roundup/megathread posts are detected (real contaminators seen for music-city)', () => {
  // These exact titles were observed polluting music-city-off-broadway-2026.
  assert.equal(isRoundupOrMegathread('Drama Desk Awards 2025'), true);
  assert.equal(isRoundupOrMegathread('Theater Wrap 2025'), true);
  assert.equal(isRoundupOrMegathread('What does your theatre week look like this week?'), true);
  assert.equal(isRoundupOrMegathread('Tony Award Nominations 2025'), true);
  assert.equal(isRoundupOrMegathread('Outer Critics Circle winners thread'), true);
  assert.equal(isRoundupOrMegathread('2025 Olivier Awards reactions'), true);
  assert.equal(isRoundupOrMegathread('Best musicals of 2025'), true);
  assert.equal(isRoundupOrMegathread('Weekly Discussion Thread'), true);
  assert.equal(isRoundupOrMegathread('Recommendations thread'), true);
  assert.equal(isRoundupOrMegathread('What should I see in NYC?'), true);
});

test('genuine show-specific posts are NOT flagged as roundups', () => {
  assert.equal(isRoundupOrMegathread('Has anyone seen Music City yet?'), false);
  assert.equal(isRoundupOrMegathread('Music City is an awesome hidden gem off-off-Broadway'), false);
  assert.equal(isRoundupOrMegathread('Just saw Maybe Happy Ending — wow'), false);
  assert.equal(isRoundupOrMegathread('Review: The Outsiders broke me'), false);
  assert.equal(isRoundupOrMegathread('My thoughts on Hadestown'), false);
  // "award"-adjacent but show-specific (no ceremony/thread phrasing)
  assert.equal(isRoundupOrMegathread('This show is award-worthy'), false);
});

test('single-significant-word titles are generic/collision-prone', () => {
  for (const t of ['Chess', 'Proof', 'Giant', 'Mercury', 'Sukkot', 'Masquerade', 'Burlesque', 'Hadestown', 'Wicked']) {
    assert.equal(isGenericTitle(t), true, `${t} should be generic`);
  }
});

test('known multi-word film/phrase collisions are generic', () => {
  for (const t of ['Music City', 'Dog Day Afternoon', 'The Lost Boys', 'Lean-To', 'Every Brilliant Thing']) {
    assert.equal(isGenericTitle(t), true, `${t} should be generic`);
  }
});

test('distinctive multi-word titles are NOT generic', () => {
  for (const t of ['Maybe Happy Ending', 'Buena Vista Social Club', 'Two Strangers (Carry a Cake Across New York)', 'Operation Mincemeat']) {
    assert.equal(isGenericTitle(t), false, `${t} should not be generic`);
  }
});

test('no show ever runs a bare-phrase Reddit query', () => {
  for (const generic of [true, false]) {
    const qs = buildAudienceSearchQueries({
      cleanTitle: 'Music City', marketName: 'Off-Broadway', isWestEnd: false, generic,
    });
    assert.ok(!qs.includes('"Music City"'), 'bare phrase query must not appear');
    // widest query is market-anchored
    assert.ok(qs.includes('"Music City" "Off-Broadway"'));
  }
});

test('generic titles market-anchor the weak thoughts/loved/recommend queries', () => {
  const generic = buildAudienceSearchQueries({
    cleanTitle: 'Mercury', marketName: 'Off-Broadway', isWestEnd: false, generic: true,
  });
  assert.ok(generic.includes('"Mercury" thoughts "Off-Broadway"'));
  assert.ok(generic.includes('"Mercury" loved "Off-Broadway"'));

  const distinctive = buildAudienceSearchQueries({
    cleanTitle: 'Maybe Happy Ending', marketName: 'Broadway', isWestEnd: false, generic: false,
  });
  // distinctive keeps the weak queries unanchored (recall)
  assert.ok(distinctive.includes('"Maybe Happy Ending" thoughts'));
});

test('opera queries keep their Met anchoring unchanged', () => {
  const qs = buildAudienceSearchQueries({
    cleanTitle: 'Innocence', marketName: 'Broadway', isWestEnd: false, isOpera: true,
  });
  assert.ok(qs.every((q) => /Met|Metropolitan/.test(q)));
});
