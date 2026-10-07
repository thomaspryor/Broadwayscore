#!/usr/bin/env node
/**
 * audit-tests-vs-derived-data.js
 *
 * Mechanical guard against the "production data pin" anti-pattern.
 *
 * What's the anti-pattern?
 *   On 2026-05-26 three unit tests broke because they hard-pinned factual
 *   claims about data/awards.json ("Lithgow won for X", "Levy@Chess").
 *   Track A's Wikipedia audit corrected that data the day before — fixing
 *   the data, breaking the pins. The test was *re-asserting the bug* its
 *   original author was trying to prevent.
 *
 * What this guard enforces:
 *   Any tests/unit/*.test.mjs that reads a *derived* file (data/awards.json,
 *   data/reviews.json, data/shows.json) must also read from a *source-of-
 *   truth* file (data/precursors/, data/review-texts/) — i.e. the input
 *   that *generated* the derived data. This pushes test authors toward
 *   deriving expectations from sources, instead of hardcoding facts that
 *   silently rot when audits update the sources.
 *
 * Exemption escape hatch:
 *   Add a top-of-file comment `// TESTS-VS-DERIVED-DATA-EXEMPT: <reason>`
 *   anywhere in the first 40 lines. Use for genuinely structural tests
 *   (schema integrity, count > 0, no nulls) that don't pin specific facts.
 *
 * Exit code: 0 = clean, 1 = violations.
 */

const fs = require('node:fs');
const path = require('node:path');

const TESTS_DIR = path.join(__dirname, '..', 'tests', 'unit');

// Derived files — outputs of enrichers / rebuilds. Tests reading these
// without source-of-truth context are the risky case.
const DERIVED_PATTERNS = [
  /data\/awards\.json/,
  /data\/reviews\.json/,
  /data\/shows\.json/,
];

// Source-of-truth dirs — inputs that generate derived data. Any read
// from these counts as satisfying the rule.
const SOURCE_PATTERNS = [
  /data\/precursors\//,
  /data\/review-texts\//,
];

const EXEMPT_MARKER = /\/\/\s*TESTS-VS-DERIVED-DATA-EXEMPT:\s*\S+/;

function audit() {
  if (!fs.existsSync(TESTS_DIR)) {
    console.error(`tests dir not found: ${TESTS_DIR}`);
    process.exit(1);
  }
  const files = fs
    .readdirSync(TESTS_DIR)
    .filter((f) => f.endsWith('.test.mjs') || f.endsWith('.test.js') || f.endsWith('.test.ts'));

  const violations = [];

  for (const name of files) {
    const fp = path.join(TESTS_DIR, name);
    const src = fs.readFileSync(fp, 'utf8');
    const readsDerived = DERIVED_PATTERNS.some((re) => re.test(src));
    if (!readsDerived) continue;

    const readsSource = SOURCE_PATTERNS.some((re) => re.test(src));
    if (readsSource) continue;

    // Check first 40 lines for exemption marker.
    const head = src.split('\n').slice(0, 40).join('\n');
    if (EXEMPT_MARKER.test(head)) continue;

    violations.push(name);
  }

  if (violations.length === 0) {
    console.log(`OK: ${files.length} test files audited; all tests reading derived data either also read source-of-truth or carry an explicit exemption.`);
    return;
  }

  console.error(`\nFound ${violations.length} test file(s) reading derived data WITHOUT also reading source-of-truth and WITHOUT an exemption:\n`);
  for (const v of violations) {
    console.error(`  tests/unit/${v}`);
  }
  console.error(`
Why this fails:
  These tests read data/awards.json / data/reviews.json / data/shows.json
  (the derived outputs of enrichers and rebuilds) but never read from
  data/precursors/ or data/review-texts/ (the sources that GENERATE that
  derived data). Hardcoded factual claims against derived data silently
  rot when an audit updates the source — and the test ends up re-asserting
  the very bug it was meant to catch.

How to fix:
  Option A (preferred): Read the source-of-truth file in your test and
    derive expectations from it. Example: tests/unit/awards-person-winner-
    pairing.test.mjs reads data/precursors/drama-desk.json and asserts
    that data/awards.json reflects what each precursor row encodes.
  Option B (escape hatch): If your test is genuinely structural (schema
    integrity, count > 0, no nulls — not pinning specific facts), add
    this comment near the top of the file:
      // TESTS-VS-DERIVED-DATA-EXEMPT: <one-line reason>
    Reviewers should challenge any new exemption.

Background:
  memory/feedback_data_pins_derive_from_source.md
  (also: 2026-05-26 incident where 3 unit tests broke because they pinned
   misread Wikipedia data that Track A later corrected.)
`);
  process.exit(1);
}

audit();
