// BRO-3219: locks in the byline-mismatch regex calibrated against the real
// review-texts corpus. extractNamedAuthor must catch the confirmed misattribution
// shapes (explicit byline correction, essay-by-director, "authored by") and must
// NOT false-positive on ordinary ensemble prose — the "no-byline pending strand"
// case is a real corpus string that a case-insensitive first draft misread as a
// two-word proper name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractNamedAuthor, criticNamesMatch } = require('./audit-flagged-file-contamination.js');

test('extracts an explicit byline correction', () => {
  const reasoning = "claude: The byline is also Henry Hitchings, not Dominic Cavendish. This is a different production.";
  assert.equal(extractNamedAuthor(reasoning), 'Henry Hitchings');
});

test('extracts an essay-by-role author with parenthetical-free phrasing', () => {
  const reasoning = 'claude: This text is an interview/essay by director Stephen Unwin reflecting on the translation work.';
  assert.equal(extractNamedAuthor(reasoning), 'Stephen Unwin');
});

test('extracts a plain "by NAME comparing" attribution', () => {
  const reasoning = 'claude: This appears to be a news article by John Horn comparing Joan Didion and Vanessa Redgrave.';
  assert.equal(extractNamedAuthor(reasoning), 'John Horn');
});

test('does not false-positive on prose fragments (regression: no-byline pending strand)', () => {
  const reasoning = "manual: Title-token 'girl' cross-attribution via Guardian /stage/ no-byline pending strand. Article predates this show's previews by 13 months.";
  assert.equal(extractNamedAuthor(reasoning), null);
});

test('does not false-positive when the reasoning names the SAME critic as the byline', () => {
  const reasoning = 'claude: This is a first-person essay written by the playwright/performer Sarah Jones about the creation of her show.';
  const extracted = extractNamedAuthor(reasoning);
  // Either no extraction, or an extraction that matches the stored critic —
  // both are fine; what must never happen is treating this as a mismatch.
  if (extracted) {
    assert.equal(criticNamesMatch(extracted, 'Sarah Jones'), true);
  }
});

test('does not extract an organization name as an author (ship-check finding)', () => {
  assert.equal(extractNamedAuthor('claude: This op-ed piece by New York Times reporters has no critical evaluation.'), null);
  assert.equal(extractNamedAuthor('claude: This text is authored by Sky News about the production history.'), null);
});

test('returns null when rejectionReasoning is absent', () => {
  assert.equal(extractNamedAuthor(null), null);
  assert.equal(extractNamedAuthor(undefined), null);
  assert.equal(extractNamedAuthor(''), null);
});

test('criticNamesMatch treats normalized-equal names as a match', () => {
  assert.equal(criticNamesMatch('Stephen Unwin', 'stephen-unwin'), true);
  assert.equal(criticNamesMatch('Stephen Unwin', 'Nicola Slavin'), false);
});
