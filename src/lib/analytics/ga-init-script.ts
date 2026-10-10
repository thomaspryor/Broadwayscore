import { PRIVATE_SHARE_PREFIXES, PRIVATE_SHARE_REDACTED, PRIVATE_SHARE_SEGMENT_SOURCE } from './redact-url';

/**
 * The inline GA4 bootstrap AnalyticsWrapper renders. A function (not a JSX
 * template literal) so tests/unit/analytics-redaction.test.ts can execute it
 * against a fake window and prove what it does.
 *
 * Share-link privacy (BRO-4481, BRO-4566): GA is switched off on every
 * private share page (PRIVATE_SHARE_PREFIXES) via Google's documented
 * `ga-disable-<ID>` flag, and a share URL arriving as the first page's
 * referrer is redacted with the same pattern as redact-url.ts.
 */
export function gaInitScript(measurementId: string): string {
  const id = JSON.stringify(measurementId);
  return `
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
var __bwscOwner = false;
try { __bwscOwner = localStorage.getItem('bwsc-owner') === 'true'; } catch (e) {}
var __bwscPriv = ${JSON.stringify(PRIVATE_SHARE_PREFIXES)};
for (var __i = 0; __i < __bwscPriv.length; __i++) {
  if (location.pathname === '/' + __bwscPriv[__i] || location.pathname.indexOf('/' + __bwscPriv[__i] + '/') === 0) window['ga-disable-' + ${id}] = true;
}
var __bwscCfg = __bwscOwner ? { traffic_type: 'internal' } : {};
var __bwscRef = document.referrer.replace(new RegExp(${JSON.stringify(PRIVATE_SHARE_SEGMENT_SOURCE)}, 'g'), ${JSON.stringify(PRIVATE_SHARE_REDACTED)});
if (__bwscRef !== document.referrer) __bwscCfg.page_referrer = __bwscRef;
gtag('config', ${id}, __bwscCfg);
`;
}
