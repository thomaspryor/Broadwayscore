// Review follow-ups for the BWW one-typo roundup fallback. Requires the real module.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { tokenFuzzyMatch, otherActiveShowMatchesExactly } = require('../../scripts/lib/fuzzy-title-token.js');

test('venue words in the slug never count as the typo partner', () => {
  // "Theater" vs slug "THEATRE" is one adjacent swap; it must not match.
  assert.equal(tokenFuzzyMatch(['harbor', 'theater'], ['harbor', 'theatre', 'opens']), null);
  assert.deepEqual(tokenFuzzyMatch(['other', 'desert', 'cities'], ['other', 'desert', 'cites', 'opens']), { token: 'cities', slugWord: 'cites' });
});

test('an upcoming near-twin owns its slug; an explicit empty pool does not block', () => {
  const twin = { id: 'b', title: 'Twin Show', status: 'upcoming' };
  assert.equal(otherActiveShowMatchesExactly({ id: 'a', title: 'Twin Shoe' }, (o) => o.id === 'b', [twin]), true);
  assert.equal(otherActiveShowMatchesExactly({ id: 'a', title: 'Twin Shoe' }, () => true, []), false);
});
