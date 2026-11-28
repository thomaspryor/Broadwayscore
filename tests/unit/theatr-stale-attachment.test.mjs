import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { closedBeforeTheatr } = require('../../scripts/lib/theatr-stale-attachment.js');
const { planStaleTheatrRemoval } = require('../../scripts/neutralize-stale-theatr-buzz.js');
const { matchTheatrToShows } = require('../../scripts/scrape-theatr-audience.js');
const { audit } = require('../../scripts/audit-audience-buzz-contamination.js');

test('closedBeforeTheatr: only shows closed before 2021', () => {
  assert.equal(closedBeforeTheatr({ status: 'closed', closingDate: '2008-01-06' }), true);
  assert.equal(closedBeforeTheatr({ status: 'closed', closingDate: '2022-09-18' }), false);
  assert.equal(closedBeforeTheatr({ status: 'open', closingDate: null }), false);
  assert.equal(closedBeforeTheatr(null), false);
});

test('matcher refuses to attach a modern Theatr listing to a show closed before Theatr existed', () => {
  const theatr = [{ id: 1, name: 'The Weir', eventCategory: 'Off-Broadway' }];
  const old = { id: 'the-weir-1999', title: 'The Weir', status: 'closed', openingDate: '1999-04-01', closingDate: '1999-09-01', category: 'broadway' };
  assert.equal(matchTheatrToShows(theatr, [old]).length, 0);
  const modern = { id: 'the-weir-off-broadway-2026', title: 'The Weir', status: 'open', openingDate: '2026-03-01', category: 'off-broadway' };
  assert.equal(matchTheatrToShows(theatr, [old, modern])[0].show.id, modern.id);
});

test('plan drops Theatr only from pre-2021 closures and recomputes the score', () => {
  const shows = [
    { id: 'old-1999', status: 'closed', closingDate: '1999-09-01', category: 'broadway' },
    { id: 'dehr-2016', status: 'closed', closingDate: '2022-09-18', category: 'broadway' },
  ];
  const t = { score: 20, reviewCount: 40 };
  const buzz = {
    'old-1999': { combinedScore: 50, sources: { theatr: t, showScore: { score: 90, reviewCount: 100 } } },
    'dehr-2016': { combinedScore: 80, sources: { theatr: t } },
  };
  const plan = planStaleTheatrRemoval(buzz, shows);
  assert.deepEqual(plan.map((p) => p.id), ['old-1999']);
  assert.equal(plan[0].after, 90);
});

test('audit flags Theatr on a pre-2021 closure, not on a 2022 closure; small-n divergence is not a finding', () => {
  const shows = [
    { id: 'old-1999', title: 'Old', status: 'closed', openingDate: '1999-04-01', closingDate: '1999-09-01', category: 'broadway' },
    { id: 'dehr-2016', title: 'Dear', status: 'closed', openingDate: '2016-12-04', closingDate: '2022-09-18', category: 'broadway' },
    { id: 'new-2026', title: 'New', status: 'open', openingDate: '2026-03-01', category: 'broadway' },
  ];
  const t = { score: 40, reviewCount: 15 };
  const buzz = { shows: {
    'old-1999': { title: 'Old', sources: { theatr: { score: 70, reviewCount: 30 } } },
    'dehr-2016': { title: 'Dear', sources: { theatr: { score: 80, reviewCount: 266 } } },
    'new-2026': { title: 'New', sources: { theatr: t, showScore: { score: 83, reviewCount: 200 }, mezzanine: { score: 85, reviewCount: 90 } } },
  } };
  const issues = audit({ shows, buzz, today: '2026-10-13' });
  const byId = Object.fromEntries(issues.map((i) => [i.id, i]));
  assert.ok(byId['old-1999'].flags.some((f) => f.startsWith('OTHER_SOURCE_STALE')));
  assert.equal(byId['dehr-2016'], undefined);
  assert.equal(byId['new-2026'], undefined, 'rc=15 divergence is below the noise floor');
  buzz.shows['new-2026'].sources.theatr = { score: 40, reviewCount: 60 };
  const again = audit({ shows, buzz, today: '2026-10-13' }).find((i) => i.id === 'new-2026');
  assert.equal(again.severity, 'info', 'a real-n platform disagreement is listed but never gated');
});

test('BRO-5276: the cleanup removes the source, leaves the tombstone, and reconcile does not refill it', () => {
  const { planStaleTheatrRemoval, applyStaleTheatrRemoval } = require('../../scripts/neutralize-stale-theatr-buzz.js');
  const { reconcileAudienceBuzz } = require('../../scripts/lib/reconcile-audience-buzz.js');
  const shows = [{ id: 'old-1999', status: 'closed', closingDate: '1999-09-01', category: 'broadway' }];
  const theatr = { score: 20, reviewCount: 40 };
  const ours = { 'old-1999': { combinedScore: 50, sources: { theatr, showScore: { score: 90, reviewCount: 100 } } } };
  const remote = { shows: { 'old-1999': { sources: { theatr } } } };
  applyStaleTheatrRemoval(ours, planStaleTheatrRemoval(ours, shows));
  assert.equal(ours['old-1999'].sources.theatr, undefined);
  assert.ok(ours['old-1999'].sourcesRemoved.theatr);
  reconcileAudienceBuzz({ shows: ours }, remote, {});
  assert.equal(ours['old-1999'].sources.theatr, undefined, 'push reconcile must not bring it back');
  assert.equal(ours['old-1999'].combinedScore, 90);
});
