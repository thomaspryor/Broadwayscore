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
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEDGER = path.join(ROOT, 'data', 'audit', 'scraper-spend-ledger.jsonl');

// The landing. Only full UTC days strictly after this count.
const LANDED_DAY = '2026-09-20';

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
    // BRO-4146: the owner keeps a daily historical backfill (closed shows); its
    // first-time SERP spend is intended and uncacheable, so it is excluded here.
    if (r.purpose === 'historical-backfill') continue;
    const day = String(r.ts || '').slice(0, 10);
    if (!day) continue;
    out.set(day, (out.get(day) || 0) + (Number(r.credits) || 0));
  }
  return out;
}

// BRO-447: this used to assert credits/day < 5,000. That ceiling assumed flat
// dispatch volume (60-90 show-runs/day in September); the October openings ran
// ~70 gather-reviews dispatches/day and spend rose with them while the SERP
// cache was healthy (repo cache 4.4 GiB, fresh bd-serp-cache-* hits), so the
// probe went red on real demand and reddened check-corpus-drift daily. Both
// regressions it ever caught (checkout-core-data in BRO-3887, the Vercel build
// cache in BRO-4146) were the repo crossing GitHub's 10 GiB cache cap, which
// LRU-evicts the whole namespace. That is now asserted directly below; the
// daily credits are still printed for context. Overall spend is policed by
// check-provider-spend.js (data-health-check.yml).
const CACHE_EVICTION_CAP_BYTES = 10 * 1024 ** 3;
// Unmeasured headroom: 2 GiB below the cap, chosen with usage at 4.4 GiB.
const CACHE_USAGE_CEILING_BYTES = 8 * 1024 ** 3;

test('BRO-3887: gather-reviews.js daily scraper credits (diagnostic)', (t) => {
  if (!fs.existsSync(LEDGER)) {
    t.skip('scraper-spend-ledger.jsonl absent (private core data not checked out)');
    return;
  }
  const byDay = creditsByDay('gather-reviews.js');
  // Today is excluded: a partial day always looks cheap.
  const today = new Date().toISOString().slice(0, 10);
  const days = [...byDay.keys()].filter((d) => d > LANDED_DAY && d < today).sort().slice(-3);
  t.diagnostic(`gather-reviews.js credits/day, excluding historical-backfill: ${days.map((d) => `${d}=${byDay.get(d)}`).join(', ') || 'no complete day yet'}`);
});

test('BRO-3887: repo Actions cache stays below the size that evicts the SERP cache', (t) => {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    t.skip('no GH_TOKEN/GITHUB_TOKEN (check-corpus-drift.yml passes one)');
    return;
  }
  const repo = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';
  // A token that is set but cannot read the usage fails here on purpose, so a
  // missing `actions: read` permission cannot turn this into a silent skip.
  let usage;
  try {
    usage = JSON.parse(
      execFileSync('gh', ['api', `repos/${repo}/actions/cache/usage`], { encoding: 'utf8', env: { ...process.env, GH_TOKEN: token } }),
    );
  } catch (e) {
    assert.fail(`could not read cache usage (not a cache-size finding; check the job's actions: read permission or GitHub API status): ${String(e.stderr || e.message).trim()}`);
  }
  const bytes = Number(usage.active_caches_size_in_bytes);
  assert.ok(Number.isFinite(bytes), `unexpected cache usage payload: ${JSON.stringify(usage)}`);
  const gib = (n) => (n / 1024 ** 3).toFixed(2);
  t.diagnostic(`repo Actions cache: ${gib(bytes)} GiB across ${usage.active_caches_count} entries`);
  assert.ok(
    bytes < CACHE_USAGE_CEILING_BYTES,
    `repo Actions cache is ${gib(bytes)} GiB; past ${gib(CACHE_EVICTION_CAP_BYTES)} GiB GitHub LRU-evicts every ` +
      'entry, including the KB-sized bd-serp-cache-* that gather-reviews.js relies on, and SERP spend jumps ' +
      '(BRO-3887, BRO-4146). Find the biggest keys: `gh cache list --sort size_in_bytes --limit 20`; scripts/prune-github-actions-cache.js prunes by key prefix.',
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
