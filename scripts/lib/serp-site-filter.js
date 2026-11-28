/**
 * Pure deciders for `site:` SERP answers (BRO-7531).
 *
 * When a `site:x.com "Title" review` query has no match on x.com, Google (as
 * relayed by Scrapingdog / Bright Data / ScrapingBee) often answers with its
 * "no exact match" fallback: a handful of results from OTHER domains
 * (youtube, facebook, our own site). That is the same signal as an empty
 * answer, but it is a non-empty array, so _serpWithChain cached it for 24h
 * even on press night (emptyAuthoritative:false), hiding a review published
 * minutes later. Live probe 2026-11-15: `site:nystagereview.com "The Visitors"
 * Off-Broadway review 2026` returned only youtube.com + broadwayworld.com.
 *
 * It is also what a FAILED ask looks like. Measured live 2026-11-15 on
 * Scrapingdog: the same `site:` query asked repeatedly flips between on-domain
 * results and 10 results that are all off-domain (the filter was ignored on
 * 14 of 45 identical asks of queries with certain matches; putting site: last
 * is worse, 18 of 30). Of 182 such answers re-asked once, 50 came back with
 * on-domain results (27 of the 52 where the outlet's review is already in our
 * data). A re-ask costs 5 credits and yields about what a first ask does.
 *
 * These helpers only decide. _serpWithChain uses them to (a) re-ask
 * Scrapingdog once, and (b) keep such an answer out of the 24h cache on
 * emptyAuthoritative:false flows. discoverCorrectUrl uses them to run its
 * alternate-title / no-site / no-date fallbacks, which used to run only on a
 * literally empty answer.
 */

/**
 * Hostnames named by the POSITIVE site: clauses of a query.
 * - `-site:x.com` exclusions are ignored (brand-mention-serp.js sends those;
 *   every result is correctly off those domains).
 * - `(site:a OR site:b)` groups from buildSiteClause yield both.
 * - Path forms (`site:reddit.com/r/Broadway`) compare by hostname only.
 */
function positiveSiteDomains(query) {
  if (typeof query !== 'string' || !query) return [];
  const out = [];
  const re = /(^|[\s(])(-?)site:([^\s()"']+)/gi;
  let m;
  while ((m = re.exec(query)) !== null) {
    if (m[2] === '-') continue;
    const host = m[3].split('/')[0].toLowerCase().replace(/^www\./, '').replace(/[.,;:]+$/, '');
    if (host && host.includes('.') && !out.includes(host)) out.push(host);
  }
  return out;
}

function _hostOf(result) {
  const raw = result && (result.url || result.link);
  if (typeof raw !== 'string' || !raw) return '';
  try { return new URL(raw).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

/**
 * True when a query restricted to site: domains came back NON-EMPTY with zero
 * results on any of those domains. An unparsable result URL counts as
 * off-domain (it cannot be the review either way).
 *
 * @param {string} query
 * @param {Array<{url?: string, link?: string}>} results
 * @param {(expected: string, actual: string) => boolean} domainMatches
 *   scraper.js domainMatchesExpected, injected so alias groups and registry
 *   aliases stay in step with discoverCorrectUrl's host gate.
 */
function isOffDomainOnlyAnswer(query, results, domainMatches) {
  if (!Array.isArray(results) || results.length === 0) return false;
  const domains = positiveSiteDomains(query);
  if (domains.length === 0) return false;
  const matches = typeof domainMatches === 'function'
    ? domainMatches
    : (expected, actual) => actual === expected || actual.endsWith('.' + expected);
  for (const r of results) {
    const host = _hostOf(r);
    if (host && domains.some((d) => matches(d, host))) return false;
  }
  return true;
}

/**
 * Ask Scrapingdog once more? Only for an answer that ignored a positive site:
 * filter. Kill switch: SERP_SITE_REASK=0.
 */
function shouldReaskIgnoredSiteFilter(query, results, domainMatches, env = process.env) {
  if (env && env.SERP_SITE_REASK === '0') return false;
  return isOffDomainOnlyAnswer(query, results, domainMatches);
}

/**
 * Does the re-ask's answer replace the first one? Only when it has on-domain
 * results. A failed (null) or again-off-domain re-ask keeps the first answer.
 * So does a clean empty: the same measurement saw queries with certain
 * matches come back empty on 23 of 59 re-asks, so an empty is no more
 * trustworthy than the filler, and callers treat both as "nothing found".
 */
function preferReaskAnswer(query, second, domainMatches) {
  return Array.isArray(second) && second.length > 0 && !isOffDomainOnlyAnswer(query, second, domainMatches);
}

module.exports = { positiveSiteDomains, isOffDomainOnlyAnswer, shouldReaskIgnoredSiteFilter, preferReaskAnswer };
