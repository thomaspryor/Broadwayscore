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
const { featureFlags, PROD_HELD_FEATURES } = await import('../../src/config/feature-flags.ts');
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
// Released public pages that show commercial aggregates only (owner-approved, BRO-5777).
// Path to Broadway (BRO-5842): recoupment rates by route/source, aggregates only, held behind its own flag.
const PUBLIC_AGGREGATE_ROUTES = new Set(['src/app/season-report/page.tsx', 'src/app/path-to-broadway/page.tsx']);
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
    // The public Season Report shows recoupment aggregates and names only shows that
    // recouped (no budgets, running costs or shows that did not recoup); the owner
    // released it 2026-10-20 (BRO-5777) and asked for show links 2026-10-21 (BRO-5808).
    if (PUBLIC_AGGREGATE_ROUTES.has(rel)) continue;
    text.split('\n').forEach((line, i) => {
      if (call.test(line) && !/^\s*(\/\/|\*|import\b)/.test(line) && !line.includes('featureFlags.commercial')) {
        offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `gate these on featureFlags.commercial:\n${offenders.join('\n')}`);
});

// BRO-5007: Box Office Scorecard v2 is not public yet (owner, 2026-10-10).
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

test('next.config inlines HELD_BOX_OFFICE_BUILD from both held flags', () => {
  const cfg = readFileSync(path.join(ROOT, 'next.config.js'), 'utf8');
  assert.match(cfg, /HELD_BOX_OFFICE_BUILD:\s*heldBoxOfficeBuild/);
  assert.match(cfg, /includes\('commercial'\)\s*&&\s*builtFeatures\.includes\('boxOfficeV2'\)/);
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
