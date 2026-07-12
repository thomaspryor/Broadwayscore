/**
 * Primary-domain collision gate for outlet-registry.json.
 *
 * Two outlets sharing a primary `domain` make URL-based outlet resolution
 * ambiguous for that domain: buildDomainToOutletIndex picks one winner, so the
 * other outlet can never be positively identified from a URL. The old
 * last-write-wins rule silently handed telegraph.co.uk to sunday-telegraph and
 * mis-homed 161 daily-Telegraph reviews at T3 weight (card 39b637c5-416f-81db).
 *
 * The only collisions allowed are DECLARED edition pairs — deliberate splits of
 * one masthead where byline/section data (not the URL) assigns the edition.
 * Anything else is either an accidental registry duplicate (merge it — see the
 * 2026-07-12 six-pair merge, card 39b637c5-416f-8175) or a new outlet
 * squatting on an existing outlet's domain (fix the domain).
 */
const EDITION_PAIRS = [
  ['telegraph', 'sunday-telegraph'],   // telegraph.co.uk
  ['express-uk', 'sunday-express'],    // express.co.uk
  ['timeout', 'timeout-london'],       // timeout.com (path-split /london)
];

function normalizeDomain(d) {
  return String(d || '').replace(/^www\./, '').toLowerCase().trim();
}

/**
 * @param {object} outlets - registry.outlets map (id → entry)
 * @returns {Array<{domain: string, outletIds: string[]}>} collision groups not
 *   fully covered by a declared edition pair, sorted by domain.
 */
function findUndeclaredDomainCollisions(outlets) {
  const byDomain = new Map();
  for (const [id, entry] of Object.entries(outlets || {})) {
    if (id === '_aliasIndex' || id === '_meta') continue;
    const domain = normalizeDomain(entry && entry.domain);
    if (!domain) continue;
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain).push(id);
  }

  const declared = EDITION_PAIRS.map((pair) => new Set(pair));
  const collisions = [];
  for (const [domain, ids] of byDomain) {
    if (ids.length < 2) continue;
    const covered = declared.some((pair) => ids.every((id) => pair.has(id)));
    if (!covered) collisions.push({ domain, outletIds: [...ids].sort() });
  }
  return collisions.sort((a, b) => a.domain.localeCompare(b.domain));
}

module.exports = { EDITION_PAIRS, findUndeclaredDomainCollisions };
