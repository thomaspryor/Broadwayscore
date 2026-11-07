// BRO-5183: a page found by url discovery must pass the content verifier
// before it replaces a review's url and text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const { discoveredPageVerdict } = require('../../scripts/lib/discovered-page-verdict.js');

test('only a verified page for this production is accepted', () => {
  assert.equal(discoveredPageVerdict({ isValid: true, wrongProduction: false, wrongArticle: false, issues: [] }).accept, true);
  assert.equal(discoveredPageVerdict(null).accept, false, 'no verdict');
  // The Something Rotten! case: a 2018 Kennedy Center touring review for the 2015 Broadway run.
  assert.equal(discoveredPageVerdict({ isValid: false, wrongProduction: true, confidence: 'high', issues: ['2018 tour'] }).accept, false);
  // A wrongProduction the temporal override lowered to 'low' does not refuse (main path keeps it too).
  assert.equal(discoveredPageVerdict({ isValid: false, wrongProduction: true, confidence: 'low' }).accept, true);
  // No verdict refuses but is not counted against the page.
  assert.equal(discoveredPageVerdict(null).retry, true);
  assert.equal(discoveredPageVerdict({ isValid: true, wrongArticle: true }).accept, false);
  assert.equal(discoveredPageVerdict({ isValid: true, isFilmTv: true }).accept, false);
  assert.equal(discoveredPageVerdict({ isValid: false, issues: [] }).accept, false);
});

test('the collector checks a discovered page before writing its url', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'collect-review-texts.js'), 'utf8');
  const retry = src.slice(src.indexOf('Re-attempting fetch with discovered URL'));
  const verdictAt = retry.indexOf('discoveredPageVerdict(');
  const urlWriteAt = retry.indexOf('updateFileUrlWithInvariant(');
  assert.ok(verdictAt > 0, 'retry path calls discoveredPageVerdict');
  assert.ok(urlWriteAt > verdictAt, 'verdict comes before the url write');
  assert.ok(retry.indexOf('{ discoveredUrl }') > 0 && retry.indexOf('{ discoveredUrl }') < verdictAt, 'the verifier judges the discovered page on its own date and url');
  const main = src.slice(src.indexOf('const contentVerification = await verifyFetchedContent('));
  assert.ok(main.indexOf('discoveredPageVerdict(') > 0 && main.indexOf('discoveredPageVerdict(') < main.indexOf('await updateReviewJson('), 'no_url/showNotMentioned discoveries are gated too');
  assert.ok(!/updateReviewJson\([^)]*,\s*null\)/.test(retry.slice(0, retry.indexOf('return { success: true, method: retryResult.method'))), 'retry stores the verification, not null');
});
