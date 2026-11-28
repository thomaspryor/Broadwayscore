/**
 * Guard: the critic-score tier rules live in ONE place, scripts/lib/score-tiers.js.
 *
 * Copies of the tier ladder kept drifting from the site badge: the app feed,
 * the social cards, the review OG images, the newsletter and the brand tokens
 * each had their own `score >= 83` → "Critical Gold" chain, most without the
 * West End 85 Gold threshold, and several still said "Skippable" where the
 * site says "Mixed". This test scans every code file in scripts/ and src/ and
 * fails when:
 *
 *   1. a line states the Gold threshold literal 83 within two code lines of a
 *      tier label/key (Critical Gold, gold, mustSee, must-see, goldThreshold…).
 *      Use getGoldThreshold / getScoreTierId / getScoreTierLabel or the
 *      DEFAULT_GOLD_THRESHOLD constant from score-tiers.js instead.
 *   2. code (not a comment) contains the word "Skippable". The site label for
 *      55-64 is "Mixed" (SCORE_TIER_LABELS.skippable). The lowercase bucket id
 *      'skippable' is fine; this check is case-sensitive.
 *
 * Comments are ignored. Test files are ignored (they pin literals on purpose).
 * The lists below are the deliberate exceptions. GOLD_83_BASELINE is a ratchet:
 * a file may not gain a copy, and when you remove one, lower its count (or
 * delete the entry) so the baseline cannot hide a new copy later.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE_OF_TRUTH = 'scripts/lib/score-tiers.js';
const CODE_EXT = /\.(?:c|m)?[jt]sx?$/;
const SKIP_DIRS = new Set(['node_modules', '.next', 'out', 'dist', 'build', '.turbo']);

// "Skippable" is the DATA label for 55-64 (fantasy points keys). These files
// own that contract; score-tier-label-contract.test.mjs pins them.
const SKIPPABLE_ALLOW = {
  'src/config/scoring.ts': 'DATA label: getCriticLabel feeds engine.ts and the fantasy points map',
  'scripts/lib/fantasy-helpers.js': 'DATA label: criticLabelForScore keys the fantasy points map',
  'scripts/lib/fantasy-pricing.js': 'DATA label keys of the fantasy price priors; notes are internal (priceNoteFor)',
  'src/app/dev/catalog/catalog-data.mjs': 'dev-only catalog page (notFound() in production)',
};

// Display copy that still spells out the Broadway Gold threshold next to its
// label. Each is prose or a static string, not a tier decision; deriving them
// is a UI change that needs a visual-QA pass. Counts are hits (lines), not files.
const GOLD_83_BASELINE = {
  'src/app/brand/BrandPageClient.tsx': { count: 4, why: 'brand guide swatches, prose and sample-badge helper (Broadway ranges)' },
  'src/app/methodology/page.tsx': { count: 2, why: 'methodology prose and tier legend' },
  'src/app/west-end/methodology/page.tsx': { count: 2, why: 'prose comparing WE 85 to Broadway 83' },
  'src/components/HomepageExplainerShelf.tsx': { count: 1, why: 'homepage explainer legend "83+ Critical Gold"' },
};

function walk(dir, out) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name) && !ent.name.startsWith('.')) walk(join(dir, ent.name), out);
    } else if (CODE_EXT.test(ent.name)) {
      out.push(join(dir, ent.name));
    }
  }
  return out;
}

const isTestFile = rel =>
  /\.test\.[cm]?[jt]sx?$/.test(rel) || rel.startsWith('scripts/tests/') || rel.includes('/__tests__/');

/**
 * Code with comments blanked out, one entry per source line (line numbers preserved).
 * Comment markers inside '…' and "…" strings are code, so a glob like
 * 'src/**\/*.ts' does not blank the rest of the file. Template literals are
 * not tracked (a stray backtick in JSX text would hide every later comment).
 */
export function codeLines(src) {
  let inBlock = false;
  return src.split('\n').map(line => {
    let out = '';
    let quote = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      const prev = i ? line[i - 1] : '';
      if (inBlock) {
        if (c === '*' && line[i + 1] === '/') { inBlock = false; i++; }
        continue;
      }
      if (quote) {
        out += c;
        if (c === '\\') out += line[++i] ?? '';
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '/' && line[i + 1] === '*') { inBlock = true; i++; continue; }
      // `//` starts a comment only at line start or after whitespace/punctuation,
      // so URLs in JSX text ("https://…") survive.
      if (c === '/' && line[i + 1] === '/' && (i === 0 || /[\s;,(){}[\]]/.test(prev))) break;
      // An apostrophe between letters is JSX text ("Don't"), not a string.
      if ((c === "'" || c === '"') && !(c === "'" && /\w/.test(prev) && /\w/.test(line[i + 1] || ''))) quote = c;
      out += c;
    }
    return out;
  });
}

const GOLD_LITERAL = /(?<![\w.$])83(?![\w.])/;
// Tier labels/keys. "must-see" counts only as the bucket id ('must-see',
// score-must-see) or the mustSee key: LLM review prompts use the English
// phrase "must-see" for review-level Rave bands, which are not show tiers.
const TIER_TOKEN = /critical[ _-]?gold|\bmustSee\b|'must-see'|score-must-see|\bgold\b|goldThreshold|goldMin|GOLD_THRESHOLD/i;

/** Line numbers (1-based) where 83 sits within two code lines of a tier label. */
export function goldLiteralHits(src) {
  const code = codeLines(src);
  const hits = [];
  code.forEach((line, i) => {
    if (!GOLD_LITERAL.test(line)) return;
    const window = code.slice(Math.max(0, i - 2), i + 3).join('\n');
    if (TIER_TOKEN.test(window)) hits.push(i + 1);
  });
  return hits;
}

/** Line numbers (1-based) where code says "Skippable". */
export function skippableHits(src) {
  const hits = [];
  codeLines(src).forEach((line, i) => { if (/\bSkippable\b/.test(line)) hits.push(i + 1); });
  return hits;
}

const files = [...walk(join(ROOT, 'scripts'), []), ...walk(join(ROOT, 'src'), [])]
  .map(abs => ({ abs, rel: relative(ROOT, abs).split(sep).join('/') }))
  .filter(f => f.rel !== SOURCE_OF_TRUTH && !isTestFile(f.rel));

test('detectors: comments ignored, code caught', () => {
  assert.deepEqual(goldLiteralHits("// score >= 83 is Critical Gold\nconst x = 1;"), []);
  assert.deepEqual(goldLiteralHits("/* gold\n 83 */ const y = 2;"), []);
  assert.deepEqual(goldLiteralHits("if (s >= 83) return 'Critical Gold';"), [1]);
  assert.deepEqual(goldLiteralHits("const goldThreshold = isWE ? 85 : 83;"), [1]);
  assert.deepEqual(goldLiteralHits("export const SCORE_TIER_CRITICAL_GOLD = inScoreRange(83, 100);"), [1]);
  assert.deepEqual(goldLiteralHits("mustSee: {\n  label: 'Critical Gold',\n  range: '83-100',"), [3]);
  assert.deepEqual(goldLiteralHits("if (score >= 83) return { grade: 'A-' };"), [], 'audience grade A- is not a tier label');
  assert.deepEqual(goldLiteralHits("const exact = 83.23; // gold"), [], '83.23 is not the literal 83');
  assert.deepEqual(skippableHits("// Skippable for closed shows\nlabel: 'Mixed'"), []);
  assert.deepEqual(skippableHits("{ id: 'skippable', label: 'Mixed' }"), []);
  assert.deepEqual(skippableHits("if (s >= 55) return 'Skippable';"), [1]);
  assert.deepEqual(skippableHits("const u = 'https://x.com/Skippable';"), [1], 'a URL is not a comment');
  assert.deepEqual(goldLiteralHits("const g = 'src/**/*.ts'; if (s >= 83) return 'Critical Gold';"), [1], '/* inside a string is not a comment');
  assert.deepEqual(goldLiteralHits("const g = \"a//b\"; if (s >= 83) return 'Critical Gold';"), [1], '// inside a string is not a comment');
  assert.deepEqual(goldLiteralHits("<p>Don't miss</p> // gold 83"), [], 'a JSX apostrophe does not swallow the comment');
  assert.deepEqual(goldLiteralHits("const q = 'it\\'s'; /* gold 83 */"), [], 'escaped quote inside a string');
});

test(`no hard-coded Gold threshold 83 next to a tier label outside ${SOURCE_OF_TRUTH}`, () => {
  assert.ok(files.length > 500, `scanned only ${files.length} files — walk is broken`);
  const problems = [];
  const seen = {};
  for (const { abs, rel } of files) {
    const hits = goldLiteralHits(readFileSync(abs, 'utf8'));
    if (!hits.length) continue;
    seen[rel] = hits.length;
    const base = GOLD_83_BASELINE[rel];
    if (!base) problems.push(`${rel}:${hits.join(',')} hard-codes Gold 83 next to a tier label; use score-tiers.js (getGoldThreshold / getScoreTierId / getScoreTierLabel / DEFAULT_GOLD_THRESHOLD)`);
    else if (hits.length > base.count) problems.push(`${rel}:${hits.join(',')} has ${hits.length} Gold-83 copies, baseline allows ${base.count}; derive the new one from score-tiers.js`);
  }
  for (const [rel, base] of Object.entries(GOLD_83_BASELINE)) {
    const n = seen[rel] || 0;
    if (n < base.count) problems.push(`${rel} now has ${n} Gold-83 copies (baseline ${base.count}); lower GOLD_83_BASELINE so it cannot hide a new one`);
  }
  assert.deepEqual(problems, []);
});

test('no user-visible "Skippable" (the 55-64 display label is "Mixed")', () => {
  const problems = [];
  for (const { abs, rel } of files) {
    if (SKIPPABLE_ALLOW[rel]) continue;
    const hits = skippableHits(readFileSync(abs, 'utf8'));
    if (hits.length) problems.push(`${rel}:${hits.join(',')} says "Skippable"; use SCORE_TIER_LABELS.skippable ("Mixed") from score-tiers.js`);
  }
  assert.deepEqual(problems, []);
});

test('allowlisted files still exist and still need their exception', () => {
  for (const rel of Object.keys(SKIPPABLE_ALLOW)) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    assert.ok(skippableHits(src).length > 0, `${rel} no longer says "Skippable"; remove it from SKIPPABLE_ALLOW`);
  }
});
