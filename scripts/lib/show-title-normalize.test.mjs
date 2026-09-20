import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeShowTitle, buildVenueVocabulary } = require('./show-title-normalize.js');

test('applies the venue strip alone', () => {
  const r = normalizeShowTitle({
    id: 'the-cherry-orchard-park-avenue-armory-off-broadway-2026',
    title: 'The Cherry Orchard (Park Avenue Armory)',
    venue: 'Park Avenue Armory',
  });
  assert.equal(r.title, 'The Cherry Orchard');
  assert.equal(r.changed, true);
  assert.deepEqual(r.steps.map(s => s.kind), ['venue-suffix']);
});

test('applies the case fix alone', () => {
  const r = normalizeShowTitle({ id: 'america-who-hurt-you', title: 'AMERICA, WHO HURT YOU?' });
  assert.equal(r.title, 'America, Who Hurt You?');
  assert.deepEqual(r.steps.map(s => s.kind), ['title-case']);
});

test('ORDER: stripping the venue exposes a shouted title underneath', () => {
  // The live corpus row. "Theaters" inside the parenthetical supplies the
  // only lowercase letters in the string, so the de-shouter sees a mixed-case
  // title and does nothing. Run it second and both repairs land.
  const r = normalizeShowTitle({
    id: 'this-is-not-about-me-59e59-theaters-off-broadway-2026',
    title: 'THIS IS NOT ABOUT ME. (59E59 Theaters)',
    venue: '59E59 Theaters, Theater C',
  });
  assert.equal(r.title, 'This Is Not About Me.');
  assert.deepEqual(r.steps.map(s => s.kind), ['venue-suffix', 'title-case']);
});

test('the reverse order would be a no-op, which is why the order is fixed', () => {
  const { toDisplayTitleCase } = require('./title-display-case.js');
  assert.equal(
    toDisplayTitleCase('THIS IS NOT ABOUT ME. (59E59 Theaters)'),
    'THIS IS NOT ABOUT ME. (59E59 Theaters)',
    'de-shouting first does nothing — this pins WHY venue-strip runs first',
  );
});

test('a clean title is returned unchanged with no steps', () => {
  const r = normalizeShowTitle({ id: 'x', title: 'Death of a Salesman', venue: 'Hudson Theatre' });
  assert.equal(r.title, 'Death of a Salesman');
  assert.equal(r.changed, false);
  assert.deepEqual(r.steps, []);
});

test('manual-review titles are flagged and NOT guessed at', () => {
  const r = normalizeShowTitle({
    id: 'mas-sabe-el-saulo-por-viejo-off-broadway-2025',
    title: 'MÁS SABE EL SAULO POR VIEJO...',
  });
  assert.equal(r.manualReview, true);
  assert.equal(r.changed, false, 'must not invent Spanish casing');
  assert.equal(r.title, 'MÁS SABE EL SAULO POR VIEJO...');
});

test('the corpus vocabulary oracle reaches rows whose own venue disagrees', () => {
  const vocab = buildVenueVocabulary([{ venue: 'Soho Playhouse' }, { venue: 'Hudson Theatre' }]);
  const r = normalizeShowTitle(
    { id: 'x', title: 'A Play (Soho Playhouse)', venue: 'Somewhere Else Entirely' },
    { venueVocabulary: vocab },
  );
  assert.equal(r.title, 'A Play');
  assert.equal(r.steps[0].oracle, 'corpus-venue');
});

test('is idempotent — normalising twice equals normalising once', () => {
  const once = normalizeShowTitle({
    id: 'x', title: 'THIS IS NOT ABOUT ME. (59E59 Theaters)', venue: '59E59 Theaters, Theater C',
  }).title;
  const twice = normalizeShowTitle({ id: 'x', title: once, venue: '59E59 Theaters, Theater C' }).title;
  assert.equal(twice, once);
});

test('missing or non-string titles are safe', () => {
  assert.equal(normalizeShowTitle({ id: 'x' }).changed, false);
  assert.equal(normalizeShowTitle({ id: 'x', title: null }).title, '');
  assert.equal(normalizeShowTitle(null).changed, false);
});
