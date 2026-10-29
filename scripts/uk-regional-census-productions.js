#!/usr/bin/env node
'use strict';
/**
 * BRO-6541: UK hub productions the Guardian list missed, found in the BRO-6488 London
 * outlet census. A regional-uk census item that matches no hub show yet, whose headline
 * names a hub house (data/venue-metros.json alias) after the title, is grouped with the
 * other outlets' reviews of the same title at the same house within REVIEW_SPAN_DAYS.
 * Each group becomes an add-show row for scripts/lib/uk-regional-add-plan.js buildAction
 * (same guards as the Guardian backfill), and its reviews an ingest list.
 *
 *   node scripts/uk-regional-census-productions.js [--min-outlets=2] [--since=2024-01-01]
 *        [--out=<file.json>] [--plans=bro-N-x]   (add-show plans; --ingest-plans=bro-N-y for reviews)
 */
const fs = require('fs');
const path = require('path');
const { norm, TABLE, resolveMetroInfo } = require('./lib/venue-metro');
const { matchCensusItems } = require('./lib/uk-regional-census-match');
const { buildAction } = require('./lib/uk-regional-add-plan');
const { urlKey } = require('./lib/outlet-feed-reconcile');
const { buildPlans } = require('./new-fix-plan');
const { hasHelpFlag } = require('./lib/cli-help');

const ROOT = path.join(__dirname, '..');
const CENSUS_DIR = path.join(ROOT, 'data', 'audit', 'outlet-census', 'london');
const REVIEW_SPAN_DAYS = 120;
// Not a single production: tours, roundups, festivals, opera/dance seasons, best-of lists.
const NOT_A_PRODUCTION = /\b(tour|touring|roundup|round up|best of|festival review|fringe|edinburgh|panto(?:mime)? season|interview|preview|first look|photos|cast (?:announced|revealed)|university|student|amateur)\b/i;
// Receiving houses: a title reviewed there is almost always a tour stop, and the census
// cannot tell the house's own work from a visiting show, so it founds no production there.
const RECEIVING_HOUSES = new Set(['The Lowry', 'Lyceum Theatre, Sheffield']);
const SAFE_URL = /^[A-Za-z0-9:/._~%=+,-]+$/;

const ALIASES = TABLE.venues
  .filter((v) => TABLE.metros[v.metro] && TABLE.metros[v.metro].country === 'UK')
  .flatMap((v) => [v.venue.split(',')[0], ...(v.aliases || [])].map((a) => ({ key: norm(a), v })))
  .filter((a) => a.key.length >= 4)
  .sort((a, b) => b.key.length - a.key.length);

function titleCase(s) {
  const small = new Set(['a', 'an', 'and', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'or', 'with']);
  return s.split(' ').map((w, i) => (i > 0 && small.has(w) ? w : /^(?:ii|iii|iv|vi|vii|viii)$/.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ').replace(/ S\b/g, "'s");
}

function lastSegment(url) {
  try { return new URL(url).pathname.split('/').filter(Boolean).pop() || ''; } catch { return ''; }
}

/** { title, alias } from a headline that reads "<title> [review|at|,|–] ... <house> ...". */
const HOUSE_WORDS = /\b(?:theatre|playhouse|studio|opera|company|festival|crucible|lyceum|moiseiwitsch|minerva|swan|ustinov|rsc)\b/i;

function parseHeadline(item) {
  const raw = String(item.headline || '').replace(/\s+/g, ' ').trim();
  const lead = ` ${norm(raw).replace(/^(?:theatre )?review /, '')} `;
  // The earliest house named ends the title ("doubt ustinov studio theatre royal bath" -> Doubt).
  const hits = ALIASES.filter((a) => lead.includes(` ${a.key} `));
  if (!hits.length) return null;
  const at = (a) => lead.indexOf(` ${a.key} `);
  const hit = hits.sort((a, b) => at(a) - at(b) || b.key.length - a.key.length)[0];
  const before = lead.slice(0, lead.indexOf(` ${hit.key} `)).trim();
  // Not "in": it ends "The Spy Who Came in from the Cold" and "Figures in Extinction" too early.
  const t = before.replace(/\s+(?:review|at|starring|with)(?:\s.*)?$/, '').replace(/\s+(?:review|rsc|opera north)$/, '').trim();
  const words = t.split(' ').filter(Boolean);
  if (!words.length || words.length > 9 || /^(?:review|at|the)$/.test(t)) return null;
  // Keep the outlet's own casing when the headline has it; slug-derived headlines are lowercase.
  const cased = raw.match(new RegExp(`^(?:review:?\\s*)?(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^A-Za-z0-9]+')})`, 'i'));
  const full = cased && /[A-Z]/.test(cased[1]) ? cased[1] : titleCase(t);
  const slug = norm(lastSegment(item.url)).replace(/ /g, '-').replace(/^review-/, '');
  // After a comma comes the house or company ("Dear Young Monster, Tanya Moiseiwitsch"), unless
  // the URL slug carries the whole title ("hello-dolly-review"): then the comma is the title's own.
  const [head, ...rest] = full.split(/,\s/);
  const houseAfter = HOUSE_WORDS.test(rest.join(' '));
  const title = rest.length && !houseAfter && slug.startsWith(`${norm(full).replace(/ /g, '-')}-`) ? full : head;
  // A headline cut mid-word ("...fleg and fruitc") shows as the slug running on past the title.
  if (slug.startsWith(norm(title).replace(/ /g, '-')) && /^[a-z0-9]/.test(slug.slice(norm(title).length))) return null;
  return { title, key: norm(title), alias: hit };
}

function loadItems(since) {
  const items = [];
  for (const f of fs.readdirSync(CENSUS_DIR).filter((x) => x.endsWith('.manifest.json'))) {
    const m = JSON.parse(fs.readFileSync(path.join(CENSUS_DIR, f), 'utf8'));
    for (const i of m.items || []) {
      if (i.itemMarket === 'regional-uk' && String(i.publishDate || '') >= since) items.push({ ...i, outletId: m.outletId });
    }
  }
  return items;
}

// venue-write-guard-ok: venues here are venue-metros.json names, only grouped; buildAction (lib/uk-regional-add-plan.js) writes them through sanitizeVenueForWrite.
/** Group unmatched items into productions: same title key + house, reviews within REVIEW_SPAN_DAYS. */
function groupProductions(items) {
  const groups = [];
  const pendingBtg = [];
  const byKey = new Map();
  for (const it of items.sort((a, b) => String(a.publishDate).localeCompare(String(b.publishDate)))) {
    if (NOT_A_PRODUCTION.test(`${it.headline} ${it.url}`)) continue;
    const p = parseHeadline(it);
    if (!p) continue;
    // British Theatre Guide slugs cut the title at 15 characters, so its items only join
    // a production another outlet named in full.
    // A title shorter than the cut ("fade-the-lowry-salf") is whole and may found one.
    // Its titles and dates are too unreliable to found one even when the title fits the cut.
    const btg = String(it.url).includes('britishtheatreguide.info');
    const info = resolveMetroInfo(p.alias.v.venue);
    if (!info || info.country !== 'UK' || !info.hub) continue;
    if (!btg && RECEIVING_HOUSES.has(p.alias.v.venue)) continue;
    const k = `${p.key}|${p.alias.v.venue}`;
    const list = byKey.get(k) || [];
    const near = (x) => Math.abs(Date.parse(it.publishDate) - Date.parse(x.first)) / 86400000 <= REVIEW_SPAN_DAYS;
    let g = btg
      ? groups.find((x) => x.venue === p.alias.v.venue && near(x) && btgJoins(x.key, p.key))
      : list.find(near);
    if (!g && btg) { pendingBtg.push({ it, p }); continue; }
    if (!g) {
      g = { key: p.key, title: p.title, venue: p.alias.v.venue, city: info.slug, hub: info.hub, first: String(it.publishDate).slice(0, 10), items: [] };
      list.push(g); groups.push(g); byKey.set(k, list);
    }
    if (!g.items.some((x) => x.outletId === it.outletId)) g.items.push(it);
  }
  // A BTG review published before the full-title review it belongs to.
  for (const { it, p } of pendingBtg) {
    const g = groups.find((x) => x.venue === p.alias.v.venue && Math.abs(Date.parse(it.publishDate) - Date.parse(x.first)) / 86400000 <= REVIEW_SPAN_DAYS
      && btgJoins(x.key, p.key));
    if (g && !g.items.some((x) => x.outletId === it.outletId)) g.items.push(it);
  }
  return mergeNearTitles(groups);
}

/**
 * A BTG slug title ("the birthd") joins a full title it starts. Its cut last word is dropped
 * only when what is left still names something ("the" alone would take "The Caretaker").
 */
function btgJoins(fullKey, cutKey) {
  if (fullKey.length < cutKey.length) return false;
  if (fullKey.startsWith(cutKey)) return true;
  const base = cutKey.replace(/ \S*$/, '');
  return base.replace(/^the /, '').length >= 4 && base !== cutKey && fullKey.startsWith(`${base} `);
}

// Words a review headline adds after the same production's title ("Grease the Musical").
const TITLE_SUFFIX = /^(?:the |a new )?(?:musical|play|opera|panto|pantomime)$/;

/** One production reviewed as "Grease" and "Grease the Musical" (or "Birthday Party" and "The Birthday Party"). */
function mergeNearTitles(groups) {
  const bare = (k) => k.replace(/^the /, '');
  const out = [];
  for (const g of [...groups].sort((a, b) => bare(a.key).length - bare(b.key).length)) {
    const into = out.find((x) => x.venue === g.venue && Math.abs(Date.parse(x.first) - Date.parse(g.first)) / 86400000 <= REVIEW_SPAN_DAYS
      && (bare(g.key) === bare(x.key) || (bare(g.key).startsWith(`${bare(x.key)} `) && TITLE_SUFFIX.test(bare(g.key).slice(bare(x.key).length + 1)))));
    if (!into) { out.push(g); continue; }
    if (/^the /.test(g.key) && !/^the /.test(into.key)) into.title = `The ${into.title}`;
    if (g.first < into.first) into.first = g.first;
    for (const it of g.items) if (!into.items.some((x) => x.outletId === it.outletId)) into.items.push(it);
  }
  return out;
}

function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) {
    console.log('Usage: node scripts/uk-regional-census-productions.js [--min-outlets=2] [--since=YYYY-MM-DD] [--out=<file>] [--plans=<prefix>] [--ingest-plans=<prefix>]');
    return null;
  }
  const arg = (k) => (argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=') || null;
  const since = arg('since') || '2024-01-01';
  const minOutlets = Number(arg('min-outlets') || 2);
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
  const shows = Array.isArray(data) ? data : data.shows;
  const hub = shows.filter((s) => /-uk$/.test(s.city || ''));
  const { unmatched } = matchCensusItems(loadItems(since), hub, new Map(), urlKey);
  const groups = groupProductions(unmatched).filter((g) => g.items.length >= minOutlets);

  const adds = [];
  const ingests = [];
  const skips = {};
  const working = shows.map((s) => ({ ...s }));
  // A title running as a tour or in the West End within a year is a tour stop, not a hub production.
  const elsewhere = shows.filter((s) => s.tourParent || ['tour', 'west-end'].includes(s.category) || /-tour-|tour$/.test(s.id));
  const isTourStop = (g) => elsewhere.some((s) => norm(s.title).replace(/^the /, '') === g.key.replace(/^the /, '')
    && Math.abs(Date.parse(s.openingDate || s.previewsStartDate || 0) - Date.parse(g.first)) / 86400000 <= 400);
  for (const g of groups) {
    if (isTourStop(g)) { skips['tour or West End run'] = (skips['tour or West End run'] || 0) + 1; continue; }
    const src = g.items.find((i) => SAFE_URL.test(i.url));
    if (!src) continue;
    const r = buildAction({ title: g.title, venue: g.venue, city: g.city, hub: g.hub, date: g.first, guardianUrl: src.url, source: `${src.outletId}-review`, discoverySource: 'uk-regional-census-backfill' }, working);
    if (r.skip) { const why = r.skip.replace(/ as .*/, ''); skips[why] = (skips[why] || 0) + 1; continue; }
    // buildAction speaks for the Guardian backfill; this row came from the census.
    const show = r.action.show;
    show.discoverySource = 'uk-regional-census-backfill';
    for (const k of ['statusSource', 'openingDateSource']) if (show[k]) show[k] = show[k].replace('guardian-review', 'census-review');
    for (const [k, v] of Object.entries(show)) if (typeof v === 'string' && /guardian/i.test(v)) console.warn(`  note: ${show.id}.${k} = ${v}`);
    working.push(show);
    adds.push({ ...r.action, description: `BRO-6541: add ${r.action.show.id} (${g.items.length} census reviews)` });
    for (const i of g.items.filter((x) => SAFE_URL.test(x.url))) {
      ingests.push({ type: 'run-script', script: 'ingest-review-from-url.js', args: `--show=${r.action.show.id} --url=${i.url} --outlet=${i.outletId}`, description: `BRO-6541: ingest ${i.outletId} review for ${r.action.show.id}` });
    }
  }
  const byCity = {};
  for (const a of adds) byCity[a.show.city] = (byCity[a.show.city] || 0) + 1;
  console.log(`unmatched census items ${unmatched.length}; productions with >=${minOutlets} outlets ${groups.length}; addable ${adds.length}; reviews ${ingests.length}`);
  console.log(`by city ${JSON.stringify(byCity)}`);
  console.log(`skipped ${JSON.stringify(skips)}`);
  const write = (prefix, summary, actions) => {
    for (const p of buildPlans(prefix, summary, actions)) {
      fs.writeFileSync(path.join(ROOT, 'data', 'pending-fixes', `${p.name}.json`), `${JSON.stringify(p.plan, null, 2)}\n`);
      console.log(`plan ${p.name}: ${p.plan.plan.actions.length} actions, planId ${p.plan.planId}`);
    }
  };
  if (arg('plans')) write(arg('plans'), 'BRO-6541: add UK hub productions found in the outlet census', adds);
  if (arg('ingest-plans')) write(arg('ingest-plans'), 'BRO-6541: ingest census reviews for the new UK hub productions', ingests);
  if (arg('out')) fs.writeFileSync(arg('out'), `${JSON.stringify({ adds: adds.map((a) => a.show), ingests, groups }, null, 2)}\n`);
  return { adds, ingests };
}

if (require.main === module) main();
module.exports = { main, parseHeadline, groupProductions };
