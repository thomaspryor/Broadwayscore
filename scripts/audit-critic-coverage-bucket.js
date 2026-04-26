#!/usr/bin/env node
/**
 * audit-critic-coverage-bucket.js — Categorize the gaps in
 * data/audit/critic-coverage-audit.json into:
 *   A. exact URL match under wrong critic (misattribution)
 *   B. show+outlet match under wrong critic (likely co-coverage; needs review)
 *   C. not Broadway (film/album/non-theater path)
 *   D. true missing Broadway (needs ingest)
 *   E. true missing West End
 *
 * Output: data/audit/critic-coverage-buckets.json + .md report.
 */
const fs = require('fs');
const path = require('path');
const REPO_ROOT = path.resolve(__dirname, '..');
const AUDIT_DIR = path.join(REPO_ROOT, 'data/audit');
const audit = JSON.parse(fs.readFileSync(path.join(AUDIT_DIR, 'critic-coverage-audit.json')));
const rev = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data/reviews.json')));
const shows = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data/shows.json')));
const showList = shows.shows || shows;

function normTitle(s) {
  return (s||'').toLowerCase()
    .replace(/['']/g, "'")
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\b(the|a|an|review|broadway|off-broadway|theater|theatre|musical|play)\b/g, '')
    .replace(/\s+/g, ' ').trim();
}

// Build: normTitle -> [shows], categorized
const titleMap = new Map();
for (const s of showList) {
  const cat = s.category || 'broadway';
  const k = normTitle(s.title);
  if (!k) continue;
  if (!titleMap.has(k)) titleMap.set(k, []);
  titleMap.get(k).push({ id: s.id, title: s.title, category: cat, openingDate: s.openingDate });
}

function urlKey(u) {
  try { const x = new URL(u); return x.hostname.replace(/^www\./,'') + x.pathname.replace(/\/$/,'').split('?')[0]; } catch { return null; }
}

// Domain → market preference. UK outlets review WE/OWE; US outlets review BWY/OB.
const UK_DOMAINS = ['theguardian.com', 'guardian.co.uk', 'ft.com', 'thetimes.co.uk', 'thetimes.com', 'telegraph.co.uk', 'standard.co.uk', 'dailymail.co.uk', 'thestage.co.uk', 'whatsonstage.com', 'inews.co.uk', 'i-paper.com', 'independent.co.uk', 'the-independent.com', 'londontheatre.co.uk', 'timeout.com/london'];

function urlMarket(u) {
  try {
    const url = new URL(u);
    const h = url.hostname.replace(/^www\./,'');
    const fullPath = h + url.pathname;
    for (const d of UK_DOMAINS) {
      if (h === d || h.endsWith('.' + d) || fullPath.includes(d)) return 'uk';
    }
    return 'us';
  } catch { return 'us'; }
}

function urlOutletId(u) {
  try {
    const h = new URL(u).hostname.replace(/^www\./,'');
    const map = {
      'wsj.com': 'wsj', 'vulture.com': 'vulture', 'nymag.com': 'vulture',
      'nytimes.com': 'nytimes', 'newyorker.com': 'newyorker',
      'hollywoodreporter.com': 'hollywood-reporter', 'variety.com': 'variety',
      'thewrap.com': 'thewrap', 'deadline.com': 'deadline', 'latimes.com': 'latimes',
      'chicagotribune.com': 'chicagotribune', 'theatermania.com': 'theatermania',
      'nystagereview.com': 'nysr', 'nypost.com': 'nypost', 'amny.com': 'amny',
      'newyorktheater.me': 'nyt-theater', 'newyorktheatreguide.com': 'nytg',
      'nydailynews.com': 'nydailynews', 'timeout.com': 'timeout',
      'talkinbroadway.com': 'talkinbroadway', 'theatrely.com': 'theatrely',
      'villagevoice.com': 'village-voice', 'slantmagazine.com': 'slantmagazine',
      'observer.com': 'observer', 'washingtonpost.com': 'washpost',
      'usatoday.com': 'usatoday', 'thedailybeast.com': 'dailybeast', 'dailybeast.com': 'dailybeast',
      'apnews.com': 'ap', 'theguardian.com': 'guardian', 'guardian.com': 'guardian',
      'telegraph.co.uk': 'telegraph', 'thetimes.co.uk': 'times-uk', 'thetimes.com': 'times-uk',
      'ft.com': 'financialtimes', 'standard.co.uk': 'standard', 'dailymail.co.uk': 'daily-mail',
      'thestage.co.uk': 'thestage', 'whatsonstage.com': 'whatsonstage',
      'inews.co.uk': 'i-paper', 'independent.co.uk': 'independent', 'the-independent.com': 'independent',
      'londontheatre.co.uk': 'london-theatre', 'nbcnewyork.com': 'nbcny', 'newsday.com': 'newsday',
      'northjersey.com': 'northjerseycom', 'ny1.com': 'ny1', 'ew.com': 'ew',
    };
    for (const [d, id] of Object.entries(map)) {
      if (h === d || h.endsWith('.' + d)) return id;
    }
    return null;
  } catch { return null; }
}

function pickShow(matches, market, urlYearHint) {
  // Filter by market preference
  const wantBroadway = market === 'us';
  const wantWE = market === 'uk';
  const broadway = matches.filter(s => s.category === 'broadway' || !s.category);
  const offBwy = matches.filter(s => s.category === 'off-broadway');
  const we = matches.filter(s => s.category === 'west-end');
  const owe = matches.filter(s => s.category === 'off-west-end');
  let pool = [];
  if (wantBroadway) pool = [...broadway, ...offBwy];
  else if (wantWE) pool = [...we, ...owe];
  if (pool.length === 0) return null;
  // Prefer most recent opening
  pool.sort((a,b) => (b.openingDate||'').localeCompare(a.openingDate||''));
  // If URL hints at a year, pick the show with closest opening year
  if (urlYearHint) {
    pool.sort((a,b) => {
      const ay = parseInt((a.openingDate||'').slice(0,4) || '0', 10);
      const by = parseInt((b.openingDate||'').slice(0,4) || '0', 10);
      const ad = Math.abs(ay - urlYearHint);
      const bd = Math.abs(by - urlYearHint);
      return ad - bd;
    });
  }
  return pool[0];
}

function extractUrlYear(u) {
  const m = u.match(/\/(20\d{2})\//);
  return m ? parseInt(m[1], 10) : null;
}

function isClearlyNonTheaterUrl(u) {
  const url = (u||'').toLowerCase();
  if (url.includes('/movies/movie-reviews/')) return true;
  if (url.includes('/movie-reviews/')) return true;
  if (url.includes('/tv/tv-reviews/')) return true;
  if (url.includes('/tv-reviews/')) return true;
  if (url.includes('/album-reviews/')) return true;
  if (url.includes('/music/album-')) return true;
  if (url.includes('/film-reviews/')) return true;
  if (url.includes('/film/')) return true;            // Slant /film/
  if (url.includes('/movies/')) return true;          // generic /movies/
  if (url.includes('/books/review/')) return true;
  if (url.includes('/book-reviews/')) return true;
  if (url.includes('/restaurants/')) return true;
  return false;
}

// Year-proximity check: skip if matched show opened too long before the URL year
// (likely indicates a new production we don't track, NOT a stale review of an old show)
function showIsTemporallyPlausible(show, urlYear) {
  if (!urlYear) return false;  // require year to be confident
  const showYear = parseInt((show.openingDate||'').slice(0,4) || '0', 10);
  if (!showYear) return false;
  // Tighter: show must have opened at most 2 years before article. Eliminates cats-2016 → cats-jellicle-ball-2026 mismatches.
  return showYear >= urlYear - 2;
}

// URL-slug sanity check: does the URL path contain any token from the matched show slug?
function urlMatchesShowSlug(url, showId) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    const tokens = showId.toLowerCase().split('-').filter(t => t.length >= 4 && !/^\d{4}$/.test(t));
    if (tokens.length === 0) return true;  // can't verify
    return tokens.some(t => path.includes(t));
  } catch { return false; }
}

function matchTitleToShow(rawTitle, urlMarketHint, urlYearHint) {
  let t = rawTitle.replace(/[‘’"']/g, "'");
  let m = t.match(/^['"]?(.+?)['"]?\s+review/i);
  let candidate = m ? m[1] : t.split(/[—–:|,]/)[0];
  candidate = normTitle(candidate);
  if (!candidate) return null;
  let matches = titleMap.get(candidate);
  if (!matches) {
    for (const [k, v] of titleMap) {
      if (k.startsWith(candidate) && candidate.length >= 4) { matches = v; break; }
      if (candidate.startsWith(k) && k.length >= 4) { matches = v; break; }
    }
  }
  if (!matches) return null;
  return pickShow(matches, urlMarketHint, urlYearHint);
}

const byUrl = new Map();
const byShowOutlet = new Map();
for (const r of rev.reviews) {
  const k = urlKey(r.url);
  if (k) {
    if (!byUrl.has(k)) byUrl.set(k, []);
    byUrl.get(k).push({ criticName: r.criticName, showId: r.showId, outletId: r.outletId, publishDate: r.publishDate });
  }
  const k2 = (r.showId||'') + '|' + (r.outletId||'');
  if (!byShowOutlet.has(k2)) byShowOutlet.set(k2, []);
  byShowOutlet.get(k2).push({ criticName: r.criticName, url: r.url, publishDate: r.publishDate });
}

const out = { exactUrlMatch: [], showOutletMatch: [], notBroadway: [], trueMissingBwy: [], trueMissingWE: [] };

for (const c of audit) {
  const items = c.missing || [];
  for (const m of items) {
    if (isClearlyNonTheaterUrl(m.url)) {
      out.notBroadway.push({ critic: c.name, title: m.title, url: m.url, reason: 'non-theater-path' });
      continue;
    }
    const market = urlMarket(m.url);
    const yearHint = extractUrlYear(m.url);
    const key = urlKey(m.url);
    const exact = byUrl.get(key) || [];
    if (exact.length) {
      const wrongCritic = exact.find(e => e.criticName !== c.name);
      if (wrongCritic) {
        out.exactUrlMatch.push({
          critic: c.name, expectedOutlet: c.outlet,
          existsAs: wrongCritic.criticName, showId: wrongCritic.showId, outletId: wrongCritic.outletId,
          title: m.title, url: m.url
        });
      }
      continue;
    }
    const show = matchTitleToShow(m.title, market, yearHint);
    if (!show) {
      out.notBroadway.push({ critic: c.name, market, title: m.title, url: m.url });
      continue;
    }
    if (!showIsTemporallyPlausible(show, yearHint)) {
      out.notBroadway.push({ critic: c.name, market, title: m.title, url: m.url, reason: 'show-too-old', matchedShow: show.id });
      continue;
    }
    if (!urlMatchesShowSlug(m.url, show.id)) {
      out.notBroadway.push({ critic: c.name, market, title: m.title, url: m.url, reason: 'url-slug-mismatch', matchedShow: show.id });
      continue;
    }
    if (show.category !== 'broadway' && market === 'us') {
      // US-outlet URL matched OB only; classify as not Broadway
      out.notBroadway.push({ critic: c.name, market, title: m.title, url: m.url, matchedShow: show });
      continue;
    }
    if (show.category === 'west-end' || show.category === 'off-west-end') {
      // West End — separate bucket
      const outletId = urlOutletId(m.url);
      const k2 = show.id + '|' + outletId;
      const list = byShowOutlet.get(k2) || [];
      const wrong = list.find(e => e.criticName !== c.name);
      if (wrong) {
        out.showOutletMatch.push({ critic: c.name, expectedOutlet: c.outlet, showId: show.id, showTitle: show.title, existsAs: wrong.criticName, title: m.title, url: m.url, market: 'we' });
      } else {
        out.trueMissingWE.push({ critic: c.name, expectedOutlet: c.outlet, showId: show.id, showTitle: show.title, outletId, title: m.title, url: m.url });
      }
      continue;
    }
    // BWY: check show+outlet
    const outletId = urlOutletId(m.url);
    const k2 = show.id + '|' + outletId;
    const list = byShowOutlet.get(k2) || [];
    const wrong = list.find(e => e.criticName !== c.name);
    if (wrong) {
      out.showOutletMatch.push({ critic: c.name, expectedOutlet: c.outlet, showId: show.id, showTitle: show.title, existsAs: wrong.criticName, title: m.title, url: m.url, market: 'bwy' });
    } else {
      out.trueMissingBwy.push({ critic: c.name, expectedOutlet: c.outlet, showId: show.id, showTitle: show.title, outletId, title: m.title, url: m.url });
    }
  }
}

console.log('Bucket counts:');
console.log('  A. exact URL match (wrong critic):', out.exactUrlMatch.length);
console.log('  B. show+outlet match (wrong critic):', out.showOutletMatch.length);
console.log('  C. not Broadway (film/album/no match):', out.notBroadway.length);
console.log('  D. true missing — Broadway:', out.trueMissingBwy.length);
console.log('  E. true missing — West End:', out.trueMissingWE.length);

fs.writeFileSync(path.join(AUDIT_DIR, 'critic-coverage-buckets.json'), JSON.stringify(out, null, 2));

// Markdown report
const lines = [];
lines.push('# Critic coverage bucketing — ' + new Date().toISOString().slice(0, 10) + '\n');
lines.push(`Source: data/audit/critic-coverage-audit.json`);
lines.push('');
lines.push('## Bucket counts');
lines.push(`- A. Exact URL already in data, wrong critic: ${out.exactUrlMatch.length}`);
lines.push(`- B. Show+outlet already covered, wrong critic: ${out.showOutletMatch.length}`);
lines.push(`- C. Not Broadway (film/album/no match): ${out.notBroadway.length}`);
lines.push(`- D. **TRUE MISSING — Broadway** (need ingest): ${out.trueMissingBwy.length}`);
lines.push(`- E. True missing — West End (excluded from Broadway focus): ${out.trueMissingWE.length}`);
lines.push('');

lines.push('## Bucket A — exact URL misattributions');
for (const e of out.exactUrlMatch) lines.push(`- expected: **${e.critic}** | exists as: ${e.existsAs} | ${e.showId} | url: ${e.url}`);
lines.push('');

lines.push('## Bucket B — show+outlet misattributions');
for (const e of out.showOutletMatch) lines.push(`- expected: **${e.critic}** (${e.market}) | exists as: ${e.existsAs} | ${e.showTitle} (${e.showId}) | url: ${e.url}`);
lines.push('');

lines.push('## Bucket D — true missing Broadway by critic');
const byC = {};
for (const e of out.trueMissingBwy) { byC[e.critic] = byC[e.critic] || []; byC[e.critic].push(e); }
for (const [name, items] of Object.entries(byC).sort((a,b)=>b[1].length-a[1].length)) {
  lines.push(`\n### ${name} (${items[0].expectedOutlet}) — ${items.length}`);
  for (const e of items) lines.push(`- ${e.showTitle} (${e.showId}) → ${e.url}`);
}

const mdPath = path.join(AUDIT_DIR, 'critic-coverage-buckets.md');
fs.writeFileSync(mdPath, lines.join('\n'));
console.log('\nReport: ' + mdPath);
