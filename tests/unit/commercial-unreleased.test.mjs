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
