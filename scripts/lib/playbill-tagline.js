'use strict';

/**
 * Parses the genre tag-line Playbill prints on every production page, e.g.
 *   Broadway | Play | Dark Comedy | Revival
 *   Broadway | Musical | Original
 * Markup (verified against live pages 2026-08-21, BRO-2023):
 *   <div class="bsp-bio-subtitle">
 *     <h5 class="bsp-bio-sub-text">Broadway</h5>
 *     <h5 class="bsp-bio-sub-text">Play</h5>
 *     <h5 class="bsp-bio-sub-text">Dark Comedy</h5>
 *     <h5 class="bsp-bio-sub-text">Revival</h5>
 *   </div>
 * The last tag is "Revival" or "Original" whenever Playbill has classified
 * the production — this is Playbill's own authoritative call, not a title
 * heuristic, so it resolves cases a corpus cross-reference can't: a prior
 * production that predates this project's data (Gloria's 2015 Off-Broadway
 * run), and it does NOT fire for a same-title transfer between markets
 * (Paddington West End -> Broadway both print "Original"; Inter Alia West
 * End -> Broadway also prints "Original").
 */

const SUBTITLE_BLOCK_RE = /<div class="bsp-bio-subtitle">([\s\S]{0,800}?)<\/div>/;
const TAG_RE = /<h5 class="bsp-bio-sub-text">\s*([^<]+?)\s*<\/h5>/g;

function parsePlaybillTagLine(html) {
  const block = html && html.match(SUBTITLE_BLOCK_RE);
  if (!block) return { tags: [], market: null, showType: null, revivalStatus: 'unknown' };

  const tags = [];
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(block[1]))) tags.push(m[1].trim());

  const market = tags[0] || null;
  const typeTag = tags.find(t => /^(play|musical)$/i.test(t));
  const showType = typeTag ? typeTag.toLowerCase() : null;

  let revivalStatus = 'unknown';
  if (tags.some(t => /^revival$/i.test(t))) revivalStatus = 'revival';
  else if (tags.some(t => /^original$/i.test(t))) revivalStatus = 'original';

  return { tags, market, showType, revivalStatus };
}

module.exports = { parsePlaybillTagLine };
