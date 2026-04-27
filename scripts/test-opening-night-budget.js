#!/usr/bin/env node
/**
 * Unit tests for scripts/lib/opening-night-budget.js
 *
 * Run: node scripts/test-opening-night-budget.js
 */

'use strict';

const { estimateBudget, checkBudget, DEFAULT_PER_SHOW } = require('./lib/opening-night-budget');

let passed = 0;
let failed = 0;

async function test(description, fn) {
  try {
    await fn();
    console.log(`  ✓ ${description}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ FAIL: ${description}`);
    console.log(`      ${e.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'expected equal'} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}

function plentyUsage() {
  return {
    scrapingbee: { remaining: 5_000_000 },
    browserbase: { remaining: null },
    anthropic:   { remaining: null },
    openai:      { remaining: null },
    gemini:      { remaining: null },
    gha_minutes: { remaining: 1900 },
  };
}

async function main() {
  console.log('\n── estimateBudget ──');

  await test('N=0 zero totals across all resources', () => {
    const e = estimateBudget(0);
    assertEq(e.scrapingbee.total, 0);
    assertEq(e.browserbase.total, 0);
    assertEq(e.anthropic.total, 0);
    assertEq(e.openai.total, 0);
    assertEq(e.gemini.total, 0);
    assertEq(e.gha_minutes.total, 0);
  });

  await test('N=1 uses default perShow numbers', () => {
    const e = estimateBudget(1);
    assertEq(e.scrapingbee.perShow, DEFAULT_PER_SHOW.scrapingbee);
    assertEq(e.scrapingbee.total, DEFAULT_PER_SHOW.scrapingbee);
    assertEq(e.browserbase.total, DEFAULT_PER_SHOW.browserbase);
    assertEq(e.anthropic.total, DEFAULT_PER_SHOW.anthropic);
    assertEq(e.gha_minutes.total, DEFAULT_PER_SHOW.gha_minutes);
  });

  await test('N=5 multiplies linearly', () => {
    const e = estimateBudget(5);
    assertEq(e.scrapingbee.total, 250000);
    assertEq(e.browserbase.total, 25);
    assertEq(e.anthropic.total, 2.0);
    assertEq(e.openai.total, 1.5);
    assertEq(e.gemini.total, 0.25);
    assertEq(e.gha_minutes.total, 300);
  });

  await test('N=10 dollar totals rounded to cents (no float drift)', () => {
    const e = estimateBudget(10);
    assertEq(e.anthropic.total, 4.0);
    assertEq(e.openai.total, 3.0);
    assertEq(e.gemini.total, 0.5);
  });

  await test('thresholds reflect platform caps (SB softFloor, BB dailyCap, GHA monthlyCap)', () => {
    const e = estimateBudget(1);
    assertEq(e.scrapingbee.threshold, Math.round(0.5 * 5_350_000));
    assertEq(e.browserbase.threshold, 30);
    assertEq(e.gha_minutes.threshold, 2000);
  });

  await test('custom perShow override is honored, untouched fields fall back to defaults', () => {
    const e = estimateBudget(3, { ...DEFAULT_PER_SHOW, scrapingbee: 100000 });
    assertEq(e.scrapingbee.total, 300000);
    assertEq(e.browserbase.total, 15);
  });

  await test('throws on negative N', () => {
    let threw = false;
    try { estimateBudget(-1); } catch { threw = true; }
    assert(threw, 'expected throw on negative N');
  });

  await test('throws on non-numeric N', () => {
    let threw = false;
    try { estimateBudget('three'); } catch { threw = true; }
    assert(threw, 'expected throw on non-numeric N');
  });

  console.log('\n── checkBudget ──');

  await test('N=1 with plenty: ok=true, no blockers', async () => {
    const r = await checkBudget(1, { liveUsage: plentyUsage() });
    assertEq(r.ok, true);
    assertEq(r.blockers.length, 0);
  });

  await test('N=5 fits under SB+GHA limits with plenty', async () => {
    const r = await checkBudget(5, { liveUsage: plentyUsage() });
    assertEq(r.ok, true, 'should be ok with 5M SB credits and 1900 GHA min');
  });

  await test('SB blocker fires when needed > available (live remaining)', async () => {
    const u = plentyUsage(); u.scrapingbee.remaining = 100_000;
    const r = await checkBudget(5, { liveUsage: u });
    assertEq(r.ok, false);
    const sb = r.blockers.find(b => b.resource === 'scrapingbee');
    assert(sb, 'scrapingbee blocker missing');
    assertEq(sb.needed, 250000);
    assertEq(sb.available, 100000);
  });

  await test('GHA blocker fires when monthly remaining is short', async () => {
    const u = plentyUsage(); u.gha_minutes.remaining = 100;
    const r = await checkBudget(5, { liveUsage: u });
    assertEq(r.ok, false);
    const gha = r.blockers.find(b => b.resource === 'gha_minutes');
    assert(gha, 'gha_minutes blocker missing');
    assertEq(gha.needed, 300);
    assertEq(gha.available, 100);
  });

  await test('Browserbase blocker fires when N exceeds daily cap (cap-based, no live API)', async () => {
    const r = await checkBudget(7, { liveUsage: plentyUsage() }); // 7*5 = 35 > 30
    const bb = r.blockers.find(b => b.resource === 'browserbase');
    assert(bb, 'browserbase should hard-block at 7 shows');
    assertEq(bb.needed, 35);
    assertEq(bb.available, 30);
    assertEq(r.ok, false);
  });

  await test('Browserbase warning fires near cap (N=5 → 25/30 = 83%)', async () => {
    const r = await checkBudget(5, { liveUsage: plentyUsage() });
    const bb = r.warnings.find(w => w.resource === 'browserbase');
    assert(bb, 'browserbase should warn at 5 shows (>75% of cap)');
  });

  await test('SB warning fires at >90% of live remaining (tight squeeze)', async () => {
    const u = plentyUsage(); u.scrapingbee.remaining = 260_000;
    const r = await checkBudget(5, { liveUsage: u });
    assertEq(r.ok, true, 'should NOT block at 96% — soft warn only');
    const sb = r.warnings.find(w => w.resource === 'scrapingbee');
    assert(sb, 'scrapingbee warning missing at 96% utilization');
  });

  await test('LLM dollar blocker fires when total > daily cap (cap-based, no live API)', async () => {
    const r = await checkBudget(200, { liveUsage: plentyUsage() });
    const a = r.blockers.find(b => b.resource === 'anthropic');
    assert(a, 'anthropic should hard-block at 200 shows');
    assert(a.message.includes('$'), `expected $ formatting, got: ${a.message}`);
  });

  await test('blocker shape: resource/needed/available/unit/message all present', async () => {
    const u = plentyUsage(); u.scrapingbee.remaining = 1000;
    const r = await checkBudget(5, { liveUsage: u });
    const b = r.blockers[0];
    for (const k of ['resource', 'needed', 'available', 'unit', 'message']) {
      assert(k in b, `missing ${k}`);
    }
  });

  await test('result envelope includes estimate/usage/numShows for downstream rendering', async () => {
    const r = await checkBudget(3, { liveUsage: plentyUsage() });
    assertEq(r.numShows, 3);
    assert(r.estimate, 'estimate should be returned');
    assert(r.usage, 'usage should be returned');
  });

  await test('zero-show fan-out: ok=true, no blockers (orchestrator no-op)', async () => {
    const r = await checkBudget(0, { liveUsage: plentyUsage() });
    assertEq(r.ok, true);
    assertEq(r.blockers.length, 0);
  });

  await test('undefined usage[resource] entry falls through to cap-based comparison', async () => {
    // Caller passes incomplete liveUsage (no scrapingbee key at all).
    // Expected: SB falls through to threshold-based, doesn't crash.
    const partial = {
      browserbase: { remaining: null },
      anthropic: { remaining: null },
      openai: { remaining: null },
      gemini: { remaining: null },
      gha_minutes: { remaining: 1900 },
    };
    const r = await checkBudget(1, { liveUsage: partial });
    // With N=1, SB total=50000, threshold=2,675,000 — comfortably under, no blocker.
    assertEq(r.ok, true);
  });

  await test('live=0 (zero remaining) is treated as a hard blocker, not a fallthrough', async () => {
    // The `usage[resource]?.remaining ?? null` chain must NOT mistake 0 for null.
    const u = plentyUsage();
    u.scrapingbee.remaining = 0;
    const r = await checkBudget(1, { liveUsage: u });
    assertEq(r.ok, false, 'zero remaining must block');
    const sb = r.blockers.find(b => b.resource === 'scrapingbee');
    assert(sb, 'expected SB blocker at remaining=0');
    assertEq(sb.available, 0);
  });

  await test('soft-warn cap-based path includes resource and percentage', async () => {
    // GHA cap is 2000; soft warn at >75% of cap. 26 shows × 60min = 1560 min = 78%.
    const usageNoLiveGHA = {
      ...plentyUsage(),
      gha_minutes: { remaining: null }, // force cap-based path
    };
    const r = await checkBudget(26, { liveUsage: usageNoLiveGHA });
    const w = r.warnings.find(x => x.resource === 'gha_minutes');
    assert(w, 'expected GHA warning on cap-based path');
    assert(w.message.includes('gha_minutes'), `message should name resource, got: ${w.message}`);
  });

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`${'═'.repeat(50)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('test harness threw:', err);
  process.exit(2);
});
