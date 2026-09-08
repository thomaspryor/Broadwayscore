#!/usr/bin/env node

/**
 * Standing CI check for the flag-vs-CV contradiction signal (#651, Notion
 * 3ad637c5). Previously this detector was computed exactly once, by hand, to
 * produce the pipeline-health audit — nothing re-ran it and nothing gated on
 * it. Scans review-text files for shows that opened in the last 30 days and
 * counts detectCvFlagContradiction() hits (scripts/lib/flag-contradiction.js):
 * an exclusion flag (wrongProduction/wrongShow/isRoundupArticle) sitting on a
 * file whose own most recent full-text contentVerification pass affirms it
 * (isValid, confidence 'high') at >300 words.
 *
 * A hit is bait for a human look, not proof of a false positive — CV is not
 * authoritative over the flags. The original acceptance bar (drive the count
 * under 4, then flip --gate on) never landed — the count sat at ~24-29 for
 * weeks. Task #1673 replaces that stalled manual-drain plan with
 * baseline-diff (mirrors #1665/#1666/#1668, which all removed their legacy
 * gate flag on cutover — none of them carries one today): the pre-existing
 * backlog is frozen in data/audit/cv-flag-contradiction-baseline.json and
 * never fails CI — only a NEW (showId, file) pair not in that baseline fails
 * the build under --strict. Identity is (showId, file), not the detected
 * `flag` or `cvReasoning` — see scripts/lib/cv-flag-contradiction-baseline.js
 * for why.
 *
 * UNLIKE the 3 precedents (which scan the full corpus every run), this
 * script windows to shows opened in the last --window days by design (the
 * signal is a pipeline-health check for recently-opened shows, not a
 * standing corpus property) — so a baselined hit whose show ages past the
 * window simply stops appearing in `hits`, on both --strict and
 * --update-baseline. That's harmless for --strict (an aged-out hit can never
 * cause a false failure), but --update-baseline's full-overwrite would
 * silently drop it from the baseline with no record of why — indistinguishable
 * from "someone fixed it" — so --update-baseline logs every dropped/added key
 * explicitly (second-opinion review, task #1673) instead of writing a silent
 * diff.
 *
 * Usage:
 *   node scripts/audit-cv-flag-contradiction.js                   # report only
 *   node scripts/audit-cv-flag-contradiction.js --strict           # exit 1 on NEW (non-baselined) hits
 *   node scripts/audit-cv-flag-contradiction.js --update-baseline  # regenerate baseline from current scan
 *   node scripts/audit-cv-flag-contradiction.js --window=30        # days (default 30)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { detectCvFlagContradiction } = require('./lib/flag-contradiction');
const {
  assertCorpusScanned,
  CorpusNotScannedError,
  summarizeWindowCoverage,
  shouldRefuseRedirectedGate,
} = require('./lib/corpus-scan-guard');
const { baselineKeySet, computeNewViolators } = require('./lib/cv-flag-contradiction-baseline');

const USAGE = `audit-cv-flag-contradiction.js — flag-vs-CV contradiction detector (#651)

Usage:
  node scripts/audit-cv-flag-contradiction.js [--strict] [--update-baseline] [--window=30]

  --strict           exit 1 when a NEW (non-baselined) contradiction is found (task #1673)
  --update-baseline  regenerate data/audit/cv-flag-contradiction-baseline.json from the current scan
  --window=N         only consider shows opened in the last N days (default 30)
`;

// BSC_AUDIT_ROOT exists so the coverage counting below can be proven against
// a fixture corpus instead of asserted by eye — the counters are the whole
// point of BRO-2348, and an uncounted counter is exactly the "absence of a
// signal looks like the safe outcome" trap.
//
// A redirect that could PASS a gate is REFUSED in main(), via
// shouldRefuseRedirectedGate(): a NON-EMPTY decoy root satisfies
// assertCorpusScanned, so `--strict` once printed "0 contradiction(s)" and
// exited 0 on this repo's own CI gate (test.yml:4485), which is also on the
// autonomous-triage safe-check allowlist. An EMPTY redirected corpus is
// deliberately allowed through, because it can only ever FAIL loudly at
// assertCorpusScanned -- refusing it too made that guard untestable and let
// its `gate:` argument be mutated to false with every suite still green.
// Report-only runs may always redirect.
const ROOT_OVERRIDE = process.env.BSC_AUDIT_ROOT || '';
const ROOT = ROOT_OVERRIDE ? path.resolve(ROOT_OVERRIDE) : path.resolve(__dirname, '..');
const SHOWS_FILE = path.join(ROOT, 'data', 'shows.json');
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');
const BASELINE_PATH = path.join(ROOT, 'data', 'audit', 'cv-flag-contradiction-baseline.json');

function parseArgs(argv) {
  const args = { window: 30, strict: false, updateBaseline: false };
  for (const a of argv) {
    if (a === '--strict') args.strict = true;
    else if (a === '--update-baseline') args.updateBaseline = true;
    else if (a.startsWith('--window')) {
      // Keep the RAW token: parseInt truncates, so '1e9' becomes 1 and '30d'
      // becomes 30 — nonsense silently turned into a plausible window
      // (round 4 finding 3). main() validates the token, not just the number.
      // slice, NOT split('=')[1]: split truncates at a SECOND '=', so
      // '--window=1=e9' handed the regex just '1' and passed, running a
      // one-day scan (round 5). That is the very bug round 4 filed --
      // validating the truncation instead of the token -- reintroduced by
      // round 4's own fix.
      // Match '--window' broadly, then require the '=<digits>' form. Gating
      // the branch on '--window=' meant a bare `--window 7` matched NOTHING,
      // was silently dropped, and the sweep scanned the DEFAULT 30 days while
      // printing "--window=30d" -- an operator asking for 7 got 30 and a
      // clean exit 0. Same silent-wrong-window class as the tokens above.
      args.windowRaw = a.startsWith('--window=') ? a.slice('--window='.length) : a;
      args.window = parseInt(args.windowRaw, 10);
    }
  }
  return args;
}

function loadBaseline() {
  try {
    return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  } catch {
    return { hits: [] };
  }
}

function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const args = parseArgs(process.argv.slice(2));

  // An unusable --window is a vacuous PASS of the same class as the redirected
  // root below: `--window=abc` made parseInt return NaN, every date comparison
  // false, and `--strict` exit 0 having examined ZERO shows, while the
  // coverage line laundered the NaN into a clean-looking "--window=0d"
  // (round 3 finding 1). `--window=-5` passed too. Reject it outright rather
  // than letting a downstream clamp turn nonsense into a plausible number.
  if (args.windowRaw !== undefined && !/^\d+$/.test(args.windowRaw)) {
    console.error(
      `FAIL: --window must be a positive number of days, got "${args.windowRaw}". ` +
        'Refusing rather than scanning an empty window and reporting it as clean.'
    );
    process.exit(2);
  }
  if (!Number.isFinite(args.window) || args.window <= 0) {
    console.error(
      `FAIL: --window must be a positive number of days, got "${args.window}". ` +
        'Refusing rather than scanning an empty window and reporting it as clean.'
    );
    process.exit(2);
  }


  // Corpus presence, checked independent of the date window below (#1063
  // ship-check finding): gating on the window-filtered per-file `scanned`
  // count conflated "corpus missing" with "0 shows opened in this window" —
  // a real, if rare, false-FAIL on a quiet window. A raw top-level listing
  // of REVIEW_TEXTS_DIR answers "is the checkout here at all" without
  // depending on which shows happen to fall inside --window.
  let corpusEntries = 0;
  try { corpusEntries = fs.readdirSync(REVIEW_TEXTS_DIR).length; } catch { corpusEntries = 0; }

  // A redirected root may never produce a PASSING gate verdict, and may never
  // rewrite the baseline (BASELINE_PATH follows ROOT too). The refusal is
  // seated HERE rather than at the top of main() so that an EMPTY redirected
  // corpus still reaches assertCorpusScanned below: that path can only ever
  // FAIL loudly, so allowing it costs nothing and is the only way to test the
  // gate wiring at all. Refusing it earlier made the #1063 vacuous-pass guard
  // untestable from a fixture, which round 4 found had left `gate:` mutable
  // to false with both suites still green.
  if (shouldRefuseRedirectedGate({
    rootOverride: ROOT_OVERRIDE,
    corpusEntries,
    strict: args.strict,
    updateBaseline: args.updateBaseline,
  })) {
    console.error(
      'FAIL: BSC_AUDIT_ROOT is set with a non-empty corpus, so --strict and ' +
        '--update-baseline are refused. A redirected corpus would pass vacuously. ' +
        'Use report-only mode.'
    );
    process.exit(2);
  }

  try {
    assertCorpusScanned(corpusEntries, { gate: args.strict || args.updateBaseline });
  } catch (e) {
    if (!(e instanceof CorpusNotScannedError)) throw e;
    console.error(`\nFAIL: ${e.message}`);
    process.exit(1);
  }

  const showsFile = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
  const shows = Array.isArray(showsFile) ? showsFile : showsFile.shows;
  const cutoff = Date.now() - args.window * 86400000;
  const recentShows = shows.filter((s) => {
    if (!s.openingDate) return false;
    const t = Date.parse(s.openingDate);
    return !Number.isNaN(t) && t >= cutoff;
  });

  // Coverage bookkeeping (BRO-2348). Counted, never inferred:
  // `recentShows.length` is NOT what this sweep examines. A show can be
  // selected by the window and still contribute nothing — no review-texts
  // directory, an unreadable one, or one whose every file fails to parse.
  // Measured on the real corpus 2026-09-07: 132 selected, 72 examined.
  const eligibleShows = shows.filter(
    (s) => s.openingDate && !Number.isNaN(Date.parse(s.openingDate))
  ).length;
  const openedShows = recentShows.filter((s) => Date.parse(s.openingDate) <= Date.now()).length;
  let showsWithTexts = 0;
  let filesParsed = 0;

  const hits = [];
  for (const show of recentShows) {
    const showDir = path.join(REVIEW_TEXTS_DIR, show.id);
    let files;
    try {
      files = fs.readdirSync(showDir).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    // Counted from what the loop ACTUALLY did, never from what it listed.
    // `files.length` would count a corrupt file as parsed, and a show whose
    // directory exists but holds no readable .json (a _pending/-only strand,
    // for instance) would be reported as examined — in the one line whose
    // whole purpose is honest coverage (ship-check findings 1 and 2).
    let parsedThisShow = 0;
    for (const file of files) {
      let data;
      try {
        data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
      } catch {
        continue;
      }
      parsedThisShow++;
      const contradiction = detectCvFlagContradiction(data);
      if (contradiction) {
        hits.push({ showId: show.id, file, ...contradiction });
      }
    }
    filesParsed += parsedThisShow;
    if (parsedThisShow > 0) showsWithTexts++;
  }

  // "shows opened in the last Nd" was false: the window filter is a lower
  // bound only, so 110 of the 132 it selected on 2026-09-07 had not opened.
  console.log(`Flag-vs-CV contradiction sweep: ${recentShows.length} shows in the last ${args.window}d window, ${hits.length} contradiction(s) found.`);
  for (const h of hits) {
    // No cvReasoning in stdout: this repo is public and CV reasoning often
    // embeds verbatim quotes from copyrighted review text (CLAUDE.md §3) —
    // this script runs in CI (public Actions logs), not just locally.
    console.log(`  [${h.flag}] ${h.showId}/${h.file} (${h.wordCount}w)`);
  }

  // Printed before the --update-baseline branch exits and before the --strict
  // verdict, so every path that REACHES the report carries it. (An empty
  // corpus still exits earlier at the assertCorpusScanned guard above, which
  // is a loud failure, not a misreadable clean result.) The misreading this
  // prevents is of a CLEAN run: "(12 baselined, 0 new)" plus exit 0 reads as
  // a healthy corpus when the sweep examined 72 of 2,943 shows (BRO-2348).
  for (const line of summarizeWindowCoverage({
    windowDays: args.window,
    corpusShows: shows.length,
    eligibleShows,
    windowShows: recentShows.length,
    openedShows,
    showsWithTexts,
    filesParsed,
  }).lines) {
    console.log(line);
  }

  // --update-baseline: regenerate the baseline from the current scan and exit
  // (mirrors audit-critic-outlets.js / audit-outlet-registry.js). Logs every
  // added/dropped (showId, file) key explicitly — a --window-scoped rescan
  // can drop a baselined key simply because its show aged out of the window,
  // which looks identical to "someone fixed it" unless it's called out
  // (second-opinion review, task #1673).
  if (args.updateBaseline) {
    const oldHits = loadBaseline().hits || [];
    const oldSet = baselineKeySet(oldHits);
    const newEntries = hits
      .map(h => ({ showId: h.showId, file: h.file, flag: h.flag }))
      .sort((a, b) => (a.showId + a.file).localeCompare(b.showId + b.file));
    const newSet = baselineKeySet(newEntries);
    const added = computeNewViolators(newEntries, oldSet);
    const dropped = oldHits.filter(h => !newSet.has(`${h.showId}::${h.file}`));

    const baseline = { generatedAt: new Date().toISOString().slice(0, 10), hits: newEntries };
    fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
    console.log(`\n✅ Baseline updated: ${baseline.hits.length} known contradiction(s) (${BASELINE_PATH})`);
    if (added.length) {
      console.log(`  +${added.length} added: ${added.map(a => `${a.showId}/${a.file}`).join(', ')}`);
    }
    if (dropped.length) {
      console.log(`  -${dropped.length} dropped (fixed, or aged out of --window=${args.window}d): ${dropped.map(d => `${d.showId}/${d.file}`).join(', ')}`);
    }
    process.exit(0);
  }

  const baselineSet = baselineKeySet(loadBaseline().hits);
  const newViolators = computeNewViolators(hits, baselineSet);

  if (hits.length > 0) {
    console.log(`\n(${hits.length - newViolators.length} baselined, ${newViolators.length} new)`);
  }

  if (args.strict) {
    if (newViolators.length > 0) {
      // No cvReasoning here either — same public-CI-log constraint as above.
      console.log(`\n⚠️  NEW flag-vs-CV contradiction(s), not in the baseline (${BASELINE_PATH}):`);
      for (const v of newViolators) {
        console.log(`  [${v.flag}] ${v.showId}/${v.file}`);
      }
      console.log(`\nInvestigate, or if this is deliberate progress, refresh the baseline:`);
      console.log(`  node scripts/audit-cv-flag-contradiction.js --update-baseline`);
      process.exit(1);
    }
    process.exit(0);
  }
}

main();
