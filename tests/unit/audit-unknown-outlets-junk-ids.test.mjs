import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { countResolvableUnknowns } = require('../../scripts/audit-unknown-outlets.js');

test('BRO-5275: sentence-fragment ids are not registry gaps; a real unregistered outlet still is', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unk-'));
  try {
    const put = (show, file, data) => {
      fs.mkdirSync(path.join(dir, show), { recursive: true });
      fs.writeFileSync(path.join(dir, show, file), JSON.stringify({ showId: show, ...data }));
    };
    put('s-2026', 'a.json', { outletId: 'the-unthinkable-happens', outlet: 'x', url: 'https://example.com/a', fullText: 'text' });
    put('s-2026', 'b.json', { outletId: 'buy-tickets-direct-from-the-theatre', outlet: 'x', url: 'https://example.com/b', fullText: 'text' });
    put('s-2026', 'c.json', { outletId: 'someindieblog', outlet: 'Some Indie Blog', url: 'https://someindieblog.example/c', fullText: 'text' });
    const r = countResolvableUnknowns(dir, new Set(['variety']));
    assert.equal(r.resolvableUnknowns, 1);
    assert.equal(r.examples[0].outletId, 'someindieblog');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
