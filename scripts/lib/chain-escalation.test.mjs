// chain-escalation.test.mjs (BRO-3009 S1-T9) — walks pageChainOrder and
// serpChainOrder and asserts consecutive priced tiers only get MORE expensive
// in a way this file explicitly declares. An undeclared cost increase fails
// the test: this is the mechanism that makes a silent backwards-cost fallback
// (routing to a pricier provider without anyone deciding that on purpose)
// structurally impossible, not just something a human might notice in a log.
//
// Scope note: this prices each tier at its CHEAPEST/default mode (sd 'plain',
// sb 'standard') to compare providers' baseline per-request economics along
// the routing order. It does not vary renderJs/premium/stealth per URL — that
// per-request variance is a separate concern from "does the ORDER itself ever
// route backwards," which is what this test and pageChainOrder/serpChainOrder
// are about.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { creditsFor } = require('./provider-credits.js');
const { usdFor, loadProviderPricing } = require('./provider-pricing.js');
const { pageChainOrder } = require('./scraper.js');
const { serpChainOrder } = require('./url-discovery.js');

const pricing = loadProviderPricing();
const BILLING = {
  scrapingdog: pricing.scrapingdog.billing,
  scrapingbee: pricing.scrapingbee.billing,
  brightdata: pricing.brightdata.billing,
};

// The only tiers pageChainOrder/serpChainOrder can emit with zero provider
// credit spend — everything else must be priced below or this file throws.
// A new PAID tier added to either chain order that isn't priced here would
// otherwise silently fall through the old `return null` default and be
// treated as free, exempting it from the pairwise cost-escalation check.
const FREE_TIERS = new Set(['cookies-plain', 'playwright-first', 'playwright-last']);

// Baseline USD cost for one request at each tier name pageChainOrder /
// serpChainOrder can emit, in the given chain's context — SD/SB bill by
// credits and the credit MODE differs between a page fetch (sd 'page', sb
// 'standard') and a SERP query (sb 'serp', 25cr — SD SERP isn't part of
// serpChainOrder, it's gated separately). Bright Data bills a flat per-request
// rate regardless of context. FREE_TIERS entries return null, excluding them
// from the pairwise comparison below — any transition INTO a paid tier from a
// free one is not a cost escalation by definition. Anything else is neither
// priced nor declared free: throw instead of defaulting to free.
function baselineUsd(chainName, tierName) {
  if (tierName === 'brightdata') return usdFor('brightdata', 1, pricing);
  if (tierName === 'scrapingdog') {
    return usdFor('scrapingdog', creditsFor('sd', chainName === 'serp' ? 'serp' : 'page'), pricing);
  }
  if (tierName === 'scrapingbee') {
    return usdFor('scrapingbee', creditsFor('sb', chainName === 'serp' ? 'serp' : 'standard'), pricing);
  }
  if (FREE_TIERS.has(tierName)) return null;
  throw new Error(
    `baselineUsd: unrecognized tier "${tierName}" in ${chainName} chain — ` +
      `add it to FREE_TIERS above if it spends no provider credits, or price it explicitly.`
  );
}

// A PAYG tier following a prepaid tier is structurally normal — PAYG is the
// safety-valve tier, expected to cost more per unit — so it needs no
// per-pair declaration. Capped: an exemption that's supposed to cover
// "PAYG costs somewhat more" must not silently swallow a pricing typo that
// makes a rate absurdly wrong (e.g. a misplaced decimal).
const AUTO_EXEMPT_MAX_MULTIPLIER = 50;
function isAutoExempt(fromTier, toTier, multiplier) {
  return BILLING[fromTier] === 'prepaid' && BILLING[toTier] === 'payg' && multiplier <= AUTO_EXEMPT_MAX_MULTIPLIER;
}

// Everything else that's a real cost increase must be declared here, with
// the multiplier and reason it's legal. maxMultiplier bounds the declaration
// itself — a future provider-pricing.json edit that blows the real ratio
// past this ceiling still fails the test instead of riding the existing
// declaration forever (a pricing bug hiding behind an old, unrelated OK).
const DECLARED_ESCALATIONS = [
  {
    chain: 'page',
    from: 'scrapingdog',
    to: 'scrapingbee',
    maxMultiplier: 1.5,
    reason:
      'Both prepaid tiers with near-identical plan rates ($0.00009 vs ' +
      '$0.000099/credit, ~1.1x) — Scrapingdog runs first for host coverage/' +
      'reliability, not pure cost minimization; not a routing bug.',
  },
  {
    chain: 'serp',
    from: 'brightdata',
    to: 'scrapingbee',
    maxMultiplier: 3,
    reason:
      'SERP fallback: Bright Data (PAYG, $0.0015/req) to ScrapingBee SERP ' +
      '(prepaid, 25cr = $0.002475/req) — SB SERP is the stronger/slower ' +
      'unblocker kept as the last-resort tier; a real, accepted cost increase.',
  },
];

function declaredEntry(chainName, fromTier, toTier) {
  return DECLARED_ESCALATIONS.find((e) => e.chain === chainName && e.from === fromTier && e.to === toTier);
}

function assertNoUndeclaredEscalation(chainName, tierOrder) {
  const priced = tierOrder
    .map((tier) => ({ tier, usd: baselineUsd(chainName, tier) }))
    .filter((x) => x.usd !== null);
  for (let i = 1; i < priced.length; i++) {
    const prev = priced[i - 1];
    const cur = priced[i];
    if (cur.usd <= prev.usd) continue;
    const multiplier = cur.usd / prev.usd;
    if (isAutoExempt(prev.tier, cur.tier, multiplier)) continue;
    const declared = declaredEntry(chainName, prev.tier, cur.tier);
    if (declared && multiplier <= declared.maxMultiplier) continue;
    assert.fail(
      `Undeclared (or over-ceiling) cost escalation in ${chainName} chain: ${prev.tier} ($${prev.usd}) -> ` +
        `${cur.tier} ($${cur.usd}), ${multiplier.toFixed(2)}x` +
        (declared ? ` exceeds its declared maxMultiplier (${declared.maxMultiplier}x)` : '') +
        `. Declare it in DECLARED_ESCALATIONS with a reason and maxMultiplier, or fix the chain order.`
    );
  }
}

const PAGE_FLAG_COMBOS = [
  { name: 'all providers enabled, no cookies', flags: { useScrapingdog: true, hasBdToken: true, sbAllowed: true } },
  { name: 'cookies present', flags: { hasCookies: true, useScrapingdog: true, hasBdToken: true, sbAllowed: true } },
  { name: 'scrapingdog disabled', flags: { useScrapingdog: false, hasBdToken: true, sbAllowed: true } },
  { name: 'bright data disabled', flags: { useScrapingdog: true, hasBdToken: false, sbAllowed: true } },
  { name: 'scrapingbee disabled', flags: { useScrapingdog: true, hasBdToken: true, sbAllowed: false } },
  { name: 'only bright data + scrapingbee', flags: { useScrapingdog: false, hasBdToken: true, sbAllowed: true } },
];

for (const { name, flags } of PAGE_FLAG_COMBOS) {
  test(`pageChainOrder (${name}): no undeclared cost escalation`, () => {
    const chain = pageChainOrder({
      hasCookies: false,
      preferPlaywright: false,
      isBroadwayWorld: false,
      isPublicSite: false,
      skips: new Set(),
      ...flags,
    });
    assertNoUndeclaredEscalation('page', chain);
  });
}

test('serpChainOrder default (BD first): BD -> SB is the one declared escalation', () => {
  const chain = serpChainOrder(false);
  assert.deepEqual(chain, ['brightdata', 'scrapingbee']);
  assertNoUndeclaredEscalation('serp', chain);
});

test('serpChainOrder preferSpeed (SB first): SB -> BD is a cost decrease, nothing to declare', () => {
  const chain = serpChainOrder(true);
  assert.deepEqual(chain, ['scrapingbee', 'brightdata']);
  assertNoUndeclaredEscalation('serp', chain);
});

test('declared escalation list names exactly the two known real increases — nothing else is exempted', () => {
  assert.deepEqual(
    DECLARED_ESCALATIONS.map((e) => `${e.chain}:${e.from}->${e.to}`),
    ['page:scrapingdog->scrapingbee', 'serp:brightdata->scrapingbee']
  );
});

test('sanity: brightdata really is pricier than the page-chain baseline scrapingdog/scrapingbee rates', () => {
  const sd = baselineUsd('page', 'scrapingdog');
  const bd = baselineUsd('page', 'brightdata');
  const sb = baselineUsd('page', 'scrapingbee');
  assert.ok(bd > sd, 'BD should be pricier than SD baseline (page-chain PAYG-after-prepaid, auto-exempt)');
  assert.ok(bd > sb, 'BD should be pricier than SB baseline (page-chain PAYG-after-prepaid, auto-exempt)');
});

test('sanity: brightdata is cheaper than ScrapingBee at SERP pricing — this is the real declared escalation', () => {
  const bd = baselineUsd('serp', 'brightdata');
  const sbSerp = baselineUsd('serp', 'scrapingbee');
  assert.ok(sbSerp > bd, 'SB SERP (25cr) should be pricier than BD per-request — documents the serp:brightdata->scrapingbee declaration');
});
