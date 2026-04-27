#!/usr/bin/env node
/**
 * End-to-end validation of the ticket-single-button A/B test.
 *
 * Runs 4 checks against live production:
 *   1. PostHog /decide/ returns a ~50/50 distribution over random distinct_ids
 *   2. Sticky bucketing works — same distinct_id returns the same variant repeatedly
 *   3. Each variant renders the correct DOM on a real show page (Playwright)
 *   4. Clicking the primary CTA fires a ticket_click event with the right ab_variant
 *
 * This is the authoritative "is the A/B test valid?" check. Run it whenever
 * you suspect the flag, code, or analyzer are out of sync. Also run it before
 * any change to TicketButtonsAB.tsx, the flag config, or the analyzer.
 *
 * Usage:
 *   node scripts/validate-ab-test.js
 *   node scripts/validate-ab-test.js --strict   # exit 1 on any failure
 *
 * Required env vars:
 *   POSTHOG_PERSONAL_API_KEY  (for /decide/ API checks)
 *
 * If Playwright browsers are missing locally, install with:
 *   npx playwright install chromium
 */

const { chromium } = require('playwright');

const STRICT = process.argv.includes('--strict');
const URL = 'https://broadwayscorecard.com/show/hamilton';
const FLAG_KEY = 'ticket-single-button';
const PH_PUBLIC_KEY = 'phc_xVenlxA1HzyJz0Yjlj3UkF9JVLCPe86Td6vQEK41SF7';

const results = [];
function recordPass(name, detail) { results.push({ name, pass: true, detail }); console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`); }
function recordFail(name, detail) { results.push({ name, pass: false, detail }); console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }

async function decideApi(distinctId) {
  const res = await fetch('https://us.posthog.com/decide/?v=3', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: PH_PUBLIC_KEY, distinct_id: distinctId }),
  });
  const data = await res.json();
  return data.featureFlags?.[FLAG_KEY] ?? null;
}

// ─── Check 1: ~50/50 distribution over random IDs ───
async function checkDistribution() {
  console.log('\n── Check 1: variant distribution (30 random distinct_ids) ──');
  const counts = { multi: 0, single: 0, other: 0 };
  for (let i = 0; i < 30; i++) {
    const id = `validate_ab_${Date.now()}_${i}`;
    const v = await decideApi(id);
    if (v === 'multi' || v === 'single') counts[v]++;
    else counts.other++;
  }
  console.log(`  multi: ${counts.multi}, single: ${counts.single}, other: ${counts.other}`);
  const total = counts.multi + counts.single;
  if (total < 25) {
    recordFail('distribution', `only ${total}/30 classified as multi/single (flag may not be active)`);
    return;
  }
  const ratio = counts.multi / total;
  if (ratio < 0.25 || ratio > 0.75) {
    recordFail('distribution', `multi ratio ${(ratio*100).toFixed(0)}% is outside 25-75% sanity window`);
    return;
  }
  recordPass('~50/50 distribution', `multi=${counts.multi}, single=${counts.single}`);
}

// ─── Check 2: sticky bucketing per distinct_id ───
async function checkSticky() {
  console.log('\n── Check 2: sticky bucketing (same id returns same variant 5x) ──');
  const ids = ['validate_sticky_a', 'validate_sticky_b', 'validate_sticky_c'];
  for (const id of ids) {
    const seen = new Set();
    for (let i = 0; i < 5; i++) seen.add(await decideApi(id));
    if (seen.size === 1 && !seen.has(null)) {
      recordPass(`sticky:${id}`, `variant=${[...seen][0]}`);
    } else {
      recordFail(`sticky:${id}`, `variants seen: ${[...seen].join(',')}`);
    }
  }
}

// ─── Check 3: DOM rendering per variant ───
async function checkRendering(browser) {
  console.log('\n── Check 3: DOM rendering per variant (real show page) ──');
  // Find one ID per variant
  const renderCounts = {};
  const ids = { multi: null, single: null };
  for (let i = 0; i < 20 && (!ids.multi || !ids.single); i++) {
    const id = `validate_render_${i}`;
    const v = await decideApi(id);
    if (v === 'multi' && !ids.multi) ids.multi = id;
    if (v === 'single' && !ids.single) ids.single = id;
  }
  if (!ids.multi || !ids.single) {
    recordFail('render', 'could not find deterministic IDs for both variants');
    return;
  }

  for (const [expected, id] of Object.entries(ids)) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.addInitScript((args) => {
      localStorage.setItem(`ph_${args.key}_posthog`, JSON.stringify({
        distinct_id: args.id, $device_id: args.id,
      }));
    }, { id, key: PH_PUBLIC_KEY });
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(5000);
    const resolved = await page.evaluate(() => window.posthog?.getFeatureFlag?.('ticket-single-button') ?? null);
    // Count PRIMARY top-of-card A/B-rendered buttons only. The ShowtimesCard
    // has its own set of deep-link buttons for each performance time that
    // are NOT part of the A/B test — so we scope to anchors whose text
    // starts with "Get Tickets" (the primary CTA label) or exactly matches
    // a known secondary-platform name ("Ticketmaster", "SeatPlan", etc.).
    const primaryButtons = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      const secondaryNames = new Set(['Ticketmaster', 'SeatPlan', 'Telecharge', 'Vivid Seats', 'Official Site']);
      return anchors
        .map(a => ({ txt: (a.textContent || '').trim(), href: a.getAttribute('href') || '' }))
        .filter(({ txt }) => txt.startsWith('Get Tickets') || secondaryNames.has(txt));
    });
    const primaryCount = primaryButtons.length;
    await ctx.close();

    if (resolved !== expected) {
      recordFail(`render:${expected}`, `PostHog resolved to '${resolved}' not '${expected}'`);
      continue;
    }
    // Store count for cross-variant comparison below
    renderCounts[expected] = primaryCount;
    recordPass(`render:${expected}`, `${id} → ${primaryCount} primary buttons`);
  }

  // The key assertion: multi must have strictly MORE primary buttons than single.
  // This validates the A/B logic without being brittle about exact counts (the
  // page has multiple TicketButtonsAB instances + ShowtimesCard CTA, so raw
  // button counts vary by page layout).
  if (renderCounts.multi != null && renderCounts.single != null) {
    if (renderCounts.multi > renderCounts.single) {
      recordPass('multi > single', `multi=${renderCounts.multi} vs single=${renderCounts.single}`);
    } else {
      recordFail('multi > single', `multi=${renderCounts.multi} vs single=${renderCounts.single} — single should have fewer buttons`);
    }
  }
}

// ─── Check 4: click tracking fires with correct ab_variant ───
async function checkClickTracking(browser) {
  console.log('\n── Check 4: click tracking fires with correct ab_variant ──');
  // Reuse the same ID discovery as check 3
  const ids = { multi: null, single: null };
  for (let i = 0; i < 20 && (!ids.multi || !ids.single); i++) {
    const id = `validate_click_${i}`;
    const v = await decideApi(id);
    if (v === 'multi' && !ids.multi) ids.multi = id;
    if (v === 'single' && !ids.single) ids.single = id;
  }

  for (const [expected, id] of Object.entries(ids)) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const captures = [];
    page.on('request', req => {
      const url = req.url();
      if (url.includes('us.i.posthog.com/capture') || url.includes('us.i.posthog.com/e/')) {
        const pd = req.postData();
        if (pd) {
          try {
            let body;
            if (pd.startsWith('{')) body = JSON.parse(pd);
            else if (pd.startsWith('data=')) body = JSON.parse(decodeURIComponent(pd.slice(5)));
            else body = { raw: pd };
            captures.push(body);
          } catch { /* ignore */ }
        }
      }
    });
    // Block actual affiliate navigation so the click doesn't really open a tab
    await ctx.route('**/*', r => {
      const u = r.request().url();
      if (u.includes('todaytix.pxf.io') || u.includes('ticketmaster.evyy.net')) return r.abort();
      return r.continue();
    });
    await page.addInitScript((args) => {
      localStorage.setItem(`ph_${args.key}_posthog`, JSON.stringify({
        distinct_id: args.id, $device_id: args.id,
      }));
    }, { id, key: PH_PUBLIC_KEY });
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(4000);
    try {
      await page.locator('a:has-text("Get Tickets")').first().click({ timeout: 5000, force: true });
    } catch (e) {
      recordFail(`click:${expected}`, `could not click primary CTA: ${e.message}`);
      await ctx.close();
      continue;
    }
    await page.waitForTimeout(1500);
    await ctx.close();

    const ticketClickEvent = captures.find(c => c?.event === 'ticket_click');
    if (!ticketClickEvent) {
      recordFail(`click:${expected}`, 'no ticket_click event captured');
      continue;
    }
    const abVariant = ticketClickEvent.properties?.ab_variant;
    // Accept both new flag-prefixed format and legacy bare format. The new
    // format added a `flag:ticket-single-button,` cohort prefix on 2026-04-27
    // (Codex ship-check #6). Once all in-flight tabs cycle out, drop the
    // legacy branch.
    const expectedNew = `flag:ticket-single-button,platform:todaytix,buttons:${expected}`;
    const expectedLegacy = `platform:todaytix,buttons:${expected}`;
    if (abVariant === expectedNew || abVariant === expectedLegacy) {
      recordPass(`click:${expected}`, `ab_variant='${abVariant}'`);
    } else {
      recordFail(`click:${expected}`, `ab_variant='${abVariant}' (expected '${expectedNew}' or legacy '${expectedLegacy}')`);
    }
  }
}

async function main() {
  console.log('═'.repeat(70));
  console.log(`A/B TEST END-TO-END VALIDATION — ${FLAG_KEY}`);
  console.log('═'.repeat(70));

  await checkDistribution();
  await checkSticky();

  const browser = await chromium.launch({ headless: true });
  try {
    await checkRendering(browser);
    await checkClickTracking(browser);
  } finally {
    await browser.close();
  }

  console.log('\n' + '═'.repeat(70));
  const failures = results.filter(r => !r.pass);
  const passes = results.filter(r => r.pass);
  console.log(`RESULT: ${passes.length} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  ✗ ${f.name} — ${f.detail || ''}`);
  }
  console.log('═'.repeat(70));

  if (STRICT && failures.length > 0) process.exit(1);
}

main().catch(e => {
  console.error('Validator crashed:', e);
  process.exit(2);
});
