/**
 * Regression guard for Theater Scorecard venue scores.
 *
 * Pins scores that are grounded in external, verifiable evidence — not
 * prompt anchors or LLM-generated summaries. Any future generator re-run
 * that changes these scores must be intentional and reviewed.
 *
 * Evidence basis for each fixture is noted inline.
 *
 * Run with: node --test tests/unit/theater-scorecard-regression.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const META_PATH = path.join(__dirname, '../../data/theater-metadata.json');
const meta = require(META_PATH);

function scores(name) {
  const entry = meta[name];
  if (!entry || !entry.venueScores) throw new Error(`Theater not found or no venueScores: ${name}`);
  return entry.venueScores;
}

// ─── Sightlines=5 anchors ───────────────────────────────────────────────────
// These are structurally unique configurations where exceptional sightlines
// are inherent to the physical design — not a matter of opinion.

test('Circle in the Square: sightlines=5 (thrust stage, seats wrap 270°, no bad angle)', () => {
  assert.strictEqual(scores('Circle in the Square Theatre').sightlines, 5);
});

test('Vivian Beaumont: sightlines=5 (purpose-built Lincoln Center theater, 1965)', () => {
  assert.strictEqual(scores('Vivian Beaumont Theater').sightlines, 5);
});

// ─── Sightlines=3 — large houses ────────────────────────────────────────────
// Theaters with >1500 seats where physical depth and/or balcony overhangs
// produce material sightline limitations in rear and upper sections.
// Evidence: capacity data from official theater websites; the Gershwin score
// is corroborated by SeatPlan/AVFMS source material used during generation.

test('Gershwin Theatre: sightlines=3 (1933 seats — established baseline, rear sections far from stage)', () => {
  assert.strictEqual(scores('Gershwin Theatre').sightlines, 3);
});

test('Lyric Theatre: sightlines=3 (1930 seats, 4 levels — comparable capacity to Gershwin)', () => {
  assert.strictEqual(scores('Lyric Theatre').sightlines, 3);
});

test('Broadway Theatre: sightlines=3 (1761 seats, exceptionally deep house — rear orchestra and balcony are very far)', () => {
  assert.strictEqual(scores('Broadway Theatre').sightlines, 3);
});

test('Majestic Theatre: sightlines=3 (1645 seats, obstructed side and rear sections per SeatPlan data)', () => {
  assert.strictEqual(scores('Majestic Theatre').sightlines, 3);
});

// ─── Ambiance=5 anchors ─────────────────────────────────────────────────────
// Architectural landmarks with documented exceptional interiors.

test('New Amsterdam Theatre: ambiance=5 (restored Beaux-Arts / Art Nouveau landmark, 1903)', () => {
  assert.strictEqual(scores('New Amsterdam Theatre').ambiance, 5);
});

test('Belasco Theatre: ambiance=5 (Tiffany-decorated interior, 1907, NYC landmark)', () => {
  assert.strictEqual(scores('Belasco Theatre').ambiance, 5);
});

// ─── Sound=5 anchor ─────────────────────────────────────────────────────────

test('Vivian Beaumont: sound=5 (purpose-built acoustics, Lincoln Center)', () => {
  assert.strictEqual(scores('Vivian Beaumont Theater').sound, 5);
});

// ─── Comfort=5 anchor ───────────────────────────────────────────────────────
// The Marquis (Todd Haimes Theatre) opened in 1982 as a modern hotel-integrated
// theater — wider rows and more legroom than any pre-war Broadway house.

test('Marquis Theatre: comfort=5 (modern hotel theater, best legroom on Broadway)', () => {
  assert.strictEqual(scores('Marquis Theatre').comfort, 5);
});

// ─── Schema integrity for all 42 theaters ───────────────────────────────────

test('All 42 theaters have venueScores with 5 integer dimensions in range 1-5', () => {
  const DIMS = ['sightlines', 'sound', 'comfort', 'ambiance', 'facilities'];
  let count = 0;
  for (const [name, entry] of Object.entries(meta)) {
    if (name === '_meta' || !entry.venueScores) continue;
    count++;
    for (const dim of DIMS) {
      const val = entry.venueScores[dim];
      assert.ok(
        Number.isInteger(val) && val >= 1 && val <= 5,
        `${name}.${dim} = ${val} — expected integer 1-5`
      );
    }
  }
  assert.strictEqual(count, 42, `Expected 42 theaters with venueScores, got ${count}`);
});
