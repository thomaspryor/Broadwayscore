// BRO-6330: a recorded owner answer drops the card's owner-hold park line so
// workers can pick the card up; parks for other reasons stay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { unparkOwnerHolds } = require('../../src/lib/owner-decision-link.js');

test('owner-call park lines from real stuck cards are removed', () => {
  for (const line of [
    "PARKED: needs the owner's call on caveat versus adding the credit", // BRO-5605
    'PARKED: Needs a product call on team-credit pages vs individual pages before building', // BRO-5406
    'PARKED: owner decision', // BRO-6111
    'PARKED: Prototype + plan for owner approval; nothing posts or lands until then', // BRO-6250
  ]) {
    assert.deepEqual(unparkOwnerHolds([line, '', '## Problem']), ['', '## Problem'], line);
  }
});

test('parks for other reasons survive an answer', () => {
  const kept = [
    'PARKED: UI change on /biz: needs a /visual-qa pass', // BRO-5109
    'PARKED: needs live ScrapingBee credits',
    'PARKED: Mac-only launchd step',
  ];
  assert.deepEqual(unparkOwnerHolds(kept), kept);
});

test('body text that mentions the owner is untouched', () => {
  const body = ['## Problem', 'The owner decision on 10-25 picked A.', 'ANSWERED by the owner (see the "Owner decision" comment on this card).'];
  assert.deepEqual(unparkOwnerHolds(body), body);
});
