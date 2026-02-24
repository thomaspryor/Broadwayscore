#!/usr/bin/env node
/**
 * Enrich shows.json with runtime and age recommendation data from Wikipedia.
 *
 * Looks for:
 * - Runtime in Infobox fields: runtime, running_time, running time, length
 * - Age recommendation from article text
 *
 * Usage: node scripts/enrich-wikipedia-runtimes.js [--dry-run] [--category=off-broadway|west-end|broadway]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const DRY_RUN = process.argv.includes('--dry-run');
const CATEGORY_FILTER = process.argv.find(a => a.startsWith('--category='))?.split('=')[1] || null;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'BroadwayScorecardBot/1.0 (broadway-scorecard project)' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchJson(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error')); }
      });
    }).on('error', reject);
  });
}

async function getPageContent(title) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=revisions&rvprop=content&rvslots=main&format=json`;
  const data = await fetchJson(url);
  const pages = data.query.pages;
  const pageId = Object.keys(pages)[0];
  if (pageId === '-1') return null;
  const content = pages[pageId].revisions?.[0]?.slots?.main?.['*'] || null;

  // Handle redirects
  if (content) {
    const redirect = content.match(/#REDIRECT\s*\[\[([^\]]+)\]\]/i);
    if (redirect) {
      return getPageContent(redirect[1]);
    }
  }
  return content;
}

function buildSearchTitles(show) {
  let title = show.title;
  const suffixes = [' The Musical', ' the Musical', ': The Musical', ': the Musical',
    ' A Musical', ' A New Musical', ': A Musical', ' – The Musical'];
  for (const s of suffixes) {
    if (title.endsWith(s)) {
      title = title.substring(0, title.length - s.length);
      break;
    }
  }

  const format = show.format;
  const variants = [];
  if (format === 'musical') {
    variants.push(`${title} (musical)`, title, `${title} (Musical)`);
  } else if (format === 'play') {
    variants.push(`${title} (play)`, title, `${title} (Play)`);
  } else {
    variants.push(title, `${title} (musical)`, `${title} (play)`);
  }
  return variants;
}

/**
 * Parse runtime text from Wikipedia infobox.
 *
 * Examples:
 *   "2 hours, 30 minutes" → "2h 30m"
 *   "{{Duration|h=2|m=30}}" → "2h 30m"
 *   "Approximately 2 hours and 15 minutes" → "2h 15m"
 *   "150 minutes" → "2h 30m"
 *   "1 hour 45 minutes" → "1h 45m"
 *   "2:30" → "2h 30m"
 */
function parseRuntime(text) {
  if (!text) return null;
  let t = text.trim();

  // Remove wiki markup
  t = t.replace(/\{\{[Dd]uration\|h=(\d+)\|m=(\d+)\}\}/g, '$1 hours $2 minutes');
  t = t.replace(/\{\{[Dd]uration\|m=(\d+)\}\}/g, '$1 minutes');
  t = t.replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2');
  t = t.replace(/<ref[^>]*>.*?<\/ref>/gis, '');
  t = t.replace(/<ref[^>]*\/>/gi, '');
  t = t.replace(/\{\{[^}]*\}\}/g, '');
  t = t.replace(/<!--.*?-->/gs, '');
  t = t.replace(/['']+/g, '');
  t = t.trim().toLowerCase();

  if (!t || t === 'n/a' || t === 'tbd' || t === 'tba' || t === 'varies') return null;

  // "Xh Ym" already formatted
  const already = t.match(/^(\d+)h\s*(\d+)m$/);
  if (already) return `${parseInt(already[1])}h ${parseInt(already[2])}m`;

  // "X hours and Y minutes" or "X hours, Y minutes"
  const hm = t.match(/(\d+)\s*hours?\s*(?:,?\s*(?:and\s*)?)?(\d+)\s*(?:minutes?|mins?)/);
  if (hm) return `${parseInt(hm[1])}h ${parseInt(hm[2])}m`;

  // "X hours" only
  const hOnly = t.match(/^(?:approximately\s+)?(\d+)\s*hours?$/);
  if (hOnly) return `${parseInt(hOnly[1])}h`;

  // "X minutes" only
  const mOnly = t.match(/^(?:approximately\s+)?(\d+)\s*(?:minutes?|mins?)$/);
  if (mOnly) {
    const mins = parseInt(mOnly[1]);
    if (mins < 30 || mins > 360) return null; // Unrealistic
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }

  // "X:YY" format
  const colon = t.match(/^(\d+):(\d{2})$/);
  if (colon) {
    const h = parseInt(colon[1]);
    const m = parseInt(colon[2]);
    if (h >= 1 && h <= 5 && m < 60) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }

  return null;
}

/**
 * Extract intermission count from Wikipedia text near the runtime.
 */
function parseIntermissions(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/no\s+intermission|without\s+intermission|no\s+interval/i.test(t)) return 0;
  if (/one\s+intermission|1\s+intermission|one\s+interval|1\s+interval/i.test(t)) return 1;
  if (/two\s+intermissions?|2\s+intermissions?|two\s+intervals?|2\s+intervals?/i.test(t)) return 2;
  return null;
}

async function main() {
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const shows = showsData.shows;

  let targets = shows.filter(s => !s.runtime);

  if (CATEGORY_FILTER) {
    targets = targets.filter(s => (s.category || 'broadway') === CATEGORY_FILTER);
    console.log(`Filtering to category: ${CATEGORY_FILTER}`);
  }

  console.log(`Total shows: ${shows.length}`);
  console.log(`Shows missing runtime: ${targets.length}`);
  console.log(`DRY_RUN: ${DRY_RUN}\n`);

  let enriched = 0, notFound = 0, noRuntime = 0, errors = 0;

  for (let i = 0; i < targets.length; i++) {
    const show = targets[i];
    const searchTitles = buildSearchTitles(show);

    process.stdout.write(`[${i + 1}/${targets.length}] ${show.id}... `);

    let content = null;
    for (const title of searchTitles) {
      try {
        content = await getPageContent(title);
        if (content) break;
      } catch (e) {
        errors++;
      }
      await new Promise(r => setTimeout(r, 200));
    }

    if (!content) {
      console.log('NOT FOUND');
      notFound++;
      await new Promise(r => setTimeout(r, 300));
      continue;
    }

    // Validate this is a theatrical production page
    const hasInfobox = /\{\{Infobox (musical|play|film|television)/i.test(content);
    const hasTheatreContext = /\b(broadway|west end|off-broadway|theatre|theater|musical|playwright|librett)/i.test(content.substring(0, 2000));
    if (!hasInfobox && !hasTheatreContext) {
      console.log('not a theatre page');
      notFound++;
      await new Promise(r => setTimeout(r, 300));
      continue;
    }

    // Extract runtime from infobox
    const runtimeMatch = content.match(/\|\s*(?:runtime|running[_ ]time|length)\s*=\s*(.+?)(?:\n\||\n\}\})/si);
    const parts = [];

    if (runtimeMatch) {
      const runtime = parseRuntime(runtimeMatch[1]);
      if (runtime) {
        if (!DRY_RUN) show.runtime = runtime;
        parts.push(`runtime=${runtime}`);
        enriched++;
      }

      // Check for intermission info near runtime
      const intermissions = parseIntermissions(runtimeMatch[1]);
      if (intermissions !== null && show.intermissions === undefined) {
        if (!DRY_RUN) show.intermissions = intermissions;
        parts.push(`intermissions=${intermissions}`);
      }
    }

    if (parts.length === 0) {
      console.log('no runtime in infobox');
      noRuntime++;
    } else {
      console.log(parts.join(', '));
    }

    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\n=== Summary ===`);
  console.log(`Runtime enriched: ${enriched}`);
  console.log(`Not found on Wikipedia: ${notFound}`);
  console.log(`Found but no runtime: ${noRuntime}`);
  console.log(`Errors: ${errors}`);

  if (!DRY_RUN && enriched > 0) {
    fs.writeFileSync(SHOWS_PATH, JSON.stringify(showsData, null, 2) + '\n');
    console.log(`\nshows.json updated.`);
  } else if (DRY_RUN) {
    console.log(`\n(dry run — no files written)`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
