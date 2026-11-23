// BRO-8163 class guard: a hasEnoughReviews / reviewsRemainingForScore call with no 4th (gate) argument ignores the
// standing rule and the per-show overrides, so a short run shows a score on its page and is missing from lists/feeds.
// New callers must pass scoreGateArg(show); a deliberate exception goes in ALLOWED with a reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const ALLOWED: Record<string, string> = {
  'src/lib/data-show-ranks.ts': 'rank pool is "scored shows 2005+", explicit false',
  'scripts/count-pool.ts': 'explicit false, pool count',
  'src/lib/regional-shelf.ts': 'regional markets, rule only covers broadway/west-end/specials (follow-up)',
  'scripts/lib/search-shows-scores.js': 'tour search scores',
  'scripts/wanted-method-check.js': 'coverage-minute diagnostic',
  'src/app/show/[slug]/page.tsx': 'passes isCuratedHistoricalShow, which is scoreGateArg(show)',
  'src/components/show-page/ShowPageBelowFold.tsx': 'passes isCuratedHistoricalShow from the page',
  'src/components/show-cards/ScoreBadge.tsx': 'receives the gate as a prop',
  'scripts/validate-market-expansion.js': 'text check only',
  'scripts/lib/coverage-floor.js': 'comment only',
  'scripts/lib/opening-signal.js': 'comment only / local port',
  'scripts/lib/min-reviews.js': 'definition',
  'src/config/score-buckets.ts': 'definition',
  'src/lib/market-utils.ts': 'comment only',
  'scripts/generate-status-page.js': 'local mirror of the gate with its own signature',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.next' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Top-level argument count of the call whose "(" is at index `open`. */
function argCount(src: string, open: number): number {
  let depth = 0, n = 1, any = false;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return any ? n : 0; }
    else if (c === ',' && depth === 1) { n++; }
    else if (!/\s/.test(c)) any = true;
  }
  return -1;
}

test('every hasEnoughReviews / reviewsRemainingForScore caller passes the gate argument or is allowlisted', () => {
  const bad: string[] = [];
  for (const f of [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'scripts'))]) {
    const rel = path.relative(ROOT, f);
    if (ALLOWED[rel]) continue;
    const src = fs.readFileSync(f, 'utf8');
    const re = /\b(hasEnoughReviews|reviewsRemainingForScore)\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const before = src.slice(Math.max(0, m.index - 12), m.index);
      if (/function\s+$|\.\s*$|\*\s*$|\/\/\s*$/.test(before) || /^\s*(\*|\/\/)/.test(src.slice(src.lastIndexOf('\n', m.index) + 1, m.index))) continue;
      const line = src.slice(src.lastIndexOf('\n', m.index) + 1, src.indexOf('\n', m.index));
      if (/console\.(error|log|warn)|['"`][^'"`]*hasEnoughReviews\(\)/.test(line)) continue;
      const n = argCount(src, m.index + m[0].length - 1);
      if (n < 4) bad.push(`${rel}:${src.slice(0, m.index).split('\n').length} (${n} args)`);
    }
  }
  assert.deepEqual(bad, [], 'pass scoreGateArg(show) as the 4th argument, or add the file to ALLOWED with a reason');
});
