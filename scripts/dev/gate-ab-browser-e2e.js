/**
 * Run: start a dev server (PORT=3457 npx next dev -p 3457, needs data symlinks),
 * then NODE_PATH=./node_modules node scripts/dev/gate-ab-browser-e2e.js
 *
 * Empirical E2E of the mobile-gate-timing A/B against the shipped code
 * (dev server on :3457, main tree). Stubs window.posthog (flag + capture)
 * before any page JS runs; emulates a touch device so pointer:coarse matches.
 *
 * Scenarios:
 *  A control:        65%+10s fires; 70% pre-10s does NOT; payload timing:control
 *  B end-of-content: 70% does NOT fire; 97%@>3s fires; payload timing:end-of-content
 *  C fallback:       no flags ever → unarmed until 5s poll timeout; then control
 *                    params (65%+10s) fire; payload timing:fallback
 *  D race:           flag resolves at ~2.5s; scrolling past 97% BEFORE resolution
 *                    fires nothing (contamination guard); after resolution fires
 *                    as end-of-content
 *  E cooldown:       fresh dismissal stamp suppresses the scroll gate entirely
 */
const { chromium, devices } = require('playwright');
const URL = 'http://localhost:3457/';
const MODAL = 'text=Know the score before you book';
let failures = 0;

function check(name, cond, detail = '') {
  console.log(`${cond ? '  ✔' : '  ✘ FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

async function newPage(browser, { flagScript, preload }) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  // Real posthog-js must never replace the stub: block its assets AND freeze the global.
  await ctx.route(/posthog|i\.posthog\.com/, (r) => r.abort());
  await ctx.addInitScript(`
    window.__ph = [];
    ${flagScript}
    if (window.posthog) {
      const stub = window.posthog;
      Object.defineProperty(window, 'posthog', { get: () => stub, set: () => {}, configurable: false });
    }
    ${preload || ''}
    // instant scrolling so dispatched positions are synchronous
    document.addEventListener('DOMContentLoaded', () => {
      const st = document.createElement('style'); st.textContent = 'html{scroll-behavior:auto !important}';
      document.head.appendChild(st);
    });
  `);
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  return { ctx, page };
}

const stubPosthog = (flagExpr) => `
  window.posthog = {
    getFeatureFlag: (k) => k === 'mobile-gate-timing' ? (${flagExpr}) : undefined,
    capture: (e, p) => window.__ph.push({ e, p: p || {} }),
  };`;

async function scrollTo(page, pct) {
  // Lazy content grows scrollHeight after a jump — re-seek until the target
  // percentage holds across two consecutive checks.
  for (let i = 0; i < 8; i++) {
    const stable = await page.evaluate((p) => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo(0, Math.floor(max * p));
      window.dispatchEvent(new Event('scroll'));
      return { max, y: window.scrollY };
    }, pct);
    await page.waitForTimeout(350);
    const now = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
    if (Math.abs(now - stable.max) < 50) break;
  }
  await page.waitForTimeout(300);
}

const modalVisible = (page) => page.locator(MODAL).isVisible().catch(() => false);
const events = (page) => page.evaluate(() => window.__ph);

(async () => {
  const browser = await chromium.launch();

  // Sanity: touch emulation gives pointer:coarse
  {
    const { ctx, page } = await newPage(browser, { flagScript: stubPosthog(`'control'`) });
    const coarse = await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches);
    check('touch emulation → pointer:coarse', coarse === true);
    await ctx.close();
  }

  // A — control
  {
    console.log('\nA: control (65% + 10s)');
    const { ctx, page } = await newPage(browser, { flagScript: stubPosthog(`'control'`) });
    await page.waitForTimeout(1000);
    await scrollTo(page, 0.7);
    check('no fire at 70% before 10s min-time', !(await modalVisible(page)));
    await page.waitForTimeout(10500);
    await scrollTo(page, 0.72);
    check('fires at 70% after 10s', await modalVisible(page));
    const evs = await events(page);
    const shown = evs.find((x) => x.e === 'gate_modal_shown');
    check('gate_modal_shown ab_variant=timing:control',
      shown?.p?.ab_variant === 'flag:mobile-gate-timing,timing:control', JSON.stringify(shown?.p));
    check('trigger_source=scroll', shown?.p?.trigger_source === 'scroll');
    // dismiss via Maybe later → dismissed event carries same meta + stamp written
    await page.locator('text=Maybe later').click().catch(() => {});
    await page.waitForTimeout(400);
    const evs2 = await events(page);
    const dis = evs2.find((x) => x.e === 'gate_modal_dismissed');
    check('dismissed event carries ab_variant', dis?.p?.ab_variant === 'flag:mobile-gate-timing,timing:control');
    const stamp = await page.evaluate(() => localStorage.getItem('bsc_gate_dismissed_at'));
    check('dismissal stamp written', /^\d{13}$/.test(stamp || ''));
    await ctx.close();
  }

  // B — end-of-content
  {
    console.log('\nB: end-of-content (95% + 3s guard)');
    const { ctx, page } = await newPage(browser, { flagScript: stubPosthog(`'end-of-content'`) });
    await page.waitForTimeout(3500); // past the 3s guard
    await scrollTo(page, 0.7);
    check('no fire at 70% (variant threshold is 95%)', !(await modalVisible(page)));
    await scrollTo(page, 0.97);
    check('fires at 97%', await modalVisible(page));
    const shown = (await events(page)).find((x) => x.e === 'gate_modal_shown');
    check('payload timing:end-of-content',
      shown?.p?.ab_variant === 'flag:mobile-gate-timing,timing:end-of-content', JSON.stringify(shown?.p));
    await ctx.close();
  }

  // C — fallback (flags never resolve)
  {
    console.log('\nC: fallback (no flag → control behavior, fallback label)');
    const { ctx, page } = await newPage(browser, {
      flagScript: `window.posthog = { capture: (e,p) => window.__ph.push({e, p: p||{}}) };`, // no getFeatureFlag
    });
    await page.waitForTimeout(1000);
    await scrollTo(page, 0.97);
    check('unarmed pre-timeout: no fire even at 97%', !(await modalVisible(page)));
    await page.waitForTimeout(10000); // poll timeout (5s) + control min-time (10s from mount) both pass
    await scrollTo(page, 0.97);
    check('fires post-timeout with control params', await modalVisible(page));
    const shown = (await events(page)).find((x) => x.e === 'gate_modal_shown');
    check('payload timing:fallback (excluded from analysis)',
      shown?.p?.ab_variant === 'flag:mobile-gate-timing,timing:fallback', JSON.stringify(shown?.p));
    await ctx.close();
  }

  // D — race: flag resolves late; pre-resolution scroll must not fire
  {
    console.log('\nD: race (flag resolves at ~2.5s)');
    const { ctx, page } = await newPage(browser, {
      flagScript: `
        window.__flagReady = false;
        setTimeout(() => { window.__flagReady = true; }, 2500);
        window.posthog = {
          getFeatureFlag: (k) => (k === 'mobile-gate-timing' && window.__flagReady) ? 'end-of-content' : undefined,
          capture: (e, p) => window.__ph.push({ e, p: p || {} }),
        };`,
    });
    await page.waitForTimeout(800);
    await scrollTo(page, 0.97); // pre-resolution: listener must be unarmed
    check('scroll past 97% BEFORE flag resolves: no fire', !(await modalVisible(page)));
    await page.waitForTimeout(3200); // flag resolved (~2.5s) + variant 3s min-time from mount satisfied
    await scrollTo(page, 0.97);
    check('fires after resolution as end-of-content', await modalVisible(page));
    const shown = (await events(page)).find((x) => x.e === 'gate_modal_shown');
    check('no contamination: labeled end-of-content, not fallback/control',
      shown?.p?.ab_variant === 'flag:mobile-gate-timing,timing:end-of-content', JSON.stringify(shown?.p));
    await ctx.close();
  }

  // E — cooldown suppresses the scroll gate
  {
    console.log('\nE: cooldown (fresh dismissal stamp)');
    const { ctx, page } = await newPage(browser, {
      flagScript: stubPosthog(`'end-of-content'`),
      preload: `try { localStorage.setItem('bsc_gate_dismissed_at', String(Date.now() - 3600000)); } catch {}`,
    });
    await page.waitForTimeout(4000);
    await scrollTo(page, 0.97);
    check('no fire within 14d of dismissal', !(await modalVisible(page)));
    check('no gate_modal_shown emitted', !(await events(page)).some((x) => x.e === 'gate_modal_shown'));
    await ctx.close();
  }

  await browser.close();
  console.log(`\n${failures === 0 ? 'ALL SCENARIOS PASS' : failures + ' FAILURE(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
})();
