#!/usr/bin/env node
/**
 * Enrich shows.json with synopses from Wikipedia plot/synopsis sections.
 *
 * Targets shows with empty/missing synopsis. Searches Wikipedia by show title,
 * extracts the == Plot == or == Synopsis == section, and cleans it to a 1-2
 * sentence summary (max 500 chars).
 *
 * Usage: node scripts/enrich-wikipedia-synopsis.js [--dry-run] [--category=off-broadway|west-end|broadway]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { stripWikiMarkup, hasWikiMarkup, stripLeadingJunk } = require('./lib/wiki-utils');
const { cleanSearchTitle } = require('./lib/title-normalization');

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const DRY_RUN = process.argv.includes('--dry-run');
const CATEGORY_FILTER = process.argv.find(a => a.startsWith('--category='))?.split('=')[1] || null;
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '0', 10);

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'BroadwayScorecardBot/1.0 (broadway-scorecard project)' } }, (res) => {
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
  const title = cleanSearchTitle(show.title);

  const type = show.type || show.format;
  const variants = [];

  // Extract year from show ID for year-disambiguated articles (e.g., "Passion (1994 musical)")
  const yearMatch = show.id && show.id.match(/-(\d{4})(?:-|$)/);
  const year = yearMatch ? yearMatch[1] : null;

  if (type === 'musical') {
    variants.push(`${title} (musical)`, title);
    if (year) variants.push(`${title} (${year} musical)`);
  } else if (type === 'play') {
    variants.push(`${title} (play)`, title);
    if (year) variants.push(`${title} (${year} play)`);
  } else {
    variants.push(title, `${title} (musical)`, `${title} (play)`);
  }

  // For shows with "The" prefix, also try without it
  if (title.startsWith('The ') && title.length > 6) {
    const noThe = title.substring(4);
    if (type === 'musical') {
      variants.push(`${noThe} (musical)`);
    } else if (type === 'play') {
      variants.push(`${noThe} (play)`);
    }
  }

  return variants;
}

/**
 * Extract the Plot or Synopsis section from Wikipedia wikitext.
 * Returns cleaned plain text, or null if not found.
 */
function extractPlotSection(content) {
  // Try multiple section headers in priority order
  const sectionHeaders = [
    /==\s*Plot\s*==/i,
    /==\s*Synopsis\s*==/i,
    /==\s*Plot summary\s*==/i,
    /==\s*Story\s*==/i,
    // Musical numbers section removed — yields song lists, not plot summaries
  ];

  for (const headerRegex of sectionHeaders) {
    const headerMatch = content.match(headerRegex);
    if (!headerMatch) continue;

    const startIdx = headerMatch.index + headerMatch[0].length;
    // Find the next section header (== Something ==) to bound the extraction
    const rest = content.substring(startIdx);
    const nextSection = rest.match(/\n==\s*[^=]/);
    const sectionText = nextSection ? rest.substring(0, nextSection.index) : rest.substring(0, 3000);

    // Clean wikitext
    let cleaned = stripWikiMarkup(sectionText);

    if (cleaned.length < 20) continue;

    // Reject if markup remnants survive cleaning
    if (hasWikiMarkup(cleaned)) continue;

    // Skip "Musical numbers" sections that are just song lists
    if (/^Act [12I]/i.test(cleaned) || /^[""]/.test(cleaned)) continue;

    return cleaned;
  }

  // Fallback: try the lead section (before any == header ==)
  const leadEnd = content.match(/\n==/);
  if (leadEnd) {
    const lead = content.substring(0, leadEnd.index);
    // Only use lead if it has substantial content after the infobox
    const afterInfobox = lead.replace(/\{\{Infobox[\s\S]*?\n\}\}/gi, '').trim();
    let cleaned = stripWikiMarkup(afterInfobox);

    if (cleaned.length >= 50 && !hasWikiMarkup(cleaned)) return cleaned;
  }

  return null;
}

/**
 * Trim text to a clean synopsis: first 1-2 sentences, max 500 chars.
 */
function trimToSynopsis(text) {
  // First, try to get the first 1-2 meaningful sentences
  const sentences = text.match(/[^.!?]+[.!?]+/g);
  if (!sentences) return text.substring(0, 500);

  let synopsis = '';
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    // Skip very short fragments or meta sentences
    if (trimmed.length < 10) continue;
    if (/^(The musical|The play|The show|It) (was|is) (based on|adapted|written|composed|directed|produced|set)/i.test(trimmed) && synopsis.length === 0) {
      // Keep "based on" sentences at the start — they're useful context
      synopsis += trimmed + ' ';
    } else if (synopsis.length === 0 || (synopsis.length + trimmed.length) <= 450) {
      synopsis += trimmed + ' ';
    }
    if (synopsis.length >= 300) break;
  }

  synopsis = synopsis.trim();
  if (synopsis.length > 500) {
    synopsis = synopsis.substring(0, 497) + '...';
  }
  return synopsis;
}

async function main() {
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const shows = showsData.shows;

  let targets = shows.filter(s => !s.synopsis || s.synopsis.trim() === '');

  if (CATEGORY_FILTER) {
    targets = targets.filter(s => (s.category || 'broadway') === CATEGORY_FILTER);
    console.log(`Filtering to category: ${CATEGORY_FILTER}`);
  }

  if (LIMIT > 0) {
    targets = targets.slice(0, LIMIT);
    console.log(`Limiting to ${LIMIT} shows`);
  }

  console.log(`Total shows: ${shows.length}`);
  console.log(`Shows missing synopsis: ${targets.length}`);
  console.log(`DRY_RUN: ${DRY_RUN}\n`);

  let enriched = 0, notFound = 0, noPlot = 0;

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
        // Skip API errors
      }
      await new Promise(r => setTimeout(r, 200));
    }

    if (!content) {
      console.log('NOT FOUND');
      notFound++;
      await new Promise(r => setTimeout(r, 300));
      continue;
    }

    // Reject disambiguation pages
    if (/\{\{disambiguation\}\}/i.test(content) || /may refer to:/i.test(content.substring(0, 2000))) {
      console.log('disambiguation page');
      notFound++;
      await new Promise(r => setTimeout(r, 300));
      continue;
    }

    // Validate this is a theatrical production page (not a film-only page)
    const hasTheatreInfobox = /\{\{Infobox (musical|play)/i.test(content);
    const hasFilmInfobox = /\{\{Infobox (film|television)/i.test(content);
    const hasTheatreContext = /\b(broadway|west end|off-broadway|theatre|theater|musical|playwright|librett)/i.test(content.substring(0, 2000));
    if (hasFilmInfobox && !hasTheatreInfobox && !hasTheatreContext) {
      console.log('film page, not theatre');
      notFound++;
      await new Promise(r => setTimeout(r, 300));
      continue;
    }
    if (!hasTheatreInfobox && !hasFilmInfobox && !hasTheatreContext) {
      console.log('not a theatre page');
      notFound++;
      await new Promise(r => setTimeout(r, 300));
      continue;
    }

    const plotText = extractPlotSection(content);
    if (!plotText) {
      console.log('no plot section');
      noPlot++;
      await new Promise(r => setTimeout(r, 300));
      continue;
    }

    const synopsis = trimToSynopsis(stripLeadingJunk(plotText));
    if (synopsis.length < 20) {
      console.log('synopsis too short');
      noPlot++;
      await new Promise(r => setTimeout(r, 300));
      continue;
    }

    // Reject synopses that are clearly wrong content
    if (/may refer to:/i.test(synopsis) ||
        /^.{0,20}is a \d{4} American .* film/i.test(synopsis) ||
        /\| website = |\| past_members/.test(synopsis)) {
      console.log('bad content in synopsis');
      noPlot++;
      await new Promise(r => setTimeout(r, 300));
      continue;
    }

    if (!DRY_RUN) {
      show.synopsis = synopsis;
    }
    console.log(`${synopsis.substring(0, 80)}...`);
    enriched++;

    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\n=== Summary ===`);
  console.log(`Enriched: ${enriched}`);
  console.log(`Not found on Wikipedia: ${notFound}`);
  console.log(`Found but no plot section: ${noPlot}`);

  if (!DRY_RUN && enriched > 0) {
    fs.writeFileSync(SHOWS_PATH, JSON.stringify(showsData, null, 2) + '\n');
    console.log(`\nshows.json updated.`);
  } else if (DRY_RUN) {
    console.log(`\n(dry run — no files written)`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
