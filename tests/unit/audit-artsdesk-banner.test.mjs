import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { classify, scan } = require('../../scripts/audit-artsdesk-banner.js');

test('classify flags banner prefix and trailing Image label', () => {
  assert.deepEqual(classify({ fullText: 'Help keep arts journalism alive. We’re rebuilding. Body Image' }), { banner: true, endsImage: true, words: 9 });
  assert.equal(classify({ fullText: 'A clean review ends here.' }).banner, false);
});

test('scan finds artsdesk files in show and _pending folders, ignores other outlets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-audit-'));
  const w = (rel, d) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), JSON.stringify(d)); };
  w('x-off-west-end-2026/artsdesk--a.json', { url: 'https://theartsdesk.com/theatre/x', fullText: 'Help keep arts journalism alive. Body', contentTier: 'truncated' });
  w('_pending/y-off-west-end-2026/artsdesk--b.json', { url: 'https://theartsdesk.com/theatre/y', fullText: 'Clean review text.' });
  w('x-off-west-end-2026/guardian--c.json', { url: 'https://theguardian.com/z', fullText: 'Help keep arts journalism alive' });
  const rows = scan(root, { year: '2026' });
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((r) => r.banner).length, 1);
  assert.ok(rows.some((r) => r.show.startsWith('_pending')));
});
