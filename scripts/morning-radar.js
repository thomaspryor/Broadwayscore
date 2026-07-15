#!/usr/bin/env node
/**
 * morning-radar.js — Opening Night Radar for /morning-briefing skill
 *
 * Reads 4 JSON files and outputs a compact JSON array of shows opening
 * in the next 7 days with readiness status (DTLI, BWW, broadcast).
 *
 * Usage: node scripts/morning-radar.js [--days N]
 */

const fs = require('fs');
const path = require('path');
const {
  hasEmptyCast,
  isPlaceholderSynopsis,
  hasStaleUpcomingTag,
  hasSameMarketTitleMatch,
} = require('./lib/opening-night-completeness.js');

const dataDir = path.join(__dirname, '..', 'data');

function loadJSON(filename) {
  const filepath = path.join(dataDir, filename);
  if (!fs.existsSync(filepath)) return null;
  return JSON.parse(fs.readFileSync(filepath, 'utf8'));
}

const daysArg = process.argv.includes('--days')
  ? parseInt(process.argv[process.argv.indexOf('--days') + 1], 10)
  : 7;

const shows = loadJSON('shows.json');
if (!shows || !shows.shows) {
  console.error('ERROR: data/shows.json missing or invalid');
  process.exit(1);
}

const sentData = loadJSON('opening-night-sent.json') || { shows: {} };
const dtliData = loadJSON('dtli-slug-map.json') || { shows: {} };
const bwwData = loadJSON('bww-roundup-urls.json') || {};

const now = new Date();
const cutoff = new Date(now.getTime() + daysArg * 24 * 60 * 60 * 1000);

const upcoming = shows.shows.filter(s => {
  if (!s.openingDate) return false;
  const d = new Date(s.openingDate + 'T00:00:00');
  return d >= now && d <= cutoff;
});

upcoming.sort((a, b) => a.openingDate.localeCompare(b.openingDate));

const results = upcoming.map(s => {
  const market = s.category || 'broadway';
  const hasDtli = !!(dtliData.shows && dtliData.shows[s.id]);
  const hasBww = !!bwwData[s.id];
  const sent = sentData.shows || {};
  // Broadcasts only go out for Broadway and West End — not OB/OWE
  const broadcastMarket = market === 'broadway' || market === 'west-end';
  const broadcastSent = broadcastMarket
    ? !!(sent[s.id]?.completed || sent[`${market}:${s.id}`]?.completed)
    : null; // null = not applicable

  // Metadata completeness — surfaces the class of bug that shipped The Whoopi
  // Monologues live with cast:[] and a placeholder synopsis (card #189). These
  // are 'warning' severity in the hourly checklist (never emailed per
  // feedback_actionable_only_email_alerts.md), so the morning radar is the
  // pull-based surface where a human actually sees them before publicizing.
  const completenessIssues = [];
  if (s.status !== 'closed') {
    if (hasEmptyCast(s)) completenessIssues.push('empty cast');
    if (isPlaceholderSynopsis(s.synopsis)) completenessIssues.push('thin/placeholder synopsis');
    if (hasStaleUpcomingTag(s)) completenessIssues.push("stale 'upcoming' tag");
    if (s.isRevival !== true && hasSameMarketTitleMatch(s, shows.shows)) completenessIssues.push('unverified revival');
  }

  return {
    id: s.id,
    title: s.title,
    date: s.openingDate,
    market,
    hasDtli,
    hasBww,
    broadcastSent,
    status: s.status,
    completenessIssues
  };
});

console.log(JSON.stringify(results, null, 2));
