#!/usr/bin/env node
/**
 * send-opening-night-broadcast.js
 *
 * Creates a Resend DRAFT broadcast when a show opens and has enough reviews.
 * Owner logs into Resend, reviews the draft, and clicks Send manually.
 * Code never calls /broadcasts/{id}/send.
 *
 * Reads shows.json, reviews.json, critic-consensus.json, subscribers.json,
 * and opening-night-sent.json.
 *
 * Multiple shows opening the same night are coalesced into a single email.
 *
 * Usage: node scripts/send-opening-night-broadcast.js [--dry-run] [--lookback=DAYS] [--market=broadway|west-end] [--send-to=EMAIL] [--subject="..."]
 *
 * --send-to=EMAIL  Preview mode: send a single transactional email via Resend (not a broadcast/draft).
 *                  Use this to review the email rendering before a real draft is created.
 *
 * Env: RESEND_API_KEY, RESEND_BROADWAY_AUDIENCE_ID, RESEND_WE_AUDIENCE_ID, OWNER_EMAIL, DISCORD_WEBHOOK_ALERTS
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { routeAlert } = require('./lib/owner-alert-router');
const {
  postJSON, buildBroadcastOpeningNightHtml: buildBroadcastOpeningNightHtmlRaw, buildBroadcastSubjectLine, buildUnsubscribeUrl, siteNameForMarket,
} = require('./lib/email-templates');
const { applyUtm } = require('./lib/email-utm');
const { isLondonMarket } = require('./lib/venue-classification');

// Wrap the HTML builder so every send/draft path picks up GA4/PostHog UTM
// attribution (idempotent — see scripts/lib/email-utm.js). Campaign is the
// show set so opening-night traffic can be grouped per show in analytics.
function buildBroadcastOpeningNightHtml(shows, sendTo, market) {
  const html = buildBroadcastOpeningNightHtmlRaw(shows, sendTo, market);
  const campaign = `opening-${(shows || []).map(s => s.showId).filter(Boolean).join('-') || market}`;
  return applyUtm(html, { source: 'opening-night', campaign });
}
const { checkPreviewDedup } = require('./lib/preview-dedup');
const { acquireSendLock, releaseSendLock } = require('./lib/send-lock');

const { hasHelpFlag } = require('./lib/cli-help.js');
const { showFormatTitle } = require('./lib/show-format');

const USAGE = `send-opening-night-broadcast.js — Creates a Resend DRAFT broadcast when a show opens and has enough reviews.

Usage:
  node scripts/send-opening-night-broadcast.js [options]
  node scripts/send-opening-night-broadcast.js --help, -h    print this usage and exit
`;
const DRY_RUN = process.argv.includes('--dry-run');
const LOOKBACK_ARG = process.argv.find(a => a.startsWith('--lookback='));
const LOOKBACK_DAYS = LOOKBACK_ARG ? parseInt(LOOKBACK_ARG.split('=')[1], 10) : 2;
const MARKET_ARG = process.argv.find(a => a.startsWith('--market='));
const MARKET = MARKET_ARG ? MARKET_ARG.split('=')[1] : 'broadway'; // 'broadway' or 'west-end'
const SEND_TO_ARG = process.argv.find(a => a.startsWith('--send-to='));
const SEND_TO = SEND_TO_ARG ? SEND_TO_ARG.split('=')[1] : null; // Preview mode: send to single email only
// --shows=ID1,ID2,... — restrict broadcast to this exact set of show IDs.
// Used by opening-night-broadcast.yml to enforce its readiness gate (15+ reviews) which is
// stricter than this script's internal MIN_REVIEWS. Without this allow-list, a workflow run
// triggered for one ready show would re-discover and broadcast every other recently-opened
// show in the same market that meets only the looser internal threshold.
const SHOWS_ARG = process.argv.find(a => a.startsWith('--shows='));
const ALLOWED_SHOW_IDS = SHOWS_ARG ? new Set(SHOWS_ARG.split('=')[1].split(',').map(s => s.trim()).filter(Boolean)) : null;
// --recreate-draft: delete the old Resend draft (if any) and create a fresh one.
// Use this after fixing a bug in the email template — clears completed flag so the script
// doesn't bail with "already broadcast". Safe: only creates a draft, never calls /send.
const RECREATE_DRAFT = process.argv.includes('--recreate-draft');
// --force-create-draft: bypass the readiness gate (MIN_REVIEWS / MIN_T1 / MIN_T2 / MIN_HIGH_CONFIDENCE).
// Always combine with --shows= to target a specific show. Still draft-only — never calls /send.
// For revivals or niche shows where T1 outlets are unlikely to cover; owner manually reviews the
// draft in Resend UI and decides whether to send.
const FORCE_CREATE_DRAFT = process.argv.includes('--force-create-draft');
// --subject="..." — override the generated subject line for this run. For one-off wording
// (return engagements, transfers) without touching the shared template. Applies to both the
// draft and the [PREVIEW] variant, and still passes the FORBIDDEN_SUBJECT_WORDS safety check.
const SUBJECT_ARG = process.argv.find(a => a.startsWith('--subject='));
const SUBJECT_OVERRIDE = SUBJECT_ARG ? SUBJECT_ARG.split('=').slice(1).join('=').trim() : null;

const DATA_DIR = path.join(__dirname, '..', 'data');
const SHOWS_PATH = path.join(DATA_DIR, 'shows.json');
const REVIEWS_PATH = path.join(DATA_DIR, 'reviews.json');
const CONSENSUS_PATH = path.join(DATA_DIR, 'critic-consensus.json');
const SUBSCRIBERS_PATH = path.join(DATA_DIR, isLondonMarket(MARKET) ? 'subscribers-westend.json' : 'subscribers.json');
const SENT_PATH = path.join(DATA_DIR, 'opening-night-sent.json');
const EXPRESS_COMPLETED_PATH = path.join(DATA_DIR, 'audit', 'opening-night-express-completed.json');

const MOBILE_SHOWS_PATH = path.join(__dirname, '..', 'public', 'data', 'mobile-shows.json');
const OUTLET_REGISTRY_PATH = path.join(DATA_DIR, 'outlet-registry.json');
const FROM_EMAIL = 'updates@broadwayscorecard.com';
const SITE_NAME = siteNameForMarket(MARKET);
// WE has ~15 reliable outlets vs Broadway's 40+; median WE show gets 10 scored reviews
const MIN_REVIEWS = isLondonMarket(MARKET) ? 8 : 12;
const MIN_T1_REVIEWS = 3;
const MIN_T2_REVIEWS = isLondonMarket(MARKET) ? 2 : 3;
const MIN_HIGH_CONFIDENCE = isLondonMarket(MARKET) ? 6 : 8;


function loadJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function saveSentData(data) {
  try {
    fs.writeFileSync(SENT_PATH, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`ERROR: Failed to save sent-tracking data to ${SENT_PATH}: ${err.message}`);
    console.error('WARNING: Sent-tracking state may be lost — risk of duplicate sends on next run');
  }
}

/**
 * Pure merge helper — exposed for unit tests. Remote entries are preserved, local
 * entries win on conflict (the CLI just sent, so its entries are newest).
 */
function mergeTrackerEntries(remoteParsed, localParsed) {
  const merged = { ...(remoteParsed || {}) };
  if (!merged.shows) merged.shows = {};
  const localShows = (localParsed && localParsed.shows) || {};
  for (const [k, v] of Object.entries(localShows)) {
    merged.shows[k] = v;
  }
  return merged;
}

/**
 * Push data/opening-night-sent.json to origin/main via the GitHub Contents API.
 *
 * Why: when the script is invoked from a local shell (e.g. manual CLI preview), it
 * writes the tracker to disk but the running-in-CI workflow reads origin/main. Without
 * a sync step, the workflow can't see the CLI write and will double-send on its next
 * run. This is what caused the 2026-04-11 duplicate-preview incident (CLI sent at
 * 02:09 UTC but never committed; workflow fired at 12:21 UTC reading stale origin).
 *
 * Strategy: fetch the current file from origin/main, parse it, merge in our in-memory
 * entries (CLI write wins on conflict — the CLI just sent, so our entries are newest),
 * PUT back with the fetched sha. If the sha is stale due to concurrent write, retry
 * once with a fresh fetch.
 *
 * Skipped when:
 *   - Running in GitHub Actions (the workflow commits separately).
 *   - DRY_RUN (never write to origin).
 *   - `gh` CLI is missing or the user isn't authenticated (logged loudly).
 *
 * Exits non-zero on failure after one retry, so the user knows dedup is at risk.
 */
function syncTrackerToOrigin(localData) {
  if (process.env.GITHUB_ACTIONS === 'true') {
    // Workflow's dedicated commit step handles this path.
    return;
  }
  if (DRY_RUN) return;

  // Check gh is available and authed.
  try {
    execSync('gh auth status', { stdio: 'ignore' });
  } catch {
    console.error('\nWARNING: `gh` CLI missing or not authenticated — cannot sync opening-night-sent.json to origin.');
    console.error('         The next workflow run will not see this preview send. Run `gh auth login`, then manually');
    console.error('         push data/opening-night-sent.json to main, or live with a possible duplicate.');
    process.exitCode = 1;
    return;
  }

  const REPO = 'thomaspryor/Broadwayscore';
  const REMOTE_PATH = 'data/opening-night-sent.json';
  const BRANCH = 'main';

  const fetchRemote = () => {
    // gh api errors (incl. 404) throw; treat 404 as "file doesn't exist yet".
    try {
      const raw = execSync(
        `gh api repos/${REPO}/contents/${REMOTE_PATH}?ref=${BRANCH}`,
        { encoding: 'utf8' }
      );
      const meta = JSON.parse(raw);
      const content = Buffer.from(meta.content, 'base64').toString('utf8');
      let parsed = {};
      try { parsed = JSON.parse(content); } catch { parsed = {}; }
      return { sha: meta.sha, parsed };
    } catch (err) {
      if (String(err.stderr || err.message || '').includes('404')) {
        return { sha: null, parsed: { shows: {} } };
      }
      throw err;
    }
  };

  const putRemote = (sha, parsed) => {
    const content = Buffer.from(JSON.stringify(parsed, null, 2) + '\n', 'utf8').toString('base64');
    const payload = {
      message: 'data: Sync opening-night-sent tracking from CLI preview',
      content,
      branch: BRANCH,
    };
    if (sha) payload.sha = sha;
    // Write payload via stdin so the filename doesn't leak into shell expansion.
    const tmpPath = path.join(require('os').tmpdir(), `ons-${Date.now()}.json`);
    fs.writeFileSync(tmpPath, JSON.stringify(payload));
    try {
      execSync(
        `gh api --method PUT repos/${REPO}/contents/${REMOTE_PATH} --input ${JSON.stringify(tmpPath)}`,
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
    } finally {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  };

  const attempt = () => {
    const remote = fetchRemote();
    const merged = mergeTrackerEntries(remote.parsed, localData);
    putRemote(remote.sha, merged);
  };

  try {
    attempt();
    console.log(`  Synced opening-night-sent.json to origin/${BRANCH} via gh api`);
  } catch (err) {
    const msg = String(err.stderr || err.message || '');
    // Retry once on sha conflict (409/422) — remote may have changed between fetch and PUT.
    if (msg.includes('409') || msg.includes('422') || msg.includes('sha')) {
      console.error(`  Sync retry after remote conflict: ${msg.trim().slice(0, 200)}`);
      try {
        attempt();
        console.log(`  Synced opening-night-sent.json to origin/${BRANCH} (after retry)`);
        return;
      } catch (err2) {
        console.error(`\nWARNING: Sync retry failed: ${(err2.stderr || err2.message || '').toString().trim().slice(0, 300)}`);
      }
    } else {
      console.error(`\nWARNING: Failed to sync opening-night-sent.json to origin: ${msg.trim().slice(0, 300)}`);
    }
    console.error('         The next workflow run may not see this preview and could duplicate the send.');
    process.exitCode = 1;
  }
}

/**
 * Find shows that opened within the last N days.
 */
function findRecentlyOpenedShows(shows, lookbackDays) {
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - lookbackDays);
  cutoff.setHours(0, 0, 0, 0);

  return shows.filter(s => {
    if (s.status !== 'open' || !s.openingDate) return false;
    // Opera shows: skip broadcast entirely. Broadway subscribers did not opt in
    // to opera coverage; treating an opera opening as a Broadway broadcast would
    // be perceived as off-topic spam by ~160 subscribers. Proper Resend audience
    // segmentation is a separate card; until then, fail-closed.
    if (s.type === 'opera') return false;
    // Filter by market
    if (isLondonMarket(MARKET)) {
      // True West End only. isLondonMarket(category) is TRUE for off-west-end,
      // so gating on it would sweep OWE openings (Globe/fringe/kids shows) into
      // a WE broadcast — WE subscribers did not opt into off-West-End, exactly
      // as Broadway excludes off-broadway below. Require the exact category.
      if (s.category !== 'west-end') return false;
    } else {
      // Broadway: exclude off-broadway, regional (non-NYC US tryouts), and London markets.
      // Regional already carries market:'regional' so it fails the broadway-only gates,
      // but exclude by category here too — Broadway subscribers did not opt into regional.
      if (s.category === 'off-broadway' || s.category === 'regional' || isLondonMarket(s.category)) return false;
    }
    const d = new Date(s.openingDate);
    d.setHours(0, 0, 0, 0);
    return d >= cutoff && d <= now;
  });
}

/**
 * Count scored reviews and compute rave/positive/mixed/negative for a show.
 * 4-tier breakdown matching the live site's ScoreBreakdownBar.getBreakdownTier:
 *   - Rounds score before comparing (a 69.6 displays as 70, so it's Positive)
 *   - Rave: >=83 Broadway, >=85 West End
 *   - Positive: >=70
 *   - Mixed: >=55
 *   - Negative: <55
 * Keep in sync with src/components/show-cards/ScoreBreakdownBar.tsx.
 */
function getReviewStats(reviews, showId, market) {
  const showReviews = (reviews || []).filter(r => r.showId === showId && Number.isFinite(r.assignedScore));
  const goldThreshold = isLondonMarket(market) ? 85 : 83;
  let rave = 0, positive = 0, mixed = 0, negative = 0;

  for (const r of showReviews) {
    const rounded = Math.round(r.assignedScore);
    if (rounded >= goldThreshold) rave++;
    else if (rounded >= 70) positive++;
    else if (rounded >= 55) mixed++;
    else negative++;
  }

  return {
    reviewCount: showReviews.length,
    rave,
    positive,
    mixed,
    negative,
  };
}

/**
 * Build the Resend broadcast `name` (internal label, NOT subscriber-facing).
 * Resend rejects names over 70 chars (HTTP 422). List titles when they fit;
 * otherwise fall back to a count summary so any number of coalesced shows is safe.
 * Pure + exported for unit testing.
 */
const RESEND_NAME_MAX = 70;
function buildBroadcastName(siteName, shows) {
  const titles = (shows || []).map(s => s.showTitle).filter(Boolean);
  const prefix = `${siteName} opening night`;
  const full = titles.length ? `${prefix} — ${titles.join(', ')}` : prefix;
  if (full.length <= RESEND_NAME_MAX) return full;
  const summary = `${prefix} — ${titles.length} shows`;
  // Last-resort guard: even the summary must fit (very long siteName).
  return summary.length <= RESEND_NAME_MAX ? summary : summary.slice(0, RESEND_NAME_MAX);
}

async function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const RESEND_API_KEY = process.env.RESEND_API_KEY;

  if (!RESEND_API_KEY && !DRY_RUN) {
    console.log('Missing RESEND_API_KEY — skipping draft creation');
    process.exit(0);
  }

  console.log(`Opening Night Broadcast (${MARKET})`);
  console.log('=======================\n');
  if (DRY_RUN) console.log('** DRY RUN — no drafts will be created **\n');

  // Load data
  const showsData = loadJSON(SHOWS_PATH);
  if (!showsData) { console.error('Cannot load shows.json'); process.exit(1); }
  const showsArr = showsData.shows || showsData;
  const showsList = Array.isArray(showsArr) ? showsArr : Object.values(showsArr);

  const reviewsData = loadJSON(REVIEWS_PATH);
  const reviews = reviewsData ? (reviewsData.reviews || reviewsData) : [];
  const reviewsArr = Array.isArray(reviews) ? reviews : Object.values(reviews);

  const consensus = loadJSON(CONSENSUS_PATH) || {};

  if (SEND_TO) {
    console.log(`** PREVIEW MODE — sending to ${SEND_TO} only (transactional, not a draft) **\n`);
  } else {
    const subscribersData = loadJSON(SUBSCRIBERS_PATH);
    const subCount = subscribersData?.subscribers?.length || 0;
    console.log(`Subscribers in local file: ${subCount}`);
    console.log(`Mode: Resend DRAFT — owner reviews and sends manually from Resend UI`);
  }

  // Load or init sent tracking
  let sentData = loadJSON(SENT_PATH);
  if (!sentData || !sentData.shows) {
    sentData = { shows: {} };
  }

  // Find recently opened shows
  let recentlyOpened = findRecentlyOpenedShows(showsList, LOOKBACK_DAYS);
  if (recentlyOpened.length === 0) {
    console.log('No recently opened shows — nothing to broadcast');
    process.exit(0);
  }

  // Apply --shows allow-list (if provided). The workflow uses this to enforce its
  // stricter readiness gate (15+ scored reviews) — see SHOWS_ARG comment above.
  if (ALLOWED_SHOW_IDS) {
    const before = recentlyOpened.length;
    recentlyOpened = recentlyOpened.filter(s => ALLOWED_SHOW_IDS.has(s.id || s.slug));
    console.log(`--shows allow-list: ${recentlyOpened.length}/${before} shows passed (allowed: ${[...ALLOWED_SHOW_IDS].join(',')})`);
    if (recentlyOpened.length === 0) {
      console.log('No allowed shows match recently opened set — nothing to broadcast');
      process.exit(0);
    }
  }

  console.log(`Found ${recentlyOpened.length} recently opened show(s):`);
  for (const s of recentlyOpened) {
    console.log(`  - ${s.title} (${s.id}) opened ${s.openingDate}`);
  }

  // Filter out already-completed broadcasts — applies in BOTH broadcast and preview mode.
  // In preview mode, there's no reason to keep re-previewing a show whose full broadcast
  // has already been sent (completed:true). This prevents repeated preview spam when a
  // newly-opened show with 0 reviews keeps the workflow running alongside a completed show.
  // --recreate-draft bypasses this gate so a corrected draft can replace a bad one.
  // Exception: reconcile-broadcast-state.js may set draftStatus='cancelled'|'deleted'. If
  // the drafting-cycle has aged past REQUEUE_AFTER_HOURS, shouldRequeueShow re-opens the
  // slot so the next run can create a fresh draft. See scripts/lib/broadcast-state.js.
  const { shouldRequeueShow } = require('./lib/broadcast-state');
  const pendingShows = recentlyOpened.filter(s => {
    const showId = s.id || s.slug;
    const individualSent = sentData.shows[showId];
    if (!individualSent) return true;
    if (RECREATE_DRAFT) return true;
    if (shouldRequeueShow(individualSent)) {
      if (individualSent.completed) {
        console.log(`  Re-queueing ${s.title} — draft ${individualSent.draftStatus} at ${individualSent.draftCreatedAt}`);
      }
      return true;
    }
    if (individualSent.completed) {
      console.log(`  Skipping ${s.title} — already broadcast (completed)`);
      return false;
    }
    return true;
  });

  if (pendingShows.length === 0) {
    console.log('\nAll recently opened shows already broadcast — nothing to do');
    process.exit(0);
  }

  // Load outlet registry for tier-weighted scoring and readiness checks
  const outletRegistry = loadJSON(OUTLET_REGISTRY_PATH) || {};
  const outlets = outletRegistry.outlets || outletRegistry;

  function getOutletTier(outletId) {
    const entry = outlets[outletId];
    return (entry && entry.tier) || 3; // Default to Tier 3
  }

  // Load Express completion record — written by opening-night-express.yml after rebuild.
  // Used for operator visibility: logs whether Express ran clean for each show.
  const expressCompleted = loadJSON(EXPRESS_COMPLETED_PATH) || { shows: {} };
  function getExpressRecord(showId) {
    const rec = expressCompleted.shows?.[showId];
    if (!rec) return null;
    const ageMs = Date.now() - new Date(rec.completedAt).getTime();
    return ageMs < 36 * 60 * 60 * 1000 ? rec : null; // stale after 36h
  }

  // Check readiness: 12+ total, 3+ T1, 3+ T2
  const readyShows = [];
  for (const show of pendingShows) {
    const showId = show.id || show.slug;
    const expressRec = getExpressRecord(showId);
    if (expressRec) {
      console.log(`  ℹ️  Express completed for ${showId} at ${expressRec.completedAt} (${expressRec.scoredCount}/${expressRec.reviewCount} scored, run ${expressRec.runId})`);
    } else {
      console.warn(`  ⚠️  Express not used for ${showId} — proceeding with standard readiness gate (pipeline data quality unverified by Express)`);
    }
    const stats = getReviewStats(reviewsArr, showId, MARKET);
    const showReviews = reviewsArr.filter(r => r.showId === showId && r.assignedScore != null);
    const t1Count = showReviews.filter(r => getOutletTier(r.outletId) === 1).length;
    const t2Count = showReviews.filter(r => getOutletTier(r.outletId) === 2).length;
    const t3Count = showReviews.filter(r => getOutletTier(r.outletId) === 3).length;

    // Count high-confidence reviews (full-text scored, not excerpt-only)
    const highConfCount = showReviews.filter(r => r.scoreConfidence === 'high' || r.scoreConfidence === 'medium').length;

    const totalOk = stats.reviewCount >= MIN_REVIEWS;
    const t1Ok = t1Count >= MIN_T1_REVIEWS;
    const t2Ok = t2Count >= MIN_T2_REVIEWS;
    const confOk = highConfCount >= MIN_HIGH_CONFIDENCE;

    if (totalOk && t1Ok && t2Ok && confOk) {
      readyShows.push({ show, stats, t1Count, t2Count, t3Count });
      console.log(`  ✅ ${show.title}: ${stats.reviewCount} reviews (T1:${t1Count} T2:${t2Count} T3:${t3Count}, hi-conf:${highConfCount})`);
    } else if (FORCE_CREATE_DRAFT) {
      readyShows.push({ show, stats, t1Count, t2Count, t3Count });
      const reasons = [];
      if (!totalOk) reasons.push(`${stats.reviewCount}/${MIN_REVIEWS} total`);
      if (!t1Ok) reasons.push(`T1:${t1Count}/${MIN_T1_REVIEWS}`);
      if (!t2Ok) reasons.push(`T2:${t2Count}/${MIN_T2_REVIEWS}`);
      if (!confOk) reasons.push(`hi-conf:${highConfCount}/${MIN_HIGH_CONFIDENCE}`);
      console.log(`  ⚠️  ${show.title}: gate failed (${reasons.join(', ')}) — bypassed by --force-create-draft. Draft will be created for manual review.`);
    } else {
      const reasons = [];
      if (!totalOk) reasons.push(`${stats.reviewCount}/${MIN_REVIEWS} total`);
      if (!t1Ok) reasons.push(`T1:${t1Count}/${MIN_T1_REVIEWS}`);
      if (!t2Ok) reasons.push(`T2:${t2Count}/${MIN_T2_REVIEWS}`);
      if (!confOk) reasons.push(`hi-conf:${highConfCount}/${MIN_HIGH_CONFIDENCE}`);
      console.log(`  ⏳ ${show.title}: Not ready — ${reasons.join(', ')} (T1:${t1Count} T2:${t2Count} T3:${t3Count}, hi-conf:${highConfCount})`);
    }
  }

  if (readyShows.length === 0) {
    console.log(`\nNo shows are ready for broadcast (need ${MIN_REVIEWS}+ reviews, ${MIN_T1_REVIEWS}+ T1, ${MIN_T2_REVIEWS}+ T2, ${MIN_HIGH_CONFIDENCE}+ high-confidence)`);
    process.exit(0);
  }

  // Load pre-computed scores from the per-show public JSON files (same files the website serves).
  // These are always in sync with the live site since they're generated by the same rebuild.
  // Previously used mobile-shows.json which could be stale (caused Dog Day email to show wrong data).
  const showJsonDir = path.join(__dirname, '..', 'public', 'data', 'shows');
  const showJsonMap = new Map();
  for (const { show: s } of readyShows) {
    const showId = s.id || s.slug;
    const jsonPath = path.join(showJsonDir, `${showId}.json`);
    try {
      showJsonMap.set(showId, JSON.parse(fs.readFileSync(jsonPath, 'utf8')));
    } catch { /* file may not exist yet */ }
  }

  // Build show data for email template
  const showsForEmail = readyShows.map(({ show, stats }) => {
    const showId = show.id || show.slug;
    const consensusShows = consensus.shows || consensus;
    const showConsensus = consensusShows[showId] || consensusShows[show.slug];
    const consensusText = showConsensus?.text || showConsensus?.consensus || null;

    // Use pre-computed score from per-show public JSON (same as live site)
    const showJson = showJsonMap.get(showId);
    const score = showJson?.cs ?? null;
    const reviewCount = showJson?.rc ?? stats.reviewCount;

    // Show image — prefer per-show JSON image, fall back to shows.json
    const heroImg = showJson?.hi;
    let imageUrl = null;
    if (heroImg) {
      imageUrl = heroImg.startsWith('http') ? heroImg : `https://broadwayscorecard.com${heroImg}`;
    } else {
      const imagePath = show.images?.thumbnail || show.images?.poster || show.images?.hero;
      imageUrl = imagePath
        ? (imagePath.startsWith('http') ? imagePath : `https://broadwayscorecard.com${imagePath}`)
        : null;
    }

    return {
      showTitle: show.title,
      score,
      reviewCount,
      rave: stats.rave,
      positive: stats.positive,
      mixed: stats.mixed,
      negative: stats.negative,
      consensusText,
      showType: showFormatTitle(show.type),
      venue: show.venue,
      showUrl: `https://broadwayscorecard.com/show/${show.slug || showId}`,
      imageUrl,
      showId,
    };
  });

  console.log(`\n${readyShows.length} show(s) ready for broadcast:`);
  for (const s of showsForEmail) {
    console.log(`  - ${s.showTitle}: score ${s.score || 'TBD'}, ${s.reviewCount} reviews`);
  }

  // Warn if any show is missing consensus — critic-consensus.json may not be generated yet.
  // The email will still be created, but without the Critics' Take section. If consensus
  // arrives later, use --recreate-draft to replace the draft with a complete version.
  const missingConsensus = showsForEmail.filter(s => !s.consensusText);
  if (missingConsensus.length > 0) {
    console.warn(`\n⚠️  Missing Critics' Take for: ${missingConsensus.map(s => s.showTitle).join(', ')}`);
    console.warn(`   critic-consensus.json may not be generated yet.`);
    console.warn(`   Continuing — email will send without Critics' Take.`);
    console.warn(`   Once consensus is available, run again with --recreate-draft to replace this draft.`);
  }

  // Build subject line — kept clean (no [PREVIEW] tag) so it's safe to reuse for the
  // actual subscriber broadcast. The preview-only subject is derived separately below
  // and is only used when we call the Resend single-recipient /emails endpoint.
  const subject = SUBJECT_OVERRIDE || buildBroadcastSubjectLine(showsForEmail, MARKET);
  if (SUBJECT_OVERRIDE) console.log(`Subject override active (--subject)`);

  // Preview-only subject — prefixed so the owner can tell it apart from the real broadcast
  // in their inbox. NEVER used for the actual subscriber send (which uses `subject` above).
  const previewSubject = `[PREVIEW] ${subject}`;

  console.log(`\nSubject: ${subject}`);

  // Check if already broadcast
  const broadcastKey = `${MARKET}:` + showsForEmail.map(s => s.showId).sort().join('+');
  const previousSent = sentData.shows[broadcastKey];

  // --recreate-draft: delete the old Resend draft and clear the sent record so we proceed fresh.
  // Skipped under --dry-run: the delete is a LIVE Resend API call and saveSentData mutates
  // tracked state — neither belongs in a dry run (found 2026-07-05: dry-run cleared records).
  if (RECREATE_DRAFT && previousSent && DRY_RUN) {
    console.log(`\n[DRY RUN] Would delete old draft ${previousSent.draftId || '(none)'} and clear sent records`);
  }
  if (RECREATE_DRAFT && previousSent && !DRY_RUN) {
    if (previousSent.draftId) {
      console.log(`\n--recreate-draft: deleting old draft ${previousSent.draftId}...`);
      try {
        const { default: https } = await import('https');
        await new Promise((resolve, reject) => {
          const req = https.request({
            hostname: 'api.resend.com',
            path: `/broadcasts/${previousSent.draftId}`,
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${RESEND_API_KEY}` },
          }, res => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
              if (res.statusCode >= 200 && res.statusCode < 300) {
                console.log(`  Old draft deleted from Resend`);
                resolve();
              } else {
                console.warn(`  Could not delete old draft (${res.statusCode}: ${body.slice(0, 100)}) — continuing anyway`);
                resolve();
              }
            });
          });
          req.on('error', err => { console.warn(`  Delete request failed: ${err.message} — continuing`); resolve(); });
          req.end();
        });
      } catch (err) {
        console.warn(`  Could not delete old draft: ${err.message} — continuing`);
      }
    }
    // Clear all sent records for this broadcast so the script treats it as new
    delete sentData.shows[broadcastKey];
    for (const s of showsForEmail) {
      if (sentData.shows[s.showId]?.broadcastKey === broadcastKey) {
        delete sentData.shows[s.showId];
      }
    }
    saveSentData(sentData);
    console.log(`  Sent records cleared — creating fresh draft`);
  }

  if (previousSent?.completed && !SEND_TO && !RECREATE_DRAFT) {
    console.log('Broadcast already completed for this show combination — nothing to do');
    process.exit(0);
  }

  if (DRY_RUN) {
    console.log(`\n[DRY RUN] Would create Resend draft for ${MARKET}`);
    const html = buildBroadcastOpeningNightHtml(showsForEmail, null, MARKET);
    console.log(`Email HTML length: ${html.length} chars`);
    console.log('Has Resend unsubscribe variable:', html.includes('{{{RESEND_UNSUBSCRIBE_URL}}}'));
    console.log('Has score card:', html.includes('font-size:32px'));
    process.exit(0);
  }

  if (SEND_TO) {
    // Preview mode: send single transactional email (with custom unsubscribe link).
    //
    // Dedup lives in scripts/lib/preview-dedup.js — scans every tracked
    // preview:{market}:{showId}:* entry, picks the most recent, applies a rolling
    // 24h window + 3-new-review threshold. Previously this was a UTC-date-keyed
    // lookup that double-sent at UTC rollover (incident 2026-04-11 02:09 UTC —
    // 10:09 PM ET — a second preview re-sent because its key was
    // ...:2026-04-11 instead of ...:2026-04-10).
    const currentReviewCount = showsForEmail.reduce((sum, s) => sum + s.reviewCount, 0);
    const dedup = checkPreviewDedup(sentData, broadcastKey, currentReviewCount);

    if (dedup.action === 'skip') {
      const prev = dedup.lastPreview;
      console.log(`\nPreview already sent ${dedup.hoursSince.toFixed(1)}h ago for this show combination — skipping`);
      console.log(`  Previous preview: ${prev.sentAt} (${prev.reviewCount || 0} reviews, sent to ${prev.previewTo || 'unknown'})`);
      console.log(`  Current: ${currentReviewCount} reviews (+${dedup.newReviews}, need +3 to re-send within 24h)`);
      process.exit(0);
    }
    if (dedup.action === 'resend') {
      const prev = dedup.lastPreview;
      console.log(`\nRe-sending preview — ${dedup.newReviews} new reviews since last preview ${dedup.hoursSince.toFixed(1)}h ago (${prev.reviewCount || 0} → ${currentReviewCount})`);
    }

    console.log(`\nSending preview to ${SEND_TO}...`);
    const html = buildBroadcastOpeningNightHtml(showsForEmail, SEND_TO, MARKET);

    // Build unsubscribe URL for List-Unsubscribe header (RFC 8058)
    // Must point to /api/unsubscribe (handles POST) — NOT /unsubscribe (GET-only client page)
    const unsubUrl = `https://broadwayscorecard.com/api/unsubscribe?email=${encodeURIComponent(SEND_TO)}${MARKET === 'west-end' ? '&market=west-end' : ''}`;

    // Acquire cross-session send lock BEFORE calling Resend. Closes the narrow
    // race where a concurrent CLI or workflow run could double-send between
    // dedup check and network call. See scripts/lib/send-lock.js for details.
    const lock = acquireSendLock({
      purpose: `${MARKET}-preview-${broadcastKey.replace(`${MARKET}:`, '')}`,
    });
    if (!lock.acquired) {
      console.error(`\nSEND LOCK REFUSED: ${lock.reason}`);
      console.error('Another session is currently sending, or recently sent, for this path.');
      console.error('Not sending. Retry in a minute if you still need the preview.');
      process.exit(1);
    }
    console.log(`  Send lock acquired: ${lock.sessionId.slice(0, 8)} (expires ${lock.expiresAt})`);

    try {
      await postJSON('https://api.resend.com/emails', {
        from: `${SITE_NAME} <${FROM_EMAIL}>`,
        to: [SEND_TO],
        subject: previewSubject,
        html,
        headers: {
          'List-Unsubscribe': `<${unsubUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      }, {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
      });
      console.log(`Preview sent to ${SEND_TO}`);
    } catch (err) {
      console.error(`ERROR sending preview: ${err.message}`);
      // Best-effort release before bailing.
      const rel = releaseSendLock(lock);
      if (!rel.released) console.error(`  (lock release note: ${rel.reason})`);
      process.exit(1);
    }

    // Release the lock on success.
    const rel = releaseSendLock(lock);
    if (!rel.released) console.error(`  WARNING: lock release failed: ${rel.reason}`);
    else console.log(`  Send lock released`);
  } else {
    // Create a Resend DRAFT — owner reviews and clicks Send manually from Resend UI.
    // Code never calls /broadcasts/{id}/send. This prevents any repeat of the March 2026 incidents.
    console.log(`\nCreating Resend draft for owner review...`);

    // Sanity check — prevent test-labeled subjects from becoming drafts
    const FORBIDDEN_SUBJECT_WORDS = ['test', 'ignore', 'debug', 'tracking'];
    if (FORBIDDEN_SUBJECT_WORDS.some(w => subject.toLowerCase().includes(w))) {
      throw new Error(`SAFETY ABORT: Subject contains test-language: "${subject}"\nUse --send-to=EMAIL for preview sends.`);
    }

    // Build HTML — footer uses {{{RESEND_UNSUBSCRIBE_URL}}} (Resend's template variable)
    const html = buildBroadcastOpeningNightHtml(showsForEmail, null, MARKET);

    // Resolve Resend audience id for this market. Audience ids are not secret, so
    // both are hardcoded (env vars can still override). These MUST match the
    // audiences that sync-followers.js populates: Broadway → General, WE → West End.
    const RESEND_BROADWAY_AUDIENCE_ID = '472ec5ef-d7cc-4c48-8007-c0a6a302e7a4';
    const RESEND_WE_AUDIENCE_ID = '0b17260b-6a72-4a5a-a700-7b7526f18d87';
    const audienceId = isLondonMarket(MARKET)
      ? (process.env.RESEND_WE_AUDIENCE_ID || RESEND_WE_AUDIENCE_ID)
      : (process.env.RESEND_BROADWAY_AUDIENCE_ID || RESEND_BROADWAY_AUDIENCE_ID);
    if (!audienceId) {
      throw new Error(`Missing Resend audience id for market ${MARKET} — cannot create broadcast.`);
    }

    // Acquire cross-session send lock before creating the Resend draft.
    // The draft itself is not a subscriber send — owner clicks Send manually —
    // but two sessions racing would create duplicate drafts.
    const lock = acquireSendLock({
      purpose: `${MARKET}-draft-${broadcastKey.replace(`${MARKET}:`, '')}`,
    });
    if (!lock.acquired) {
      console.error(`\nSEND LOCK REFUSED: ${lock.reason}`);
      console.error('Another session is creating a draft right now. Not creating a duplicate.');
      process.exit(1);
    }
    console.log(`  Send lock acquired: ${lock.sessionId.slice(0, 8)} (expires ${lock.expiresAt})`);

    try {
      const result = await postJSON('https://api.resend.com/broadcasts', {
        audience_id: audienceId,
        // SITE_NAME is market-aware ('West End Scorecard' for WE) — never hardcode
        // 'Broadway Scorecard' here or WE subscribers get a Broadway-branded sender.
        from: `${SITE_NAME} <${FROM_EMAIL}>`,
        subject,
        html,
        // Resend caps the broadcast `name` (internal label) at 70 chars. Listing
        // every title overflows once several shows coalesce into one email (HTTP
        // 422 when 6 WE shows were combined, 2026-06-29). Fall back to a count
        // summary when the full list won't fit.
        name: buildBroadcastName(SITE_NAME, showsForEmail),
      }, {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
      });

      const draftId = result.id;
      const draftUrl = `https://resend.com/broadcasts/${draftId}`;

      console.log(`  Draft created: ${draftId}`);
      console.log(`  Review at: ${draftUrl}`);

      // Notify owner via Resend transactional (direct link to the exact draft)
      const OWNER_EMAIL = process.env.OWNER_EMAIL;
      if (OWNER_EMAIL && RESEND_API_KEY) {
        const marketDisplay = isLondonMarket(MARKET) ? 'West End' : 'Broadway';
        const notificationHtml = `
<p>An opening night email draft is ready for your review in Resend.</p>
<table style="margin:16px 0;border-collapse:collapse;">
  <tr><td style="padding:4px 12px 4px 0;color:#666">Show(s)</td><td><strong>${showsForEmail.map(s => s.showTitle).join(', ')}</strong></td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666">Market</td><td><strong>${marketDisplay}</strong></td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666">Subject</td><td>${subject}</td></tr>
</table>
<p><a href="${draftUrl}" style="background:#0066cc;color:#fff;padding:12px 24px;border-radius:4px;text-decoration:none;display:inline-block;font-weight:bold;">Review &amp; Send Draft in Resend →</a></p>
<p style="color:#888;font-size:12px;margin-top:16px;">Direct link: ${draftUrl}</p>`;

        await postJSON('https://api.resend.com/emails', {
          from: `${SITE_NAME} <${FROM_EMAIL}>`,
          to: [OWNER_EMAIL],
          subject: `[Action Required] ${marketDisplay} draft ready — ${showsForEmail.map(s => s.showTitle).join(', ')}`,
          html: notificationHtml,
        }, { 'Authorization': `Bearer ${RESEND_API_KEY}` });

        console.log(`  Owner notified at ${OWNER_EMAIL.replace(/(.{2}).*(@.*)/, '$1***$2')}`);
      } else {
        console.log(`  Warning: OWNER_EMAIL or RESEND_API_KEY not set — owner not notified by email`);
        console.log(`  Draft URL: ${draftUrl}`);
      }

      // Mark as complete from code's perspective — owner sends manually from Resend.
      // NEW 2026-04-22: also track draftStatus so reconcile-broadcast-state.js can
      // round-trip the Resend API and detect cancelled/deleted drafts. completed:true
      // stays for backwards-compat; shouldRequeueShow() gates the re-entry path.
      const completionData = {
        draftCreatedAt: new Date().toISOString(),
        draftId,
        draftUrl,
        method: 'resend-draft',
        reviewCount: showsForEmail.reduce((sum, s) => sum + s.reviewCount, 0),
        completed: true,
        draftStatus: 'draft',
        sentAt: null,
        recipientCount: null,
      };
      sentData.shows[broadcastKey] = completionData;
      for (const s of showsForEmail) {
        sentData.shows[s.showId] = { ...completionData, broadcastKey };
      }
      saveSentData(sentData);

      console.log(`\nDraft ready — log into Resend to send: ${draftUrl}`);

      // Release the lock on success.
      const rel = releaseSendLock(lock);
      if (!rel.released) console.error(`  WARNING: lock release failed: ${rel.reason}`);
      else console.log(`  Send lock released`);
    } catch (err) {
      console.error(`ERROR creating Resend draft: ${err.message}`);
      // Best-effort release before bailing.
      const rel = releaseSendLock(lock);
      if (!rel.released) console.error(`  (lock release note: ${rel.reason})`);
      // Routed through the alert router (email-noise Sprint 2, 2026-07-23) so a
      // retry-loop hitting the SAME draft-creation failure within 24h sends one
      // email, not one per retry — this was one leg of a 9-email storm for a
      // single stuck condition (trainspotting-the-musical-west-end-2026).
      await routeAlert({
        conditionKey: `broadcast:draft-creation-failed:${MARKET}`,
        title: 'Opening Night Draft Creation Failed',
        description: `Resend draft error: ${err.message}`,
        severity: 'error',
        disposition: 'human',
        cooldownHours: 24,
      });
      process.exit(1);
    }
  }

  // Track preview send.
  //
  // The key still carries a UTC-date suffix for debugging/history, but the READER
  // (checkPreviewDedup) scans the whole `preview:{broadcastKey}:*` prefix and picks
  // the most recent by `sentAt`. The suffix is no longer load-bearing for dedup —
  // rolling time windows are. See scripts/lib/preview-dedup.js for the full story.
  if (SEND_TO) {
    const previewTimestamp = new Date().toISOString();
    const previewKey = `preview:${broadcastKey}:${previewTimestamp.slice(0, 10)}`;
    const previewReviewCount = showsForEmail.reduce((sum, s) => sum + s.reviewCount, 0);
    sentData.shows[previewKey] = { sentAt: previewTimestamp, previewTo: SEND_TO, reviewCount: previewReviewCount };
    saveSentData(sentData);

    // Sync to origin/main so a concurrent workflow run can see the write.
    // Without this, local CLI previews are invisible to CI and cause duplicate sends
    // (2026-04-11 incident: 02:09 UTC local preview never reached origin, 12:21 UTC
    // workflow re-sent because its origin/main checkout had no record of the CLI run).
    // No-ops when running under GitHub Actions — the workflow commits separately.
    syncTrackerToOrigin(sentData);

    console.log(`\nPreview sent to ${SEND_TO}`);
  }
}

// Exported for unit testing. Only run main() when invoked as a CLI.
module.exports = { syncTrackerToOrigin, mergeTrackerEntries, findRecentlyOpenedShows, buildBroadcastName, RESEND_NAME_MAX };

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
}
