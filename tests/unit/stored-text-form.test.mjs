// BRO-5243: the content verifier must judge the body the collector stores,
// not the raw fetch (burn-this-2019/wsj kept isValid:false for junk it never stored).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { preCleanForStorage, textAsStored } = require('../../scripts/lib/stored-text-form.js');
const { stripTrailingJunk } = require('../../scripts/lib/text-cleaning.js');

// Invented placeholder prose, not review text.
const BODY = 'The revival opens on a bare stage and the cast works hard. '.repeat(12)
  + 'The evening closes on a quiet note. Mr. Critic is the paper’s drama critic. Write to him at critic@example.com.';
const JUNK = '\n\nRecommended Videos Advertisement Houthis widen alliance. Tariff talks stall. Parenting tips for spring.';

test('textAsStored strips trailing WSJ junk the verifier used to see', () => {
  const out = textAsStored(BODY + JUNK);
  assert.ok(out.endsWith('Write to him at critic@example.com.'), 'ends on the sign-off');
  assert.ok(!/Houthis|Tariff/.test(out), 'appended headlines removed');
});

test('textAsStored matches the save path (preCleanForStorage then stripTrailingJunk)', () => {
  for (const raw of [BODY + JUNK, BODY, '  &amp; ' + BODY + '  ']) {
    assert.equal(textAsStored(raw), stripTrailingJunk(preCleanForStorage(raw)));
  }
});

test('textAsStored passes empty and non-string input through', () => {
  assert.equal(textAsStored(''), '');
  assert.equal(textAsStored(null), null);
  assert.equal(textAsStored(undefined), undefined);
});

test('textAsStored keeps only this show\'s section of a multi-show post, like the save path', () => {
  const { isolateMultiShowSection } = require('../../scripts/lib/multi-show-section-extract.js');
  const url = 'https://theinterestedbystander.com/2026/03/01/an-ark-pen-pals/';
  // Synthetic post in the interestedbystander shape (invented text).
  const post = 'An Ark (c) A. PhotographerTheater: An Ark At the Shed The view is surreal and the seats are odd. '
    + 'Pen Pals (c) B. PhotographerTheater: Pen Pals At Theatre at St. Clement’s Two strangers write letters. The end of pen pals.';
  const out = textAsStored(post, { url, showTitle: 'Pen Pals' });
  assert.match(out, /^Pen Pals \(c\)/);
  assert.doesNotMatch(out, /surreal/);
  const pre = preCleanForStorage(post);
  assert.equal(out, stripTrailingJunk(isolateMultiShowSection(url, pre, 'Pen Pals').text));
  // a refusal stores nothing on the save path, so nothing is returned to verify (BRO-5261)
  assert.equal(textAsStored(post, { url, showTitle: 'Stereophonic' }), null);
  const { storedTextForm } = require('../../scripts/lib/stored-text-form.js');
  assert.deepEqual(storedTextForm(post, { url, showTitle: 'Stereophonic' }), { text: null, refused: true });
  assert.equal(storedTextForm(post, { url, showTitle: 'Pen Pals' }).refused, false);
  // a single-review host is untouched
  assert.equal(textAsStored(post, { url: 'https://www.wsj.com/articles/x', showTitle: 'Pen Pals' }), textAsStored(post));
});
