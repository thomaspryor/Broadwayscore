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
const fs = require('fs');
const path = require('path');
const https = require('https');

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

market = MARKET || show.category || 'broadway';
const isBroadway = !market.includes('west-end') && !market.includes('off-west-end');
const isWestEnd = market.includes('west-end') || market.includes('off-west-end');

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

  // 2. Images
  const imgDir = path.join(DATA_DIR, 'public', 'images', 'shows', SHOW_ID);
  const hasHero = fs.existsSync(path.join(imgDir, 'hero.webp'));
  const hasPoster = fs.existsSync(path.join(imgDir, 'poster.webp'));
  const hasThumbnail = fs.existsSync(path.join(imgDir, 'thumbnail.webp'));
  if (hasHero && hasPoster && hasThumbnail) {
    report(PASS, 'Show images', 'hero + poster + thumbnail all present');
  } else {
    const missing = [!hasHero && 'hero', !hasPoster && 'poster', !hasThumbnail && 'thumbnail'].filter(Boolean);
    report(WARN, 'Show images', `Missing: ${missing.join(', ')}. Run: gh workflow run fetch-all-image-formats.yml -f show=${SHOW_ID}`);
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

  // 5. BWW Review Roundup URL pattern
  const titleSlug = show.title.toUpperCase().replace(/[^A-Z0-9\s]/g, '').replace(/\s+/g, '-');
  const openingDate = show.openingDate || '';
  const bwwDate = openingDate.replace(/-/g, '');
  const bwwPattern = `https://www.broadwayworld.com/article/Review-Roundup-${titleSlug}-Opens-on-Broadway-${bwwDate}`;
  if (isBroadway && openingDate) {
    report(WARN, 'BWW Roundup URL', `Have this ready: ${bwwPattern}\n   If wrong, find correct URL and pass as --bww-roundup-url to poller.`);
  } else if (!isBroadway) {
    report(SKIP, 'BWW Roundup URL', 'West End — BWW roundups are primarily Broadway');
  }

  // 6. Talkin' Broadway URL (Broadway only)
  if (isBroadway) {
    const tbSlug = show.title.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    const tbYear = (show.openingDate || '').slice(0, 4);
    const tbUrl = `https://www.talkinbroadway.com/page/world/${tbSlug}${tbYear}.html`;
    const tbRes = await httpsGet(tbUrl);
    if (tbRes.status === 200 && tbRes.body.length > 2000) {
      report(PASS, 'Talkin\' Broadway URL', `Found: ${tbUrl}`);
    } else {
      report(WARN, 'Talkin\' Broadway URL', `Not found yet (${tbRes.status}). Expected: ${tbUrl}\n   TB publishes late — may appear after opening. Have URL ready for poller.`);
    }
  } else {
    report(SKIP, 'Talkin\' Broadway URL', 'West End — TB is Broadway-only');
  }

  // 7. Wrong-production pre-scores
  const reviewTextsDir = path.join(DATA_DIR, 'data', 'review-texts', SHOW_ID);
  if (fs.existsSync(reviewTextsDir)) {
    const files = fs.readdirSync(reviewTextsDir).filter(f => f.endsWith('.json'));
    const wrongProd = [];
    for (const f of files) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(reviewTextsDir, f), 'utf8'));
        if (d.wrongProduction) wrongProd.push(f);
      } catch {}
    }
    if (wrongProd.length > 0) {
      report(WARN, 'Wrong-production files', `${wrongProd.length} files flagged: ${wrongProd.slice(0, 3).join(', ')}${wrongProd.length > 3 ? '...' : ''}`);
    } else if (files.length > 0) {
      report(PASS, 'Pre-existing reviews', `${files.length} review files, none flagged as wrong production`);
    } else {
      report(PASS, 'Pre-existing reviews', 'No pre-existing review files (clean slate)');
    }
  } else {
    report(PASS, 'Pre-existing reviews', 'No review-texts directory yet (clean slate)');
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
  const bdToken = process.env.BRIGHTDATA_TOKEN;
  if (bdToken) {
    const bdRes = await httpsGet('https://api.brightdata.com/zone?zone=mcp_unlocker', {
      'Authorization': `Bearer ${bdToken}`,
    });
    if (bdRes.status === 200) {
      try {
        const zone = JSON.parse(bdRes.body);
        if (zone.disable) {
          report(FAIL, 'Bright Data zone', 'mcp_unlocker is DISABLED. Recover in BD UI (Configuration tab → Recover + enable toggle).');
        } else {
          report(PASS, 'Bright Data zone', 'mcp_unlocker active');
        }
      } catch {
        report(WARN, 'Bright Data zone', `Unexpected response: ${bdRes.body.slice(0, 100)}`);
      }
    } else {
      report(WARN, 'Bright Data zone', `API returned ${bdRes.status}`);
    }
  } else {
    report(SKIP, 'Bright Data zone', 'BRIGHTDATA_TOKEN not set');
  }

  // 10. ScrapingBee credits
  const sbKey = process.env.SCRAPINGBEE_API_KEY;
  if (sbKey) {
    const sbRes = await httpsGet(`https://app.scrapingbee.com/api/v1/usage?api_key=${sbKey}`);
    if (sbRes.status === 200) {
      try {
        const usage = JSON.parse(sbRes.body);
        const used = usage.used || 0;
        const limit = usage.max_api_credit || usage.limit || 1;
        const pct = Math.round((used / limit) * 100);
        if (pct > 75) {
          report(FAIL, 'ScrapingBee credits', `${pct}% used (${used}/${limit}). Opening nights at risk.`);
        } else if (pct > 50) {
          report(WARN, 'ScrapingBee credits', `${pct}% used (${used}/${limit}). Monitor.`);
        } else {
          report(PASS, 'ScrapingBee credits', `${pct}% used (${used}/${limit})`);
        }
      } catch {
        report(WARN, 'ScrapingBee credits', 'Could not parse usage response');
      }
    } else {
      report(WARN, 'ScrapingBee credits', `API returned ${sbRes.status}`);
    }
  } else {
    report(SKIP, 'ScrapingBee credits', 'SCRAPINGBEE_API_KEY not set');
  }

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

  // 12. Orchestrator recent fire
  const ghToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (ghToken) {
    const orchRes = await httpsGet(
      'https://api.github.com/repos/thomaspryor/Broadwayscore/actions/workflows/opening-night-orchestrator.yml/runs?per_page=5',
      { 'Authorization': `Bearer ${ghToken}`, 'User-Agent': 'BWSC-Health-Check' }
    );
    if (orchRes.status === 200) {
      try {
        const runs = JSON.parse(orchRes.body).workflow_runs || [];
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
      report(WARN, 'Orchestrator check', `GitHub API returned ${orchRes.status}. Set GH_TOKEN for this check.`);
    }
  } else {
    report(SKIP, 'Orchestrator check', 'GH_TOKEN not set');
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
