/**
 * Distribution audit for the Award Score display formula.
 * Computes raw points across every show and compares display formulas:
 *  - current: 40 * log10(1 + raw/4), then hard-cap at 100
 *  - uncapped: same, no cap (what would the top end actually look like?)
 *  - asymptotic A: 100 * (1 - exp(-raw / 350))
 *  - asymptotic B: 100 * (1 - exp(-raw / 450))
 *
 * Run: npx tsx scripts/audit-award-score-curves.ts
 */

import awardsData from '../data/awards.json';
import { computeSiteAwardScore } from '../src/lib/awards-scoring';

const shows = (awardsData as { shows: Record<string, unknown> }).shows;

const raws: Array<{ id: string; raw: number }> = [];
for (const id of Object.keys(shows)) {
  const r = computeSiteAwardScore(id, 'broadway');
  if (r.rawPoints > 0) raws.push({ id, raw: r.rawPoints });
}
raws.sort((a, b) => b.raw - a.raw);

function logFormula(raw: number): number {
  return 40 * Math.log10(1 + raw / 4);
}
function asymptoticA(raw: number): number {
  return 100 * (1 - Math.exp(-raw / 350));
}
function asymptoticB(raw: number): number {
  return 100 * (1 - Math.exp(-raw / 450));
}

function fmt(n: number, w: number) { return Math.round(n).toString().padStart(w); }

console.log('Top 25 shows by raw points — formula comparison\n');
console.log('rank  raw    log+cap  log-raw  asympt-A  asympt-B   show');
console.log('────  ─────  ───────  ───────  ────────  ────────  ─────────────────────────────');
for (let i = 0; i < Math.min(25, raws.length); i++) {
  const { id, raw } = raws[i];
  const logUnc = logFormula(raw);
  const logCap = Math.min(100, logUnc);
  const aA = asymptoticA(raw);
  const aB = asymptoticB(raw);
  console.log(
    `${(i+1).toString().padStart(3)}.  ${fmt(raw, 5)}   ${fmt(logCap, 3)}      ${fmt(logUnc, 3)}      ${fmt(aA, 3)}       ${fmt(aB, 3)}     ${id}`
  );
}

console.log('\nDistribution at sweeper cutoffs (raw points required):');
for (const target of [50, 70, 85, 95, 100]) {
  // Solve 40*log10(1 + raw/4) = target → raw = 4 * (10^(target/40) - 1)
  const logRaw = 4 * (Math.pow(10, target / 40) - 1);
  // Solve 100*(1 - e^(-raw/350)) = target → raw = -350 * ln(1 - target/100)
  const aARaw = target < 100 ? -350 * Math.log(1 - target / 100) : Infinity;
  const aBRaw = target < 100 ? -450 * Math.log(1 - target / 100) : Infinity;
  console.log(`  display=${target} needs:  log=${Math.round(logRaw)}pts  asympt-A=${aARaw === Infinity ? '∞' : Math.round(aARaw)}pts  asympt-B=${aBRaw === Infinity ? '∞' : Math.round(aBRaw)}pts`);
}

console.log('\nShows that get clamped by hard cap (raw > 1010, current top 5):');
let clampedCount = 0;
for (const r of raws) {
  if (logFormula(r.raw) > 100.5) {
    if (clampedCount < 5) console.log(`  ${r.id}: log=${logFormula(r.raw).toFixed(1)} → capped to 100`);
    clampedCount++;
  }
}
console.log(`  total clamped: ${clampedCount}`);
