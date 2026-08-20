/**
 * verify-watchdog-claim-loop-gone.test.mjs — the RECHECK-AFTER acceptance
 * command for task #1564's "the watchdog no longer re-claims a dispatch its
 * child refused" claim.
 *
 * Unlike this repo's usual colocated tests, this one deliberately asserts
 * against LIVE repo data (data/audit/dispatch-ledger.jsonl) rather than a
 * fixture — its whole purpose is to be re-run by
 * scripts/autonomous-acceptance-recheck.js days after the fix landed, against
 * whatever real dispatch volume has accumulated. A red run here is not a code
 * regression; it is the claim being disproven. Same pattern as
 * scripts/verify-dispatch-dead-rate-recovery.test.mjs.
 *
 * Why it cannot be checked on the day it shipped: the loop spends the
 * watchdog's perDay claim budget (CAPS.perDay = 12), and on 2026-08-19 that
 * budget was already spent by the very burst this fix exists to stop. The
 * behaviour under test — claims spreading across DISTINCT cards instead of
 * piling onto the same one — is only observable after the budget resets.
 *
 * The ledger path is the CANONICAL repo root, not a path relative to this
 * file: dispatch-ledger.jsonl is gitignored and per-machine, and the recheck
 * runs from a fresh detached checkout that would never contain it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const LEDGER = path.join('/Users/tompryor/Broadwayscore', 'data', 'audit', 'dispatch-ledger.jsonl');

// The fix's merge time. Only claims AFTER this are the population under test —
// the pre-fix bursts (12 claims across 2 tasks on 08-19, 9 on 08-18, 7 on
// 08-17, and taskId 383's historic 56) are expected to still look terrible.
const FIX_LANDED_MS = Date.parse('2026-08-19T14:40:00Z');

// One claim per card is the design. Two tolerates the genuine re-arm path (a
// claim older than REDISPATCH_REARM_MS becomes eligible again, so a card that
// stays broken for days legitimately collects one claim per day). Three or
// more UNLANDED claims on one card inside a single day is the loop.
const MAX_UNLANDED_CLAIMS_PER_TASK_PER_DAY = 2;
const MIN_CLAIMS = 6;   // below this there is not enough signal to judge

test('#1564: the watchdog no longer re-claims the same card it could not start', () => {
  let lines;
  try {
    lines = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean);
  } catch {
    assert.fail(`no dispatch ledger at ${LEDGER} — it is per-machine and gitignored; run this where dispatches actually launch`);
  }
  const entries = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  const post = entries.filter((e) => e.ts && Date.parse(e.ts) >= FIX_LANDED_MS);
  const claims = post.filter((e) => e.event === 'watchdog-redispatch' && e.taskId != null);
  assert.ok(
    claims.length >= MIN_CLAIMS,
    `only ${claims.length} watchdog claim(s) since the fix landed (${new Date(FIX_LANDED_MS).toISOString()}) — needs >= ${MIN_CLAIMS} to judge; too early to call, not a failure of the fix`,
  );

  // A claim "landed" if a launch for the same task followed it. Group the
  // rest by task and local day — the loop's signature is many unlanded claims
  // on ONE card in ONE day, which is exactly what the perDay budget then pays
  // for while nothing launches.
  const launchMs = new Map();
  for (const e of post) {
    if (e.event !== 'launch' || e.taskId == null || !e.ts) continue;
    const id = String(e.taskId);
    const ms = Date.parse(e.ts);
    if (Number.isFinite(ms) && (!launchMs.has(id) || ms > launchMs.get(id))) launchMs.set(id, ms);
  }
  const byTaskDay = new Map();
  for (const c of claims) {
    const id = String(c.taskId);
    const ms = Date.parse(c.ts);
    if (!Number.isFinite(ms)) continue;
    const landed = launchMs.has(id) && launchMs.get(id) >= ms;
    if (landed) continue;
    const key = `${id}@${new Date(ms).toISOString().slice(0, 10)}`;
    byTaskDay.set(key, (byTaskDay.get(key) || 0) + 1);
  }

  const offenders = [...byTaskDay.entries()]
    .filter(([, n]) => n > MAX_UNLANDED_CLAIMS_PER_TASK_PER_DAY)
    .sort((a, b) => b[1] - a[1]);

  assert.deepEqual(
    offenders, [],
    `the redispatch loop is back: ${offenders.map(([k, n]) => `${k} claimed ${n}x with no launch`).join('; ')}`
    + ` — planSweep should be skipping a task whose latest watchdog-redispatch is newer than its latest launch`
    + ` (scripts/lib/dispatch-watchdog-core.js watchdogClaimPending)`,
  );
});
