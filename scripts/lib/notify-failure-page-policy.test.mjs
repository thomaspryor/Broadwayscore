// BRO-4141: notify-failure emails the owner directly (severity critical +
// email true), outside page-worthy-alerts.js. A single failure of a job that is
// not an opening-night / site-down / backup job is not owner-actionable, so
// such callers must use min_consecutive_failures >= 2 (persistent breakage
// still emails). A new critical+email caller must pick a side here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

// Owner-approved categories (page-worthy-alerts.js header): opening-night
// pipeline dead, production/user-facing down, data loss.
const IMMEDIATE_PAGE_OK = new Set([
  'opening-night-broadcast.yml', 'opening-night-orchestrator.yml', 'opening-night-poller.yml',
  'opening-night-express.yml', 'restore-supabase.yml', 'test-ugc-roundtrip.yml', 'r2-cold-backup.yml',
]);

function criticalEmailCallers() {
  const dir = new URL('../../.github/workflows/', import.meta.url);
  const out = [];
  for (const f of readdirSync(dir).filter(n => n.endsWith('.yml'))) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    const blocks = src.split(/uses:\s*\.\/\.github\/actions\/notify-failure/).slice(1);
    for (const b of blocks) {
      const w = b.split(/\n\s*- (?:name|uses|run):/)[0];
      if (/severity:\s*['"]?critical/.test(w) && /email:\s*['"]?true/.test(w)) {
        const m = w.match(/min_consecutive_failures:\s*['"]?(\d+)/);
        out.push({ file: f, min: m ? Number(m[1]) : 1 });
      }
    }
  }
  return out;
}

test('critical+email notify-failure callers page on one failure only if owner-approved', () => {
  const callers = criticalEmailCallers();
  assert.ok(callers.length >= 8, `parser found only ${callers.length} callers — regex drifted?`);
  const bad = callers.filter(c => c.min < 2 && !IMMEDIATE_PAGE_OK.has(c.file)).map(c => c.file);
  assert.deepEqual(bad, [], `add min_consecutive_failures: '2' (or justify in IMMEDIATE_PAGE_OK): ${bad.join(', ')}`);
});
