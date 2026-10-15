// BRO-4444: the audit finds each BRO-4430 drop class and is silent on a repaired corpus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { auditCorpus } = require('./audit-coverage-slot-drops.js');

function corpus(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-audit-'));
  for (const [rel, data] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), JSON.stringify(data));
  }
  return dir;
}
const text = 'x'.repeat(300);

test('flags each drop class', () => {
  const dir = corpus({
    'show-a/theatre-record--x.json': { criticName: 'A Critic', fullText: text, url: 'https://www.broadwayworld.com/article/Review-Roundup-Foo-20260101' },
    'show-a/nysr--finkle.json': { criticName: 'David Finkle', fullText: text, url: 'https://nysr.example.com/review/abc' },
    'show-a/nysr--scheck.json': { criticName: 'Frank Scheck', fullText: text, url: 'https://nysr.example.com/review/abc' },
    'show-b/dateless.json': { criticName: 'Dee Late', wrongProduction: true, wrongProductionReason: 'dateless-revival', url: 'https://www.nytimes.com/2026/01/01/theater/x.html' },
    'show-b/flagged.json': { criticName: 'Flag Ged', wrongShow: true, url: 'https://www.theatermania.com/shows/' },
  });
  const byFile = Object.fromEntries(auditCorpus(dir).map((c) => [`${c.show}/${c.filename}`, c.classes]));
  assert.ok(byFile['show-a/theatre-record--x.json'].includes('aggregator-url'));
  assert.ok(byFile['show-a/nysr--finkle.json'].includes('other-critic-url'));
  assert.ok(byFile['show-a/nysr--scheck.json'].includes('other-critic-url'));
  assert.ok(byFile['show-b/dateless.json'].includes('dateless-hold'));
  assert.ok(byFile['show-b/flagged.json'].includes('flagged-non-review'));
});

test('emits nothing for a repaired corpus', () => {
  const dir = corpus({
    'show-a/a.json': { criticName: 'A Critic', fullText: text, url: 'https://www.nytimes.com/2026/01/01/theater/a.html' },
    'show-a/b.json': { criticName: 'B Critic', fullText: text, url: 'https://www.vulture.com/article/b.html' },
    'show-a/locked.json': { criticName: 'L', fullText: text, _locked: true, url: 'https://www.broadwayworld.com/article/Review-Roundup-Foo-20260101' },
    'show-a/failed-fetches.json': [],
  });
  assert.deepEqual(auditCorpus(dir), []);
});

test('missing corpus dir yields no candidates', () => {
  assert.deepEqual(auditCorpus('/nonexistent-dir-xyz'), []);
});
