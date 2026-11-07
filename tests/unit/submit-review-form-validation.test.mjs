// BRO-2433: submit-review-form outletId must be validated against the URL host.
// A URL whose host contradicts the claimed outlet is refused (guardRefused, so the
// ingest CLI exits 1) instead of being written as e.g. a T1 review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer.js');

const SHOW = 'the-gin-game-2026';
const submit = (dir, outletId, url) => createOrMergeReviewFile(SHOW, {
  outletId, outlet: outletId, criticName: 'Unknown', url, source: 'submit-review-form',
  fields: { fullText: 'A review of the production. '.repeat(60) },
}, { reviewTextsDir: dir });

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outlet-host-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('arbitrary domain claimed as a T1 outlet is refused with guardRefused', () => withTmp((dir) => {
  const r = submit(dir, 'nytimes', 'https://random-ticket-blog.example.com/gin-game-review');
  assert.equal(r.action, 'skipped');
  assert.match(r.reason, /^domain-mismatch: /);
  assert.equal(r.guardRefused, true);
  assert.equal(fs.existsSync(path.join(dir, SHOW)), false, 'nothing written');
}));

test('another registered outlet host is re-attributed to that outlet, never kept as the claimed one', () => withTmp((dir) => {
  const r = submit(dir, 'nytimes', 'https://variety.com/2026/legit/gin-game-review-1234/');
  const files = fs.existsSync(path.join(dir, SHOW)) ? fs.readdirSync(path.join(dir, SHOW)) : [];
  assert.ok(r.action !== 'skipped' || r.guardRefused === true);
  assert.ok(!files.some((f) => f.startsWith('nytimes--')), `wrote under nytimes: ${files}`);
}));

test('a URL on the outlet own host is not refused for domain mismatch', () => withTmp((dir) => {
  const r = submit(dir, 'nytimes', 'https://www.nytimes.com/2026/08/01/theater/gin-game-review.html');
  assert.doesNotMatch(String(r.reason || ''), /^domain-mismatch/);
}));
