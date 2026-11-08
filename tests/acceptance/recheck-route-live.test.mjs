/**
 * Acceptance for BRO-7138 part 3 (route failed done claims back to work), run
 * by the nightly acceptance recheck after RECHECK-AFTER. Routing armed on
 * 2026-11-15 (recheck-route.js DEFAULT_ROUTE_FROM). Done means: the recheck
 * ran since then, every routing row since then is live (not shadow, not
 * refused), and if any night had a real failure that was not handed off, a
 * live batch card was filed for it. Reads the ledger from origin/main
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
  const refused = routes.filter((e) => !e.filed && !e.maybeFiled);
  assert.deepEqual(refused.map((e) => `${e.ts} ${e.note}`), [], 'live routing rows whose card was not filed');

  const handedOff = new Set(entries.filter((e) => e.event === 'recheck-handoff' && e.handedOff).map((e) => `${e.runId}|${e.cardId}`));
  const realFails = entries.filter((e) => e.event === 'recheck' && e.cardId && !e.skip
    && recheckVerdict(e).status === 'fail' && !handedOff.has(`${e.runId}|${e.cardId}`));
  if (realFails.length) {
    const filed = routes.filter((e) => e.filed && /^BRO-\d+$/.test(String(e.identifier || '')));
    assert.ok(filed.length >= 1, `${realFails.length} real recheck failure(s) since ${ARMED} (e.g. ${realFails.slice(0, 3).map((e) => e.cardId).join(', ')}) but no live batch card was filed`);
  }
});
