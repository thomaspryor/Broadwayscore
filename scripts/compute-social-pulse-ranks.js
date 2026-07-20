#!/usr/bin/env node
/**
 * compute-social-pulse-ranks.js — post-loop rank aggregator.
 *
 * This script runs AFTER fetch-social-pulse.js has processed all running
 * shows. It reads every data/social-pulse/*.json file, sorts shows within
 * each market (Broadway / West End) by raw volume, and writes the rank
 * field back into both the canonical and public files.
 *
 * Why a separate step: rank is a CROSS-SHOW property — you can't compute
 * "#3 of 33 Broadway shows" until you know all 33 current volumes. The
 * plan-review surfaced this as a P0 issue (Claude + Gemini both flagged it).
 *
 * Usage:
 *   node scripts/compute-social-pulse-ranks.js
 *   node scripts/compute-social-pulse-ranks.js --dry-run
 *
 * Output files updated:
 *   data/social-pulse/{id}.json         — sets `rank` field
 *   public/data/shows/{id}.social.json  — sets `r` field (compact)
 */

const fs = require('fs');
const path = require('path');
const {
  computeCompositeScore,
  computePeerStats,
  derivePeerTier,
} = require('./lib/social-pulse-scorer');

const REPO_ROOT = path.join(__dirname, '..');
const SOCIAL_PULSE_DIR = path.join(REPO_ROOT, 'data', 'social-pulse');
const PUBLIC_SHOWS_DIR = path.join(REPO_ROOT, 'public', 'data', 'shows');

function parseArgs(argv) {
  return {
    dryRun: argv.includes('--dry-run'),
  };
}

/**
 * Reads all data/social-pulse/*.json files (skipping _meta.json and any
 * other leading-underscore metadata files). Returns parsed objects with
 * the showId attached.
 */
/** Max age for a pulse file to participate in ranks/tiers. Mirrors
 *  MAX_SOCIAL_PULSE_AGE_DAYS in src/lib/data-social-pulse.ts. */
const MAX_RANKABLE_AGE_DAYS = 14;

function loadAllPulseFiles() {
  if (!fs.existsSync(SOCIAL_PULSE_DIR)) {
    console.error(`No ${SOCIAL_PULSE_DIR} directory — run fetch-social-pulse.js first`);
    return [];
  }
  const files = fs.readdirSync(SOCIAL_PULSE_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
  const pulseData = [];
  for (const filename of files) {
    const filePath = path.join(SOCIAL_PULSE_DIR, filename);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (!parsed.showId) continue;
      pulseData.push({ filePath, filename, data: parsed });
    } catch (err) {
      console.warn(`Skipping ${filename}: ${err.message}`);
    }
  }

  // Freshness filter: the fetcher only rewrites RUNNING shows, so files
  // for closed/upcoming shows freeze at their last fetch forever (the
  // School Girls precedent). Pooling frozen files with fresh ones skews
  // peer percentiles and inflates "#N/M" rank denominators with dead
  // shows. /trending already excludes them via isFreshPulse — this makes
  // the ranks/tiers written back into per-show files consistent with it.
  const cutoff = Date.now() - MAX_RANKABLE_AGE_DAYS * 24 * 60 * 60 * 1000;
  const fresh = pulseData.filter((e) => {
    const t = Date.parse(e.data.fetchedAt || '');
    return !Number.isNaN(t) && t >= cutoff;
  });

  // Schema-mix guard: v2 volumes are capped-sample counts, v3 volumes are
  // true counters — different units. Once ANY v3 file exists, v2 files
  // must not share the peer pool (they'd deflate percentiles and over-tier
  // v3 shows). Before the first v3 run, all-v2 pools rank as before.
  const hasV3 = fresh.some((e) => (e.data._v || 1) >= 3);
  const pool = hasV3 ? fresh.filter((e) => (e.data._v || 1) >= 3) : fresh;

  const dropped = pulseData.length - pool.length;
  if (dropped > 0) {
    console.log(`Excluding ${dropped} stale${hasV3 ? '/legacy-schema' : ''} pulse file(s) from ranking (kept ${pool.length}).`);
  }
  return pool;
}

/**
 * Groups shows by market. The canonical file stores the market label
 * ('Broadway' / 'West End' / etc.) from fetch-social-pulse.js.
 *
 * Shows with Hidden tier are still ranked — they still have a volume, just
 * too low to display a card. This lets a show cross the display threshold
 * between weeks without its rank disappearing and reappearing.
 */
function groupByMarket(pulseData) {
  const groups = new Map();
  for (const entry of pulseData) {
    const market = entry.data.market || 'Broadway';
    if (!groups.has(market)) groups.set(market, []);
    groups.get(market).push(entry);
  }
  return groups;
}

/**
 * Minimum shows per market required to display a rank.
 *
 * Without this, "#1/3 Broadway" would be shown when only 3 shows have been
 * processed — which passes the "Reddit screenshot test" not at all. Ranks
 * should only appear once the market has enough coverage that "#N of M"
 * genuinely means something. 10 is a judgment call: large enough to feel
 * like a real ranking, small enough to activate during cold-start weeks.
 */
const MIN_SHOWS_FOR_RANK_DISPLAY = 10;

/**
 * For each market:
 *   1. Sort shows by COMPOSITE SCORE (volume × positive%/100) descending.
 *      A loud-but-hated show shouldn't outrank a smaller positive one.
 *   2. Assign 1-based rank.
 *   3. Compute peer stats (composite p80/p60, volume p50) and re-tier
 *      every show using derivePeerTier — so tiers are PEER-RELATIVE,
 *      no 8-week baseline required.
 *
 * Below MIN_SHOWS_FOR_RANK_DISPLAY the rank text is null and the card
 * hides the "#N/M" line. Tier still gets recomputed regardless.
 */
function assignRanksAndTiers(groups) {
  // Ranking strength: effectiveVolume (schema v3 Pulse Index — the
  // relevance-adjusted uncapped-counter blend) when the file has it,
  // legacy capped-sample volume otherwise. Mixed v2/v3 markets only occur
  // mid-migration; after the first v3 run every file has effectiveVolume.
  const strength = (d) => (Number.isFinite(d.effectiveVolume) ? d.effectiveVolume : (d.volume || 0));

  for (const [, entries] of groups) {
    // Sort by composite (blended) score, not raw volume
    entries.sort((a, b) => {
      const aScore = computeCompositeScore(strength(a.data), a.data.positivePct || 0);
      const bScore = computeCompositeScore(strength(b.data), b.data.positivePct || 0);
      return bScore - aScore;
    });

    // Compute peer stats once for the whole market
    const peerStats = computePeerStats(
      entries.map((e) => ({
        volume: e.data.volume || 0,
        effectiveVolume: strength(e.data),
        positivePct: e.data.positivePct || 0,
      })),
    );

    const displayable = entries.length >= MIN_SHOWS_FOR_RANK_DISPLAY;
    entries.forEach((entry, i) => {
      // Rank
      if (displayable) {
        entry.newRank = {
          position: i + 1,
          total: entries.length,
          text: `${i + 1}/${entries.length} ${marketShortLabel(entry.data.market)}`,
        };
      } else {
        entry.newRank = {
          position: i + 1,
          total: entries.length,
          text: null,
        };
      }

      // Re-tier using peer-relative rules
      entry.newTier = derivePeerTier({
        volume: entry.data.volume || 0,
        effectiveVolume: strength(entry.data),
        positivePct: entry.data.positivePct || 0,
        peerStats,
      });

      // Composite score is useful as a debug field too
      entry.newCompositeScore = computeCompositeScore(
        strength(entry.data),
        entry.data.positivePct || 0,
      );
    });
  }
}

// Backwards-compat alias — old callers expect assignRanks
const assignRanks = assignRanksAndTiers;

function marketShortLabel(market) {
  if (!market) return 'Broadway';
  if (market === 'Broadway') return 'Broadway';
  if (market === 'West End') return 'West End';
  if (market === 'Off-Broadway') return 'Off-Broadway';
  if (market === 'Off-West End') return 'Off-West End';
  return market;
}

/**
 * Writes the rank AND new tier back into both files.
 * Public compact schema: `r` = rank string, `t` = tier label.
 */
function writeRanks(pulseData, dryRun, logger = console) {
  let writeCount = 0;
  for (const entry of pulseData) {
    const canonicalPath = entry.filePath;
    const publicPath = path.join(PUBLIC_SHOWS_DIR, `${entry.data.showId}.social.json`);

    // Update canonical with rank, tier, composite score
    entry.data.rank = entry.newRank;
    entry.data.tier = entry.newTier;
    entry.data.compositeScore = Number(entry.newCompositeScore.toFixed(2));
    if (!dryRun) {
      fs.writeFileSync(canonicalPath, JSON.stringify(entry.data, null, 2));
    }

    // Update public compact file if it exists. Tier is always written;
    // rank is only written when the market has enough shows.
    if (fs.existsSync(publicPath)) {
      try {
        const publicData = JSON.parse(fs.readFileSync(publicPath, 'utf-8'));
        publicData.t = entry.newTier;
        if (entry.newRank.text) {
          publicData.r = entry.newRank.text;
        } else {
          delete publicData.r;
        }
        if (!dryRun) {
          fs.writeFileSync(publicPath, JSON.stringify(publicData));
        }
      } catch (err) {
        logger.warn(`Could not update ${publicPath}: ${err.message}`);
      }
    }

    writeCount++;
  }
  return writeCount;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`Loading social-pulse files from ${SOCIAL_PULSE_DIR}...`);
  const pulseData = loadAllPulseFiles();
  if (pulseData.length === 0) {
    console.log('No pulse files to rank.');
    process.exit(0);
  }

  console.log(`Loaded ${pulseData.length} pulse files`);

  const groups = groupByMarket(pulseData);
  console.log('\nMarket groups:');
  for (const [market, entries] of groups) {
    console.log(`  ${market}: ${entries.length} shows`);
  }

  assignRanks(groups);

  // Show the top 5 per market before writing
  console.log('\n─── Rank previews (top 5 per market) ───');
  for (const [market, entries] of groups) {
    console.log(`\n${market}:`);
    for (const entry of entries.slice(0, 5)) {
      console.log(
        `  #${entry.newRank.position}/${entry.newRank.total}  ${entry.data.showId.padEnd(40)}  ` +
          `vol=${String(entry.data.volume).padStart(4)}  ` +
          `pos=${String(entry.data.positivePct || 0).padStart(3)}%  ` +
          `cs=${String(Math.round(entry.newCompositeScore)).padStart(4)}  ` +
          `tier=${entry.newTier}`,
      );
    }
  }
  // Tier distribution
  const tierCounts = {};
  for (const [, entries] of groups) {
    for (const entry of entries) {
      tierCounts[entry.newTier] = (tierCounts[entry.newTier] || 0) + 1;
    }
  }
  console.log('\nTier distribution:', tierCounts);

  const writeCount = writeRanks(pulseData, args.dryRun);
  console.log(`\n${args.dryRun ? '[dry-run] would write' : 'Wrote'} ${writeCount} files`);
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadAllPulseFiles,
  groupByMarket,
  assignRanks,
  writeRanks,
};
