import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { matchLboRoundup, norm } = require('./lbo-roundup-match.js');

const shows = [
  { id: 'rent-west-end-2026', title: 'Rent', venue: 'Tom Stoppard Theatre', openingDate: '2026-03-01' },
  { id: 'kinky-boots-the-musical-west-end-2026', title: 'Kinky Boots the Musical', venue: 'London Coliseum', openingDate: '2026-02-01' },
  { id: 'marie-and-rosetta-west-end-2026', title: 'Marie & Rosetta', venue: 'Soho Place', openingDate: '2026-02-28' },
  { id: 'im-sorry-prime-minister-west-end-2026', title: 'I’m Sorry, Prime Minister', venue: 'Apollo Theatre', openingDate: '2026-02-12' },
  { id: 'peter-pan-west-end-2026', title: 'Peter Pan', venue: 'Troubadour Wembley Park Theatre', openingDate: '2026-01-10' },
  { id: 'cats-west-end-2026', title: 'Cats', venue: "Regent's Park Open Air Theatre", openingDate: '2026-06-01' },
];
const u = (slug) => `https://www.londonboxoffice.co.uk/news/post/${slug}`;

test('norm joins split contractions and expands ampersands', () => {
  assert.equal(norm('I’m Sorry, Prime Minister'), norm('i-m-sorry-prime-minister'));
  assert.equal(norm('Marie & Rosetta'), 'marie and rosetta');
});

test('venue-bearing slugs resolve to the right show', () => {
  const cases = {
    'review-roundup-rent-tom-stoppard-theatre': 'rent-west-end-2026',
    'review-roundup-kinky-boots-london-coliseum': 'kinky-boots-the-musical-west-end-2026',
    'review-round-up-marie-and-rosetta-soho-place': 'marie-and-rosetta-west-end-2026',
    'review-round-up-i-m-sorry-prime-minister-apollo-theatre': 'im-sorry-prime-minister-west-end-2026',
    'review-roundup-cats-regents-park-open-air-theatre': 'cats-west-end-2026',
  };
  for (const [slug, id] of Object.entries(cases)) {
    const r = matchLboRoundup(u(slug), slug.replace(/^review-round-?up-/, '').replace(/-/g, ' '), shows, { year: 2026 });
    assert.equal(r && r.show.id, id, slug);
  }
});

test('a different show sharing a title prefix is rejected', () => {
  const slug = 'wendy-and-peter-pan-barbican-review-round-up';
  assert.equal(matchLboRoundup(u(slug), 'wendy and peter pan barbican', shows, { year: 2025 }), null);
});

test('real shows.json: real show list resolves the contraction-slug roundup', { skip: !fs.existsSync('data/shows.json') }, () => {
  const raw = JSON.parse(fs.readFileSync('data/shows.json', 'utf8'));
  const all = Array.isArray(raw) ? raw : raw.shows;
  const we = all.filter((s) => s.category === 'west-end');
  const r = matchLboRoundup(u('review-round-up-i-m-sorry-prime-minister-apollo-theatre'), 'i m sorry prime minister apollo theatre', we, { year: 2026 });
  assert.equal(r && r.show.id, 'im-sorry-prime-minister-west-end-2026');
});

test('a longer title that merely starts with a tracked title is not matched (review: Cats The Jellicle Ball)', { skip: !fs.existsSync('data/shows.json') }, () => {
  const raw = JSON.parse(fs.readFileSync('data/shows.json', 'utf8'));
  const we = (Array.isArray(raw) ? raw : raw.shows).filter((s) => /london|west/.test(s.category || ''));
  for (const [slug, year] of [
    ['review-roundup-cats-the-jellicle-ball-southbank', 2026],
    ['review-round-up-hamlet-hackney-empire', 2026],
    ['review-round-up-girls-and-boys-royal-court', 2026],
  ]) {
    assert.equal(matchLboRoundup(u(slug), null, we, { year }), null, slug);
  }
});

test('renamed and sub-venues still resolve (Tom Stoppard = Duke of York, Dorfman = National)', { skip: !fs.existsSync('data/shows.json') }, () => {
  const raw = JSON.parse(fs.readFileSync('data/shows.json', 'utf8'));
  const we = (Array.isArray(raw) ? raw : raw.shows).filter((s) => /london|west/.test(s.category || ''));
  assert.equal(matchLboRoundup(u('review-roundup-rent-tom-stoppard-theatre'), null, we, { year: 2026 }).show.id, 'rent-west-end-2026');
  assert.equal(matchLboRoundup(u('review-round-up-pride-national-theatre'), null, we, { year: 2026 }).show.id, 'pride-west-end-2026');
});

test('BRO-6089: sitemap year keeps a same-title revival from another era out of the title match', () => {
  const godot = [
    { id: 'godot-west-end-2017', title: 'Waiting for Godot', venue: 'Theatre Royal Haymarket', openingDate: '2009-05-01', closingDate: '2009-07-30' },
    { id: 'godot-west-end-2024', title: 'Waiting for Godot', venue: 'Theatre Royal Haymarket', openingDate: '2024-09-01', closingDate: '2025-01-01' },
  ];
  const url = u('review-round-up-waiting-for-godot-theatre-royal-haymarket');
  const r24 = matchLboRoundup(url, 'waiting for godot', godot, { year: 2024 });
  assert.equal(r24 && r24.show.id, 'godot-west-end-2024');
  // 2009 round-up must not land on the 2024 show.
  const r09 = matchLboRoundup(url, 'waiting for godot', godot, { year: 2009 });
  assert.equal(r09 && r09.show.id, 'godot-west-end-2017');
  // a unique title keeps matching whatever the lastmod year
  const only24 = [godot[1]];
  assert.ok(matchLboRoundup(url, 'waiting for godot', only24, { year: 2031 }));
  // no year: old behaviour unchanged
  assert.ok(matchLboRoundup(url, 'waiting for godot', only24, {}));
});

test('BRO-6089: showRunNearYear honours open runs and prior runs', () => {
  const { showRunNearYear } = require('./lbo-roundup-match.js');
  assert.equal(showRunNearYear({ openingDate: '2018-01-01', status: 'open' }, 2025), true);
  assert.equal(showRunNearYear({ openingDate: '2018-01-01', closingDate: '2019-01-01' }, 2025), false);
  assert.equal(showRunNearYear({ openingDate: '2024-01-01', closingDate: '2024-06-01', priorRuns: [{ openingDate: '2017-05-01', closingDate: '2017-08-01' }] }, 2017), true);
  assert.equal(showRunNearYear({ title: 'x' }, 2001), true);
});
