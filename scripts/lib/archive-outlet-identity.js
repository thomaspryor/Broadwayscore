/**
 * Outlet identity for aggregator-archive cache rows (WET, TR, SD, TS, LBO).
 *
 * Cache rows store outletIds computed at scrape time. Rows cached during the
 * domain-collision era carry stale URL-derived mappings (e.g. sunday-telegraph
 * for telegraph.co.uk URLs — card 39b637c5-416f-81bb), and every re-ingest
 * faithfully reproduces the stale ID.
 *
 * Re-resolving EVERY row's URL is not safe: WET star-rating rows carry the
 * roundup page itself as `url` (would mis-home Guardian/Times rows to
 * westendtheatre), and old caches have label/URL row misalignment (Observer
 * columns with theguardian.com URLs). So the URL only overrides the
 * cached/label-derived ID when:
 *   - the fallback ID is not a registered outlet (junk scrape-era slug), or
 *   - the fallback outlet itself claims the URL's domain — proof the cached ID
 *     was URL-derived under the old collision resolver and may be stale.
 * The aggregator's own outlet ID never wins via URL: that URL is the roundup
 * page, not the review.
 */
const {
  normalizeOutlet,
  resolveOutletFromUrl,
  getOutletFromRegistry,
} = require('./review-normalization');

function resolveArchiveRowOutletId({ url, outletLabel, cachedOutletId, sourceOutletId }) {
  // Normalize the cached ID too: a cached alias or since-merged ID
  // (the-upcoming-uk, the-express) canonicalizes even when the row has no URL.
  const fallback = normalizeOutlet(cachedOutletId || outletLabel || '');
  if (!url) return fallback;

  let resolved = null;
  try { resolved = resolveOutletFromUrl(url); } catch { /* malformed URL */ }
  if (!resolved || resolved.outletId === fallback) return fallback;
  if (sourceOutletId && resolved.outletId === sourceOutletId) return fallback;

  const fallbackEntry = getOutletFromRegistry(fallback);
  if (!fallbackEntry) return resolved.outletId;

  let host;
  try { host = new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return fallback; }
  const claimedDomains = [fallbackEntry.domain, ...(fallbackEntry.domainAliases || [])]
    .filter(Boolean)
    .map((d) => String(d).replace(/^www\./, '').toLowerCase());
  const fallbackClaimsHost = claimedDomains.some((d) => host === d || host.endsWith(`.${d}`));
  return fallbackClaimsHost ? resolved.outletId : fallback;
}

// --- WE-aggregator wiring guard (source lint) -------------------------------
//
// Bans the row-ingest shape `outletId: r.outletId || <anything>`. fc5596d0813
// removed three variants of it, all of which re-introduced stale/divergent
// outletIds because they trusted a scrape-era cached ID instead of recomputing
// identity:
// diacritic-guard-ok: the next line QUOTES the legacy shred this lint exists to ban — live code below calls normalizeOutlet(). See scripts/lib/diacritic-fold-guard.js.
//     outletId: r.outletId || r.outlet?.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'unknown',
//     outletId: r.outletId || 'unknown',
//     outletId: r.outletId || normalizeOutlet(r.outlet || ''),
//
// Deliberately BROAD, and deliberately NOT narrowed to accommodate legitimate
// exceptions. Narrowing on the right-hand side (e.g. "only flag a
// normalizeOutlet() fallback") would still catch the third shape while
// permitting the first two forever — the two most likely to recur, since
// normalizeOutlet is what a developer reaches for when they ARE thinking about
// outlet identity. A genuine non-ingest use DECLARES itself with a trailing
// `// audit-only: <reason>` on, or on the line DIRECTLY above, the match — the same
// convention as the repo's `# hygiene-*-ok:` workflow markers and the
// .alert-sender-baseline.json exemption ledgers. The reason is mandatory: a
// bare `// audit-only:` does not exempt anything.
//
// Lives here rather than as a regex literal inside the test's assert so the
// test can require() it and feed it fixtures (CLAUDE.md rule 15) — without
// that, nothing proves the guard still matches anything at all, which is
// exactly how a "false positive fix" silently turns into a dead gate.
const RAW_OUTLET_ID_INGEST_RE = /outletId\s*[:=]\s*(?:r|review|lboReview)\.outletId\s*\|\|/g;
const AUDIT_ONLY_RE = /\/\/\s*audit-only:\s*\S/;
const COMMENT_ONLY_RE = /^\s*\/\//;

/**
 * findRawOutletIdIngestLines(contents) -> [{ line, text }]
 *
 * One entry per un-exempted match. `line` is 1-based. Matching runs over the
 * whole file rather than line-by-line on purpose: `\s*` spans newlines, so the
 * wrapped form
 *     outletId:
 *       r.outletId || 'unknown',
 * is caught too, and a naive per-line rewrite would have silently dropped it.
 */
function findRawOutletIdIngestLines(contents) {
  const lines = String(contents).split('\n');
  const findings = [];
  RAW_OUTLET_ID_INGEST_RE.lastIndex = 0;
  let m;
  while ((m = RAW_OUTLET_ID_INGEST_RE.exec(contents)) !== null) {
    const startLine = contents.slice(0, m.index).split('\n').length - 1;
    const endLine = startLine + (m[0].split('\n').length - 1);
    // The annotation may sit on any line the match spans, or on the line above
    // it -- but only if that line is a COMMENT line. Without the comment-only
    // restriction, an unrelated trailing `// audit-only:` on the preceding line
    // of real code silently exempts the match below it, which is how a source
    // lint quietly goes dead.
    const spanned = lines.slice(startLine, endLine + 1);
    const above = startLine > 0 ? lines[startLine - 1] : '';
    const exempt = spanned.some((l) => AUDIT_ONLY_RE.test(l))
      || (COMMENT_ONLY_RE.test(above) && AUDIT_ONLY_RE.test(above));
    if (exempt) continue;
    findings.push({ line: startLine + 1, text: lines[startLine].trim() });
  }
  return findings;
}

module.exports = { resolveArchiveRowOutletId, findRawOutletIdIngestLines };
