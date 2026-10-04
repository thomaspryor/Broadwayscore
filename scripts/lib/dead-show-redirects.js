/**
 * Hardcoded vercel.json `/show/<a>` → `/show/<b>` redirects run BEFORE the
 * middleware slug map, so a destination whose show was renamed or retired
 * sends the visitor straight into a 404 (8 found 2026-10-04, BRO-275 — e.g.
 * /show/the-choir-of-man → a slug that no longer existed).
 *
 * A destination is alive when it is a live show slug or a key in the
 * generated slug-redirect map (which forwards it on). Parameterised
 * destinations (":slug") are left alone.
 */
function isDeadShowRedirect(redirect, liveSlugs, slugRedirectMap) {
  const dest = redirect && redirect.destination;
  if (typeof dest !== 'string' || !dest.startsWith('/show/')) return false;
  const target = dest.slice('/show/'.length).replace(/\/$/, '');
  if (!target || target.includes(':') || target.includes('/') || target.includes('(')) return false;
  if (liveSlugs.has(target)) return false;
  if (slugRedirectMap && Object.prototype.hasOwnProperty.call(slugRedirectMap, target.toLowerCase())) return false;
  return true;
}

function findDeadShowRedirects(redirects, liveSlugs, slugRedirectMap) {
  return (redirects || []).filter(r => isDeadShowRedirect(r, liveSlugs, slugRedirectMap));
}

module.exports = { isDeadShowRedirect, findDeadShowRedirects };
