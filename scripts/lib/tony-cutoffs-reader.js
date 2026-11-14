/**
 * Read the Tony eligibility windows from src/lib/tony-cutoffs.ts (the single
 * source of truth) for Node scripts that cannot import TypeScript. Parses the
 * TONY_CUTOFFS records' ceremonyYear/label/start/end; fails loudly if the
 * file's shape changes so a caller never silently gets no windows.
 *
 * Why: generate-fantasy-config.js measured past seasons by shifting the
 * current (provisional) window back N years, which dropped opening-day
 * shows like The Lost Boys (2026-04-26) from every window (BRO-5667).
 */
const fs = require('fs');
const path = require('path');

const CUTOFFS_PATH = path.join(__dirname, '..', '..', 'src', 'lib', 'tony-cutoffs.ts');
const RECORD_RE = /ceremonyYear:\s*(\d{4}),\s*label:\s*'(\d{4}-\d{2})',\s*start:\s*'(\d{4}-\d{2}-\d{2})',\s*end:\s*'(\d{4}-\d{2}-\d{2})'/g;

function parseTonyCutoffs(src) {
  const out = [];
  for (const m of src.matchAll(RECORD_RE)) {
    out.push({ ceremonyYear: Number(m[1]), label: m[2], start: m[3], end: m[4] });
  }
  if (out.length === 0) throw new Error('tony-cutoffs-reader: no TONY_CUTOFFS records parsed; did tony-cutoffs.ts change shape?');
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

function readTonyCutoffs(file = CUTOFFS_PATH) {
  return parseTonyCutoffs(fs.readFileSync(file, 'utf8'));
}

/** The `n` seasons before `label`, most recent first. Throws if any is missing. */
function seasonsBefore(label, n, cutoffs = readTonyCutoffs()) {
  const i = cutoffs.findIndex(c => c.label === label);
  if (i < n) throw new Error(`tony-cutoffs-reader: need ${n} seasons before ${label}, found ${Math.max(i, 0)}`);
  return cutoffs.slice(i - n, i).reverse();
}

module.exports = { parseTonyCutoffs, readTonyCutoffs, seasonsBefore };
