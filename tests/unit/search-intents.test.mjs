/**
 * BRO-5988: the search-intent map must point at real pages, and pages that share an
 * intent must not share a title (the cannibalization the map exists to stop).
 * Real registries, real functions. The duplicate-title check is advisory (warns)
 * unless INTENT_STRICT=1, per CLAUDE.md section 19.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SEARCH_INTENTS, getIntentForPath, getIntentPaths, isCanonicalPath } from '../../src/config/search-intents';
import { BROWSE_PAGES } from '../../src/config/browse-pages';
import { GUIDE_PAGES, interpolateTemplate } from '../../src/config/guide-pages';
import { getBestOfList } from '../../src/lib/data-core';

/** The <title>/H1 pair a page ships, or undefined when the path is not a real page. */
function pageTitles(path) {
  const [, kind, slug] = path.split('/');
  if (kind === 'browse') {
    const p = BROWSE_PAGES[slug];
    return p && { meta: p.metaTitle, h1: p.h1, title: p.title };
  }
  if (kind === 'guides') {
    const g = GUIDE_PAGES[slug];
    if (!g) return undefined;
    const vars = { year: 2026, monthYear: 'October 2026', season: '2026-27' };
    return { meta: interpolateTemplate(g.metaTitleTemplate, vars), h1: interpolateTemplate(g.h1Template, vars), title: g.title };
  }
  if (kind === 'best') {
    const l = getBestOfList(slug);
    return l && { meta: l.title, h1: l.title, title: l.title };
  }
  return undefined;
}

test('every URL in the intent map is a real page', () => {
  for (const intent of SEARCH_INTENTS) {
    for (const path of getIntentPaths(intent)) {
      assert.ok(pageTitles(path), `${intent.id}: ${path} is not in any registry`);
    }
  }
});

test('a URL belongs to at most one intent, and each intent has a distinct canonical', () => {
  const seen = new Map();
  for (const intent of SEARCH_INTENTS) {
    for (const path of getIntentPaths(intent)) {
      assert.equal(seen.has(path), false, `${path} is in both ${seen.get(path)} and ${intent.id}`);
      seen.set(path, intent.id);
    }
  }
});

test('lookup folds year variants and trailing slashes onto the base page', () => {
  assert.equal(getIntentForPath('/guides/best-broadway-musicals-2026')?.id, 'best-musicals');
  assert.equal(getIntentForPath('/browse/best-broadway-musicals/')?.id, 'best-musicals');
  assert.equal(getIntentForPath('/browse/west-end-shows'), undefined);
  assert.equal(isCanonicalPath('/best/musicals'), false);
  assert.equal(isCanonicalPath('/guides/best-broadway-musicals'), true);
});

test('pages sharing an intent have distinct titles (advisory)', () => {
  const clashes = [];
  for (const intent of SEARCH_INTENTS) {
    const byTitle = new Map();
    for (const path of getIntentPaths(intent)) {
      const t = pageTitles(path);
      for (const key of [t.meta.toLowerCase(), t.h1.toLowerCase(), t.title.toLowerCase()]) {
        const stripped = key.replace(/\(?\b(19|20)\d\d\b\)?/g, '').replace(/\s+/g, ' ').trim();
        if (byTitle.has(stripped) && byTitle.get(stripped) !== path) {
          clashes.push(`${intent.id}: "${stripped}" on ${byTitle.get(stripped)} and ${path}`);
        }
        byTitle.set(stripped, path);
      }
    }
  }
  if (clashes.length) console.warn(`ADVISORY title overlap:\n  ${clashes.join('\n  ')}`);
  if (process.env.INTENT_STRICT === '1') assert.deepEqual(clashes, []);
});
