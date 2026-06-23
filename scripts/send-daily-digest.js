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
const AUDIT_DIR = path.join(__dirname, '..', 'data', 'audit');
const DRY_RUN = process.argv.includes('--dry-run');

/**
 * Balusters postmortem follow-through: aggregate exclusion-logger JSONL entries
 * from today + last 7 days (baseline) and surface:
 *   - today's top N reasons (by count)
 *   - reasons >2σ above the 7-day mean (spike detection)
 *   - reasons first seen within 7 days (novel — investigate)
 *
 * The Cote Notices regex bug went undetected for weeks because no aggregation
 * existed. Daily digest surfaces these patterns before they hit opening night.
 */
function computeExclusionTrend(now) {
  const todayKey = new Date(now).toISOString().slice(0, 10);
  const days = [];
  for (let i = 0; i < 8; i++) {
    days.push(new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10));
  }

  const perDay = new Map(); // day → Map<reason, count>
  const firstSeen = new Map(); // reason → day

  for (const day of days) {
    const p = path.join(AUDIT_DIR, `exclusions-${day}.jsonl`);
    if (!fs.existsSync(p)) continue;
    let content;
    try { content = fs.readFileSync(p, 'utf8'); } catch { continue; }
    const dayCounts = new Map();
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      const reason = rec.reason || 'unknown';
      dayCounts.set(reason, (dayCounts.get(reason) || 0) + 1);
      if (!firstSeen.has(reason) || day < firstSeen.get(reason)) {
        firstSeen.set(reason, day);
      }
    }
    perDay.set(day, dayCounts);
  }

  const today = perDay.get(todayKey) || new Map();
  const pastDays = days.slice(1).filter(d => perDay.has(d));
  const allReasons = new Set([...today.keys(), ...pastDays.flatMap(d => [...perDay.get(d).keys()])]);

  const trend = [];
  for (const reason of allReasons) {
    const todayCount = today.get(reason) || 0;
    const pastCounts = pastDays.map(d => (perDay.get(d) || new Map()).get(reason) || 0);
    const mean = pastCounts.length ? pastCounts.reduce((a, b) => a + b, 0) / pastCounts.length : 0;
    const variance = pastCounts.length
      ? pastCounts.reduce((a, b) => a + (b - mean) ** 2, 0) / pastCounts.length
      : 0;
    const stdev = Math.sqrt(variance);
    const threshold = mean + 2 * stdev;
    const spike = todayCount > threshold && todayCount >= 5;
    const novel = firstSeen.get(reason) >= days[6]; // first seen within last 7 days
    trend.push({
      reason,
      todayCount,
      mean: Math.round(mean * 10) / 10,
      stdev: Math.round(stdev * 10) / 10,
      threshold: Math.round(threshold * 10) / 10,
      spike,
      novel,
      firstSeen: firstSeen.get(reason),
    });
  }

  const spikes = trend.filter(t => t.spike).sort((a, b) => b.todayCount - a.todayCount);
  const novelReasons = trend.filter(t => t.novel && t.todayCount > 0).sort((a, b) => b.todayCount - a.todayCount);
  const topToday = trend.filter(t => t.todayCount > 0).sort((a, b) => b.todayCount - a.todayCount).slice(0, 10);

  return { spikes, novelReasons, topToday, todayTotal: [...today.values()].reduce((a, b) => a + b, 0) };
}

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

    // Score changes — only surface when the *displayed* (rounded) score flips.
    // cs is stored as a float but the site rounds to a whole number, so
    // sub-integer wobble (78.17 → 78.57) is noise, not a real move. Each flip
    // carries the review delta that drove it, so we don't repeat the show list
    // in a separate New Reviews section.
    if (currShow.cs != null && prevShow.cs != null && Math.round(currShow.cs) !== Math.round(prevShow.cs)) {
      const from = Math.round(prevShow.cs);
      const to = Math.round(currShow.cs);
      changes.scoreChanges.push({
        id, slug: currShow.s, title: currShow.t, from, to,
        direction: to > from ? 'up' : 'down',
        reviewsAdded: currRc - prevRc, reviewTotal: currRc, market,
      });
    } else if (currShow.cs != null && prevShow.cs == null) {
      // First score assigned
      changes.scoreChanges.push({
        id, slug: currShow.s, title: currShow.t, from: null, to: Math.round(currShow.cs),
        direction: 'new', reviewsAdded: currRc - prevRc, reviewTotal: currRc, market,
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

  // Compute exclusion trend (independent of show-snapshot changes).
  // Emits a summary even if no show-level changes occurred — silent-drop trends
  // still need to surface.
  const exclusionTrend = computeExclusionTrend(new Date());

  // First run — save snapshot, skip email
  if (!prevSnapshot) {
    console.log('No previous snapshot found — saving initial snapshot, skipping email.');
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(currSnapshot, null, 2));
    return;
  }

  const changes = diffSnapshots(prevSnapshot, currSnapshot);
  const today = currSnapshot.date;
  changes.exclusionTrend = exclusionTrend;

  const hasExclusionSignal = exclusionTrend.spikes.length > 0 || exclusionTrend.novelReasons.length > 0;
  if (!hasChanges(changes) && !hasExclusionSignal) {
    console.log('No changes or exclusion signals detected — skipping email.');
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
