/**
 * BRO-2272: cross-market rescue must not force-include a different
 * production's reviews. Real shape: 2024 West End "A View from the Bridge"
 * reviews (Independent, Telegraph) were moved onto the 2026 Off-Broadway
 * production on ID distance alone, stamped allowEarlyDate + override.
 *
 * Run: node --test scripts/lib/migrate-reroute-backlog.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { crossMarketDateGate, stripBypassFlags, BYPASS_FLAGS } = require('./reroute-stamp-policy.js');
const { decideCrossMarketReroute } = require('./cross-market-reroute-guard.js');

const AVFTB_2026 = {
  id: 'a-view-from-the-bridge-off-broadway-2026', title: 'A View from the Bridge',
  venue: 'Theatre Row', openingDate: '2026-05-10', previewsStartDate: '2026-04-20',
  creativeTeam: [{ name: 'Neil Pepe', role: 'Director' }],
};
const REGISTRY = { outlets: { telegraph: { isDualMarket: true, domain: 'telegraph.co.uk' } } };

test('2024 review of a different production is refused by the date gate', () => {
  const g = crossMarketDateGate({ publishDate: '2024-02-14' }, AVFTB_2026);
  assert.equal(g.ok, false);
  assert.match(g.reason, /before-target-window/);
});

test('review inside the target window passes', () => {
  assert.equal(crossMarketDateGate({ publishDate: '2026-05-12' }, AVFTB_2026).ok, true);
});

test('missing publishDate is refused (no corroboration)', () => {
  assert.equal(crossMarketDateGate({}, AVFTB_2026).ok, false);
});

test('review long after closing is refused', () => {
  const closed = { ...AVFTB_2026, closingDate: '2026-06-30' };
  assert.equal(crossMarketDateGate({ publishDate: '2027-06-01' }, closed).ok, false);
});

test('an existing allowEarlyDate on the review does not rescue an early date', () => {
  const g = crossMarketDateGate({ publishDate: '2024-02-14', allowEarlyDate: true, wrongProductionOverride: true }, AVFTB_2026);
  assert.equal(g.ok, false);
});

test('LLM-guessed publishDate is refused even when it looks in-window', () => {
  assert.equal(crossMarketDateGate({ publishDate: '2026-05-12', dateSource: 'llm-scoring' }, AVFTB_2026).ok, false);
});

test('target with no start date is refused (no lower bound to check)', () => {
  assert.equal(crossMarketDateGate({ publishDate: '2026-05-12' }, { id: 'x' }).ok, false);
});

test('stripBypassFlags removes every bypass flag, nothing else', () => {
  const d = { allowEarlyDate: true, allowLateDate: true, wrongProductionOverride: true, keep: 1 };
  stripBypassFlags(d);
  for (const f of BYPASS_FLAGS) assert.ok(!(f in d));
  assert.equal(d.keep, 1);
});

test('guard still refuses a Telegraph review naming no target venue/director', () => {
  const v = decideCrossMarketReroute({
    file: { url: 'https://www.telegraph.co.uk/x', fullText: 'Dominic West and Lindsay Posner at the Young Vic.' },
    candidateShow: AVFTB_2026, outletRegistry: REGISTRY,
  });
  assert.equal(v.allow, false);
});

test('migrate script wires the date gate and never stamps allowEarlyDate cross-market', () => {
  const src = fs.readFileSync(new URL('../migrate-reroute-backlog.js', import.meta.url), 'utf8');
  assert.match(src, /crossMarketDateGate\(data, targetShow\)/);
  assert.match(src, /stripBypassFlags\(sourceData\)/);
  assert.match(src, /distance >= 2 && !CROSS_MARKET/);
});
