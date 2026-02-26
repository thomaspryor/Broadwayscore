#!/usr/bin/env node
/**
 * Validate and fix Telecharge/Ticketmaster links in shows.json.
 *
 * Unlike TodayTix (which responds to HEAD requests), Telecharge uses Akamai
 * queue-it (302 for everything) and Ticketmaster requires JS rendering (404 for
 * HEAD/GET). So this script validates differently:
 *
 * Telecharge:
 * - Verify URL matches expected construction from show title
 * - Reconstruct if mismatched (show title may have changed)
 * - Remove for closed shows
 *
 * Ticketmaster:
 * - Re-verify via SERP search (confirms URL still appears in Google)
 * - Update if SERP returns a different URL
 * - Remove for closed shows
 *
 * Usage: node scripts/fix-platform-ticket-links.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const DRY_RUN = process.argv.includes('--dry-run');

// ============================================================================
// Telecharge URL construction (shared with enrich script)
// ============================================================================

const TELECHARGE_EXCEPTIONS = {
  'Chicago': 'Chicago-The-Musical',
};

function buildTelechargeUrl(showTitle) {
  if (TELECHARGE_EXCEPTIONS[showTitle]) {
    return 'https://www.telecharge.com/Broadway/' + TELECHARGE_EXCEPTIONS[showTitle];
  }
  const slug = showTitle
    .replace(/&/g, 'And')
    .replace(/[''!,.:;?"()]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return 'https://www.telecharge.com/Broadway/' + slug;
}

// ============================================================================
// Ticketmaster SERP re-verification
// ============================================================================

function httpGet(url, options = {}) {
  return new Promise((resolve, reject) => {
    const timeout = options.timeout || 30000;
    const urlObj = new URL(url);
    const proto = urlObj.protocol === 'https:' ? https : require('http');
    const reqOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BroadwayScorecard/1.0)' },
      timeout,
    };
    const req = proto.request(reqOptions, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
      res.on('error', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function normalizeShowName(name) {
  return name.toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function serpVerifyTicketmaster(showTitle, existingUrl) {
  const apiKey = process.env.SCRAPINGBEE_API_KEY;
  if (!apiKey) return { status: 'skip', reason: 'no API key' };

  const query = `site:ticketmaster.com "${showTitle}" broadway tickets`;
  const searchUrl = `https://app.scrapingbee.com/api/v1/store/google?api_key=${apiKey}&search=${encodeURIComponent(query)}`;

  try {
    const result = await httpGet(searchUrl);
    if (result.statusCode !== 200) return { status: 'skip', reason: `SERP ${result.statusCode}` };

    const data = JSON.parse(result.body);
    const results = data.organic_results || data.results || [];
    const tmPattern = /ticketmaster\.com\/.*tickets\/artist\/\d+/;

    for (const r of results) {
      const url = r.url || r.link;
      if (!url || !tmPattern.test(url)) continue;

      const serpTitle = normalizeShowName(r.title || '');
      const showNorm = normalizeShowName(showTitle);
      const showWords = showNorm.split(' ').filter(w => w.length > 2);
      const matchCount = showWords.filter(w => serpTitle.includes(w)).length;

      if (showWords.length === 0 || matchCount >= Math.ceil(showWords.length * 0.5)) {
        const cleanUrl = url.replace(/^http:/, 'https:').replace('://ticketmaster.com', '://www.ticketmaster.com');
        if (cleanUrl === existingUrl) {
          return { status: 'ok' };
        }
        return { status: 'updated', newUrl: cleanUrl };
      }
    }

    return { status: 'not_found', reason: 'no matching SERP result' };
  } catch (e) {
    return { status: 'skip', reason: e.message };
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log(`Platform Ticket Link Validator ${DRY_RUN ? '(DRY RUN)' : ''}`);
  console.log('='.repeat(60));

  const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const shows = data.shows;

  const stats = {
    telechargeChecked: 0, telechargeFixed: 0, telechargeRemoved: 0,
    ticketmasterChecked: 0, ticketmasterFixed: 0, ticketmasterRemoved: 0, ticketmasterSkipped: 0,
  };

  // ── Phase 1: Telecharge validation ──────────────────────────────
  console.log('\n── Telecharge Validation ──');

  for (const show of shows) {
    const links = show.ticketLinks || [];
    const tcIndex = links.findIndex(l => l.platform === 'Telecharge');
    if (tcIndex < 0) continue;
    stats.telechargeChecked++;

    const tcLink = links[tcIndex];

    // Remove for closed shows
    if (show.status === 'closed') {
      if (!DRY_RUN) links.splice(tcIndex, 1);
      console.log(`${show.id}: REMOVED (closed)`);
      stats.telechargeRemoved++;
      continue;
    }

    // Verify URL matches expected construction
    const expected = buildTelechargeUrl(show.title);
    if (tcLink.url !== expected) {
      console.log(`${show.id}: URL mismatch`);
      console.log(`  Current:  ${tcLink.url}`);
      console.log(`  Expected: ${expected}`);
      if (!DRY_RUN) tcLink.url = expected;
      stats.telechargeFixed++;
    }
  }

  console.log(`Telecharge: ${stats.telechargeChecked} checked, ${stats.telechargeFixed} fixed, ${stats.telechargeRemoved} removed`);

  // ── Phase 2: Ticketmaster validation ────────────────────────────
  console.log('\n── Ticketmaster Validation ──');

  for (const show of shows) {
    const links = show.ticketLinks || [];
    const tmIndex = links.findIndex(l => l.platform === 'Ticketmaster');
    if (tmIndex < 0) continue;
    stats.ticketmasterChecked++;

    const tmLink = links[tmIndex];

    // Remove for closed shows
    if (show.status === 'closed') {
      if (!DRY_RUN) links.splice(tmIndex, 1);
      console.log(`${show.id}: REMOVED (closed)`);
      stats.ticketmasterRemoved++;
      continue;
    }

    // SERP re-verify
    console.log(`${show.id}: verifying via SERP...`);
    const result = await serpVerifyTicketmaster(show.title, tmLink.url);

    if (result.status === 'ok') {
      console.log(`  ✓ URL confirmed`);
    } else if (result.status === 'updated') {
      console.log(`  → Updated: ${result.newUrl}`);
      if (!DRY_RUN) tmLink.url = result.newUrl;
      stats.ticketmasterFixed++;
    } else if (result.status === 'not_found') {
      console.log(`  ⚠ Not found in SERP (keeping existing URL)`);
      // Don't remove — SERP can have false negatives
    } else {
      console.log(`  ⚠ Skipped: ${result.reason}`);
      stats.ticketmasterSkipped++;
    }

    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`Ticketmaster: ${stats.ticketmasterChecked} checked, ${stats.ticketmasterFixed} fixed, ${stats.ticketmasterRemoved} removed, ${stats.ticketmasterSkipped} skipped`);

  // ── Save ─────────────────────────────────────────────────────────
  const totalChanges = stats.telechargeFixed + stats.telechargeRemoved +
                       stats.ticketmasterFixed + stats.ticketmasterRemoved;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Total changes: ${totalChanges}`);

  if (!DRY_RUN && totalChanges > 0) {
    fs.writeFileSync(SHOWS_PATH, JSON.stringify(data, null, 2) + '\n');
    console.log('shows.json updated.');
  } else if (DRY_RUN) {
    console.log('(dry run — no files written)');
  } else {
    console.log('No changes needed.');
  }

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `changes_made=${totalChanges > 0}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `summary=TC:${stats.telechargeFixed}f/${stats.telechargeRemoved}r TM:${stats.ticketmasterFixed}f/${stats.ticketmasterRemoved}r\n`);
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
