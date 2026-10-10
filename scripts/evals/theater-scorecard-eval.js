#!/usr/bin/env node
/**
 * theater-scorecard-eval.js
 *
 * Offline eval for LLM-generated Theater Scorecard data (venueScores objects
 * in theater-metadata.json). Runs pure validators from
 * scripts/lib/theater-scorecard-validators.js — no API credits burned.
 *
 * Exits 0 on clean, non-zero on hard findings. Warnings are shown but don't
 * fail the eval (use --strict to fail on warnings too).
 *
 * Usage:
 *   node scripts/evals/theater-scorecard-eval.js
 *   node scripts/evals/theater-scorecard-eval.js --json
 *   node scripts/evals/theater-scorecard-eval.js --strict
 *   node scripts/evals/theater-scorecard-eval.js --metadata path/to/theater-metadata.json
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const {
  validateVenueScores,
  detectBoilerplatePhrases,
  checkScoreDistribution,
  SCORE_DIMENSIONS,
} = require('../lib/theater-scorecard-validators');

function parseArgs(argv) {
  const args = { json: false, strict: false, metadata: null };
  const list = argv.slice(2);
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--json')   args.json   = true;
    else if (a === '--strict') args.strict = true;
    else if (a === '--metadata') args.metadata = list[++i] || null;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: theater-scorecard-eval.js [--json] [--strict] [--metadata PATH]');
      process.exit(0);
    }
  }
  return args;
}

function loadTheaters(metadataPath) {
  const raw = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  const out = {};
  for (const [name, v] of Object.entries(raw)) {
    if (name === '_meta') continue;
    if (v && v.venueScores) out[name] = v.venueScores;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  const root = path.join(__dirname, '..', '..');
  const metadataPath = args.metadata || path.join(root, 'data', 'theater-metadata.json');

  if (!fs.existsSync(metadataPath)) {
    console.error(`theater-scorecard-eval: file not found: ${metadataPath}`);
    process.exit(1);
  }

  const theaters = loadTheaters(metadataPath);
  const theaterNames = Object.keys(theaters);

  // ── Per-theater findings ───────────────────────────────────────────────
  const perTheater = [];
  let totalBannedClaims   = 0;
  let totalShowRefs       = 0;
  let totalScoreRange     = 0;
  let totalSummaryLength  = 0;
  let totalConflicts      = 0;

  for (const name of theaterNames) {
    const findings = validateVenueScores(name, theaters[name]);
    if (findings.length > 0) {
      perTheater.push({ name, findings });
      for (const f of findings) {
        if (f.type === 'banned-claim')            totalBannedClaims++;
        else if (f.type === 'show-reference')     totalShowRefs++;
        else if (f.type === 'score-out-of-range' || f.type === 'missing-dimension') totalScoreRange++;
        else if (f.type === 'summary-too-long')   totalSummaryLength++;
        else if (f.type === 'score-summary-conflict') totalConflicts++;
      }
    }
  }

  // ── Cross-theater checks ───────────────────────────────────────────────
  const boilerplate = detectBoilerplatePhrases(theaters);
  const { stats, warnings: distWarnings } = checkScoreDistribution(theaters);

  // ── Hard failures = banned claims + show refs + score range + hard length + conflicts
  const hardFailures = totalBannedClaims + totalShowRefs + totalScoreRange + totalSummaryLength + totalConflicts;
  const softWarnings = boilerplate.length + distWarnings.length;

  // ── Output ────────────────────────────────────────────────────────────
  if (args.json) {
    const result = {
      pass: hardFailures === 0 && (args.strict ? softWarnings === 0 : true),
      theaters: theaterNames.length,
      clean: theaterNames.length - perTheater.length,
      hardFailures,
      softWarnings,
      findings: perTheater,
      boilerplate,
      distributionWarnings: distWarnings,
      distributionStats: stats,
    };
    console.log(JSON.stringify(result, null, 2));
  } else {
    const line = '='.repeat(60);
    console.log(line);
    console.log('Theater Scorecard Eval');
    console.log(line);
    console.log(`Theaters:       ${theaterNames.length}`);
    console.log(`With findings:  ${perTheater.length}`);
    console.log(`Clean:          ${theaterNames.length - perTheater.length}`);
    console.log();
    console.log(`Banned claims:      ${totalBannedClaims}  ← accessibility/safety in LLM summary`);
    console.log(`Show references:    ${totalShowRefs}  ← show-specific language in venue summary`);
    console.log(`Score out-of-range: ${totalScoreRange}  ← dimension not integer 1–5`);
    console.log(`Summary too long:   ${totalSummaryLength}  ← exceeds ${require('../lib/theater-scorecard-validators').SUMMARY_MAX_CHARS} chars`);
    console.log(`Score conflicts:    ${totalConflicts}  ← summary contradicts numeric score`);
    console.log();

    if (perTheater.length > 0) {
      console.log('── Hard Findings ──────────────────────────────────────');
      for (const { name, findings } of perTheater) {
        const hard = findings.filter(f => f.type !== 'summary-long-warning');
        if (hard.length === 0) continue;
        console.log(`\n  ${name}`);
        for (const f of hard) {
          const tag = f.matched ? ` → "${f.matched}"` : '';
          console.log(`    [${f.type}] ${f.field || ''} — ${f.message}${tag}`);
        }
      }

      const warned = perTheater.filter(p => p.findings.some(f => f.type === 'summary-long-warning'));
      if (warned.length > 0) {
        console.log('\n── Length Warnings ────────────────────────────────────');
        for (const { name, findings } of warned) {
          for (const f of findings.filter(f => f.type === 'summary-long-warning')) {
            console.log(`  ${name}: ${f.message}`);
          }
        }
      }
      console.log();
    }

    if (boilerplate.length > 0) {
      console.log('── Boilerplate Warnings ───────────────────────────────');
      for (const b of boilerplate) {
        console.log(`  "${b.phrase}" — ${b.count} theaters: ${b.theaters.join(', ')}`);
      }
      console.log();
    }

    if (distWarnings.length > 0) {
      console.log('── Distribution Warnings ──────────────────────────────');
      for (const w of distWarnings) {
        console.log(`  ${w.message}`);
      }
      console.log();
    }

    console.log('── Score Distribution ─────────────────────────────────');
    for (const dim of SCORE_DIMENSIONS) {
      const s = stats[dim];
      if (!s) continue;
      const dist = Object.entries(s.distribution)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([v, c]) => `${v}:${c}`)
        .join('  ');
      console.log(`  ${dim.padEnd(12)}: ${dist}  (spread=${s.spread})`);
    }
    console.log();

    const exitCode = hardFailures > 0 || (args.strict && softWarnings > 0) ? 1 : 0;
    if (exitCode === 0) {
      console.log('PASS — no hard findings');
    } else {
      console.log(`FAIL — ${hardFailures} hard finding(s)${args.strict && softWarnings > 0 ? `, ${softWarnings} warning(s)` : ''}`);
    }
    process.exit(exitCode);
  }

  const exitCode = hardFailures > 0 || (args.strict && softWarnings > 0) ? 1 : 0;
  process.exit(exitCode);
}

main();
