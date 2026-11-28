/**
 * Guard (BRO-8451): the Critic Score tier functions take a TIER MARKET, not a raw show category.
 * An Australian regional show has category 'regional' (same as a US tryout) but needs Gold 85, so
 * every call site that has a show must pass getTierMarket(show). A call like
 * getScoreTier(score, show.category) silently gives an AU show the US cutoff (83).
 *
 * Fails when a code file calls a tier function with an argument that ends `.category` (or
 * `?.category`). The listed files are deliberate exceptions: their objects carry no venue, so
 * AU cannot be told apart there. A file may not gain a copy; shrink the list when you fix one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CODE_EXT = /\.(?:c|m)?[jt]sx?$/;
const SKIP_DIRS = new Set(['node_modules', '.next', 'out', 'dist', 'build', '.turbo']);
const TIER_FNS = ['getGoldThreshold', 'getScoreTierId', 'getScoreTierLabel', 'getBreakdownTierId', 'getReviewBreakdownTierId',
  'isCriticalGold', 'getScoreBucket', 'getScoreTier', 'getScoreColorClass', 'getScoreTextColorClass', 'getScoreTierRange'];
const CALL = new RegExp(`\\b(?:${TIER_FNS.join('|')})\\(([^()]*(?:\\([^()]*\\)[^()]*)*)\\)`, 'g');

// Paths are joined from parts so the CI-coverage audit does not read this guard as "naming" these sources.
const ALLOWED = {
  [['scripts', 'video-proto', 'render.js'].join('/')]: 'prototype video renderer: its show objects carry no venue',
  [['scripts', 'video-proto', 'showdata.js'].join('/')]: 'prototype video renderer: its show objects carry no venue',
  [['scripts', 'generate-review-og-images.js'].join('/')]: 'review frontmatter has a category string only, no venue',
};

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (CODE_EXT.test(e.name) && !/\.test\.[cm]?[jt]sx?$/.test(e.name)) out.push(p);
  }
  return out;
}

test('no tier-function call passes a raw show.category (use getTierMarket(show))', () => {
  const bad = [];
  for (const abs of [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'scripts'))]) {
    const rel = relative(ROOT, abs).split(sep).join('/');
    if (rel === 'scripts/lib/score-tiers.js' || ALLOWED[rel]) continue;
    const text = readFileSync(abs, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    for (const m of text.matchAll(CALL)) {
      const args = m[1];
      if (/\w\??\.category\b/.test(args) && !/getTierMarket/.test(args)) bad.push(`${rel}: ${m[0].slice(0, 90)}`);
    }
  }
  assert.deepEqual(bad, [], `pass getTierMarket(show) instead of show.category:\n${bad.join('\n')}`);
});
