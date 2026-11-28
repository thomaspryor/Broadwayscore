// LIVE-DATA-LANE: reads data/venue-metros.json (read by the test). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const s = require('./tic-stage.js');
const { getCity } = require('./tic-cities.js');

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
test('buildShowEntry: keeps the theatre website as officialUrl only when first-party (BRO-7668)', () => {
  const detail = (website) => ({ venue: 'Steppenwolf Theatre', address: '1650 N Halsted St Chicago', showType: 'Play', website });
  const own = s.buildShowEntry({ page: page(), detail: detail('http://www.steppenwolf.org'), dates: { openingDate: '2024-03-02' }, discoveredAt: '2026-10-29' });
  assert.equal(own.officialUrl, 'https://www.steppenwolf.org');
  const other = s.buildShowEntry({ page: page(), detail: detail('http://www.chicagotribune.com/x'), dates: { openingDate: '2024-03-02' }, discoveredAt: '2026-10-29' });
  assert.equal(other.officialUrl, undefined);
  const none = s.buildShowEntry({ page: page(), detail: detail(null), dates: { openingDate: '2024-03-02' }, discoveredAt: '2026-10-29' });
  assert.equal('officialUrl' in none, false);
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
  const tour = { id: 'p', title: 'Parade', category: 'tour', openingDate: '2025-02-01' };
  // BRO-8454: a tour is a duplicate only when it plays Chicago near the dates.
  assert.equal(s.findDuplicate(e, [tour], undefined, () => [{ city: 'Chicago, IL', venue: 'CIBC Theatre', start: '2025-05-20', end: '2025-06-08' }]), tour);
  assert.equal(s.findDuplicate(e, [tour], undefined, () => [{ city: 'Denver, CO', venue: 'Buell', start: '2025-05-20', end: '2025-06-08' }]), null);
  assert.equal(s.findDuplicate(e, [{ id: 'p', title: 'Parade', category: 'broadway', openingDate: '1998-12-17' }]), null);
});

test('findDuplicate: a same-title production in another market or metro is not a duplicate (BRO-8450)', () => {
  const e = { title: 'A Christmas Carol', openingDate: '2026-11-20' };
  const others = [
    { id: 'a-christmas-carol-west-end-2026', title: 'A Christmas Carol', category: 'west-end', venue: 'Old Vic, London', openingDate: '2026-11-25' },
    { id: 'acc-ob', title: 'A Christmas Carol', category: 'off-broadway', venue: 'Theatre, New York, NY', openingDate: '2026-12-01' },
    { id: 'acc-manc', title: 'A Christmas Carol', category: 'regional', venue: 'Royal Exchange, Manchester', openingDate: '2026-11-28' },
    { id: 'acc-bos', title: 'A Christmas Carol', category: 'regional', venue: 'Huntington Theatre, Boston, MA', openingDate: '2026-11-28' },
  ];
  assert.equal(s.findDuplicate(e, others), null);
  // The same metro still dedupes, whatever the stored category.
  assert.ok(s.findDuplicate(e, [{ id: 'acc-chi', title: 'A Christmas Carol', category: 'regional', venue: 'Goodman Theatre, Chicago, IL', openingDate: '2026-11-15' }]));
  // A non-regional row in this metro reaches the final check and still dedupes.
  assert.equal(s.findDuplicate(e, [{ id: 'acc-try', title: 'A Christmas Carol', category: 'off-broadway', venue: 'Goodman Theatre, Chicago, IL', openingDate: '2026-11-15' }])?.id, 'acc-try');
  // Outside the 120-day window it is a different run.
  assert.equal(s.findDuplicate(e, [{ id: 'acc-old', title: 'A Christmas Carol', category: 'regional', venue: 'Goodman Theatre, Chicago, IL', openingDate: '2025-11-15' }]), null);
});

test('findDuplicate: the stored metro slug wins over the venue string (BRO-8450)', () => {
  const e = { title: 'Hamlet', openingDate: '2026-03-01' };
  // Venue text the Chicago pattern cannot read, but the row is stored as Chicago.
  assert.ok(s.findDuplicate(e, [{ id: 'h1', title: 'Hamlet', category: 'regional', city: 'chicago-il', venue: 'Writers Theatre', openingDate: '2026-03-05' }]));
  // Venue text that looks like Illinois/Indiana, but the row is stored in another metro.
  assert.equal(s.findDuplicate(e, [{ id: 'h2', title: 'Hamlet', category: 'regional', city: 'indianapolis-in', venue: 'Phoenix Theatre, Indianapolis, IN', openingDate: '2026-03-05' }]), null);
});

test('findDuplicate: DC and LA match by metro, not by market label (BRO-8450)', () => {
  const dc = getCity('dc');
  const la = getCity('la');
  const e = { title: 'Candide', openingDate: '2026-04-01' };
  assert.ok(s.findDuplicate(e, [{ id: 'c-dc', title: 'Candide', category: 'regional', city: dc.metro, venue: 'Arena Stage, Washington, DC', openingDate: '2026-04-03' }], dc));
  // No stored slug: placed from the venue through the metro table.
  assert.ok(s.findDuplicate(e, [{ id: 'c-dc2', title: 'Candide', category: 'off-broadway', venue: 'Arena Stage, Washington, DC', openingDate: '2026-04-03' }], dc));
  assert.equal(s.findDuplicate(e, [{ id: 'c-la', title: 'Candide', category: 'regional', city: la.metro, venue: 'LA Opera, Los Angeles, CA', openingDate: '2026-04-03' }], dc), null);
  assert.equal(s.findDuplicate(e, [{ id: 'c-we', title: 'Candide', category: 'west-end', venue: 'Old Vic, London', openingDate: '2026-04-03' }], la), null);
  assert.equal(s.findDuplicate(e, [{ id: 'c-chi', title: 'Candide', category: 'regional', city: 'chicago-il', venue: 'Goodman Theatre, Chicago, IL', openingDate: '2026-04-03' }], la), null);
});

test('dedupeId: venue suffix on an id collision', () => {
  const e = { id: 'hamlet-regional-2024', slug: 'hamlet-regional-2024', venue: 'Writers Theatre, Glencoe, IL' };
  s.dedupeId(e, { id: 77 }, new Set(['hamlet-regional-2024']));
  assert.equal(e.id, 'hamlet-regional-2024-writers-theatre');
  assert.equal(e.slug, e.id);
});
