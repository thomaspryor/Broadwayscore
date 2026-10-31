// BRO-6585: ingest-urls passes the page date as input.publishDate (top level);
// the writer used it for its guards but never wrote it, so the file was undated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

test('a top-level publishDate is written to a new review file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-'));
  fs.mkdirSync(path.join(dir, 'a-few-good-men-2026'));
  const { createOrMergeReviewFile } = require('./review-file-writer.js');
  const r = createOrMergeReviewFile('a-few-good-men-2026', {
    outletId: 'new-york-sun', outlet: 'The New York Sun', criticName: 'Elysa Gardner', bylineFromOwnPage: true,
    url: 'https://www.nysun.com/article/aaron-sorkin-once-again-handles-the-truth-in-timely-a-few-good-men',
    source: 'ingest-urls', publishDate: '2026-10-29', fields: { fullText: 'word '.repeat(400) },
  }, { reviewTextsDir: dir });
  assert.ok(r.filepath, JSON.stringify(r));
  assert.equal(JSON.parse(fs.readFileSync(r.filepath, 'utf8')).publishDate, '2026-10-29');
});
