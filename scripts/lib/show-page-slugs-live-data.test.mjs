// LIVE-DATA-LANE: reads data/shows.json (untracked core data). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-8085).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resolveShowSlugs, loadShowsForSlugs } = require('./show-page-slugs.js');

test('every open London show in the real data resolves to its own slug', () => {
  const real = loadShowsForSlugs(fs, path, path.join(path.dirname(new URL(import.meta.url).pathname), '..'));
  const london = real.filter(s => s.status === 'open' && (s.category === 'west-end' || s.category === 'off-west-end') && !s._devOnly);
  if (!london.length) return; // stub data in a keyless container
  const { slugs, unknown } = resolveShowSlugs(london.map(s => s.id), real);
  assert.deepEqual(unknown, []);
  assert.deepEqual(slugs, london.map(s => s.slug));
});
