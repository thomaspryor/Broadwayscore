/**
 * The Profitability Scorecard (capitalization, recoupment, Hit/Flop designations, /biz)
 * was released on prod 2026-10-26 (BRO-6192), the way the site releases
 * features: the `commercial` getter returns true and the name left
 * PROD_HELD_FEATURES. These tests pin that released state, so a prod build
 * (which no longer lists `commercial` in NEXT_PUBLIC_FEATURES) still ships /biz,
 * its browse pages, sitemap entries and llms.txt line. The post-deploy smoke
 * test 'Profitability Scorecard is live' checks what the live site serves.
 *
 * Box Office Scorecard v2 (boxOfficeV2) is still held: the guards below keep
 * its data and components behind commercial AND boxOfficeV2.
 *
 * File name kept from the unreleased era so references to it stay valid.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Prod's flag state after the release: commercial is not listed in the env.
// feature-flags.ts reads this at import time.
process.env.NEXT_PUBLIC_FEATURES = '';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { featureFlags, PROD_HELD_FEATURES } = await import('../../src/config/feature-flags.ts');
const { BROWSE_PAGES, getAllBrowseSlugs, getBrowsePageConfig } = await import('../../src/config/browse-pages.ts');

test('commercial is released: on without NEXT_PUBLIC_FEATURES and not prod-held', () => {
  assert.equal(featureFlags.commercial, true);
  assert.equal(PROD_HELD_FEATURES.has('commercial'), false);
  const src = readFileSync(path.join(ROOT, 'src/config/feature-flags.ts'), 'utf8');
  assert.match(src, /get commercial\(\) \{ return true; \}/, 'commercial getter must return true (launched)');
});

test('every browse page that reads commercial data is tagged with the commercial flag', () => {
  // Keeps the kill switch working: turning the getter off must drop these pages.
  const offenders = Object.values(BROWSE_PAGES)
    .filter((cfg) => [cfg.filter, cfg.dataFilter, cfg.customSort, cfg.sectionGroup]
      .some((fn) => typeof fn === 'function' && /getShowCommercial/.test(fn.toString())))
    .filter((cfg) => cfg.requiresFeature !== 'commercial')
    .map((cfg) => cfg.slug);
  assert.deepEqual(offenders, [], `add requiresFeature: 'commercial' to: ${offenders.join(', ')}`);
});

test('commercial browse pages exist on a prod build', () => {
  const gated = Object.values(BROWSE_PAGES).filter((cfg) => cfg.requiresFeature === 'commercial');
  assert.ok(gated.some((cfg) => cfg.slug === 'biggest-broadway-flops'), 'expected the flops page to be tagged');
  const slugs = new Set(getAllBrowseSlugs());
  for (const cfg of gated) {
    assert.ok(slugs.has(cfg.slug), `${cfg.slug} is missing from getAllBrowseSlugs()`);
    assert.ok(getBrowsePageConfig(cfg.slug), `${cfg.slug} does not resolve in getBrowsePageConfig()`);
  }
});

test('/biz surfaces advertise the Profitability Scorecard behind the flag only', () => {
  // Sitemap, llms.txt and the footer read the flag, so they follow the release
  // and the kill switch together.
  const sitemap = readFileSync(path.join(ROOT, 'src/app/sitemap.ts'), 'utf8');
  assert.match(sitemap, /featureFlags\.commercial \? \[[\s\S]*?\/biz`[\s\S]*?BIZ_TOPIC_PATHS[\s\S]*?getSeasonsWithCommercialData\(\)\.filter\(isIndexedCommercialSeason\)/);
  const llms = readFileSync(path.join(ROOT, 'src/app/llms.txt/route.ts'), 'utf8');
  assert.match(llms, /featureFlags\.commercial \? `- \[Profitability Scorecard\]/);
  const footer = readFileSync(path.join(ROOT, 'src/components/FooterMarketContent.tsx'), 'utf8');
  assert.match(footer, /featureFlags\.commercial && <li><Link href="\/biz"/);
  // Every topic page listed in the sitemap is a real route.
  const topics = sitemap.match(/BIZ_TOPIC_PATHS = \[([^\]]*)\]/)[1].match(/'([^']+)'/g).map((q) => q.slice(1, -1));
  assert.ok(topics.length >= 5);
  for (const t of topics) {
    assert.ok(statSync(path.join(ROOT, 'src/app/biz', t, 'page.tsx')).isFile(), `src/app/biz/${t}/page.tsx missing`);
  }
});

// Thin season pages are the one exception: noindex below MIN_INDEXED_SEASON_SHOWS.
const SEASON_PAGE = 'src/app/biz/season/[season]/page.tsx';

test('/biz pages carry no robots noindex (thin season pages aside)', () => {
  const files = walk(path.join(ROOT, 'src/app/biz'));
  assert.ok(files.length >= 7);
  const offenders = files.filter((f) => path.relative(ROOT, f) !== SEASON_PAGE)
    .filter((f) => /noindex|index:\s*false/.test(readFileSync(f, 'utf8')))
    .map((f) => path.relative(ROOT, f));
  assert.deepEqual(offenders, [], `remove noindex from: ${offenders.join(', ')}`);
  const season = readFileSync(path.join(ROOT, SEASON_PAGE), 'utf8');
  assert.match(season, /isIndexedCommercialSeason\(params\.season\) \? \{\} : \{ robots: \{ index: false, follow: true \} \}/);
});

const { getSeasonsWithCommercialData, isIndexedCommercialSeason, getShowsBySeasonWithCommercial, MIN_INDEXED_SEASON_SHOWS } =
  await import('../../src/lib/data-commercial.ts');

test('only seasons with enough tracked shows are indexed', () => {
  const seasons = getSeasonsWithCommercialData();
  const indexed = seasons.filter(isIndexedCommercialSeason);
  assert.ok(indexed.length >= 5, 'recent seasons should be indexed');
  for (const s of seasons) {
    assert.equal(isIndexedCommercialSeason(s), getShowsBySeasonWithCommercial(s).length >= MIN_INDEXED_SEASON_SHOWS, s);
  }
});

// Commercial data loads only through data-commercial.ts (toPublicShowCommercial
// keeps raw research notes out of page payloads), whatever the flag says.
const COMMERCIAL_JSON_READERS = new Set([
  'src/lib/data-commercial.ts',
  'src/lib/data-tony-predictions.ts', // only drops "Tour Stop" shows from Tony eligibility
]);

test('only the allowlisted modules import commercial.json', () => {
  const offenders = ['src/app', 'src/components', 'src/lib'].flatMap((d) => walk(path.join(ROOT, d)))
    .filter((f) => /commercial\.json['"]/.test(readFileSync(f, 'utf8')))
    .map((f) => path.relative(ROOT, f))
    .filter((rel) => !COMMERCIAL_JSON_READERS.has(rel));
  assert.deepEqual(offenders, [], `read commercial data through data-commercial.ts:\n${offenders.join('\n')}`);
});

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

// BRO-5007: Box Office Scorecard v2 is not public yet (owner, 2026-10-10).
const { computeDemoFlags } = await import('../../scripts/lib/demo-feature-flags.js');

test('boxOfficeV2 is off without the env var and held back from production', () => {
  assert.equal(featureFlags.boxOfficeV2, false);
  assert.ok(PROD_HELD_FEATURES.has('boxOfficeV2'), 'boxOfficeV2 must stay in PROD_HELD_FEATURES until released');
});

test('the public demo build leaves prod-held flags off (boxOfficeV2 included)', () => {
  const src = readFileSync(path.join(ROOT, 'src/config/feature-flags.ts'), 'utf8');
  const flags = computeDemoFlags(src);
  assert.ok(flags.length > 5, 'demo flag list unexpectedly short');
  assert.ok(!flags.includes('boxOfficeV2'), 'boxOfficeV2 must not be enabled on demo.broadwayscorecard.com');
  assert.ok(flags.includes('commercial'), 'commercial is released, so demo keeps it on');
  assert.ok(!PROD_HELD_FEATURES.has('seasonReport'), 'seasonReport is released (BRO-5777)');
  const wf = readFileSync(path.join(ROOT, '.github/workflows/vercel-demo.yml'), 'utf8');
  const codeLines = wf.split('\n').filter((l) => !/^\s*#/.test(l));
  assert.ok(codeLines.some((l) => /node\s+scripts\/lib\/demo-feature-flags\.js/.test(l)),
    'vercel-demo.yml must compute its flags by running scripts/lib/demo-feature-flags.js');
  assert.ok(!codeLines.some((l) => l.includes('matchAll(/get')),
    'vercel-demo.yml must not extract flags inline (that path enables prod-held flags)');
});


// Held-feature guards (BRO-5007 v3). Names are derived, never listed: getters
// from data-commercial's /BoxOffice/ exports, components from
// held-feature-leak.js's isHeldSource (path patterns plus the @held-feature
// marker). The v2-only lists these replace let new names slip through.
const { createRequire } = await import('node:module');
const requireCjs = createRequire(import.meta.url);
const { SENTINELS, isHeldSource, scanBuildOutput } = requireCjs('../../scripts/lib/held-feature-leak.js');

const SRC_FILES = ['src/app', 'src/components', 'src/lib'].flatMap((d) => walk(path.join(ROOT, d)))
  .map((file) => ({ file, rel: path.relative(ROOT, file).split(path.sep).join('/'), text: readFileSync(file, 'utf8') }));
const byRel = new Map(SRC_FILES.map((f) => [f.rel, f]));
const isClient = (text) => /^\s*['"]use client['"]/.test(text);

function resolveImport(fromRel, spec) {
  let base;
  if (spec.startsWith('@/')) base = `src/${spec.slice(2)}`;
  else if (spec.startsWith('.')) base = path.posix.join(path.posix.dirname(fromRel), spec);
  else return null;
  for (const ext of ['', '.tsx', '.ts', '/index.tsx', '/index.ts']) if (byRel.has(base + ext)) return base + ext;
  return null;
}

test('held box-office data is computed only behind commercial AND boxOfficeV2', () => {
  const src = readFileSync(path.join(ROOT, 'src/lib/data-commercial.ts'), 'utf8');
  const heldFns = [...src.matchAll(/^export (?:async )?(?:function|const) (\w*BoxOffice\w*)/gm)].map((m) => m[1]);
  assert.ok(heldFns.includes('getShowBoxOfficeV2') || heldFns.some((n) => /^getShowBoxOffice/.test(n)),
    'data-commercial box-office getters not found; update this guard');
  const call = new RegExp(`\\b(${heldFns.join('|')})\\s*\\(`);
  const offenders = [];
  for (const { rel, text } of SRC_FILES) {
    if (rel === 'src/lib/data-commercial.ts') continue;
    text.split('\n').forEach((line, i) => {
      if (call.test(line) && !/^\s*(\/\/|\*|import\b)/.test(line)
        && !(line.includes('featureFlags.commercial') && line.includes('featureFlags.boxOfficeV2'))) {
        offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `gate these on featureFlags.commercial && featureFlags.boxOfficeV2:\n${offenders.join('\n')}`);
});

test('held modules never reach a client bundle through a static import', () => {
  // A static import of a 'use client' module puts its copy in the importing
  // route's chunk whatever the flags say, and a client module bundles anything
  // it imports. Allowed: a server module importing a held server module (no JS
  // ships), and a held client module importing another held client module
  // (both live in the lazily loaded chunk).
  const staticImport = /^\s*import\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gm;
  const offenders = [];
  for (const { rel, text } of SRC_FILES) {
    const importerHeld = isHeldSource(rel, text);
    const importerClient = isClient(text);
    for (const m of text.matchAll(staticImport)) {
      const target = resolveImport(rel, m[1]);
      if (!target) continue;
      const t = byRel.get(target);
      if (!isHeldSource(target, t.text)) continue;
      const targetClient = isClient(t.text);
      const ok = (!importerClient && !targetClient) || (importerHeld && importerClient && targetClient);
      if (!ok) offenders.push(`${rel} imports ${target}`);
    }
  }
  assert.deepEqual(offenders, [], `load these with next/dynamic from a 'use client' *Lazy module:\n${offenders.join('\n')}`);
});

test('held components are dynamic() from client modules only, behind the build-time check', () => {
  // dynamic() in a server component still bundles the module into that page's
  // chunk (the flag-off /box-office build shipped "Vs. its cost" this way).
  // From a client module it is a separate chunk, but webpack still emits that
  // chunk in a flag-off build unless the import sits in a branch the build
  // folds away: `process.env.HELD_BOX_OFFICE_BUILD === 'true' ? dynamic(...) : ...`.
  const lazyImport = /dynamic\(\s*\(\)\s*=>\s*import\(\s*['"]([^'"]+)['"]/g;
  const buildCheck = /process\.env\.HELD_BOX_OFFICE_BUILD\s*===\s*'true'\s*\?\s*$/;
  const offenders = [];
  const unguarded = [];
  let found = 0;
  for (const { rel, text } of SRC_FILES) {
    for (const m of text.matchAll(lazyImport)) {
      const target = resolveImport(rel, m[1]);
      if (!target || !isHeldSource(target, byRel.get(target).text)) continue;
      found++;
      if (!isClient(text)) offenders.push(`${rel} -> ${target}`);
      if (!buildCheck.test(text.slice(0, m.index))) unguarded.push(`${rel} -> ${target}`);
    }
  }
  assert.ok(found >= 2, 'expected the held card and tables to be lazy-loaded somewhere');
  assert.deepEqual(offenders, [], `move these dynamic() calls into a 'use client' module:\n${offenders.join('\n')}`);
  assert.deepEqual(unguarded, [],
    `write these as process.env.HELD_BOX_OFFICE_BUILD === 'true' ? dynamic(...) : () => null:\n${unguarded.join('\n')}`);
});

test('next.config inlines HELD_BOX_OFFICE_BUILD from boxOfficeV2 (commercial is always on)', () => {
  const cfg = readFileSync(path.join(ROOT, 'next.config.js'), 'utf8');
  assert.match(cfg, /HELD_BOX_OFFICE_BUILD:\s*heldBoxOfficeBuild/);
  // A prod env without 'commercial' must still fold the held chunks in once
  // boxOfficeV2 is listed, or the runtime flags and the build disagree.
  assert.match(cfg, /heldBoxOfficeBuild = builtFeatures\.includes\('boxOfficeV2'\);/);
  assert.equal(featureFlags.commercial, true);
});

test('every leak sentinel is held-only copy', () => {
  // The build scan is only meaningful if each sentinel appears in held source
  // and nowhere public.
  for (const s of SENTINELS) {
    const where = SRC_FILES.filter((f) => f.text.includes(s));
    assert.ok(where.some((f) => isHeldSource(f.rel, f.text)), `sentinel "${s}" is not in any held source file`);
    const pub = where.filter((f) => !isHeldSource(f.rel, f.text)).map((f) => f.rel);
    assert.deepEqual(pub, [], `sentinel "${s}" also appears in public source`);
  }
});

test('the build scan reports held copy and passes clean output', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(path.join(tmpdir(), 'held-leak-'));
  mkdirSync(path.join(dir, '_next/static/chunks'), { recursive: true });
  writeFileSync(path.join(dir, 'index.html'), '<p>Broadway grosses</p>');
  writeFileSync(path.join(dir, '_next/static/chunks/a.js'), 'x="ok"');
  assert.deepEqual(scanBuildOutput(dir).hits, []);
  writeFileSync(path.join(dir, '_next/static/chunks/b.js'), `x="${SENTINELS[0]}"`);
  const { hits } = scanBuildOutput(dir);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sentinel, SENTINELS[0]);
});
