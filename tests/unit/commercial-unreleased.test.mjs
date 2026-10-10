/**
 * The commercial scorecard (capitalization, recoupment, Hit/Flop designations)
 * is unreleased on prod (owner, 2026-10-04). Prod builds run with the
 * `commercial` flag off; demo builds turn every flag on.
 *
 * Before this guard, hiding the section was not enough: the show page handed
 * commercial data to a client component (so it sat in every Broadway show
 * page's RSC payload), /browse/biggest-broadway-flops was public, and llms.txt
 * and the sitemap advertised /biz. These tests fail if a page starts loading
 * commercial data without the flag, or a browse page built on it ships ungated.
 * They read source, so they cannot see every indirection; the post-deploy smoke
 * test 'commercial scorecard stays unreleased' checks what the live site serves.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Prod's flag state: commercial off. feature-flags.ts reads this at import time.
process.env.NEXT_PUBLIC_FEATURES = '';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { featureFlags } = await import('../../src/config/feature-flags.ts');
const { BROWSE_PAGES, getAllBrowseSlugs, getBrowsePageConfig } = await import('../../src/config/browse-pages.ts');

test('commercial flag is off when NEXT_PUBLIC_FEATURES does not list it', () => {
  assert.equal(featureFlags.commercial, false);
});

test('every browse page that reads commercial data requires the commercial flag', () => {
  const offenders = Object.values(BROWSE_PAGES)
    .filter((cfg) => [cfg.filter, cfg.dataFilter, cfg.customSort, cfg.sectionGroup]
      .some((fn) => typeof fn === 'function' && /getShowCommercial/.test(fn.toString())))
    .filter((cfg) => cfg.requiresFeature !== 'commercial')
    .map((cfg) => cfg.slug);
  assert.deepEqual(offenders, [], `add requiresFeature: 'commercial' to: ${offenders.join(', ')}`);
});

test('commercial browse pages do not exist while the flag is off', () => {
  const gated = Object.values(BROWSE_PAGES).filter((cfg) => cfg.requiresFeature === 'commercial');
  assert.ok(gated.some((cfg) => cfg.slug === 'biggest-broadway-flops'), 'expected the flops page to be gated');
  const slugs = new Set(getAllBrowseSlugs());
  for (const cfg of gated) {
    assert.equal(slugs.has(cfg.slug), false, `${cfg.slug} is still in getAllBrowseSlugs()`);
    assert.equal(getBrowsePageConfig(cfg.slug), undefined, `${cfg.slug} still resolves in getBrowsePageConfig()`);
  }
  assert.ok(getBrowsePageConfig('best-broadway-musicals-all-time') || getAllBrowseSlugs().length > 50,
    'ungated browse pages must still resolve');
});

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

// Server-side readers of commercial.json that never emit commercial figures.
// Anything else importing it must go through data-commercial's loaders.
const COMMERCIAL_JSON_READERS = new Set([
  'src/lib/data-commercial.ts',
  'src/lib/data-tony-predictions.ts', // only drops "Tour Stop" shows from Tony eligibility
]);

test('pages only load commercial data behind featureFlags.commercial', () => {
  const src = readFileSync(path.join(ROOT, 'src/lib/data-commercial.ts'), 'utf8');
  // getSeason is a date helper, not commercial data.
  const dataFns = [...src.matchAll(/^export (?:async )?(?:function|const) (\w+)/gm)]
    .map((m) => m[1]).filter((n) => n !== 'getSeason');
  assert.ok(dataFns.includes('getShowCommercial'), 'data-commercial exports not found; update this guard');
  const offenders = [];
  // src/lib too: a helper there that loads commercial data and is called from a
  // page would otherwise slip past a scan of the page alone.
  const files = ['src/app', 'src/components', 'src/lib'].flatMap((d) => walk(path.join(ROOT, d)));
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    if (rel === 'src/lib/data-commercial.ts') continue;
    const text = readFileSync(file, 'utf8');
    if (/commercial\.json['"]/.test(text) && !COMMERCIAL_JSON_READERS.has(rel)) {
      offenders.push(`${rel}: imports commercial.json directly`);
    }
    // Follow renamed imports (`getShowCommercial as gsc`) as well as the real names.
    const names = new Set(dataFns);
    for (const m of text.matchAll(/\b(\w+)\s+as\s+(\w+)/g)) if (names.has(m[1])) names.add(m[2]);
    const call = new RegExp(`\\b(${[...names].join('|')})\\s*\\(`);
    if (!call.test(text)) continue;
    // A route that 404s while the flag is off may load whatever it likes.
    if (/if \(!featureFlags\.commercial\) notFound\(\);/.test(text)) continue;
    text.split('\n').forEach((line, i) => {
      if (call.test(line) && !/^\s*(\/\/|\*|import\b)/.test(line) && !line.includes('featureFlags.commercial')) {
        offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `gate these on featureFlags.commercial:\n${offenders.join('\n')}`);
});

// BRO-5007: Box Office Scorecard v2 is not public yet (owner, 2026-10-10).
const { PROD_HELD_FEATURES } = await import('../../src/config/feature-flags.ts');
const { computeDemoFlags } = await import('../../scripts/lib/demo-feature-flags.js');

test('boxOfficeV2 is off without the env var and held back from production', () => {
  assert.equal(featureFlags.boxOfficeV2, false);
  assert.ok(PROD_HELD_FEATURES.has('boxOfficeV2'), 'boxOfficeV2 must stay in PROD_HELD_FEATURES until released');
  assert.ok(PROD_HELD_FEATURES.has('commercial'));
});

test('the public demo build leaves prod-held flags off (boxOfficeV2 included)', () => {
  const src = readFileSync(path.join(ROOT, 'src/config/feature-flags.ts'), 'utf8');
  const flags = computeDemoFlags(src);
  assert.ok(flags.length > 5, 'demo flag list unexpectedly short');
  assert.ok(!flags.includes('boxOfficeV2'), 'boxOfficeV2 must not be enabled on demo.broadwayscorecard.com');
  // commercial's demo behavior is pending an owner decision: unchanged (allowlisted).
  assert.ok(flags.includes('commercial'), 'commercial stays on demo until the owner decides');
  const wf = readFileSync(path.join(ROOT, '.github/workflows/vercel-demo.yml'), 'utf8');
  const codeLines = wf.split('\n').filter((l) => !/^\s*#/.test(l));
  assert.ok(codeLines.some((l) => /node\s+scripts\/lib\/demo-feature-flags\.js/.test(l)),
    'vercel-demo.yml must compute its flags by running scripts/lib/demo-feature-flags.js');
  assert.ok(!codeLines.some((l) => l.includes('matchAll(/get')),
    'vercel-demo.yml must not extract flags inline (that path enables prod-held flags)');
});

test('v2 box-office data is computed only behind commercial AND boxOfficeV2', () => {
  const v2Fns = ['getShowBoxOfficeV2', 'getRunningBoxOfficeV2', 'getBoxOfficeV2Listing', 'getBoxOfficeV2Market'];
  const call = new RegExp(`\\b(${v2Fns.join('|')})\\s*\\(`);
  const offenders = [];
  for (const file of ['src/app', 'src/components', 'src/lib'].flatMap((d) => walk(path.join(ROOT, d)))) {
    const rel = path.relative(ROOT, file);
    if (rel === 'src/lib/data-commercial.ts') continue;
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (call.test(line) && !/^\s*(\/\/|\*|import\b)/.test(line)
        && !(line.includes('featureFlags.commercial') && line.includes('featureFlags.boxOfficeV2'))) {
        offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `gate these on featureFlags.commercial && featureFlags.boxOfficeV2:\n${offenders.join('\n')}`);
});

test('the v2 card is lazy-loaded, so its code stays out of every show page bundle', () => {
  // A static import puts the held feature's copy into the below-fold chunk
  // that every show page downloads, flag or no flag (BRO-5007 leak test).
  const staticImport = /^\s*import\s+(?!type\b)[^;]*['"]@\/components\/(BoxOfficeScorecardV2|BoxOfficeV2Tables)['"]/;
  const offenders = [];
  for (const file of ['src/app', 'src/components', 'src/lib'].flatMap((d) => walk(path.join(ROOT, d)))) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (staticImport.test(line)) offenders.push(`${path.relative(ROOT, file)}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], `load BoxOfficeScorecardV2 and BoxOfficeV2Tables with next/dynamic:\n${offenders.join('\n')}`);
});

test('the held components are dynamic() from client modules only', () => {
  // dynamic() in a server component still bundles the module into that page's
  // chunk (the flag-off /box-office build shipped "Vs. its cost" this way).
  const lazyImport = /dynamic\(\s*\(\)\s*=>\s*import\(\s*['"]@\/components\/(BoxOfficeScorecardV2|BoxOfficeV2Tables)['"]/;
  const offenders = [];
  let found = 0;
  for (const file of ['src/app', 'src/components', 'src/lib'].flatMap((d) => walk(path.join(ROOT, d)))) {
    const src = readFileSync(file, 'utf8');
    if (!lazyImport.test(src)) continue;
    found++;
    if (!/^\s*['"]use client['"]/.test(src)) offenders.push(path.relative(ROOT, file));
  }
  assert.ok(found >= 2, 'expected the card and the tables to be lazy-loaded somewhere');
  assert.deepEqual(offenders, [], `move these dynamic() calls into a 'use client' module:\n${offenders.join('\n')}`);
});
