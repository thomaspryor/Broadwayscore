/**
 * BRO-8056 1b-iii: the eslint rule that keeps every show-page surface on
 * getShowForRender(). Lints source text with the repo config, so reverting
 * the rule (or narrowing its file globs) fails here.
 *
 * Run: node --test tests/unit/show-render-lint.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ESLint } from 'eslint';

const eslint = new ESLint();
const ruleHits = async (code, filePath) => {
  const [res] = await eslint.lintText(code, { filePath });
  return res.messages.filter(m => m.ruleId === 'no-restricted-imports');
};

const bad = [
  ["import { getShowBySlug } from '@/lib/data-core';\nexport const x = getShowBySlug;\n", 'src/app/show/[slug]/page.tsx'],
  ["import { getCriticConsensus } from '@/lib/data-consensus';\nexport const x = getCriticConsensus;\n", 'src/app/show/[slug]/reviews.json/route.ts'],
  ["import { getAudienceBuzz } from '@/lib/data-audience';\nexport const x = getAudienceBuzz;\n", 'src/components/show-page/Example.tsx'],
  ["import { getShowBySlug } from '../../lib/data-core';\nexport const x = getShowBySlug;\n", 'src/components/show-page/Example.tsx'],
];

for (const [code, file] of bad) {
  test(`show page may not read its show directly: ${file}`, async () => {
    const hits = await ruleHits(code, file);
    assert.equal(hits.length, 1, JSON.stringify(hits));
    assert.match(hits[0].message, /getShowForRender/);
  });
}

test('other-show lookups and the seam itself stay allowed', async () => {
  assert.equal((await ruleHits("import { getShowById, getTourStops } from '@/lib/data-core';\nexport const x = [getShowById, getTourStops];\n", 'src/components/show-page/ShowTrustLines.tsx')).length, 0);
  assert.equal((await ruleHits("import { getShowForRender } from '@/lib/show-render';\nexport const x = getShowForRender;\n", 'src/app/show/[slug]/page.tsx')).length, 0);
  // The rule is scoped to show-page files: other pages are untouched.
  assert.equal((await ruleHits("import { getShowBySlug } from '@/lib/data-core';\nexport const x = getShowBySlug;\n", 'src/app/browse/page.tsx')).length, 0);
});
