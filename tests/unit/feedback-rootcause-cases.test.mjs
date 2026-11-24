// BRO-7919: reader report #1190 ("13 Going on 30 - Toronto run coming up")
// matched two productions, so the intake router parked it as ambiguous and the
// owner got a root-cause button for "router leaves already-fixed asks open".
// Pins: (1) every recorded root-cause case replays green through the REAL
// router, (2) place-word pinning and the bare-ask rule, including the cousins
// that must stay parked, (3) the planner only offers a root-cause button when
// the router still cannot close the ask, (4) the acceptance checker answers for
// reader-feedback-rootcause-<N> keys instead of CANNOT TELL forever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CASES, replayCase, rootCauseIssueNumber } = require('../../scripts/lib/feedback-rootcause-cases.js');
const { planContentRequestActions, pickCandidateByPlace, isBareAskForExisting } = require('../../scripts/lib/content-request-routing.js');
const { isAlreadyInCatalog } = require('../../scripts/lib/feedback-issue-body.js');
const { routerAlreadyInCatalog } = require('../../scripts/lib/feedback-proposal.js');
const { decide } = require('../../scripts/check-alert-condition-absent.js');

test('every recorded root-cause case replays as already in the catalog', () => {
  assert.ok(Object.keys(CASES).length > 0);
  for (const n of Object.keys(CASES)) {
    const r = replayCase(Number(n));
    assert.equal(r.code, 0, `#${n}: ${r.message}`);
  }
});

test('acceptance checker replays reader-feedback-rootcause keys, CANNOT TELL without a case', () => {
  assert.equal(rootCauseIssueNumber('reader-feedback-rootcause-1190'), 1190);
  assert.equal(rootCauseIssueNumber('reader-feedback-1190'), null);
  assert.equal(decide([], 'reader-feedback-rootcause-1190').code, 0);
  assert.equal(decide([], 'reader-feedback-rootcause-999999').code, 3);
  // A regressed router is reported as still firing, not as a pass.
  const broken = { 7: { ...CASES[1190], show: '13 Going on 30' , message: 'Please add 13 Going on 30' } };
  assert.equal(replayCase(7, broken).code, 1);
});

const T = (id, city, status = 'open') => ({ id, title: 'X Show', city, status, category: 'regional', market: 'regional', openingDate: '2026-01-01' });
const TORONTO = T('x-toronto-regional-2026', 'toronto-on', 'upcoming');
const CHICAGO = T('x-chicago-regional-2025', 'chicago-il', 'closed');
const YORK = T('x-york-regional-2026', 'york-uk');
const BWAY = { id: 'x-2026', title: 'X Show', status: 'open', category: 'broadway', market: 'broadway', openingDate: '2026-01-01' };

test('place word pins one production; negated, origin and longer-name mentions do not', () => {
  // A candidate with no city (Broadway/West End rows) means no pin at all.
  assert.equal(pickCandidateByPlace([BWAY, TORONTO], 'X Show is coming to Toronto'), null);
  const c = [CHICAGO, TORONTO, YORK];
  assert.equal(pickCandidateByPlace(c, 'X Show - Toronto run coming up').id, TORONTO.id);
  assert.equal(pickCandidateByPlace(c, 'X Show is coming to Toronto').id, TORONTO.id);
  assert.equal(pickCandidateByPlace(c, 'not the Toronto one'), null);
  assert.equal(pickCandidateByPlace(c, 'X Show transferred from Chicago and is missing reviews'), null);
  assert.equal(pickCandidateByPlace(c, 'X Show played a short Chicago run, now Toronto'), null);
  assert.equal(pickCandidateByPlace(c, 'saw X Show in New York'), null);
  assert.equal(pickCandidateByPlace(c, 'saw X Show in York').id, YORK.id);
  assert.equal(pickCandidateByPlace(c, 'X Show in Toronto and Chicago'), null);
  assert.equal(pickCandidateByPlace([TORONTO, { ...TORONTO, id: 'x-toronto-regional-2027' }], 'Toronto'), null);
  assert.equal(pickCandidateByPlace([{ ...CHICAGO, title: 'Chicago' }, TORONTO], 'Chicago'), null, 'city that is the title');
});

test('bare ask rule: "add" alone closes, change wording and other productions stay parked', () => {
  assert.equal(isBareAskForExisting('Please add X Show', undefined, BWAY), true);
  assert.equal(isBareAskForExisting('Is X Show on here?', undefined, BWAY), true);
  assert.equal(isBareAskForExisting('Please add the cast for X Show', undefined, BWAY), false);
  assert.equal(isBareAskForExisting('Please add the new production of X Show', undefined, BWAY), false);
  assert.equal(isBareAskForExisting('Please add the Toronto run of X Show', 'place', TORONTO), true);
  assert.equal(isBareAskForExisting('Please add X Show', 'place', CHICAGO), false, 'closed production never closes');
  assert.equal(isBareAskForExisting('Please add X Show', undefined, CHECK_CLOSED()), false);
});
function CHECK_CLOSED() { return { ...BWAY, status: 'closed' }; }

test('#1190 shape end to end: ambiguous title pinned by place closes; unpinned stays parked', () => {
  const c = CASES[1190];
  const pinned = planContentRequestActions({ message: c.message, show: c.show, shows: c.shows });
  assert.equal(isAlreadyInCatalog(pinned), true, JSON.stringify(pinned));
  const unpinned = planContentRequestActions({ message: 'Please add 13 Going on 30', show: '13 Going on 30', shows: c.shows });
  assert.equal(isAlreadyInCatalog(unpinned), false);
  assert.equal(unpinned[0].candidateIds.length, 2);
});

test('planner: router-closed ask returns its catalog row (no root-cause button); parked ask returns []', () => {
  const c = CASES[1190];
  const hit = routerAlreadyInCatalog(c.message, c.show, c.shows);
  assert.deepEqual(hit.map((m) => m.id), ['13-going-on-30-toronto-regional-2026']);
  assert.match(hit[0].url, /\/show\/13-going-on-30-toronto-regional-2026$/);
  assert.deepEqual(routerAlreadyInCatalog('Please add 13 Going on 30', '13 Going on 30', c.shows), []);
  assert.deepEqual(routerAlreadyInCatalog(null, null, null), []);
});
