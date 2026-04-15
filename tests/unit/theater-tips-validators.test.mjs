/**
 * Unit tests for theater-tips-validators.js
 *
 * Pattern: require() the real validators; never copy logic into the test.
 *
 * Regression driver: 2026-04-03 hallucination incident where Gemini invented
 * elevator access for 17 theaters. These tests pin the guards so the same
 * class of hallucination cannot ship again without the test turning red.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  validateSchema,
  detectBannedClaims,
  validateGrounding,
  validateCategoryDedup,
  auditCrossTheaterDiversity,
  validateSubwayFacts,
  extractClaimedLines,
  findKnownStation,
  validateTips,
} = require('../../scripts/lib/theater-tips-validators.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'theater-tips-golden');
const loadFixture = name => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

// --- Fixtures --------------------------------------------------------------

const cleanTips = {
  seating: {
    bestSeats: 'The mezzanine offers great sightlines.',
    avoidSeats: null,
  },
  parking: {
    nearestGarages: [{ name: 'Icon Parking 45th St', walkMinutes: 3 }],
    streetParking: 'Limited metered parking on side streets.',
    tip: 'Garages fill fast before 8pm shows.',
  },
  dining: {
    preShow: [{ name: "Joe Allen", cuisine: 'American', walkMinutes: 4, priceRange: '$$', notes: 'Classic theater haunt.' }],
    postShow: [{ name: "Sardi's", cuisine: 'Continental', walkMinutes: 3, priceRange: '$$$', notes: 'Celebrity murals.' }],
    quickBite: [{ name: "Schmackary's", cuisine: 'Bakery', walkMinutes: 6, priceRange: '$', notes: 'Cookies.' }],
  },
  logistics: {
    entrance: 'Main entrance on West 45th Street.',
    nearestSubway: '49 St (N/Q/R/W).',
    exitStrategy: 'Exit east for taxis.',
    restrooms: 'Lines form at intermission.',
  },
};

const cleanScraped = {
  dining: [
    { name: "Joe Allen" },
    { name: "Sardi's" },
    { name: "Schmackary's" },
  ],
  parking: [{ name: 'Icon Parking 45th St' }],
};

// --- detectBannedClaims ----------------------------------------------------

describe('detectBannedClaims', () => {
  test('clean tips produce no findings', () => {
    assert.strictEqual(detectBannedClaims(cleanTips).length, 0);
  });

  test('elevator claim in seating is flagged (regression from 2026-04-03)', () => {
    const bad = structuredClone(cleanTips);
    bad.seating.bestSeats = 'The mezzanine offers great sightlines. The theater has an elevator.';
    const findings = detectBannedClaims(bad);
    assert.ok(findings.length >= 1, 'should flag elevator claim');
    assert.strictEqual(findings[0].category, 'accessibility');
    assert.strictEqual(findings[0].path, 'seating.bestSeats');
  });

  test('wheelchair-accessible claim in restrooms is flagged', () => {
    const bad = structuredClone(cleanTips);
    bad.logistics.restrooms = 'Wheelchair accessible restrooms available on each level.';
    const findings = detectBannedClaims(bad);
    assert.ok(findings.some(f => f.category === 'accessibility'));
  });

  test('ADA-compliant claim is flagged', () => {
    const bad = structuredClone(cleanTips);
    bad.logistics.entrance = 'The main entrance is ADA compliant.';
    const findings = detectBannedClaims(bad);
    assert.ok(findings.some(f => f.match.includes('ADA')));
  });

  test('specific count of elevators is flagged as classic hallucination', () => {
    const bad = structuredClone(cleanTips);
    bad.seating.bestSeats = 'Two elevators serve the mezzanine.';
    const findings = detectBannedClaims(bad);
    // Both "elevators" and "two elevators" patterns fire — that's fine.
    assert.ok(findings.some(f => f.match.toLowerCase().includes('two elevators')));
  });

  test('gluten-free claim in dining notes is flagged', () => {
    const bad = structuredClone(cleanTips);
    bad.dining.preShow[0].notes = 'Great gluten-free menu.';
    const findings = detectBannedClaims(bad);
    assert.ok(findings.some(f => f.category === 'medical'));
    assert.ok(findings.some(f => f.path.startsWith('dining.preShow[0]')));
  });

  test('emergency exit claim is flagged', () => {
    const bad = structuredClone(cleanTips);
    bad.logistics.exitStrategy = 'Use the emergency exit if the main doors are crowded.';
    const findings = detectBannedClaims(bad);
    assert.ok(findings.some(f => f.category === 'safety'));
  });

  test('normal Broadway content with the word "accessibility" in no form is unaffected', () => {
    const ok = structuredClone(cleanTips);
    ok.logistics.nearestSubway = 'Take the A train to 42nd St.';
    assert.strictEqual(detectBannedClaims(ok).length, 0);
  });
});

// --- validateSchema --------------------------------------------------------

describe('validateSchema', () => {
  test('clean tips produce no errors', () => {
    assert.strictEqual(validateSchema(cleanTips).length, 0);
  });

  test('missing seating object produces error', () => {
    const bad = structuredClone(cleanTips);
    delete bad.seating;
    const errors = validateSchema(bad);
    assert.ok(errors.some(e => e.includes('seating')));
  });

  test('accessibility field on LLM output is rejected', () => {
    const bad = structuredClone(cleanTips);
    bad.seating.accessibility = 'has elevator';
    const errors = validateSchema(bad);
    assert.ok(errors.some(e => e.includes('accessibility')));
  });

  test('invalid priceRange is rejected', () => {
    const bad = structuredClone(cleanTips);
    bad.dining.preShow[0].priceRange = 'expensive';
    const errors = validateSchema(bad);
    assert.ok(errors.some(e => e.includes('priceRange')));
  });

  test('non-numeric walkMinutes is rejected', () => {
    const bad = structuredClone(cleanTips);
    bad.parking.nearestGarages[0].walkMinutes = '3 minutes';
    const errors = validateSchema(bad);
    assert.ok(errors.some(e => e.includes('walkMinutes')));
  });
});

// --- validateGrounding -----------------------------------------------------

describe('validateGrounding', () => {
  test('clean tips against matching scraped data -> no findings', () => {
    assert.strictEqual(validateGrounding(cleanTips, cleanScraped).length, 0);
  });

  test('invented restaurant name flagged', () => {
    const bad = structuredClone(cleanTips);
    bad.dining.preShow.push({ name: 'Invented Bistro', cuisine: 'French', walkMinutes: 2, priceRange: '$$', notes: '' });
    const findings = validateGrounding(bad, cleanScraped);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].kind, 'invented-restaurant');
    assert.strictEqual(findings[0].name, 'Invented Bistro');
  });

  test('invented garage name flagged', () => {
    const bad = structuredClone(cleanTips);
    bad.parking.nearestGarages.push({ name: 'Ghost Garage', walkMinutes: 1 });
    const findings = validateGrounding(bad, cleanScraped);
    assert.ok(findings.some(f => f.kind === 'invented-garage'));
  });
});

// --- validateCategoryDedup -------------------------------------------------

describe('validateCategoryDedup', () => {
  test('clean tips with unique names per category -> no findings', () => {
    assert.strictEqual(validateCategoryDedup(cleanTips).length, 0);
  });

  test('same restaurant appearing in preShow and postShow is flagged', () => {
    const bad = structuredClone(cleanTips);
    bad.dining.postShow[0] = { ...bad.dining.preShow[0] };
    const findings = validateCategoryDedup(bad);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].duplicateOf, 'preShow');
  });
});

// --- auditCrossTheaterDiversity --------------------------------------------

describe('auditCrossTheaterDiversity', () => {
  test('no overuse -> empty', () => {
    const drafts = {
      t1: { dining: { preShow: [{ name: 'A' }], postShow: [], quickBite: [] } },
      t2: { dining: { preShow: [{ name: 'B' }], postShow: [], quickBite: [] } },
    };
    assert.strictEqual(auditCrossTheaterDiversity(drafts, 0.5).length, 0);
  });

  test('lazy padding (restaurant in all theaters) is flagged', () => {
    const drafts = {};
    for (let i = 0; i < 10; i++) {
      drafts[`t${i}`] = { dining: { preShow: [{ name: 'Junior\'s' }, { name: `Unique${i}` }], postShow: [], quickBite: [] } };
    }
    const findings = auditCrossTheaterDiversity(drafts, 0.5);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].name, "Junior's");
    assert.strictEqual(findings[0].count, 10);
  });

  test('same-theater dupes across categories count once per theater', () => {
    const drafts = {
      t1: { dining: { preShow: [{ name: 'X' }], postShow: [{ name: 'X' }], quickBite: [] } },
      t2: { dining: { preShow: [{ name: 'Y' }], postShow: [], quickBite: [] } },
    };
    // X is in 1/2 theaters -> fraction 0.5, not >0.5, so threshold 0.5 should NOT flag
    assert.strictEqual(auditCrossTheaterDiversity(drafts, 0.5).length, 0);
  });
});

// --- end-to-end validateTips -----------------------------------------------

describe('validateTips (end-to-end)', () => {
  test('clean tips + scraped -> all empty arrays', () => {
    const result = validateTips(cleanTips, cleanScraped);
    assert.strictEqual(result.schemaErrors.length, 0);
    assert.strictEqual(result.bannedClaims.length, 0);
    assert.strictEqual(result.groundingFindings.length, 0);
    assert.strictEqual(result.categoryDupes.length, 0);
  });

  test('known-bad fixture (elevator + invented restaurant) -> multiple findings', () => {
    const bad = structuredClone(cleanTips);
    bad.seating.bestSeats = 'The theater has an elevator to the balcony.';
    bad.dining.preShow.push({ name: 'Fabricated Cafe', cuisine: 'French', walkMinutes: 2, priceRange: '$$', notes: '' });
    const result = validateTips(bad, cleanScraped);
    assert.ok(result.bannedClaims.length >= 1, 'should flag banned claim');
    assert.ok(result.groundingFindings.length >= 1, 'should flag invented name');
  });
});

// --- validateSubwayFacts ---------------------------------------------------
//
// Empirical iteration 2026-04-15: ran current Gemini Flash prompt against 10
// theaters and found 3/10 had wrong subway lines. These tests pin each real
// hallucination we saw so the same class cannot regress silently.

describe('validateSubwayFacts', () => {
  test('correct claim ("49 St N, R, W") -> no findings', () => {
    const tips = { logistics: { nearestSubway: 'The nearest station is 49 St, served by the N, R, and W trains.' } };
    assert.strictEqual(validateSubwayFacts(tips).length, 0);
  });

  test('Q claimed at 49 St is flagged (observed Al Hirschfeld iter1)', () => {
    const tips = { logistics: { nearestSubway: 'The 49th Street subway station (N, Q, R, W lines) is the closest.' } };
    const findings = validateSubwayFacts(tips);
    assert.strictEqual(findings.length, 1);
    assert.ok(findings[0].wrongLines.includes('Q'));
    assert.strictEqual(findings[0].station, '49 st');
  });

  test('2 claimed at 50 St is flagged (observed Broadway Theatre iter1)', () => {
    const tips = { logistics: { nearestSubway: 'The 50 St. subway station (1, 2 lines) is the closest.' } };
    const findings = validateSubwayFacts(tips);
    assert.ok(findings[0].wrongLines.includes('2'));
  });

  test('7 train claimed at 50 St is flagged (persistent iter2/iter3 failure)', () => {
    const tips = { logistics: { nearestSubway: '50 St: 1, 7' } };
    const findings = validateSubwayFacts(tips);
    assert.ok(findings[0].wrongLines.includes('7'));
  });

  test('unknown station -> no finding (can verify)', () => {
    const tips = { logistics: { nearestSubway: 'The 23 St station (F, M) is a short cab ride.' } };
    assert.strictEqual(validateSubwayFacts(tips).length, 0);
  });

  test('null subway field -> no finding', () => {
    const tips = { logistics: { nearestSubway: null } };
    assert.strictEqual(validateSubwayFacts(tips).length, 0);
  });

  test('extractClaimedLines: parenthesized list preferred over full text', () => {
    const lines = extractClaimedLines('The 49 St station (N, Q, R, W lines) is closest.');
    assert.deepStrictEqual(lines.sort(), ['N', 'Q', 'R', 'W']);
  });

  test('findKnownStation: ordinal "49th Street" normalizes to "49 st"', () => {
    assert.strictEqual(findKnownStation('The 49th Street subway station'), '49 st');
  });

  test('findKnownStation: "42nd Street-Bryant Park" matches bryant pk', () => {
    const key = findKnownStation('The 42nd Street-Bryant Park station');
    assert.ok(key === '42 st-bryant pk' || key === 'bryant pk' || key === 'bryant park');
  });
});

// --- Golden fixture tests (real model output) ------------------------------

describe('golden fixtures from live Gemini Flash output (2026-04-15)', () => {
  test('clean-ambassador: real iter3 output passes all validators', () => {
    const tips = loadFixture('clean-ambassador.json');
    const result = validateTips(tips, { dining: [], parking: [] });
    assert.strictEqual(result.bannedClaims.length, 0);
    assert.strictEqual(result.categoryDupes.length, 0);
    assert.strictEqual(result.subwayFindings.length, 0);
  });

  test('clean-lena-horne: real iter3 output passes all validators', () => {
    const tips = loadFixture('clean-lena-horne.json');
    const result = validateTips(tips, { dining: [], parking: [] });
    assert.strictEqual(result.bannedClaims.length, 0);
    assert.strictEqual(result.subwayFindings.length, 0);
  });

  test('regression-subway-q-at-49: real iter1 hallucination must be flagged', () => {
    const tips = loadFixture('regression-subway-q-at-49.json');
    const findings = validateSubwayFacts(tips);
    assert.ok(findings.length >= 1);
    assert.ok(findings[0].wrongLines.includes('Q'));
  });

  test('regression-subway-2-at-50: real iter1 hallucination must be flagged', () => {
    const tips = loadFixture('regression-subway-2-at-50.json');
    const findings = validateSubwayFacts(tips);
    assert.ok(findings.length >= 1);
    assert.ok(findings[0].wrongLines.includes('2'));
  });
});
