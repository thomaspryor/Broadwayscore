'use strict';
/**
 * BRO-6710: pick review URLs for under-bar UK hub shows out of per-show SERP results.
 *
 * A result is kept when (pure, no I/O, CLAUDE.md §15):
 *   1. its domain is a registered outlet (resolve), and it is not an aggregation/feature page (reject);
 *   2. the result title or URL slug leads with the show's title (leading "the"/"review" dropped), so
 *      "Animal Farm" at Leeds never takes a "Farm" headline and a longer title is not truncated;
 *   3. the title, URL or snippet names the house, its town or a house word, so another city's run is out;
 *   4. a year in the URL path (YYYY or YYYY/MM) is the opening year or the one after it.
 * One review per outlet per show; outlets the show already holds are skipped. ingest does the page check.
 */
const { norm } = require('./venue-metro');

const GENERIC = new Set(['the', 'theatre', 'theater', 'playhouse', 'studio', 'studios', 'festival', 'royal', 'new', 'house', 'arts', 'centre', 'center', 'rep']);

const key = (s) => norm(String(s || '').replace(/\([^)]*\)/g, ' ')).replace(/^the /, '');

function housePhrases(show) {
  const [house, town] = String(show.venue || '').split(',').map((p) => norm(p));
  const words = (house || '').split(' ').filter((w) => w.length >= 4 && !GENERIC.has(w) && w !== town);
  // The town alone is weak (a tour page names the next city), so only the house and its distinctive words count.
  return [house, ...words].filter((p) => p && p.length >= 4);
}

function urlYears(url) {
  let p = '';
  try { p = new URL(url).pathname; } catch { return []; }
  return [...p.matchAll(/(?:^|\/)(20\d\d)(?=\/|-|$)/g)].map((m) => Number(m[1]));
}

// Words that can follow a title in a headline ("Lear review", "Lear at the Crucible"); same idea as uk-regional-census-match.
const TITLE_END = new Set(['review', 'at', 'with', 'by', 'musical', 'theatre', 'starring', 'from', 'tour', 'live']); // not 'in'/'the': "Once" must not take "Once in a Lifetime"

function leads(text, t, show) {
  const lead = ` ${norm(text).replace(/^(?:theatre |show )?review (?:of )?/, '').replace(/^the /, '')} `;
  if (!lead.startsWith(` ${t} `)) return false;
  const next = lead.slice(t.length + 2).split(' ')[0];
  return !next || TITLE_END.has(next) || housePhrases(show).some((p) => ` ${lead.slice(t.length + 2)}`.trimStart().startsWith(`${p} `));
}

/** Does this SERP result review this show? */
function resultMatchesShow(show, r) {
  const t = key(show.title);
  if (t.length < 3) return false;
  const slug = (() => { try { return new URL(r.url).pathname.split('/').filter(Boolean).pop() || ''; } catch { return ''; } })();
  const slugText = slug.replace(/\.[a-z]+$/, '').replace(/-/g, ' ');
  const titleOk = leads(r.title, t, show) || leads(slugText, t, show);
  const hay = ` ${norm(`${r.title || ''} ${r.url} ${r.description || ''}`)} `;
  if (!/review/.test(norm(`${r.title || ''} ${slugText}`))) return false; // previews, news and interviews are not reviews
  if (!titleOk) return false;
  if (!housePhrases(show).some((p) => hay.includes(` ${p} `))) return false;
  const open = Number(String(show.openingDate || '').slice(0, 4));
  const years = urlYears(r.url);
  if (open && years.length && !years.some((y) => y === open - 1 || y === open || y === open + 1)) return false;
  return true;
}

/**
 * @param show     hub row
 * @param results  [{url,title,description}]
 * @param ctx      { resolve(url)->outletId|null, reject(url,title,showTitle)->bool, heldKeys:Set, urlKey(url) }
 */
function pickForShow(show, results, ctx) {
  const seen = new Set();
  const picks = [];
  for (const r of results || []) {
    if (!r || !r.url) continue;
    if (/\/(?:threads?|forums?|topic|tag|category)\//i.test(r.url)) continue; // forum threads and index pages are not reviews
    if (ctx.reject(r.url, r.title, show.title)) continue;
    const outlet = ctx.resolve(r.url);
    if (!outlet || ctx.heldKeys.has(ctx.urlKey(r.url)) || ctx.heldKeys.has(`outlet:${outlet}`) || seen.has(outlet)) continue;
    if (!resultMatchesShow(show, r)) continue;
    seen.add(outlet);
    picks.push({ url: r.url, outlet });
  }
  return picks;
}

module.exports = { resultMatchesShow, pickForShow, housePhrases };
