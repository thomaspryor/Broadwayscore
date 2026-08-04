#!/usr/bin/env node
/**
 * Enrich shows.json with synopses from Wikipedia plot/synopsis sections.
 *
 * Targets shows with empty/missing synopsis. Searches Wikipedia by show title,
 * extracts the == Plot == or == Synopsis == section, and cleans it to a 1-2
 * sentence summary (max 500 chars).
 *
 * Every candidate synopsis is gated through verifyProductionMatch (Opus)
 * before being written — same-titled Wikipedia articles for a DIFFERENT
 * production are common (task #68, 2026-06-21: a BBC sitcom's plot almost
 * landed on "All About Me" (2010 Dame Edna revue)). No ANTHROPIC_API_KEY →
 * no verifier → nothing is written, matching the fixSynopsis() pattern in
 * auto-fix-show-data.js.
 *
 * Usage: node scripts/enrich-wikipedia-synopsis.js [--dry-run] [--category=off-broadway|west-end|broadway] [--show=ID]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { stripLeadingJunk } = require('./lib/wiki-utils');
const {
  buildSearchTitles,
  isDisambiguationPage,
  isTheatricalPage,
  extractPlotSection,
  trimToSynopsis,
  hasBadSynopsisContent,
  resolveVariantContent,
  pickSearchCandidate,
} = require('./lib/wikipedia-synopsis-match');
const { cleanSearchTitle } = require('./lib/title-normalization');
const { isValidSynopsis, classifyBadSynopsis } = require('./lib/synopsis-validation');
const { verifyProductionMatch } = require('./lib/synopsis-production-match');
const { CLAUDE_OPUS } = require('./lib/models');
const { loadShows, saveShows } = require('./lib/shows-write-guard');

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `enrich-wikipedia-synopsis.js — Enrich shows.json with synopses from Wikipedia plot/synopsis sections.

Usage:
  node scripts/enrich-wikipedia-synopsis.js [options]
  node scripts/enrich-wikipedia-synopsis.js --help, -h    print this usage and exit
`;
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const DRY_RUN = process.argv.includes('--dry-run');
const CATEGORY_FILTER = process.argv.find(a => a.startsWith('--category='))?.split('=')[1] || null;
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '0', 10);
const ONLY_SHOW = process.argv.find(a => a.startsWith('--show='))?.split('=')[1] || null;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const WIKI_API = 'https://en.wikipedia.org/w/api.php';
// WMF's User-Agent policy expects contact info in the UA string — a bare
// "BroadwayScorecardBot/1.0 (broadway-scorecard project)" is still subject to
// the anonymous API's tight burst limit (see MAX_RETRIES/backoff below), but
// a compliant UA is a prerequisite for any future rate-limit exception.
const USER_AGENT = 'BroadwayScorecardBot/1.0 (https://broadwayscorecard.com; contact@broadwayscorecard.com)';
const MAX_RETRIES = 3;

// Helper function to call Claude API (mirrors auto-fix-show-data.js's callClaudeAPI).
function callClaudeAPI(prompt, maxTokens, model = CLAUDE_OPUS) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });

    const options = {
      hostname: 'api.anthropic.com',
      port: 443,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          const text = response.content?.[0]?.text;
          resolve(text || null);
        } catch {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.write(postData);
    req.end();
  });
}

/**
 * Fetch and JSON-parse a Wikipedia API URL, with backoff+retry on 429/503.
 * The old version of this function didn't check res.statusCode at all, so a
 * 429 rate-limit body ("You are making too many requests...", plain text —
 * not JSON) failed JSON.parse and was silently swallowed by the caller's
 * empty catch block, reporting every remaining show as "NOT FOUND" (task #68,
 * 2026-06-21: 0/51 — reproduced live: ~15 rapid requests trips the anonymous
 * API's per-IP burst limit).
 */
function fetchJson(url, attempt = 1) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 429 || res.statusCode === 503) {
          if (attempt > MAX_RETRIES) {
            reject(new Error(`HTTP ${res.statusCode} after ${MAX_RETRIES} retries`));
            return;
          }
          const retryAfterHeader = parseInt(res.headers['retry-after'], 10);
          const waitMs = Number.isFinite(retryAfterHeader) ? retryAfterHeader * 1000 : attempt * 3000;
          setTimeout(() => {
            fetchJson(url, attempt + 1).then(resolve, reject);
          }, waitMs);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${data.slice(0, 150)}`)); }
      });
    }).on('error', reject);
  });
}

/**
 * Fetch multiple candidate titles in ONE batched request (pipe-separated,
 * formatversion=2, redirects=1 — MediaWiki resolves #REDIRECT server-side).
 * Cuts per-show request count from up to 4 down to 1, which is the main
 * lever against tripping the anonymous API's rate limit.
 */
async function fetchPagesBatch(titles) {
  const unique = [...new Set(titles)].filter(Boolean);
  if (unique.length === 0) return { pagesByTitle: new Map(), redirects: new Map() };
  const url = `${WIKI_API}?action=query&titles=${encodeURIComponent(unique.join('|'))}&prop=revisions&rvprop=content&rvslots=main&format=json&formatversion=2&redirects=1`;
  const data = await fetchJson(url);
  const pagesByTitle = new Map();
  for (const p of (data.query && data.query.pages) || []) pagesByTitle.set(p.title, p);
  const redirects = new Map();
  for (const r of (data.query && data.query.redirects) || []) redirects.set(r.from, r.to);
  return { pagesByTitle, redirects };
}

async function searchWikipediaTitles(query) {
  const url = `${WIKI_API}?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=8&format=json&formatversion=2`;
  const data = await fetchJson(url);
  return ((data.query && data.query.search) || []).map(r => r.title);
}

/**
 * Find Wikipedia wikitext for a show: try the guessed title variants
 * (batched into one request), then fall back to full-text search when none
 * of the guesses hit.
 */
async function findWikipediaContent(show) {
  const variants = buildSearchTitles(show);
  const { pagesByTitle, redirects } = await fetchPagesBatch(variants);
  for (const variant of variants) {
    const content = resolveVariantContent(pagesByTitle, redirects, variant);
    if (content) return { content, matchedVia: 'direct' };
  }

  const type = show.type || show.format;
  const query = `${cleanSearchTitle(show.title)} ${type === 'musical' ? 'musical' : 'play'}`;
  const searchResults = await searchWikipediaTitles(query);
  const candidate = pickSearchCandidate(show, searchResults);
  if (!candidate) return null;

  const { pagesByTitle: pb2, redirects: rd2 } = await fetchPagesBatch([candidate]);
  const content = resolveVariantContent(pb2, rd2, candidate);
  if (!content) return null;
  return { content, matchedVia: 'search' };
}

async function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const showsData = loadShows();
  const shows = showsData.shows;

  // Target any show whose synopsis is missing OR bad (refusal, generic
  // production-history placeholder, stale future-tense, or otherwise invalid).
  // Previously only empty synopses were re-enriched, so placeholders written
  // pre-opening sat live forever (1536 incident, 2026-06-21).
  let targets = shows.filter(s => classifyBadSynopsis(s).bad);

  if (ONLY_SHOW) {
    targets = targets.filter(s => s.id === ONLY_SHOW);
  }

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
  console.log(`Verifier (ANTHROPIC_API_KEY): ${ANTHROPIC_API_KEY ? 'enabled' : 'DISABLED — nothing will be written'}`);
  console.log(`DRY_RUN: ${DRY_RUN}\n`);

  const verifier = ANTHROPIC_API_KEY ? (p => callClaudeAPI(p, 200, CLAUDE_OPUS)) : null;

  let enriched = 0, notFound = 0, noPlot = 0, wrongShow = 0, apiErrors = 0;

  for (let i = 0; i < targets.length; i++) {
    const show = targets[i];
    process.stdout.write(`[${i + 1}/${targets.length}] ${show.id}... `);

    let result;
    try {
      result = await findWikipediaContent(show);
    } catch (e) {
      console.log(`API error: ${e.message}`);
      apiErrors++;
      // A persistent rate-limit/HTTP-error run means every remaining "NOT
      // FOUND" would be a false diagnosis, not a real miss — stop instead of
      // mislabeling the rest of the target list (the exact failure mode that
      // produced the 0/51 in task #68).
      if (apiErrors >= 3) {
        console.log(`\n⚠️  ${apiErrors} consecutive API errors — aborting run early (Wikipedia API likely rate-limiting this IP). Remaining ${targets.length - i - 1} shows left untouched, not counted as "not found".`);
        break;
      }
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }
    apiErrors = 0;

    if (!result) {
      console.log('NOT FOUND');
      notFound++;
      await new Promise(r => setTimeout(r, 300));
      continue;
    }

    const { content } = result;

    if (isDisambiguationPage(content)) {
      console.log('disambiguation page');
      notFound++;
      await new Promise(r => setTimeout(r, 300));
      continue;
    }

    if (!isTheatricalPage(content)) {
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
    if (synopsis.length < 20 || hasBadSynopsisContent(synopsis) || !isValidSynopsis(synopsis)) {
      console.log('synopsis too short or invalid');
      noPlot++;
      await new Promise(r => setTimeout(r, 300));
      continue;
    }

    // Wrong-show gate: a Wikipedia article can match on title but describe a
    // DIFFERENT production (task #68 — a BBC sitcom's plot for "All About Me").
    if (!verifier) {
      console.log('skipped — no verifier (ANTHROPIC_API_KEY) to confirm right show');
      wrongShow++;
      await new Promise(r => setTimeout(r, 300));
      continue;
    }
    const { match, reason } = await verifyProductionMatch(show, synopsis, verifier);
    if (!match) {
      console.log(`rejected (wrong show): ${reason}`);
      wrongShow++;
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
  console.log(`Rejected as wrong show / unverified: ${wrongShow}`);

  if (!DRY_RUN && enriched > 0) {
    saveShows(showsData);
    console.log(`\nshows.json updated.`);
  } else if (DRY_RUN) {
    console.log(`\n(dry run — no files written)`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
