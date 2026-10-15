// Header overflow probe shared by scripts/check-header-overflow.mjs (BRO-4575)
// and the daily UX walkthrough (BRO-4604). A position:fixed header that
// overflows does not widen the document, so the walkthrough's document
// scrollWidth probe cannot see it; this measures the header <nav> itself.

// Runs in the page. Returns { scrollWidth, clientWidth, offenders[], accountVisible }.
export function probe({ simulateSignedIn } = {}) {
  const nav = document.querySelector('header.fixed.top-0 nav');
  if (!nav) return { error: 'header nav not found' };
  const signIn = nav.querySelector('button[aria-label="Sign in"]');
  if (simulateSignedIn && signIn) {
    // Mirrors the authenticated branch of src/components/HeaderUserIcon.tsx.
    const a = document.createElement('a');
    a.href = '/my-shows';
    a.setAttribute('aria-label', 'My Shows');
    a.className = 'hidden sm:flex items-center shrink-0 gap-1.5 px-2 py-1.5 text-sm text-gray-400 hover:text-white transition-colors rounded-lg hover:bg-white/[0.05]';
    a.innerHTML = '<span class="block w-6 h-6 rounded-full border border-white/20"></span><span class="hidden md:inline">My Shows</span>';
    signIn.replaceWith(a);
  }
  const account = nav.querySelector('[aria-label="Sign in"], [aria-label="My Shows"]');
  const accountVisible = !!account && account.getBoundingClientRect().width > 0;
  const vw = document.documentElement.clientWidth;
  const offenders = [];
  for (const el of nav.querySelectorAll('a, button, input')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue; // display:none / hidden
    if (r.left < -1 || r.right > vw + 1) {
      const label = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || el.tagName)
        .trim().replace(/\s+/g, ' ').slice(0, 40);
      offenders.push(`${el.tagName.toLowerCase()} "${label}" right=${Math.round(r.right)} vw=${vw}`);
    }
  }
  return { scrollWidth: nav.scrollWidth, clientWidth: nav.clientWidth, offenders, accountVisible };
}

// Walkthrough findings for the current page: [] when the header fits.
export async function headerOverflowFindings(page, vpLabel, stateName, { simulateSignedIn = false } = {}) {
  const res = await page.evaluate(probe, { simulateSignedIn });
  const screenshot = `${vpLabel}__${stateName}`;
  // Deterministic findings file board cards without a two-model agreement
  // check, so an error/maintenance page (no header nav) is logged, not filed.
  if (res.error) {
    console.error(`[ux-walkthrough] header probe on ${stateName} (${vpLabel}) skipped: ${res.error}`);
    return [];
  }
  // 1px tolerance, same as the offender check: sub-pixel rounding is not a defect.
  if (res.scrollWidth <= res.clientWidth + 1 && res.offenders.length === 0) return [];
  const detail = res.offenders.length ? `; offscreen: ${res.offenders.join('; ')}` : '';
  return [{
    summary: `Header overflow on ${stateName} (${vpLabel}): nav scrollWidth=${res.scrollWidth} exceeds clientWidth=${res.clientWidth}${detail}`,
    screenshot, severity: 'high', tag: 'probe',
  }];
}

// Tablet widths sit between the mobile hamburger and the desktop nav, where
// BRO-4575 clipped Sign in and the hamburger unnoticed (390 and 1440 only).
export const TABLET_VIEWPORT = { label: 'tablet', width: 768, height: 1024 };

// Home state only, signed out: the header is identical on every page.
// `shoot(page, name)` (optional) saves the screenshot a finding cites.
export async function captureTabletHeader({ browser, baseUrl, shoot }) {
  const findings = [];
  const shots = [];
  let context;
  try {
    context = await browser.newContext({ viewport: { width: TABLET_VIEWPORT.width, height: TABLET_VIEWPORT.height } });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/`, { waitUntil: 'load', timeout: 20000 });
    await page.waitForTimeout(1000);
    // Signed-out first, then the signed-in header (wider: "My Shows" + avatar)
    // swapped in for the Sign in pill, as check-header-overflow.mjs does.
    const found = [
      ...await headerOverflowFindings(page, TABLET_VIEWPORT.label, 'home'),
      ...await headerOverflowFindings(page, TABLET_VIEWPORT.label, 'home_signed_in', { simulateSignedIn: true }),
    ];
    if (found.length && shoot) {
      const name = `${found[0].screenshot}`;
      shots.push({ name, file: await shoot(page, name) });
    }
    findings.push(...found);
  } catch (err) {
    console.error(`[ux-walkthrough] tablet header probe failed: ${err.message}`);
  } finally {
    if (context) await context.close().catch(() => {});
  }
  return { findings, shots };
}
