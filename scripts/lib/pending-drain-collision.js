'use strict';
/**
 * BRO-7930: when a _pending stub's byline resolves to a primary file that already exists
 * ({outlet}--{critic}.json), the drain used to log "already exists — keep pending" and leave the
 * stub forever: 43 of the ~82 unresolved open-show stubs on 2026-11-20, which is why the open-show
 * drain reported "Promoted: 0". Decide what that stub actually is.
 *
 *  same-article      the primary already carries this article (www/query/trailing-slash/typo
 *                    variant of one URL): the stub is redundant.
 *  different-article same outlet + critic but another article (a news item, a second piece):
 *                    not a second copy of the primary, and it cannot take the primary's filename.
 */

function urlParts(u) {
  try {
    const x = new URL(String(u || '').trim());
    const segs = x.pathname.split('/').filter(Boolean);
    return { host: x.hostname.toLowerCase().replace(/^www\./, ''), last: (segs[segs.length - 1] || '').toLowerCase().replace(/\.[a-z0-9]{2,5}$/, '') };
  } catch { return null; }
}

function editDistance(a, b, cap = 3) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** True when two URLs name the same article (host-insensitive to www, path prefix, query; tolerant of a 1-2 char typo in a long slug). */
function urlsSameArticle(a, b) {
  const x = urlParts(a), y = urlParts(b);
  if (!x || !y || !x.last || !y.last) return false;
  if (x.host !== y.host && !x.host.endsWith('.' + y.host) && !y.host.endsWith('.' + x.host)) return false;
  if (x.last === y.last) return true;
  return x.last.length >= 20 && y.last.length >= 20 && editDistance(x.last, y.last, 2) <= 2;
}

/** @returns {'same-article'|'different-article'} */
function classifyTargetCollision(stub, existing) {
  return urlsSameArticle(stub && stub.url, existing && existing.url) ? 'same-article' : 'different-article';
}

/**
 * BRO-7930: the rule (if any) by which the rebuild would exclude a stub we are about to promote under a byline.
 * A stub with no text yet is promoted on purpose (the collector fetches the body), so the no-text/no-score rules do
 * not block. Any other rule (wrongProduction, blockedReviewUrl, namedNonReviewUrl, listingPageUrl, ...) means the
 * promoted file would be dead on arrival: leave it tagged in _pending instead of adding a file nothing can score.
 * `guards` / `noSignalRules` are injectable for tests.
 */
function promotionBlockRule(candidate, show, filePath, { guards, noSignalRules } = {}) {
  guards = guards || require('./review-guards');
  noSignalRules = noSignalRules || require('./coverage-holes').NO_SIGNAL_RULES;
  let rule = null;
  try { rule = guards.explainExclusion(candidate, show, filePath); } catch { rule = null; }
  return rule && !noSignalRules.includes(rule) ? rule : null;
}

module.exports = { promotionBlockRule, urlsSameArticle, classifyTargetCollision, editDistance };
