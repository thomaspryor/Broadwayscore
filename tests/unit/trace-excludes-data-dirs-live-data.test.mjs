// LIVE-DATA-LANE: traces the real detect-route graph over the untracked private core data trees (BRO-7101); runs in check-corpus-drift.yml, not test.yml's blocking batch.
// BRO-8136: size budget for the real api/admin/ingest-review/detect require graph.
// The blocking guards (config excludes, synthetic fixture, directory-name scan)
// live in trace-excludes-data-dirs.test.mjs and need no data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const configText = readFileSync(join(ROOT, 'next.config.js'), 'utf8');
const excludes = new Function(
  `return [${configText.match(/outputFileTracingExcludes:\s*\{\s*'\*\*\/\*':\s*\[([\s\S]*?)\n\s*\],\s*\n(?:\s*\.\.\.[^\n]*\n)?\s*\},/)[1]}];`,
)();

function nft() {
  try {
    return require(join(ROOT, 'node_modules/next/dist/compiled/@vercel/nft')).nodeFileTrace;
  } catch {
    return null;
  }
}

test('real detect-route graph stays under the function size budget (when data is present)', async (t) => {
  const nodeFileTrace = nft();
  const entries = [
    'scripts/lib/review-normalization.js',
    'scripts/lib/byline-normalization.js',
    'scripts/lib/critic-fill-rules.js',
    'scripts/lib/review-write-guard.js',
  ];
  if (!nodeFileTrace || !entries.every(e => existsSync(join(ROOT, e)))) return t.skip('nft or entry modules missing');
  // Without the private core data the trace measures almost nothing; say so
  // instead of passing silently (checks 1, 2 and 4 still guard a bare checkout).
  if (!existsSync(join(ROOT, 'data', 'reviews.json'))) return t.skip('private core data absent: size budget not measurable here');
  const { fileList } = await nodeFileTrace(entries, {
    base: ROOT,
    processCwd: ROOT,
    ignore: [...excludes, 'node_modules/**'],
  });
  let total = 0;
  for (const f of fileList) {
    try {
      const st = statSync(join(ROOT, f));
      if (st.isFile()) total += st.size;
    } catch { /* file vanished or unreadable */ }
  }
  const mb = total / 1e6;
  // Vercel's hard limit is 250MB uncompressed including node_modules; the
  // repo-file part of this graph measured 138MB on 2026-11-23 after the fix.
  assert.ok(mb < 200, `detect route traces ${mb.toFixed(0)}MB of repo files (budget 200MB); a data/ tree is leaking in`);
});
