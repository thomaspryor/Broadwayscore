import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { canonicalBritishTheatreUrl } = require('./britishtheatre-locale-url.js');

test('only British Theatre locale-prefixed post URLs are normalized', () => {
  for (const locale of ['ar', 'ko', 'fr', 'es', 'de', 'ja', 'zh', 'pt', 'it']) {
    assert.equal(canonicalBritishTheatreUrl(`https://www.britishtheatre.com/${locale}/posts/example?x=1#part`), 'https://www.britishtheatre.com/posts/example?x=1#part');
  }
  for (const url of ['https://britishtheatre.com/de/shows/example', 'https://britishtheatre.com/posts/example', 'https://britishtheatre.com.evil.test/ar/posts/example', 'https://other.test/ar/posts/example', 'not a url', null]) {
    assert.equal(canonicalBritishTheatreUrl(url), url);
  }
});

test('the shared writer stores the canonical URL', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'britishtheatre-url-'));
  try {
    const { createOrMergeReviewFile } = require('./review-file-writer.js');
    const result = createOrMergeReviewFile('made-in-dagenham-west-end-2014', {
      outletId: 'britishtheatrecom', outlet: 'BritishTheatre.com', criticName: 'Stephen Collins',
      url: 'https://www.britishtheatre.com/pt/posts/review-made-dagenham-adelphi-theatre-4stars',
      source: 'ingest-urls', fields: {},
    }, { reviewTextsDir: dir });
    assert.ok(result.filepath, JSON.stringify(result));
    assert.equal(JSON.parse(fs.readFileSync(result.filepath, 'utf8')).url, 'https://www.britishtheatre.com/posts/review-made-dagenham-adelphi-theatre-4stars');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
