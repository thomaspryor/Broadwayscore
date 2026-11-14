import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { matchesShowSearchQuery } = require('../../scripts/lib/show-search-match.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..');

const searchShows = JSON.parse(
  readFileSync(path.join(repoRoot, 'public/data/search-shows.json'), 'utf-8')
);

const wanted = searchShows.find(s => s.id === 'wanted-2022');

test('Wanted (formerly Gun & Powder) is present in the search index with its former title as an alias', () => {
  assert.ok(wanted, 'wanted-2022 should exist in public/data/search-shows.json');
  assert.ok(
    Array.isArray(wanted.akaTitles) && wanted.akaTitles.includes('Gun & Powder'),
    'wanted-2022 should carry "Gun & Powder" as an akaTitle'
  );
});

// The exact queries that previously returned zero results (Notion card #589).
const zeroResultQueries = ['gun &', 'gun &powder', 'gun & powder'];

for (const query of zeroResultQueries) {
  test(`search query "${query}" now matches Wanted via its former title`, () => {
    assert.ok(
      matchesShowSearchQuery(wanted, query),
      `expected "${query}" to match show ${wanted.title} via akaTitles`
    );
  });
}

test('unrelated queries do not spuriously match', () => {
  assert.equal(matchesShowSearchQuery(wanted, 'hamilton'), false);
  assert.equal(matchesShowSearchQuery(wanted, ''), false);
});
