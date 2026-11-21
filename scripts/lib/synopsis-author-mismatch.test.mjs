// BRO-5080: Home Front 1985 (James Duff) was saved with Warren Leight's 2023
// Home Front. A synopsis lead naming an author the row's credits lack is
// rejected at write time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { synopsisAuthorMismatch, classifyBadSynopsis } = require('./synopsis-validation.js');
const row = (synopsis, writers) => ({ synopsis, creativeTeam: writers.map(([name, role]) => ({ name, role })) });

test('a lead naming another author is a mismatch', () => {
  assert.equal(synopsisAuthorMismatch(row('Home Front is a play by Warren Leight. It tells the story of an interracial couple who meet on V-J Day.', [['James Duff', 'Playwright']])), 'Warren Leight');
});

test('credited authors, descriptors and co-writers pass', () => {
  assert.equal(synopsisAuthorMismatch(row('Burn This is a play by Lanford Wilson. Like many of his works it follows a dancer.', [['Lanford Wilson', 'Playwright']])), null);
  assert.equal(synopsisAuthorMismatch(row('A new play by Pulitzer Prize winner Stephen Adly Guirgis, based on the true crime story.', [['Stephen Adly Guirgis', 'Playwright']])), null);
  assert.equal(synopsisAuthorMismatch(row('Red is a play by American playwright John Logan about the painter Mark Rothko.', [['John Logan', 'Playwright']])), null);
  assert.equal(synopsisAuthorMismatch(row('Not Now, Darling is a farce by Ray Cooney and John Chapman set in a fur salon.', [['Ray Cooney and John Chapman', 'Playwright']])), null);
});

test('source-work authors, sentence fragments and rows without writer credits are left alone', () => {
  assert.equal(synopsisAuthorMismatch(row('Rockabye Hamlet is a rock musical based on the play by William Shakespeare, told through song.', [['Cliff Jones', 'Book']])), null);
  assert.equal(synopsisAuthorMismatch(row('The Octette Bridge Club is a play by P. Set in Providence, Rhode Island, it follows eight sisters.', [['P. J. Barry', 'Playwright']])), null);
  assert.equal(synopsisAuthorMismatch(row('Home Front is a play by Warren Leight. It tells the story of a couple.', [['Someone', 'Director']])), null);
});

test('a stored synopsis is not re-flagged bad for it (the credit may be the wrong side)', () => {
  assert.equal(classifyBadSynopsis(row('Sweetmeats is a play by Karim Khan that tells the story of Hema and Liaqat, a couple who run a sweet shop in east London.', [['George Kaufman', 'Playwright']])).bad, false);
});

test('review fixes: music directors are not writers, award phrases are not names, "from" in a title is not a source', () => {
  assert.equal(synopsisAuthorMismatch(row('Cabaret is a musical by John Kander and Fred Ebb set in Weimar Berlin.', [['X Y', 'Director'], ['Z W', 'Music Director']])), null);
  assert.equal(synopsisAuthorMismatch(row('Eclipsed is a play by Tony Award nominee Danai Gurira about women in the Liberian civil war.', [['Danai Gurira', 'Playwright']])), null);
  assert.equal(synopsisAuthorMismatch(row('Notes from the Field is a play by Someone Else about the school-to-prison pipeline.', [['Anna Deavere Smith', 'Playwright']])), 'Someone Else');
});

test('the shared synopsis gate rejects another author unless the page identity is already confirmed', () => {
  const { gateScrapedSynopsis } = require('./synopsis-fact-check.js');
  const show = { title: 'Home Front', status: 'closed', creativeTeam: [{ name: 'James Duff', role: 'Playwright' }] };
  const text = 'Home Front is a play by Warren Leight. It tells the story of an interracial couple who meet while celebrating V-J Day in 1945.';
  assert.equal(gateScrapedSynopsis(show, text, { showsById: {}, awardsByShow: {} }).ok, false);
  assert.equal(gateScrapedSynopsis(show, text, { showsById: {}, awardsByShow: {}, checkAuthor: false }).ok, true);
});
