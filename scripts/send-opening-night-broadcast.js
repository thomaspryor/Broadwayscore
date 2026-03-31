#!/usr/bin/env node
/**
 * send-opening-night-broadcast.js
 *
 * Creates a Buttondown DRAFT when a show opens and has enough reviews.
 * Owner logs into Buttondown, reviews the draft, and clicks Send manually.
 * Code never pushes the Send button.
 *
 * Reads shows.json, reviews.json, critic-consensus.json, subscribers.json,
 * and opening-night-sent.json.
 *
 * Multiple shows opening the same night are coalesced into a single email.
 *
 * Usage: node scripts/send-opening-night-broadcast.js [--dry-run] [--lookback=DAYS] [--market=broadway|west-end] [--send-to=EMAIL]
 *
 * --send-to=EMAIL  Preview mode: send a single transactional email via Resend (not a broadcast/draft).
 *                  Use this to review the email rendering before a real draft is created.
 *
 * Env: BUTTONDOWN_API_KEY, RESEND_API_KEY (for --send-to preview and owner notifications), DISCORD_WEBHOOK_ALERTS
 */

const fs = require('fs');
const path = require('path');
const { sendAlert } = require('./lib/discord-notify');
const {
  postJSON, buildBroadcastOpeningNightHtml, buildUnsubscribeUrl,
} = require('./lib/email-templates');
const { isLondonMarket } = require('./lib/venue-classification');

const DRY_RUN = process.argv.includes('--dry-run');
const LOOKBACK_ARG = process.argv.find(a => a.startsWith('--lookback='));
const LOOKBACK_DAYS = LOOKBACK_ARG ? parseInt(LOOKBACK_ARG.split('=')[1], 10) : 2;
const MARKET_ARG = process.argv.find(a => a.startsWith('--market='));
const MARKET = MARKET_ARG ? MARKET_ARG.split('=')[1] : 'broadway'; // 'broadway' or 'west-end'
const SEND_TO_ARG = process.argv.find(a => a.startsWith('--send-to='));
const SEND_TO = SEND_TO_ARG ? SEND_TO_ARG.split('=')[1] : null; // Preview mode: send to single email only

const DATA_DIR = path.join(__dirname, '..', 'data');
const SHOWS_PATH = path.join(DATA_DIR, 'shows.json');
const REVIEWS_PATH = path.join(DATA_DIR, 'reviews.json');
const CONSENSUS_PATH = path.join(DATA_DIR, 'critic-consensus.json');
const SUBSCRIBERS_PATH = path.join(DATA_DIR, isLondonMarket(MARKET) ? 'subscribers-westend.json' : 'subscribers.json');
const SENT_PATH = path.join(DATA_DIR, 'opening-night-sent.json');

const MOBILE_SHOWS_PATH = path.join(__dirname, '..', 'public', 'data', 'mobile-shows.json');
const OUTLET_REGISTRY_PATH = path.join(DATA_DIR, 'outlet-registry.json');
const FROM_EMAIL = 'updates@broadwayscorecard.com';
const SITE_NAME = isLondonMarket(MARKET) ? 'West End Scorecard' : 'Broadway Scorecard';
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
    if (isLondonMarket(MARKET)) {
      if (!isLondonMarket(s.category)) return false;
    } else {
      // Broadway: exclude off-broadway and London markets
      if (s.category === 'off-broadway' || isLondonMarket(s.category)) return false;
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
    if (r.assignedScore >= 65) positive++;
    else if (r.assignedScore >= 40) mixed++;
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
  const BUTTONDOWN_API_KEY = process.env.BUTTONDOWN_API_KEY;
  const RESEND_API_KEY = process.env.RESEND_API_KEY; // Still used for --send-to preview and owner notification

  if (!BUTTONDOWN_API_KEY && !DRY_RUN && !SEND_TO) {
    console.log('Missing BUTTONDOWN_API_KEY — skipping draft creation');
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
    console.log(`Mode: Buttondown DRAFT — owner reviews and sends manually from Buttondown UI`);
  }

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

  // Filter out already-completed broadcasts — applies in BOTH broadcast and preview mode.
  // In preview mode, there's no reason to keep re-previewing a show whose full broadcast
  // has already been sent (completed:true). This prevents repeated preview spam when a
  // newly-opened show with 0 reviews keeps the workflow running alongside a completed show.
  const pendingShows = recentlyOpened.filter(s => {
    const showId = s.id || s.slug;
    const individualSent = sentData.shows[showId];
    if (individualSent && individualSent.completed) {
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

  // Check readiness: 12+ total, 3+ T1, 3+ T2
  const readyShows = [];
  for (const show of pendingShows) {
    const showId = show.id || show.slug;
    const stats = getReviewStats(reviewsArr, showId);
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

  // Load pre-computed scores from mobile-shows.json (generated by generate-mobile-data.js)
  // This ensures the email shows the SAME score as the live site — no duplicate computation
  const mobileShowsData = loadJSON(MOBILE_SHOWS_PATH);
  const mobileShowsMap = new Map();
  if (mobileShowsData?.shows) {
    for (const ms of mobileShowsData.shows) mobileShowsMap.set(ms.id, ms);
  }

  // Build show data for email template
  const showsForEmail = readyShows.map(({ show, stats }) => {
    const showId = show.id || show.slug;
    const consensusShows = consensus.shows || consensus;
    const showConsensus = consensusShows[showId] || consensusShows[show.slug];
    const consensusText = showConsensus?.text || showConsensus?.consensus || null;

    // Use pre-computed score from mobile-shows.json (same as live site)
    const mobileShow = mobileShowsMap.get(showId);
    const score = mobileShow?.cs ?? null;
    const reviewCount = mobileShow?.cr?.rc ?? stats.reviewCount;

    // Show image — prefer mobile-shows.json image (already optimized), fall back to shows.json
    const mobileImg = mobileShow?.img;
    let imageUrl = null;
    if (mobileImg?.po || mobileImg?.th) {
      const img = mobileImg.po || mobileImg.th;
      imageUrl = img.startsWith('http') ? img : `https://broadwayscorecard.com${img}`;
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

  // Build subject line — never put [PREVIEW] in subject, it confuses subscribers if leaked
  const subject = showsForEmail.length === 1
    ? `${showsForEmail[0].showTitle} is now open, and the critic reviews are in`
    : `${showsForEmail.length} shows opened ${MARKET === 'west-end' ? 'in the West End' : 'on Broadway'} — the reviews are in`;

  console.log(`\nSubject: ${subject}`);

  // Check if already broadcast
  const broadcastKey = `${MARKET}:` + showsForEmail.map(s => s.showId).sort().join('+');
  const previousSent = sentData.shows[broadcastKey];

  if (previousSent?.completed && !SEND_TO) {
    console.log('Broadcast already completed for this show combination — nothing to do');
    process.exit(0);
  }

  if (DRY_RUN) {
    console.log(`\n[DRY RUN] Would create Buttondown draft for ${MARKET}`);
    const html = buildBroadcastOpeningNightHtml(showsForEmail, null, MARKET);
    console.log(`Email HTML length: ${html.length} chars`);
    console.log('Has Buttondown unsubscribe variable:', html.includes('{{ unsubscribe_url }}'));
    console.log('Has score card:', html.includes('font-size:32px'));
    process.exit(0);
  }

  if (SEND_TO) {
    // Preview mode: send single transactional email (with custom unsubscribe link)
    // Dedup: skip if we already previewed this show combination today with the same review count.
    // Re-send if 3+ more reviews have been scored since last preview (meaningful new data).
    const today = new Date().toISOString().slice(0, 10);
    const previewKey = `preview:${broadcastKey}:${today}`;
    const currentReviewCount = showsForEmail.reduce((sum, s) => sum + s.reviewCount, 0);
    const previousPreview = sentData.shows[previewKey];
    if (previousPreview?.sentAt) {
      const previousReviewCount = previousPreview.reviewCount || 0;
      const newReviews = currentReviewCount - previousReviewCount;
      if (newReviews < 3) {
        console.log(`\nPreview already sent today for this show combination — skipping`);
        console.log(`  Previous preview: ${previousPreview.sentAt} (${previousReviewCount} reviews)`);
        console.log(`  Current: ${currentReviewCount} reviews (+${newReviews}, need +3 to re-send)`);
        process.exit(0);
      }
      console.log(`\nRe-sending preview — ${newReviews} new reviews since last preview (${previousReviewCount} → ${currentReviewCount})`);
    }

    console.log(`\nSending preview to ${SEND_TO}...`);
    const html = buildBroadcastOpeningNightHtml(showsForEmail, SEND_TO, MARKET);

    // Build unsubscribe URL for List-Unsubscribe header (RFC 8058)
    // Must point to /api/unsubscribe (handles POST) — NOT /unsubscribe (GET-only client page)
    const unsubUrl = `https://broadwayscorecard.com/api/unsubscribe?email=${encodeURIComponent(SEND_TO)}${MARKET === 'west-end' ? '&market=west-end' : ''}`;

    try {
      await postJSON('https://api.resend.com/emails', {
        from: `${SITE_NAME} <${FROM_EMAIL}>`,
        to: [SEND_TO],
        subject,
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
      process.exit(1);
    }
  } else {
    // Create a Buttondown DRAFT — owner reviews and clicks Send manually from Buttondown UI.
    // Code never pushes the Send button. This prevents any repeat of the March 2026 incidents.
    console.log(`\nCreating Buttondown draft for owner review...`);

    // Sanity check — prevent test-labeled subjects from becoming drafts
    const FORBIDDEN_SUBJECT_WORDS = ['test', 'ignore', 'debug', 'tracking'];
    if (FORBIDDEN_SUBJECT_WORDS.some(w => subject.toLowerCase().includes(w))) {
      throw new Error(`SAFETY ABORT: Subject contains test-language: "${subject}"\nUse --send-to=EMAIL for preview sends.`);
    }

    // Build HTML — uses {{ unsubscribe_url }} (Buttondown's template variable)
    const html = buildBroadcastOpeningNightHtml(showsForEmail, null, MARKET);
    const marketLabel = isLondonMarket(MARKET) ? '[West End] ' : '';

    try {
      const result = await postJSON('https://api.buttondown.com/v1/emails', {
        subject: `${marketLabel}${subject}`,
        body: html,
        status: 'draft',
      }, {
        'Authorization': `Token ${BUTTONDOWN_API_KEY}`,
      });

      const draftId = result.id;
      const draftUrl = `https://buttondown.com/emails/${draftId}`;

      console.log(`  Draft created: ${draftId}`);
      console.log(`  Review at: ${draftUrl}`);

      // Notify owner via Resend transactional (direct link to the exact draft)
      const OWNER_EMAIL = process.env.OWNER_EMAIL;
      if (OWNER_EMAIL && RESEND_API_KEY) {
        const marketDisplay = isLondonMarket(MARKET) ? 'West End' : 'Broadway';
        const notificationHtml = `
<p>An opening night email draft is ready for your review in Buttondown.</p>
<table style="margin:16px 0;border-collapse:collapse;">
  <tr><td style="padding:4px 12px 4px 0;color:#666">Show(s)</td><td><strong>${showsForEmail.map(s => s.showTitle).join(', ')}</strong></td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666">Market</td><td><strong>${marketDisplay}</strong></td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666">Subject</td><td>${subject}</td></tr>
</table>
<p><a href="${draftUrl}" style="background:#0066cc;color:#fff;padding:12px 24px;border-radius:4px;text-decoration:none;display:inline-block;font-weight:bold;">Review &amp; Send Draft in Buttondown →</a></p>
<p style="color:#888;font-size:12px;margin-top:16px;">Direct link: ${draftUrl}<br>
${isLondonMarket(MARKET) ? '<strong>Note:</strong> This is a West End broadcast. Filter by the "west-end" tag before sending.' : ''}</p>`;

        await postJSON('https://api.resend.com/emails', {
          from: `Broadway Scorecard <${FROM_EMAIL}>`,
          to: [OWNER_EMAIL],
          subject: `[Action Required] ${marketDisplay} draft ready — ${showsForEmail.map(s => s.showTitle).join(', ')}`,
          html: notificationHtml,
        }, { 'Authorization': `Bearer ${RESEND_API_KEY}` });

        console.log(`  Owner notified at ${OWNER_EMAIL.replace(/(.{2}).*(@.*)/, '$1***$2')}`);
      } else {
        console.log(`  Warning: OWNER_EMAIL or RESEND_API_KEY not set — owner not notified by email`);
        console.log(`  Draft URL: ${draftUrl}`);
      }

      // Mark as complete from code's perspective — owner sends manually from Buttondown
      const completionData = {
        draftCreatedAt: new Date().toISOString(),
        draftId,
        draftUrl,
        method: 'buttondown-draft',
        reviewCount: showsForEmail.reduce((sum, s) => sum + s.reviewCount, 0),
        completed: true,
      };
      sentData.shows[broadcastKey] = completionData;
      for (const s of showsForEmail) {
        sentData.shows[s.showId] = { ...completionData, broadcastKey };
      }
      saveSentData(sentData);

      console.log(`\nDraft ready — log into Buttondown to send: ${draftUrl}`);
    } catch (err) {
      console.error(`ERROR creating Buttondown draft: ${err.message}`);
      await sendAlert({
        title: 'Opening Night Draft Creation Failed',
        description: `Buttondown draft error: ${err.message}`,
        severity: 'error',
      });
      process.exit(1);
    }
  }

  // Track preview send
  if (SEND_TO) {
    const today2 = new Date().toISOString().slice(0, 10);
    const previewKey2 = `preview:${broadcastKey}:${today2}`;
    const previewReviewCount = showsForEmail.reduce((sum, s) => sum + s.reviewCount, 0);
    sentData.shows[previewKey2] = { sentAt: new Date().toISOString(), previewTo: SEND_TO, reviewCount: previewReviewCount };
    saveSentData(sentData);
    console.log(`\nPreview sent to ${SEND_TO}`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
