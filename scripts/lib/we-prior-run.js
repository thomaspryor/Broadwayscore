'use strict';

/**
 * BRO-7163 F09: a WE reference URL is prior-run only when NO current-run source cites it. An old WET post
 * updated in place keeps its old date and re-cites the same live URL; that stale listing must not
 * outvote a current theatre.reviews roundup that cites it. (The Broadway article path already subtracts
 * current-run corroboration; this is the WE-path equivalent.)
 */
function weUrlIsPriorRun(url, priorRunUrls, currentRunSources) {
  if (!priorRunUrls || !priorRunUrls.has(url)) return false;
  const cur = currentRunSources && currentRunSources.get(url);
  return !(cur && cur.size > 0);
}

module.exports = { weUrlIsPriorRun };
