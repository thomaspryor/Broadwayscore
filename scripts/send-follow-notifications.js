#!/usr/bin/env node
/**
 * send-follow-notifications.js
 *
 * Reads show-changes-digest.json + followers.json, sends notification
 * emails via Resend for each show with meaningful changes and followers.
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

// High-priority change types — a single one of these warrants an email
const HIGH_PRIORITY_TYPES = ['status-change', 'cast-change', 'lottery-added', 'recoupment'];

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

function buildEmailHtml(showTitle, changes, showUrl) {
  const changesHtml = changes.map(c => {
    const icon = c.type === 'status-change' ? '&#127917;' :
                 c.type === 'new-reviews' ? '&#128221;' :
                 c.type === 'score-change' ? '&#128200;' :
                 c.type === 'cast-change' ? '&#127917;' :
                 c.type === 'lottery-added' ? '&#127922;' :
                 c.type === 'recoupment' ? '&#128176;' :
                 c.type === 'date-change' ? '&#128197;' : '&#8226;';
    return `<tr><td style="padding:6px 12px;font-size:15px;color:rgba(255,255,255,0.85);line-height:1.5;">${icon}&nbsp; ${escapeHtml(c.message)}</td></tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#0a0a0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#0a0a0f;padding:32px 16px;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
  <tr><td style="padding-bottom:24px;border-bottom:1px solid rgba(255,255,255,0.1);">
    <span style="font-size:14px;font-weight:600;color:#a78bfa;letter-spacing:0.5px;text-transform:uppercase;">Broadway Scorecard</span>
  </td></tr>
  <tr><td style="padding:28px 0 8px;">
    <h1 style="margin:0;font-size:22px;font-weight:700;color:#ffffff;line-height:1.3;">Updates for ${escapeHtml(showTitle)}</h1>
  </td></tr>
  <tr><td style="padding:16px 0;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background-color:rgba(255,255,255,0.05);border-radius:12px;border:1px solid rgba(255,255,255,0.08);">
      <tr><td style="padding:16px 12px 4px;">
        <p style="margin:0 0 8px 12px;font-size:12px;font-weight:600;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:0.5px;">What's new</p>
      </td></tr>
      ${changesHtml}
      <tr><td style="padding-bottom:12px;"></td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:8px 0 32px;" align="center">
    <a href="${escapeHtml(showUrl)}" style="display:inline-block;padding:12px 32px;background-color:#a78bfa;color:#0a0a0f;font-size:15px;font-weight:700;text-decoration:none;border-radius:8px;">View Full Details</a>
  </td></tr>
  <tr><td style="padding-top:24px;border-top:1px solid rgba(255,255,255,0.08);">
    <p style="margin:0;font-size:12px;color:rgba(255,255,255,0.3);line-height:1.6;">
      You're receiving this because you followed ${escapeHtml(showTitle)} on <a href="https://broadwayscorecard.com" style="color:rgba(255,255,255,0.4);">Broadway Scorecard</a>.
    </p>
  </td></tr>
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
  if (!digest || !digest.changes) {
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

  console.log(`\nSend queue: ${sendQueue.length} emails across ${changesEntries.length} changed shows`);
  console.log(`Budget: ${MAX_SENDS_PER_RUN} max sends per run`);

  // Budget pre-check
  if (sendQueue.length > MAX_SENDS_PER_RUN) {
    const msg = `Follow notifications budget exceeded: ${sendQueue.length} needed, ${MAX_SENDS_PER_RUN} max. Skipping send.`;
    console.error(msg);
    await sendAlert({
      title: 'Follow Notification Budget Exceeded',
      description: msg,
      severity: 'warning',
      fields: [
        { name: 'Queue Size', value: String(sendQueue.length) },
        { name: 'Budget', value: String(MAX_SENDS_PER_RUN) },
      ],
    });
    process.exit(0);
  }

  if (sendQueue.length === 0) {
    console.log('Nothing to send');
    process.exit(0);
  }

  // Send emails
  let sentCount = 0;
  let errorCount = 0;
  const sentKeys = [...alreadySent];

  for (const { showId, email, changes } of sendQueue) {
    const show = showsMap[showId];
    const showTitle = show?.title || showId;
    const showUrl = `https://broadwayscorecard.com/show/${show?.slug || showId}`;

    if (DRY_RUN) {
      console.log(`  [DRY] Would send to ${email.replace(/(.{2}).*(@.*)/, '$1***$2')} for ${showTitle}`);
      console.log(`         Changes: ${changes.map(c => c.message).join('; ')}`);
      sentCount++;
      continue;
    }

    try {
      await postJSON('https://api.resend.com/emails', {
        from: `Broadway Scorecard <${FROM_EMAIL}>`,
        to: [email],
        subject: `Updates for ${showTitle} on Broadway Scorecard`,
        html: buildEmailHtml(showTitle, changes, showUrl),
      }, {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
      });

      sentCount++;
      const key = `${showId}:${email}`;
      sentKeys.push(key);
      console.log(`  Sent to ${email.replace(/(.{2}).*(@.*)/, '$1***$2')} for ${showTitle} (${sentCount}/${sendQueue.length})`);

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

  // Clean up checkpoint on full success
  if (!DRY_RUN && errorCount === 0 && sentCount === sendQueue.length) {
    try { fs.unlinkSync(CHECKPOINT_PATH); } catch { /* ok */ }
    console.log('Checkpoint cleaned up (full success)');
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
