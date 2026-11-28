import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildLiveCriticAliases, deriveCriticOutletAliases, findMissingCriticOutletAliases, retiredSlugs } = require('../../scripts/lib/critic-outlet-redirects');
const { buildCriticRedirectEntries } = require('../../scripts/lib/critic-slug-aliases');

const pairs = {
  'frank-rich-the-new-york-times': 'frank-rich',
  'claire-allfree-for-metro': 'claire-allfree',
  'christopher-kelly-nj-com': 'christopher-kelly',
  'carole-di-tosti-theater-pizzazz': 'carole-di-tosti',
  'brian-scott-lipton-cititour': 'brian-scott-lipton',
  'aliya-al-hassan-broadwayworld': 'aliya-al-hassan',
  'a-r-hoffman-the-new-york-sun': 'a-r-hoffman',
  'elysa-gardner-the-new-york-sun': 'elysa-gardner',
};
const outlets = { outlets: {
  nytimes: { displayName: 'The New York Times' },
  'metro-uk': { displayName: 'Metro UK', aliases: ['metro'] },
  njcom: { displayName: 'NJ.com' },
  'theater-pizzazz': { displayName: 'Theater Pizzazz' },
  cititour: { displayName: 'Cititour' },
  broadwayworld: { displayName: 'BroadwayWorld' },
  'new-york-sun': { displayName: 'The New York Sun' },
} };
const live = new Set(Object.values(pairs));
const shows = [{ id: 'broadway-show', category: 'broadway' }, { id: 'tour-show', category: 'tour' }];
const reviews = [...live].map(criticName => ({ criticName, showId: shows[0].id }));
const build = (overrides = {}) => buildLiveCriticAliases({ aliases: {}, reviews, shows, outlets, ...overrides });

test('all eight logged retired twins become permanent compact-map entries', () => {
  assert.deepEqual(build().aliases, pairs);
  const compact = buildCriticRedirectEntries(build().aliases);
  for (const [slug, canonical] of Object.entries(pairs)) assert.equal(compact[`critic:${slug}`], canonical);
  assert.deepEqual(findMissingCriticOutletAliases(Object.keys(pairs), live, outlets, {}),
    Object.entries(pairs).map(([slug, canonical]) => ({ slug, canonical })));
});

test('all recorded retired patterns resolve; unknown suffixes and dead critics stay absent', () => {
  assert.deepEqual(deriveCriticOutletAliases(retiredSlugs, live, outlets), pairs);
  assert.deepEqual(deriveCriticOutletAliases([
    'alex-gale', 'beth-easton', 'jonas-schwartz', 'jonas-schwartz-the-new-york-times',
    'frank-rich-unknown-outlet',
  ], live, outlets), {});
});

test('new live outlet twins seen in logs fail the coverage check until registered', () => {
  const observed = [...retiredSlugs, 'frank-rich-for-the-new-york-times'];
  const aliases = build().aliases;
  assert.deepEqual(findMissingCriticOutletAliases(observed, live, outlets, aliases), [
    { slug: 'frank-rich-for-the-new-york-times', canonical: 'frank-rich' },
  ]);
  assert.deepEqual(findMissingCriticOutletAliases(observed, live, outlets, {
    ...aliases, 'frank-rich-for-the-new-york-times': 'frank-rich',
  }), []);
});

test('never shadows live pages, invents targets without reviews, or redirects ambiguous prefixes', () => {
  assert.deepEqual(deriveCriticOutletAliases(retiredSlugs, null, outlets), {});
  const withTwin = new Set([...live, 'frank-rich-the-new-york-times']);
  assert.equal(deriveCriticOutletAliases(retiredSlugs, withTwin, outlets)['frank-rich-the-new-york-times'], undefined);
  assert.deepEqual(deriveCriticOutletAliases(['ann-lee-times'], new Set(['ann', 'ann-lee']), {
    times: {}, 'lee-times': {},
  }), {});
  assert.deepEqual(build({ reviews: null }).aliases, {});
  assert.deepEqual(build({ reviews: [] }).aliases, {});
});

test('tour-only, inherited, and unknown-show reviews do not create redirect targets', () => {
  for (const patch of [{ showId: 'tour-show' }, { inheritedFromShowId: 'original' }, { showId: 'missing' }]) {
    assert.deepEqual(build({ reviews: reviews.map(r => ({ ...r, ...patch })) }).aliases, {});
  }
});

test('curated aliases take precedence and chains through derived twins flatten', () => {
  const result = build({ aliases: {
    'old-frank': 'frank-rich-the-new-york-times',
    'claire-allfree-for-metro': 'elysa-gardner',
  } }).aliases;
  assert.equal(result['old-frank'], 'frank-rich');
  assert.equal(result['claire-allfree-for-metro'], 'elysa-gardner');
  assert.deepEqual(findMissingCriticOutletAliases(['claire-allfree-for-metro'], live, outlets, result), [
    { slug: 'claire-allfree-for-metro', canonical: 'claire-allfree' },
  ]);
});

test('malformed observed slugs fail loudly without interpreting URLs as critic metadata', () => {
  for (const bad of [null, {}, 'https://example.com/critics/frank-rich', '../frank-rich', 'Frank Rich']) {
    assert.throws(() => deriveCriticOutletAliases([bad], live, outlets), /route slugs/);
  }
});
