/**
 * byline-normalization regression tests.
 *
 * Per CLAUDE.md rule 15 this require()s the real function — no logic copied.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeBylineCapture, leadingPersonName } = require('./byline-normalization.js');

test('strips a leading job-title prefix from a byline capture', () => {
  assert.equal(normalizeBylineCapture('Senior Editor Jane Doe'), 'Jane Doe');
  assert.equal(normalizeBylineCapture('Contributing Critic John Smith'), 'John Smith');
  assert.equal(normalizeBylineCapture('Chief Theatre Critic Sarah Lee'), 'Sarah Lee');
});

test('leaves an ordinary two-word name untouched', () => {
  assert.equal(normalizeBylineCapture('Franco Milazzo'), 'Franco Milazzo');
});

test('does not strip when the job-title word is the only token before a single-word remainder', () => {
  // "Chief Editor" with no name after it isn't a byline this normalizer can fix —
  // require a 2+ word remainder so it doesn't eat a real one-word capture.
  assert.equal(normalizeBylineCapture('Chief Editor'), 'Chief Editor');
});

test('still title-cases an ALL-CAPS name after stripping a job-title prefix', () => {
  assert.equal(normalizeBylineCapture('SENIOR EDITOR JANE DOE'), 'Jane Doe');
});

// BRO-3919: reviewer credit printed as the body's last line.
const { extractBodyByline } = require('./byline-normalization.js');
const { extractBylineFromText } = require('./byline-from-text.js');

test('extractBodyByline: recovers trailing reviewer credits (real corpus shapes)', () => {
  assert.equal(extractBodyByline('… It runs until 1 August. Tickets: here. Review: Emma Foxhall Photos Helen Murray'), 'Emma Foxhall');
  assert.equal(extractBodyByline('Tickets: here.\n\nReview: Sunita Jaswal Photo: Mark Douet'), 'Sunita Jaswal');
  assert.equal(extractBodyByline('well worth seeing. Review: Jack Shaw Photos: Harry Elletson'), 'Jack Shaw');
  assert.equal(extractBodyByline('until 17th April 2027 Reviewer: Helena FeatherstonePhotos: Johan Persson'), 'Helena Featherstone');
  assert.equal(extractBodyByline('just two hours in all. Reviewer: Vera Liber'), 'Vera Liber');
  assert.equal(extractBodyByline('Brittany Bradford, Aaron Costa Ganis and Triney Sandoval. Reviewed by Jonathan Mandell'), 'Jonathan Mandell');
  assert.equal(extractBodyByline('to make new memories. Reviewer: Anita-Marguerite Butler'), 'Anita-Marguerite Butler');
});

test('extractBodyByline: rejects headlines, chrome, show titles and mid-text credits', () => {
  // related-articles rails: "<Headline> Review: <Title>" at the very end
  assert.equal(extractBodyByline('You might be interested in August 1, 2024 ‘Life and Trust’ Review: Faustian Bargains'), null);
  assert.equal(extractBodyByline('Stories you may also like… Sep 28, 2026 Staatsoper Berlin 2026–27 Review: La Vestale'), null);
  assert.equal(extractBodyByline('Submit Review Close'), null);
  assert.equal(extractBodyByline('A strong night.\nReview: Act One', { showTitle: 'Act One' }), null);
  assert.equal(extractBodyByline('Review: Emma Foxhall\n' + 'More prose follows for a long while. '.repeat(20)), null);
  assert.equal(extractBodyByline('Review: The Theatre Team'), null);
  assert.equal(extractBodyByline(''), null);
  assert.equal(extractBodyByline(null), null);
});

test('extractBylineFromText: falls back to the trailing credit for any outlet', () => {
  assert.deepEqual(extractBylineFromText('london-theatre-reviews', 'Great show.\n\nReview: Oliver Popa Photos: Mark Senior'), { name: 'Oliver Popa', known: true });
  assert.equal(extractBylineFromText('london-theatre-reviews', 'Great show with no credit.'), null);
  assert.deepEqual(extractBylineFromText('plays-international', 'Mark Shenton in the West End ★★★★☆ 22 July 2026 Great.'), { name: 'Mark Shenton', known: true });
});

test('otherNamedCriticAtOutlet: an Unknown file beside a different named critic stays Unknown (heart-wall)', () => {
  const { otherNamedCriticAtOutlet } = require('./byline-from-text.js');
  const seen = new Set(['london-theatre|julia-rank', 'timeout-london|isobel-lewis']);
  assert.equal(otherNamedCriticAtOutlet(seen, 'london-theatre', 'jack-shaw'), true);
  assert.equal(otherNamedCriticAtOutlet(seen, 'london-theatre', 'julia-rank'), false, 'same critic still dedups as exact');
  assert.equal(otherNamedCriticAtOutlet(seen, 'london-theatre-reviews', 'jack-shaw'), false);
  assert.equal(otherNamedCriticAtOutlet(new Set(['x|unknown']), 'x', 'jack-shaw'), false);
});

// BRO-5444: the WET roundup byline kept "Holly O'" of "Holly O'Mahony".
test('leadingPersonName keeps O\', Mc, D\' and hyphenated surnames whole', () => {
  assert.equal(leadingPersonName("Holly O'Mahony"), "Holly O'Mahony");
  assert.equal(leadingPersonName('Holly O’MahonyThe Stage'), 'Holly O’Mahony');
  assert.equal(leadingPersonName('Ian McKellen, Guardian'), 'Ian McKellen');
  assert.equal(leadingPersonName("Anya D'Souza"), "Anya D'Souza");
  assert.equal(leadingPersonName('Sam Smith-Jones'), 'Sam Smith-Jones');
  assert.equal(leadingPersonName('Arifa AkbarThe Guardian'), 'Arifa Akbar');
  assert.equal(leadingPersonName('Unknown'), null);
  assert.equal(leadingPersonName(''), null);
});

// BRO-5420: decoration around a byline is stripped at save time.
test('sanitizeCriticName strips pronoun tags, role titles, HTML, escapes and OCR tails', async () => {
  const { sanitizeCriticName } = require('./byline-normalization.js');
  const cases = {
    'Bethan Warriner (she/her)': 'Bethan Warriner',
    'Ron Fassler (critic)': 'Ron Fassler',
    'Debra Craine, Chief Dance Critic': 'Debra Craine',
    'Victor Gluck, Editor-in-Chief': 'Victor Gluck',
    'Drew Sitton • Times of San Diego': 'Drew Sitton',
    'Lisa Martland<br>': 'Lisa Martland',
    '&middot': 'Unknown',
    'Luc\\u00eda Piquero': 'Lucía Piquero',
    'Sheridan Morley·': 'Sheridan Morley',
    'HuffPost (Steven Suskin)': 'Steven Suskin',
  };
  for (const [raw, want] of Object.entries(cases)) assert.equal(sanitizeCriticName(raw), want, raw);
  for (const keep of ['Ben Brantley (Pt. 2)', 'Barbara Siegel & Scott Siegel', 'nick730', "Holly O'Mahony", 'J. Kelly Nestruck', 'Unknown', 'Theatre Bee (UK)'])
    assert.equal(sanitizeCriticName(keep), keep, keep);
  assert.equal(sanitizeCriticName('https://www.example.com/author/jane-doe'), sanitizeCriticName('https://www.example.com/author/jane-doe'));
});
