// LIVE-DATA-LANE: reads data/auto-critic-aliases.json, data/audit/critic-distinct-people.json and data/critic-registry.json through the real emission helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { newSplitPairs } = require('../../scripts/lib/critic-split-resolution');
const { displayCriticName } = require('../../scripts/lib/critic-display-name');
const { normalizeCritic } = require('../../scripts/lib/review-normalization');
const { criticProfileKey } = require('../../scripts/lib/url-slug');
const { classifyVariantPair } = require('../../scripts/lib/critic-variant-match');
const { pairs: distinctPairs } = require('../../data/audit/critic-distinct-people.json');

const page = (name, count = 1) => ({ name, slug: criticProfileKey(name), count });
const pair = (canonical, variant) => ({
  key: [canonical.slug, variant.slug].sort().join('|'), canonical, variant,
});

test('an explicit alias wins even when the corrected spelling has fewer reviews', () => {
  const p = pair(page('Samuel L.', 40), page('Samuel L. Leiter'));
  assert.deepEqual(newSplitPairs([p], new Set()), []);
  assert.deepEqual(newSplitPairs([{ ...p, canonical: p.variant, variant: p.canonical }], new Set()), []);
});

test('every spelling on both pages must converge, regardless of count order', () => {
  const canonical = { ...page('Samuel L.', 40), spellings: ['Samuel L.', 'Samuel Leiterr'] };
  const p = pair(canonical, page('Samuel L. Leiter'));
  assert.deepEqual(newSplitPairs([p], new Set()), [p]);
  const reversed = { ...p, canonical: p.variant, variant: p.canonical };
  assert.deepEqual(newSplitPairs([reversed], new Set()), [reversed]);
});

test('unresolved names and two discarded bylines do not count as a resolved alias', () => {
  for (const [a, b] of [['Jess Green', 'Jesse Green'], ['Unknown', 'Staff']]) {
    const p = pair(page(a), page(b));
    assert.deepEqual(newSplitPairs([p], new Set()), [p]);
    assert.deepEqual(newSplitPairs([p], new Set([p.key])), []);
  }
});

test('an outlet scoped correction must cover every outlet on either page', () => {
  const canonical = { ...page('David Finkle', 40), outlets: ['cote-notices'] };
  const variant = { ...page('David Cote'), outlets: ['cote-notices'] };
  assert.deepEqual(newSplitPairs([pair(canonical, variant)], new Set()), []);
  const p = pair({ ...canonical, outlets: ['cote-notices', 'nysr'] }, variant);
  assert.deepEqual(newSplitPairs([p], new Set()), [p]);
  const reversed = { ...p, canonical: p.variant, variant: p.canonical };
  assert.deepEqual(newSplitPairs([reversed], new Set()), [reversed]);
});

test('BRO-7855: the three Buzznews reviews keep the outlet verified full byline', () => {
  // The publisher now prints Bree Samani-McGrath on each of these articles:
  // https://buzznews.net/theatre/theatre-reviews/item/5167-in-the-back-on-the-floor-work-pain-and-corporate-slaying.html
  // https://www.buzznews.net/theatre/theatre-reviews/item/5934-review-in-white-rabbit-red-rabbit-the-audience-becomes-the-play.html
  // https://buzznews.net/theatre/theatre-reviews/item/6842-our-town-finds-big-feelings-in-an-ordinary-small-town.html
  for (const raw of ['Bree Samani', 'Bree Samani-McGrath', 'Bree Samani McGrath']) {
    assert.equal(criticProfileKey(displayCriticName(raw, 'Buzznews')), 'bree-samani-mcgrath', raw);
    assert.equal(normalizeCritic(raw), 'bree-samani-mcgrath', raw);
  }
  assert.equal(displayCriticName('Bree Samani', 'Buzznews'), 'Bree Samani-McGrath');
  const p = pair({ ...page('Bree Samani', 2), outlets: ['Buzznews'] },
    { ...page('Bree Samani-McGrath'), outlets: ['Buzznews'] });
  assert.deepEqual(newSplitPairs([p], new Set()), []);
  assert.equal(displayCriticName('Bree McGrath', 'Buzznews'), 'Bree McGrath');
});

test('BRO-7855 cousin: the Roma Tore typo shares Roma Torre identity at ingestion', () => {
  assert.equal(normalizeCritic('Roma Tore'), normalizeCritic('Roma Torre'));
  assert.equal(displayCriticName('Roma Tore', 'NY1'), 'Roma Torre');
});

test('BRO-7855: outlet prefix resolves and combined credits remain separate pages', () => {
  assert.equal(displayCriticName('CurtainUp, Elyse Sommer', 'CurtainUp'), 'Elyse Sommer');
  const p = pair({ ...page('Elyse Sommer', 106), outlets: ['CurtainUp'] },
    { ...page('CurtainUp, Elyse Sommer', 2), outlets: ['CurtainUp'] });
  assert.deepEqual(newSplitPairs([p], new Set()), []);
  for (const [combined, other] of [
    ['David Dougill, Helen Hawkins', 'Helen Hawkins'],
    ['David Dougill, Jane Edwardes, Thomas W Hodgkinson', 'Jane Edwardes, Thomas W Hodgkinson'],
    ['David Dougill, Jane Edwardes, Thomas W Hodgkinson', 'Thomas W. Hodgkinson'],
  ]) {
    const a = { ...page(combined), outlets: ['The Times (UK)'] };
    const b = { ...page(other, 20), outlets: ['The Times (UK)'] };
    assert.equal(classifyVariantPair(a, b, { distinct: new Set(distinctPairs) }).verdict, 'distinct', combined + ' / ' + other);
  }
});

test('BRO-7855 cousin: verified joint credit stays distinct from either solo author', () => {
  const joint = { ...page('David Fox and Cameron Kelsall'), outlets: ['Parterre Box'] };
  for (const name of ['David Fox', 'Cameron Kelsall']) {
    const solo = { ...page(name, 20), outlets: ['Parterre Box'] };
    assert.equal(classifyVariantPair(joint, solo, { distinct: new Set(distinctPairs) }).verdict, 'distinct');
    assert.notEqual(criticProfileKey(displayCriticName(joint.name, 'Parterre Box')),
      criticProfileKey(displayCriticName(name, 'Parterre Box')));
  }
  // Other joint bylines still need review; this is an evidenced exception.
  assert.equal(classifyVariantPair({ ...joint, name: 'David Fox and Jane Smith' },
    { ...page('David Fox', 20), outlets: ['Parterre Box'] }, { distinct: new Set(distinctPairs) }).verdict, 'review');
});
