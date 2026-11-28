/**
 * Shared Plans privacy (BRO-4481): leave a /plans/<token> page with a full
 * document load, never a client-side (Next.js router) navigation.
 *
 * GA4's history-change page_view, fired by a client-side navigation out of a
 * plans page, carries the plans URL — token included — as page_referrer
 * (verified 2026-10-03 against the live property's gtag.js with every collect
 * request intercepted: dl=/, dr=/plans/<token>). A document load instead goes
 * through gaInitScript, which redacts a plans referrer before GA's first hit,
 * and Back returns to a separate document that disables GA again on load.
 *
 * Pure decision so it is unit-tested; LeaveByDocument applies it.
 */
export interface LinkClick {
  href: string | null;
  currentHref: string;
  target: string | null;
  download: boolean;
  button: number;
  modified: boolean;
  defaultPrevented: boolean;
}

/** The URL to load as a new document, or null to leave the click alone. */
export function documentNavigationFor(click: LinkClick): string | null {
  if (!click.href || click.defaultPrevented || click.button !== 0 || click.modified || click.download) return null;
  if (click.target && click.target !== '_self') return null;
  let url: URL;
  let here: URL;
  try {
    here = new URL(click.currentHref);
    url = new URL(click.href, here);
  } catch {
    return null;
  }
  if (url.origin !== here.origin) return null; // off-site: the browser loads a document anyway
  if (url.pathname.startsWith('/api/')) return null; // downloads (.ics) keep their default
  if (url.pathname === here.pathname && url.search === here.search) return null; // same page / #hash
  return url.href;
}
