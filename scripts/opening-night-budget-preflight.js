#!/usr/bin/env node
/**
 * Workflow-side budget pre-flight for opening-night-orchestrator.
 *
 * Reads --shows=ID1,ID2 (comma-separated, comes from the orchestrator's
 * `find` step) and ALSO scans shows.json for any other shows opening in
 * the next 24h that the per-shift `find` filtered out (e.g. a parallel
 * West End shift covering different markets). The cross-shift cohort is
 * the right denominator for SB/GHA budget — both shifts draw from the
 * same monthly pool.
 *
 * Then:
 *   - prints a human-readable summary
 *   - if !ok: identifies the show(s) that push over each blocked resource;
 *     when multiple shows share an opening date, attributes the breakage
 *     to the cohort rather than a single show
 *   - fires a Discord alert (severity=error, no cooldown) if blockers
 *     are present and DISCORD_WEBHOOK_ALERTS is set
 *   - exits 0 on success and on its own internal failures (continue-on-error
 *     semantics; any uncaught throw logs ::error:: first)
 *
 * Usage:
 *   node scripts/opening-night-budget-preflight.js --shows=show-a,show-b,show-c
 *   SHOWS=a,b,c node scripts/opening-night-budget-preflight.js
 *
 * Env:
 *   SHOWS                  — comma-separated show IDs (or pass --shows=)
 *   SCRAPINGBEE_API_KEY    — for live SB remaining
 *   GHA_BILLING_PAT        — optional, for live GHA-minutes remaining (PAT
 *                            with user+billing scopes; GITHUB_TOKEN won't work)
 *   DISCORD_WEBHOOK_ALERTS — to fire the alert; if absent, prints to stdout only
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { checkBudget, fetchLiveUsage } = require('./lib/opening-night-budget');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (const a of args) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
    else if (a.startsWith('--')) out[a.slice(2)] = true;
  }
  return out;
}

function loadShowMap() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'shows.json'), 'utf8'));
    const list = data.shows || data;
    const map = {};
    for (const s of list) map[s.id] = s;
    return map;
  } catch {
    return {};
  }
}

/**
 * Find shows in shows.json opening within ±24h that aren't already in the
 * per-shift list. Used to surface cross-shift cohort budget collisions
 * (e.g. Broadway 23:00 UTC shift + West End 18:00 UTC shift on the same
 * UTC day each only see their own market — but both share the SB/GHA pool).
 */
function findCrossShiftAdditions(perShiftIds, showMap) {
  const known = new Set(perShiftIds);
  const now = new Date();
  const horizonStart = new Date(now);
  horizonStart.setUTCHours(0, 0, 0, 0);
  const horizonEnd = new Date(horizonStart);
  horizonEnd.setUTCDate(horizonEnd.getUTCDate() + 2); // today + tomorrow UTC

  const extras = [];
  for (const s of Object.values(showMap)) {
    if (known.has(s.id)) continue;
    if (!s.openingDate) continue;
    const valid = s.status === 'open' || s.status === 'upcoming' || s.status === 'previews';
    if (!valid) continue;
    const d = new Date(s.openingDate);
    if (d >= horizonStart && d < horizonEnd) extras.push(s.id);
  }
  return extras;
}

/**
 * Build the marginal-show map: for each blocker resource, identify the
 * earliest show whose inclusion first puts the cohort over the limit.
 * If multiple shows share that openingDate, return a cohort label so the
 * alert doesn't arbitrarily blame one of them.
 */
async function buildCulpritMap(orderedShowIds, blockers, usage, showMap) {
  const map = {};
  for (const blocker of blockers) {
    let culprit = null;
    for (let i = 1; i <= orderedShowIds.length; i++) {
      const r = await checkBudget(i, { liveUsage: usage });
      if (r.blockers.some(b => b.resource === blocker.resource)) {
        const id = orderedShowIds[i - 1];
        const date = (showMap[id] && showMap[id].openingDate) || null;
        // If multiple shows share this opening date, attribute to the cohort
        const sameDate = orderedShowIds.filter(x => {
          const d = (showMap[x] && showMap[x].openingDate) || null;
          return d && d === date;
        });
        culprit = sameDate.length > 1
          ? { type: 'cohort', date, ids: sameDate, label: `cohort opening ${date} (${sameDate.length} shows)` }
          : { type: 'show', id, date, label: id };
        break;
      }
    }
    map[blocker.resource] = culprit;
  }
  return map;
}

function compareShows(a, b, showMap) {
  const da = (showMap[a] && showMap[a].openingDate) || '9999-12-31';
  const db = (showMap[b] && showMap[b].openingDate) || '9999-12-31';
  const cmp = da.localeCompare(db);
  if (cmp !== 0) return cmp;
  // Deterministic tiebreaker on id to keep marginal-show identification stable
  return a.localeCompare(b);
}

async function main() {
  const args = parseArgs();
  const showsArg = args.shows || process.env.SHOWS || '';
  const perShiftIds = showsArg.split(',').map(s => s.trim()).filter(Boolean);

  if (perShiftIds.length === 0) {
    console.log('No shows provided to budget pre-flight — nothing to check.');
    return;
  }

  const showMap = loadShowMap();
  const crossShiftIds = findCrossShiftAdditions(perShiftIds, showMap);
  const allIds = [...perShiftIds, ...crossShiftIds];

  // Sort with deterministic tiebreaker so the marginal-show identification
  // is stable across runs (and CI vs local).
  const ordered = [...allIds].sort((a, b) => compareShows(a, b, showMap));

  console.log(`Budget pre-flight for ${ordered.length} show(s) (${perShiftIds.length} from this shift, ${crossShiftIds.length} cross-shift in next 24h):`);
  for (const id of ordered) {
    const s = showMap[id];
    const opening = s && s.openingDate ? s.openingDate : '?';
    const market = s && s.category ? s.category : '?';
    const note = perShiftIds.includes(id) ? '' : ' [cross-shift]';
    console.log(`  · ${id} (${market}, opens ${opening})${note}`);
  }
  console.log('');

  const usage = await fetchLiveUsage();
  const result = await checkBudget(ordered.length, { liveUsage: usage });

  // Print human-readable summary
  console.log('Estimated consumption (numShows=' + ordered.length + '):');
  for (const [k, v] of Object.entries(result.estimate)) {
    console.log(`  ${k.padEnd(13)} total=${v.total}  (perShow=${v.perShow}, threshold=${v.threshold})`);
  }
  console.log('');

  if (result.ok) {
    if (result.warnings.length) {
      console.log('::warning::Budget OK with squeeze:');
      for (const w of result.warnings) console.log(`  · ${w.message}`);
    } else {
      console.log('Budget OK — no warnings.');
    }
    return;
  }

  // !ok: build the culprit map ONCE and reuse for both stdout + Discord
  const culprits = await buildCulpritMap(ordered, result.blockers, usage, showMap);

  console.log('::warning::Budget pre-flight FAILED:');
  for (const b of result.blockers) {
    const c = culprits[b.resource];
    const tail = c ? `  →  pushed over by: ${c.label}` : '';
    console.log(`  ✗ ${b.message}${tail}`);
  }
  console.log('');

  // Fire Discord alert (severity=error, no cooldown — opening-night budget
  // exhaustion is rare enough that we want every occurrence visible)
  if (process.env.DISCORD_WEBHOOK_ALERTS) {
    try {
      const { sendAlert } = require('./lib/discord-notify');
      const fields = [];
      for (const b of result.blockers) {
        const c = culprits[b.resource];
        fields.push({
          name: `${b.resource} blocker`,
          value: `Need ${b.needed} ${b.unit || ''}, ${b.available} available` +
            (c ? `\nMarginal: ${c.label}` : ''),
          inline: false,
        });
      }
      fields.push({
        name: `Shows in window (${ordered.length})`,
        value: ordered
          .map((id, i) => `${i + 1}. \`${id}\`${perShiftIds.includes(id) ? '' : ' (cross-shift)'}`)
          .join('\n')
          .slice(0, 1000),
        inline: false,
      });
      await sendAlert({
        title: `Opening-night budget pre-flight FAILED — ${ordered.length} shows scheduled`,
        description: `${result.blockers.length} resource blocker(s) detected. Orchestrator continues (continue-on-error), but expect partial coverage. Reduce concurrent openings, top up credits, or swap to alternates.`,
        severity: 'error',
        fields: fields.slice(0, 10),
      });
      console.log('Discord alert sent.');
    } catch (e) {
      console.log(`::warning::Failed to send Discord alert: ${e.message}`);
    }
  } else {
    console.log('::warning::DISCORD_WEBHOOK_ALERTS not set — alert not delivered.');
  }
}

main().catch((err) => {
  // continue-on-error semantics, but don't swallow the failure silently —
  // surface it in the workflow annotations so a real bug doesn't go invisible.
  console.error(`::error::Budget pre-flight threw: ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(0);
});
