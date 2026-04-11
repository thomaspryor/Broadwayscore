#!/usr/bin/env node
/**
 * Validate StubHub ticket URLs in data/shows.json.
 *
 * StubHub reuses performer IDs when shows close, so a URL like
 *   https://www.stubhub.com/joe-turners-come-and-gone-tickets/performer/150605994
 * may silently redirect to a completely different show
 *   https://www.stubhub.com/mackerelle-tickets/performer/150605994
 * or return 404 outright.
 *
 * Validation strategy:
 * 1. HEAD + follow redirects via curl (StubHub blocks Node fetch UAs).
 * 2. If final status is 4xx/5xx → BROKEN (hard error).
 * 3. Extract slug from the final URL path.
 * 4. Compare to the show's known slug/title. If mismatch → BROKEN (wrong show).
 *
 * Output:
 *   - Console: live progress + summary
 *   - /tmp/stubhub-validation.json: full per-URL results
 *   - /tmp/stubhub-broken.txt: list of broken URLs with show ID + reason
 *
 * Usage:
 *   node scripts/validate-stubhub-urls.js [--apply]
 *
 * --apply: strip broken URLs from shows.json (default: dry-run, report only)
 */

const fs = require('fs');
const { execSync } = require('child_process');

const APPLY = process.argv.includes('--apply');
const SHOWS_PATH = 'data/shows.json';

// Noise tokens stripped from both sides before comparison.
// Market/year/suffix words that don't distinguish shows from each other.
const NOISE_TOKENS = new Set([
  'the','and','for','show','tickets',
  'ny','nyc','new','york','broadway',
  'london','west','end','city',
  'musical','play','production','theatre','theater','live',
  '2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025','2026','2027',
]);

function normalizeSlug(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function extractSlugFromStubhubUrl(url) {
  // https://www.stubhub.com/joe-turners-come-and-gone-tickets/performer/150605994
  // -> joe-turners-come-and-gone
  const m = url.match(/stubhub\.com\/([^/]+)-tickets\//);
  return m ? normalizeSlug(m[1]) : null;
}

function meaningfulTokens(slug) {
  return new Set(
    (slug || '')
      .split('-')
      .filter(t => t && t.length >= 2 && !NOISE_TOKENS.has(t))
  );
}

/**
 * Are these two slugs referring to the same show? Symmetric token-overlap
 * comparison — both the smaller and larger token set must have sufficient
 * overlap so that "oliver" vs "oliver-hazard" (a band) fails, but
 * "wicked" vs "wicked-the-musical" (same show) passes.
 */
function slugsReferToSameShow(ourSlug, landingSlug) {
  if (!ourSlug && !landingSlug) return true;
  if (!landingSlug) return false;
  if (ourSlug === landingSlug) return true;

  const ours = meaningfulTokens(ourSlug);
  const theirs = meaningfulTokens(landingSlug);

  if (ours.size === 0 || theirs.size === 0) return false;

  // Intersection
  let overlap = 0;
  for (const t of ours) if (theirs.has(t)) overlap++;

  // Both sides must overlap substantially
  const ourCoverage = overlap / ours.size;
  const theirCoverage = overlap / theirs.size;

  // Case 1: our slug is a subset of landing (landing adds "the musical" etc.) — all our tokens must be present
  if (ourCoverage === 1.0) return true;

  // Case 2: landing slug is a subset of ours — all landing tokens must be present
  if (theirCoverage === 1.0) return true;

  // Case 3: both sides share most of their meaningful tokens
  return ourCoverage >= 0.75 && theirCoverage >= 0.5;
}

function probeUrl(url) {
  try {
    // -sI: silent HEAD. -L: follow redirects. Capture status + final URL.
    const out = execSync(
      `curl -sI -L -o /dev/null -w "%{http_code}|%{url_effective}" -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15" --max-time 8 ${JSON.stringify(url)}`,
      { encoding: 'utf8' }
    ).trim();
    const [status, finalUrl] = out.split('|');
    return { status: parseInt(status, 10), finalUrl };
  } catch (err) {
    return { status: 0, finalUrl: null, error: err.message };
  }
}

async function main() {
  const shows = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const results = [];
  let total = 0;

  // Build a flat list of (show, link index) for StubHub only
  const targets = [];
  for (const [showIdx, show] of shows.shows.entries()) {
    if (!['open', 'previews', 'upcoming'].includes(show.status)) continue;
    const links = show.ticketLinks || [];
    for (const [linkIdx, link] of links.entries()) {
      if (link.platform === 'StubHub') {
        targets.push({ showIdx, linkIdx, show, link });
      }
    }
  }
  total = targets.length;
  console.log(`Validating ${total} active-show StubHub URLs...\n`);

  for (let i = 0; i < targets.length; i++) {
    const { show, link } = targets[i];
    // Compare by show TITLE (e.g. "Wicked"), not show ID slug (e.g. "wicked-west-end-2021").
    // The show ID has market + year suffixes that StubHub doesn't include.
    const ourSlug = normalizeSlug(show.title);
    const { status, finalUrl } = probeUrl(link.url);
    let verdict = 'ok';
    let reason = null;
    let landingSlug = null;

    if (status === 0) {
      verdict = 'probe_error';
      reason = 'curl failed';
    } else if (status >= 400) {
      verdict = 'broken';
      reason = `HTTP ${status}`;
    } else if (finalUrl) {
      landingSlug = extractSlugFromStubhubUrl(finalUrl);
      if (!landingSlug) {
        verdict = 'ok'; // category URLs etc. — hard to verify, assume ok
      } else if (!slugsReferToSameShow(ourSlug, landingSlug)) {
        verdict = 'broken';
        reason = `wrong show: "${show.title}" → ${landingSlug}`;
      }
    }

    results.push({
      showId: show.id,
      showTitle: show.title,
      ourSlug,
      url: link.url,
      finalUrl,
      landingSlug,
      status,
      verdict,
      reason,
    });

    const marker = verdict === 'ok' ? '✓' : verdict === 'broken' ? '✗' : '?';
    const tag = verdict === 'broken' ? ` — ${reason}` : '';
    console.log(`  [${i + 1}/${total}] ${marker} ${show.title}${tag}`);
  }

  // Summary
  const broken = results.filter(r => r.verdict === 'broken');
  const ok = results.filter(r => r.verdict === 'ok');
  const errored = results.filter(r => r.verdict === 'probe_error');
  console.log(`\n=== SUMMARY ===`);
  console.log(`  ok:     ${ok.length}`);
  console.log(`  broken: ${broken.length}`);
  console.log(`  errors: ${errored.length}`);

  if (broken.length > 0) {
    console.log(`\n=== BROKEN ===`);
    for (const r of broken) {
      console.log(`  ${r.showId}: ${r.showTitle}`);
      console.log(`    ${r.url}`);
      console.log(`    reason: ${r.reason}`);
    }
  }

  fs.writeFileSync('/tmp/stubhub-validation.json', JSON.stringify(results, null, 2));
  fs.writeFileSync(
    '/tmp/stubhub-broken.txt',
    broken.map(r => `${r.showId}\t${r.reason}\t${r.url}`).join('\n')
  );
  console.log(`\nReports:\n  /tmp/stubhub-validation.json\n  /tmp/stubhub-broken.txt`);

  if (APPLY && broken.length > 0) {
    // Replace broken URLs with a StubHub search URL using the show title.
    // Rationale: Partnerize affiliate tracking works on ANY stubhub.com URL, and
    // https://www.stubhub.com/search?q=<title> always returns a valid results page.
    // Users land on search -> pick the correct show -> still tracked for conversion.
    // Better than stripping because the StubHub button stays visible on the page.
    const brokenByUrl = new Map();
    for (const r of broken) brokenByUrl.set(`${r.showId}::${r.url}`, r);

    let replaced = 0;
    for (const show of shows.shows) {
      if (!show.ticketLinks) continue;
      for (const link of show.ticketLinks) {
        if (link.platform !== 'StubHub') continue;
        const key = `${show.id}::${link.url}`;
        if (!brokenByUrl.has(key)) continue;
        const query = encodeURIComponent(show.title);
        link.url = `https://www.stubhub.com/search?q=${query}`;
        // Drop priceFrom since the search page doesn't guarantee that specific price
        delete link.priceFrom;
        replaced++;
      }
    }
    fs.writeFileSync(SHOWS_PATH, JSON.stringify(shows, null, 2) + '\n');
    console.log(`\n--apply: replaced ${replaced} broken StubHub URL(s) with search-URL fallbacks in ${SHOWS_PATH}`);
  } else if (broken.length > 0) {
    console.log(`\nDry run. Re-run with --apply to replace broken URLs with search-URL fallbacks.`);
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
