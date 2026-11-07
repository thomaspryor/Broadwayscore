// BRO-5737: the live shows.json alias/id-clash check lives in tests/unit/duplicate-show-dedup-live-data.test.mjs (check-corpus-drift.yml)
// BRO-4049: crazy-mama-off-broadway-2026 (TodayTix stub) duplicated
// crazy-mama-a-true-story-of-love-and-madness-off-broadway-2026 (59E59 venue
// page). Discovery filed opening-night reviews under the stub id. Requires the
// real dedup functions (the live shows.json check is split out, see line 1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { checkForDuplicate, venuesMatch, normalizeTitle } = require('../../scripts/lib/deduplication.js');
const { findExistingMatch } = require('../../scripts/lib/candidate-dedup.js');

const CANON = {
  id: 'crazy-mama-a-true-story-of-love-and-madness-off-broadway-2026',
  title: 'Crazy Mama: A True Story of Love and Madness',
  venue: '59E59 Theaters, Theater C',
  status: 'open', openingDate: '2026-09-22', closingDate: '2026-10-18',
  previewsStartDate: '2026-09-16', category: 'off-broadway', market: 'broadway',
};

test('same-venue title-prefix stub is flagged as a duplicate (comma and dash venue spellings)', () => {
  for (const venue of ['59E59 Theaters, Theater C', '59E59 Theaters - Theater C']) {
    const stub = { id: 'crazy-mama-off-broadway-2026', title: 'Crazy Mama', venue,
      status: 'previews', previewsStartDate: '2026-09-16', category: 'off-broadway', market: 'broadway' };
    const r = checkForDuplicate(stub, [CANON]);
    assert.equal(r.isDuplicate, true, venue);
    assert.equal(r.existingShow.id, CANON.id);
  }
});

test('sibling rooms at the same venue stay distinct', () => {
  assert.equal(venuesMatch('59E59 Theaters, Theater A', '59E59 Theaters, Theater C'), false);
});

// BRO-5557: a spaced en/em dash tagline ("ANON – a tempest at our kitchen table")
// was never stripped by normalizeTitle (only an ASCII hyphen was), so the BWW
// roundup headline "Anne Washburn's ANON" minted a second ANON show at MCC.
test('normalizeTitle drops a spaced en/em dash tagline like it drops an ASCII hyphen', () => {
  assert.equal(normalizeTitle('ANON – a tempest at our kitchen table'), normalizeTitle('ANON - a tempest at our kitchen table'));
  assert.equal(normalizeTitle('ANON — a tempest at our kitchen table'), 'anon');
  assert.equal(normalizeTitle('Anne Washburn’s ANON'), 'anon');
  // an unspaced en dash inside a title is a range / compound, not a tagline
  assert.notEqual(normalizeTitle('Rock–Paper–Scissors'), 'rock');
});

test('roundup headline with a writer credit matches the dash-tagline show at the same house (both dedupe paths)', () => {
  const MCC = 'The Newman Mills Theatre at the Robert W. Wilson MCC Theatre Space';
  const existing = [{ id: 'anon-real', title: 'ANON – a tempest at our kitchen table', slug: 'anon-a-tempest-at-our-kitchen-table-off-broadway', venue: MCC, openingDate: '2026-10-14', previewsStartDate: '2026-09-25', closingDate: '2026-11-01', category: 'off-broadway', market: 'broadway', type: 'play' }];
  const hit = findExistingMatch({ title: 'Anne Washburn’s ANON', venue: 'MCC Theater' }, existing);
  assert.equal(hit?.match.id, 'anon-real');
  const dup = checkForDuplicate({ title: 'Anne Washburn’s ANON', venue: 'MCC Theater', openingDate: '2026-10-15', category: 'off-broadway', market: 'broadway', type: 'play' }, existing);
  assert.equal(dup.isDuplicate, true);
  assert.equal(dup.existingShow.id, 'anon-real');
  // a different play at the same house is not merged
  assert.equal(findExistingMatch({ title: 'Anne Washburn’s Mr. Burns', venue: 'MCC Theater' }, existing), null);
});

// BRO-5557: same subtitle behind a different credit list (Il Cimento, NYU Skirball).
const { isSameSubtitleTail } = require('../../scripts/lib/deduplication.js');
test('isSameSubtitleTail: a different credit list before one distinctive subtitle', () => {
  const a = 'Anne Teresa De Keersmaeker: Il Cimento dell’Armonia e dell’Inventione';
  const b = 'Anne Teresa De Keersmaeker & Radouan Mriziga: Il Cimento dell\'Armonia e dell\'Inventione';
  assert.equal(isSameSubtitleTail(a, b), true);
  assert.equal(isSameSubtitleTail(a, a), false, 'identical titles are not this rule');
  assert.equal(isSameSubtitleTail('Part 1: Prologue', 'Part 2: Prologue'), false, 'short tails never match');
  // a dash tail is the company / house, not a subtitle (validate-data caught these on the first draft)
  assert.equal(isSameSubtitleTail('Tosca - English National Opera', 'Angel Bones - English National Opera'), false);
  assert.equal(isSameSubtitleTail('Jack and the Beanstalk - Theatre on Kew', 'The Wind in the Willows - Theatre on Kew'), false);
  // a prefixed special engagement of the same show is not a credit-list extension (New Victory Fraggle Rock)
  assert.equal(isSameSubtitleTail('Jim Henson\'s Fraggle Rock: Back to the Rock Live', 'Grown-Up Nights: Jim Henson\'s Fraggle Rock: Back to the Rock Live'), false);
  // an Encore / extra word in the head is a different engagement, not an added credit
  assert.equal(isSameSubtitleTail('National Theatre Live: Hamlet Prince of Denmark', 'National Theatre Live Encore: Hamlet Prince of Denmark'), false);
  // ", " and "+" join credits like "&"
  assert.equal(isSameSubtitleTail('Ana Maria Lopez: A Long Distinct Subtitle', 'Ana Maria Lopez, Joe Smith: A Long Distinct Subtitle'), true);
  assert.equal(isSameSubtitleTail('Ana Maria Lopez: A Long Distinct Subtitle', 'Ana Maria Lopez + Joe Smith: A Long Distinct Subtitle'), true);
  // two unrelated acts sharing a tagline are not a credit-list extension
  assert.equal(isSameSubtitleTail('Ballet Alpha: A Night of Dance and Music', 'Company Beta: A Night of Dance and Music'), false);
  assert.equal(isSameSubtitleTail('Il Cimento dell\'Armonia', b), false, 'needs a separator on both sides');
  const existing = [{ id: 'cim', slug: 'cim', title: a, venue: 'NYU Skirball', openingDate: null, previewsStartDate: '2027-04-22', closingDate: '2027-04-24', category: 'off-broadway', market: 'broadway', type: 'special' }];
  const r = checkForDuplicate({ title: b, venue: 'NYU Skirball', previewsStartDate: '2027-04-22', closingDate: '2027-04-24', category: 'off-broadway', market: 'broadway' }, existing);
  assert.equal(r.isDuplicate, true);
  assert.equal(findExistingMatch({ title: b, venue: 'NYU Skirball' }, existing)?.match.id, 'cim');
});
