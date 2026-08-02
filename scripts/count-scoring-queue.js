#!/usr/bin/env node
/**
 * count-scoring-queue.js — the LLM scoring cascade's gate reads this, and only this.
 *
 * Replaces four hand-rolled `node -e` counters that used to live inline in
 * .github/workflows/llm-ensemble-score.yml. Each had drifted looser than the
 * selection filter scripts/llm-scoring/index.ts actually applies, and because
 * the workflow gates phases 2-4 behind `UNSCORED == 0`, that drift starved the
 * whole cascade (task #652). Rationale in scripts/lib/scoring-queue-counts.js.
 *
 * Usage:
 *   node scripts/count-scoring-queue.js            # human-readable
 *   node scripts/count-scoring-queue.js --json     # one JSON object on stdout
 *   node scripts/count-scoring-queue.js --github-output   # KEY=value for $GITHUB_OUTPUT
 *   node scripts/count-scoring-queue.js --dir=path/to/review-texts
 */

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help');

const USAGE = `count-scoring-queue.js — depth of each LLM scoring-cascade phase

  --json            emit a single JSON object on stdout
  --github-output   emit unscored=/rescore=/stale=/emergency= lines for $GITHUB_OUTPUT
  --dir=PATH        review-texts root (default data/review-texts)
  --shows=PATH      shows.json used for titles (default data/shows.json)
  --min-scanned=N   exit 1 if fewer than N review files were scanned
  --require-shows   exit 1 if shows.json can't be read (default: warn)
  -h, --help        this message

Counts are the CANONICAL, actionable depth — files the scorer can never consume
(not scoreable, terminal text-gate block, no scoreable text) are excluded and
reported separately as residue. Read scripts/lib/scoring-queue-counts.js first.`;

if (hasHelpFlag(process.argv)) {
  console.log(USAGE);
  process.exit(0);
}

const { countScoringQueues } = require('./lib/scoring-queue-counts');

const args = process.argv.slice(2);
const argVal = (name, fallback) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const reviewTextsDir = argVal('dir', path.join('data', 'review-texts'));
const showsPath = argVal('shows', path.join('data', 'shows.json'));

const showTitles = new Map();
try {
  const raw = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw.shows || [];
  for (const s of list) if (s && s.id && s.title) showTitles.set(s.id, s.title);
} catch (err) {
  // Titles feed content-quality's show-mention check, so a missing shows.json
  // shifts the counts rather than merely blurring them. Loud by default, and
  // hard-fail under --require-shows (which CI passes) so a broken core-data
  // checkout can never masquerade as a drained queue.
  const msg = `count-scoring-queue: could not read ${showsPath} (${err.message}) — counts may shift without show titles`;
  if (args.includes('--require-shows')) {
    console.error(`ERROR: ${msg}`);
    process.exit(1);
  }
  console.error(`WARNING: ${msg}`);
}

let counts;
try {
  counts = countScoringQueues(reviewTextsDir, { showTitles });
} catch (err) {
  console.error(`ERROR: could not scan ${reviewTextsDir}: ${err.message}`);
  process.exit(1);
}

// Scan-collapse guard. A half-checked-out or empty review-texts tree would
// otherwise report a drained queue and silently stop the scorer forever with
// a green run (Codex adversarial review, task #652 ship-check).
const minScanned = Number(argVal('min-scanned', '0'));
if (minScanned > 0 && counts.scanned < minScanned) {
  console.error(
    `ERROR: scanned only ${counts.scanned} review files in ${reviewTextsDir} (expected >= ${minScanned}). ` +
    'Refusing to report queue depth from a partial corpus — check the review-texts checkout.'
  );
  process.exit(1);
}

const githubOutput = args.includes('--github-output');

// A full scan is ~15s over 41K files, so --github-output writes the
// KEY=value lines to stdout and the human report to STDERR in the same run —
// the workflow gets both from one invocation instead of scanning twice.
function report(write) {
  write(`Scanned ${counts.scanned} review files in ${reviewTextsDir}`);
  write(`  UNSCORED  (phase 1): ${counts.unscored}`);
  write(`  RESCORE   (phase 2): ${counts.rescore}`);
  write(`  STALE     (phase 3): ${counts.stale}`);
  write(`  EMERGENCY (phase 4): ${counts.emergency}`);
  const residue = Object.entries(counts.unscoredResidue);
  if (residue.length) {
    write('');
    write('Unscored residue excluded from the gate (not actionable by the scorer):');
    for (const [reason, n] of residue.sort((a, b) => b[1] - a[1])) write(`  ${reason}: ${n}`);
  }
  if (counts.unrecoverableSamples.length) {
    write('');
    write('Sample unrecoverable files (need recovered text, not a retry):');
    for (const s of counts.unrecoverableSamples) write(`  ${s}`);
  }
}

if (args.includes('--json')) {
  console.log(JSON.stringify(counts));
} else if (githubOutput) {
  report(line => console.error(line));
  console.log(`unscored=${counts.unscored}`);
  console.log(`rescore=${counts.rescore}`);
  console.log(`stale=${counts.stale}`);
  console.log(`emergency=${counts.emergency}`);
} else {
  report(line => console.log(line));
}
