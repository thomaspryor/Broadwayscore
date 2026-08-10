#!/usr/bin/env node
/**
 * send-follow-notifications.js
 *
 * Reads show-changes-digest.json + followers.json, sends notification
 * emails via Resend for each show with meaningful changes and followers.
 *
 * Opening-night changes get a rich email with critic score card, review
 * breakdown, and consensus text. All other changes get a bullet-list email.
 *
 * Delivery-safe: after sending, removes fully-delivered shows from the
 * digest so undelivered changes persist for the next run.
 *
 * Usage: node scripts/send-follow-notifications.js [--dry-run]
 *
 * Env: RESEND_API_KEY, DISCORD_WEBHOOK_ALERTS
 */

const fs = require('fs');
const path = require('path');
const { sendAlert } = require('./lib/discord-notify');
const { isLondonMarket } = require('./lib/venue-classification');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `send-follow-notifications.js — Reads show-changes-digest.json + followers.json, sends notification.

Usage:
  node scripts/send-follow-notifications.js [options]
  node scripts/send-follow-notifications.js --help, -h    print this usage and exit
`;
const {
  postJSON, sleep, escapeHtml, getScoreColor, getChangeAnchor,
  buildUnfollowUrl, buildFooterHtml, buildEmailHtml, buildOpeningNightHtml, siteNameForMarket, buildReplyToAddress,
} = require('./lib/email-templates');

const DIGEST_PATH = path.join(__dirname, '..', 'data', 'audit', 'show-changes-digest.json');
const FOLLOWERS_PATH = path.join(__dirname, '..', 'data', 'followers.json');
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const CHECKPOINT_PATH = path.join(__dirname, '..', 'data', 'audit', 'follow-send-checkpoint.json');

const DRY_RUN = process.argv.includes('--dry-run');

// Budget: Resend free tier = 3,000 emails/month (100/day)
const MONTHLY_LIMIT = 3000;
const BUDGET_RESERVE = 500;
const MAX_SENDS_PER_RUN = Math.min(MONTHLY_LIMIT - BUDGET_RESERVE, 100); // 100/day limit on free tier

const FROM_EMAIL = 'updates@broadwayscorecard.com';

// High-priority change types — a single one of these warrants an email
const HIGH_PRIORITY_TYPES = ['opening-night', 'status-change', 'cast-change', 'lottery-added', 'recoupment'];

function loadJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function shouldNotify(changes) {
  if (!changes || changes.length === 0) return false;
  const hasHighPriority = changes.some(c => HIGH_PRIORITY_TYPES.includes(c.type));
  return hasHighPriority || changes.length >= 2;
}

async function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const RESEND_API_KEY = process.env.RESEND_API_KEY;

  if (!RESEND_API_KEY) {
    console.log('Missing RESEND_API_KEY — skipping sends');
    if (!DRY_RUN) process.exit(0);
  }

  console.log('Send Follow Notifications (Resend)');
  console.log('===================================\n');
  if (DRY_RUN) console.log('** DRY RUN — no emails will be sent **\n');

  const digest = loadJSON(DIGEST_PATH);
  if (!digest || !digest.changes || Object.keys(digest.changes).length === 0) {
    console.log('No digest found or no changes detected — nothing to send');
    process.exit(0);
  }

  const followers = loadJSON(FOLLOWERS_PATH);
  if (!followers || !followers.followers) {
    console.log('No followers.json found — nothing to send');
    process.exit(0);
  }

  const shows = loadJSON(SHOWS_PATH);
  const showsList = shows ? (shows.shows || shows) : {};
  const showsArr = Array.isArray(showsList) ? showsList : Object.values(showsList);
  const showsMap = {};
  for (const s of showsArr) {
    if (s.id || s.slug) showsMap[s.id || s.slug] = s;
  }

  // Load checkpoint (resume from partial send)
  const checkpoint = loadJSON(CHECKPOINT_PATH);
  const alreadySent = new Set();
  if (checkpoint && checkpoint.sent) {
    for (const key of checkpoint.sent) alreadySent.add(key);
    console.log(`Resuming from checkpoint: ${alreadySent.size} already sent`);
  }

  // Build send queue
  const changesEntries = Object.entries(digest.changes);
  const sendQueue = [];

  for (const [showId, changes] of changesEntries) {
    if (!shouldNotify(changes)) {
      console.log(`  Skip ${showId}: changes below notification threshold`);
      continue;
    }

    const showFollowers = followers.followers[showId];
    if (!showFollowers || showFollowers.length === 0) {
      console.log(`  Skip ${showId}: no followers`);
      continue;
    }

    for (const email of showFollowers) {
      const key = `${showId}:${email}`;
      if (alreadySent.has(key)) continue;
      sendQueue.push({ showId, email, changes });
    }
  }

  // Priority queue: opening-night emails first (Pre-Mortem P1)
  sendQueue.sort((a, b) => {
    const aOpening = a.changes.some(c => c.type === 'opening-night') ? 0 : 1;
    const bOpening = b.changes.some(c => c.type === 'opening-night') ? 0 : 1;
    return aOpening - bOpening;
  });

  console.log(`\nSend queue: ${sendQueue.length} emails across ${changesEntries.length} changed shows`);
  console.log(`Budget: ${MAX_SENDS_PER_RUN} max sends per run`);

  // Budget warning (no longer blocks — sends what it can, keeps the rest)
  if (sendQueue.length > MAX_SENDS_PER_RUN) {
    const msg = `Follow notifications: ${sendQueue.length} needed, ${MAX_SENDS_PER_RUN} max. Will send ${MAX_SENDS_PER_RUN} (prioritizing opening nights), rest persists for next run.`;
    console.warn(msg);
    await sendAlert({
      title: 'Follow Notification Budget Warning',
      description: msg,
      severity: 'warning',
      fields: [
        { name: 'Queue Size', value: String(sendQueue.length) },
        { name: 'Budget', value: String(MAX_SENDS_PER_RUN) },
      ],
    });
  }

  if (sendQueue.length === 0) {
    console.log('Nothing to send');
    process.exit(0);
  }

  // Track which shows had ALL emails sent (for delivery-safe snapshot)
  const emailsPerShow = {};
  const sentPerShow = {};
  for (const item of sendQueue) {
    emailsPerShow[item.showId] = (emailsPerShow[item.showId] || 0) + 1;
    sentPerShow[item.showId] = 0;
  }

  // Send emails (capped at budget)
  let sentCount = 0;
  let errorCount = 0;
  const sentKeys = [...alreadySent];

  for (const { showId, email, changes } of sendQueue) {
    if (sentCount >= MAX_SENDS_PER_RUN) {
      console.log(`\nBudget reached (${MAX_SENDS_PER_RUN}). Remaining emails will persist for next run.`);
      break;
    }

    const show = showsMap[showId];
    const showTitle = show?.title || showId;
    const market = isLondonMarket(show?.category) ? 'west-end' : 'broadway';
    const siteBase = market === 'west-end' ? 'https://broadwayscorecard.com/west-end' : 'https://broadwayscorecard.com';
    const showUrl = `https://broadwayscorecard.com/show/${show?.slug || showId}`;

    // Route: opening-night → rich template, else → generic
    const openingNight = changes.find(c => c.type === 'opening-night');
    const otherChanges = changes.filter(c => c.type !== 'opening-night');

    // Show image: prefer thumbnail → poster → hero
    const imagePath = show?.images?.thumbnail || show?.images?.poster || show?.images?.hero;
    const imageUrl = imagePath
      ? (imagePath.startsWith('http') ? imagePath : `https://broadwayscorecard.com${imagePath}`)
      : null;

    const html = openingNight
      ? buildOpeningNightHtml(showTitle, openingNight, otherChanges, showUrl, showId, email, imageUrl, market)
      : buildEmailHtml(showTitle, changes, showUrl, showId, email, market);

    const siteName = siteNameForMarket(market);
    const subject = openingNight
      ? `${showTitle} is now open, and the critic reviews are in`
      : `Updates for ${showTitle} on ${siteName}`;

    if (DRY_RUN) {
      console.log(`  [DRY] Would send to ${email.replace(/(.{2}).*(@.*)/, '$1***$2')} for ${showTitle}`);
      console.log(`         Subject: ${subject}`);
      console.log(`         Changes: ${changes.map(c => c.message).join('; ')}`);
      if (openingNight) console.log(`         [OPENING NIGHT template — score: ${openingNight.score || 'TBD'}, reviews: ${openingNight.reviewCount || 0}]`);
      sentCount++;
      sentPerShow[showId]++;
      continue;
    }

    try {
      await postJSON('https://api.resend.com/emails', {
        from: `${siteName} <${FROM_EMAIL}>`,
        // `updates@` is send-only — without this, a follower's reply bounces.
        reply_to: buildReplyToAddress(),
        to: [email],
        subject,
        html,
      }, {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
      });

      sentCount++;
      sentPerShow[showId]++;
      const key = `${showId}:${email}`;
      sentKeys.push(key);
      console.log(`  Sent to ${email.replace(/(.{2}).*(@.*)/, '$1***$2')} for ${showTitle} (${sentCount}/${Math.min(sendQueue.length, MAX_SENDS_PER_RUN)})`);

      // Checkpoint every 25 sends
      if (sentCount % 25 === 0) {
        fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify({ sent: sentKeys, timestamp: new Date().toISOString() }, null, 2));
        console.log(`  [Checkpoint] Saved at ${sentCount} sends`);
      }

      // Rate limit: 200ms between sends
      await sleep(200);
    } catch (err) {
      errorCount++;
      console.error(`  ERROR sending to ${email.replace(/(.{2}).*(@.*)/, '$1***$2')} for ${showTitle}: ${err.message}`);
      if (errorCount >= 5) {
        console.error('Too many errors — aborting sends');
        await sendAlert({
          title: 'Follow Notification Send Errors',
          description: `${errorCount} errors in a row. Aborting. Last error: ${err.message}`,
          severity: 'error',
        });
        break;
      }
    }
  }

  // Final checkpoint
  if (!DRY_RUN && sentCount > 0) {
    fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify({ sent: sentKeys, timestamp: new Date().toISOString() }, null, 2));
  }

  console.log(`\nDone: ${sentCount} sent, ${errorCount} errors`);

  // Delivery-safe snapshot: remove only fully-delivered shows from digest
  // Undelivered shows persist for next run (Pre-Mortem P0)
  if (!DRY_RUN) {
    const fullyDelivered = [];
    for (const [showId, needed] of Object.entries(emailsPerShow)) {
      if (sentPerShow[showId] >= needed) {
        fullyDelivered.push(showId);
      }
    }

    if (fullyDelivered.length > 0) {
      for (const showId of fullyDelivered) {
        delete digest.changes[showId];
      }
      fs.writeFileSync(DIGEST_PATH, JSON.stringify(digest, null, 2));
      console.log(`Removed ${fullyDelivered.length} fully-delivered shows from digest`);

      const remaining = Object.keys(digest.changes).length;
      if (remaining > 0) {
        console.log(`${remaining} shows with undelivered changes persist for next run`);
      }
    }
  }

  // Clean up checkpoint on full success
  if (!DRY_RUN && errorCount === 0 && sentCount >= sendQueue.length) {
    try { fs.unlinkSync(CHECKPOINT_PATH); } catch { /* ok */ }
    console.log('Checkpoint cleaned up (full success)');
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
