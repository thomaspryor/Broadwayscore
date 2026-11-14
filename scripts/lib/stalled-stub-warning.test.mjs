import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { findStalledReviewStubs } = require('./opening-night-discovery-policy.js');

const now = new Date('2026-10-31T12:00:00Z');
const show = { id: 'the-heart-off-broadway-2026', openingDate: '2026-10-29' };
const hoursAgo = (h) => new Date(+now - h * 3600000).toISOString();

function dirWith(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(d, name), JSON.stringify({ contentTier: 'stub', fullText: '', ...body }));
  return d;
}

test('BRO-6682: real stall still reported; excluded and abandoned stubs are not', () => {
  const d = dirWith({
    'talkinbroadway--unknown.json': { firstSeenAt: hoursAgo(10) },
    'variety--cynthia-littleton.json': { firstSeenAt: hoursAgo(25), isRoundupArticle: true },
    'wrong--show.json': { firstSeenAt: hoursAgo(25), wrongShow: true },
    'frontmezzjunkies--unknown.json': { firstSeenAt: hoursAgo(529) },
    'fresh--one.json': { firstSeenAt: hoursAgo(1) },
  });
  const files = findStalledReviewStubs(show, d, now).map((s) => s.file);
  assert.deepEqual(files, ['talkinbroadway--unknown.json']);
});
