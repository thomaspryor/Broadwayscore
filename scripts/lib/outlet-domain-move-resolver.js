'use strict';

/**
 * BRO-7822: decide a probable outlet domain move WITHOUT a card when the
 * evidence is unambiguous.
 *
 * "Quality: outlet domain moves" (health-check.js) flags an unregistered census
 * host whose identity slug equals a registered outlet's own domain slug. Every
 * flag became a digest card and a worker session that hand-added one host
 * (BRO-7335, BRO-7411, BRO-7761, BRO-8044 in 12 days). Most of those decisions
 * follow one of two shapes the registry already answers the same way every
 * time, so they are applied here instead:
 *
 *   platform-mirror   one side is a blog-platform subdomain (x.substack.com,
 *                     x.ghost.io, x.wordpress.com, ...) and the other carries
 *                     the IDENTICAL label (hackneycitizen.ghost.io <->
 *                     hackneycitizen.co.uk, theartsdispatch.com <->
 *                     theartsdispatch.substack.com). Registry ground truth on
 *                     2026-11-23: every such pair is recorded as a domainAlias.
 *   home-market-tld   same label, one side a generic TLD (.com/.org/.net) and
 *                     the other the ccTLD of the country the outlet already
 *                     reviews in, and every show the host was seen on is in a
 *                     market the outlet already has reviews in
 *                     (westendextra.co.uk <-> westendextra.com, a West End
 *                     paper seen on West End shows).
 *
 *   foreign-cctld-twin  (notDomainMove) two DIFFERENT national ccTLDs
 *                     (metro.us vs metro.co.uk, independent.ie vs
 *                     independent.co.uk): a paper does not change country.
 *
 * Everything else stays undecided and keeps the digest row: a
 * punctuation twin (curtain-up.com vs curtainup.com, a distinct Colorado site)
 * or an edition abroad (rollingstone.co.uk on a West End show) needs judgment.
 * A wrong alias credits a review to the wrong outlet and tier; undecided only
 * costs a card, so this never guesses.
 *
 * Pure: no I/O. `outletMarkets` maps outletId -> Set of markets the outlet has
 * reviews in; `showMarket` maps showId -> market (shows.json `market`).
 */

const { platformSuffixOf, multipartSuffixOf, stripCosmeticPrefixes } = require('./host-suffix-lists');
const { registrableHost } = require('./non-review-url-patterns');

const GENERIC_TLDS = new Set(['com', 'org', 'net']);
// The country a market's shows play in, as the ccTLDs a local paper would use.
const MARKET_CCTLDS = {
  broadway: ['us'],
  tour: ['us'],
  'west-end': ['co.uk', 'uk', 'org.uk'],
};
// A registry `region` that already says which market an outlet covers, for an
// outlet whose every review moved to the new host (West End Extra, BRO-7335,
// had 0 reviews left on westendextra.com).
const REGION_MARKET = { london: 'west-end', uk: 'west-end', nyc: 'broadway', 'new-york': 'broadway' };

// ccTLDs commonly bought as generic vanity domains: never read as a country.
const VANITY_CCTLDS = new Set(['tv', 'io', 'co', 'me', 'fm', 'ly', 'am', 'to', 'cc', 'ai', 'gg', 'is', 'it', 'la', 'ws', 'nu', 'vc', 'ac', 'sh', 'st']);
const countryOf = (suffix) => String(suffix || '').split('.').pop();
function isNationalCc(suffix) {
  const c = countryOf(suffix);
  return /^[a-z]{2}$/.test(c) && !VANITY_CCTLDS.has(c);
}

function hostShape(host) {
  const h = stripCosmeticPrefixes(registrableHost(String(host || '').toLowerCase()));
  if (!h) return null;
  const platform = platformSuffixOf(h);
  const multipart = platform ? null : multipartSuffixOf(h);
  const suffix = platform || multipart || h.split('.').pop();
  const rest = h.slice(0, -(suffix.length + 1));
  const label = rest.split('.').filter(Boolean).pop() || '';
  return { host: h, platform, suffix, label };
}

/**
 * @param {{host:string, outletId:string, shows?:string[]}} move  a findProbableDomainMoves row (+ census shows)
 * @param {object} outlets  registry `.outlets`
 * @param {{outletMarkets?: Map<string,Set<string>>|object, showMarket?: Map<string,string>|object}} ctx
 * @returns {{kind:'domainAlias'|'notDomainMove'|null, rule:string, reason:string}}
 */
function decideDomainMove(move, outlets, ctx = {}) {
  const outlet = outlets && move && outlets[move.outletId];
  if (!outlet || !outlet.domain) return { kind: null, rule: 'no-outlet', reason: 'outlet missing or has no domain' };
  const a = hostShape(move.host);
  const b = hostShape(outlet.domain);
  if (!a || !b || !a.label || a.label !== b.label) {
    return { kind: null, rule: 'label-differs', reason: `${move.host} and ${outlet.domain} differ in more than the suffix (e.g. a hyphen); needs judgment` };
  }

  // Never auto-alias onto a tier 1/2 outlet: a blog or mirror named after a
  // major paper (variety.substack.com, thestage.com) would inherit its weight.
  // Those stay a judgment call (second-opinion review, BRO-7822).
  const aliasAllowed = !(Number(outlet.tier) > 0 && Number(outlet.tier) <= 2);

  if (a.platform || b.platform) {
    if (a.platform && b.platform && a.platform === b.platform) {
      return { kind: null, rule: 'same-platform', reason: 'same platform, different subdomain shape; needs judgment' };
    }
    if (!aliasAllowed) return { kind: null, rule: 'major-outlet', reason: `${move.outletId} is tier ${outlet.tier}; a same-named blog is not trusted automatically` };
    return {
      kind: 'domainAlias',
      rule: 'platform-mirror',
      reason: `BRO-7822 auto: ${move.host} is the same "${a.label}" label as ${outlet.domain} on a blog platform (${a.platform || b.platform}); platform moves are always the same outlet`,
    };
  }

  // Two DIFFERENT national ccTLDs (metro.us vs metro.co.uk, independent.ie vs
  // independent.co.uk, artshub.com.au vs artshub.co.uk): a paper does not move
  // country, so this is a same-named paper elsewhere. Vanity ccTLDs used as
  // generic ones (.tv, .io, .co, ...) are excluded.
  if (isNationalCc(a.suffix) && isNationalCc(b.suffix) && countryOf(a.suffix) !== countryOf(b.suffix)) {
    return {
      kind: 'notDomainMove',
      rule: 'foreign-cctld-twin',
      reason: `BRO-7822 auto: ${move.host} (.${a.suffix}) and ${outlet.domain} (.${b.suffix}) are national domains of different countries; a same-named paper, not a move`,
    };
  }

  const get = (m, k) => (m instanceof Map ? m.get(k) : m && m[k]);
  const genericSide = GENERIC_TLDS.has(a.suffix) ? a : GENERIC_TLDS.has(b.suffix) ? b : null;
  const ccSide = genericSide === a ? b : a;
  if (!genericSide || GENERIC_TLDS.has(ccSide.suffix)) {
    return { kind: null, rule: 'tld-not-home-swap', reason: `${a.suffix} vs ${b.suffix} is not a generic-to-home-country swap; needs judgment` };
  }
  if (!aliasAllowed) return { kind: null, rule: 'major-outlet', reason: `${move.outletId} is tier ${outlet.tier}; a same-named site is not trusted automatically` };
  const shows = Array.isArray(move.shows) ? move.shows : [];
  if (shows.length === 0) return { kind: null, rule: 'no-shows', reason: 'no census shows to check the market against' };
  const outletMarketsRaw = get(ctx.outletMarkets, move.outletId);
  const outletMarkets = new Set(outletMarketsRaw || []);
  if (REGION_MARKET[outlet.region]) outletMarkets.add(REGION_MARKET[outlet.region]);
  for (const showId of shows) {
    const market = get(ctx.showMarket, showId);
    const cc = market && MARKET_CCTLDS[market];
    if (!cc) return { kind: null, rule: 'market-unknown', reason: `${showId} has no market with a known country` };
    if (!cc.includes(ccSide.suffix)) return { kind: null, rule: 'market-country-mismatch', reason: `${showId} (${market}) does not play in the .${ccSide.suffix} country` };
    if (!outletMarkets.has(market)) return { kind: null, rule: 'outlet-new-market', reason: `${move.outletId} has no ${market} reviews yet (an edition abroad, or a different paper)` };
  }
  return {
    kind: 'domainAlias',
    rule: 'home-market-tld',
    reason: `BRO-7822 auto: ${move.host} swaps ${outlet.domain}'s TLD for its home ccTLD (.${ccSide.suffix}) and every census show is in a market ${move.outletId} already reviews`,
  };
}

/**
 * outletId -> Set(market), from reviews.json rows + shows.json. `excludeHosts`
 * (registrable hosts) drops reviews already published on a host being judged,
 * so a host never vouches for its own market.
 */
function buildOutletMarkets(reviews, showMarket, { excludeHosts = null } = {}) {
  const out = new Map();
  for (const r of reviews || []) {
    if (!r || !r.outletId) continue;
    if (excludeHosts && excludeHosts.size && r.url) {
      let h = '';
      try { h = registrableHost(new URL(r.url).hostname.toLowerCase()); } catch { /* unparseable url: keep */ }
      if (h && excludeHosts.has(h)) continue;
    }
    const m = showMarket instanceof Map ? showMarket.get(r.showId) : showMarket && showMarket[r.showId];
    if (!m) continue;
    if (!out.has(r.outletId)) out.set(r.outletId, new Set());
    out.get(r.outletId).add(m);
  }
  return out;
}

module.exports = { decideDomainMove, buildOutletMarkets, hostShape, MARKET_CCTLDS, REGION_MARKET };
