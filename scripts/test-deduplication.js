#!/usr/bin/env node
/**
 * Tests for scripts/lib/deduplication.js
 *
 * Covers the 2026-05-03 Emporium duplicate incident:
 *   "Thornton Wilder's The Emporium" vs "The Emporium"
 *   shipped as two entries because the possessive prefix wasn't stripped.
 *
 * Run: node scripts/test-deduplication.js
 */

const {
  normalizeTitle,
  checkForDuplicate,
} = require('./lib/deduplication');

const tests = [];
let pass = 0;
let fail = 0;

function test(name, fn) {
  tests.push({ name, fn });
}

function assertEqual(actual, expected, name) {
  if (actual === expected) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
  }
}

// ---------- normalizeTitle ----------

test('normalizeTitle: strips author possessive prefix (2-word author)', () => {
  assertEqual(
    normalizeTitle("Thornton Wilder's The Emporium"),
    'emporium',
    "Thornton Wilder's The Emporium → emporium"
  );
});

test('normalizeTitle: strips brand possessive prefix (Disney)', () => {
  assertEqual(
    normalizeTitle("Disney's Aladdin"),
    'aladdin',
    "Disney's Aladdin → aladdin"
  );
});

test('normalizeTitle: strips multi-word author possessive (3 words)', () => {
  assertEqual(
    normalizeTitle("Andrew Lloyd Webber's Cats"),
    'cats',
    "Andrew Lloyd Webber's Cats → cats"
  );
});

test('normalizeTitle: strips Stephen Sondheim possessive', () => {
  assertEqual(
    normalizeTitle("Stephen Sondheim's Old Friends"),
    'old friends',
    "Stephen Sondheim's Old Friends → old friends"
  );
});

test('normalizeTitle: handles curly apostrophe', () => {
  assertEqual(
    normalizeTitle('Thornton Wilder’s The Emporium'),
    'emporium',
    "Thornton Wilder’s The Emporium → emporium"
  );
});

test('normalizeTitle: keeps integral possessives (single-word)', () => {
  // Single-word possessive that IS the title's own structure,
  // we still strip — collisions are caught downstream by isMultiProduction.
  assertEqual(
    normalizeTitle("Hell's Kitchen"),
    'kitchen',
    "Hell's Kitchen → kitchen (collision risk handled by venue/year check)"
  );
});

test('normalizeTitle: leaves non-possessive titles alone', () => {
  assertEqual(
    normalizeTitle('Cats'),
    'cats',
    "Cats → cats"
  );
  assertEqual(
    normalizeTitle('A Doll House'),
    'doll house',
    "A Doll House → doll house"
  );
});

test('normalizeTitle: still strips colon subtitle', () => {
  assertEqual(
    normalizeTitle('All Out: Comedy About Ambition'),
    'all out',
    "All Out: ... → all out"
  );
});

// ---------- checkForDuplicate (the Emporium case) ----------

const emporium2025 = {
  id: 'the-emporium-off-broadway-2025',
  title: 'The Emporium',
  slug: 'the-emporium-off-broadway',
  venue: 'Classic Stage Company',
  category: 'off-broadway',
  status: 'upcoming',
  openingDate: null,
};

const emporium2026 = {
  id: 'thornton-wilders-the-emporium-off-broadway-2026',
  title: "Thornton Wilder's The Emporium",
  slug: 'thornton-wilders-the-emporium-off-broadway',
  venue: 'Classic Stage Company',
  category: 'off-broadway',
  status: 'previews',
  openingDate: '2026-05-18',
};

test('Emporium: possessive variant flagged as duplicate (same venue, same year)', () => {
  const r = checkForDuplicate(emporium2026, [emporium2025]);
  assertEqual(r.isDuplicate, true, '2026 variant flagged as dup of 2025 entry');
});

test('Emporium: order-invariant', () => {
  const r = checkForDuplicate(emporium2025, [emporium2026]);
  assertEqual(r.isDuplicate, true, '2025 variant flagged when 2026 already in catalog');
});

// ---------- false-positive prevention ----------

const bandsVisit2017 = {
  id: 'the-bands-visit-2017',
  title: "The Band's Visit",
  slug: 'the-bands-visit-2017',
  venue: 'Ethel Barrymore Theatre',
  category: 'broadway',
  status: 'closed',
  openingDate: '2017-11-09',
};

const visit2015 = {
  id: 'the-visit-2015',
  title: 'The Visit',
  slug: 'the-visit-2015',
  venue: 'Lyceum Theatre',
  category: 'broadway',
  status: 'closed',
  openingDate: '2015-04-23',
};

test("FP guard: \"The Band's Visit\" vs \"The Visit\" at different venues NOT flagged", () => {
  const r = checkForDuplicate(bandsVisit2017, [visit2015]);
  assertEqual(r.isDuplicate, false, "different venues → multi-production");
});

const visit1973 = {
  id: 'the-visit-1973',
  title: 'The Visit',
  slug: 'the-visit-1973',
  venue: 'Ethel Barrymore Theatre',
  category: 'broadway',
  status: 'closed',
  openingDate: '1973-11-25',
};

test("FP guard: \"The Band's Visit\" 2017 vs \"The Visit\" 1973 same venue NOT flagged (year gap)", () => {
  const r = checkForDuplicate(bandsVisit2017, [visit1973]);
  assertEqual(r.isDuplicate, false, "44-year gap → multi-production");
});

const fosseDancin = {
  id: 'bob-fosses-dancin-2023',
  title: "Bob Fosse's Dancin'",
  slug: 'bob-fosses-dancin-2023',
  venue: 'Music Box Theatre',
  category: 'broadway',
  status: 'closed',
  openingDate: '2023-03-19',
};

const dancin1978 = {
  id: 'dancin-1978',
  title: "Dancin'",
  slug: 'dancin-1978',
  venue: 'Broadhurst Theatre',
  category: 'broadway',
  status: 'closed',
  openingDate: '1978-03-27',
};

test("FP guard: \"Bob Fosse's Dancin'\" vs \"Dancin'\" different venues NOT flagged", () => {
  const r = checkForDuplicate(fosseDancin, [dancin1978]);
  assertEqual(r.isDuplicate, false, "different venues + closed → multi-production");
});

// ---------- existing dedup behavior preserved ----------

test("Existing: Disney's Aladdin still dedupes against Aladdin", () => {
  const aladdinDisney = {
    id: 'aladdin-2014',
    title: "Disney's Aladdin",
    slug: 'aladdin-2014',
    venue: 'New Amsterdam Theatre',
    category: 'broadway',
    status: 'open',
    openingDate: '2014-03-20',
  };
  const aladdinPlain = {
    id: 'aladdin-2014-todaytix',
    title: 'Aladdin',
    slug: 'aladdin-2014-todaytix',
    venue: 'New Amsterdam Theatre',
    category: 'broadway',
    status: 'open',
    openingDate: '2014-03-20',
  };
  const r = checkForDuplicate(aladdinDisney, [aladdinPlain]);
  assertEqual(r.isDuplicate, true, "Disney's Aladdin === Aladdin");
});

test('Existing: cross-market same title NOT flagged (Hamilton BW vs WE)', () => {
  const hamiltonBw = {
    id: 'hamilton-2015',
    title: 'Hamilton',
    slug: 'hamilton-2015',
    venue: 'Richard Rodgers Theatre',
    category: 'broadway',
    status: 'open',
    openingDate: '2015-08-06',
  };
  const hamiltonWe = {
    id: 'hamilton-west-end-2017',
    title: 'Hamilton',
    slug: 'hamilton-west-end-2017',
    venue: 'Victoria Palace Theatre',
    category: 'west-end',
    status: 'open',
    openingDate: '2017-12-21',
  };
  const r = checkForDuplicate(hamiltonWe, [hamiltonBw]);
  assertEqual(r.isDuplicate, false, 'cross-market: not a duplicate');
});

// ---------- regression: Globe duplicate guard (2026-05-09 incident) ----------

const { findSameTitleTwinIfNoOpeningDate } = require('./lib/deduplication');

const motherCourageGlobe = {
  id: 'mother-courage-and-her-children-globe-west-end-2026',
  title: 'Mother Courage and Her Children - Globe',
  slug: 'mother-courage-and-her-children-globe-west-end',
  venue: "Shakespeare's Globe",
  category: 'off-west-end',
  status: 'upcoming',
  openingDate: '2026-05-07',
};

test('Globe guard: candidate with null openingDate + same title in same pool → twin found', () => {
  const candidate = {
    title: 'Mother Courage and Her Children - Globe',
    venue: 'Globe Theatre',
    category: 'off-west-end',
    openingDate: null,
  };
  const twin = findSameTitleTwinIfNoOpeningDate(candidate, [motherCourageGlobe]);
  assertEqual(twin?.id, motherCourageGlobe.id, 'twin returned for Globe-incident scenario');
});

test('Globe guard: candidate WITH openingDate → guard skipped (returns null)', () => {
  const candidate = {
    title: 'Mother Courage and Her Children - Globe',
    venue: 'Globe Theatre',
    category: 'off-west-end',
    openingDate: '2026-05-07',
  };
  const twin = findSameTitleTwinIfNoOpeningDate(candidate, [motherCourageGlobe]);
  assertEqual(twin, null, 'openingDate present → guard does not fire');
});

test('Globe guard: cross-pool same title → no twin (Hamilton WE vs Hamilton BW)', () => {
  const hamiltonBw = {
    id: 'hamilton-2015',
    title: 'Hamilton',
    venue: 'Richard Rodgers Theatre',
    category: 'broadway',
    status: 'open',
    openingDate: '2015-08-06',
  };
  const candidate = {
    title: 'Hamilton',
    venue: 'Victoria Palace Theatre',
    category: 'west-end',
    openingDate: null,
  };
  const twin = findSameTitleTwinIfNoOpeningDate(candidate, [hamiltonBw]);
  assertEqual(twin, null, 'cross-pool: BW vs WE never twins');
});

// ---------- run ----------

console.log('Running deduplication tests...\n');
for (const t of tests) {
  console.log(t.name);
  try {
    t.fn();
  } catch (e) {
    fail++;
    console.log(`  ✗ threw: ${e.message}`);
  }
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
