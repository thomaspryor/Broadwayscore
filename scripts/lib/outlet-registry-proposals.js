/**
 * BRO-6762 hole 6: turn the unknown-outlet queue into ready-to-review registry
 * entries, so an unregistered host is proposed instead of silently blocked
 * ('unregistered-host' in gap-ingest-policy). Pure; the audit owns the I/O.
 */
const { canonicalPublicationHost } = require('./host-suffix-lists');
const { isSaneOutletHost, MIN_OCCURRENCES } = require('./drain-unknown-outlets');
const GENERIC = new Set(['open', 'news', 'blog', 'blogs', 'www', 'm', 'amp', 'app', 'web', 'site', 'pages', 'www2']);

function humanize(id) {
  return String(id).replace(/[-_]+/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function registeredDomains(registry) {
  const set = new Set();
  for (const e of Object.values(registry || {})) {
    if (!e) continue;
    for (const d of [e.domain, ...(e.domainAliases || [])]) if (d) set.add(String(d).replace(/^www\./, ''));
  }
  return set;
}

/**
 * @param {{outlets?: object[]}} audit  unknown-aggregator-outlets.json
 * @param {object} registry             outlet-registry.json outlets map
 * @returns {{proposals: object[], skipped: {host: string, reason: string}[]}}
 */
function buildProposals(audit, registry, { minOccurrences = MIN_OCCURRENCES } = {}) {
  const known = registeredDomains(registry);
  const taken = new Set(Object.keys(registry || {}));
  const proposals = [];
  const skipped = [];
  const seen = new Set();
  for (const o of (audit && audit.outlets) || []) {
    const sample = (o.sampleUrls && o.sampleUrls[0]) || `https://${o.host}/`;
    const host = (canonicalPublicationHost(sample) || o.host || '').replace(/^www\./, '');
    const skip = (reason) => skipped.push({ host: o.host, reason });
    if (!host) { skip('no-host'); continue; }
    if (!isSaneOutletHost(host)) { skip('not-an-outlet'); continue; }
    if (known.has(host)) { skip('already-registered'); continue; }
    if ((o.occurrences || 0) < minOccurrences) { skip('below-min-occurrences'); continue; }
    const id = o.provisionalOutletId;
    if (!id || GENERIC.has(id)) { skip('generic-id'); continue; }
    if (taken.has(id) || seen.has(id)) { skip('id-collision'); continue; }
    seen.add(id);
    proposals.push({
      id,
      entry: {
        displayName: humanize(id),
        tier: 3,
        aliases: [id],
        domain: host,
        region: 'unknown',
        accessModel: 'unknown',
        starScale: null,
        domainAliases: [],
      },
      occurrences: o.occurrences,
      shows: o.shows || [],
      sampleUrls: (o.sampleUrls || []).slice(0, 3),
      reviewNeeded: ['tier', 'region', 'accessModel', 'starScale'],
    });
  }
  proposals.sort((a, b) => b.occurrences - a.occurrences);
  return { proposals, skipped };
}

module.exports = { buildProposals, humanize };
