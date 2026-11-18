// BRO-7789 class guard: `git fetch --depth=1 ... main` into a checkout that has
// history grafts the new main tip as a parentless root. HEAD and origin/main
// then share no history, so every later fast-forward or rebase fails
// ("refusing to merge unrelated histories"). Seen 2026-11-18: makePathsOnMain
// (linear-cmd-execution.js) did this to the cloud main checkout during a card
// close, which disabled the session-start code-checkout sync for that container.
//
// Use repoDepthArgs() from scripts/lib/shallow-fetch-args.js instead. A fetch
// that is fine at depth 1 (a data repo reset to FETCH_HEAD, a throwaway CI
// checkout) carries `depth1-fetch-ok: <reason>` on its line or the line above.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const DIRS = ['scripts', '.claude/hooks'];
const EXT = /\.(js|mjs|cjs|ts|sh)$/;
const FETCH_DEPTH1_MAIN = /fetch.*--depth[= ]1\b.*\bmain\b|fetch.*\bmain\b.*--depth[= ]1\b/i;
const WAIVER = /depth1-fetch-ok:\s*\S/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); } else if (EXT.test(e.name) && !/\.test\.|\/tests?\//.test(p)) out.push(p);
  }
  return out;
}

export function findDepth1MainFetches(source) {
  const lines = source.split('\n');
  const hits = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    if (/^(#|\/\/|\*|\/\*)/.test(t)) return;
    if (!FETCH_DEPTH1_MAIN.test(line)) return;
    if (WAIVER.test(line) || (i > 0 && WAIVER.test(lines[i - 1]))) return;
    hits.push(i + 1);
  });
  return hits;
}

test('detector: flags a bare depth-1 main fetch, honours the waiver and comments', () => {
  assert.deepEqual(findDepth1MainFetches("run(['fetch', '-q', '--depth=1', 'origin', 'main'])"), [1]);
  assert.deepEqual(findDepth1MainFetches('git fetch origin main --depth 1'), [1]);
  assert.deepEqual(findDepth1MainFetches('# depth1-fetch-ok: data repo, reset to FETCH_HEAD\ngit fetch --depth 1 origin main'), []);
  assert.deepEqual(findDepth1MainFetches('// git fetch --depth=1 origin main is wrong'), []);
  assert.deepEqual(findDepth1MainFetches("run(['fetch', ...repoDepthArgs({ repoRoot }), 'origin', 'main'])"), []);
});

test('no unwaived depth-1 fetch of main in scripts/ or .claude/hooks/', () => {
  const bad = [];
  for (const d of DIRS) {
    const abs = path.join(ROOT, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of walk(abs)) {
      for (const n of findDepth1MainFetches(fs.readFileSync(f, 'utf8'))) bad.push(`${path.relative(ROOT, f)}:${n}`);
    }
  }
  assert.deepEqual(bad, [], `depth-1 fetch of main (use repoDepthArgs, or waive with depth1-fetch-ok: <reason>):\n${bad.join('\n')}`);
});
