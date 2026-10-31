#!/usr/bin/env node
/**
 * Live HTTP audit of every URL in data/show-score-urls.json.
 *
 * Distinct from scripts/audit-show-score-urls.js (which audits offline from the
 * cached aggregator-archive for wrong-production matches + duplicate URLs). This
 * script complements that by actually fetching each URL and flagging slugs that
 * silently redirect to Show Score's generic listing page.
 *
 * Why: Show Score returns HTTP 200 with the 126KB generic listing when a slug
 * doesn't exist (seen 2026-04-24 with "beaches-a-new-musical-broadway" — no such
 * slug on SS; "beaches-broadway" is the correct one). extract-show-score-reviews.js
 * correctly rejects these silent redirects (page title lacks a "(Broadway)" suffix)
 * but the rejection is logged softly; a misconfigured slug can hide for weeks.
 *
 * Usage:
 *   node scripts/audit-show-score-url-redirects.js                # audit all URLs
 *   node scripts/audit-show-score-url-redirects.js --limit=20     # cap at N (quick test)
 *   node scripts/audit-show-score-url-redirects.js --show=<id>    # single show
 *
 * Exit code:
 *   0  no silent redirects found
 *   1  at least one silent redirect — list printed (fix show-score-urls.json)
 *   2  fetch error on ALL candidates — network / rate-limit, re-run later
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const URLS_PATH = path.join(__dirname, '..', 'data', 'show-score-urls.json');
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const REQUEST_SPACING_MS = 750;
const GENERIC_TITLE_SUBSTR = 'NYC Theatre Reviews and Tickets';

const args = process.argv.slice(2);
const limitArg = args.find(a => a.startsWith('--limit='));
const showArg = args.find(a => a.startsWith('--show='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;
const SHOW_ID_FILTER = showArg ? showArg.split('=')[1] : null;

function loadUrlMap() {
  if (!fs.existsSync(URLS_PATH)) {
    console.error(`${URLS_PATH} not found`);
    process.exit(2);
  }
  const raw = JSON.parse(fs.readFileSync(URLS_PATH, 'utf8'));
  return raw.shows || raw;
}

function fetchTitle(url, depth = 0) {
  return new Promise((resolve) => {
    if (depth > 3) return resolve({ error: 'too many redirects' });
    const req = https.get(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        return resolve(fetchTitle(next, depth + 1));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 20000) res.destroy();
      });
      const finish = () => {
        const m = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        resolve({ status: res.statusCode, title: m ? m[1].trim() : '', size: body.length });
      };
      res.on('end', finish);
      res.on('close', finish);
    });
    req.on('error', (err) => resolve({ error: err.message }));
    req.setTimeout(15000, () => {
      req.destroy();
      resolve({ error: 'timeout' });
    });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const urlMap = loadUrlMap();
  let entries = Object.entries(urlMap);
  if (SHOW_ID_FILTER) entries = entries.filter(([id]) => id === SHOW_ID_FILTER);
  if (LIMIT != null) entries = entries.slice(0, LIMIT);

  console.log(`Auditing ${entries.length} Show Score URL${entries.length === 1 ? '' : 's'} via live HTTP...`);

  const redirects = [];
  const errors = [];
  let ok = 0;

  for (const [showId, url] of entries) {
    const result = await fetchTitle(url);
    if (result.error) {
      errors.push({ showId, url, error: result.error });
      console.log(`  [ERR] ${showId} — ${result.error}`);
    } else if (result.title.includes(GENERIC_TITLE_SUBSTR) && !/\(/.test(result.title)) {
      // Real show titles include "(Broadway)" / "(Off-Broadway)" / "(London)"
      // → a title containing "NYC Theatre Reviews and Tickets" with no "(…)" suffix
      // is the generic listing page.
      redirects.push({ showId, url, title: result.title, size: result.size });
      console.log(`  [REDIRECT] ${showId} → ${url}`);
      console.log(`             title="${result.title.slice(0, 80)}" size=${result.size}`);
    } else {
      ok++;
    }
    await sleep(REQUEST_SPACING_MS);
  }

  console.log('');
  console.log(`=== Audit summary ===`);
  console.log(`  OK (real show pages):  ${ok}`);
  console.log(`  Silent redirects:      ${redirects.length}`);
  console.log(`  Fetch errors:          ${errors.length}`);

  if (redirects.length > 0) {
    console.log('');
    console.log('=== Silent redirects — fix these in data/show-score-urls.json ===');
    for (const r of redirects) console.log(`  ${r.showId}:  ${r.url}`);
    process.exit(1);
  }
  if (ok === 0 && errors.length > 0) {
    // Likely a network blip, not a data problem.
    process.exit(2);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(2);
});
