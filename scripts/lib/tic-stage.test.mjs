import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const s = require('./tic-stage.js');

const rev = (o, u) => ({ outlet: o, url: u });
const page = (over = {}) => ({ id: 1, slug: 'x', title: 'Topdog/Underdog', venue: 'Steppenwolf Theatre Company', reviews: [rev('A', 'http://a/1'), rev('B', 'http://b/1'), rev('C', 'http://c/1')], ...over });

test('prefilter: needs 3 distinct linked outlets', () => {
  assert.equal(s.prefilter(page()).ok, true);
  assert.equal(s.prefilter(page({ reviews: [rev('A', 'http://a/1'), rev('A', 'http://a/2'), rev('B', 'http://b/1')] })).reason, 'under-3-outlets');
});
test('prefilter: drops tour houses, virtual, empty', () => {
  assert.equal(s.prefilter(page({ venue: 'CIBC Theatre' })).reason, 'tour-house');
  assert.equal(s.prefilter(page({ venue: 'Online Stream' })).reason, 'virtual');
  assert.equal(s.prefilter({ empty: true }).reason, 'empty');
});
test('buildShowEntry: regional local-only entry with -regional-<year> id', () => {
  const e = s.buildShowEntry({ page: page(), detail: { venue: 'Steppenwolf Theatre', address: '1650 N Halsted St Chicago', showType: 'Play' }, dates: { openingDate: '2024-03-02' }, discoveredAt: '2026-10-29' });
  assert.equal(e.id, 'topdogunderdog-regional-2024'.replace('topdogunderdog', 'topdog-underdog'));
  assert.equal(e.venue, 'Steppenwolf Theatre, Chicago, IL');
  assert.equal(e.localOnly, true);
  assert.equal(e.discoverySource, 'theatreinchicago');
  assert.equal(e.type, 'play');
  assert.equal(e.city, 'chicago-il');
  // the metro slug must exist in the shared table, or the hub never lists the show
  assert.ok(JSON.parse(fs.readFileSync(new URL('../../data/venue-metros.json', import.meta.url), 'utf8')).metros[e.city]);
});
test('findDuplicate: same-title Chicago regional or nearby tour', () => {
  const e = { title: 'Parade', openingDate: '2025-06-01' };
  assert.ok(s.findDuplicate(e, [{ id: 'p', title: 'Parade', category: 'tour', openingDate: '2025-02-01' }]));
  assert.equal(s.findDuplicate(e, [{ id: 'p', title: 'Parade', category: 'broadway', openingDate: '1998-12-17' }]), null);
});

test('dedupeId: venue suffix on an id collision', () => {
  const e = { id: 'hamlet-regional-2024', slug: 'hamlet-regional-2024', venue: 'Writers Theatre, Glencoe, IL' };
  s.dedupeId(e, { id: 77 }, new Set(['hamlet-regional-2024']));
  assert.equal(e.id, 'hamlet-regional-2024-writers-theatre');
  assert.equal(e.slug, e.id);
});
