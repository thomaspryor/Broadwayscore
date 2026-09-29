import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { extractShowSection, findSectionHeadings } = require('./multi-show-section-extract.js');
const { stripVenueListingsTrailer, detectTruncationSignals } = require('./content-quality.js');

// Synthetic post mirroring the real interestedbystander shape (real text is private/copyrighted).
const POST =
  'An Ark (c) Rachel Louise BrownTheater: An Ark At the Shed If you have ever gone up the Vessel the view is surreal. ' +
  'The filmed play is written by A. Writer. An Ark (c) Marc J. FranklinAN ARK (THE HAPPENING): Start with the journey to your seat. ' +
  'Try/Step/Trip (c) The Living Word ProjectTheater: Try/Step/Trip Under the Radar at A.R.T. New York Theatres The title of the piece is a dance. ' +
  'Try/Step/Trip (c) The Living Word ProjectThe story, as told, is short. ' +
  'Pen Pals (c) Russ RowlandTheater: Pen Pals At Theatre at St. Clement’s It seems two strangers write letters. The end of pen pals.';

test('keeps only the target show section', () => {
  const r = extractShowSection(POST, 'Try/Step/Trip');
  assert.ok(r);
  assert.match(r.text, /^Try\/Step\/Trip \(c\)/);
  assert.match(r.text, /story, as told/);
  assert.doesNotMatch(r.text, /Vessel|Pen Pals At|two strangers/);
});

test('first and last sections cut correctly', () => {
  const first = extractShowSection(POST, 'An Ark');
  assert.match(first.text, /^An Ark \(c\) Rachel/);
  assert.doesNotMatch(first.text, /Try\/Step|Pen Pals/);
  const last = extractShowSection(POST, 'Pen Pals');
  assert.match(last.text, /^Pen Pals \(c\)/);
  assert.doesNotMatch(last.text, /Vessel|Living Word/);
  assert.equal(last.end, POST.length);
});

test('absent or non-multi-show returns null, never the whole post', () => {
  assert.equal(extractShowSection(POST, 'Stereophonic'), null);
  assert.equal(extractShowSection('Just one review (c) Someone Theater: Just one', 'Just one'), null);
  assert.equal(findSectionHeadings(POST).length, 3);
});

test('title that is a prefix of another does not match it', () => {
  const t = 'Pen (c) A BTheater: Pen Show one body text. Pen Pals (c) C DTheater: Pen Pals Show two body.';
  assert.match(extractShowSection(t, 'Pen Pals').text, /^Pen Pals/);
  assert.equal(extractShowSection(t, 'Pen Pals').text.includes('Show one'), false);
});

const BODY = 'The production is a triumph of design and performance, and it rewards close attention across its full running time. '.repeat(2);
test('trailing venue address classifies complete', () => {
  const t = BODY + 'Hayes Theater 240 West 44th Street New York, NY 10036';
  assert.ok(!detectTruncationSignals(t).signals.includes('no_ending_punctuation'));
  assert.equal(stripVenueListingsTrailer(t).endsWith('time.'), true);
});
test('listings trailer classifies complete', () => {
  const t = BODY + 'Listings and ticket information can be found here';
  assert.ok(!detectTruncationSignals(t).signals.includes('no_ending_punctuation'));
});
test('mid-sentence truncation before an address stays flagged', () => {
  const t = BODY + 'and then the second act begins with Hayes Theater 240 West 44th Street New York, NY 10036';
  assert.ok(detectTruncationSignals(t).signals.includes('no_ending_punctuation'));
});
test('genuinely unpunctuated ending stays flagged', () => {
  assert.ok(detectTruncationSignals(BODY + 'and the cast then moves on to').signals.includes('no_ending_punctuation'));
});

test('classifyContentTier: complete review + venue address trailer is not truncated', () => {
  const { classifyContentTier } = require('./content-quality.js');
  const prose = 'A wonderfully staged evening with sharp performances and a clear point of view about ambition and loss. '.repeat(30);
  for (const trailer of ['Hayes Theater 240 West 44th Street New York, NY 10036', 'Listings and ticket information can be found here']) {
    const r = classifyContentTier({ fullText: prose + trailer });
    assert.equal(r.contentTier, 'complete', trailer);
  }
});

test('accented show titles match whole, not shredded at the accent', () => {
  const t = 'Les Misérables (c) A BTheater: Les Misérables Body one text here. Pen Pals (c) C DTheater: Pen Pals Body two.';
  const r = extractShowSection(t, 'Les Miserables');
  assert.ok(r && /Body one/.test(r.text) && !/Body two/.test(r.text));
});
