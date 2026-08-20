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

// Declared PRIMARY-domain vs. domainAliases overlaps (task #1270). The
// original gate only ever scanned each outlet's primary `domain`, so an
// outlet claiming another outlet's domain via `domainAliases` was invisible
// to it — the exact same undeclared-shared-host bug class the gate exists to
// prevent, reachable through a field it never checked. A domainAliases-
// inclusive scan of the live registry (2026-08-11) found 4 such pairs; each
// was individually investigated against reviews.json/review-texts before
// being declared here:
const DECLARED_ALIAS_OVERLAPS = [
  // AP wire copy syndicates on abcnews.go.com. 'ap' is in
  // review-normalization.js's WIRE_SERVICE_OUTLETS set, so the cross-outlet
  // merge guard never blocks it on this host regardless of which outlet the
  // resolver picks, and buildDomainToOutletIndex's primary-domain-wins rule
  // deterministically resolves the host to abc-news (its primary owner) —
  // genuinely ambiguous by URL alone, but already safe at runtime.
  ['ap', 'abc-news'],
  // Critic Robert Sholiton runs two blogs — Gotham Playgoer
  // (gotham-playgoer.blogspot.com) and Bob's Theater Blog
  // (bobstheaterblog.com) — and has cross-posted a handful of reviews onto
  // the other blog's blogspot host. Verified in reviews.json: both outlets
  // carry real, distinct reviews with URLs on bobs-theater-blog.blogspot.com.
  ['gotham-playgoer', 'bobs-theater-blog'],
  // CONFIRMED accidental registry duplicate, not yet merged. dctheatrescene
  // and dc-metro-theater-arts are the same real publication (DC Theatre
  // Scene rebranded to DC Metro Theater Arts): same critics (Richard Seff,
  // Deb Miller), same host (dcmetrotheaterarts.com); 16
  // dc-metro-theater-arts--*.json review-text files duplicate an identity
  // dctheatrescene already owns. Declared (not merged) because
  // data/review-texts carried another live session's uncommitted WIP when
  // this was found, making a same-repo file rename unsafe to attempt here —
  // see Notion card for the follow-up merge.
  ['dctheatrescene', 'dc-metro-theater-arts'],
  // CONFIRMED accidental registry duplicate, not yet merged. chicago-sun-times
  // and suntimes are the same real publication (Chicago Sun-Times): same
  // critics (Catey Sullivan, Steven Oxman), same host (chicago.suntimes.com);
  // 7 suntimes--*.json review-text files duplicate an identity
  // chicago-sun-times already owns. Declared (not merged) for the same
  // review-texts-WIP reason as above — see Notion card for the follow-up
  // merge.
  ['chicago-sun-times', 'suntimes'],
];

function normalizeDomain(d) {
  return String(d || '').replace(/^www\./, '').toLowerCase().trim();
}

/**
 * @param {object} outlets - registry.outlets map (id → entry)
 * @returns {Array<{domain: string, outletIds: string[]}>} collision groups not
 *   fully covered by a declared edition pair or alias overlap, sorted by domain.
 */
function findUndeclaredDomainCollisions(outlets) {
  const byDomain = new Map();
  for (const [id, entry] of Object.entries(outlets || {})) {
    if (id === '_aliasIndex' || id === '_meta') continue;
    const domains = new Set();
    const primary = normalizeDomain(entry && entry.domain);
    if (primary) domains.add(primary);
    if (Array.isArray(entry && entry.domainAliases)) {
      for (const alias of entry.domainAliases) {
        const d = normalizeDomain(alias);
        if (d) domains.add(d);
      }
    }
    for (const domain of domains) {
      if (!byDomain.has(domain)) byDomain.set(domain, []);
      byDomain.get(domain).push(id);
    }
  }

  const declared = [...EDITION_PAIRS, ...DECLARED_ALIAS_OVERLAPS].map((pair) => new Set(pair));
  const collisions = [];
  for (const [domain, ids] of byDomain) {
    if (ids.length < 2) continue;
    const covered = declared.some((pair) => ids.every((id) => pair.has(id)));
    if (!covered) collisions.push({ domain, outletIds: [...ids].sort() });
  }
  return collisions.sort((a, b) => a.domain.localeCompare(b.domain));
}

/**
 * Would registering `candidateId` with `candidateDomain` create an undeclared
 * primary-domain collision against the outlets already in the registry?
 *
 * For callers that AUTO-CREATE new outlet entries and infer a domain from the
 * outlet's own review URLs (rebuild-all-reviews.js's AUTO-REGISTER NEW
 * OUTLETS block) — that inference has no way to know the inferred domain is
 * already claimed by an existing outlet, so it must ask this gate before
 * writing the domain. Without it, any new outlet whose reviews happen to
 * share a masthead's host with an already-registered outlet (e.g. a
 * venue-disambiguated "the-times-barbican" sharing thetimes.co.uk with
 * "times-uk") gets auto-stamped with a colliding domain on creation, turning
 * validate-data.js's domain-collision gate red until a later cleanup pass
 * nulls it back out (task #1776 — this exact class caused repeat main-red
 * incidents).
 *
 * @param {object} outlets - registry.outlets map (id → entry), NOT yet
 *   containing candidateId
 * @param {string} candidateId
 * @param {string|null|undefined} candidateDomain
 * @returns {boolean}
 */
function wouldCauseDomainCollision(outlets, candidateId, candidateDomain) {
  const domain = normalizeDomain(candidateDomain);
  if (!domain) return false;
  const withCandidate = { ...(outlets || {}), [candidateId]: { domain: candidateDomain } };
  const collisions = findUndeclaredDomainCollisions(withCandidate);
  return collisions.some((c) => c.outletIds.includes(candidateId));
}

module.exports = {
  EDITION_PAIRS,
  DECLARED_ALIAS_OVERLAPS,
  findUndeclaredDomainCollisions,
  wouldCauseDomainCollision,
};
