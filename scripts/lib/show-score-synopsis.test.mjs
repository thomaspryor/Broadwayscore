// BRO-5859: Show Score synopses were cut at 797 chars + "..." mid-word.
// Requires the real functions.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const { capSynopsisAtSentence, extractShowScoreAboutText, extractShowScoreSynopsis } = require('./show-score-synopsis.js');

const SENT = 'The company sings well and the second act moves quickly. ';

test('text inside the cap is returned unchanged (whitespace normalized)', () => {
  assert.equal(capSynopsisAtSentence('  A short  blurb.  '), 'A short blurb.');
  assert.equal(capSynopsisAtSentence(''), null);
});

test('long text is cut at the last sentence end, never mid-word or with an ellipsis', () => {
  const out = capSynopsisAtSentence(SENT.repeat(20));
  assert.ok(out.length <= 800);
  assert.ok(out.endsWith('quickly.'), out.slice(-30));
  assert.ok(!/\.\.\.$|…$/.test(out));
});

test('a full stop after an initial or title is not a sentence end', () => {
  const text = 'x'.repeat(500) + ' end one. Directed by J. Smith and St. Clair ' + 'y'.repeat(400);
  assert.ok(capSynopsisAtSentence(text).endsWith('end one.'));
});

test('no sentence end past 40% of the cap gives null', () => {
  assert.equal(capSynopsisAtSentence('Short. ' + 'word '.repeat(300)), null);
});

const page = (body) => new JSDOM(`<html><body>${body}</body></html>`).window.document;

test('About text comes from the sibling of the about-header (Show Score layout)', () => {
  const doc = page(`<div class="about-header"><h2>About the Show</h2></div>
    <div class="about"><p>${SENT.repeat(5)}</p><p>Second paragraph runs long enough.</p></div>`);
  const full = extractShowScoreAboutText(doc);
  assert.ok(full.endsWith('Second paragraph runs long enough.'));
  assert.equal(extractShowScoreSynopsis(doc), full);
});

test('no About heading gives null', () => {
  assert.equal(extractShowScoreSynopsis(page('<h2>Reviews</h2><p>Nothing here at all.</p>')), null);
});

test('a token straddling the cap, a dotted acronym or an ellipsis is not a sentence end', () => {
  const lead = 'w'.repeat(500) + ' real end.';
  const straddle = lead + ' ' + 'z'.repeat(800 - lead.length - 3) + ' 3.5 more words follow here';
  assert.ok(capSynopsisAtSentence(straddle).endsWith('real end.'));
  assert.ok(capSynopsisAtSentence(lead + ' Sent to the U.S. Army and more ' + 'q'.repeat(400)).endsWith('real end.'));
  assert.ok(capSynopsisAtSentence(lead + ' He wrote... and more ' + 'q'.repeat(400)).endsWith('real end.'));
});
