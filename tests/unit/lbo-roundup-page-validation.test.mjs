import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateRoundupPageTitle } = require('../../scripts/lib/show-matching');

// Regression test for Stuart King cross-show contamination (2026-04-25):
// LBO archive caches were keyed by showId without checking the cached HTML
// actually matched that show. validateRoundupPageTitle is the gate every
// archive reader now runs before extracting reviews.

const fakePage = (title) => `<html><head><title>${title}</title></head><body></body></html>`;

describe('validateRoundupPageTitle', () => {
  test('accepts legitimate same-show roundup', () => {
    const html = fakePage('Review Round-Up: OH, MARY! at the Trafalgar Theatre - West End Theatre News and Reviews');
    const r = validateRoundupPageTitle(html, 'Oh, Mary!');
    assert.strictEqual(r.ok, true);
  });

  test('rejects Magic Mike Live page-title against Oh Mary HTML (Stuart King report)', () => {
    const html = fakePage('Review Round-Up: OH, MARY! at the Trafalgar Theatre - West End Theatre News and Reviews');
    const r = validateRoundupPageTitle(html, 'Magic Mike Live');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'page-title-mismatch');
  });

  test('rejects Trainspotting the musical against Paddington The Musical (false-friend "musical"+"the")', () => {
    // The opening-night-poller sitemap fallback used to fuzzy-match these because
    // both slugs contained "the" and "musical". Validator should reject content.
    const html = fakePage('Review Round-Up: PADDINGTON THE MUSICAL at the Savoy Theatre - West End Theatre News and Reviews');
    const r = validateRoundupPageTitle(html, 'Trainspotting the musical');
    assert.strictEqual(r.ok, false);
  });

  test('rejects Hamilton against Marie & Rosetta', () => {
    const html = fakePage('Review Round-Up: MARIE AND ROSETTA at @SohoPlace - West End Theatre News and Reviews');
    assert.strictEqual(validateRoundupPageTitle(html, 'Hamilton').ok, false);
  });

  test('rejects Oliver! against Marie & Rosetta', () => {
    const html = fakePage('Review Round-Up: MARIE AND ROSETTA at @SohoPlace - West End Theatre News and Reviews');
    assert.strictEqual(validateRoundupPageTitle(html, 'Oliver!').ok, false);
  });

  test('rejects Wicked against Dracula', () => {
    const html = fakePage('Review Round-Up: DRACULA at the Noel Coward Theatre - West End Theatre News and Reviews');
    assert.strictEqual(validateRoundupPageTitle(html, 'Wicked').ok, false);
  });

  test('accepts single-word title against its own page (Wicked)', () => {
    const html = fakePage('Review Round-Up: WICKED at the Apollo Theatre - West End Theatre News and Reviews');
    assert.strictEqual(validateRoundupPageTitle(html, 'Wicked').ok, true);
  });

  test('accepts apostrophe/punctuation titles (Teeth \'n\' Smiles)', () => {
    const html = fakePage("Review: TEETH 'N' SMILES at Duke of York's Theatre - West End Theatre News and Reviews");
    const r = validateRoundupPageTitle(html, "Teeth 'n' Smiles");
    assert.strictEqual(r.ok, true);
  });

  test('rejects when html lacks <title> tag', () => {
    const r = validateRoundupPageTitle('<html><body>content</body></html>', 'Anything');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'no-title-tag');
  });

  test('rejects empty/null html', () => {
    assert.strictEqual(validateRoundupPageTitle('', 'X').ok, false);
    assert.strictEqual(validateRoundupPageTitle(null, 'X').ok, false);
  });

  test('numeric-only title "13" matches its own page', () => {
    // Show "13" was missing from validator pre-2026-04-26 — distinctive-words
    // filter dropped 1-2 char tokens. Now caught via fullTitle whole-word match.
    const html = fakePage('Review Roundup: 13 THE MUSICAL Opens at the Bernard B. Jacobs Theatre');
    assert.strictEqual(validateRoundupPageTitle(html, '13').ok, true);
  });

  test('numeric-only title "13" rejects wrong-content page', () => {
    // The actual contamination this session: a "13" archive contained
    // FREE MAN OF COLOR roundup. Validator must reject.
    const html = fakePage('Review Roundup: A FREE MAN OF COLOR Opens on Broadway');
    assert.strictEqual(validateRoundupPageTitle(html, '13').ok, false);
  });

  test('numeric-substring "13" inside "1973" does NOT false-positive', () => {
    // Word-boundary check prevents "13" from matching inside "1973" digit run.
    const html = fakePage('A LITTLE NIGHT MUSIC 1973 Production Reviews');
    assert.strictEqual(validateRoundupPageTitle(html, '13').ok, false);
  });

  test('multi-token short title "9 to 5" matches its own page', () => {
    // "9 to 5" had all tokens filtered (1 char + stopword "to") — fullTitle
    // whole-word match handles the entire phrase as a single match candidate.
    const html = fakePage('Review Roundup: 9 TO 5 National Tour Reviews');
    assert.strictEqual(validateRoundupPageTitle(html, '9 to 5').ok, true);
  });

  test('substring "live" inside "lively" does NOT pass for Magic Mike Live', () => {
    // Old check used pageTitle.includes(word) — would let "lively" match "live".
    // New check uses whole-word matching.
    const html = fakePage('Review Round-Up: A LIVELY EVENING at Some Theatre - West End Theatre');
    const r = validateRoundupPageTitle(html, 'Magic Mike Live');
    assert.strictEqual(r.ok, false);
  });
});
