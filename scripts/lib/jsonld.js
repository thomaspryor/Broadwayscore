'use strict';
/**
 * One place that knows how schema.org JSON-LD is actually shaped in the wild.
 *
 * THE DEFECT THIS EXISTS TO PREVENT (Rhinoceros at A.R.T., 2026-08-24):
 * every JSON-LD reader in this repo was written as
 *
 *     const items = Array.isArray(parsed) ? parsed : [parsed];
 *
 * which handles a bare node and a top-level array but NOT a `@graph`. Playbill
 * (and every Yoast-powered site) wraps its NewsArticle in one:
 *
 *     {"@context":"https://schema.org","@graph":[{"@type":"NewsArticle",...}]}
 *
 * so the top-level object carries no @type, no datePublished, no headline —
 * and a reader looking for those finds nothing. In aggregator-candidate-
 * extract.js that made isBotShell() fail its date signal, and a real 159KB
 * article was rejected as a Cloudflare block page on every daily run for 12
 * days. Every regional/off-Broadway show Playbill covered was dropped.
 *
 * The fix is not "remember to handle @graph" — it is that no caller writes
 * that ternary again. scripts/lib/audit-jsonld-graph.js fails CI if one does.
 */

/**
 * Flatten one parsed JSON-LD payload into the schema.org nodes it carries.
 * Handles the three shapes publishers actually ship:
 *   1. a bare node         -> [node]
 *   2. a top-level array   -> its elements
 *   3. a `@graph` wrapper  -> the wrapper AND its nodes, including a @graph
 *                             nested inside an array element (some CMSes).
 *
 * The wrapper itself is kept so a caller reading a property that legitimately
 * lives at the top level (e.g. `@context`) still sees it.
 *
 * Never throws: malformed third-party JSON-LD must not crash a batch run.
 *
 * @param {unknown} parsed - the result of JSON.parse on one ld+json block
 * @returns {object[]} nodes, in document order, wrapper before its graph
 */
function jsonLdItems(parsed) {
  const out = [];
  const top = Array.isArray(parsed) ? parsed : [parsed];
  for (const node of top) {
    if (!node || typeof node !== 'object') continue;
    out.push(node);
    const graph = node['@graph'];
    if (Array.isArray(graph)) {
      for (const g of graph) {
        if (g && typeof g === 'object') out.push(g);
      }
    }
  }
  return out;
}

/**
 * JSON.parse one ld+json block's text and flatten it. Returns [] rather than
 * throwing on malformed input — uncontrolled third-party markup is the norm,
 * and one bad block must never take down the caller.
 *
 * @param {string} text - raw textContent of a <script type="application/ld+json">
 * @returns {object[]}
 */
function parseJsonLd(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  return jsonLdItems(parsed);
}

/**
 * True when a node's `@type` matches `type`. schema.org allows @type to be a
 * string OR an array of strings — LondonTheatre.co.uk emits
 * `"@type": ["Event","TheaterEvent"]` — so a bare `=== 'TheaterEvent'` check
 * silently drops those. Same bug class as the @graph miss: a shape the spec
 * allows that the reader never anticipated.
 *
 * @param {object} node
 * @param {string} type
 * @returns {boolean}
 */
function hasJsonLdType(node, type) {
  if (!node || typeof node !== 'object') return false;
  const t = node['@type'];
  if (typeof t === 'string') return t === type;
  if (Array.isArray(t)) return t.includes(type);
  return false;
}

module.exports = { jsonLdItems, parseJsonLd, hasJsonLdType };
