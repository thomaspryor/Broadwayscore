/**
 * Every new show must get BOTH category and market set at discovery.
 *
 * Root cause of Schmigadoon (2026-04-19), Beaches (2026-04-22), Rocky Horror
 * (2026-04-23), Joe Turner (2026-04-25), Lost Boys (2026-04-26): the creator
 * had no explicit Broadway branch — Broadway shows fell through the if/else-if
 * chain and shipped with null category+market. The fix extracts classification
 * to scripts/lib/classify-show.js; this test asserts the real function behavior
 * AND confirms discover-new-shows.js still calls it (CLAUDE.md §15: never copy
 * logic into tests, always require the real thing).
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const ROOT = join(import.meta.dirname, '..', '..');
const { classifyShow } = require(join(ROOT, 'scripts/lib/classify-show.js'));

// --- Functional tests: the real classifier must return non-null, consistent pairs ---

test('classifyShow({category:"off-broadway"}) → Broadway market', () => {
  assert.deepStrictEqual(classifyShow({ category: 'off-broadway' }),
    { category: 'off-broadway', market: 'broadway' });
});

test('classifyShow({category:"west-end"}) → West End market', () => {
  assert.deepStrictEqual(classifyShow({ category: 'west-end' }),
    { category: 'west-end', market: 'west-end' });
});

test('classifyShow({category:"off-west-end"}) → West End market', () => {
  assert.deepStrictEqual(classifyShow({ category: 'off-west-end' }),
    { category: 'off-west-end', market: 'west-end' });
});

test('classifyShow({}) (Broadway default) → never null', () => {
  // This is THE bug — Broadway shows arriving without an explicit category.
  // Must default to {category:"broadway", market:"broadway"}, not leave either null.
  const out = classifyShow({});
  assert.strictEqual(out.category, 'broadway',
    'Broadway default must set category="broadway" — the bug that bit Schmigadoon/Beaches/Rocky Horror.');
  assert.strictEqual(out.market, 'broadway',
    'Broadway default must set market="broadway" — null market breaks opening-night orchestrator.');
});

test('classifyShow(null|undefined|{category:null}) → Broadway default, no crash', () => {
  assert.deepStrictEqual(classifyShow(null),
    { category: 'broadway', market: 'broadway' });
  assert.deepStrictEqual(classifyShow(undefined),
    { category: 'broadway', market: 'broadway' });
  assert.deepStrictEqual(classifyShow({ category: null }),
    { category: 'broadway', market: 'broadway' });
});

test('classifyShow always returns category+market consistent with validate-data.js rules', () => {
  // validate-data.js:247-252 enforces:
  //   category='off-broadway' ⇒ market='broadway'
  //   category='off-west-end' ⇒ market='west-end'
  //   otherwise market === category
  for (const cat of ['broadway', 'off-broadway', 'west-end', 'off-west-end']) {
    const out = classifyShow({ category: cat });
    const expected = cat === 'off-broadway' ? 'broadway'
                   : cat === 'off-west-end' ? 'west-end'
                   : cat;
    assert.strictEqual(out.market, expected,
      `classifyShow({category:"${cat}"}) returned market="${out.market}", validate-data.js expects "${expected}"`);
  }
});

// --- BRO-157: genre must override venue for category at discovery time too ---
// (not just in validate-data.js's CI backstop — see genre-classification.test.mjs
// for the shared applyGenreCategoryOverride() behavior tests).

test('discover-new-shows.js applies applyGenreCategoryOverride before pushing a TodayTix-confirmed show', () => {
  const src = readFileSync(join(ROOT, 'scripts/discover-new-shows.js'), 'utf8');
  assert.ok(
    /require\(['"]\.\/lib\/genre-classification['"]\)/.test(src),
    'discover-new-shows.js no longer requires ./lib/genre-classification'
  );
  assert.ok(
    /applyGenreCategoryOverride\(/.test(src),
    'discover-new-shows.js no longer calls applyGenreCategoryOverride — a non-theatrical ' +
      'show at a West End venue (e.g. dance at Sadler\'s Wells) can ship with category=' +
      '"west-end" again until the next validate-data.js CI run (BRO-157 regression).'
  );
});

// BRO-157 follow-up: the second-opinion review on the original fix found TWO
// MORE live, non-provisional West End intake paths that never computed genre
// at all — fetchShowsFromTodayTixLondon() and fetchShowsFromOfficialLondonTheatre()
// — a higher-risk gap than the one originally fixed, since genre being unset
// (not just wrong) means validate-data.js's CI backstop can't catch it either
// (isNonTheatricalGenre(undefined) is false). All three West End intake
// functions must call applyGenreCategoryOverride — assert the count so a
// future refactor can't silently drop one.
test('all 3 West End show-intake sites call applyGenreCategoryOverride (BRO-157 follow-up)', () => {
  const src = readFileSync(join(ROOT, 'scripts/discover-new-shows.js'), 'utf8');
  const callCount = (src.match(/applyGenreCategoryOverride\(/g) || []).length;
  assert.strictEqual(
    callCount, 3,
    `Expected applyGenreCategoryOverride() to be called exactly 3 times ` +
      `(fetchShowsFromTodayTixLondon, fetchShowsFromOfficialLondonTheatre, and the ` +
      `TodayTix-confirmed validated.push branch) — found ${callCount}. If you added or ` +
      `removed a West End intake path, keep every one genre-aware or this count out of sync.`
  );

  for (const fnName of ['fetchShowsFromTodayTixLondon', 'fetchShowsFromOfficialLondonTheatre']) {
    const start = src.indexOf(`async function ${fnName}`);
    assert.ok(start !== -1, `could not find function ${fnName} in discover-new-shows.js`);
    const nextFnStart = src.indexOf('\nasync function ', start + 1);
    const body = src.slice(start, nextFnStart === -1 ? start + 6000 : nextFnStart);
    assert.ok(
      /classifyGenre\(/.test(body) && /applyGenreCategoryOverride\(/.test(body),
      `${fnName} must call classifyGenre() and applyGenreCategoryOverride() before pushing ` +
        `a show — otherwise a non-theatrical show at a West End venue ships with the wrong ` +
        `category AND no genre, so even the validate-data.js CI backstop can't fix it later.`
    );
  }
});

// --- Wiring test: the creator must actually use the helper ---

test('scripts/discover-new-shows.js calls classifyShow on every new show', () => {
  const src = readFileSync(join(ROOT, 'scripts/discover-new-shows.js'), 'utf8');
  assert.ok(
    /require\(['"]\.\/lib\/classify-show['"]\)/.test(src)
      || /require\(['"]\.\/lib\/classify-show\.js['"]\)/.test(src),
    'discover-new-shows.js no longer requires ./lib/classify-show — someone inlined the logic again. ' +
      'Keep classification in one place per CLAUDE.md §15.'
  );
  assert.ok(
    /classifyShow\(\s*show\s*\)/.test(src),
    'discover-new-shows.js imports classifyShow but never calls it with the show. ' +
      'New shows will ship with null category+market again.'
  );
  // The call site must be immediately before `data.shows.push(showEntry)` —
  // anywhere else and a later mutation could overwrite the fields.
  const pushIdx = src.indexOf('data.shows.push(showEntry)');
  const preceding = src.slice(Math.max(0, pushIdx - 400), pushIdx);
  assert.ok(
    /classifyShow\(\s*show\s*\)/.test(preceding),
    'classifyShow() is no longer called in the ~400 chars before data.shows.push(showEntry). ' +
      'The call must stay adjacent to the push so nothing can overwrite category/market between.'
  );
});
