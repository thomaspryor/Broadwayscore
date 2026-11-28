// LIVE-DATA-LANE: asserts the committed vercel.json against the live data/shows.json (CLASS GUARD for BRO-8285: a /show/<live slug> redirect hides that show); runs in check-corpus-drift.yml, not the blocking batch
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { findShadowingShowRedirects } = require('./dead-show-redirects.js');
const __dirname_ = fileURLToPath(new URL('.', import.meta.url));

test('committed vercel.json has no /show/<live slug> -> /show/<other> redirect (skips without core data)', (t) => {
  const shows = path.join(__dirname_, '..', '..', 'data', 'shows.json');
  if (!fs.existsSync(shows)) return t.skip('data/shows.json not present');
  const d = JSON.parse(fs.readFileSync(shows, 'utf8'));
  const list = d.shows || d;
  const vercel = JSON.parse(fs.readFileSync(path.join(__dirname_, '..', '..', 'vercel.json'), 'utf8'));
  const bad = findShadowingShowRedirects(vercel.redirects, new Set(list.map(s => s.slug)));
  assert.deepEqual(bad.map(r => `${r.source} -> ${r.destination}`), []);
});
