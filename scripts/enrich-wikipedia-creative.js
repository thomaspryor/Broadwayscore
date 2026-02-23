#!/usr/bin/env node
/**
 * Enrich shows.json with creative team data from Wikipedia infoboxes.
 *
 * Fields populated:
 * - creativeTeam: from Wikipedia infobox (music, lyrics, book, playwright)
 *
 * Targets shows with empty/missing creativeTeam. Searches Wikipedia by show title.
 * Safe to run repeatedly — only adds to empty creativeTeam arrays.
 *
 * Usage: node scripts/enrich-wikipedia-creative.js [--dry-run] [--category=off-broadway|west-end|broadway]
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
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error`)); }
      });
    }).on('error', reject);
  });
}

function cleanWikitext(text) {
  return text
    .replace(/<!--.*?-->/gs, '')
    .replace(/<\/?(?:br|ref|small|nowiki)[^>]*>/gi, ' ')
    .replace(/\{\{(?:hidden|collapse|based on|Infobox)[^}]*\}\}/gis, '')
    .replace(/\{\{[Uu]bl\|([^}]*)\}\}/g, '$1')
    .replace(/\{\{[Pp]lainlist\|([^}]*)\}\}/g, '$1')
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
    .replace(/'{2,3}/g, '')
    .replace(/\*/g, ' ')
    .replace(/\}\}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildSearchTitle(show) {
  let title = show.title;

  // Strip common suffixes that duplicate Wikipedia disambiguation
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

function parseInfobox(content) {
  const musicalBox = content.match(/\{\{Infobox musical(.*?)\n\}\}/s);
  const playBox = content.match(/\{\{Infobox play(.*?)\n\}\}/s);
  const infobox = musicalBox || playBox;
  if (!infobox) return null;

  const type = musicalBox ? 'musical' : 'play';
  const text = infobox[0];

  const fields = {};
  const fieldNames = ['music', 'lyrics', 'book', 'playwright', 'author', 'writer'];
  for (const f of fieldNames) {
    const m = text.match(new RegExp(`\\|\\s*${f}\\s*=\\s*(.+?)(?:\\n\\||\\n\\}\\})`, 's'));
    if (m) {
      const val = cleanWikitext(m[1]);
      if (val && val.length > 0) fields[f] = val;
    }
  }
  return { fields, type };
}

async function getPageContent(title) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=revisions&rvprop=content&rvslots=main&format=json`;
  const data = await fetchJson(url);
  const pages = data.query.pages;
  const pageId = Object.keys(pages)[0];
  if (pageId === '-1') return null;
  return pages[pageId].revisions?.[0]?.slots?.main?.['*'] || null;
}

async function getWikipediaInfobox(searchTitles) {
  // Phase 1: Try exact title matches
  for (const title of searchTitles) {
    try {
      const content = await getPageContent(title);
      if (!content) continue;

      // Handle redirects
      const redirect = content.match(/#REDIRECT\s*\[\[([^\]]+)\]\]/i);
      if (redirect) {
        const rContent = await getPageContent(redirect[1]);
        if (rContent) {
          const result = parseInfobox(rContent);
          if (result) return { ...result, title: redirect[1] };
        }
        continue;
      }

      const result = parseInfobox(content);
      if (result) return { ...result, title };
    } catch (e) {
      continue;
    }
  }

  // Phase 2: Wikipedia search API fallback
  try {
    const baseTitle = searchTitles[0].replace(/ \(musical\)| \(play\)/g, '');
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(baseTitle + ' musical OR play theatre')}&srlimit=3&format=json`;
    const searchData = await fetchJson(searchUrl);
    for (const sr of (searchData.query?.search || [])) {
      const content = await getPageContent(sr.title);
      if (!content) continue;
      const result = parseInfobox(content);
      if (result) return { ...result, title: sr.title };
    }
  } catch (e) { /* ignore search failures */ }

  return null;
}

function buildCreativeTeam(fields, type) {
  const team = [];

  if (type === 'play') {
    if (fields.playwright) {
      team.push({ name: fields.playwright, role: 'Playwright' });
    } else if (fields.author) {
      team.push({ name: fields.author, role: 'Playwright' });
    } else if (fields.writer) {
      team.push({ name: fields.writer, role: 'Playwright' });
    }
  } else {
    if (fields.book) {
      team.push({ name: fields.book, role: 'Book' });
    }
    if (fields.music && fields.lyrics && fields.music === fields.lyrics) {
      team.push({ name: fields.music, role: 'Music & Lyrics' });
    } else {
      if (fields.music) {
        team.push({ name: fields.music, role: 'Music' });
      }
      if (fields.lyrics) {
        team.push({ name: fields.lyrics, role: 'Lyrics' });
      }
    }
  }

  return team;
}

async function main() {
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const shows = showsData.shows;

  let targets = shows.filter(s => !s.creativeTeam || s.creativeTeam.length === 0);

  if (CATEGORY_FILTER) {
    targets = targets.filter(s => (s.category || 'broadway') === CATEGORY_FILTER);
    console.log(`Filtering to category: ${CATEGORY_FILTER}`);
  }

  console.log(`Total shows: ${shows.length}`);
  console.log(`Shows missing creativeTeam: ${targets.length}`);
  console.log(`DRY_RUN: ${DRY_RUN}\n`);

  let enriched = 0, notFound = 0, noData = 0;

  for (let i = 0; i < targets.length; i++) {
    const show = targets[i];
    const searchTitles = buildSearchTitle(show);

    process.stdout.write(`[${i + 1}/${targets.length}] ${show.id}... `);

    const result = await getWikipediaInfobox(searchTitles);
    if (!result) {
      console.log('NOT FOUND');
      notFound++;
      await new Promise(r => setTimeout(r, 500));
      continue;
    }

    const team = buildCreativeTeam(result.fields, result.type);
    if (team.length === 0) {
      console.log(`infobox found but no creative data`);
      noData++;
      await new Promise(r => setTimeout(r, 500));
      continue;
    }

    if (!DRY_RUN) {
      show.creativeTeam = team;
    }
    console.log(`${team.map(t => `${t.role}: ${t.name}`).join(', ')}`);
    enriched++;

    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\n=== Summary ===`);
  console.log(`Enriched: ${enriched}`);
  console.log(`Not found on Wikipedia: ${notFound}`);
  console.log(`Found but no creative data: ${noData}`);

  if (!DRY_RUN && enriched > 0) {
    fs.writeFileSync(SHOWS_PATH, JSON.stringify(showsData, null, 2) + '\n');
    console.log(`\nshows.json updated.`);
  } else if (DRY_RUN) {
    console.log(`\n(dry run — no files written)`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
