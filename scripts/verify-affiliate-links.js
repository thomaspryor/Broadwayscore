#!/usr/bin/env node
'use strict';

/**
 * verify-affiliate-links.js — link integrity probe for the affiliate revenue
 * stream (affiliate hardening plan, 2026-08-03).
 *
 * Fetches a deterministic sample of LIVE production show pages and validates
 * every rendered Impact deep link against src/config/affiliate-platforms.json
 * via scripts/lib/affiliate-link-contract.js: correct publisher/campaign/
 * program IDs, u= decodes to a todaytix.com URL whose show ID matches the
 * page's todaytixId in shows.json, and links are present/absent according to
 * show status. This validates what the TS builder actually RENDERED — the
 * only check that catches a deploy-time regression in the real output.
 *
 * ── CRITICAL SAFETY RULE (plan-review User-Impact finding) ─────────────────
 * This script must NEVER request a pxf.io / evyy.net / sjv.io tracking URL.
 * Those are OUR OWN Impact tracking links; automated CI hits on them are
 * self-clicks that Impact's fraud systems may flag against the account this
 * whole revenue stream depends on. Link validation is offline parsing only;
 * the optional destination spot-check requests the DECODED todaytix.com URL
 * directly (no Impact involvement).
 *
 * Destination checks are best-effort: TodayTix may bot-block CI, so a block
 * reads as SKIP (never PASS — scraper memory: challenge pages return 200);
 * the caller-visible skip streak is watched by check-affiliate-health's
 * digest wiring via the result file.
 *
 * Runs: locally any time (node scripts/verify-affiliate-links.js), and weekly
 * as an ISOLATED job in weekly-affiliate-report.yml (its failure cannot block
 * the Monday report email).
 *
 * Usage:
 *   node scripts/verify-affiliate-links.js [--json] [--skip-destinations]
 *   node scripts/verify-affiliate-links.js --base=http://localhost:3000
 */

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help');
// hygiene-help-flag-ok: the fetch the auditor flags is inside fetchPage()'s
// DEFINITION (declared before main for readability) — nothing risky executes
// at module load; main() checks hasHelpFlag first (line ~196) before any work.
const { PLATFORMS, validateImpactLink, extractImpactLinks, parseImpactLink } = require('./lib/affiliate-link-contract');

const REPO_ROOT = path.join(__dirname, '..');
const RESULT_PATH = path.join(REPO_ROOT, 'data', 'audit', 'affiliate-link-probe.json');
const DEFAULT_BASE = 'https://broadwayscorecard.com';
const MAX_PAGES = 8;
const MAX_DESTINATION_CHECKS = 3;
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const USAGE = `verify-affiliate-links.js — validate rendered affiliate links on prod pages

Options:
  --base=URL            Site base (default ${DEFAULT_BASE})
  --json                Machine-readable output
  --skip-destinations   Skip the TodayTix destination spot-checks
  --dry-run             Don't write ${path.relative(REPO_ROOT, RESULT_PATH)}
  --help                This message

NEVER requests pxf.io/evyy.net/sjv.io tracking URLs (self-click fraud risk) —
destination checks hit the decoded todaytix.com URL only.`;

function loadShows() {
  const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data', 'shows.json'), 'utf8'));
  return Array.isArray(raw) ? raw : raw.shows || [];
}

function ticketUrls(show) {
  const urls = [];
  for (const t of show.ticketLinks || []) if (t && t.url) urls.push(String(t.url));
  if (show.todaytixUrl) urls.push(String(show.todaytixUrl));
  return urls;
}

function hasTodaytix(show) {
  return Boolean(show.todaytixId) || ticketUrls(show).some((u) => u.includes('todaytix.com'));
}

/**
 * Deterministic page sample: top-listed open Broadway shows (highest traffic,
 * where a broken link is most expensive), one WE, one OB, one closed show
 * (must NOT render buy links), sorted by id for stable selection.
 */
function selectSample(shows) {
  const withTT = shows.filter(hasTodaytix);
  const openOf = (pred) =>
    withTT
      .filter((s) => s.status === 'open' && pred(s))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const broadway = openOf((s) => (s.category || s.market) === 'broadway').slice(0, 2);
  const westEnd = openOf((s) => (s.category || s.market) === 'west-end').slice(0, 1);
  const offBroadway = openOf((s) => (s.category || s.market) === 'off-broadway').slice(0, 1);
  const closed = withTT
    .filter((s) => s.status === 'closed' && s.closingDate)
    .sort((a, b) => String(b.closingDate).localeCompare(String(a.closingDate)))
    .slice(0, 1);
  const sample = [...broadway, ...westEnd, ...offBroadway, ...closed].slice(0, MAX_PAGES);
  return sample.map((s) => ({
    id: s.id,
    slug: s.slug || s.id,
    status: s.status,
    todaytixId: s.todaytixId || null,
    expectLinks: s.status === 'open',
  }));
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });
  return { status: res.status, finalUrl: res.url, html: res.ok ? await res.text() : '' };
}

function checkPage(page, html) {
  const problems = [];
  const links = extractImpactLinks(html);
  let clientOnly = false;
  if (page.expectLinks && links.length === 0) {
    // The primary "Get Tickets" CTA is CLIENT-rendered (TicketButtonsAB
    // returns null until PostHog flags load), so static HTML only carries
    // pxf.io links when the ShowtimesCard has showtime data. A page with the
    // raw todaytix.com URL present still builds its affiliate link in the
    // browser — that's healthy (verified live on
    // a-walk-on-the-moon-off-broadway, 2026-08-03). Only a page with NO
    // TodayTix reference at all has actually lost its ticket data.
    if (/todaytix\.com/.test(html)) {
      clientOnly = true;
    } else {
      problems.push('open TodayTix-linked show renders no Impact links AND no todaytix.com reference — ticket data missing from page');
    }
  }
  if (!page.expectLinks && links.length > 0) {
    problems.push(`${page.status} show still renders ${links.length} Impact affiliate link(s)`);
  }
  const destinations = [];
  for (const link of links) {
    const parsed = parseImpactLink(link);
    // Identify which configured platform this link claims to be, by campaign id.
    const platformName = Object.entries(PLATFORMS).find(
      ([, cfg]) => cfg.type === 'impact' && cfg.impactCampaignId === (parsed && parsed.campaignId)
    )?.[0];
    if (!platformName) {
      problems.push(`link with unknown campaignId ${(parsed && parsed.campaignId) || '?'}: ${link.slice(0, 120)}`);
      continue;
    }
    const check = validateImpactLink(link, platformName);
    if (!check.ok) {
      problems.push(`${platformName}: ${check.problems.join('; ')} (${link.slice(0, 120)})`);
      continue;
    }
    const dest = check.parsed.destination || '';
    if (platformName === 'TodayTix') {
      if (!/todaytix\.com/.test(dest)) {
        problems.push(`TodayTix link destination is not todaytix.com: ${dest.slice(0, 120)}`);
      } else if (page.todaytixId) {
        // Deep links carry the show id either as /shows/{id}-slug or ?showId={id}.
        const idMatch = dest.match(/[?&]showId=(\d+)/) || dest.match(/\/shows\/(\d+)-/);
        if (idMatch && String(idMatch[1]) !== String(page.todaytixId)) {
          problems.push(`TodayTix destination showId ${idMatch[1]} != shows.json todaytixId ${page.todaytixId}: ${dest.slice(0, 140)}`);
        }
        if (idMatch) destinations.push(dest);
      }
    }
  }
  return { linksFound: links.length, clientOnly, problems, destinations };
}

/**
 * Destination spot-check — DECODED todaytix.com URLs only (see safety rule).
 * verdicts: ok | broken (404/homepage-redirect) | skipped (bot-block/timeout)
 */
async function checkDestination(dest) {
  try {
    const res = await fetch(dest, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404 || res.status === 410) return { dest, verdict: 'broken', detail: `HTTP ${res.status}` };
    const finalPath = new URL(res.url).pathname;
    if (res.ok && (finalPath === '/' || finalPath === '')) {
      return { dest, verdict: 'broken', detail: 'redirected to TodayTix homepage (dead deep link)' };
    }
    if (res.status === 403 || res.status === 429 || res.status === 503) {
      return { dest, verdict: 'skipped', detail: `bot-blocked (HTTP ${res.status})` };
    }
    return { dest, verdict: res.ok ? 'ok' : 'skipped', detail: `HTTP ${res.status}` };
  } catch (err) {
    return { dest, verdict: 'skipped', detail: err.message };
  }
}

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log(USAGE);
    return 0;
  }
  const argv = process.argv.slice(2);
  const base = (argv.find((a) => a.startsWith('--base=')) || `--base=${DEFAULT_BASE}`).slice(7).replace(/\/$/, '');
  const json = argv.includes('--json');
  const skipDest = argv.includes('--skip-destinations');
  const dryRun = argv.includes('--dry-run');

  const shows = loadShows();
  const sample = selectSample(shows);
  if (sample.length === 0) {
    console.error('No sample pages selected — shows.json has no TodayTix-linked shows?');
    return 1;
  }

  const results = [];
  const allDest = [];
  for (const page of sample) {
    const url = `${base}/show/${page.slug}`;
    try {
      const { status, html } = await fetchPage(url);
      if (status !== 200) {
        results.push({ ...page, url, verdict: 'error', problems: [`page fetch HTTP ${status}`], linksFound: 0 });
        continue;
      }
      const check = checkPage(page, html);
      results.push({ ...page, url, verdict: check.problems.length ? 'fail' : 'pass', ...check });
      allDest.push(...check.destinations);
    } catch (err) {
      results.push({ ...page, url, verdict: 'error', problems: [err.message], linksFound: 0 });
    }
  }

  let destChecks = [];
  if (!skipDest) {
    const targets = [...new Set(allDest)].slice(0, MAX_DESTINATION_CHECKS);
    for (const dest of targets) destChecks.push(await checkDestination(dest));
  }

  const failed = results.filter((r) => r.verdict === 'fail' || r.verdict === 'error');
  const brokenDest = destChecks.filter((d) => d.verdict === 'broken');
  const skippedDest = destChecks.filter((d) => d.verdict === 'skipped');
  const summary = {
    base,
    pagesChecked: results.length,
    pagesFailed: failed.length,
    destinationsChecked: destChecks.length,
    destinationsBroken: brokenDest.length,
    destinationsSkipped: skippedDest.length,
    allDestinationsSkipped: destChecks.length > 0 && skippedDest.length === destChecks.length,
    results,
    destChecks,
    updatedAt: new Date().toISOString(),
  };

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    for (const r of results) {
      const icon = r.verdict === 'pass' ? '✅' : '🔴';
      console.log(`${icon} ${r.slug.padEnd(45)} ${r.status.padEnd(9)} links=${r.linksFound}${r.problems && r.problems.length ? ' — ' + r.problems.join(' | ') : ''}`);
    }
    for (const d of destChecks) {
      const icon = d.verdict === 'ok' ? '✅' : d.verdict === 'broken' ? '🔴' : '⏭️';
      console.log(`${icon} dest ${d.verdict.padEnd(8)} ${d.detail.padEnd(40)} ${d.dest.slice(0, 100)}`);
    }
  }

  if (!dryRun) {
    fs.mkdirSync(path.dirname(RESULT_PATH), { recursive: true });
    fs.writeFileSync(RESULT_PATH, JSON.stringify(summary, null, 2) + '\n');
  }

  const hasFailure = failed.length > 0 || brokenDest.length > 0;
  if (hasFailure && !dryRun && process.env.CI) {
    // Failure IS actionable (broken revenue links) — route through the router,
    // never a raw email. Cooldown keeps a broken week from double-alerting
    // across the weekly run + any manual replays.
    const { routeAlert } = require('./lib/owner-alert-router');
    await routeAlert({
      conditionKey: 'affiliate:link-integrity',
      title: `Affiliate link integrity: ${failed.length} page(s) / ${brokenDest.length} destination(s) broken`,
      description:
        `verify-affiliate-links.js found problems on live production pages:\n` +
        failed.map((r) => `- ${r.slug}: ${(r.problems || []).join('; ')}`).join('\n') +
        brokenDest.map((d) => `\n- destination: ${d.detail} — ${d.dest}`).join('') +
        `\n\nEvery broken link is revenue leaking. Replay locally: node scripts/verify-affiliate-links.js`,
      hint: 'Compare the rendered link against src/config/affiliate-platforms.json; if the destination is dead, check fix-todaytix-links.yml output for the show.',
      severity: 'error',
      disposition: 'digest',
      cooldownHours: 72,
    });
  }

  console.log(`\n${failed.length} page failure(s), ${brokenDest.length} broken destination(s), ${skippedDest.length} skipped.`);
  // Exit non-zero on real failures so the isolated CI job goes red (its
  // redness cannot block the report job — separate job, no `needs`).
  return hasFailure ? 1 : 0;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error('verify-affiliate-links failed:', err.stack || err.message);
      process.exit(1);
    }
  );
}

module.exports = { selectSample, checkPage };
