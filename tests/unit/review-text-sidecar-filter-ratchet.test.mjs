// BRO-4849: each show's data/review-texts/<show>/_blocklist.json is a {urls:[...]} sidecar, not a review.
// A sweep that skips only failed-fetches.json treats it as one: audit-coverage-holes listed 14 phantom
// no-URL holes, build-aggregator-truth counted it as a valid review, and opening-night-poller's pre-wipe
// stamped placeholder fields into it. Every review-texts sweep must also skip '_'-prefixed files.
// Ratchet: scripts still carrying the bare filter may only shrink, and the fixed ones stay fixed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BARE = /[!=]==\s*'failed-fetches\.json'/;
const GUARDED = /startsWith\('_'\)|BLOCKLIST_FILENAME|_blocklist|isReviewTextFile/; // isReviewTextFile: scripts/lib/review-text-sidecars.js (BRO-5342)
const BASELINE = 5; // 2026-10-19 (BRO-5342 swapped ~160 scripts to isReviewTextFile); was 126. Lower it as files get the guard.
const FIXED = ['scripts/audit-coverage-holes.js', 'scripts/build-aggregator-truth.js', 'scripts/opening-night-poller.js'];

function bareFilterFiles() {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
      if (!/\.(c|m)?js$/.test(e.name)) continue;
      const s = fs.readFileSync(p, 'utf8');
      if (BARE.test(s) && !GUARDED.test(s)) out.push(path.relative(ROOT, p));
    }
  })(path.join(ROOT, 'scripts'));
  return out;
}

test('no new review-texts sweep skips only failed-fetches.json (it must also skip _-prefixed sidecars)', () => {
  const files = bareFilterFiles();
  assert.ok(files.length <= BASELINE,
    `${files.length} scripts filter review-texts with only failed-fetches.json (baseline ${BASELINE}). Add \`|| f.startsWith('_')\` to the new one(s).`);
});

test('the sweeps fixed for BRO-4849 keep the sidecar guard', () => {
  const files = new Set(bareFilterFiles());
  for (const f of FIXED) {
    assert.ok(!files.has(f), `${f} lost its _-prefix guard`);
    assert.match(fs.readFileSync(path.join(ROOT, f), 'utf8'), /startsWith\('_'\)|isReviewTextFile/, `${f} must skip _-prefixed files`);
  }
});
