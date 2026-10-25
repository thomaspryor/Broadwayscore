// BRO-3628 ship-check: HeaderSearch now sends `query` on fuzzy-only misses
// (has_results true, fuzzy_only true), not just zero results. The friction
// analyzer's query must not filter those out on has_results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

test('getZeroResultsSearches keys on query presence, not has_results', async () => {
  process.env.POSTHOG_PERSONAL_API_KEY ||= 'test-key';
  const realFetch = globalThis.fetch;
  let sent = '';
  globalThis.fetch = async (_url, opts) => {
    sent = JSON.parse(opts.body).query.query;
    return { ok: true, json: async () => ({ results: [['fleabg', 2]] }) };
  };
  try {
    const { getZeroResultsSearches } = require('../../scripts/lib/posthog-query.js');
    assert.deepEqual(await getZeroResultsSearches(), [['fleabg', 2]]);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.match(sent, /properties\.query IS NOT NULL/);
  assert.doesNotMatch(sent, /has_results\s*=\s*false/);
});
