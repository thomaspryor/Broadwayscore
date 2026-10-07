#!/usr/bin/env node
/**
 * Verifies public/brand-tokens.json and tailwind.config.ts stay in sync.
 * Fails (exit 1) if any tracked color value drifts between the two files.
 *
 * Both files are canonical inputs to downstream consumers:
 *   - tailwind.config.ts feeds the running site
 *   - public/brand-tokens.json feeds Claude Design, Figma, Canva, email
 *     templates, and the brand kit. They MUST agree.
 *
 * To add a new tracked color, append to MAPPINGS below.
 */
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const TOKENS_PATH = path.join(REPO_ROOT, 'public', 'brand-tokens.json');
const TW_PATH = path.join(REPO_ROOT, 'tailwind.config.ts');

const tokens = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
const twSrc = fs.readFileSync(TW_PATH, 'utf8');

function getSection(src, name) {
  const idx = src.indexOf(name + ': {');
  if (idx === -1) return null;
  let depth = 0;
  let start = -1;
  for (let i = idx; i < src.length; i++) {
    if (src[i] === '{') {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.substring(start, i);
    }
  }
  return null;
}

function getValue(section, key) {
  if (!section) return null;
  const escaped = key.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const re = new RegExp(`['"]?${escaped}['"]?\\s*:\\s*['"]([^'"]+)['"]`);
  const m = section.match(re);
  return m ? m[1] : null;
}

const brand = getSection(twSrc, 'brand');
const surface = getSection(twSrc, 'surface');
const score = getSection(twSrc, 'score');
const status = getSection(twSrc, 'status');

const checks = [
  ['brand gold',                     getValue(brand,   'DEFAULT'),  tokens.brand.gold],
  ['brand gold-hover',               getValue(brand,   'hover'),    tokens.brand.goldHover],
  ['brand gold-light',               getValue(brand,   'light'),    tokens.brand.goldLight],
  ['surface default',                getValue(surface, 'DEFAULT'),  tokens.surface.default],
  ['surface raised',                 getValue(surface, 'raised'),   tokens.surface.raised],
  ['surface overlay',                getValue(surface, 'overlay'),  tokens.surface.overlay],
  ['surface elevated',               getValue(surface, 'elevated'), tokens.surface.elevated],
  ['score must-see (Critical Gold)', getValue(score,   'must-see'), tokens.scores.mustSee.solid],
  ['score great (Recommended)',      getValue(score,   'great'),    tokens.scores.great.solid],
  ['score good (Worth Seeing)',      getValue(score,   'good'),     tokens.scores.good.solid],
  ['score tepid (Skippable)',        getValue(score,   'tepid'),    tokens.scores.tepid.solid],
  ['score skip (Critical Miss)',     getValue(score,   'skip'),     tokens.scores.skip.solid],
  ['score none (Pending)',           getValue(score,   'none'),     tokens.scores.pending.solid],
  ['status open',                    getValue(status,  'open'),     tokens.status.open],
  ['status closed',                  getValue(status,  'closed'),   tokens.status.closed],
  ['status previews',                getValue(status,  'previews'), tokens.status.previews],
];

const missing = [];
const failures = [];

for (const [label, twValue, jsonValue] of checks) {
  if (twValue == null) {
    missing.push(`  ${label}: not found in tailwind.config.ts`);
    continue;
  }
  if (jsonValue == null) {
    missing.push(`  ${label}: not found in brand-tokens.json`);
    continue;
  }
  if (twValue.toLowerCase() !== jsonValue.toLowerCase()) {
    failures.push(`  ${label}: tailwind=${twValue}  brand-tokens=${jsonValue}`);
  }
}

if (missing.length || failures.length) {
  console.error('Brand token sync check FAILED.\n');
  if (missing.length) {
    console.error('Missing values (the extractor could not find these — either the file structure changed or the key was renamed):');
    console.error(missing.join('\n') + '\n');
  }
  if (failures.length) {
    console.error('Mismatched values:');
    console.error(failures.join('\n') + '\n');
  }
  console.error('Fix: update tailwind.config.ts AND public/brand-tokens.json so both files agree.');
  console.error('Both files are canonical — they must stay in lockstep.');
  process.exit(1);
}

console.log(`Brand token sync check PASSED — ${checks.length} values match across tailwind.config.ts and brand-tokens.json.`);
