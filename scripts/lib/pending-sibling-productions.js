'use strict';
// BRO-7945 Part B. The same article is queued in _pending under every same-title production
// (ew--6aa1dc39.json under a-streetcar-named-desire-1973/-1988/-1992/-2005/-regional-2026).
// Two pure pieces so the drain stops paying for, and re-judging, the same URL once per copy:
//   makeFetchCache  one fetch per URL per run (a thrown error is cached too: no second paid try)
//   siblingForArticle  which same-title sibling production owns an out-of-window article

const { isArticleOutsideProductionWindow } = require('./date-guard');
const { normalizeTitle } = require('./title-match');

function makeFetchCache(fetchImpl) {
  const memo = new Map();
  const wrapped = (url) => {
    if (!memo.has(url)) memo.set(url, Promise.resolve().then(() => fetchImpl(url)).then(
      (value) => ({ value }), (error) => ({ error })));
    return memo.get(url).then((r) => { if (r.error) throw r.error; return r.value; });
  };
  wrapped.stats = () => ({ unique: memo.size });
  return wrapped;
}

/** Other productions sharing this show's title (and market) whose window contains publishDate. */
function siblingForArticle(show, allShows, publishDate, { hasCopy = () => true, isOutside = isArticleOutsideProductionWindow } = {}) {
  if (!show || !publishDate) return null;
  const key = normalizeTitle(show.title || '');
  if (!key) return null;
  for (const s of allShows || []) {
    if (!s || s.id === show.id || normalizeTitle(s.title || '') !== key) continue;
    if ((s.market || null) !== (show.market || null)) continue;
    if (!isOutside(s, publishDate) && hasCopy(s.id)) return s;
  }
  return null;
}

module.exports = { makeFetchCache, siblingForArticle };
