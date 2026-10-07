#!/usr/bin/env node
/**
 * verify-gd-snapshot-timing.js — BLOCKING GATE for the GD historical-odds backfill.
 *
 * Background: GoldDerby's WordPress REST API exposes /latest-odds-v3/ for closed
 * Tony leagues going back to 2013. The question this script answers: does the
 * endpoint serve **final pre-ceremony** odds (the data we want) or **current
 * retail-betting** odds for closed leagues (i.e. post-hoc pile-on once a winner
 * is known)? The 6-reviewer plan-review surfaced this as the #1 risk: shipping
 * a "GD called X of last N Tonys" Reddit stat that's actually circular.
 *
 * Two independent checks. Both must pass.
 *
 *   1. Direct: Hadestown's API percentage for the 2019 Best Musical race should
 *      be within ±5pp of the contemporary reference number (~88%, widely
 *      reported by Variety/THR/Vox in May–June 2019).
 *
 *   2. Triangulation: there must be at least one historical winner whose API
 *      percentage is BELOW 50%. Post-hoc retail data cannot have winners under
 *      50% — retail bettors pile onto known winners. If we find a real upset
 *      with the winner ranked 2nd or 3rd, the data is pre-ceremony by
 *      construction. Tested probes: Kinky Boots 2013 (39.2%) + The Outsiders
 *      2024 (21.7%).
 *
 * Exit 0 iff both gates pass. Exit 1 otherwise — and the plan to backfill
 * historical odds is abandoned.
 */

const GD_BASE = 'https://www.goldderby.com/wp-json/gameplay/v1';
const UA = 'Broadway-Scorecard/historical-odds-verify (tom@broadwayscorecard.com)';

const REFERENCE = {
  // Contemporary pre-ceremony Hadestown probability per Variety/THR predictions
  // articles in May–June 2019. Hadestown was the heavy but non-unanimous
  // favorite. This is the canonical reference number for the gate.
  hadestown2019Pct: 88,
  tolerancePp: 5,
};

const PROBES = [
  // Big-Four winners-league IDs discovered from /featured-leagues/tony
  { year: 2019, leagueId: 1202873958, catId: 154, expectedWinner: /hadestown/i, type: 'favorite' },
  { year: 2024, leagueId: 1205819228, catId: 154, expectedWinner: /outsiders/i, type: 'upset' },
  { year: 2013, leagueId: 1201883675, catId: 154, expectedWinner: /kinky/i, type: 'upset' },
];

async function gdGet(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return res.json();
}

function rowsOf(payload) {
  if (Array.isArray(payload?.data)) return payload.data;
  // Some endpoints return numbered-key objects
  return Object.values(payload).filter(v => v && typeof v === 'object' && 'title' in v);
}

async function fetchRace({ leagueId, catId }) {
  const url = `${GD_BASE}/latest-odds-v3/${leagueId}/${catId}/combined`;
  return rowsOf(await gdGet(url)).map(r => ({
    title: r.title,
    pct: parseFloat(r.percentage),
    isWinner: Number(r.is_winner) === 1,
  })).sort((a, b) => b.pct - a.pct);
}

(async () => {
  const results = {};
  for (const probe of PROBES) {
    const rows = await fetchRace(probe);
    const winnerRow = rows.find(r => r.isWinner);
    const winnerRank = winnerRow ? rows.indexOf(winnerRow) + 1 : null;
    results[probe.year] = { rows, winnerRow, winnerRank, probe };
    await new Promise(r => setTimeout(r, 600));
  }

  // GATE 1 — direct check
  const had = results[2019].rows.find(r => /hadestown/i.test(r.title));
  if (!had || !had.isWinner) {
    console.error('GATE FAIL: 2019 Hadestown row not found or not flagged is_winner.');
    process.exit(1);
  }
  const delta = Math.abs(had.pct - REFERENCE.hadestown2019Pct);

  console.log(`API_HADESTOWN_PCT=${had.pct}`);
  console.log(`REFERENCE_HADESTOWN_PCT=${REFERENCE.hadestown2019Pct}`);
  console.log(`DELTA_PP=${delta.toFixed(2)}`);
  console.log(`TOLERANCE_PP=${REFERENCE.tolerancePp}`);

  const gate1 = delta <= REFERENCE.tolerancePp;
  console.log(`GATE_1_DIRECT=${gate1 ? 'PASS' : 'FAIL'}`);

  // GATE 2 — triangulation: at least one winner ranked 2nd+ AND with pct < 50
  const upsets = Object.values(results).filter(r =>
    r.winnerRow && r.winnerRow.pct < 50 && r.winnerRank > 1
  );
  console.log(`UPSETS_FOUND=${upsets.length}`);
  for (const u of upsets) {
    console.log(`  ${u.probe.year} winner=${u.winnerRow.title} pct=${u.winnerRow.pct}% rank=${u.winnerRank}`);
  }
  const gate2 = upsets.length >= 1;
  console.log(`GATE_2_TRIANGULATION=${gate2 ? 'PASS' : 'FAIL'}`);

  if (!gate1 || !gate2) {
    console.error('\nGATE FAIL — abandon the historical-odds backfill plan.');
    console.error('If GATE_1 failed: API may be serving post-hoc data; pivot to Wayback scrape.');
    console.error('If GATE_2 failed: every historical winner is at favorite-only odds; suspicious.');
    process.exit(1);
  }

  console.log('\n✅ Snapshot-timing gate PASS — historical odds backfill is safe to proceed.');
})().catch(e => {
  console.error('verify-gd-snapshot-timing.js error:', e.message);
  process.exit(1);
});
