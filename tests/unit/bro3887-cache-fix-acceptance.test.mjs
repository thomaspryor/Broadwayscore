// TESTS-VS-DERIVED-DATA-EXEMPT: this asserts a live OPERATIONAL property (scraper
// spend recorded in data/audit/scraper-spend-ledger.jsonl), not a factual claim
// about shows/reviews. It deliberately reads whatever the ledger currently says
// rather than pinning any value, which is the point of a deferred-effect probe.
//
// BRO-3887 acceptance probe — RECHECK-AFTER: 2026-09-22
//
// The fix (main @ 277c2b3fa90) deleted a run-id-keyed 3.4 GiB actions/cache from
// .github/actions/checkout-core-data. That cache had pushed the repo to 28.06 GiB
// against GitHub's 10 GiB limit, so LRU eviction wiped the whole namespace roughly
// hourly — including the 22 KB SERP cache (scripts/lib/serp-cache.js, 24h TTL).
// With it evicted, each of opening-night-reviews.yml's 8 daily ticks re-paid for
// SERP queries it had already answered, and gather-reviews.js went from 360 to
// 9,178 scraper credits/day while dispatch volume stayed flat (show-runs/day
// 68,62,66,72,91,61,35 across 09-14..09-20).
//
// That claim CANNOT be verified at landing time — it needs a full day of ticks
// running against the fixed action. Hence Paused + RECHECK-AFTER rather than Done
// (the pattern from scripts/verify-provider-spend-streak.test.mjs):
// scripts/autonomous-acceptance-recheck.js picks this up in shadow mode once the
// date passes and reports pass/fail against fresh origin/main.
//
// Threshold rationale: the pre-fix peak was 9,178-10,468 credits/day and the
// pre-regression baseline (09-16) was 2,026. 5,000 sits between them — comfortably
// under the broken régime, comfortably over the target, so a genuine burst of real
// openings does not produce a false failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEDGER = path.join(ROOT, 'data', 'audit', 'scraper-spend-ledger.jsonl');

// The landing. Only full UTC days strictly after this count.
const LANDED_DAY = '2026-09-20';
const CREDITS_PER_DAY_CEILING = 5000;

function creditsByDay(script) {
  const out = new Map();
  const raw = fs.readFileSync(LEDGER, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue; // a partially-flushed final line is normal for a JSONL ledger
    }
    if (r.script !== script) continue;
    const day = String(r.ts || '').slice(0, 10);
    if (!day) continue;
    out.set(day, (out.get(day) || 0) + (Number(r.credits) || 0));
  }
  return out;
}

test('BRO-3887: gather-reviews.js daily scraper credits are back under control', (t) => {
  if (!fs.existsSync(LEDGER)) {
    t.skip('scraper-spend-ledger.jsonl absent (private core data not checked out)');
    return;
  }
  const byDay = creditsByDay('gather-reviews.js');

  // Only full days after the landing are evidence. Today is excluded — a partial
  // day always looks cheap and would make this probe pass for the wrong reason.
  const today = new Date().toISOString().slice(0, 10);
  const days = [...byDay.keys()].filter((d) => d > LANDED_DAY && d < today).sort();

  if (days.length === 0) {
    t.skip(`no complete UTC day after ${LANDED_DAY} in the ledger yet — recheck later`);
    return;
  }

  const recent = days.slice(-3);
  const offenders = recent.filter((d) => byDay.get(d) > CREDITS_PER_DAY_CEILING);
  const detail = recent.map((d) => `${d}=${byDay.get(d)}`).join(', ');

  assert.deepEqual(
    offenders,
    [],
    `gather-reviews.js is still over ${CREDITS_PER_DAY_CEILING} credits/day (${detail}). ` +
      'Pre-fix peak was 9,178-10,468/day; the 09-16 baseline was 2,026. If this fails, ' +
      'check first whether the SERP cache is surviving between runs: ' +
      '`gh cache list --json key,sizeInBytes | grep bd-serp-cache` should show an entry, ' +
      'and a gather-reviews job log should report "Cache restored from key: bd-serp-cache-" ' +
      'from a PREVIOUS run id, not the current one.',
  );
});

test('BRO-3887: no core-data actions/cache step has been reintroduced', () => {
  // The spend regression is downstream of this one line of YAML, so the probe
  // checks the cause as well as the symptom — the symptom takes a day to read,
  // this is instant and is what would actually regress.
  const action = fs.readFileSync(
    path.join(ROOT, '.github', 'actions', 'checkout-core-data', 'action.yml'),
    'utf8',
  );
  const live = action
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  assert.ok(
    !/uses:\s*['"]?actions\/cache/.test(live),
    'checkout-core-data must not cache its clone — it saved 3.4 GiB per job across 243 ' +
      'jobs and evicted the entire repo cache namespace hourly (BRO-3887)',
  );
});
