import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('./awards-season-labels.js');

test('ceremony numbers map to seasons across the COVID gap', () => {
  assert.equal(L.ceremonyToSeason('73rd'), '2018-19');
  assert.equal(L.ceremonyToSeason('74th'), '2019-20');
  assert.equal(L.ceremonyToSeason('75th'), '2021-22');
  assert.equal(L.ceremonyToSeason('78th'), '2024-25');
  assert.equal(L.seasonToCeremony('2024-25'), '78th');
  assert.equal(L.seasonToCeremony('2021-22'), '75th');
  assert.equal(L.seasonToCeremony('2019-20'), '74th');
  assert.equal(L.seasonToCeremony('2020-21'), null, 'no ceremony for 2020-21');
});

test('two agreeing signals beat the third', () => {
  // smash-2025: wrong label, ceremony + opening window agree
  assert.deepEqual(L.resolveTonySeason({ label: '2023-24', ceremony: '78th', windowLabel: '2024-25' }), { season: '2024-25', ceremony: '78th' });
  // pictures-from-home-2023: wrong ceremony
  assert.deepEqual(L.resolveTonySeason({ label: '2022-23', ceremony: '77th', windowLabel: '2022-23' }), { season: '2022-23', ceremony: '76th' });
  // slave-play-2021: opening date is the return run; label + ceremony agree
  assert.equal(L.resolveTonySeason({ label: '2019-20', ceremony: '74th', windowLabel: '2021-22' }), null);
  // no majority: leave alone
  assert.equal(L.resolveTonySeason({ label: '2019-20', ceremony: '78th', windowLabel: '2022-23' }), null);
});

test('siblings that shared the wrong label move with it; UK awards do not', () => {
  const shows = { x: { tony: { season: '2023-24', ceremony: '78th' }, dramadesk: { season: '2023-24' }, lortel: { season: '2022-23' }, olivier: { season: '2023-24' } } };
  const changes = L.repairSeasonLabels(shows, () => '2024-25');
  assert.equal(changes.length, 1);
  assert.equal(shows.x.tony.season, '2024-25');
  assert.equal(shows.x.dramadesk.season, '2024-25');
  assert.equal(shows.x.lortel.season, '2022-23', 'Off-Broadway award: never moved');
  assert.equal(shows.x.olivier.season, '2023-24');
});
