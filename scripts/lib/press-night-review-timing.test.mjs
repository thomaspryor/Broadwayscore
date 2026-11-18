// BRO-7767: a press-night review (hand-ingested 12:00am ET) went live 36 min later
// (bar 30) because the show-scoped scoring run ran the global --validate pass
// (~4.5 min over every show) before pushing the score. Show-scoped runs must skip it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const wf = fs.readFileSync(path.join(root, '.github/workflows/llm-ensemble-score.yml'), 'utf8');

test('scoring workflow: --validate is gated on an empty show_id', () => {
  const m = wf.match(/if \[ "\$\{\{ github\.event\.inputs\.run_validation \}\}" == "true" \]([^\n]*)\n\s*ARGS="\$ARGS --validate"/);
  assert.ok(m, 'validate step present');
  assert.match(m[1], /-z "\$\{\{ github\.event\.inputs\.show_id \}\}"/, 'show-scoped runs must skip --validate');
});

test('record check still fails on the original NY Sun lateness (history not rewritten)', () => {
  const rec = JSON.parse(fs.readFileSync(path.join(root, 'data/audit/press-night/blue-man-group-a-new-holiday-surprise-2026-2026-11-17.json'), 'utf8'));
  const sun = rec.perReview.find((r) => /new york sun/i.test(r.outlet));
  const lagMin = (Date.parse(sun.firstLiveAt) - Date.parse(rec.fileState.files.find((f) => f.outletId === 'new-york-sun').firstSeenAt)) / 60000;
  assert.ok(lagMin > 30, `record keeps the miss (${lagMin.toFixed(0)} min)`);
});
