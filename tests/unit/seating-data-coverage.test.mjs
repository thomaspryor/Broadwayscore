/**
 * BRO-932 acceptance test: seating section data coverage for top Broadway
 * theaters.
 *
 * Background: seating sections were fully populated for all 42 Broadway
 * theaters by mid-April 2026, then silently wiped to 0/42 by the quarterly
 * generate-theater-tips.yml automated run on 2026-07-01 (merge-theater-tips.js
 * rebuilt structuredTips.seating from the LLM draft alone, which never
 * produces a `sections` field — see scripts/lib/theater-tips-merge.js and
 * tests/unit/theater-tips-merge-preserves-sections.test.mjs for the fix).
 *
 * This test pins the data-coverage half of the acceptance criteria: at least
 * 10 theaters carry valid seating sections, and every section that exists is
 * shaped so SeatingGuidanceCard/SeatingGuidance (src/components/) will render
 * it (isValidSection requires name + verdict + verdictLabel).
 *
 * Run with: node --test tests/unit/seating-data-coverage.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const META_PATH = path.join(__dirname, '../../data/theater-metadata.json');
const meta = require(META_PATH);

const VALID_VERDICTS = new Set(['sweet-spot', 'solid', 'skip']);

function theatersWithSections() {
  return Object.entries(meta).filter(
    ([name, entry]) => name !== '_meta' && entry?.structuredTips?.seating?.sections?.length > 0
  );
}

describe('seating section data coverage', () => {
  test('at least 10 theaters have non-empty seating sections', () => {
    const withSections = theatersWithSections();
    assert.ok(
      withSections.length >= 10,
      `Expected >=10 theaters with seating sections, found ${withSections.length}: ${withSections.map(([n]) => n).join(', ')}`
    );
  });

  test('every populated theater has at least one sweet-spot or value-pick section', () => {
    for (const [name, entry] of theatersWithSections()) {
      const sections = entry.structuredTips.seating.sections;
      const hasHighlight = sections.some((s) => s.verdict === 'sweet-spot' || s.isValuePick);
      assert.ok(hasHighlight, `${name} has sections but none are a sweet-spot or value pick`);
    }
  });

  test('every section has the fields SeatingGuidance requires to render (name, verdict, verdictLabel)', () => {
    for (const [name, entry] of theatersWithSections()) {
      const sections = entry.structuredTips.seating.sections;
      sections.forEach((s, i) => {
        assert.strictEqual(typeof s.name, 'string', `${name} section[${i}].name must be a string`);
        assert.ok(s.name.length > 0, `${name} section[${i}].name must be non-empty`);
        assert.ok(VALID_VERDICTS.has(s.verdict), `${name} section[${i}].verdict = ${s.verdict} — must be one of ${[...VALID_VERDICTS]}`);
        assert.strictEqual(typeof s.verdictLabel, 'string', `${name} section[${i}].verdictLabel must be a string`);
        assert.ok(s.verdictLabel.length > 0, `${name} section[${i}].verdictLabel must be non-empty`);
      });
    }
  });

  test('at most one isValuePick per theater', () => {
    for (const [name, entry] of theatersWithSections()) {
      const valuePicks = entry.structuredTips.seating.sections.filter((s) => s.isValuePick);
      assert.ok(valuePicks.length <= 1, `${name} has ${valuePicks.length} isValuePick sections, expected at most 1`);
    }
  });

  // Regression: the first BRO-932 data pass claimed "no major obstruction" in
  // a generic Rear Orchestra rationale for every theater, which directly
  // contradicted Lyric Theatre's own verified avoidSeats text ("rear
  // orchestra may have obstructed views"). Caught by adversarial /ship-check
  // review, not the data pipeline — pin it so it can't silently recur.
  test('no section rationale claims freedom from obstruction that the theater\'s own avoidSeats contradicts', () => {
    for (const [name, entry] of theatersWithSections()) {
      const seating = entry.structuredTips.seating;
      const avoidSeats = (seating.avoidSeats || '').toLowerCase();
      if (!avoidSeats.includes('obstruct')) continue;
      for (const s of seating.sections) {
        const rationale = (s.rationale || '').toLowerCase();
        assert.ok(
          !rationale.includes('no major obstruction') && !rationale.includes('no obstruction'),
          `${name} section "${s.name}" rationale claims no obstruction, but avoidSeats says: "${seating.avoidSeats}"`
        );
      }
    }
  });

  // Broader version of the same regression: a second review pass found the
  // fix above only banned the literal phrase, but Lyric Theatre's "Rear
  // Orchestra" section still shipped a plain "solid" rating with no mention
  // of the obstruction risk its own avoidSeats names for that exact section.
  // This checks the more general case — when avoidSeats names a specific
  // section by name alongside a caution word, that section's rationale must
  // at least acknowledge it (not necessarily downgrade the verdict).
  const CAUTION_WORDS = ['obstruct', 'limited', 'distant', 'avoid', 'watch out'];
  test('sections explicitly named in a cautionary avoidSeats acknowledge the caution in their own rationale', () => {
    for (const [name, entry] of theatersWithSections()) {
      const seating = entry.structuredTips.seating;
      const avoidSeats = (seating.avoidSeats || '').toLowerCase();
      if (!avoidSeats || !CAUTION_WORDS.some((w) => avoidSeats.includes(w))) continue;
      for (const s of seating.sections) {
        const nameTokens = s.name.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
        const sectionNamedInAvoidSeats = nameTokens.length > 0 && nameTokens.every((t) => avoidSeats.includes(t));
        if (!sectionNamedInAvoidSeats) continue;
        const rationale = (s.rationale || '').toLowerCase();
        const acknowledges = CAUTION_WORDS.some((w) => rationale.includes(w)) || rationale.includes('own seating notes') || rationale.includes('check the seat');
        assert.ok(
          acknowledges,
          `${name} avoidSeats cautions about "${s.name}" ("${seating.avoidSeats}") but its rationale doesn't acknowledge it: "${s.rationale}"`
        );
      }
    }
  });

  test('the BRO-932 target theaters (Shubert, St. James, Nederlander, Imperial, Lunt-Fontanne, Minskoff, Marquis, Gershwin, Palace, Lyric) are all populated', () => {
    const targets = [
      'Shubert Theatre',
      'St. James Theatre',
      'Nederlander Theatre',
      'Imperial Theatre',
      'Lunt-Fontanne Theatre',
      'Minskoff Theatre',
      'Marquis Theatre',
      'Gershwin Theatre',
      'Palace Theatre',
      'Lyric Theatre',
    ];
    for (const name of targets) {
      const sections = meta[name]?.structuredTips?.seating?.sections;
      assert.ok(sections?.length > 0, `${name} is missing seating sections`);
    }
  });
});

describe('seating guidance UI is wired to structuredTips.seating.sections', () => {
  const readSrc = (relPath) => fs.readFileSync(path.join(__dirname, '../../', relPath), 'utf8');

  test('theater detail page passes sections into SeatingGuidanceCard', () => {
    const src = readSrc('src/app/theater/[slug]/page.tsx');
    assert.match(src, /SeatingGuidanceCard/);
    assert.match(src, /theater\.structuredTips\?\.seating\?\.sections/);
  });

  test('show page (below-fold) passes sections into SeatingGuidanceCard', () => {
    const src = readSrc('src/components/show-page/ShowPageBelowFold.tsx');
    assert.match(src, /SeatingGuidanceCard/);
    assert.match(src, /theater\.structuredTips\?\.seating\?\.sections/);
  });
});
