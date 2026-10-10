/**
 * UGC visual QA driver — captures the rating/watchlist/lists flows at mobile
 * (390px) and desktop (1440px) against the local dev server, with a fully
 * mocked Supabase backend so we act as a real signed-in user.
 *
 * Usage: node capture.js [phase]   phase = fixture | myshows | live | all
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { installSupabaseMock, injectSession } = require('./supabase-mock');

const BASE = 'http://localhost:3456';
const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });

const VIEWPORTS = {
  mobile: { width: 390, height: 844 },
  desktop: { width: 1440, height: 900 },
};

const findings = [];
function note(id, severity, text) {
  findings.push({ id, severity, text });
  console.log(`[${severity}] ${id}: ${text}`);
}

async function shot(page, name, opts = {}) {
  const file = path.join(OUT, `${name}.png`);
  try {
    await page.screenshot({ path: file, fullPage: opts.fullPage || false, timeout: 12000 });
    console.log(`  📸 ${name}`);
  } catch (e) {
    console.log(`  ⚠️ screenshot failed: ${name}: ${e.message.split('\n')[0]}`);
    await page.keyboard.press('Escape').catch(() => {});
  }
}

async function checkOverflow(page, label) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return { scrollW: doc.scrollWidth, clientW: doc.clientWidth };
  });
  if (overflow.scrollW > overflow.clientW + 1) {
    note(label, 'BUG', `horizontal overflow: scrollWidth ${overflow.scrollW} > viewport ${overflow.clientW}`);
  }
}

// ─────────────────────────────────────────────────────────────
// Phase A: fixture page (widget-level UX, no auth)
// ─────────────────────────────────────────────────────────────
async function phaseFixture(browser) {
  console.log('\n=== PHASE A: rating widget fixture ===');
  for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
    const ctx = await browser.newContext({ viewport: vp, hasTouch: vpName === 'mobile', isMobile: vpName === 'mobile', deviceScaleFactor: vpName === 'mobile' ? 3 : 1 });
    const page = await ctx.newPage();

    // A1: empty state → tap star → panel
    await page.goto(`${BASE}/test/show-rating-fixture?state=empty`);
    await page.waitForSelector('[data-testid="show-rating-fixture"]');
    const card = page.locator('[data-testid="rating-card"]');
    await shot(page, `A1-${vpName}-empty-initial`);

    if (vpName === 'mobile') {
      // mobile: tap 4th star via touchscreen to trigger touch path
      const star4 = card.getByRole('button', { name: '4 stars' }).first();
      await star4.tap();
    } else {
      await card.getByRole('button', { name: '4 stars' }).first().click();
    }
    await page.waitForTimeout(400);
    await shot(page, `A2-${vpName}-star-tapped-panel-open`);
    await checkOverflow(page, `A2-${vpName}`);

    // Half-star affordance on mobile
    if (vpName === 'mobile') {
      const halfBtn = page.getByRole('button', { name: /make it/i });
      if (await halfBtn.count()) {
        await shot(page, `A3-mobile-halfstar-button`);
      } else {
        note('A3-mobile', 'UX', 'no half-star affordance appeared after tap');
      }
    }

    // A4: date picker — do NOT click/focus it: onFocus calls showPicker() and the
    // native popup wedges page.screenshot. Inspect attributes only.
    const dateInput = page.locator('input[type="date"]');
    if (await dateInput.count()) {
      const max = await dateInput.getAttribute('max');
      const today = new Date().toISOString().split('T')[0];
      if (max && max > today) note(`A4-${vpName}`, 'BUG', `date max=${max} is in the future (today=${today}) — future closing date leaks into picker cap`);
    }

    // A5: long review text near limit
    const textarea = page.locator('textarea');
    await textarea.fill('x'.repeat(1950));
    await page.waitForTimeout(200);
    await shot(page, `A5-${vpName}-near-charlimit`);
    await textarea.fill('A wonderful night at the theatre. '.repeat(3));

    // A6: save
    await page.getByRole('button', { name: /^save/i }).click();
    await page.waitForTimeout(400);
    await shot(page, `A6-${vpName}-after-save`);

    // A7: existing state — controls row (hover-only affordances on desktop?)
    await page.goto(`${BASE}/test/show-rating-fixture?state=existing`);
    await page.waitForSelector('[data-testid="rating-card"]');
    await shot(page, `A7-${vpName}-existing-initial`);
    if (vpName === 'desktop') {
      // check whether edit/delete are invisible until hover
      const editBtn = page.locator('[data-testid="rating-card"] [aria-label="Edit rating"]').first();
      const opacity = await editBtn.evaluate(el => getComputedStyle(el.parentElement).opacity).catch(() => null);
      if (opacity === '0') note('A7-desktop', 'UX', 'edit/delete controls are opacity-0 until hover — undiscoverable');
      await page.locator('[data-testid="rating-card"]').hover();
      await page.waitForTimeout(200);
      await shot(page, `A7b-desktop-existing-hover`);
    }

    // A8: multi-viewing state
    await page.goto(`${BASE}/test/show-rating-fixture?state=multi`);
    await page.waitForSelector('[data-testid="rating-card"]');
    await shot(page, `A8-${vpName}-multi-viewings`, { fullPage: true });
    await checkOverflow(page, `A8-${vpName}`);

    // A9: "+ New Viewing" flow
    const newViewing = page.getByRole('button', { name: /new viewing/i });
    if (await newViewing.count()) {
      await newViewing.click();
      await page.waitForTimeout(400);
      await shot(page, `A9-${vpName}-new-viewing-panel`);
      // Does the new-viewing panel pre-fill the OLD rating?
      const starsLabel = await page.locator('text=/\\d\\.\\d stars/').first().textContent().catch(() => null);
      if (starsLabel) note(`A9-${vpName}`, 'UX', `"+ New Viewing" pre-fills previous rating (${starsLabel.trim()}) instead of starting fresh`);
    }

    await ctx.close();
  }
}

// ─────────────────────────────────────────────────────────────
// Phase B: My Shows with mock data
// ─────────────────────────────────────────────────────────────
async function phaseMyShows(browser) {
  console.log('\n=== PHASE B: My Shows (mock data) ===');
  for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
    const ctx = await browser.newContext({ viewport: vp, hasTouch: vpName === 'mobile', isMobile: vpName === 'mobile' });
    const page = await ctx.newPage();

    for (const tab of ['diary', 'watchlist', 'lists']) {
      await page.goto(`${BASE}/my-shows?mock=1&tab=${tab}`);
      await page.waitForSelector('text=shows seen', { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(800);
      await shot(page, `B-${vpName}-myshows-${tab}`, { fullPage: true });
      await checkOverflow(page, `B-${vpName}-${tab}`);
    }

    await ctx.close();
  }
}

// ─────────────────────────────────────────────────────────────
// Phase C: live show page, real signed-in actions vs mocked Supabase
// ─────────────────────────────────────────────────────────────
async function phaseLive(browser) {
  console.log('\n=== PHASE C: live show page, signed-in flows ===');
  const SHOW = '/show/gypsy-2024';

  for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
    // C0: signed-OUT star tap → sign-in modal
    {
      const ctx = await browser.newContext({ viewport: vp, hasTouch: vpName === 'mobile', isMobile: vpName === 'mobile' });
      await installSupabaseMock(ctx);
      const page = await ctx.newPage();
      await page.goto(BASE + SHOW, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      await shot(page, `C0-${vpName}-showpage-signedout`, { fullPage: vpName === 'mobile' });
      await checkOverflow(page, `C0-${vpName}`);

      const ratingHeader = page.locator('text=My Rating & Review').first();
      if (!(await ratingHeader.count())) {
        note(`C0-${vpName}`, 'BUG', 'rating widget not found on show page (flag or render issue)');
      } else {
        await ratingHeader.scrollIntoViewIfNeeded();
        const star = page.locator('h3:has-text("My Rating & Review") ~ * button[aria-label="4 stars"], [aria-label="4 stars"]').first();
        if (vpName === 'mobile') await star.tap().catch(() => star.click()); else await star.click();
        await page.waitForTimeout(600);
        await shot(page, `C1-${vpName}-signedout-star-tap`);
      }
      await ctx.close();
    }

    // C2+: signed-in
    {
      const ctx = await browser.newContext({ viewport: vp, hasTouch: vpName === 'mobile', isMobile: vpName === 'mobile' });
      const { store, log } = await installSupabaseMock(ctx);
      await injectSession(ctx);
      const page = await ctx.newPage();
      page.on('console', m => { if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 160)); });

      await page.goto(BASE + SHOW, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      await shot(page, `C2-${vpName}-signedin-initial`);

      const star = page.locator('[aria-label="4 stars"]').first();
      await star.scrollIntoViewIfNeeded();
      if (vpName === 'mobile') await star.tap().catch(() => star.click()); else await star.click();
      await page.waitForTimeout(500);
      await shot(page, `C3-${vpName}-signedin-panel`);

      // type review + date, save
      await page.locator('textarea').fill('Audra was transcendent. Best Rose I have ever seen.');
      await page.locator('input[type="date"]').fill('2025-06-15').catch(() => {});
      await page.getByRole('button', { name: /^save/i }).click();
      await page.waitForTimeout(1500);
      await shot(page, `C4-${vpName}-after-save`);
      const inserts = log.filter(l => l.method === 'POST' && l.path.includes('/reviews'));
      console.log(`  reviews in store: ${store.reviews.length}, POSTs: ${inserts.length}`);
      if (store.reviews.length !== 1) note(`C4-${vpName}`, 'BUG', `expected 1 review after save, store has ${store.reviews.length}`);

      // C5: DOUBLE-RATING probe. After save the star row is disabled read-only;
      // the only path to a second viewing is the small "+ New Viewing" text link.
      const canRestar = await page.locator('[aria-label="5 stars"]:not([disabled])').count();
      note(`C5pre-${vpName}`, 'UX', `after saving, star row is ${canRestar ? 'still tappable' : 'DISABLED read-only — only affordances are tiny "+ New Viewing"/hover-pencil'}`);
      const newViewing = page.getByRole('button', { name: /new viewing/i }).first();
      await newViewing.scrollIntoViewIfNeeded();
      await newViewing.click();
      await page.waitForTimeout(500);
      await shot(page, `C5-${vpName}-second-rating-panel`);
      await page.getByRole('button', { name: /^save/i }).click();
      await page.waitForTimeout(1500);
      await shot(page, `C5b-${vpName}-after-second-save`);
      const patches = log.filter(l => l.method === 'PATCH' && l.path.includes('/reviews'));
      console.log(`  after 2nd save: reviews=${store.reviews.length} POSTs=${log.filter(l => l.method === 'POST' && l.path.includes('/reviews')).length} PATCHes=${patches.length}`);
      note(`C5-${vpName}`, store.reviews.length === 2 ? 'INFO' : 'BUG',
        store.reviews.length === 2
          ? 'second star-click created a second viewing (append)'
          : `second star-click resulted in ${store.reviews.length} review(s) — ${patches.length ? 'it PATCHed the first one (lastSavedId reuse)' : 'unexpected'}`);

      await ctx.close();
    }

    // C6: FAILED SAVE — does typed text survive?
    {
      const ctx = await browser.newContext({ viewport: vp, hasTouch: vpName === 'mobile', isMobile: vpName === 'mobile' });
      await installSupabaseMock(ctx, { failWrites: ['reviews'] });
      await injectSession(ctx);
      const page = await ctx.newPage();
      await page.goto(BASE + SHOW, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      const star = page.locator('[aria-label="4 stars"]').first();
      await star.scrollIntoViewIfNeeded();
      if (vpName === 'mobile') await star.tap().catch(() => star.click()); else await star.click();
      await page.waitForTimeout(400);
      const REVIEW_TEXT = 'This took me ten minutes to type on my phone and I would be furious to lose it.';
      await page.locator('textarea').fill(REVIEW_TEXT);
      await page.getByRole('button', { name: /^save/i }).click();
      await page.waitForTimeout(1500);
      await shot(page, `C6-${vpName}-after-failed-save`);
      const panelStillOpen = await page.locator('textarea').count();
      const textPreserved = panelStillOpen && (await page.locator('textarea').inputValue().catch(() => '')) === REVIEW_TEXT;
      note(`C6-${vpName}`, textPreserved ? 'INFO' : 'BUG',
        textPreserved ? 'failed save preserved panel + text' : `failed save ${panelStillOpen ? 'kept panel but lost text' : 'CLOSED panel and discarded typed review'}`);
      await ctx.close();
    }

    // C7: watchlist + add-to-list buttons
    {
      const ctx = await browser.newContext({ viewport: vp, hasTouch: vpName === 'mobile', isMobile: vpName === 'mobile' });
      const { store } = await installSupabaseMock(ctx);
      await injectSession(ctx);
      const page = await ctx.newPage();
      await page.goto(BASE + SHOW, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);

      const watchBtn = page.getByRole('button', { name: /watchlist|want to see/i }).first();
      if (await watchBtn.count()) {
        await watchBtn.scrollIntoViewIfNeeded();
        await watchBtn.click();
        await page.waitForTimeout(1200);
        await shot(page, `C7-${vpName}-watchlist-clicked`);
        console.log(`  watchlist rows: ${store.watchlist.length}`);
      } else {
        note(`C7-${vpName}`, 'INFO', 'no watchlist button found on show page');
        await shot(page, `C7-${vpName}-no-watchlist-btn`);
      }

      const addToList = page.getByRole('button', { name: /add to list/i }).first();
      if (await addToList.count()) {
        await addToList.scrollIntoViewIfNeeded();
        await addToList.click();
        await page.waitForTimeout(600);
        await shot(page, `C8-${vpName}-addtolist-dropdown`);
      }
      await ctx.close();
    }
  }
}

(async () => {
  const phase = process.argv[2] || 'all';
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  try {
    const run = async (name, fn) => {
      try { await fn(browser); } catch (e) { note(name, 'HARNESS', `phase crashed: ${e.message.split('\n')[0]}`); }
    };
    if (phase === 'fixture' || phase === 'all') await run('fixture', phaseFixture);
    if (phase === 'myshows' || phase === 'all') await run('myshows', phaseMyShows);
    if (phase === 'live' || phase === 'all') await run('live', phaseLive);
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(__dirname, 'findings.json'), JSON.stringify(findings, null, 2));
  console.log(`\n${findings.length} findings written to findings.json`);
})();
