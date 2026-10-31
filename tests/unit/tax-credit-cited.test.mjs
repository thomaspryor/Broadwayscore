// NY tax credit "cited as received" detection (BRO-4989 shadow). require()s
// the real helper (§15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { taxCreditCited } = require('../../scripts/lib/tax-credit-cited');

test('received, paid and part-of-position wording counts', () => {
  for (const notes of [
    'Received $3M NY state tax credit',
    'Received maximum $3M NY tax credit but insufficient to save production',
    'recouped about nine months after closing, helped by the revived NY State Broadway tax credit (Deadline)',
  ]) assert.equal(taxCreditCited({ notes }).cited, true, notes);
});

test('eligible, expected and conditional wording does not', () => {
  for (const notes of [
    'Eligible for $3M NY tax credit',
    'Expected ~$2M NY tax credit',
    'High end: ~65% if NY State tax credit (up to $3M) is received',
    'Qualified for the NY State theater tax credit',
    'Eligible for $3M tax credit (would reduce net loss to ~$3M)',
    // future tense and negations (ship-check review): never "received"
    "NYT: 'has not recouped those costs, but with the help of a New York state tax credit will get part way there'",
    'Has not yet received its NY tax credit',
    'Producers received no tax credit',
    "Tax credit received? Unknown",
    "Hasn't received the tax credit",
    '',
  ]) assert.equal(taxCreditCited({ notes }).cited, false, notes);
  assert.equal(taxCreditCited(null).cited, false);
});

test('a later clause does not borrow "received" from an earlier sentence', () => {
  assert.equal(taxCreditCited({ notes: 'Investors received nothing. Eligible for $3M tax credit' }).cited, false);
});

test('an explicit source field wins and is checked in other fields', () => {
  assert.deepEqual(taxCreditCited({ taxCreditReceivedSource: 'Deadline, Jun 2026' }), { cited: true, quote: 'Deadline, Jun 2026' });
  assert.equal(taxCreditCited({ estimatedRecoupmentSource: 'Variety: received its $3M tax credit' }).cited, true);
});
