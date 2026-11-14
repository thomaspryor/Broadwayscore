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

// BRO-3018: the same for NOTION_API_KEY. After the stuck-work rows were
// retired no scheduled script reads it; the steps that still passed it were
// leftovers from when owner-alert-router shelled out to notion-brain.js.
// BRO-5845: autonomous-merge.yml (the retired nightly loop) stopped passing
// it too, so the allowlist is empty: no workflow may pass the key.
const NOTION_KEY_ALLOWED = new Set();

test('no workflow passes secrets.NOTION_API_KEY', () => {
  const files = fs.readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));
  const hits = [];
  for (const f of files) {
    if (NOTION_KEY_ALLOWED.has(f)) continue;
    fs.readFileSync(path.join(DIR, f), 'utf8').split('\n').forEach((line, i) => {
      if (/secrets\.NOTION_API_KEY\b/.test(line) && !line.trimStart().startsWith('#')) hits.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, []);
});

test('the NOTION_API_KEY allowlist has no stale entries', () => {
  for (const f of NOTION_KEY_ALLOWED) {
    const src = fs.readFileSync(path.join(DIR, f), 'utf8');
    assert.match(src, /secrets\.NOTION_API_KEY\b/, `${f} no longer uses the key; drop it from the allowlist`);
  }
});
