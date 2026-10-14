#!/usr/bin/env node
/**
 * WHO is re-creating the #483 stale-flag state.
 *
 * WHY THIS EXISTS
 * ---------------
 * `audit-stale-flag-after-url-correction.js --gate` answers "is the corpus
 * clean?" Nothing answered "which code is putting it back?", and that gap is
 * what turned this bug into a multi-day loop:
 *
 *   2026-08-12  a session fixed maybeUpgradeUrl (review-normalization.js)
 *   2026-08-13  a session fixed flag-wrong-production-by-date.js, drained the
 *               backlog, watched the gate read 0, reported it closed.
 *               Red again the same evening.
 *
 * Neither producer appears in this tool's first run. Both fixes were correct
 * and neither touched what was actually writing the state. The producers were
 * found only by hand-grepping notes off re-flagged files — this automates that.
 *
 * WHAT IT DOES AND DOES NOT DO
 * ----------------------------
 * DOES: attribute every currently-matching file to the producer that stamped
 * it, by note prefix, and group by URL-correction day.
 *
 * DOES NOT: prove a fix worked. An earlier version of this file shipped a
 * `--fail-if-any-since=DATE` flag pitched as a falsification test. It was
 * removed because it was itself a false green, in two ways an adversarial
 * review caught before merge:
 *   - it keyed on `_urlChangedClear.at` (WHEN THE URL WAS CORRECTED), but the
 *     event being falsified is when a PRODUCER STAMPED THE FLAG. Measured on
 *     the live corpus: 110 of 121 files had a correction date before the fix
 *     date but a file mtime after it, so the window reported 11 and passed
 *     silently over 110.
 *   - review records carry no stamp timestamp at all, so there is nothing
 *     honest to key on. Fixing this needs a provenance field on the write, not
 *     a flag on a reader.
 * Shipping it would have reproduced the exact failure it was written to stop:
 * a check that returns green without bearing on the thing it claims to check.
 * If you want a real falsification test, add the stamp timestamp first.
 */

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { detectStaleFlagAfterUrlCorrection } = require('./lib/stale-flag-after-url-correction');
const { listShowDirs } = require('./lib/list-show-dirs');
const { assertCorpusScanned, CorpusNotScannedError } = require('./lib/corpus-scan-guard');

const USAGE = `audit-stale-flag-producers.js — attribute #483 stale-flag files to the producer that stamped them.

Usage:
  node scripts/audit-stale-flag-producers.js [--review-texts-dir=PATH] [--json]

  --review-texts-dir=PATH   corpus root (default: data/review-texts; REVIEW_TEXTS_DIR env also honoured)
  --json                    machine-readable output
  --help, -h                print this and exit

Reports only. It cannot tell you whether a fix held — see the docblock.
`;

const argv = process.argv.slice(2);
if (hasHelpFlag(argv)) {
  console.log(USAGE);
  process.exit(0);
}

const dirArg = argv.find((a) => a.startsWith('--review-texts-dir='));
const REVIEW_TEXTS_DIR = dirArg ? dirArg.split('=')[1]
  : (process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts'));
const asJson = argv.includes('--json');

// A zero-file scan must FAIL, not print a reassuring zero. scripts/lib/
// corpus-scan-guard.js exists because of task #1063: "an audit that reports 0
// issues in that state is a vacuous pass, worse than no gate at all". This tool
// is run in worktrees where data/review-texts does not exist, so it is exactly
// the shape that would have produced a confident false green.
let showDirs = [];
try {
  showDirs = listShowDirs(REVIEW_TEXTS_DIR, { silent: true });
} catch {
  showDirs = [];
}
try {
  assertCorpusScanned(showDirs.length, { gate: true });
} catch (e) {
  if (!(e instanceof CorpusNotScannedError)) throw e;
  console.error(`FAIL: ${e.message}`);
  console.error(`(looked in ${REVIEW_TEXTS_DIR} — pass --review-texts-dir=PATH or set REVIEW_TEXTS_DIR)`);
  process.exit(1);
}

// These producers already identify their own flags by note prefix —
// rebuild-all-reviews.js:1384 matches on `Pre-opening guard:` to recognise what
// it wrote. That string-literal coupling is itself the defect described in
// memory/feedback_includability_predicates_must_be_canonical.md; until the
// producers stamp a real provenance field, prefixes are the only attribution
// available. Where a prefix is emitted by more than one script, say so rather
// than picking one — naming the wrong file is how the loop repeats.
const PRODUCERS = [
  ['Pre-opening guard:', 'rebuild-all-reviews.js (inline pre-opening guard)'],
  ['Dateless revival guard:', 'AMBIGUOUS — rebuild-all-reviews.js:1489 OR flag-wrong-production-by-date.js:151 (byte-identical notes)'],
  ['Date guard:', 'flag-wrong-production-by-date.js'],
  ['URL-path cross-market:', 'rebuild-all-reviews.js (URL-path cross-market guard)'],
  ['Cross-market:', 'rebuild-all-reviews.js (cross-market guard)'],
  ['Same URL exists', 'rebuild-all-reviews.js (same-URL dedup)'],
  ['OB review superseded', 'rebuild-all-reviews.js (OB supersede)'],
  ['CV-promoted:', 'content-verification promotion path'],
  ['Cross-show URL collision', 'audit-cross-show-url-collisions.js'],
];

function attribute(data) {
  const note = String(data.wrongProductionNote || data.wrongShowReason || '');
  for (const [prefix, name] of PRODUCERS) {
    if (note.startsWith(prefix)) return name;
  }
  if (data.wrongProductionProvenance === 'manual') return 'manual (operator)';
  return note ? `UNATTRIBUTED — note: ${note.slice(0, 60)}` : 'UNATTRIBUTED — no note';
}

let scanned = 0;
const rows = [];
for (const showDir of showDirs) {
  const dirPath = path.join(REVIEW_TEXTS_DIR, showDir);
  let entries;
  try { entries = fs.readdirSync(dirPath); } catch { continue; }
  for (const file of entries) {
    if (!file.endsWith('.json')) continue;
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(dirPath, file), 'utf8')); } catch { continue; }
    scanned++; // count only files we actually parsed, so the total is honest
    if (detectStaleFlagAfterUrlCorrection(data).length === 0) continue;
    const at = data._urlChangedClear && data._urlChangedClear.at;
    rows.push({
      showId: showDir,
      file,
      producer: attribute(data),
      urlCorrectedOn: at ? String(at).slice(0, 10) : 'unknown',
    });
  }
}

const byProducer = {};
for (const r of rows) byProducer[r.producer] = (byProducer[r.producer] || 0) + 1;

if (asJson) {
  console.log(JSON.stringify({ scanned, matched: rows.length, byProducer, rows }, null, 2));
} else {
  console.log(`Stale-flag producer attribution: ${scanned} files parsed across ${showDirs.length} shows, ${rows.length} match.\n`);
  if (rows.length === 0) {
    console.log('Corpus is clean. (This says nothing about whether any fix HELD — see --help.)');
  } else {
    console.log('BY PRODUCER — the list of code still writing this state:');
    for (const [p, n] of Object.entries(byProducer).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(4)}  ${p}`);
    }
    console.log('\nNote: counts are attribution by note prefix, not proof of causation.');
    console.log('An AMBIGUOUS row means two scripts emit byte-identical notes — check both.');
  }
}
