// Guards the BRO-6899 rename (Diary/Watchlist/Feed -> Seen/To See/Photos).
// The first sweep missed multi-line JSX text, aria-labels and a script
// selector, so this scans for the retired user-facing phrases directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../..', import.meta.url).pathname;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|js)$/.test(p) && !/\.test\./.test(p)) out.push(p);
  }
  return out;
}

const RETIRED = [
  /Add to watchlist/i,
  /Remove from watchlist/i,
  /On your watchlist/i,
  /Your diary (is|has) started/i,
  /Your Feed is/,
  /"Diary views"/,
  /"Feed view"/,
  /shows in your diary/i,
  /My Watched Shows/,
  /Tap Watchlist on/,
  /Keep a watchlist/i,
  /Failed to load watchlist/i,
  /^\s*Watchlist\s*$/,
];

test('retired My Shows names do not appear in user-facing source', () => {
  const files = [...walk(join(root, 'src')), join(root, 'scripts/lib/welcome-email.js'), join(root, 'scripts/lib/reddit-post-screenshots.js')];
  const bad = [];
  for (const f of files) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
      if (RETIRED.some(re => re.test(line))) bad.push(`${f.replace(root, '')}:${i + 1}: ${t}`);
    });
  }
  assert.deepEqual(bad, []);
});
