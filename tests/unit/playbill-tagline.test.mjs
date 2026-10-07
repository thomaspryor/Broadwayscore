/**
 * BRO-2023: revival detection was wrong in both directions — a same-title
 * market transfer read as a revival, and a prior production missing from
 * this corpus (no shows.json entry, so cross-reference found nothing) read
 * as a confident "not a revival". Playbill prints the answer itself on every
 * production page's genre tag-line ("Broadway | Play | Revival" / "...|
 * Original"), so it resolves both directions without a title heuristic.
 *
 * Snippets below are trimmed straight from live pages fetched 2026-08-21
 * (real `curl` responses, not fabricated) — one per real-world case named in
 * the issue: Gloria (missing 2015 Off-Broadway prior production, should read
 * revival), Paddington (West End -> Broadway transfer, should NOT read
 * revival), The Fantasticks (42-year-old prior run, should read revival),
 * Inter Alia (same-title cross-market transfer, should NOT read revival).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parsePlaybillTagLine } = require('../../scripts/lib/playbill-tagline.js');

function pageWithTags(...tags) {
  const h5s = tags.map(t => `            <h5 class="bsp-bio-sub-text">${t}</h5>`).join('\n');
  return `<html><body><div class="bsp-bio-content">
                                <div class="bsp-bio-subtitle">
${h5s}

                                </div>
                            </div></body></html>`;
}

test('Gloria — Broadway/Play/Dark Comedy/Revival → revival, play', () => {
  const html = pageWithTags('Broadway', 'Play', 'Dark Comedy', 'Revival');
  assert.deepStrictEqual(parsePlaybillTagLine(html), {
    tags: ['Broadway', 'Play', 'Dark Comedy', 'Revival'],
    market: 'Broadway',
    showType: 'play',
    revivalStatus: 'revival',
  });
});

test('Paddington Broadway transfer — Broadway/Musical/Original → NOT revival', () => {
  const html = pageWithTags('Broadway', 'Musical', 'Original');
  const parsed = parsePlaybillTagLine(html);
  assert.equal(parsed.revivalStatus, 'original');
  assert.equal(parsed.showType, 'musical');
});

test('The Fantasticks — Broadway/Musical/Revival → revival', () => {
  const html = pageWithTags('Broadway', 'Musical', 'Revival');
  assert.equal(parsePlaybillTagLine(html).revivalStatus, 'revival');
});

test('Inter Alia Broadway — Play/Drama/One Act/Original → NOT revival (cross-market transfer)', () => {
  const html = pageWithTags('Broadway', 'Play', 'Drama', 'One Act', 'Original');
  const parsed = parsePlaybillTagLine(html);
  assert.equal(parsed.revivalStatus, 'original');
  assert.equal(parsed.showType, 'play');
});

test('no bsp-bio-subtitle block → unknown, not a false "original"', () => {
  const html = '<html><body>no tag line here</body></html>';
  assert.deepStrictEqual(parsePlaybillTagLine(html), {
    tags: [], market: null, showType: null, revivalStatus: 'unknown',
  });
});

test('reads revival/original from the LAST tag, not "anywhere in the list" (ship-check finding)', () => {
  // A genre tag containing the word doesn't get misread, and if a markup
  // regression ever printed both Revival and Original, the one Playbill
  // actually intends (the last one) wins rather than an arbitrary tie-break.
  const contradictory = pageWithTags('Broadway', 'Play', 'Original', 'Revival');
  assert.equal(parsePlaybillTagLine(contradictory).revivalStatus, 'revival');
  const reversedContradictory = pageWithTags('Broadway', 'Play', 'Revival', 'Original');
  assert.equal(parsePlaybillTagLine(reversedContradictory).revivalStatus, 'original');
});

test('empty/undefined html does not throw', () => {
  assert.equal(parsePlaybillTagLine('').revivalStatus, 'unknown');
  assert.equal(parsePlaybillTagLine(undefined).revivalStatus, 'unknown');
});

// --- Wiring lock (CLAUDE.md §15): both call sites must use this parser,
// not re-implement a title-based heuristic that would regress BRO-2023. ---
test('validate-show-venue.js parses the tag line and feeds it into compareShow', () => {
  const src = require('fs').readFileSync(
    require('path').join(import.meta.dirname, '..', '..', 'scripts/validate-show-venue.js'), 'utf8');
  assert.match(src, /require\(['"]\.\/lib\/playbill-tagline['"]\)/);
  assert.match(src, /tagLine\.revivalStatus/);
});

test('discover-new-shows.js runs the Playbill tag-line check before IBDB', () => {
  const src = require('fs').readFileSync(
    require('path').join(import.meta.dirname, '..', '..', 'scripts/discover-new-shows.js'), 'utf8');
  assert.match(src, /validatePlaybillProduction/);
  assert.match(src, /revivalStatusUnconfirmed/);
});
