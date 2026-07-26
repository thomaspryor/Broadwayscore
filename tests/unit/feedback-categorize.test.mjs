// Tests the real feedback-categorization prompt builder + response parser
// (scripts/lib/feedback-categorize.js). Guards the 2026-07-26 Elephant Shoes
// regression: content-addition requests must be routed as Content Error with
// contentRequest:true, and the prompt must never let the model declare a
// request out of scope by market/venue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildCategorizationPrompt, parseCategorizedResponse } = require('../../scripts/lib/feedback-categorize.js');

const SAMPLE = [{
  category: 'other',
  show: 'Elephant Shoes (Regional)',
  message: 'Please include the reviews for Elephant Shoes from its run over at the Rechnitz Theatre in Red Bank',
  _date: '2026-07-26T00:47:35.441857+00:00',
}];

test('prompt declares full market scope, not Broadway-only', () => {
  const prompt = buildCategorizationPrompt(SAMPLE);
  for (const market of ['Broadway', 'Off-Broadway', 'West End', 'regional']) {
    assert.match(prompt, new RegExp(market, 'i'), `prompt must mention ${market}`);
  }
});

test('prompt carries the content-request routing rules', () => {
  const prompt = buildCategorizationPrompt(SAMPLE);
  assert.match(prompt, /"Content Error" with "contentRequest": true/);
  assert.match(prompt, /Never declare a legitimate theatre-content request out of scope/);
  assert.match(prompt, /Promotional or link-insertion requests .* are "Other"/);
  assert.match(prompt, /"contentRequest": false,/, 'JSON schema must include the contentRequest field');
});

test('prompt embeds submission fields with fallbacks', () => {
  const prompt = buildCategorizationPrompt(SAMPLE);
  assert.match(prompt, /Elephant Shoes \(Regional\)/);
  assert.match(prompt, /Name: Anonymous/);
  assert.match(prompt, /Email: Not provided/);
  assert.match(prompt, /Rechnitz Theatre in Red Bank/);
});

test('parseCategorizedResponse extracts JSON embedded in prose', () => {
  const out = parseCategorizedResponse(
    'Here is my analysis:\n{"categorized": [{"submissionNumber": 1, "category": "Content Error", "contentRequest": true, "priority": "Medium"}]}\nDone.'
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].category, 'Content Error');
  assert.equal(out[0].contentRequest, true);
});

test('parseCategorizedResponse returns [] when categorized key is absent', () => {
  assert.deepEqual(parseCategorizedResponse('{"something": 1}'), []);
});

test('parseCategorizedResponse throws on non-JSON output', () => {
  assert.throws(() => parseCategorizedResponse('I could not categorize these.'), /Could not parse/);
});
