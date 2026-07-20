#!/usr/bin/env node
/**
 * Enrich shows.json with runtime data from TodayTix.
 *
 * Runtime source: the show PAGE's displayed run time (Contentful CMS field),
 * NOT the REST API's runningTime — the API can be stale (Birthright 2026-07:
 * API said 90 min, page said 3hr 30min). See scripts/lib/todaytix-runtime.js.
 * The API is still used for age recommendation and as a runtime fallback when
 * the page has no parseable run time.
 *
 * Usage: node scripts/enrich-todaytix-runtimes.js [--dry-run] [--category=off-broadway|west-end|broadway] [--limit=N]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { fetchPage, cleanup } = require('./lib/scraper');
const { extractRunTimeDisplay, parseRunTimeDisplay, todaytixPageUrl } = require('./lib/todaytix-runtime');
const { atomicWriteShowsJson } = require('./lib/atomic-shows-write');

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const DRY_RUN = process.argv.includes('--dry-run');
const CATEGORY_FILTER = process.argv.find(a => a.startsWith('--category='))?.split('=')[1] || null;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
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

/**
 * Convert minutes to display format: "2h 30m" or "1h 45m" or "90m"
 */
function formatRuntime(minutes) {
  if (minutes < 60) return minutes + 'm';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/**
 * Extract age recommendation from TodayTix description or special notes.
 */
function extractAgeRecommendation(show) {
  // Check dedicated ageDescription field first (most reliable)
  if (show.ageDescription) {
    const ageDesc = show.ageDescription;
    // Simple format: "12+", "10+", "21+ only"
    const simpleMatch = ageDesc.match(/^(\d+)\+/);
    if (simpleMatch) return `Ages ${simpleMatch[1]}+`;
    // "Recommended for ages 7 and up", etc.
    const recMatch = ageDesc.match(/(?:recommended|suitable)\s+(?:for\s+)?(?:ages?|children)\s+(\d+)/i);
    if (recMatch) return `Ages ${recMatch[1]}+`;
    // "at least six years old" style
    const wordMatch = ageDesc.match(/at\s+least\s+(\w+)\s+years?\s+old/i);
    if (wordMatch) {
      const numWords = { three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
      const n = numWords[wordMatch[1].toLowerCase()] || parseInt(wordMatch[1]);
      if (n) return `Ages ${n}+`;
    }
  }

  const texts = [show.specialNote, show.description, show.heroSubtitle].filter(Boolean).join(' ');

  // Common patterns: "Ages 10+", "Recommended for ages 12 and up", "Suitable for ages 5+"
  const patterns = [
    /(?:recommended|suitable)\s+(?:for\s+)?(?:ages?|children)\s+(\d+)\s*(?:and\s+(?:up|over)|plus|\+)/i,
    /ages?\s+(\d+)\s*(?:and\s+(?:up|over)|plus|\+)/i,
    /(\d+)\s*(?:and\s+(?:up|over)|plus|\+)\s+(?:age|year)/i,
    /minimum\s+age\s*:?\s*(\d+)/i,
    /not\s+(?:suitable|recommended)\s+(?:for\s+)?(?:children\s+)?under\s+(\d+)/i,
  ];

  for (const pattern of patterns) {
    const match = texts.match(pattern);
    if (match) {
      return `Ages ${match[1]}+`;
    }
  }
  return null;
}

async function main() {
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const shows = showsData.shows;

  // Find shows with todaytixId that need runtime OR age recommendation
  let targets = shows.filter(s => s.todaytixId && (!s.runtime || !s.ageRecommendation));

  if (CATEGORY_FILTER) {
    targets = targets.filter(s => (s.category || 'broadway') === CATEGORY_FILTER);
    console.log(`Filtering to category: ${CATEGORY_FILTER}`);
  }

  const limit = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '0', 10);
  if (limit > 0) targets = targets.slice(0, limit);

  console.log(`Total shows: ${shows.length}`);
  console.log(`Targets (has TodayTix ID, needs runtime or age rec): ${targets.length}`);
  console.log(`DRY_RUN: ${DRY_RUN}\n`);

  let runtimeEnriched = 0, ageEnriched = 0, errors = 0, noRuntime = 0;

  for (let i = 0; i < targets.length; i++) {
    const show = targets[i];
    process.stdout.write(`[${i + 1}/${targets.length}] ${show.id} (TT:${show.todaytixId})... `);

    try {
      const url = `https://api.todaytix.com/api/v2/shows/${show.todaytixId}`;
      const response = await fetchJson(url);
      const ttShow = response.data;

      if (!ttShow) {
        console.log('NO DATA');
        errors++;
        await new Promise(r => setTimeout(r, 300));
        continue;
      }

      const parts = [];

      // Runtime (only if show doesn't have one yet).
      // Prefer the show PAGE's displayed run time — the API's runningTime is
      // often stale. Fall back to the API only when the page yields nothing.
      if (!show.runtime) {
        let pageRuntime = null;
        const pageUrl = todaytixPageUrl(show);
        try {
          const pageResult = await fetchPage(pageUrl, { renderJs: false, fast: true });
          pageRuntime = parseRunTimeDisplay(extractRunTimeDisplay(pageResult && pageResult.content));
        } catch { /* fall through to API */ }

        if (pageRuntime) {
          if (!DRY_RUN) {
            show.runtime = pageRuntime.runtime;
            if (pageRuntime.intermissions != null) show.intermissions = pageRuntime.intermissions;
          }
          parts.push(`runtime=${pageRuntime.runtime} (page)`);
          runtimeEnriched++;
        } else if (ttShow.runningTime && ttShow.runningTime.minutes) {
          const mins = ttShow.runningTime.minutes;
          const display = ttShow.runningTime.display || '';

          // Sanity checks: TodayTix data can be wrong (e.g., EBT listed as 2h30m)
          let skip = false;
          if (mins > 240) {
            console.log(`  ⚠️  Skipping suspicious runtime: ${mins}min (>4h) — likely wrong`);
            skip = true;
          }
          if (show.intermissions === 0 && mins > 150) {
            console.log(`  ⚠️  Skipping suspicious runtime: ${mins}min with no intermission — likely wrong`);
            skip = true;
          }
          if (/inc\.?\s*intermission/i.test(display) && show.intermissions === 0) {
            console.log(`  ⚠️  Skipping runtime: TodayTix says "${display}" but show has 0 intermissions — mismatch`);
            skip = true;
          }

          if (!skip) {
            const runtime = formatRuntime(mins);
            if (!DRY_RUN) show.runtime = runtime;
            parts.push(`runtime=${runtime}`);
            runtimeEnriched++;
          } else {
            parts.push('runtime skipped (suspicious)');
            noRuntime++;
          }
        } else {
          parts.push('no runtime');
          noRuntime++;
        }
      }

      // Age recommendation (only if show doesn't have one)
      if (!show.ageRecommendation) {
        const age = extractAgeRecommendation(ttShow);
        if (age) {
          if (!DRY_RUN) show.ageRecommendation = age;
          parts.push(`age=${age}`);
          ageEnriched++;
        }
      }

      // Intermissions (from runningTime description if present)
      if (show.intermissions === undefined && ttShow.runningTime && ttShow.runningTime.display) {
        const display = ttShow.runningTime.display.toLowerCase();
        if (display.includes('no intermission') || display.includes('no interval')) {
          if (!DRY_RUN) show.intermissions = 0;
          parts.push('intermissions=0');
        } else if (display.includes('one intermission') || display.includes('one interval') || display.includes('1 intermission') || display.includes('1 interval')) {
          if (!DRY_RUN) show.intermissions = 1;
          parts.push('intermissions=1');
        }
      }

      console.log(parts.join(', '));
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      errors++;
    }

    await new Promise(r => setTimeout(r, 300));
  }

  await cleanup();

  console.log(`\n=== Summary ===`);
  console.log(`Runtime enriched: ${runtimeEnriched}`);
  console.log(`Age recommendation enriched: ${ageEnriched}`);
  console.log(`No runtime available: ${noRuntime}`);
  console.log(`Errors: ${errors}`);

  if (!DRY_RUN && (runtimeEnriched > 0 || ageEnriched > 0)) {
    atomicWriteShowsJson(SHOWS_PATH, showsData);
    console.log(`\nshows.json updated.`);
  } else if (DRY_RUN) {
    console.log(`\n(dry run — no files written)`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
