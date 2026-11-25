#!/usr/bin/env node
/**
 * Pre-Opening Night Health Check
 *
 * Runs the afternoon before a show opens. Automates CLAUDE.md §14 checks
 * to catch issues BEFORE they become opening night emergencies.
 *
 * Usage:
 *   node scripts/check-opening-night-readiness.js --show=SHOW_ID [--market=broadway|west-end]
 *
 * Env (optional — checks skip gracefully if missing):
 *   ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY
 *   SCRAPINGBEE_API_KEY, BRIGHTDATA_TOKEN, RESEND_API_KEY
 *   FORMSPREE_SUBSCRIBER_API_KEY, FORMSPREE_SUBSCRIBER_FORM_ID
 *   GH_TOKEN or GITHUB_TOKEN (for workflow run checks)
 */
require('./lib/llm-usage-install'); // LLM spend meter: before any client is built (BRO-5043)
const fs = require('fs');
const path = require('path');
const https = require('https');
const { fetchGitHubJSON } = require('./lib/gh-api-client');
const { imagePresent } = require('./lib/show-image-presence');
const { fetchSBCreditStatus } = require('./lib/check-sb-credits');
const { sbCreditVerdict } = require('./lib/sb-credit-verdict');
const { readinessMarket, isWestEndReadinessMarket } = require('./lib/readiness-market');
const { spawnSync } = require('child_process');
const { readinessVerdict } = require('./lib/outlet-feed-reconcile');
const { posterReadiness, preExistingReviewsReadiness, parseImageAuditLine, describeSpawnFailure } = require('./lib/readiness-guards');
const RL = require('./lib/readiness-lane'); // lane / embargo / recent-change checks (BRO-7548)

// --- CLI args ---
const args = process.argv.slice(2);
const SHOW_ID = (args.find(a => a.startsWith('--show=')) || '').split('=')[1];
const MARKET = (args.find(a => a.startsWith('--market=')) || '').split('=')[1] || '';

if (!SHOW_ID) {
  console.error('Usage: node scripts/check-opening-night-readiness.js --show=SHOW_ID [--market=broadway|west-end]');
  process.exit(1);
}

// --- Helpers ---
function httpsGet(url, headers = {}) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const req = https.request({
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers,
        timeout: 15000,
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
      });
      req.on('error', (err) => resolve({ status: 0, body: err.message, headers: {} }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout', headers: {} }); });
      req.end();
    } catch (e) {
      resolve({ status: 0, body: e.message, headers: {} });
    }
  });
}

const PASS = '✅', WARN = '⚠️', FAIL = '❌', SKIP = '⏭️';
const results = [];

function report(status, name, detail) {
  results.push({ status, name, detail });
  console.log(`${status} ${name}`);
  if (detail) console.log(`   ${detail}`);
}

// --- Load show data ---
const DATA_DIR = path.join(__dirname, '..');
let showsData, show, market;
try {
  showsData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'data', 'shows.json'), 'utf8'));
  show = showsData.shows.find(s => s.id === SHOW_ID);
} catch (e) {
  console.error('Cannot load shows.json:', e.message);
  process.exit(1);
}

if (!show) {
  report(FAIL, 'Show exists', `${SHOW_ID} not found in shows.json`);
  printSummary();
  process.exit(1);
}

market = readinessMarket(MARKET, show.category);
// Shared with route-readiness-failure.js's resolve check (BRO-5261).
const isWestEnd = isWestEndReadinessMarket(market);
const isBroadway = !isWestEnd;

console.log(`\n${'═'.repeat(60)}`);
console.log(`  Opening Night Readiness: ${show.title}`);
console.log(`  Show ID: ${SHOW_ID} | Market: ${market}`);
console.log(`  Opening: ${show.openingDate || 'NOT SET'}`);
console.log(`${'═'.repeat(60)}\n`);

// --- Checks ---
async function runChecks() {
  // 1. Show data basics
  if (!show.openingDate) {
    report(FAIL, 'Opening date', 'openingDate is null — show won\'t be detected by orchestrator');
  } else {
    report(PASS, 'Opening date', show.openingDate);
  }

  if (!show.status || show.status === 'closed') {
    report(FAIL, 'Show status', `Status is "${show.status}" — should be "previews" or "open"`);
  } else {
    report(PASS, 'Show status', show.status);
  }

  // 1b. Category not-null (CLAUDE.md rule 14 item 5; Joe Turner 2026-04-19
  // shipped with category=null and the orchestrator soft-warned + defaulted
  // to broadway — fragile. Hard-fail if null.)
  if (!show.category) {
    report(FAIL, 'Show category',
      `category is null — orchestrator will warn + default to broadway. ` +
      `Fix in broadway-scorecard-data/shows.json: set category to 'broadway' or 'west-end'.`);
  } else if (show.category === 'broadway' || show.category === 'west-end') {
    report(PASS, 'Show category', show.category);
  } else {
    report(WARN, 'Show category',
      `category="${show.category}" — orchestrator only special-cases broadway/west-end. ` +
      `Confirm this is intentional (off-broadway / off-west-end shows don't get the broadcast pipeline).`);
  }

  // 1c. BRO-7778: a review headlined with the short title ("Review: It's a Wonderful Life" for "It's A Wonderful Life:
  // A Live Radio Play") must be matched, or at least raise the near-miss alert. Within 7 days of opening, a short title
  // nothing catches fails: add shows.json akaTitles through a fix plan.
  try {
    const { shortTitleCoverage } = require('./lib/press-title-coverage');
    const cov = shortTitleCoverage(show, showsData.shows);
    const days = show.openingDate ? (Date.parse(show.openingDate) - Date.now()) / 86400000 : Infinity;
    const addAka = `add "${cov.lead}" to akaTitles with a fix plan (node scripts/new-fix-plan.js)`;
    if (cov.status === 'no-subtitle') report(PASS, 'Short-title matching', 'billed title has no subtitle');
    else if (cov.status === 'matched') report(PASS, 'Short-title matching', `reviews titled "${cov.lead}" match on every path`);
    else if (cov.akaPossible) report(days <= 7 ? FAIL : WARN, 'Short-title matching', `reviews titled only "${cov.lead}" are not admitted (${cov.status === 'near-miss' ? 'they raise the near-miss alert' : 'and raise no alert'}): ${addAka}`);
    else if (cov.status === 'near-miss') report(WARN, 'Short-title matching', `reviews titled only "${cov.lead}" raise the near-miss alert but cannot be admitted (one word, or another show's name); watch the alert on press night`);
    else report(days <= 7 ? FAIL : WARN, 'Short-title matching', `reviews titled "${cov.lead}" are not matched and raise no near-miss alert (${cov.missed.slice(0, 2).join('; ')})`);
  } catch (e) {
    report(WARN, 'Short-title matching', `could not check: ${e.message}`);
  }

  // 2. Images
  // Trust shows.json's images field (what the site actually renders) rather
  // than hardcoding the .webp filename the standard pipeline produces — the
  // SERP-fallback image path writes .jpg/.png instead, and a hardcoded-webp
  // check flags those shows as "missing" even though the site displays them
  // fine (found via a-month-in-the-country-west-end-2026, 2026-09-02: real
  // poster.jpg + thumbnail.jpg on disk and wired into images.{poster,
  // thumbnail}, reported as "Missing: hero, poster, thumbnail").
  const images = show.images || {};
  // A field being SET is not the same as the file EXISTING. An earlier pass
  // here checked truthiness only, which fixed a false "missing" (the code
  // used to hardcode a .webp extension) by introducing a false ALL-CLEAR,
  // which on an opening-night gate is the worse direction. Real case at the
  // time of writing: high-society-west-end-2026 has images.hero pointing at
  // hero.webp, only poster.jpg and thumbnail.jpg are on disk, and the check
  // printed "✅ Show images". Repo-wide there were 334 images.* refs pointing
  // at files absent from public/.
  //
  // Predicate lives in scripts/lib/show-image-presence.js so the test exercises
  // the real function instead of a copy (CLAUDE.md rule 15).
  const hasHero = imagePresent(images.hero);
  const hasPoster = imagePresent(images.poster);
  const hasThumbnail = imagePresent(images.thumbnail);
  if (hasHero && hasPoster && hasThumbnail) {
    report(PASS, 'Show images', 'hero + poster + thumbnail all present');
  } else {
    const missing = [!hasHero && 'hero', !hasPoster && 'poster', !hasThumbnail && 'thumbnail'].filter(Boolean);
    report(WARN, 'Show images', `Missing: ${missing.join(', ')}. Run: gh workflow run fetch-all-image-formats.yml -f show_id=${SHOW_ID}`);
  }

  // 3. DTLI slug (Broadway only)
  if (isBroadway) {
    try {
      const slugMap = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'data', 'dtli-slug-map.json'), 'utf8'));
      const dtliSlug = (slugMap.shows || slugMap)[SHOW_ID];
      if (dtliSlug) {
        report(PASS, 'DTLI slug', `Mapped to: ${dtliSlug}`);
      } else {
        report(WARN, 'DTLI slug', `No mapping found. Run: gh workflow run scrape-dtli-show-score.yml to discover. Broadcast gate needs at least 1 aggregator.`);
      }
    } catch {
      report(WARN, 'DTLI slug map', 'Cannot read dtli-slug-map.json');
    }
  } else {
    report(SKIP, 'DTLI slug', 'West End — DTLI is US-only');
  }

  // 4. DTLI reachability (Broadway only)
  if (isBroadway) {
    try {
      const slugMap = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'data', 'dtli-slug-map.json'), 'utf8'));
      const dtliSlug = (slugMap.shows || slugMap)[SHOW_ID];
      if (dtliSlug) {
        const url = `https://didtheylikeit.com/shows/${dtliSlug}/`;
        const res = await httpsGet(url);
        if (res.status === 200 && res.body.length > 5000 && (res.body.includes('review-item') || res.body.includes('poster-review-item'))) {
          report(PASS, 'DTLI page reachable', `${url} — ${(res.body.length / 1024).toFixed(0)}KB`);
        } else if (res.status === 200 && res.body.length < 2000) {
          report(WARN, 'DTLI page blocked', `Got ${res.body.length} bytes — likely CDN challenge. fetchPage fallback will be used in CI.`);
        } else if (res.status === 200) {
          report(WARN, 'DTLI page loaded but no reviews', `Page exists but no review-item class found. DTLI may not have reviews yet.`);
        } else {
          report(WARN, 'DTLI page not found', `${url} returned ${res.status}. Page may not exist yet.`);
        }
      } else {
        report(SKIP, 'DTLI reachability', 'No DTLI slug — skipping reachability check');
      }
    } catch (e) {
      report(WARN, 'DTLI reachability', `Error: ${e.message}`);
    }
  } else {
    report(SKIP, 'DTLI reachability', 'West End — DTLI is US-only');
  }

  // 5. BWW Review Roundup discovery
  // URL pattern guessing was DELETED 2026-04-26 (commit eccdb3280f) — never
  // caught what reviews.php missed and burned 17 min/cycle pre-publication.
  // The current chain is: reviews.php Browserbase → homepage scan → SERP →
  // fast-fail. Pre-opening 404s are EXPECTED — page doesn't exist until
  // reviews start dropping. Manual --bww-roundup-url is only needed when
  // reviews.php fails after publication.
  if (isBroadway) {
    report(PASS, 'BWW Roundup discovery',
      `Chain: reviews.php → homepage scan → SERP → fast-fail. ` +
      `Pre-opening 404 is normal; only intervene if reviews.php fails AFTER opening. ` +
      `URL pattern guessing was removed 2026-04-26.`);
  } else {
    report(SKIP, 'BWW Roundup discovery', 'West End — BWW roundups are primarily Broadway');
  }

  // 6. Talkin' Broadway URL (Broadway only)
  // TB pattern varies by show: Lost Boys 2026 used `TheLostBoys.html` (bare
  // slug, no year), Giant 2026 used `giant2026.html` (year suffix). The
  // poller's tryTbDirectUrl tries BOTH. Pre-opening, TB can publish early
  // (Lost Boys' Howard Miller landed 24h pre-opening), so the bare-slug
  // variant is worth checking now.
  if (isBroadway && show.category === 'off-broadway') {
    // Off-Broadway TB pages are dated, not titled; the poller builds them from openingDate (BRO-8148).
    const obUrls = require('./lib/tb-direct-url').buildTbObOpeningCandidates(show.openingDate);
    if (obUrls.length) report(SKIP, 'Talkin\' Broadway URL', `Off-Broadway: poller tries ${obUrls.length} dated pages from ${obUrls[0]}`);
    else report(WARN, 'Talkin\' Broadway URL', 'Off-Broadway show has no openingDate, so the poller cannot build its dated TB url');
  } else if (isBroadway) {
    const baseSlug = show.title.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    const baseSlugCamel = show.title.replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
      .split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
    const tbYear = (show.openingDate || '').slice(0, 4);
    const candidates = [
      `https://www.talkinbroadway.com/page/world/${baseSlugCamel}.html`,           // Lost Boys pattern
      `https://www.talkinbroadway.com/page/world/${baseSlug}${tbYear}.html`,       // Giant pattern (year)
      `https://www.talkinbroadway.com/page/world/${baseSlug}.html`,                // bare lowercase
    ];
    let found = null;
    for (const url of candidates) {
      const res = await httpsGet(url);
      if (res.status === 200 && res.body.length > 2000) {
        found = url;
        break;
      }
    }
    if (found) {
      report(PASS, 'Talkin\' Broadway URL', `Found: ${found}`);
    } else {
      report(WARN, 'Talkin\' Broadway URL',
        `Not found yet across ${candidates.length} pattern variants. ` +
        `TB can publish early (Lost Boys' Howard Miller landed 24h pre-opening) but typically publishes within ` +
        `48h of opening. Poller will discover via tryTbDirectUrl.`);
    }
  } else {
    report(SKIP, 'Talkin\' Broadway URL', 'West End — TB is Broadway-only');
  }

  // 7. Wrong-production pre-scores
  // A "clean slate" is only true BEFORE opening (BRO-5326: Fish passed this check
  // with 12 review files because the resolver pointed at an empty tree).
  const reviewTextsDir = path.join(require('./lib/review-texts-dir').resolveReviewTextsDir(), SHOW_ID);
  const dirExists = fs.existsSync(reviewTextsDir);
  const rtFiles = dirExists ? fs.readdirSync(reviewTextsDir).filter(f => f.endsWith('.json')) : [];
  const wrongProd = [];
  for (const f of rtFiles) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(reviewTextsDir, f), 'utf8'));
      if (d.wrongProduction) wrongProd.push(f);
    } catch {}
  }
  const rtVerdict = preExistingReviewsReadiness({
    openingDate: show.openingDate, today: new Date().toISOString().slice(0, 10),
    dirExists, fileCount: rtFiles.length, wrongProductionCount: wrongProd.length,
  });
  if (wrongProd.length > 0) {
    report(WARN, 'Wrong-production files', `${wrongProd.length} files flagged: ${wrongProd.slice(0, 3).join(', ')}${wrongProd.length > 3 ? '...' : ''}`);
  } else {
    report(rtVerdict.status === 'pass' ? PASS : WARN, 'Pre-existing reviews', rtVerdict.detail);
  }

  // 7b. Poster is this show's art (BRO-5326: Fish shipped with Big Fish art; the
  // vision audit that catches it was never scheduled, so nothing ever looked).
  {
    // The audit child loads .env itself, so load it here too: a key that lives only
    // in .env must not make a by-hand run report "not verified".
    if (!process.env.GEMINI_API_KEY) { try { require('./lib/load-env').loadEnv(); } catch {} }
    const hasKey = !!process.env.GEMINI_API_KEY;
    let parsed = null, failure = null;
    if (hasKey) {
      const r = spawnSync(process.execPath, [path.join(__dirname, 'audit-images-llm.js'), `--show=${SHOW_ID}`, '--no-write', '--skip-validation'],
        { encoding: 'utf8', timeout: 90000, cwd: DATA_DIR });
      parsed = parseImageAuditLine(r.stdout);
      failure = describeSpawnFailure(r);
    }
    const pv = posterReadiness(parsed, { hasKey, failure });
    report(pv.status === 'pass' ? PASS : pv.status === 'warn' ? WARN : SKIP, 'Poster is this show', pv.detail);
  }

  // 7c. Outlet feeds hold no review of this show that we never ingested (BRO-5358:
  // Fish had two in RSS feeds for ~2 days). Advisory, like every new gate (CLAUDE.md §19).
  {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'outlet-feed-reconcile.js'), `--show=${SHOW_ID}`, '--json', '--no-write'],
      { encoding: 'utf8', timeout: 120000, cwd: DATA_DIR });
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch { /* skip verdict below */ }
    const fv = readinessVerdict(parsed);
    report(fv.status === 'pass' ? PASS : fv.status === 'warn' ? WARN : SKIP, 'Outlet feeds vs corpus', fv.detail);
  }

  // 8. API keys (quick validation — no costly API calls)
  const keyChecks = [
    { name: 'ANTHROPIC_API_KEY', env: 'ANTHROPIC_API_KEY', test: 'https://api.anthropic.com/v1/models', headers: { 'x-api-key': '', 'anthropic-version': '2023-06-01' }, keyHeader: 'x-api-key' },
    { name: 'OPENAI_API_KEY', env: 'OPENAI_API_KEY', test: 'https://api.openai.com/v1/models', headers: { 'Authorization': '' }, keyHeader: 'Authorization', keyPrefix: 'Bearer ' },
    { name: 'GEMINI_API_KEY', env: 'GEMINI_API_KEY', test: null }, // just check existence
    { name: 'SCRAPINGBEE_API_KEY', env: 'SCRAPINGBEE_API_KEY', test: null },
    { name: 'BRIGHTDATA_TOKEN', env: 'BRIGHTDATA_TOKEN', test: null },
    { name: 'RESEND_API_KEY', env: 'RESEND_API_KEY', test: 'https://api.resend.com/domains', headers: { 'Authorization': '' }, keyHeader: 'Authorization', keyPrefix: 'Bearer ' },
  ];

  for (const kc of keyChecks) {
    const key = process.env[kc.env];
    if (!key) {
      report(WARN, `API key: ${kc.name}`, 'Not set in environment. Set in .env or GitHub secrets.');
      continue;
    }
    if (kc.test) {
      const headers = { ...kc.headers };
      if (kc.keyHeader) headers[kc.keyHeader] = (kc.keyPrefix || '') + key;
      const res = await httpsGet(kc.test, headers);
      if (res.status >= 200 && res.status < 300) {
        report(PASS, `API key: ${kc.name}`, 'Valid');
      } else {
        report(FAIL, `API key: ${kc.name}`, `Invalid (HTTP ${res.status})`);
      }
    } else {
      report(PASS, `API key: ${kc.name}`, 'Set (not validated)');
    }
  }

  // 9. Bright Data zone status
  // Per memory/feedback_brightdata_zone_migration.md: `mcp_unlocker` is the
  // OBSOLETE trial zone (always shows disabled with "trial limit reached" —
  // ignore). The active zone is $BRIGHTDATA_ZONE (default web_unlocker2 as
  // of 2026-04-25). Alternates: web_unlocker_mnewmsyo / mngwkvlo / mnn80138.
  const bdToken = process.env.BRIGHTDATA_TOKEN;
  const bdZone = process.env.BRIGHTDATA_ZONE || 'web_unlocker2';
  if (bdToken) {
    const bdRes = await httpsGet(`https://api.brightdata.com/zone?zone=${encodeURIComponent(bdZone)}`, {
      'Authorization': `Bearer ${bdToken}`,
    });
    if (bdRes.status === 200) {
      try {
        const zone = JSON.parse(bdRes.body);
        if (zone.disable) {
          report(FAIL, 'Bright Data zone',
            `${bdZone} is DISABLED ("${zone.disable}"). Recover in BD UI ` +
            `(Configuration tab → Recover + enable toggle), or swap to alternate ` +
            `via: printf 'NEW_ZONE' | gh secret set BRIGHTDATA_ZONE.`);
        } else {
          report(PASS, 'Bright Data zone', `${bdZone} active`);
        }
      } catch {
        report(WARN, 'Bright Data zone', `Unexpected response: ${bdRes.body.slice(0, 100)}`);
      }
    } else {
      report(WARN, 'Bright Data zone', `API returned ${bdRes.status} for zone ${bdZone}`);
    }
  } else {
    report(SKIP, 'Bright Data zone', 'BRIGHTDATA_TOKEN not set');
  }

  // 9b. CRITICAL_CRONS membership (CLAUDE.md rule 14 item 2). Verify
  // opening-night-orchestrator is in check-cron-health.yml's CRITICAL_CRONS
  // list — without it, a missing/late orchestrator run won't page anyone.
  try {
    const cronHealthYml = fs.readFileSync(
      path.join(DATA_DIR, '.github', 'workflows', 'check-cron-health.yml'),
      'utf8',
    );
    if (cronHealthYml.includes('opening-night-orchestrator')) {
      report(PASS, 'Orchestrator in CRITICAL_CRONS', 'opening-night-orchestrator listed in check-cron-health.yml');
    } else {
      report(FAIL, 'Orchestrator missing from CRITICAL_CRONS',
        'opening-night-orchestrator NOT found in .github/workflows/check-cron-health.yml. ' +
        'Late or missed runs won\'t page. Add to CRITICAL_CRONS list.');
    }
  } catch (e) {
    report(WARN, 'Orchestrator CRITICAL_CRONS check', `Could not read check-cron-health.yml: ${e.message}`);
  }

  // 10. ScrapingBee credits
  //
  // BRO-3032: this block used to fetch /usage itself and read `usage.used` —
  // a field that endpoint has never returned (it returns used_api_credit) —
  // so the percentage was always 0 and this check reported PASS "0% used" at
  // every real usage level, including an exhausted cycle. A dead alarm inside
  // a MANDATORY readiness checklist (CLAUDE.md rule 14).
  //
  // Both halves now live where they can be tested and where the payload shape
  // is already known: lib/check-sb-credits.js owns the fetch and classifies
  // no-key / api-error / max_api_credit<=0, and lib/sb-credit-verdict.js owns
  // the thresholds. Nothing here hand-reads a provider field name any more.
  const sbVerdict = sbCreditVerdict(await fetchSBCreditStatus());
  // `?? WARN`: an unmapped level would make report() push {status: undefined},
  // which printSummary counts in none of its four buckets — the check would
  // silently vanish from the summary, which is the exact failure mode this
  // whole fix exists to remove. Degrade loudly instead.
  const sbSymbol = { pass: PASS, warn: WARN, fail: FAIL, skip: SKIP }[sbVerdict.level] ?? WARN;
  report(sbSymbol, 'ScrapingBee credits', sbVerdict.detail);

  // 11. Subscriber sync (Formspree vs Resend)
  const resendKey = process.env.RESEND_API_KEY;
  const formspreeKey = process.env.FORMSPREE_SUBSCRIBER_API_KEY;
  const formspreeForm = process.env.FORMSPREE_SUBSCRIBER_FORM_ID;
  if (resendKey && formspreeKey && formspreeForm) {
    const resendRes = await httpsGet('https://api.resend.com/audiences/472ec5ef-d7cc-4c48-8007-c0a6a302e7a4/contacts', {
      'Authorization': `Bearer ${resendKey}`,
    });
    const formspreeRes = await httpsGet(`https://formspree.io/api/0/forms/${formspreeForm}/submissions`, {
      'Authorization': `Bearer ${formspreeKey}`,
    });

    let resendCount = 0, formspreeCount = 0;
    try {
      resendCount = JSON.parse(resendRes.body).data?.length || 0;
    } catch {}
    try {
      const subs = JSON.parse(formspreeRes.body).submissions || [];
      // Deduplicate by email, only count subscribes (not unsubscribes)
      const emails = new Set();
      for (const s of subs) {
        const email = (s.email || s._replyto || '').toLowerCase().trim();
        const action = (s.action || 'subscribe').toLowerCase();
        if (action === 'unsubscribe') emails.delete(email);
        else if (email) emails.add(email);
      }
      formspreeCount = emails.size;
    } catch {}

    const diff = Math.abs(resendCount - formspreeCount);
    if (diff > 10) {
      report(WARN, 'Subscriber sync', `Resend: ${resendCount}, Formspree: ${formspreeCount} (Δ${diff}). Run sync-followers.js before broadcast.`);
    } else {
      report(PASS, 'Subscriber sync', `Resend: ${resendCount}, Formspree: ${formspreeCount} (Δ${diff})`);
    }
  } else {
    report(SKIP, 'Subscriber sync', 'Missing RESEND_API_KEY or FORMSPREE keys');
  }

  // 11b. Resource budget headroom (single-show pre-flight).
  // Soft-warns when any resource has less than 1.5× the per-show estimate
  // available — i.e. enough to cover this show plus ~half another. Failures
  // block, except ScrapingBee-only shortfalls (fallback provider, WARN; BRO-7854).
  // See scripts/lib/opening-night-budget.js.
  try {
    const { checkBudget, splitBudgetBlockers } = require('./lib/opening-night-budget');
    const budget = await checkBudget(1);
    const { hard, soft } = splitBudgetBlockers(budget.blockers);
    const fmt = b => `${b.resource}: need ${b.needed} ${b.unit || ''}, ${b.available} available`;
    if (hard.length > 0) {
      report(FAIL, 'Resource budget (1 show)', hard.concat(soft).map(fmt).join('; '));
    } else if (soft.length > 0) {
      // SB is a fallback link; owner policy is ride-it-out (BRO-7854).
      report(WARN, 'Resource budget (1 show)', `${soft.map(fmt).join('; ')} (fallback provider, riding it out per policy)`);
    } else {
      // Soft-warn at 1.5× per-show headroom (i.e. tight if we couldn't fit a second one)
      const tight = [];
      for (const [res, est] of Object.entries(budget.estimate)) {
        const avail = budget.usage[res] && budget.usage[res].remaining;
        if (avail == null) continue;
        if (est.perShow > 0 && avail < est.perShow * 1.5) {
          tight.push(`${res}: ${avail} remaining < 1.5× per-show (${est.perShow})`);
        }
      }
      if (tight.length > 0) {
        report(WARN, 'Resource budget (1 show)', `Tight headroom — ${tight.join('; ')}`);
      } else {
        const totals = Object.entries(budget.estimate).map(([k, v]) => `${k}=${v.total}`).join(', ');
        report(PASS, 'Resource budget (1 show)', `Budget OK: ${totals}`);
      }
    }
  } catch (e) {
    report(WARN, 'Resource budget check', `Could not run budget check: ${e.message}`);
  }

  // 12. Orchestrator recent fire
  const ghToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (ghToken) {
    let orchRuns = null;
    let orchStatus = 200;
    let orchError = '';
    try {
      orchRuns = await fetchGitHubJSON(
        'https://api.github.com/repos/thomaspryor/Broadwayscore/actions/workflows/opening-night-orchestrator.yml/runs?per_page=5',
        { token: ghToken, caller: 'check-opening-night-readiness.js' }
      );
    } catch (err) {
      orchStatus = err.status || 0;
      orchError = err.message;
    }
    if (orchStatus === 200) {
      try {
        if (!orchRuns) throw new Error('unparseable response');
        const runs = orchRuns.workflow_runs || [];
        const recentRun = runs[0];
        if (recentRun) {
          const ageHours = (Date.now() - new Date(recentRun.created_at).getTime()) / 3600000;
          if (ageHours < 48) {
            report(PASS, 'Orchestrator recently fired', `${recentRun.conclusion || recentRun.status} ${Math.round(ageHours)}h ago`);
          } else {
            report(WARN, 'Orchestrator stale', `Last run was ${Math.round(ageHours)}h ago. Consider manual trigger before opening.`);
          }
        } else {
          report(FAIL, 'Orchestrator never fired', 'No runs found. Trigger manually: gh workflow run opening-night-orchestrator.yml');
        }
      } catch {
        report(WARN, 'Orchestrator check', 'Could not parse GitHub API response');
      }
    } else {
      report(WARN, 'Orchestrator check', `GitHub API returned ${orchStatus || orchError || 'an error'}. Set GH_TOKEN for this check.`);
    }
  } else {
    report(SKIP, 'Orchestrator check', 'GH_TOKEN not set');
  }

  // 13. Opening-night lane (BRO-7548). The lane is the primary publisher for Broadway (LANE_ONLY_MARKETS), so a
  // readiness verdict that only knows the orchestrator can say "ready" while the lane is disarmed or dead.
  const toStatus = (v) => ({ pass: PASS, warn: WARN, fail: FAIL, skip: SKIP }[v.status]);
  const emit = (name, v) => report(toStatus(v), name, v.detail);
  const nowMs = Date.now();
  const night = show.openingDate;
  emit('Embargo (reviews open)', RL.embargoVerdict(show, nowMs));
  // BRO-7808: embargo lifted days after the recorded openingDate; runs before any early return so it is never skipped.
  try {
    const allReviews = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'data', 'reviews.json'), 'utf8'));
    const mine = (allReviews.reviews || allReviews).filter((r) => r.showId === SHOW_ID);
    const late = RL.lateEmbargoVerdict(show, mine, nowMs);
    if (late.status !== 'skip') emit('Late embargo (reviews after press night)', late);
  } catch (e) { if (e.code !== 'ENOENT') throw e; /* no reviews file: nothing to compare */ }

  // The lane only publishes shows LANE_ONLY_MARKETS covers; for any other show a disarmed lane or a missing night run
  // is not a risk and must not exit 1 (West End, off-Broadway). Read from the lane-switch ledger (cloud gets 403 on
  // repo variables).
  let laneVars = { onlyMarkets: '', standdown: '' };
  try {
    const rows = fs.readFileSync(path.join(DATA_DIR, 'data', 'audit', 'lane-switch.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    laneVars = RL.replayLaneVars(rows);
  } catch { /* no ledger = nothing ever set = lane covers nothing */ }
  const applies = RL.laneAppliesTo(laneVars, show);
  if (!applies.applies) {
    report(SKIP, 'Opening-night lane', `${applies.reason} (per data/audit/lane-switch.jsonl)`);
    printSummary();
    return;
  }
  report(PASS, 'Lane publishes this show', `${applies.reason} (per data/audit/lane-switch.jsonl)`);
  // BRO-7741: the answer to "a review is missing" on a lane night, printed where the person checking readiness looks.
  report(PASS, 'If a review is missing', `do not roll back the lane: node scripts/opening-night-lane-inbox.js add --show=${SHOW_ID} --url=URL (or dispatch ingest-urls.yml by hand); the lane publishes it on its next pass, about 2 min. Runbook: docs/cloud-overnight-watch-runbook.md`);

  let armed = null;
  try {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'opening-night-lane-rehearse.js'), '--arm-check'], { encoding: 'utf8', timeout: 60000 });
    const line = String(r.stdout || '').split('\n').reverse().find((l) => l.trim().startsWith('{'));
    const armJson = line ? JSON.parse(line) : null;
    if (armJson && typeof armJson.arm === 'boolean') armed = armJson.arm;
    emit('Lane armed', RL.armVerdict(armJson));
  } catch (e) {
    emit('Lane armed', RL.armVerdict(null));
  }

  // BRO-7781: the latest simulated opening night (lane-rehearsal.yml writes the record). Read, never run here: the night is
  // synthetic and show-independent, and this script runs with live scraper and model keys in its env.
  let simRecord = null;
  try { simRecord = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'data', 'audit', 'simulated-opening-night.json'), 'utf8')); } catch { /* none yet */ }
  emit('Simulated opening night', RL.simulatedNightVerdict(simRecord, nowMs));

  const emb = RL.embargoFor(show);
  if (!ghToken) {
    report(SKIP, 'Lane night run / watchdog / recent changes', 'GH_TOKEN not set');
  } else if (!emb || !night) {
    report(WARN, 'Lane night run / watchdog', 'No embargo or opening date, so no night to look for.');
  } else if (RL.nightOver(show, nowMs)) {
    report(SKIP, 'Lane night run / watchdog', `Press night ${night} is over (embargo ${emb.embargoAt} was more than 12h ago).`);
  } else {
    const ghGet = (url) => fetchGitHubJSON(url, { token: ghToken, caller: 'check-opening-night-readiness.js' });
    const toRuns = (resp) => ((resp && resp.workflow_runs) || []).map((r) => ({
      displayTitle: r.display_title || r.name || '', status: r.status, conclusion: r.conclusion, createdAt: r.created_at,
    }));
    const createdFrom = encodeURIComponent(new Date(emb.kickAtMs - 24 * 3600000).toISOString());
    for (const [wf, label, mode] of [['opening-night-lane-live.yml', 'Lane night run', 'night'], ['opening-night-lane-watchdog.yml', 'Lane watchdog', 'watchdog']]) {
      try {
        const resp = await ghGet(`https://api.github.com/repos/thomaspryor/Broadwayscore/actions/workflows/${wf}/runs?per_page=100&created=%3E%3D${createdFrom}`);
        emit(label, RL.laneRunVerdict(toRuns(resp), { showId: SHOW_ID, night, label: label.toLowerCase(), mode, kickAtMs: emb.kickAtMs, nowMs }));
      } catch (e) {
        report(WARN, label, `GitHub API error (${e.status || e.message}); could not look for the ${label.toLowerCase()}.`);
      }
    }
    const WINDOW_H = 48;
    const since = new Date(nowMs - WINDOW_H * 3600000).toISOString();
    try {
      const responses = [];
      for (const p of RL.PIPELINE_PATHS) {
        responses.push(await ghGet(`https://api.github.com/repos/thomaspryor/Broadwayscore/commits?sha=main&since=${encodeURIComponent(since)}&per_page=50&path=${encodeURIComponent(p)}`));
      }
      emit('Pipeline changes (last 48h)', RL.changesVerdict(RL.mergeCommitResponses(responses, RL.PIPELINE_PATHS), { armed, windowHours: WINDOW_H }));
    } catch (e) {
      report(WARN, 'Pipeline changes (last 48h)', `GitHub API error (${e.status || e.message}); could not list recent pipeline commits.`);
    }
  }

  printSummary();
}

function printSummary() {
  const passes = results.filter(r => r.status === PASS).length;
  const warns = results.filter(r => r.status === WARN).length;
  const fails = results.filter(r => r.status === FAIL).length;
  const skips = results.filter(r => r.status === SKIP).length;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  SUMMARY: ${passes} pass, ${warns} warn, ${fails} fail, ${skips} skip`);

  if (fails > 0) {
    console.log(`\n  ${FAIL} NOT READY — fix ${fails} failing check(s) before opening night`);
    results.filter(r => r.status === FAIL).forEach(r => console.log(`     ${r.name}: ${r.detail}`));
  } else if (warns > 0) {
    console.log(`\n  ${WARN} MOSTLY READY — review ${warns} warning(s)`);
  } else {
    console.log(`\n  ${PASS} ALL CLEAR — ready for opening night!`);
  }
  console.log(`${'═'.repeat(60)}\n`);

  process.exit(fails > 0 ? 1 : 0);
}

runChecks().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
