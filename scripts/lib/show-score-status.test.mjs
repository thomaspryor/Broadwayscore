import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const { extractStatusFromHtml, venueFromShowScoreDoc } = require('./show-score-status.js');

// Trimmed from https://www.show-score.com/off-off-broadway-shows/falls-for-jodie
// as served on 2026-09-30: the info line holds only the Google Maps
// neighbourhood link; the venue survives as <survey-review-modal venue-name>.
const FALLS_FOR_JODIE = `<html><head><title>Show Score | Falls for Jodie NYC Reviews and Tickets</title></head><body>
<div class='show-page-v2__info-top-line'> Ends Oct 18 <span class='show-page-v2__info-top-line-delimiter'></span>
<a target="_blank" href="https://maps.google.com/?q=40.75,-73.99">NYC: Midtown W </a></div>
<survey-review-modal show-city='New York ' show-id='11964' show-name='Falls for Jodie' venue-name='The Tank'></survey-review-modal>
</body></html>`;

const docOf = (html) => new JSDOM(html).window.document;

test('venue comes from the survey modal venue-name when the info link is a neighbourhood (BRO-4432)', () => {
  assert.equal(venueFromShowScoreDoc(docOf(FALLS_FOR_JODIE)), 'The Tank');
  const r = extractStatusFromHtml(FALLS_FOR_JODIE);
  assert.equal(r.venue, 'The Tank');
  assert.equal(r.ssStatus, 'open');
});

test('a real venue link still wins over the modal attribute', () => {
  const html = FALLS_FOR_JODIE.replace('NYC: Midtown W ', 'NYC: 59E59 Theaters');
  assert.equal(venueFromShowScoreDoc(docOf(html)), '59E59 Theaters');
});

test('a placeholder venue-name is refused by the sanitizer, leaving null', () => {
  const html = FALLS_FOR_JODIE.replace("venue-name='The Tank'", "venue-name='TBA'");
  assert.equal(venueFromShowScoreDoc(docOf(html)), null);
});

test('no modal, no link, no known-venue parenthetical: null (deferred, as before)', () => {
  const html = `<html><head><title>Show Score | Safe House (World Premiere)</title></head><body>
<div class='show-page-v2__info-top-line'> Closed </div></body></html>`;
  assert.equal(venueFromShowScoreDoc(docOf(html)), null);
});

test('non-venue survey attributes (Online, Various venues, Site-specific) are refused', () => {
  for (const bad of ['Online', 'Various venues', 'Site-specific', 'Virtual Stage', 'Streaming']) {
    const html = FALLS_FOR_JODIE.replace("venue-name='The Tank'", `venue-name='${bad}'`);
    assert.equal(venueFromShowScoreDoc(docOf(html)), null, bad);
  }
});
