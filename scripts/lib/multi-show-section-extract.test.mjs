import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { extractShowSection, findSectionHeadings, isolateMultiShowSection, isMultiShowPostUrl, isolateMultiShowSectionForShowId } = require('./multi-show-section-extract.js');
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

// Shared gate used by collect-review-texts.js AND ingest-review-from-url.js.
const IB_URL = 'https://theinterestedbystander.com/2026/03/01/an-ark-try-step-trip-pen-pals/';

test('isolateMultiShowSection: multi-show host keeps only the section', () => {
  const r = isolateMultiShowSection(IB_URL, POST, 'Pen Pals');
  assert.equal(r.action, 'isolated');
  assert.match(r.text, /^Pen Pals \(c\)/);
  assert.doesNotMatch(r.text, /Vessel|Try\/Step\/Trip Under/);
});

test('isolateMultiShowSection: section not found in a multi-section post refuses (stores nothing)', () => {
  const r = isolateMultiShowSection(IB_URL, POST, 'Stereophonic');
  assert.equal(r.action, 'refuse');
  assert.equal(r.text, null);
});

test('isolateMultiShowSection: single-section post on the host and other hosts pass text through', () => {
  const one = 'Giulia (c) PhotogTheater: Giulia At the Mint A whole review of one show.';
  assert.deepEqual(isolateMultiShowSection(IB_URL, one, 'Giulia'), { action: 'single-section', text: one });
  assert.deepEqual(isolateMultiShowSection('https://www.nytimes.com/x.html', POST, 'Pen Pals'), { action: 'not-multi-show', text: POST });
  assert.equal(isMultiShowPostUrl('https://www.theinterestedbystander.com/x'), true);
});

// The corpus spelling (69 review-texts files, all 20 reviews.json rows): www.interestedbystander.com.
test('isMultiShowPostUrl matches the real www.interestedbystander.com host', () => {
  assert.equal(isMultiShowPostUrl('https://www.interestedbystander.com/2024/04/stereophonic/'), true);
  assert.equal(isolateMultiShowSection('https://www.interestedbystander.com/2026/03/post/', POST, 'Pen Pals').action, 'isolated');
  assert.equal(isMultiShowPostUrl('https://notinterestedbystander.com/x'), false);
});

test('isolateMultiShowSectionForShowId looks the title up in shows.json (unknown id => refuse, never the whole post)', () => {
  const r = isolateMultiShowSectionForShowId('https://www.interestedbystander.com/p/', POST, 'no-such-show-id-9999');
  assert.equal(r.action, 'refuse');
  assert.equal(isolateMultiShowSectionForShowId('https://www.nytimes.com/x', POST, 'x').action, 'not-multi-show');
});

// Corpus sweep decision (scripts/isolate-multi-show-sections.js planIsolation).
const { planIsolation } = require('./multi-show-isolation-plan.js');
const SB_POST = 'DRAG (c) PhotogOff-Broadway: DRAG: The Musical At New World Stages A drag review. ' +
  'Sunset Blvd (c) Marc BrennerBroadway: Sunset Blvd At the St. James Theatre I have seen it. The end.';

test('planIsolation: whole post reduced to the section, CV whole-post verdict auto-cleared, rescore queued', () => {
  const data = { url: 'https://www.interestedbystander.com/2024/11/capsule.html', fullText: SB_POST,
    wrongShow: true, wrongShowReason: 'CV-promoted: The scraped content reviews "DRAG: The Musical"',
    contentVerification: { wrongArticle: true } };
  const p = planIsolation(data, 'sunset-boulevard-2024', '2026-09-29T00:00:00.000Z');
  assert.ok(p && p.data);
  assert.match(p.data.fullText, /^Sunset Blvd \(c\)/);
  assert.doesNotMatch(p.data.fullText, /DRAG/);
  assert.equal(p.data.wrongShow, false);
  assert.ok(p.data.wrongShowAutoCleared);
  assert.equal(p.data.contentVerification.wrongArticle, false);
  assert.equal(p.data.contentVerification.staleWholePostVerdict, true);
  assert.equal(p.data.needsRescore, true);
  assert.deepEqual(p.clearedFlags, ['wrongShow']);
  // idempotent: the isolated section is a single-section text
  assert.equal(planIsolation(p.data, 'sunset-boulevard-2024', '2026-09-29T00:00:00.000Z'), null);
});

test('planIsolation: a human/other-reason wrongShow is left alone; other hosts untouched', () => {
  const data = { url: 'https://www.interestedbystander.com/x.html', fullText: SB_POST, wrongShow: true, wrongShowReason: 'manual: wrong show' };
  const p = planIsolation(data, 'sunset-boulevard-2024', '2026-09-29T00:00:00.000Z');
  assert.equal(p.data.wrongShow, true);
  assert.equal(planIsolation({ url: 'https://www.nytimes.com/x', fullText: SB_POST }, 'sunset-boulevard-2024', 'x'), null);
});
