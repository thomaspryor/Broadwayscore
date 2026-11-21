#!/usr/bin/env node
/*
 * audit-verifier-wiring.js (S3-T5)
 *
 * Static audit: for every sweep function in scripts/sweep-we-aggregators.js
 * that calls an extractor (extractTheatreReviews / extractSectionReviews /
 * extractStageReviews / extractStarRatings), assert that the same function
 * body contains a `verifyPage(...)` call earlier (positionally) in source.
 *
 * Also asserts that scripts/scrape-stagedoor-critics.js routes its SERP
 * discovery results through verifyAggregatorUrl.
 *
 * Exits 0 when every gated extractor has at least one preceding verifier
 * call. Exits 1 with a list of offending call sites when any gap is found.
 * Wire into CI when stable.
 */

const fs = require('fs');
const path = require('path');

const SWEEP_PATH = path.join(__dirname, 'sweep-we-aggregators.js');
const STAGEDOOR_PATH = path.join(__dirname, 'scrape-stagedoor-critics.js');

const EXTRACTORS = [
  'extractTheatreReviews',
  'extractSectionReviews',
  'extractStageReviews',
  'extractStarRatings',
];

const GATE_FNS = ['verifyPage', 'verifyAggregatorUrl'];

function splitFunctions(src) {
  // Walk source, build a list of { name, startLine, endLine }. Brace-counter
  // approach handles nested blocks correctly without depending on a JS parser.
  const lines = src.split('\n');
  const fns = [];
  const headRe = /^(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/;
  let cur = null;
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!cur) {
      const m = line.match(headRe);
      if (m) {
        // Find the first { on this line or later before any other function
        const openIdx = line.indexOf('{');
        if (openIdx !== -1) {
          cur = { name: m[1], startLine: i, body: [line.slice(openIdx + 1)] };
          // Count braces on the head line
          depth = 1;
          for (let k = openIdx + 1; k < line.length; k++) {
            if (line[k] === '{') depth++;
            else if (line[k] === '}') depth--;
          }
          if (depth === 0) {
            cur.endLine = i;
            fns.push(cur);
            cur = null;
          }
        }
      }
      continue;
    }
    // inside a function
    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    cur.body.push(line);
    if (depth <= 0) {
      cur.endLine = i;
      fns.push(cur);
      cur = null;
      depth = 0;
    }
  }
  return fns;
}

function auditSweepFile() {
  const src = fs.readFileSync(SWEEP_PATH, 'utf8');
  const fns = splitFunctions(src);
  const gaps = [];
  let totalSweeps = 0;
  let gatedSweeps = 0;

  for (const fn of fns) {
    if (!fn.name.startsWith('sweep')) continue;
    totalSweeps++;
    // Collect extractor + gate call positions inside this function body.
    const extractorHits = [];
    const gateHits = [];
    for (let i = 0; i < fn.body.length; i++) {
      const line = fn.body[i];
      if (EXTRACTORS.some(e => line.includes(`${e}(`))) {
        extractorHits.push(i);
      }
      if (GATE_FNS.some(g => line.includes(`${g}(`))) {
        gateHits.push(i);
      }
    }
    if (extractorHits.length === 0) {
      gatedSweeps++; // sweep with no extractor calls is vacuously gated
      continue;
    }
    const firstGate = gateHits.length > 0 ? gateHits[0] : Infinity;
    const ungatedExtractors = extractorHits.filter(eh => eh < firstGate);
    if (ungatedExtractors.length > 0) {
      gaps.push({
        function: fn.name,
        firstUngatedExtractorLine: fn.startLine + 1 + ungatedExtractors[0],
        totalExtractorCalls: extractorHits.length,
        totalGateCalls: gateHits.length,
      });
    } else {
      gatedSweeps++;
    }
  }
  return { totalSweeps, gatedSweeps, gaps };
}

function auditStagedoorFile() {
  const src = fs.readFileSync(STAGEDOOR_PATH, 'utf8');
  const hasGate = src.includes('verifyAggregatorUrl(') &&
    src.includes("require('./lib/show-match-verifier')");
  return { gated: hasGate };
}

const sweepReport = auditSweepFile();
const sdReport = auditStagedoorFile();

console.log('=== Verifier-wiring audit ===');
console.log(`sweep-we-aggregators.js: ${sweepReport.gatedSweeps}/${sweepReport.totalSweeps} sweep functions verifier-gated`);
console.log(`scrape-stagedoor-critics.js: ${sdReport.gated ? 'verifier-gated' : 'NO VERIFIER WIRING'}`);

if (sweepReport.gaps.length > 0) {
  console.error('\nGaps:');
  for (const g of sweepReport.gaps) {
    console.error(`  [${g.function}] extractor at line ${g.firstUngatedExtractorLine} has no preceding verifyPage/verifyAggregatorUrl call (${g.totalGateCalls} gates total in function)`);
  }
}

const ok = sweepReport.gaps.length === 0 && sdReport.gated;
if (!ok) {
  console.error('\nverifier-gated: FAIL');
  process.exit(1);
}
console.log(`verifier-gated: ${sweepReport.gatedSweeps}/${sweepReport.totalSweeps} sweep functions + scrape-stagedoor-critics`);
process.exit(0);
