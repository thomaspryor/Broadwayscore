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

test('extractBodyByline: TotalTheater "Critic: <Name>" credits header at the top (BRO-7080)', () => {
  // Real fullText heads, data/review-texts/*/totaltheater1--unknown.json.
  const fish = 'Fish TotalTheater October 16, 2026 off-Broadway – WP Theater & Signature Theater at WP Theater: 2162 Broadway. Oct. 11-Oct. 25, 2026. Dark Comedy. Author: Melis Aker. Director: Tatiana Pandiani. Critic: David Sheward (Oct. 2026). **** Melis Aker’s Fish (a';
  const billy = 'Billy Crystal: 860 TotalTheater October 26, 2026 Broadway – Imperial Theater: 249 West 45 Street. Oct. 21, 2026-Jan. 3, 2027. Solo Autobiography. Author/Cast: Billy Crystal. Director: Scott Ellis. 90 min. Critic: David Sheward (Oct. 2026). **** The numbers in the title';
  const dow = 'Regional – Houston, TX: national tour at Hobby Center: 800 Bagby Street. Score: Eddie Perfect. Book: Scott Brown & Anthony King. Director: Catie Davis (tour). Original: Alex Timbers. Critic: David Dow Bentley (Nov. 2026). I have a confession to make.';
  assert.equal(extractBodyByline(fish + ' Long review prose. '.repeat(60)), 'David Sheward');
  assert.equal(extractBodyByline(billy, { showTitle: 'Billy Crystal: 860' }), 'David Sheward');
  assert.equal(extractBodyByline(dow), 'David Dow Bentley');
  assert.equal(extractBylineFromText('totaltheater1', fish).name, 'David Sheward');
});

test('extractBodyByline: "Critic:" in prose or deep in the text is not a credit (BRO-7080)', () => {
  assert.equal(extractBodyByline('He was the critic: a fierce one, and fair.'), null);
  assert.equal(extractBodyByline('The Critic: Jane Doe.'), null);
  assert.equal(extractBodyByline('Critic: David Sheward wrote that the show was long.'), null);
  assert.equal(extractBodyByline('An opening paragraph. ' + 'More prose here. '.repeat(50) + 'Critic: David Sheward (Oct. 2026). ' + 'Tail prose. '.repeat(30)), null);
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
