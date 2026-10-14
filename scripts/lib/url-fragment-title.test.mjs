// Run: node --test scripts/lib/url-fragment-title.test.mjs
// BRO-3915. Requires the real predicate (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isUrlFragmentTitle, urlFragmentReason } = require('./url-fragment-title.js');

test('catches the phantom that shipped', () => {
  // tabdates-off-west-end-2026 — a Hampstead Theatre what's-on tab control
  // followed as if it were a production.
  assert.equal(isUrlFragmentTitle('?tab=dates'), true);
  assert.match(urlFragmentReason('?tab=dates'), /query string/);
});

test('catches the other shapes a listing scraper produces', () => {
  for (const t of ['tab=dates', '&page=2', '?', '?utm_source=x', 'https://hampsteadtheatre.com/whats-on', '/whats-on', '/whats-on/']) {
    assert.equal(isUrlFragmentTitle(t), true, `should reject ${JSON.stringify(t)}`);
  }
});

test('& Juliet is a REAL show and must never be flagged', () => {
  // and-juliet-2022, Stephen Sondheim Theatre. The obvious rule — "reject a
  // title starting with ? or &" — flags this immediately. A guard that
  // hard-errors on correct data gets weakened, and a weakened guard catches
  // nothing.
  assert.equal(isUrlFragmentTitle('& Juliet'), false);
  assert.equal(urlFragmentReason('& Juliet'), null);
});

test('real titles with awkward punctuation pass', () => {
  for (const t of [
    '& Juliet',
    'Slave Play',
    "Kevin!!!!!",
    'This Is Not About Me.',
    'The Body of Mary: A Play in Three Acts (of God)',
    'NODA MAP – 320°F',
    'Noda Map - minus 320 Fahrenheit',
    'Schmigadoon!',
    "O'Hara",
    '360 ALLSTARS',
    'E = mc2',            // spaced equals in prose is not a query parameter
    'Two Trains Running',
  ]) {
    assert.equal(isUrlFragmentTitle(t), false, `should ACCEPT ${JSON.stringify(t)}`);
  }
});

test('non-strings and blanks are not fragments', () => {
  for (const t of [null, undefined, 42, {}, '', '   ']) {
    assert.equal(isUrlFragmentTitle(t), false);
  }
});
