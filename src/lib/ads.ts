/**
 * Google AdSense: slot config, script loader and the pure render decision
 * (BRO-5893, sprint-plan-adsense.md B-T2/B-T9).
 *
 * Ships dark: every slot id is '' until the owner's AdSense account is
 * approved and the unit exists, and the PostHog `ads` flag sits at 0% `ads`.
 * With an empty slot id, decideAdRender() is false for everyone, so no
 * visitor sees a box or loads the Google script. ADSENSE_CLIENT is set so
 * ads.txt and the verification meta tag can serve during Google's review.
 *
 * Kept free of React and `@/` imports: src/middleware.ts (edge) and the
 * unit tests import it directly.
 */

/** Publisher id (`ca-pub-…`). Public, not a secret. */
export const ADSENSE_CLIENT = 'ca-pub-5443308376628971';

/** The `ads.txt` record authorizing Google to sell this publisher's inventory. */
export const ADS_TXT_LINE = `google.com, ${ADSENSE_CLIENT.replace(/^ca-/, '')}, DIRECT, f08c47fec0942fa0`;

/** PostHog multivariate flag: `ads` / `no-ads`. Unresolved = no ads. */
export const ADS_FLAG = 'ads';

export const AD_SLOTS = {
  // Fixed 300×250 display unit `bwsc-show-inline` (not responsive: a
  // responsive unit can outgrow its box and get clipped, which breaks policy).
  showInline: { id: '', width: 300, height: 250 },
} as const;

export type AdSlotName = keyof typeof AD_SLOTS;

/** First-party cookie set by src/middleware.ts on /show/* pages. */
export const AD_REGION_COOKIE = 'bwsc_ad_region';
/** Self-opt-out cookie (owner's own browsing, monitoring tools). */
export const NO_ADS_COOKIE = 'bwsc_noads';

export type AdRegion = 'ads-ok' | 'no-ads';

/**
 * No ads for visitors in the UK, the EEA or Switzerland (owner decision
 * 2026-10-22): EU-27 + IS, LI, NO + GB + CH. Keeps Google's consent pop-up
 * from ever appearing.
 */
export const NO_AD_COUNTRIES: ReadonlySet<string> = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  'IS', 'LI', 'NO', 'GB', 'CH',
]);

/** `x-vercel-ip-country` value → region. Missing/unknown country = no ads. */
export function adRegionForCountry(code: string | null | undefined): AdRegion {
  const c = (code || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return 'no-ads';
  return NO_AD_COUNTRIES.has(c) ? 'no-ads' : 'ads-ok';
}

const AUTOMATION_UA_RE = /HeadlessChrome|Lighthouse|PageSpeed|Chrome-Lighthouse|GTmetrix|Playwright/i;

export interface AutomationSignals {
  webdriver?: boolean;
  userAgent?: string;
  search?: string;
  cookie?: string;
}

/** Pure: do these browser signals mean automation (or an opted-out viewer)? */
export function isAutomatedSignals({ webdriver, userAgent, search, cookie }: AutomationSignals): boolean {
  if (webdriver === true) return true;
  if (userAgent && AUTOMATION_UA_RE.test(userAgent)) return true;
  if (search && new URLSearchParams(search).get('noads') === '1') return true;
  if (cookie && readCookie(cookie, NO_ADS_COOKIE) === '1') return true;
  return false;
}

/**
 * True for headless/automated browsers, Lighthouse-style auditors, `?noads=1`
 * and the `bwsc_noads=1` cookie. Our own CI and monitoring hit production, and
 * AdSense counts their impressions as invalid traffic. SSR = true (no ads).
 */
export function isAutomatedBrowser(): boolean {
  if (typeof window === 'undefined') return true;
  return isAutomatedSignals({
    webdriver: navigator.webdriver,
    userAgent: navigator.userAgent,
    search: window.location.search,
    cookie: document.cookie,
  });
}

export function readCookie(cookieHeader: string, name: string): string | undefined {
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw; // malformed %-escape: never throw inside AdSlot's effect
    }
  }
  return undefined;
}

/** Region from the middleware cookie; anything but 'ads-ok' is undefined. */
export function readAdRegion(): AdRegion | undefined {
  if (typeof document === 'undefined') return undefined;
  const v = readCookie(document.cookie, AD_REGION_COOKIE);
  return v === 'ads-ok' || v === 'no-ads' ? v : undefined;
}

export interface AdRenderInput {
  variant: string | undefined;
  authLoading: boolean;
  isAuthenticated: boolean;
  automated: boolean;
  region: AdRegion | string | undefined;
  /** Defaults to ADSENSE_CLIENT; injectable for tests. */
  client?: string;
  /** The slot's `data-ad-slot` id. */
  slotId: string;
}

/**
 * Pure: render the ad only when every condition holds. An unresolved flag,
 * auth still loading, or an unknown region all mean no ads, so the flag's
 * `no-ads` setting is a kill switch that reaches everyone.
 */
export function decideAdRender({
  variant,
  authLoading,
  isAuthenticated,
  automated,
  region,
  client = ADSENSE_CLIENT,
  slotId,
}: AdRenderInput): boolean {
  // TODO(BRO-5893): remove once the slot id is committed
  if (!client || !slotId) return false;
  return (
    variant === 'ads' &&
    !authLoading &&
    !isAuthenticated &&
    !automated &&
    region === 'ads-ok'
  );
}

let adsenseLoading: Promise<boolean> | null = null;

/**
 * Inject adsbygoogle.js once. Resolves false when the script fails or is
 * blocked (ad blockers), so the caller renders nothing. A failure is not
 * cached: the next show page tries again.
 */
export function loadAdSense(): Promise<boolean> {
  if (typeof window === 'undefined' || !ADSENSE_CLIENT) return Promise.resolve(false);
  if (adsenseLoading) return adsenseLoading;

  adsenseLoading = new Promise((resolve) => {
    const script = document.createElement('script');
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(ADSENSE_CLIENT)}`;
    script.onload = () => resolve(true);
    script.onerror = () => {
      script.remove();
      adsenseLoading = null;
      resolve(false);
    };
    document.head.appendChild(script);
  });

  return adsenseLoading;
}
