import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isCutAtApostrophe } = require('./critic-name-apostrophe.js');

test('names cut at an apostrophe or a bare particle are caught', () => {
  for (const n of ["Holly O'", 'Holly O', 'Holly O’', "Jane D'", 'Ian Mc', 'Sean L']) assert.equal(isCutAtApostrophe(n), true, n);
});

test('full names are not', () => {
  for (const n of ["Holly O'Mahony", 'Ian McKellen', 'Ben Brantley', 'Mark Lawson', 'Jo', 'Unknown', '', null, 'Dan Bacalzo']) assert.equal(isCutAtApostrophe(n), false, String(n));
});

const { isGarbageCriticName } = require('./critic-name-apostrophe.js');
test('OCR residue and fragments are garbage; real names are not', () => {
  for (const n of [":3!-:eridan t1!~rle,,'", "AleksSierz ^ . •'", 'X', '..', 'J0hn Smith', 'Ben BRANTLEYwrites']) assert.equal(isGarbageCriticName(n), true, n);
  for (const n of ['Unknown', "Holly O'Mahony", 'Anne-Marie Duff', 'J. Kelly Nestruck', 'Ian McKellen', 'Zoë Svendsen', 'Dominic Cavendish', 'BWW', 'AP', 'NY1 Staff'.replace('1', '')]) assert.equal(isGarbageCriticName(n), false, n);
});
