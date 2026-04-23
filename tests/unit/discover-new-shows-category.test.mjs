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
