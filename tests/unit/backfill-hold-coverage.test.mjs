// BRO-4990: every script that reads commercial-pending-review.json AND writes
// commercial.json must honor the backfill human-review hold
// (commercial-apply-gate.requiresHumanReview). A new pending->commercial
// writer that skips it would publish unreviewed backfill research to /biz.
import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPTS = path.join(ROOT, 'scripts');

// Read pending only as classifier input; never copy pending values into
// commercial.json. Re-check before adding anything here.
const NOT_PENDING_APPLIERS = new Set([
  'scripts/classify-stale-closures.js',
]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(c?js|mjs)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
  }
  return out;
}

describe('backfill human-review hold coverage', () => {
  it('every pending->commercial.json writer checks requiresHumanReview', () => {
    const missing = [];
    for (const file of walk(SCRIPTS)) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      if (NOT_PENDING_APPLIERS.has(rel)) continue;
      const src = fs.readFileSync(file, 'utf8');
      const readsPending = /commercial-pending-review\.json/.test(src) && /PENDING_PATH|pending\.shows/.test(src);
      const writesCommercial = /\bsaveCommercial\s*\(/.test(src);
      if (readsPending && writesCommercial && !/requiresHumanReview/.test(src)) missing.push(rel);
    }
    assert.deepEqual(missing, [], `these scripts move pending entries into commercial.json without the backfill hold: ${missing.join(', ')}`);
  });

  // A writer that REPLACES a pending row drops requiresHumanReview, and the
  // next weekly bulk apply publishes the unreviewed backfill (ship-check
  // P1: backfill-commercial-o4mini.js did exactly this).
  it('every pending row replacement spreads the old row or carries the hold', () => {
    const bad = [];
    const assign = /pending\.shows\[[^\]]+\]\s*=\s*([^;]{0,120})/g;
    for (const file of walk(SCRIPTS)) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      const src = fs.readFileSync(file, 'utf8');
      if (!/commercial-pending-review\.json/.test(src)) continue;
      for (const m of src.matchAll(assign)) {
        const rhs = m[1].trimStart();
        if (/^\{\s*\.\.\./.test(rhs) || /^(carryHumanReviewHold|holdForBackfill)\(/.test(rhs)) continue;
        const line = src.slice(0, m.index).split('\n').length;
        bad.push(`${rel}:${line}`);
      }
    }
    assert.deepEqual(bad, [], `wrap these pending.shows[...] replacements in carryHumanReviewHold(prev, next): ${bad.join(', ')}`);
  });
});

// Owner exception 2026-10-10: closed shows already TBD in commercial.json get
// researched with --hold-for-review. Without it the non-backfill path bumps
// researchAttempts in commercial.json and leaves the pending row unheld.
describe('--hold-for-review', () => {
  it('forces the held path in the script and is wired through the workflow', () => {
    const src = fs.readFileSync(path.join(SCRIPTS, 'deep-research-commercial.js'), 'utf8');
    assert.match(src, /const HOLD_ALL = flags\['hold-for-review'\] === true;/);
    assert.match(src, /const isBackfill = HOLD_ALL \|\| backfillSlugSet\.has\(slug\);/);
    assert.match(src, /if \(!DRY_RUN && !isBackfill\) \{/, 'commercial.json writes must stay behind !isBackfill');
    const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'deep-research-commercial.yml'), 'utf8');
    assert.match(wf, /hold_for_review:/);
    assert.match(wf, /inputs\.hold_for_review \}\}" = "true" \]; then\s+ARGS="\$ARGS --hold-for-review"/);
  });
});
