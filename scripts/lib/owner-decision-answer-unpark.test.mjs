// BRO-6330: once a card's last open decision is answered, a park line that only
// waited on the owner's call is marked UNPARKED (reason kept); parks naming a
// real block stay. recordAnswer applies this only when a marker was rewritten,
// no DECISION NEEDED line remains, and the answer is not a visual approval.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { unparkOwnerHolds } = require('../../src/lib/owner-decision-link.js');

test('owner-call park lines from real stuck cards are marked UNPARKED, reason kept', () => {
  for (const [line, want] of [
    ["PARKED: needs the owner's call on caveat versus adding the credit", // BRO-5605
      "UNPARKED (owner-answered): needs the owner's call on caveat versus adding the credit"],
    ['PARKED: Needs a product call on team-credit pages vs individual pages', // BRO-5406
      'UNPARKED (owner-answered): Needs a product call on team-credit pages vs individual pages'],
    ['PARKED: owner decision', 'UNPARKED (owner-answered): owner decision'], // BRO-6111
    ['PARKED: Prototype + plan for owner approval; nothing posts until then', // BRO-6250
      'UNPARKED (owner-answered): Prototype + plan for owner approval; nothing posts until then'],
  ]) {
    assert.deepEqual(unparkOwnerHolds([line, '## Problem']), [want, '## Problem'], line);
  }
});

test('parks naming a real block stay parked even when they mention the owner', () => {
  const kept = [
    'PARKED: owner must add the API key',
    "PARKED: waits on the owner's Mac",
    'PARKED: Auto-filed by owner-alert-router (condition: cron-health-chronic:x)',
    'PARKED: not an owner decision, needs a §18 review',
    'PARKED: UI change on /biz: needs a /visual-qa pass',
    'PARKED: needs live ScrapingBee credits',
  ];
  assert.deepEqual(unparkOwnerHolds(kept), kept);
});

test('body text that mentions the owner is untouched', () => {
  const body = ['## Problem', 'The owner decision on 10-25 picked A.', 'ANSWERED by the owner (see the "Owner decision" comment on this card).'];
  assert.deepEqual(unparkOwnerHolds(body), body);
});
