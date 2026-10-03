import { SHARED_PLAN_REDACTED, SHARED_PLAN_SEGMENT_SOURCE } from './redact-url';

/**
 * The inline GA4 bootstrap AnalyticsWrapper renders. A function (not a JSX
 * template literal) so tests/unit/analytics-redaction.test.ts can execute it
 * against a fake window and prove what it does.
 *
 * Shared Plans privacy (BRO-4481): GA is switched off on /plans pages via
 * Google's documented `ga-disable-<ID>` flag, and a plans URL arriving as the
 * first page's referrer is redacted with the same pattern as redact-url.ts.
 */
export function gaInitScript(measurementId: string): string {
  const id = JSON.stringify(measurementId);
  return `
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
var __bwscOwner = false;
try { __bwscOwner = localStorage.getItem('bwsc-owner') === 'true'; } catch (e) {}
if (location.pathname === '/plans' || location.pathname.indexOf('/plans/') === 0) window['ga-disable-' + ${id}] = true;
var __bwscCfg = __bwscOwner ? { traffic_type: 'internal' } : {};
var __bwscRef = document.referrer.replace(new RegExp(${JSON.stringify(SHARED_PLAN_SEGMENT_SOURCE)}, 'g'), ${JSON.stringify(SHARED_PLAN_REDACTED)});
if (__bwscRef !== document.referrer) __bwscCfg.page_referrer = __bwscRef;
gtag('config', ${id}, __bwscCfg);
`;
}
