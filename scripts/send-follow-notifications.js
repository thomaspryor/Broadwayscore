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
const https = require('https');
const { sendAlert } = require('./lib/discord-notify');

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
const FONT = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";

// High-priority change types — a single one of these warrants an email
const HIGH_PRIORITY_TYPES = ['opening-night', 'status-change', 'cast-change', 'lottery-added', 'recoupment'];

function loadJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function postJSON(url, body, headers) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const data = JSON.stringify(body);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };

    const req = https.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => responseBody += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(responseBody)); } catch { resolve(responseBody); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${responseBody.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function shouldNotify(changes) {
  if (!changes || changes.length === 0) return false;
  const hasHighPriority = changes.some(c => HIGH_PRIORITY_TYPES.includes(c.type));
  return hasHighPriority || changes.length >= 2;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function getScoreColor(score) {
  if (score == null) return { bg: '#6b7280', text: '#ffffff', label: 'TBD' };
  if (score >= 85) return { bg: '#FFD700', text: '#1a1a1a', label: 'Must-See' };
  if (score >= 75) return { bg: '#22c55e', text: '#ffffff', label: 'Recommended' };
  if (score >= 65) return { bg: '#14b8a6', text: '#ffffff', label: 'Worth Seeing' };
  if (score >= 55) return { bg: '#f59e0b', text: '#1a1a1a', label: 'Skippable' };
  return { bg: '#ef4444', text: '#ffffff', label: 'Stay Away' };
}

function buildUnfollowUrl(showId, showTitle, email) {
  return `https://broadwayscorecard.com/unfollow?email=${encodeURIComponent(email)}&show=${encodeURIComponent(showId)}&title=${encodeURIComponent(showTitle)}`;
}

function buildFooterHtml(showTitle, showId, email) {
  const unfollowUrl = buildUnfollowUrl(showId, showTitle, email);
  return `<tr><td style="padding-top:20px;border-top:1px solid rgba(255,255,255,0.06);">
    <p style="margin:0;font-size:12px;color:rgba(255,255,255,0.25);line-height:1.6;font-family:${FONT};">
      You're receiving this because you followed ${escapeHtml(showTitle)} on <a href="https://broadwayscorecard.com" style="color:#d4a574;">Broadway Scorecard</a>.<br>
      <a href="${escapeHtml(unfollowUrl)}" style="color:rgba(255,255,255,0.35);">Unfollow this show</a>
    </p>
  </td></tr>`;
}

function buildEmailHtml(showTitle, changes, showUrl, showId, email) {
  const changesHtml = changes.map(c => {
    return `<tr><td style="padding:8px 20px;font-size:15px;color:rgba(255,255,255,0.85);line-height:1.5;font-family:${FONT};border-left:2px solid #d4a574;">&#8226;&nbsp; ${escapeHtml(c.message)}</td></tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#0f0f14;font-family:${FONT};">
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#0f0f14;padding:32px 16px;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
  <tr><td style="padding-bottom:20px;border-bottom:1px solid rgba(212,165,116,0.2);">
    <span style="font-size:14px;font-weight:600;color:#d4a574;letter-spacing:0.5px;text-transform:uppercase;font-family:${FONT};">Broadway Scorecard</span>
  </td></tr>
  <tr><td style="padding:28px 0 8px;">
    <h1 style="margin:0;font-size:22px;font-weight:700;color:#ffffff;line-height:1.3;font-family:${FONT};">Updates for ${escapeHtml(showTitle)}</h1>
  </td></tr>
  <tr><td style="padding:16px 0;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#1a1a24;border-radius:12px;border:1px solid rgba(212,165,116,0.12);">
      <tr><td style="padding:16px 20px 4px;">
        <p style="margin:0 0 8px;font-size:11px;font-weight:600;color:rgba(212,165,116,0.6);text-transform:uppercase;letter-spacing:0.8px;font-family:${FONT};">What's new</p>
      </td></tr>
      ${changesHtml}
      <tr><td style="padding-bottom:12px;"></td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:8px 0 32px;" align="center">
    <a href="${escapeHtml(showUrl)}" style="display:inline-block;padding:12px 32px;background-color:#d4a574;color:#0f0f14;font-size:14px;font-weight:700;text-decoration:none;border-radius:8px;font-family:${FONT};">View Full Details</a>
  </td></tr>
  ${buildFooterHtml(showTitle, showId, email)}
</table>
</td></tr></table>
</body></html>`;
}

function buildOpeningNightHtml(showTitle, openingChange, otherChanges, showUrl, showId, email) {
  const sc = getScoreColor(openingChange.score);
  const scoreDisplay = openingChange.score != null ? Math.round(openingChange.score) : '?';
  const reviewCount = openingChange.reviewCount || 0;
  const positive = openingChange.positive || 0;
  const mixed = openingChange.mixed || 0;
  const negative = openingChange.negative || 0;
  const total = positive + mixed + negative;

  // Review subtitle
  const reviewSubtitle = reviewCount > 0
    ? `Based on ${reviewCount} Critic Review${reviewCount !== 1 ? 's' : ''}`
    : 'Reviews pending';

  // Breakdown bar widths (percentage, min 1% if nonzero to stay visible)
  let posW = 0, mixW = 0, negW = 0;
  if (total > 0) {
    posW = Math.max(Math.round(positive / total * 100), positive > 0 ? 1 : 0);
    negW = Math.max(Math.round(negative / total * 100), negative > 0 ? 1 : 0);
    mixW = 100 - posW - negW;
    if (mixW < 0) mixW = 0;
    if (mixed > 0 && mixW === 0) { mixW = 1; posW = Math.max(posW - 1, 0); }
  }

  // Breakdown bar HTML (only show if we have reviews)
  const breakdownHtml = total > 0 ? `
  <tr><td style="padding:16px 24px 0;">
    <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden;">
      <tr>
        ${posW > 0 ? `<td style="width:${posW}%;height:8px;background-color:#22c55e;"></td>` : ''}
        ${mixW > 0 ? `<td style="width:${mixW}%;height:8px;background-color:#f59e0b;"></td>` : ''}
        ${negW > 0 ? `<td style="width:${negW}%;height:8px;background-color:#ef4444;"></td>` : ''}
      </tr>
    </table>
  </td></tr>
  <tr><td style="padding:8px 24px 0;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="font-size:12px;color:rgba(255,255,255,0.5);font-family:${FONT};">
          <span style="color:#22c55e;font-weight:600;">${positive}</span> Positive
        </td>
        <td align="center" style="font-size:12px;color:rgba(255,255,255,0.5);font-family:${FONT};">
          <span style="color:#f59e0b;font-weight:600;">${mixed}</span> Mixed
        </td>
        <td align="right" style="font-size:12px;color:rgba(255,255,255,0.5);font-family:${FONT};">
          <span style="color:#ef4444;font-weight:600;">${negative}</span> Negative
        </td>
      </tr>
    </table>
  </td></tr>` : '';

  // Consensus block (only show if available)
  const consensusHtml = openingChange.consensusText ? `
  <tr><td style="padding:20px 24px 0;">
    <p style="margin:0 0 6px;font-size:11px;font-weight:600;color:rgba(212,165,116,0.6);text-transform:uppercase;letter-spacing:0.8px;font-family:${FONT};">Critics' Take</p>
    <p style="margin:0;font-size:14px;color:rgba(255,255,255,0.75);line-height:1.6;font-style:italic;font-family:${FONT};">"${escapeHtml(openingChange.consensusText)}"</p>
  </td></tr>` : '';

  // Show type + venue line
  const metaParts = [];
  if (openingChange.showType) metaParts.push(openingChange.showType);
  if (openingChange.venue) metaParts.push(openingChange.venue);
  const metaHtml = metaParts.length > 0 ? `
  <tr><td style="padding:16px 24px 0;">
    <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.35);font-family:${FONT};">${escapeHtml(metaParts.join(' \u00B7 '))}</p>
  </td></tr>` : '';

  // Other changes (lottery added, etc.) as bullet items below the card
  const otherHtml = otherChanges.length > 0 ? `
  <tr><td style="padding:20px 0 0;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#1a1a24;border-radius:12px;border:1px solid rgba(212,165,116,0.12);">
      <tr><td style="padding:16px 20px 4px;">
        <p style="margin:0 0 8px;font-size:11px;font-weight:600;color:rgba(212,165,116,0.6);text-transform:uppercase;letter-spacing:0.8px;font-family:${FONT};">Also new</p>
      </td></tr>
      ${otherChanges.map(c => `<tr><td style="padding:8px 20px;font-size:15px;color:rgba(255,255,255,0.85);line-height:1.5;font-family:${FONT};border-left:2px solid #d4a574;">&#8226;&nbsp; ${escapeHtml(c.message)}</td></tr>`).join('')}
      <tr><td style="padding-bottom:12px;"></td></tr>
    </table>
  </td></tr>` : '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#0f0f14;font-family:${FONT};">
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#0f0f14;padding:32px 16px;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
  <tr><td style="padding-bottom:20px;border-bottom:1px solid rgba(212,165,116,0.2);">
    <span style="font-size:14px;font-weight:600;color:#d4a574;letter-spacing:0.5px;text-transform:uppercase;font-family:${FONT};">Broadway Scorecard</span>
  </td></tr>
  <tr><td style="padding:28px 0 8px;">
    <h1 style="margin:0;font-size:24px;font-weight:700;color:#ffffff;line-height:1.3;font-family:${FONT};">${escapeHtml(showTitle)} Is Now Open</h1>
  </td></tr>
  <tr><td style="padding:16px 0;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#1a1a24;border-radius:12px;border:1px solid rgba(212,165,116,0.12);">
      <tr><td style="padding:24px;">
        <table cellpadding="0" cellspacing="0">
          <tr>
            <td style="width:72px;height:72px;background-color:${sc.bg};border-radius:12px;text-align:center;vertical-align:middle;">
              <span style="font-size:32px;font-weight:800;color:${sc.text};font-family:${FONT};line-height:72px;">${scoreDisplay}</span>
            </td>
            <td style="padding-left:16px;vertical-align:middle;">
              <p style="margin:0 0 4px;font-size:18px;font-weight:700;color:${sc.bg};font-family:${FONT};">${sc.label}</p>
              <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.5);font-family:${FONT};">${reviewSubtitle}</p>
            </td>
          </tr>
        </table>
      </td></tr>
      ${breakdownHtml}
      ${consensusHtml}
      ${metaHtml}
      <tr><td style="padding-bottom:20px;"></td></tr>
    </table>
  </td></tr>
  ${otherHtml}
  <tr><td style="padding:8px 0 32px;" align="center">
    <a href="${escapeHtml(showUrl)}" style="display:inline-block;padding:12px 32px;background-color:#d4a574;color:#0f0f14;font-size:14px;font-weight:700;text-decoration:none;border-radius:8px;font-family:${FONT};">View Full Details</a>
  </td></tr>
  ${buildFooterHtml(showTitle, showId, email)}
</table>
</td></tr></table>
</body></html>`;
}

async function main() {
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
    const showUrl = `https://broadwayscorecard.com/show/${show?.slug || showId}`;

    // Route: opening-night → rich template, else → generic
    const openingNight = changes.find(c => c.type === 'opening-night');
    const otherChanges = changes.filter(c => c.type !== 'opening-night');

    const html = openingNight
      ? buildOpeningNightHtml(showTitle, openingNight, otherChanges, showUrl, showId, email)
      : buildEmailHtml(showTitle, changes, showUrl, showId, email);

    const subject = openingNight
      ? `${showTitle} is now open on Broadway${openingNight.score ? ` \u2014 Critic Score: ${Math.round(openingNight.score)}` : ''}`
      : `Updates for ${showTitle} on Broadway Scorecard`;

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
        from: `Broadway Scorecard <${FROM_EMAIL}>`,
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
