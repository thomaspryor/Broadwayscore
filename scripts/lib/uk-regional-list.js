'use strict';
/**
 * BRO-6516 step 1: turn outlet-census review URLs (The Stage / WhatsOnStage,
 * regional-uk + touring + held-other-market buckets) into a per-production
 * list with a UK hub assignment. Pure functions; data I/O lives in
 * scripts/build-uk-regional-list.js.
 */

// Order matters: first match wins. Patterns run against the URL slug text.
const HUBS = [
  ['edinburgh', /edinburgh|fringe|traverse-theatre|royal-lyceum|pleasance|summerhall|underbelly|gilded-balloon|assembly-(?:hall|rooms|george)/],
  ['scotland', /glasgow|dundee|aberdeen|inverness|perth-theatre|pitlochry|citizens-theatre|tramway|scotland|scottish|eden-court|dundee-rep|byre/],
  ['manchester', /manchester|royal-exchange|hope-mill|salford|lowry|bolton|octagon|oldham|rochdale|home-manchester|contact-theatre|palace-theatre-manchester/],
  ['yorkshire', /leeds|sheffield|crucible|(?<!new-)york(?!-hall)|bradford|hull|halifax|harrogate|huddersfield|scarborough|stephen-joseph|west-yorkshire-playhouse|playhouse-leeds|wakefield|doncaster/],
  ['bristol-bath', /bristol|bath-|-bath|tobacco-factory|old-vic-bristol|ustinov|egg-theatre|watershed/],
  ['stratford-rsc', /stratford(?!-east)|\brsc\b|royal-shakespeare|swan-theatre|other-place/],
  ['chichester', /chichester/],
];

// Not UK regional at all: London, NYC, West End (census leaks these in via held-other-market).
const NOT_REGIONAL = /london|new-york|\bnyc\b|broadway|west-end|bethnal|stratford-east|hampstead|donmar|young-vic|almeida|kiln-theatre/;

const TOURING = /on-tour|-tour(-|$)|uk-tour|tour-review/;

function slugOf(url) {
  const m = String(url).match(/\/(?:reviews|news)\/([^/?#]+)/);
  return m ? m[1].replace(/_\d+$/, '') : '';
}

function hubFor(slug) {
  for (const [hub, re] of HUBS) if (re.test(slug)) return hub;
  return 'uk-regional';
}

// Title = text before "-review" (The Stage) or "-at-"/"-review" (WhatsOnStage).
function titleSlug(slug) {
  let t = slug.split('-review')[0];
  const at = t.indexOf('-at-');
  if (at > 0) t = t.slice(0, at);
  return t.replace(/-on-tour$/, '').replace(/-+$/, '');
}

function classify(item) {
  const slug = slugOf(item.url);
  return {
    notRegional: NOT_REGIONAL.test(slug) || !/\/reviews\/|review/.test(String(item.url)),
    slug,
    title: titleSlug(slug),
    hub: hubFor(slug),
    touring: TOURING.test(slug) || item.itemMarket === 'touring',
  };
}

// Group review URLs into productions: same title slug + same hub + same year.
function buildList(items, { since = '2024-01-01' } = {}) {
  const prods = new Map();
  for (const it of items) {
    if (!it.publishDate || it.publishDate < since) continue;
    const c = classify(it);
    if (!c.title || c.notRegional || c.hub === 'edinburgh') continue; // Edinburgh Fringe out of scope
    const key = `${c.hub}|${c.title}|${it.publishDate.slice(0, 4)}`;
    let p = prods.get(key);
    if (!p) prods.set(key, (p = { key, hub: c.hub, titleSlug: c.title, year: it.publishDate.slice(0, 4), touring: c.touring, reviews: [], needsVenueSplit: c.hub === 'uk-regional' }));
    p.touring = p.touring && c.touring;
    p.reviews.push({ outlet: it.outlet, url: it.url, publishDate: it.publishDate });
  }
  return [...prods.values()].sort((a, b) => b.reviews.length - a.reviews.length);
}

module.exports = { slugOf, hubFor, titleSlug, classify, buildList, HUBS };
