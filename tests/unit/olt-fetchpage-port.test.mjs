// S4-T4 (2026 data audit, BRO-4204): the Official London Theatre listing is
// fetched through fetchPage() (scripts/lib/scraper.js), not a raw
// https.get(). The raw call 403'd on every Actions runner for 23 consecutive
// runs (CI log 2026-09-27, run 36322077623: "OLT fetch failed (HTTP 403)")
// while returning ~100 shows locally — the TLS-fingerprint class the scraper
// rule exists for. Source-level guard so the port cannot quietly regress
// back to https.get(); the JSON-LD parse itself is covered by
// tests/unit/olt-enrichment.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const src = readFileSync(join(ROOT, 'scripts', 'discover-new-shows.js'), 'utf8');

// Body of a top-level function with `//` comment lines removed, so a comment
// that NAMES the old https.get() cannot satisfy or trip the code checks.
function functionBody(name) {
  const start = src.indexOf(`async function ${name}(`);
  assert.ok(start > 0, `${name} must exist in discover-new-shows.js`);
  const next = src.slice(start + 1).search(/\n(?:async )?function \w+\(/);
  const raw = next === -1 ? src.slice(start) : src.slice(start, start + 1 + next);
  return raw.split('\n').filter(line => !line.trimStart().startsWith('//')).join('\n');
}

test('fetchShowsFromOfficialLondonTheatre fetches via the fetchPage()-first London helper and keeps the JSON-LD parse', () => {
  const body = functionBody('fetchShowsFromOfficialLondonTheatre');
  assert.match(body, /fetchLondonListingHtml\(OLT_URL/, 'OLT goes through fetchLondonListingHtml → fetchPage()');
  assert.doesNotMatch(body, /https\.get\(/, 'no raw https.get() left in the OLT fetcher');
  assert.doesNotMatch(body, /new Promise\(\(resolve, reject\)/, 'the hand-rolled redirect-following promise is gone');
  assert.match(body, /parseOltTheaterEvents\(html\)/, 'JSON-LD TheaterEvent parse unchanged (scripts/lib/olt-enrichment.js)');
  assert.match(body, /sanitizeVenueForWrite\(event\.venue\)/, 'venue guard unchanged');
  assert.match(body, /isNonTheatreVenue\(venue\) \|\| isLondonReceivingHouse\(venue\)/, 'non-theatre / receiving-house gate unchanged');
});

test('fetchLondonListingHtml: fetchPage() first, plain undici fetch() only as the provider-less fallback, with a timeout', () => {
  const body = functionBody('fetchLondonListingHtml');
  const fetchPageAt = body.indexOf('await fetchPage(url)');
  const plainFetchAt = body.search(/(?<![.\w])fetch\(url/);
  assert.ok(fetchPageAt > 0, 'helper must call fetchPage(url)');
  assert.ok(plainFetchAt > fetchPageAt, 'plain fetch() must come AFTER fetchPage() (fallback, not a first tier)');
  assert.match(body, /AbortSignal\.timeout\(\d+\)/, 'plain fetch() carries an abort timeout (BRO-108 class)');
  assert.doesNotMatch(body, /https\.get\(/, 'fallback uses fetch() (undici), never https.get() — scraper-reference G6');
  assert.match(body, /minBytes/, 'short bodies are rejected so a stub page cannot parse as "0 shows"');
});

test('scraper.js fetchPage is imported (the scraper rule entry point)', () => {
  assert.match(src, /const \{ fetchPage, cleanup \} = require\(['"]\.\/lib\/scraper['"]\)/);
});
