import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const unregister = require('tsx/cjs/api').register();
after(unregister);
const { buildNameSlugRedirects } = require('../../scripts/lib/name-slug-redirects');
const { resolvePathRedirect } = require('../../src/lib/slug-redirects.ts');

test('real profile builder merges team credits in both indexes and links directly to the first collaborator', t => {
  const base = { category: 'broadway', venue: 'A Theatre', status: 'closed', type: 'musical', openingDate: '2000-01-01' };
  const shows = [
    { ...base, id: 'one-2000', slug: 'one-2000', creativeTeam: [
      { name: 'José Writer and Jane Smith', role: 'Book, Music & Lyrics' },
      { name: 'Jane Smith', role: 'Book' },
    ] },
    { ...base, id: 'two-2001', slug: 'two-2001', creativeTeam: [{ name: 'Jose Writer', role: 'Book' }] },
    { ...base, id: 'three-2002', slug: 'three-2002', creativeTeam: [{ name: 'Jane Smith', role: 'Director' }] },
  ];
  const originalLoad = Module._load;
  t.mock.method(Module, '_load', function (id, ...args) {
    if (id === './data-core' && args[0]?.filename.endsWith('/src/lib/data-creative.ts')) {
      return { getBroadwayShows: () => shows, slugify: require('../../scripts/lib/url-slug').slugify };
    }
    return originalLoad.call(this, id, ...args);
  });
  const creative = require('../../src/lib/data-creative.ts');
  const profiles = creative.getAllUnifiedCreativeProfiles();
  assert.deepEqual(profiles.map(p => p.name).sort(), ['Jane Smith', 'Jose Writer', 'José Writer']);
  const jane = profiles.find(p => p.name === 'Jane Smith');
  assert.equal(jane.showCount, 2, 'duplicate individual and team credits count each show once');
  assert.deepEqual(jane.shows.find(s => s.slug === 'one-2000').roles, ['Book, Music & Lyrics', 'Book']);
  assert.deepEqual(jane.categories, ['playwright', 'composer', 'lyricist', 'director']);
  for (const category of ['playwright', 'composer', 'lyricist']) {
    const index = creative.getCreativeProfiles(category);
    assert.ok(index.some(p => p.name === 'José Writer'));
    assert.ok(index.some(p => p.name === 'Jane Smith'));
    assert.ok(!index.some(p => p.name.includes(' and ')));
    assert.equal(index.find(p => p.name === 'Jane Smith').shows.filter(s => s.slug === 'one-2000').length, 1);
  }
  assert.equal(creative.getUnifiedSlugForName('Jose Writer'), 'jose-writer');
  assert.equal(creative.getUnifiedSlugForName('José Writer'), 'jose-writer-2');
  assert.equal(creative.getCreativeLink('José Writer and Jane Smith', 'Book'), '/creative/jose-writer-2');
  assert.equal(creative.getUnifiedSlugForName('José Writer and Jane Smith'), 'jose-writer-2');
  const { entries } = buildNameSlugRedirects({ shows });
  for (const old of ['jose-writer-and-jane-smith', 'jos-writer-and-jane-smith']) {
    assert.equal(creative.getUnifiedCreativeProfile(old, entries)?.name, 'José Writer');
    assert.deepEqual(resolvePathRedirect(entries, `/creative/${old}`), { pathname: '/creative/jose-writer-2', status: 301 });
    assert.ok(!creative.getUnifiedCreativeSlugs().includes(old));
  }
  assert.equal(shows[0].creativeTeam[0].name, 'José Writer and Jane Smith', 'source data stays intact');
});
