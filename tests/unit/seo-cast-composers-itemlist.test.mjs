import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const unregister = require('tsx/cjs/api').register();
const React = require('react');
const previousReact = globalThis.React;
globalThis.React = React;
after(() => {
  unregister();
  if (previousReact === undefined) delete globalThis.React;
  else globalThis.React = previousReact;
});

const { BASE_URL, generateItemListSchema } = require('../../src/lib/seo.ts');
const profiles = Array.from({ length: 52 }, (_, i) => ({
  name: `Person ${i + 1}`,
  slug: `person-${i + 1}`,
  shows: [{ slug: 'a-show' }],
}));
const categories = {
  composer: { label: 'Composer', labelPlural: 'Composers', routePath: 'composers' },
  director: { label: 'Director', labelPlural: 'Directors', routePath: 'directors' },
  lyricist: { label: 'Lyricist', labelPlural: 'Lyricists', routePath: 'lyricists' },
  playwright: { label: 'Playwright', labelPlural: 'Playwrights', routePath: 'playwrights' },
};

// Execute each real page and the real SEO helper. Only data and the client UI
// are stubbed so this acceptance command also runs without private data.
for (const route of ['cast', ...Object.values(categories).map(c => c.routePath)]) {
  test(`/${route} emits people without TheaterEvent or EventScheduled`, t => {
    const originalLoad = Module._load;
    t.mock.method(Module, '_load', function (id, ...args) {
      if (id === '@/lib/data-actors') return { getAllActorProfiles: () => profiles };
      if (id === '@/lib/data-creative') return {
        CREATIVE_CATEGORY_CONFIG: categories,
        getCreativeProfiles: () => profiles,
        getUnifiedSlugForName: name => name === 'Person 1' ? 'unified-person-1' : undefined,
      };
      if (id === '@/lib/cast-index') return {
        CAST_DEFAULT_MIN_SCORED: 3,
        getCastIndexProfiles: () => profiles,
        splitCastIndex: () => ({ main: profiles, rest: [] }),
      };
      if (id === '@/components/creative/CreativeIndexClient') return () => null;
      return originalLoad.call(this, id, ...args);
    });
    const Page = require(`../../src/app/${route}/page.tsx`).default;
    const script = React.Children.toArray(Page().props.children).find(child => child.type === 'script');
    assert.ok(script, 'page emits JSON-LD');
    const schemas = JSON.parse(script.props.dangerouslySetInnerHTML.__html);
    const list = schemas.find(schema => schema['@type'] === 'ItemList');
    assert.ok(list, 'page emits an ItemList');
    assert.equal(list.numberOfItems, 50);
    assert.equal(list.itemListElement.length, 50);
    assert.doesNotMatch(JSON.stringify(list), /TheaterEvent|EventScheduled|eventAttendanceMode|location/);
    assert.deepEqual(list.itemListElement, profiles.slice(0, 50).map((p, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      item: {
        '@type': 'Person',
        name: p.name,
        url: `${BASE_URL}/${route === 'cast' ? `cast/${p.slug}` : `creative/${index === 0 ? 'unified-person-1' : p.slug}`}`,
      },
    })));
  });
}

test('an empty person list stays empty', () => {
  const list = generateItemListSchema([], 'People', 'Person');
  assert.equal(list.numberOfItems, 0);
  assert.deepEqual(list.itemListElement, []);
});

test('show lists still default to scheduled theater events, including undated shows', () => {
  for (const startDate of [undefined, '2030-01-01']) {
    const list = generateItemListSchema([{
      name: 'A show', url: `${BASE_URL}/show/a-show`, startDate,
    }], 'Shows');
    const event = list.itemListElement[0].item;
    assert.equal(event['@type'], 'TheaterEvent');
    assert.equal(event.eventStatus, 'https://schema.org/EventScheduled');
    assert.equal(event.startDate, startDate);
    assert.ok(event.location);
  }
});

test('tour lists still emit plain name/url entries', () => {
  const list = generateItemListSchema([{
    name: 'A tour', url: `${BASE_URL}/show/a-tour`, category: 'tour',
  }], 'Tours');
  assert.deepEqual(list.itemListElement, [{
    '@type': 'ListItem', position: 1, name: 'A tour', url: `${BASE_URL}/show/a-tour`,
  }]);
});
