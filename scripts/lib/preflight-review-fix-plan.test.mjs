import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { copyUrlOwnerFolder } = require('./preflight-review-fix-plan.js');

// BRO-3065: a url repair proven by another show's folder holding the url must
// replay with that folder present, or preflight reports a false FAIL.
test('copyUrlOwnerFolder copies the folder that already holds the current url', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-src-'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-tmp-'));
  const url = 'https://www.whatsonstage.com/news/here-we-are-at-the-national-theatre-review_1676732/';
  fs.mkdirSync(path.join(src, 'blueberries-2026'));
  fs.writeFileSync(path.join(src, 'blueberries-2026', 'wos.json'), JSON.stringify({ url, publishDate: '2026-02-12' }));
  fs.mkdirSync(path.join(src, 'here-we-are-2025'));
  fs.writeFileSync(path.join(src, 'here-we-are-2025', 'wos--crompton.json'), JSON.stringify({ url }));
  const detect = (folder, u) => (u.includes('here-we-are') ? { matchedShowId: 'here-we-are-2025' } : null);
  const copied = new Set(['blueberries-2026']);
  copyUrlOwnerFolder(src, tmp, 'blueberries-2026/wos.json', copied, { detect });
  assert.ok(copied.has('here-we-are-2025'));
  assert.ok(fs.existsSync(path.join(tmp, 'here-we-are-2025', 'wos--crompton.json')));
  // nothing to copy when no other folder holds it
  const copied2 = new Set();
  copyUrlOwnerFolder(src, fs.mkdtempSync(path.join(os.tmpdir(), 'pf-tmp-')), 'blueberries-2026/wos.json', copied2, { detect: () => null });
  assert.equal(copied2.size, 0);
});
