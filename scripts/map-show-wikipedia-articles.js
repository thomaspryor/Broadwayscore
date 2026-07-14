#!/usr/bin/env node
/**
 * map-show-wikipedia-articles.js — resolves Wikipedia article titles for
 * running shows and writes data/wikipedia-title-map.json (the show→article
 * lookup used by the Social Pulse Wikipedia-pageviews counter).
 *
 * Follows the dtli-slug-map.json pattern: a regenerable external-ID mapping
 * in its own data file with _meta + unmatched tracking — deliberately NOT a
 * field on shows.json (high-churn source of truth; a feature-specific
 * lookup key doesn't belong there and would outlive the feature).
 *
 * Resolution: probes title variants (derived from buildSearchTitles in
 * enrich-wikipedia-synopsis.js), follows redirects to the canonical title,
 * rejects disambiguation pages and film/TV-only articles. A show with no
 * confident match gets NO entry (the pageviews signal is simply absent for
 * it — scorer renormalizes).
 *
 * Usage:
 *   node scripts/map-show-wikipedia-articles.js            # running shows missing from map
 *   node scripts/map-show-wikipedia-articles.js --all      # re-resolve all running shows
 *   node scripts/map-show-wikipedia-articles.js --show=ID  # single show
 *   node scripts/map-show-wikipedia-articles.js --dry-run
 *
 * Run LOCALLY (one-time + occasional top-ups when new shows open). Not a
 * cron — the weekly pulse workflow only READS the map.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const SHOWS_PATH = path.join(REPO_ROOT, 'data', 'shows.json');
const MAP_PATH = path.join(REPO_ROOT, 'data', 'wikipedia-title-map.json');
const { listRunningShows } = require('./lib/list-running-shows');
const { USER_AGENT } = require('./lib/wikipedia-pageviews');

const API = 'https://en.wikipedia.org/w/api.php';

function parseArgs(argv) {
  const args = { all: false, dryRun: false, showId: null };
  for (const a of argv.slice(2)) {
    if (a === '--all') args.all = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--show=')) args.showId = a.slice('--show='.length);
    else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function cleanSearchTitle(title) {
  return title
    .replace(/\s*\(.*?\)\s*$/, '')
    .replace(/[’]/g, "'")
    .trim();
}

/**
 * Title variants to probe, most-specific first. Derived from
 * buildSearchTitles in enrich-wikipedia-synopsis.js — year-disambiguated
 * variants FIRST so revivals resolve to the right production's article
 * era before falling back to the franchise page.
 */
function buildTitleVariants(show) {
  const type = show.type || show.format;
  const yearMatch = show.id && show.id.match(/-(\d{4})(?:-|$)/);
  const year = yearMatch ? yearMatch[1] : null;

  // Base title spellings to try. Wikipedia titles are case-sensitive after
  // the first character, so ALL-CAPS marketing titles ("SIX") need a
  // title-cased variant ("Six"). Subtitles after a colon ("Harry Potter
  // And The Cursed Child: Both Parts") usually aren't in the article name.
  const bases = [cleanSearchTitle(show.title)];
  const first = bases[0];
  if (first.includes(':')) bases.push(first.split(':')[0].trim());
  for (const b of [...bases]) {
    if (b.length > 1 && b === b.toUpperCase()) {
      bases.push(b.charAt(0) + b.slice(1).toLowerCase());
    }
  }

  const variants = [];
  for (const title of [...new Set(bases)]) {
    if (type === 'musical') {
      if (year) variants.push(`${title} (${year} musical)`);
      variants.push(`${title} (musical)`, title);
    } else if (type === 'play') {
      if (year) variants.push(`${title} (${year} play)`);
      variants.push(`${title} (play)`, title);
    } else {
      variants.push(`${title} (musical)`, `${title} (play)`, title);
    }
    if (title.startsWith('The ') && title.length > 6) {
      const noThe = title.substring(4);
      variants.push(type === 'play' ? `${noThe} (play)` : `${noThe} (musical)`);
    }
  }
  return [...new Set(variants)];
}

const TITLE_STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'at', 'in', 'on', 'musical', 'play']);

/**
 * Guards against redirects landing on the WRONG article (e.g. "White
 * Rabbit Red Rabbit" redirecting to playwright "Nassim Soleimanpour",
 * whose bio has no infobox for the person-check to catch). The article
 * title must share at least one significant word with the show title;
 * shows whose article is named something entirely different stay
 * unmatched — an absent signal is safer than a wrong one.
 */
function titlesOverlap(showTitle, articleTitle) {
  const words = (s) => (s.toLowerCase().match(/[a-z0-9']+/g) || []).filter((w) => !TITLE_STOPWORDS.has(w));
  const showWords = words(showTitle);
  if (showWords.length === 0) return true; // stopword-only titles: can't judge
  const articleWords = new Set(words(articleTitle));
  return showWords.some((w) => articleWords.has(w));
}

/**
 * Search-API fallback for shows none of whose constructed variants exist
 * (e.g. Sorkin's "To Kill a Mockingbird (2018 play)" — year unknowable
 * from our ID). Validates candidates with the same classifier + overlap
 * guard as direct probes.
 */
async function searchFallback(show) {
  const type = show.type || show.format;
  const qualifier = type === 'play' ? 'play' : 'musical';
  const q = `${cleanSearchTitle(show.title)} ${qualifier}`;
  const url = `${API}?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=3&format=json`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) return [];
  const data = await res.json();
  return (data?.query?.search || []).map((r) => r.title);
}

/**
 * Fetches a page's canonical title + wikitext, following redirects
 * server-side (redirects=1). Returns { canonicalTitle, content } or null.
 */
async function resolvePage(title) {
  const url = `${API}?action=query&titles=${encodeURIComponent(title)}&prop=revisions&rvprop=content&rvslots=main&redirects=1&format=json`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) return null;
  const data = await res.json();
  const pages = data?.query?.pages || {};
  const pageId = Object.keys(pages)[0];
  if (!pageId || pageId === '-1') return null;
  const page = pages[pageId];
  const content = page.revisions?.[0]?.slots?.main?.['*'];
  if (!content) return null;
  return { canonicalTitle: page.title, content };
}

/**
 * Accept/reject the resolved article for pulse-counter use.
 * Pure decision function (exported for tests).
 *
 * Rejections learned from the first full run (2026-07-14):
 *  - "(disambiguation)" canonical titles — Aladdin resolved to
 *    "Aladdin (disambiguation)" whose template variant slipped past the
 *    {{disambiguation}} regex; the title itself is the reliable tell.
 *  - Person articles — "White Rabbit Red Rabbit" redirects to playwright
 *    "Nassim Soleimanpour"; a person page's views measure the author's
 *    fame, not the show's weekly interest.
 */
function classifyArticle(content, canonicalTitle = '') {
  if (/\(disambiguation\)/i.test(canonicalTitle)) {
    return { ok: false, reason: 'disambiguation title' };
  }
  if (/\{\{disambig/i.test(content) || /may refer to:/i.test(content.substring(0, 2000))) {
    return { ok: false, reason: 'disambiguation' };
  }
  const head = content.substring(0, 3000);
  const hasTheatreInfobox = /\{\{Infobox (musical|play)/i.test(content);
  const hasPersonInfobox = /\{\{Infobox person/i.test(content);
  const hasFilmInfobox = /\{\{Infobox (film|television)/i.test(content);
  const hasTheatreContext = /\b(broadway|west end|off-broadway|theatre|theater|musical|playwright|librett)/i.test(head);
  if (hasPersonInfobox && !hasTheatreInfobox) return { ok: false, reason: 'person article' };
  if (hasFilmInfobox && !hasTheatreInfobox) return { ok: false, reason: 'film/tv article' };
  if (!hasTheatreInfobox && !hasTheatreContext) return { ok: false, reason: 'no theatrical context' };
  return { ok: true, reason: hasTheatreInfobox ? 'theatre infobox' : 'theatre context' };
}

function loadMap() {
  if (!fs.existsSync(MAP_PATH)) return { _meta: {}, titles: {}, unmatched: [] };
  return JSON.parse(fs.readFileSync(MAP_PATH, 'utf-8'));
}

async function main() {
  const args = parseArgs(process.argv);
  const map = loadMap();
  map.titles = map.titles || {};

  let shows;
  if (args.showId) {
    const all = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf-8')).shows;
    const show = all.find((s) => s.id === args.showId);
    if (!show) throw new Error(`Show not found: ${args.showId}`);
    shows = [show];
  } else {
    shows = listRunningShows();
    if (!args.all) shows = shows.filter((s) => !(s.id in map.titles) && !map.unmatched?.includes(s.id));
  }

  console.log(`Resolving Wikipedia articles for ${shows.length} shows...`);
  const unmatched = new Set(map.unmatched || []);
  let resolved = 0;

  for (const show of shows) {
    let hit = null;
    const candidates = buildTitleVariants(show);
    // Two passes: constructed variants first, then search-API fallback.
    for (let pass = 0; pass < 2 && !hit; pass++) {
      const titles = pass === 0 ? candidates : await searchFallback(show).catch(() => []);
      for (const variant of titles) {
        let page;
        try {
          page = await resolvePage(variant);
        } catch {
          page = null;
        }
        await new Promise((r) => setTimeout(r, 250));
        if (!page) continue;
        if (!titlesOverlap(show.title, page.canonicalTitle)) continue;
        // Type-mismatch guard: a musical must not resolve to a "(… play)"
        // article and vice versa (aladdin-2014 briefly mapped to
        // "Aladdin (play)" — an 1805 Danish play — via search fallback).
        const showType = show.type || show.format;
        if (showType === 'musical' && /\(\d{4} play\)$|\(play\)$/i.test(page.canonicalTitle)) continue;
        if (showType === 'play' && /\(\d{4} musical\)$|\(musical\)$/i.test(page.canonicalTitle)) continue;
        const verdict = classifyArticle(page.content, page.canonicalTitle);
        if (verdict.ok) {
          hit = { variant, canonicalTitle: page.canonicalTitle, reason: verdict.reason };
          break;
        }
      }
    }

    if (hit) {
      map.titles[show.id] = hit.canonicalTitle;
      unmatched.delete(show.id);
      resolved++;
      console.log(`  ${show.id} → "${hit.canonicalTitle}" (${hit.reason})`);
    } else {
      unmatched.add(show.id);
      delete map.titles[show.id];
      console.log(`  ${show.id} → NOT FOUND`);
    }
  }

  map.unmatched = [...unmatched].sort();
  map._meta = {
    lastUpdated: new Date().toISOString(),
    source: 'en.wikipedia.org API via map-show-wikipedia-articles.js',
    matchedShows: Object.keys(map.titles).length,
    unmatchedShows: map.unmatched.length,
  };

  console.log(`\nResolved ${resolved} this run; map now has ${map._meta.matchedShows} titles, ${map._meta.unmatchedShows} unmatched.`);

  if (args.dryRun) {
    console.log('(dry run — not writing)');
    return;
  }
  fs.writeFileSync(MAP_PATH, JSON.stringify(map, null, 2));
  console.log(`Wrote ${MAP_PATH}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}

module.exports = { buildTitleVariants, classifyArticle, cleanSearchTitle };
