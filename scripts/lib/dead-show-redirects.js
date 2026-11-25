/**
 * Hardcoded vercel.json `/show/<a>` → `/show/<b>` redirects run BEFORE the
 * middleware slug map, so a destination whose show was renamed or retired
 * sends the visitor straight into a 404 (8 found 2026-10-04, BRO-275 — e.g.
 * /show/the-choir-of-man → a slug that no longer existed).
 *
 * A destination is alive when it is a live show slug/id, or a key in the
 * generated slug-redirect map whose chain ends at a live slug. Parameterised
 * destinations (":slug") are left alone.
 */
function isDeadShowRedirect(redirect, liveSlugs, slugRedirectMap, liveIds) {
  const dest = redirect && redirect.destination;
  if (typeof dest !== 'string' || !dest.startsWith('/show/')) return false;
  let target = dest.slice('/show/'.length).replace(/\/$/, '');
  if (!target || target.includes(':') || target.includes('/') || target.includes('(')) return false;
  // Follow the generated map (A → B → C) to a live slug, guarding cycles. A
  // key whose chain ends at a retired slug is still dead. Show ids count as
  // alive because the prebuild regenerates an id → slug entry for every row,
  // even if the committed map predates the row.
  const seen = new Set();
  while (true) {
    if (liveSlugs.has(target) || (liveIds && liveIds.has(target))) return false;
    if (seen.has(target)) return true;
    seen.add(target);
    const next = slugRedirectMap && Object.prototype.hasOwnProperty.call(slugRedirectMap, target.toLowerCase())
      ? slugRedirectMap[target.toLowerCase()] : null;
    if (typeof next !== 'string' || !next) return true;
    target = next.replace(/^~/, '');
  }
}

function findDeadShowRedirects(redirects, liveSlugs, slugRedirectMap, liveIds) {
  const list = redirects || [];
  // A destination that is itself the source of another hardcoded redirect is
  // alive while that redirect is alive (e.g. /show/la-traviata →
  // /show/la-traviata-off-broadway → /opera/...). Iterate to a fixed point.
  let dead = new Set(list.filter(r => isDeadShowRedirect(r, liveSlugs, slugRedirectMap, liveIds)));
  for (let changed = true; changed;) {
    changed = false;
    const aliveSources = new Set(list.filter(r => !dead.has(r)).map(r => r.source));
    for (const r of dead) {
      if (aliveSources.has(r.destination.replace(/\/$/, ''))) { dead.delete(r); changed = true; }
    }
  }
  return list.filter(r => dead.has(r));
}

/**
 * BRO (2026-11-25): a hardcoded `/show/<x>` → `/show/<y>` redirect whose SOURCE
 * is the slug of a live show hijacks that show's page. Example: when the
 * Broadway `birthright` (Hudson Theatre) was added, an old
 * /show/birthright → /show/birthright-off-broadway rule from the off-Broadway
 * run still 301'd every visitor away from it. vercel.json redirects run before
 * the page route, so the live page was unreachable.
 *
 * Exempt: redirects whose destination is not a /show/ page (e.g. the
 * /show/<slug>-off-broadway → /opera/<slug> rules, which intentionally move
 * a live opera row to its own route). Parameterised sources are ignored.
 */
function findShadowingShowRedirects(redirects, liveSlugs) {
  return (redirects || []).filter((r) => {
    const src = r && r.source;
    const dest = r && r.destination;
    if (typeof src !== 'string' || typeof dest !== 'string') return false;
    if (!src.startsWith('/show/') || !dest.startsWith('/show/')) return false;
    const slug = src.slice('/show/'.length).replace(/\/$/, '').toLowerCase();
    if (!slug || /[:/(*]/.test(slug)) return false;
    if (dest.replace(/\/$/, '') === src.replace(/\/$/, '')) return false;
    // Slugs only: a /show/<id> -> /show/<slug> rule is an alias, not a hijack.
    return liveSlugs.has(slug);
  });
}

module.exports = { isDeadShowRedirect, findDeadShowRedirects, findShadowingShowRedirects };
