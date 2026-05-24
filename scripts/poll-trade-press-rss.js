#!/usr/bin/env node
/**
 * Hourly Trade-Press RSS Poller — Recoupment Detection
 *
 * Polls trade-press RSS feeds (Variety Legit, Deadline) flagged
 * `trackRecoupment: true` in scripts/lib/rss-discovery.js. Detects new
 * recoupment announcements within ~1h of publish, vs. the Friday SERP
 * scraper's worst-case 7-day latency.
 *
 * Flow:
 *   1. For each tracked feed: fetch + parse, dedup by guid against state
 *   2. Reject items older than 60 days (Playbill-style SEO-republished evergreens)
 *   3. Pre-filter title+description against /recoup(ed|ment|s)?|earned back/i.
 *      NOT "paid off" (puff pieces) or "profit" (matches "non-profit").
 *   4. Match RSS title to a show in scope (opened 28-365d ago, not yet recouped)
 *      using titleMatchesShow from rss-discovery.js
 *   5. fetchPage + classifyArticle (shared lib). Gate on
 *      productionMatch === 'exact' AND confidence === 'high'.
 *   6. articleDate must be ≤ 14 days old (older = re-surfacing, not breaking news)
 *   7. Write to commercial-pending-review.json with detectedBy:'rss-poller'.
 *      Bump state.lastSeenGuid ONLY on pending-write success (transactional).
 *
 * apply-commercial-pending.js (run by commercial-rss-poll.yml right after this
 * script) auto-applies entries via:
 *   --auto-apply-claims-from=rss-poller,recoupment-announcement-scraper
 * which gates on detectedBy ∈ list AND confidence==='high' AND sourceHost ∈
 * TRUSTED_RECOUPMENT_HOSTS.
 *
 * Usage:
 *   node scripts/poll-trade-press-rss.js                  # default (1h window)
 *   node scripts/poll-trade-press-rss.js --window-hours=24
 *   node scripts/poll-trade-press-rss.js --feed=variety
 *   node scripts/poll-trade-press-rss.js --dry-run
 */

const fs = require('fs');
const path = require('path');

const { TRACK_RECOUPMENT_FEEDS, parseFeedItems, titleMatchesShow, fetchUrl } = require('./lib/rss-discovery');
const { fetchPage } = require('./lib/scraper');
const { classifyArticle } = require('./lib/recoupment-classify');
const { TRUSTED_RECOUPMENT_HOSTS } = require('./lib/trusted-recoupment-domains');

// ---- args ----
const args = process.argv.slice(2);
const flags = {};
for (const a of args) {
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    flags[k] = v === undefined ? true : v;
  }
}
const DRY_RUN = flags['dry-run'] === true;
const WINDOW_HOURS = parseInt(flags['window-hours'], 10) || 24;
const FEED_FILTER = flags['feed'] ? flags['feed'].split(',').map(s => s.trim()) : null;
const LLM_CALL_CAP = parseInt(flags['llm-cap'], 10) || 20;
// Test-only: bypass the candidate filter for one slug so the e2e chain can be
// exercised against a real RSS article for a show that's already recouped in
// commercial.json. Only effective with --dry-run.
const TEST_SHOW = flags['test-show'] || null;

// ---- constants ----
const RECOUP_REGEX = /recoup(ed|ment|s)?|earned back/i;
const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;
const ARTICLE_DATE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

// ---- paths (mirrors scrape-recoupment-announcements.js dataPath) ----
function dataPath(filename, { writable = false } = {}) {
  const local = path.join(__dirname, '..', 'data', filename);
  if (fs.existsSync(local)) return local;
  if (writable) return local;
  const mainRepo = path.join('/Users/tompryor/Broadwayscore/data', filename);
  if (fs.existsSync(mainRepo)) return mainRepo;
  return local;
}
const SHOWS_PATH = dataPath('shows.json');
const COMMERCIAL_PATH = dataPath('commercial.json');
const PENDING_PATH = dataPath('commercial-pending-review.json', { writable: true });
const STATE_PATH = dataPath('commercial-rss-state.json', { writable: true });

// ---- helpers ----
function log(...a) { console.log(...a); }
function loadJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}
function daysBetween(dateStr) {
  if (!dateStr) return Infinity;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000);
}

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return { version: 1, feeds: {} };
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch { return { version: 1, feeds: {} }; }
}
function writeState(state) {
  state.lastRunAt = new Date().toISOString();
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

function loadPending() {
  if (!fs.existsSync(PENDING_PATH)) return { shows: {}, lastUpdated: null };
  return loadJSON(PENDING_PATH);
}
function writePending(pending) {
  pending.lastUpdated = new Date().toISOString();
  fs.writeFileSync(PENDING_PATH, JSON.stringify(pending, null, 2) + '\n');
}

// ---- show candidate scope (mirrors Friday scraper) ----
const ENHANCEMENT_FRIENDLY_ORGS = new Set([
  'Lincoln Center Theater',
  'Manhattan Theatre Club',
  'Roundabout Theatre Company',
  'Second Stage Theater',
  'The Public Theater',
]);

function pickCandidates(allShows, commercial) {
  const shows = allShows.shows || allShows;
  const cMap = commercial.shows || {};
  return shows.filter(s => {
    const c = cMap[s.slug];
    if (c?.recouped === true) return false;
    if (c?.designation === 'Nonprofit' && !ENHANCEMENT_FRIENDLY_ORGS.has(c?.nonprofitOrg)) return false;
    const opened = s.openingDate || s.previewsStartDate;
    if (!opened) return false;
    const age = daysBetween(opened);
    if (age < 28 || age > 365) return false;
    if (!['open', 'closed', 'closing'].includes(s.status)) return false;
    if (s.market && s.market !== 'broadway') return false;
    return true;
  });
}

// ---- state diff (pure; tested in tests/unit/rss-poller-state.test.mjs) ----
/**
 * Given an item list (most-recent-first per feed convention) and a lastSeenGuid,
 * return items above the lastSeenGuid AND within the date window.
 *
 * - First-ever poll (no lastSeenGuid): return all items in window.
 * - lastSeenGuid present and found in list: return items before its position.
 * - lastSeenGuid present but NOT found (item aged out of feed): return all items
 *   in window (fail-open; the date window prevents over-emit).
 */
function diffNewItems(items, lastSeenGuid, windowMs = WINDOW_HOURS * 60 * 60 * 1000) {
  const cutoff = Date.now() - windowMs;
  let stopAt = items.length;
  if (lastSeenGuid) {
    const idx = items.findIndex(i => i.guid === lastSeenGuid);
    if (idx >= 0) stopAt = idx;
  }
  return items.slice(0, stopAt).filter(i => {
    if (!i.pubDate || isNaN(i.pubDate.getTime())) return false;
    if (Date.now() - i.pubDate.getTime() > SIXTY_DAYS_MS) return false;
    return i.pubDate.getTime() >= cutoff;
  });
}

// ---- matching: extract show match for an RSS item ----
function matchShow(rssTitle, rssDescription, candidates) {
  const haystack = `${rssTitle} ${rssDescription || ''}`;
  for (const show of candidates) {
    if (titleMatchesShow(haystack, show.title)) return show;
  }
  return null;
}

// ---- per-feed processing ----
async function processFeed(feed, state, candidates, counters) {
  const feedState = state.feeds[feed.outletId] || { lastSeenGuid: null, lastPolledAt: null, errorCount: 0 };
  log(`\n— ${feed.name} (${feed.outletId}) —`);
  log(`  lastSeenGuid: ${feedState.lastSeenGuid || '(first run)'}`);

  let items;
  try {
    const xml = await fetchUrl(feed.url, 15000);
    items = parseFeedItems(xml);
  } catch (e) {
    log(`  ✗ fetch error: ${e.message}`);
    feedState.errorCount = (feedState.errorCount || 0) + 1;
    feedState.lastError = e.message;
    state.feeds[feed.outletId] = feedState;
    return [];
  }

  // Reset error count on success
  feedState.errorCount = 0;
  feedState.lastError = null;

  const fresh = diffNewItems(items, feedState.lastSeenGuid);
  log(`  ${items.length} items parsed → ${fresh.length} new+in-window`);

  const matched = [];
  for (const item of fresh) {
    const hayTitle = item.title;
    const hayDesc = item.description || '';
    if (!RECOUP_REGEX.test(hayTitle) && !RECOUP_REGEX.test(hayDesc)) continue;
    const show = matchShow(hayTitle, hayDesc, candidates);
    if (!show) {
      log(`    skip (no show match): ${hayTitle.slice(0, 90)}`);
      continue;
    }
    if (counters.llmCalls >= LLM_CALL_CAP) {
      log(`    🛑 LLM call cap (${LLM_CALL_CAP}) hit — deferring "${hayTitle.slice(0, 60)}"`);
      // Don't bump lastSeenGuid past this item — next run picks it up.
      return { findings: matched, capHit: true, mostRecentGuid: items[0]?.guid };
    }
    log(`    🔎 match → ${show.slug} :: ${hayTitle.slice(0, 90)}`);
    let html;
    try {
      const fetched = await fetchPage(item.link, { timeout: 25_000 });
      html = typeof fetched === 'string' ? fetched : (fetched?.content || '');
    } catch (e) {
      log(`      ✗ fetch failed: ${e.message}`);
      continue;
    }
    counters.llmCalls++;
    const verdict = await classifyArticle(show.title, item.link, html);
    log(`      → recouped=${verdict.recouped} match=${verdict.productionMatch} conf=${verdict.confidence}`);
    if (verdict.evidence) log(`         "${String(verdict.evidence).slice(0, 140)}"`);

    if (!verdict.recouped) continue;
    if (verdict.productionMatch !== 'exact') continue;
    if (verdict.confidence !== 'high') continue;

    const host = hostnameOf(item.link);
    if (!TRUSTED_RECOUPMENT_HOSTS.has(host)) {
      log(`      ⏭️  ${host} not in TRUSTED_RECOUPMENT_HOSTS — skipping auto-apply path`);
      continue;
    }
    if (verdict.articleDate) {
      const articleAgeMs = Date.now() - new Date(verdict.articleDate).getTime();
      if (articleAgeMs > ARTICLE_DATE_MAX_AGE_MS) {
        log(`      ⏭️  article from ${verdict.articleDate} is >14d old — likely re-surfacing, skipping`);
        continue;
      }
    }

    matched.push({ show, url: item.link, host, verdict, rssItem: item });
  }

  return { findings: matched, capHit: false, mostRecentGuid: items[0]?.guid };
}

// ---- main ----
async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('FATAL: OPENAI_API_KEY not set');
    process.exit(1);
  }

  const allShows = loadJSON(SHOWS_PATH);
  const commercial = loadJSON(COMMERCIAL_PATH);
  let candidates = pickCandidates(allShows, commercial);
  if (TEST_SHOW && DRY_RUN) {
    const allShowsArr = allShows.shows || allShows;
    const testShow = allShowsArr.find(s => s.slug === TEST_SHOW);
    if (testShow && !candidates.find(s => s.slug === TEST_SHOW)) {
      log(`[--test-show=${TEST_SHOW}] bypassing candidate filter`);
      candidates = [...candidates, testShow];
    }
  }
  log(`RSS poller — ${candidates.length} candidate shows | window=${WINDOW_HOURS}h | dry-run=${DRY_RUN} | LLM cap=${LLM_CALL_CAP}`);

  const state = loadState();
  state.feeds = state.feeds || {};

  const feeds = TRACK_RECOUPMENT_FEEDS.filter(f => !FEED_FILTER || FEED_FILTER.includes(f.outletId));
  if (feeds.length === 0) {
    log(`No feeds to poll (filter=${FEED_FILTER ? FEED_FILTER.join(',') : 'none'})`);
    return;
  }

  const counters = { llmCalls: 0 };
  const allFindings = [];
  const feedResults = {};

  for (const feed of feeds) {
    const result = await processFeed(feed, state, candidates, counters);
    feedResults[feed.outletId] = result;
    for (const f of result.findings) allFindings.push(f);
  }

  log(`\n========== SUMMARY ==========`);
  log(`LLM calls: ${counters.llmCalls} / ${LLM_CALL_CAP}`);
  log(`Promotable findings: ${allFindings.length}`);
  for (const f of allFindings) {
    log(`  ✅ ${f.show.slug}: ${f.verdict.recoupedDate || 'date?'} (${f.host})`);
    log(`     ${f.url}`);
  }

  if (DRY_RUN) {
    log(`\n[dry-run] not writing to pending or state`);
    return;
  }

  // Write pending FIRST; bump state lastSeenGuid only on success (transactional).
  if (allFindings.length > 0) {
    const pending = loadPending();
    pending.shows = pending.shows || {};
    const now = new Date().toISOString();
    let written = 0;
    for (const f of allFindings) {
      pending.shows[f.show.slug] = {
        ...(pending.shows[f.show.slug] || {}),
        recouped: true,
        _recoupedClaim: true,
        recoupedDate: f.verdict.recoupedDate || null,
        recoupedSource: f.url,
        confidence: f.verdict.confidence,
        evidence: f.verdict.evidence || null,
        sourceHost: f.host,
        detectedBy: 'rss-poller',
        detectedAt: now,
        researchedAt: now,
        promoteRecommended: true,
      };
      written++;
    }
    writePending(pending);
    log(`\nWrote ${written} entries to ${path.relative(process.cwd(), PENDING_PATH)}`);
  }

  // Bump state per feed only if processing succeeded (no early return from cap).
  // capHit:true means we bailed mid-feed — leave lastSeenGuid alone so next run
  // retries those items.
  const nowIso = new Date().toISOString();
  for (const feed of feeds) {
    const result = feedResults[feed.outletId];
    const feedState = state.feeds[feed.outletId] || { lastSeenGuid: null, errorCount: 0 };
    feedState.lastPolledAt = nowIso;
    if (result && !result.capHit && result.mostRecentGuid) {
      feedState.lastSeenGuid = result.mostRecentGuid;
    }
    state.feeds[feed.outletId] = feedState;
  }
  writeState(state);
  log(`State written to ${path.relative(process.cwd(), STATE_PATH)}`);
}

// Export pure helpers for unit tests.
module.exports = { diffNewItems, matchShow, RECOUP_REGEX, SIXTY_DAYS_MS, ARTICLE_DATE_MAX_AGE_MS };

if (require.main === module) {
  main().catch(e => { console.error('FATAL', e); process.exit(1); });
}
