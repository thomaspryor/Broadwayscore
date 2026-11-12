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
 * No exemption marker (BRO-7108): the old `TESTS-VS-DERIVED-DATA-EXEMPT`
 *   comment is retired. A test that only mentions a derived path in a fixture
 *   string is not a read and needs nothing; one that really reads the live
 *   corpus declares `LIVE-DATA-LANE:` (below); a temp-dir fixture builds the
 *   path in pieces (path.join(root, 'data', 'shows.json')).
 *
 * Live-data lane (BRO-7101): a test that declares `// LIVE-DATA-LANE: <why>`
 *   (or is named *-live-data.test.*) no longer runs in test.yml's blocking
 *   batch, so a fact that rots there cannot redden main. It is compliant here.
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

const { isDeclaredLive } = require('./lib/live-data-paths.js');

// BRO-7108: a derived path only counts when the test touches it through a file
// read on that same line (readFileSync / require / import / new URL /
// existsSync / statSync). A path that appears only in a comment or inside a
// fixture string (workflow YAML, git commands, file-size tables) is not a read
// of the live corpus, so such tests need no exemption.
const READ_CALL = /\b(readFileSync|readFile|require|import|existsSync|statSync|createReadStream|loadJson|readJson)\b|new URL\(/;
function readsDerivedFile(src) {
  return src.split('\n').some((line) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false;
    return DERIVED_PATTERNS.some((re) => re.test(line)) && READ_CALL.test(line);
  });
}

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
    if (isDeclaredLive(`tests/unit/${name}`, src)) continue; // BRO-7101: not in the blocking batch
    const readsDerived = readsDerivedFile(src);
    if (!readsDerived) continue;

    const readsSource = SOURCE_PATTERNS.some((re) => re.test(src));
    if (readsSource) continue;

    violations.push(name);
  }

  if (violations.length === 0) {
    console.log(`OK: ${files.length} test files audited; all tests reading derived data either also read source-of-truth or are declared live-data.`);
    return;
  }

  console.error(`\nFound ${violations.length} test file(s) reading derived data WITHOUT also reading source-of-truth and WITHOUT a live-data declaration:\n`);
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
  Option B: If the test really reads the live corpus but pins no specific
    fact (schema integrity, count > 0), declare the live-data lane near the
    top of the file:
      // LIVE-DATA-LANE: reads data/shows.json (untracked core data). ...
    It then runs in check-corpus-drift.yml instead of blocking main.
    A temp-dir fixture should spell the path as path.join(root, 'data', 'x.json').

Background:
  memory/feedback_data_pins_derive_from_source.md
  (also: 2026-05-26 incident where 3 unit tests broke because they pinned
   misread Wikipedia data that Track A later corrected.)
`);
  process.exit(1);
}

if (require.main === module) audit();
module.exports = { readsDerivedFile };
