#!/usr/bin/env node
/**
 * generate-subject-line.js — standalone Weekly Round-up subject line generator
 * (BRO-42). The static "Weekly Round-up · May 18 – May 24, 2026 (preview)"
 * subject says nothing about what's inside; this surfaces the week's actual
 * news — openings, the buzziest show, closings — the same way a human editor
 * would lead an email.
 *
 * Reuses the production newsworthiness scorer (scripts/newsletter/
 * newsworthiness.mjs's scoreCandidates/buildSubjectFromCandidates) so the
 * weighting and phrasing rules stay in ONE place rather than forked here —
 * that module is what scripts/newsletter/generate.mjs's live subject/lede
 * already runs on. This script only gathers this week's candidate stories
 * from data/shows.json + the public slim files and hands them to the scorer.
 *
 * Candidate sources (kept intentionally to the three the ticket asks for —
 * openings, buzziest show, closings; generate.mjs's fuller pipeline also
 * feeds recoupments/Tony/box-office movers, which need state this standalone
 * script doesn't have: prior-week snapshots, cast-changes history, etc.):
 *   - Broadway openings: openingDate OR reopeningDate in the last 7 days
 *     (ending on --date), with a public Critic Score (cs != null on the slim
 *     file — the same review-count gate canonical-critic-scores.ts
 *     documents). No status filter — mirrors generate.mjs's
 *     openingEventsForWeek(), which doesn't gate on status either: a show can
 *     still carry status:'previews' the week it opens (flip lag) or
 *     status:'closed' after a short reopening run (e.g. Can I Be Frank).
 *   - Off-Broadway openings: openingDate in the last 21 days, status 'open'.
 *     The 14-day grace beyond the normal 7-day window mirrors
 *     offBroadwayOpenings()'s documented fix for late-DB-added OB shows
 *     (generate.mjs: "Heated Rivalry" case).
 *   - West End / Off West End openings: openingDate in the last 7 days,
 *     status 'open' — this script doesn't replicate weOpeningStories()'s
 *     full logic, just the review-count + date gates.
 *   - Closings: closingDate in the next 7 days (from --date), status 'open'
 *     — mirrors the site's "Closing this Week" convention (forward-looking).
 *   - Buzziest show: best (lowest) social-pulse rank position across fresh
 *     (<=10 days old) public/data/shows/*.social.json files, the same source
 *     generate.mjs's buzziestSection() body card reads. There's no prior-week
 *     snapshot here to detect a CHANGE of #1, so `changed` is always true —
 *     documented in code, not hidden.
 *
 * Usage:
 *   node scripts/generate-subject-line.js                        this week, Broadway edition
 *   node scripts/generate-subject-line.js --date=2026-08-24       week ending the given date
 *   node scripts/generate-subject-line.js --edition=west-end       West End edition
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { isOperaShow } = require('./lib/opera-prompt-context');
const { classifyOpeningEvent } = require('./lib/opening-events-for-week');

const repo = path.join(__dirname, '..');

function parseArgs(argv) {
  const out = { date: null, edition: 'broadway' };
  for (const arg of argv) {
    const m = /^--(date|edition)=(.+)$/.exec(arg);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function loadJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(repo, relPath), 'utf8'));
}

// Public Critic Score for a show, straight from its slim public file — the
// same canonical source CLAUDE.md's canonical-critic-scores.ts wraps. `cs` is
// only set once a show clears the review-count threshold, so `cs != null`
// doubles as "has enough reviews to be newsworthy" (mirrors scripts/audit-
// score-public-since.js, which reads this same field the same way).
function getCriticScore(showId) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(repo, 'public/data/shows', `${showId}.json`), 'utf8'));
    return typeof j.cs === 'number' ? j.cs : null;
  } catch {
    return null;
  }
}

function findBuzziestShow(shows, refDate, markets) {
  const socialDir = path.join(repo, 'public/data/shows');
  const staleCutoff = new Date(refDate); staleCutoff.setDate(staleCutoff.getDate() - 10);
  let best = null; // { show, position }
  for (const s of shows) {
    if (!['open', 'previews'].includes(s.status)) continue;
    if (!markets.includes(s.category)) continue;
    if (isOperaShow(s)) continue;
    const f = path.join(socialDir, `${s.id}.social.json`);
    if (!fs.existsSync(f)) continue;
    let sp;
    try { sp = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    if (sp.t === 'Hidden' || !sp.r) continue;
    const fetchedAt = sp.u ? new Date(sp.u) : null;
    if (!fetchedAt || Number.isNaN(fetchedAt.getTime()) || fetchedAt < staleCutoff) continue;
    const m = /^(\d+)\/(\d+)\s+/.exec(sp.r);
    if (!m) continue;
    const position = Number(m[1]);
    if (!best || position < best.position) best = { show: s, position };
  }
  return best;
}

async function main() {
  const { date: argDate, edition } = parseArgs(process.argv.slice(2));
  if (edition !== 'broadway' && edition !== 'west-end') {
    console.error(`Unknown --edition=${edition} (expected 'broadway' or 'west-end')`);
    process.exit(1);
  }
  const isWe = edition === 'west-end';
  const primaryMarkets = isWe ? ['west-end', 'off-west-end'] : ['broadway', 'off-broadway'];

  const refDate = argDate ? new Date(`${argDate}T12:00:00`) : new Date();
  if (Number.isNaN(refDate.getTime())) {
    console.error(`Invalid --date=${argDate} (expected YYYY-MM-DD)`);
    process.exit(1);
  }
  const refStr = refDate.toISOString().slice(0, 10);
  const daysAgoStr = (n) => { const d = new Date(refDate); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
  const weekAgoStr = daysAgoStr(7);
  const obGraceStr = daysAgoStr(21); // 7-day window + 14-day grace, see header comment
  const weekAhead = new Date(refDate); weekAhead.setDate(weekAhead.getDate() + 7);
  const weekAheadStr = weekAhead.toISOString().slice(0, 10);

  const { shows } = loadJson('data/shows.json');

  const inWeek = (dateStr) => !!dateStr && dateStr > weekAgoStr && dateStr <= refStr;

  // isReopening via classifyOpeningEvent (scripts/lib/opening-events-for-week.js):
  // reopeningDate takes precedence when both dates fall in the same week —
  // same BRO-2594 precedence fix as generate.mjs's openingEventsForWeek().
  const bwOpenings = isWe ? [] : shows
    .filter(s => s.category === 'broadway' && !isOperaShow(s) && getCriticScore(s.id) != null)
    .filter(s => inWeek(s.openingDate) || inWeek(s.reopeningDate))
    .map(show => ({ show, isReopening: classifyOpeningEvent(show, inWeek).isReopening }));

  const obOpenings = isWe ? [] : shows
    .filter(s => s.category === 'off-broadway' && s.status === 'open' && !isOperaShow(s)
      && s.openingDate && s.openingDate > obGraceStr && s.openingDate <= refStr
      && getCriticScore(s.id) != null)
    .map(show => ({ show }));

  const weGoldOpenings = isWe ? shows
    .filter(s => primaryMarkets.includes(s.category) && s.status === 'open' && !isOperaShow(s)
      && inWeek(s.openingDate) && getCriticScore(s.id) != null)
    .map(show => ({ show })) : [];

  const closings = shows.filter(s =>
    s.closingDate && s.closingDate > refStr && s.closingDate <= weekAheadStr
    && s.status === 'open' && primaryMarkets.includes(s.category) && !isOperaShow(s));

  const buzziest = findBuzziestShow(shows, refDate, primaryMarkets);

  const { scoreCandidates, buildSubjectFromCandidates } = await import('./newsletter/newsworthiness.mjs');

  const aggregateScore = (showId) => {
    const avg = getCriticScore(showId);
    return avg == null ? null : { avg, count: 1 };
  };

  const candidates = scoreCandidates({
    edition,
    bwOpenings,
    obOpenings,
    weGoldOpenings,
    aggregateScore,
    closingsThisWeek: closings,
    buzziest: buzziest ? { show: buzziest.show, changed: true } : null,
  });

  const { subject } = buildSubjectFromCandidates(candidates);
  console.log(subject);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
