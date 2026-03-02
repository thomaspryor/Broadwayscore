#!/usr/bin/env node
/**
 * send-opening-night-broadcast.js
 *
 * Broadcasts opening-night emails to ALL general subscribers when a show
 * opens on Broadway and has 8+ scored reviews.
 *
 * Reads shows.json, reviews.json, critic-consensus.json, subscribers.json,
 * and opening-night-sent.json. Sends via Resend.
 *
 * Multiple shows opening the same night are coalesced into a single email.
 *
 * Usage: node scripts/send-opening-night-broadcast.js [--dry-run] [--lookback=DAYS] [--market=broadway|west-end] [--budget=N]
 *
 * Env: RESEND_API_KEY, DISCORD_WEBHOOK_ALERTS
 */

const fs = require('fs');
const path = require('path');
const { sendAlert } = require('./lib/discord-notify');
const {
  postJSON, sleep, buildBroadcastOpeningNightHtml,
} = require('./lib/email-templates');

const DRY_RUN = process.argv.includes('--dry-run');
const LOOKBACK_ARG = process.argv.find(a => a.startsWith('--lookback='));
const LOOKBACK_DAYS = LOOKBACK_ARG ? parseInt(LOOKBACK_ARG.split('=')[1], 10) : 2;
const MARKET_ARG = process.argv.find(a => a.startsWith('--market='));
const MARKET = MARKET_ARG ? MARKET_ARG.split('=')[1] : 'broadway'; // 'broadway' or 'west-end'
const BUDGET_ARG = process.argv.find(a => a.startsWith('--budget='));

const DATA_DIR = path.join(__dirname, '..', 'data');
const SHOWS_PATH = path.join(DATA_DIR, 'shows.json');
const REVIEWS_PATH = path.join(DATA_DIR, 'reviews.json');
const CONSENSUS_PATH = path.join(DATA_DIR, 'critic-consensus.json');
const SUBSCRIBERS_PATH = path.join(DATA_DIR, MARKET === 'west-end' ? 'subscribers-westend.json' : 'subscribers.json');
const SENT_PATH = path.join(DATA_DIR, 'opening-night-sent.json');

const OUTLET_REGISTRY_PATH = path.join(DATA_DIR, 'outlet-registry.json');
const FROM_EMAIL = 'updates@broadwayscorecard.com';
const SITE_NAME = MARKET === 'west-end' ? 'West End Scorecard' : 'Broadway Scorecard';
const MIN_REVIEWS = 8;
const DEFAULT_BUDGET_CAP = 95; // Leave headroom for per-show follow emails (Resend 100/day)
const BUDGET_CAP = BUDGET_ARG ? parseInt(BUDGET_ARG.split('=')[1], 10) : DEFAULT_BUDGET_CAP;

// Tier weights — must match src/config/scoring.ts
const TIER_WEIGHTS = { 1: 1.0, 2: 0.75, 3: 0.35 };

function loadJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function saveSentData(data) {
  fs.writeFileSync(SENT_PATH, JSON.stringify(data, null, 2));
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
    // Filter by market
    if (MARKET === 'west-end') {
      if (s.category !== 'west-end') return false;
    } else {
      // Broadway: exclude off-broadway and west-end
      if (s.category === 'off-broadway' || s.category === 'west-end') return false;
    }
    const d = new Date(s.openingDate);
    d.setHours(0, 0, 0, 0);
    return d >= cutoff && d <= now;
  });
}

/**
 * Count scored reviews and compute positive/mixed/negative for a show.
 */
function getReviewStats(reviews, showId) {
  const showReviews = (reviews || []).filter(r => r.showId === showId && r.assignedScore != null);
  let positive = 0, mixed = 0, negative = 0;

  for (const r of showReviews) {
    if (r.assignedScore >= 75) positive++;
    else if (r.assignedScore >= 55) mixed++;
    else negative++;
  }

  return {
    reviewCount: showReviews.length,
    positive,
    mixed,
    negative,
  };
}

async function main() {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;

  if (!RESEND_API_KEY && !DRY_RUN) {
    console.log('Missing RESEND_API_KEY — skipping sends');
    process.exit(0);
  }

  console.log(`Opening Night Broadcast (${MARKET})`);
  console.log('=======================\n');
  if (DRY_RUN) console.log('** DRY RUN — no emails will be sent **\n');
  console.log(`Market: ${MARKET}, Budget: ${BUDGET_CAP}, Subscribers file: ${path.basename(SUBSCRIBERS_PATH)}`);

  // Load data
  const showsData = loadJSON(SHOWS_PATH);
  if (!showsData) { console.error('Cannot load shows.json'); process.exit(1); }
  const showsArr = showsData.shows || showsData;
  const showsList = Array.isArray(showsArr) ? showsArr : Object.values(showsArr);

  const reviewsData = loadJSON(REVIEWS_PATH);
  const reviews = reviewsData ? (reviewsData.reviews || reviewsData) : [];
  const reviewsArr = Array.isArray(reviews) ? reviews : Object.values(reviews);

  const consensus = loadJSON(CONSENSUS_PATH) || {};

  const subscribersData = loadJSON(SUBSCRIBERS_PATH);
  if (!subscribersData || !subscribersData.subscribers || subscribersData.subscribers.length === 0) {
    console.log('No subscribers found — nothing to broadcast');
    process.exit(0);
  }
  const subscribers = subscribersData.subscribers; // Already sorted alphabetically

  // Load or init sent tracking
  let sentData = loadJSON(SENT_PATH);
  if (!sentData || !sentData.shows) {
    sentData = { shows: {} };
  }

  // Find recently opened shows
  const recentlyOpened = findRecentlyOpenedShows(showsList, LOOKBACK_DAYS);
  if (recentlyOpened.length === 0) {
    console.log('No recently opened shows — nothing to broadcast');
    process.exit(0);
  }

  console.log(`Found ${recentlyOpened.length} recently opened show(s):`);
  for (const s of recentlyOpened) {
    console.log(`  - ${s.title} (${s.id}) opened ${s.openingDate}`);
  }

  // Filter out already-completed broadcasts
  const pendingShows = recentlyOpened.filter(s => {
    const sent = sentData.shows[s.id || s.slug];
    return !sent || !sent.completed;
  });

  if (pendingShows.length === 0) {
    console.log('\nAll recently opened shows already broadcast — nothing to do');
    process.exit(0);
  }

  // Check readiness (12+ scored reviews)
  const readyShows = [];
  for (const show of pendingShows) {
    const showId = show.id || show.slug;
    const stats = getReviewStats(reviewsArr, showId);
    if (stats.reviewCount >= MIN_REVIEWS) {
      readyShows.push({ show, stats });
    } else {
      console.log(`  ${show.title}: Not ready (${stats.reviewCount}/${MIN_REVIEWS} reviews)`);
    }
  }

  if (readyShows.length === 0) {
    console.log('\nNo shows are ready for broadcast (need 12+ scored reviews)');
    process.exit(0);
  }

  // Load outlet registry for tier-weighted scoring
  const outletRegistry = loadJSON(OUTLET_REGISTRY_PATH) || {};
  const outlets = outletRegistry.outlets || outletRegistry;

  function getOutletTier(outletId) {
    const entry = outlets[outletId];
    return (entry && entry.tier) || 3; // Default to Tier 3
  }

  // Build show data for email template
  const showsForEmail = readyShows.map(({ show, stats }) => {
    const showId = show.id || show.slug;
    const consensusShows = consensus.shows || consensus;
    const showConsensus = consensusShows[showId] || consensusShows[show.slug];
    const consensusText = showConsensus?.text || showConsensus?.consensus || null;

    // Compute tier-weighted score (matches website's engine.ts)
    const showReviews = reviewsArr.filter(r => r.showId === showId && r.assignedScore != null);
    let avgScore = null;
    if (showReviews.length > 0) {
      let weightedSum = 0, totalWeight = 0;
      for (const r of showReviews) {
        const tier = getOutletTier(r.outletId);
        const weight = TIER_WEIGHTS[tier] || 0.35;
        weightedSum += r.assignedScore * weight;
        totalWeight += weight;
      }
      avgScore = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : null;
    }

    // Show image
    const imagePath = show.images?.thumbnail || show.images?.poster || show.images?.hero;
    const imageUrl = imagePath ? `https://broadwayscorecard.com${imagePath}` : null;

    return {
      showTitle: show.title,
      score: avgScore,
      reviewCount: stats.reviewCount,
      positive: stats.positive,
      mixed: stats.mixed,
      negative: stats.negative,
      consensusText,
      showType: show.type === 'musical' ? 'Musical' : 'Play',
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

  // Budget gate
  console.log(`\nSubscribers: ${subscribers.length}`);

  if (subscribers.length > BUDGET_CAP) {
    const msg = `Opening night broadcast: ${subscribers.length} subscribers exceeds budget cap of ${BUDGET_CAP}. Sending to first ${BUDGET_CAP}.`;
    console.warn(`WARNING: ${msg}`);
    await sendAlert({
      title: 'Opening Night Broadcast Budget Warning',
      description: msg,
      severity: 'warning',
      fields: [
        { name: 'Subscribers', value: String(subscribers.length) },
        { name: 'Budget Cap', value: String(BUDGET_CAP) },
      ],
    });
  }

  // Determine how many to send (resume from previous partial send)
  const broadcastKey = `${MARKET}:` + showsForEmail.map(s => s.showId).sort().join('+');
  const previousSent = sentData.shows[broadcastKey];
  const alreadySentCount = previousSent?.sentCount || 0;

  if (alreadySentCount > 0) {
    console.log(`Resuming from previous partial send: ${alreadySentCount} already sent`);
  }

  const toSend = subscribers.slice(alreadySentCount, alreadySentCount + BUDGET_CAP);

  if (toSend.length === 0) {
    console.log('All subscribers already sent — marking complete');
    sentData.shows[broadcastKey] = {
      ...previousSent,
      completed: true,
    };
    saveSentData(sentData);
    process.exit(0);
  }

  // Build subject line
  const subject = showsForEmail.length === 1
    ? `${showsForEmail[0].showTitle} is now open, and the critic reviews are in`
    : `${showsForEmail.length} shows opened ${MARKET === 'west-end' ? 'in the West End' : 'on Broadway'} — the reviews are in`;

  console.log(`\nSubject: ${subject}`);
  console.log(`Sending to ${toSend.length} subscribers (offset ${alreadySentCount})...`);

  if (DRY_RUN) {
    console.log('\n[DRY RUN] Would send to:');
    for (const email of toSend.slice(0, 10)) {
      console.log(`  ${email.replace(/(.{2}).*(@.*)/, '$1***$2')}`);
    }
    if (toSend.length > 10) console.log(`  ... and ${toSend.length - 10} more`);

    // Show HTML preview
    const html = buildBroadcastOpeningNightHtml(showsForEmail, 'preview@test.com', MARKET);
    console.log(`\nEmail HTML length: ${html.length} chars`);
    console.log('Has unsubscribe link:', html.includes('/unsubscribe'));
    console.log('Has score card:', html.includes('font-size:32px'));
    process.exit(0);
  }

  // Send emails
  let sentCount = alreadySentCount;
  let consecutiveErrors = 0;

  for (const email of toSend) {
    const html = buildBroadcastOpeningNightHtml(showsForEmail, email, MARKET);

    try {
      await postJSON('https://api.resend.com/emails', {
        from: `${SITE_NAME} <${FROM_EMAIL}>`,
        to: [email],
        subject,
        html,
      }, {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
      });

      sentCount++;
      consecutiveErrors = 0;
      console.log(`  Sent to ${email.replace(/(.{2}).*(@.*)/, '$1***$2')} (${sentCount - alreadySentCount}/${toSend.length})`);

      // Checkpoint every 25 sends
      if ((sentCount - alreadySentCount) % 25 === 0) {
        sentData.shows[broadcastKey] = {
          sentAt: new Date().toISOString(),
          sentCount,
          subscriberCount: subscribers.length,
          reviewCount: showsForEmail.reduce((sum, s) => sum + s.reviewCount, 0),
          completed: false,
        };
        saveSentData(sentData);
        console.log(`  [Checkpoint] Saved at ${sentCount} total sends`);
      }

      // Rate limit: 200ms between sends
      await sleep(200);
    } catch (err) {
      consecutiveErrors++;
      console.error(`  ERROR sending to ${email.replace(/(.{2}).*(@.*)/, '$1***$2')}: ${err.message}`);

      // Retry on 429 (rate limit)
      if (err.message.includes('429')) {
        console.log('  Rate limited — waiting 60s before retry...');
        await sleep(60000);
        try {
          await postJSON('https://api.resend.com/emails', {
            from: `${SITE_NAME} <${FROM_EMAIL}>`,
            to: [email],
            subject,
            html,
          }, {
            'Authorization': `Bearer ${RESEND_API_KEY}`,
          });
          sentCount++;
          consecutiveErrors = 0;
          console.log(`  Retry successful for ${email.replace(/(.{2}).*(@.*)/, '$1***$2')}`);
        } catch (retryErr) {
          console.error(`  Retry also failed: ${retryErr.message}`);
          // Exit non-zero on persistent rate limit so notify-failure triggers
          if (retryErr.message.includes('429')) {
            console.error('Resend rate limit exhausted — exiting with error');
            process.exitCode = 1;
          }
        }
      }

      // Abort on 5 consecutive errors
      if (consecutiveErrors >= 5) {
        console.error('5 consecutive errors — aborting');
        await sendAlert({
          title: 'Opening Night Broadcast Send Errors',
          description: `5 consecutive errors. Last: ${err.message}. Sent ${sentCount - alreadySentCount}/${toSend.length} in this run.`,
          severity: 'error',
        });
        break;
      }
    }
  }

  // Final save
  const allSent = sentCount >= subscribers.length;
  sentData.shows[broadcastKey] = {
    sentAt: new Date().toISOString(),
    sentCount,
    subscriberCount: subscribers.length,
    reviewCount: showsForEmail.reduce((sum, s) => sum + s.reviewCount, 0),
    completed: allSent,
  };
  saveSentData(sentData);

  console.log(`\nDone: ${sentCount - alreadySentCount} sent this run, ${sentCount} total`);
  if (allSent) {
    console.log('All subscribers sent — broadcast complete');
  } else {
    console.log(`${subscribers.length - sentCount} remaining — will continue on next cron run`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
