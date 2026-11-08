/**
 * Acceptance for BRO-7138 part 3 (route failed done claims back to work), run
 * by the nightly acceptance recheck after RECHECK-AFTER. Routing armed on
 * 2026-11-15 (recheck-route.js DEFAULT_ROUTE_FROM). Done means: the recheck
 * ran since then, every routing row since then is live (not shadow, not
 * refused unless a later night recovered), at most one batch card a night,
 * and every real failure not handed off sits in a routed batch. Reads the ledger from origin/main
 * (fetched), so it judges what CI wrote, not this checkout.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { recheckVerdict } = require('../../scripts/lib/check-env-cause.js');

const ARMED = '2026-11-15';
// Two nights after arming, so the first live night has happened.
const RECHECK_AFTER = '2026-11-17';
const due = new Date().toISOString().slice(0, 10) >= RECHECK_AFTER;

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 }).trim();

test('BRO-7138: failed done claims are routed back to work by a live batch card', { skip: due ? false : `not due before ${RECHECK_AFTER}` }, () => {
  git(['fetch', '-q', 'origin', 'main']);
  const entries = git(['show', 'origin/main:data/audit/autonomous-recheck-ledger.jsonl'])
    .split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    .filter((e) => typeof e.ts === 'string' && e.ts.slice(0, 10) >= ARMED);

  const summaries = entries.filter((e) => e.event === 'recheck-summary');
  assert.ok(summaries.length >= 1, `the nightly recheck wrote no summary since ${ARMED}`);

  const routes = entries.filter((e) => e.event === 'recheck-route');
  const notLive = routes.filter((e) => e.mode !== 'live');
  assert.deepEqual(notLive.map((e) => `${e.ts} ${e.mode}`), [], 'routing rows since arming that were not live (shadow or off)');
  // One batch card per night: at most one filed (or maybe-filed) row per run.
  const landed = routes.filter((e) => e.filed || e.maybeFiled);
  const perRun = {};
  for (const e of landed) perRun[e.runId] = (perRun[e.runId] || 0) + 1;
  assert.deepEqual(Object.entries(perRun).filter(([, n]) => n > 1), [], 'more than one batch card filed in one night');
  for (const e of routes.filter((r) => r.filed)) assert.match(String(e.identifier || ''), /^BRO-\d+$/, `filed route row ${e.ts} has no card id`);

  // A card counts as routed once any live row filed (or maybe filed) it.
  // A refused night is fine if a later night routed the same cards.
  const routedAt = new Map();
  for (const e of landed) for (const id of e.cardIds || []) if (!routedAt.has(id)) routedAt.set(id, e.ts);
  const unrecovered = routes.filter((e) => !e.filed && !e.maybeFiled)
    .filter((e) => (e.cardIds || []).some((id) => !(routedAt.has(id) && routedAt.get(id) > e.ts)));
  assert.deepEqual(unrecovered.map((e) => `${e.ts} ${e.note}`), [], 'refused routing rows whose cards no later night routed');

  // Every real failure (not env, not handed off) since arming must sit in a
  // routed batch, unless its night's batch overflowed the per-batch cap.
  const handedOff = new Set(entries.filter((e) => e.event === 'recheck-handoff' && e.handedOff).map((e) => `${e.runId}|${e.cardId}`));
  const overflowRuns = new Set(routes.filter((e) => Number(e.overflow) > 0).map((e) => e.runId));
  const unrouted = entries.filter((e) => e.event === 'recheck' && e.cardId && !e.skip
    && recheckVerdict(e).status === 'fail' && !handedOff.has(`${e.runId}|${e.cardId}`)
    && !routedAt.has(e.cardId) && !overflowRuns.has(e.runId));
  assert.deepEqual([...new Set(unrouted.map((e) => e.cardId))], [],
    'real recheck failures since arming that no batch card routed (routing off, threw, or skipped them)');
});
