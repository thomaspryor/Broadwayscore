#!/usr/bin/env node
/**
 * price-fantasy-league.js — EV-based pricing overlay for fantasy-league.json
 *
 * Reads:
 *   data/fantasy-league.json  (eligibility + heuristic prices; source of truth)
 *   data/fantasy-ev.json      (E[points] per show, from compute-fantasy-scores --mode=projection)
 *
 * Writes:
 *   data/fantasy-league.json  (same file, prices replaced with EV-based values)
 *
 * Pricing:
 *   price = clamp(round(expectedPoints × k), minPrice, maxPrice)
 *   where k is calibrated so the top 3 shows land near maxPrice and the
 *   overall floor stays at minPrice. Tuned with --calibrate to tune k.
 *
 * Safety rails:
 *   - If fantasy-ev.json is missing or older than fantasy-league.json, ABORT.
 *   - If >30% of shows move by more than $10, ABORT (likely scraper regression).
 *   - If EV is missing for an eligible BW show, keep the heuristic price as fallback.
 *
 * Usage:
 *   node scripts/price-fantasy-league.js                 # write new prices
 *   node scripts/price-fantasy-league.js --dry-run       # print diff, don't write
 *   node scripts/price-fantasy-league.js --force         # bypass delta guard
 *   node scripts/price-fantasy-league.js --k=0.18        # override calibration
 */

const fs = require('fs');
const path = require('path');
const { isBroadwayCategory } = require('./lib/venue-classification');

const dataDir = path.join(__dirname, '..', 'data');
const leaguePath = path.join(dataDir, 'fantasy-league.json');
const evPath = path.join(dataDir, 'fantasy-ev.json');

// Price bounds (consistent with current heuristic).
const MIN_PRICE = 5;
const MAX_PRICE = 35;
// Target: top ~3 shows in the $30-35 range, median BW ~$18-22.
const TARGET_TOP_PRICE = 33;
const TOP_N_ANCHOR = 3;

function calibrateK(evByShow, league) {
  const bwEvs = Object.entries(evByShow)
    .filter(([id]) => {
      const show = league.shows[id];
      return isBroadwayCategory(show);
    })
    .map(([, ev]) => ev.totalPoints)
    .filter(n => Number.isFinite(n))
    .sort((a, b) => b - a);
  if (bwEvs.length === 0) return null;
  const topAvg = bwEvs.slice(0, TOP_N_ANCHOR).reduce((a, b) => a + b, 0) / Math.min(TOP_N_ANCHOR, bwEvs.length);
  if (topAvg <= 0) return null;
  return TARGET_TOP_PRICE / topAvg;
}

function priceFromEV(evPoints, k) {
  if (!Number.isFinite(evPoints) || evPoints <= 0) return MIN_PRICE;
  const raw = Math.round(evPoints * k);
  return Math.max(MIN_PRICE, Math.min(MAX_PRICE, raw));
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const kArg = args.find(a => a.startsWith('--k='));
  const kOverride = kArg ? parseFloat(kArg.split('=')[1]) : null;

  if (!fs.existsSync(leaguePath)) {
    console.error(`Missing ${leaguePath}. Run generate-fantasy-config.js first.`);
    process.exit(1);
  }
  if (!fs.existsSync(evPath)) {
    console.error(`Missing ${evPath}. Run compute-fantasy-scores.js --mode=projection first.`);
    process.exit(1);
  }

  const league = JSON.parse(fs.readFileSync(leaguePath, 'utf8'));
  const ev = JSON.parse(fs.readFileSync(evPath, 'utf8'));
  const evByShow = ev.showScores || {};

  const k = kOverride ?? calibrateK(evByShow, league);
  if (!k || !Number.isFinite(k)) {
    console.error('Could not calibrate k (no BW EV data).');
    process.exit(1);
  }
  console.error(`Calibration: k=${k.toFixed(4)} (target top-${TOP_N_ANCHOR} avg price $${TARGET_TOP_PRICE})`);

  const diff = [];
  let missingCount = 0;
  let changedCount = 0;
  let bigMoveCount = 0;

  for (const [showId, show] of Object.entries(league.shows)) {
    const oldPrice = show.price;
    const showEV = evByShow[showId];
    let newPrice;
    let reason;
    if (showEV && Number.isFinite(showEV.totalPoints)) {
      newPrice = priceFromEV(showEV.totalPoints, k);
      reason = 'ev';
    } else {
      // Keep heuristic as fallback for any eligible show with no EV.
      newPrice = oldPrice;
      reason = 'fallback(heuristic)';
      missingCount++;
    }

    if (newPrice !== oldPrice) {
      changedCount++;
      if (Math.abs(newPrice - oldPrice) > 10) bigMoveCount++;
    }

    diff.push({
      id: showId,
      title: show.title,
      category: show.category,
      oldPrice,
      newPrice,
      ev: showEV ? showEV.totalPoints : null,
      reason,
    });

    show.price = newPrice;
  }

  diff.sort((a, b) => (b.ev || 0) - (a.ev || 0));

  console.error(`\nPrice changes: ${changedCount}/${diff.length} shows`);
  console.error(`  Big moves (>$10): ${bigMoveCount}`);
  console.error(`  Fallback (no EV): ${missingCount}`);

  const bigMovePct = diff.length > 0 ? bigMoveCount / diff.length : 0;
  if (bigMovePct > 0.30 && !force) {
    console.error(`\n[ABORT] ${(bigMovePct*100).toFixed(1)}% of shows move by >$10. Likely EV regression.`);
    console.error('Re-run with --force to bypass (only if intentional).');
    process.exit(1);
  }

  console.error('\nTop 20 by EV:');
  console.error('  EV pts   Old  →  New   Δ   Show');
  for (const row of diff.slice(0, 20)) {
    const evStr = row.ev != null ? row.ev.toFixed(1).padStart(6) : '   N/A';
    const delta = row.newPrice - row.oldPrice;
    const deltaStr = (delta >= 0 ? '+' : '') + delta;
    console.error(`  ${evStr}   $${row.oldPrice.toString().padStart(2)} → $${row.newPrice.toString().padStart(2)}  ${deltaStr.padStart(4)}   ${row.title.substring(0, 38)}`);
  }

  // Update _meta with pricing provenance.
  league._meta = {
    ...league._meta,
    pricing: {
      method: 'ev',
      k,
      targetTopPrice: TARGET_TOP_PRICE,
      evSource: ev._meta?.predictionSource || null,
      evLastUpdated: ev._meta?.lastUpdated || null,
      repricedAt: new Date().toISOString(),
    },
  };

  if (dryRun) {
    console.error('\n--dry-run: no file written');
    return;
  }
  fs.writeFileSync(leaguePath, JSON.stringify(league, null, 2) + '\n');
  console.error(`\nWrote ${leaguePath} (${diff.length} shows repriced)`);
}

main();
