// BRO-236: a brand-new Tony season with one open show must never render a
// "Predicted Winner" / 100% pick or a ranked ItemList. Source-level pins on
// every surface that can show a prediction before nominations exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');

test('nominees page redirects to predictions until nominations are announced', () => {
  const src = read('src/app/tony-awards/nominees/page.tsx');
  assert.match(
    src,
    /if \(!hasNominationsBeenAnnounced\(season\)\) \{\s*redirect\(`\/tony-awards\/predictions\/\$\{season\.label\}`\);/,
  );
  // redirect must precede any category/win-prob computation
  assert.ok(src.indexOf('redirect(`') < src.indexOf('getNomineesByCategory(season)'));
});

test('predictions [season] page gates Our Pick and ItemList on announced nominations', () => {
  const src = read('src/app/tony-awards/predictions/[season]/page.tsx');
  assert.match(src, /const showOurPick = featureFlags\.tonyPredictionsOurPick && \(!isCurrent \|\| nominationsAnnounced\)/);
  assert.match(src, /const suppressItemLists = isCurrent && !nominationsAnnounced/);
  assert.match(src, /showOurPick=\{showOurPick\}/);
});

test('CategorySection requires an explicit showOurPick (no silent default-on)', () => {
  const src = read('src/components/tony-noms/CategorySection.tsx');
  assert.match(src, /showOurPick: boolean/);
  assert.doesNotMatch(src, /showOurPick\?:/);
  assert.doesNotMatch(src, /showOurPick = true/);
});

test('hasNominationsBeenAnnounced needs >=2 top categories for the season', () => {
  const src = read('src/lib/data-tony-predictions.ts');
  const fn = src.slice(src.indexOf('export function hasNominationsBeenAnnounced'));
  assert.match(fn.slice(0, 900), /data\.tony\?\.season !== awardsSeason\) continue/);
  assert.match(fn.slice(0, 900), /categoriesWithNominees\.size >= 2/);
});

test('umbrella predictions page does not promise picks pre-nominations', () => {
  const src = read('src/app/tony-awards/predictions/page.tsx');
  assert.match(src, /nominationsAnnounced\s*\?\s*<>See our picks/);
});

test('newsletter dump imports the real hasNominationsBeenAnnounced and emits no picks pre-nominations', () => {
  const src = read('scripts/newsletter/dump-tony-predictions.ts');
  const cutoffs = read('src/lib/tony-cutoffs.ts');
  assert.doesNotMatch(cutoffs, /export function hasNominationsBeenAnnounced/);
  assert.doesNotMatch(src, /from '\.\.\/\.\.\/src\/lib\/tony-cutoffs'/);
  assert.match(src, /hasNominationsBeenAnnounced,\s*\} from '\.\.\/\.\.\/src\/lib\/data-tony-predictions'/);
  assert.doesNotMatch(src, /catch \{ return true; \}/);
  assert.match(src, /if \(!nominationsAnnounced\) \{ out\[cat\.key\] = \[\]; continue; \}/);
});

test('hub page and sitemap gate on hasNominationsBeenAnnounced', () => {
  assert.match(read('src/app/tony-awards/page.tsx'), /hasNominationsBeenAnnounced\(season\)/);
  assert.match(read('src/app/sitemap.ts'), /hasNominationsBeenAnnounced\(getTonySeasonWindow\(\)\)/);
});
