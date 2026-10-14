// BRO-3488: Notion is retired and no script reads NOTION_TOKEN (Notion code
// used NOTION_API_KEY). A workflow still passing secrets.NOTION_TOKEN is a
// dead leg that reads as live Notion coupling, so keep it from coming back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(import.meta.dirname, '..', '..', '.github', 'workflows');

test('no workflow passes the retired NOTION_TOKEN secret', () => {
  const files = fs.readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));
  assert.ok(files.length > 20, `scan looks truncated (${files.length} workflows)`);
  const hits = [];
  for (const f of files) {
    fs.readFileSync(path.join(DIR, f), 'utf8').split('\n').forEach((line, i) => {
      if (/secrets\.NOTION_TOKEN\b/.test(line) && !line.trimStart().startsWith('#')) hits.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, []);
});
