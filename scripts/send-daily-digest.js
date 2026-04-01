#!/usr/bin/env node
/**
 * Daily Digest Email
 *
 * Compares current public/data/mobile-shows.json against yesterday's snapshot
 * to detect: new shows, new reviews, score changes, audience grade changes.
 * Sends a summary email via Resend, then saves the new snapshot.
 *
 * Usage:
 *   node scripts/send-daily-digest.js [--dry-run]
 *
 * Env vars: RESEND_API_KEY, OWNER_EMAIL
 */

const fs = require('fs');
const path = require('path');
const { postJSON, buildDailyDigestHtml } = require('./lib/email-templates');

const MOBILE_DATA = path.join(__dirname, '..', 'public', 'data', 'mobile-shows.json');
const SNAPSHOT_FILE = path.join(__dirname, '..', 'data', 'audit', 'daily-snapshot.json');
const DRY_RUN = process.argv.includes('--dry-run');

function loadSnapshot() {
  try {
    return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function buildSnapshot(mobileData) {
  const snapshot = { date: new Date().toISOString().slice(0, 10), shows: {} };
  for (const show of mobileData.shows) {
    snapshot.shows[show.id] = {
      t: show.t,
      s: show.s,
      cs: show.cs ?? null,
      rc: show.cr?.rc ?? 0,
      ag: show.ag?.g ?? null,
      st: show.st,
      ty: show.ty,
      v: show.v,
      mk: show.cat === 'west-end' ? 'west-end' : 'broadway',
    };
  }
  return snapshot;
}

function diffSnapshots(prev, curr) {
  const changes = { newShows: [], newReviews: [], scoreChanges: [], audienceChanges: [] };
  const prevShows = prev.shows;
  const currShows = curr.shows;

  for (const [id, currShow] of Object.entries(currShows)) {
    const prevShow = prevShows[id];

    const market = currShow.mk || 'broadway';

    // New show
    if (!prevShow) {
      changes.newShows.push({
        id, slug: currShow.s, title: currShow.t, type: currShow.ty, status: currShow.st,
        venue: currShow.v, market,
      });
      continue;
    }

    // New reviews
    const prevRc = prevShow.rc ?? 0;
    const currRc = currShow.rc ?? 0;
    if (currRc > prevRc) {
      changes.newReviews.push({
        id, slug: currShow.s, title: currShow.t, added: currRc - prevRc, total: currRc,
        prevCount: prevRc, market,
      });
    }

    // Score changes (only when both have scores — skip undefined→defined on first scoring)
    if (currShow.cs != null && prevShow.cs != null && currShow.cs !== prevShow.cs) {
      changes.scoreChanges.push({
        id, slug: currShow.s, title: currShow.t, from: prevShow.cs, to: currShow.cs,
        direction: currShow.cs > prevShow.cs ? 'up' : 'down', market,
      });
    } else if (currShow.cs != null && prevShow.cs == null) {
      // First score assigned
      changes.scoreChanges.push({
        id, slug: currShow.s, title: currShow.t, from: null, to: currShow.cs, direction: 'new', market,
      });
    }

    // Audience grade changes
    if (currShow.ag && prevShow.ag && currShow.ag !== prevShow.ag) {
      changes.audienceChanges.push({
        id, slug: currShow.s, title: currShow.t, from: prevShow.ag, to: currShow.ag, market,
      });
    } else if (currShow.ag && !prevShow.ag) {
      changes.audienceChanges.push({
        id, slug: currShow.s, title: currShow.t, from: null, to: currShow.ag, market,
      });
    }
  }

  // Flag suspicious changes: >24 reviews added in a single day is abnormal
  changes.suspiciousChanges = changes.newReviews.filter(r => r.added > 24);
  // Also flag shows with >10 new reviews — likely tour contamination
  const spikeShows = changes.newReviews.filter(r => r.added > 10 && r.added <= 24);
  if (spikeShows.length > 0) {
    changes.reviewSpikes = spikeShows;
  }
  // Remove suspicious entries from newReviews so they aren't double-counted
  if (changes.suspiciousChanges.length > 0) {
    changes.newReviews = changes.newReviews.filter(r => r.added <= 24);
  }

  return changes;
}

function hasChanges(changes) {
  return changes.newShows.length + changes.newReviews.length +
    changes.scoreChanges.length + changes.audienceChanges.length +
    (changes.suspiciousChanges || []).length > 0;
}

async function sendEmail(html, subject) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.OWNER_EMAIL;
  if (!apiKey || !to) {
    console.error('Missing RESEND_API_KEY or OWNER_EMAIL');
    process.exit(1);
  }

  await postJSON('https://api.resend.com/emails', {
    from: 'Broadway Scorecard <updates@broadwayscorecard.com>',
    to: [to],
    subject,
    html,
  }, { Authorization: `Bearer ${apiKey}` });

  console.log(`Email sent to ${to}`);
}

async function main() {
  const mobileData = JSON.parse(fs.readFileSync(MOBILE_DATA, 'utf8'));
  const currSnapshot = buildSnapshot(mobileData);
  const prevSnapshot = loadSnapshot();

  // First run — save snapshot, skip email
  if (!prevSnapshot) {
    console.log('No previous snapshot found — saving initial snapshot, skipping email.');
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(currSnapshot, null, 2));
    return;
  }

  const changes = diffSnapshots(prevSnapshot, currSnapshot);
  const today = currSnapshot.date;

  if (!hasChanges(changes)) {
    console.log('No changes detected — skipping email.');
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(currSnapshot, null, 2));
    return;
  }

  // Build and send email
  const suspiciousCount = (changes.suspiciousChanges || []).length;
  const spikeCount = (changes.reviewSpikes || []).length;
  const totalChanges = changes.newShows.length + changes.newReviews.length +
    changes.scoreChanges.length + changes.audienceChanges.length + suspiciousCount;
  const warnings = suspiciousCount + spikeCount;
  const subject = warnings > 0
    ? `⚠️ Daily Digest: ${totalChanges} changes (${warnings} warning${warnings !== 1 ? 's' : ''}) on ${today}`
    : `Daily Digest: ${totalChanges} change${totalChanges !== 1 ? 's' : ''} on ${today}`;
  const html = buildDailyDigestHtml(changes, today);

  if (DRY_RUN) {
    console.log('DRY RUN — would send email:');
    console.log(`  Subject: ${subject}`);
    console.log(`  New shows: ${changes.newShows.length}`);
    console.log(`  New reviews: ${changes.newReviews.length} shows`);
    console.log(`  Score changes: ${changes.scoreChanges.length}`);
    console.log(`  Audience changes: ${changes.audienceChanges.length}`);
    console.log(`  Suspicious changes: ${suspiciousCount}`);
    fs.writeFileSync('/tmp/daily-digest-preview.html', html);
    console.log('  HTML preview: /tmp/daily-digest-preview.html');
  } else {
    await sendEmail(html, subject);
  }

  // Save new snapshot
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(currSnapshot, null, 2));
  console.log('Snapshot updated.');
}

main().catch(err => { console.error(err); process.exit(1); });
