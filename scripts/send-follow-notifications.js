#!/usr/bin/env node
/**
 * send-follow-notifications.js
 *
 * Reads show-changes-digest.json + followers.json, sends transactional
 * emails via Loops.so for each show with meaningful changes and followers.
 *
 * Usage: node scripts/send-follow-notifications.js [--dry-run]
 *
 * Env: LOOPS_API_KEY, LOOPS_TRANSACTIONAL_ID, DISCORD_WEBHOOK_ALERTS
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

// Budget: Loops free tier = 2,000 emails/month, reserve 400 for newsletter captures
const MONTHLY_LIMIT = 2000;
const BUDGET_RESERVE = 400;
const MAX_SENDS_PER_RUN = MONTHLY_LIMIT - BUDGET_RESERVE;

// High-priority change types — a single one of these warrants an email
const HIGH_PRIORITY_TYPES = ['status-change', 'cast-change', 'lottery-added', 'recoupment'];

function loadJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
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
  // Anti-spam: only send if 2+ changes OR 1 high-priority change
  if (!changes || changes.length === 0) return false;
  const hasHighPriority = changes.some(c => HIGH_PRIORITY_TYPES.includes(c.type));
  return hasHighPriority || changes.length >= 2;
}

function formatChanges(changes) {
  return changes.map(c => `- ${c.message}`).join('\n');
}

function formatChangesHtml(changes) {
  return '<ul>' + changes.map(c => `<li>${c.message}</li>`).join('') + '</ul>';
}

async function main() {
  const LOOPS_API_KEY = process.env.LOOPS_API_KEY;
  const LOOPS_TRANSACTIONAL_ID = process.env.LOOPS_TRANSACTIONAL_ID;

  if (!LOOPS_API_KEY || !LOOPS_TRANSACTIONAL_ID) {
    console.log('Missing LOOPS_API_KEY or LOOPS_TRANSACTIONAL_ID — skipping sends');
    if (!DRY_RUN) process.exit(0);
  }

  console.log('Send Follow Notifications');
  console.log('=========================\n');
  if (DRY_RUN) console.log('** DRY RUN — no emails will be sent **\n');

  // Load data
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

  // Filter to shows with both changes and followers
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
      await postJSON('https://app.loops.so/api/v1/transactional', {
        transactionalId: LOOPS_TRANSACTIONAL_ID,
        email,
        dataVariables: {
          showTitle,
          changes: formatChanges(changes),
          changesHtml: formatChangesHtml(changes),
          showUrl,
        },
      }, {
        'Authorization': `Bearer ${LOOPS_API_KEY}`,
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

      // Rate limit: 100ms between sends
      await sleep(100);
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

  // Clean up checkpoint on full success (no errors, all sent)
  if (!DRY_RUN && errorCount === 0 && sentCount === sendQueue.length) {
    try { fs.unlinkSync(CHECKPOINT_PATH); } catch { /* ok */ }
    console.log('Checkpoint cleaned up (full success)');
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
