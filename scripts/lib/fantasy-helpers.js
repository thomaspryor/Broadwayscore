/**
 * fantasy-helpers.js — Shared logic for fantasy league scripts
 *
 * Used by: compute-fantasy-scores.js, fantasy-admin.js, fantasy-weekly-email.js
 *
 * Exports:
 *   computeAwardsPoints(showId, awardsData, scoringConfig) — awards.json → fantasy points
 *   fetchFantasyEntries(opts)                              — Supabase REST fetch
 *   computeLeaderboard(entries, showScores, showConfig)    — ranked standings
 */

const https = require('https');

// ── Awards computation ─────────────────────────────────────────────

/**
 * Map a show's awards data to fantasy points.
 *
 * @param {string} showId        — Show ID (e.g., "chicago-1996")
 * @param {object} awardsData    — Parsed awards.json
 * @param {object} scoringConfig — scoring.awards from fantasy-league.json
 * @returns {{ points: number, awardsList: string[] }}
 */
function computeAwardsPoints(showId, awardsData, scoringConfig) {
  const showAwards = awardsData.shows?.[showId];
  if (!showAwards) return { points: 0, awardsList: [] };

  let points = 0;
  const awardsList = [];

  // ── Tony Awards ──────────────────────────────────────────────
  if (showAwards.tony) {
    const tony = showAwards.tony;
    const wins = tony.wins || [];
    const totalNoms = tony.nominations ?? wins.length;
    const nomOnly = Math.max(0, totalNoms - wins.length);

    if (nomOnly > 0) {
      points += nomOnly * (scoringConfig.tonyNom || 0);
      awardsList.push(`Tony: ${nomOnly} nom${nomOnly > 1 ? 's' : ''}`);
    }
    if (wins.length > 0) {
      points += wins.length * (scoringConfig.tonyWin || 0);
      awardsList.push(`Tony: ${wins.length} win${wins.length > 1 ? 's' : ''}`);
    }

    // Best Musical / Best Play bonus (exact match only — excludes revivals)
    if (wins.includes('Best Musical')) {
      points += scoringConfig.tonyBestMusical || 0;
      awardsList.push('Tony Best Musical');
    }
    if (wins.includes('Best Play')) {
      points += scoringConfig.tonyBestPlay || 0;
      awardsList.push('Tony Best Play');
    }
  }

  // ── Drama Desk ───────────────────────────────────────────────
  if (showAwards.dramadesk) {
    const dd = showAwards.dramadesk;
    const wins = dd.wins || [];
    const totalNoms = dd.nominations ?? wins.length;
    const nomOnly = Math.max(0, totalNoms - wins.length);

    if (nomOnly > 0) {
      points += nomOnly * (scoringConfig.dramaDeskNom || 0);
      awardsList.push(`Drama Desk: ${nomOnly} nom${nomOnly > 1 ? 's' : ''}`);
    }
    if (wins.length > 0) {
      points += wins.length * (scoringConfig.dramaDeskWin || 0);
      awardsList.push(`Drama Desk: ${wins.length} win${wins.length > 1 ? 's' : ''}`);
    }
  }

  // ── Outer Critics Circle ─────────────────────────────────────
  if (showAwards.outerCriticsCircle) {
    const occ = showAwards.outerCriticsCircle;
    const wins = occ.wins || [];
    const totalNoms = occ.nominations ?? wins.length;
    const nomOnly = Math.max(0, totalNoms - wins.length);

    if (nomOnly > 0) {
      points += nomOnly * (scoringConfig.outerCriticsNom || 0);
      awardsList.push(`Outer Critics: ${nomOnly} nom${nomOnly > 1 ? 's' : ''}`);
    }
    if (wins.length > 0) {
      points += wins.length * (scoringConfig.outerCriticsWin || 0);
      awardsList.push(`Outer Critics: ${wins.length} win${wins.length > 1 ? 's' : ''}`);
    }
  }

  // ── Drama League ─────────────────────────────────────────────
  if (showAwards.dramaLeague) {
    const dl = showAwards.dramaLeague;
    const wins = dl.wins || [];
    // Drama League often lacks nominations field — default to wins.length
    const totalNoms = dl.nominations ?? wins.length;
    const nomOnly = Math.max(0, totalNoms - wins.length);

    if (nomOnly > 0) {
      points += nomOnly * (scoringConfig.dramaLeagueNom || 0);
      awardsList.push(`Drama League: ${nomOnly} nom${nomOnly > 1 ? 's' : ''}`);
    }
    if (wins.length > 0) {
      points += wins.length * (scoringConfig.dramaLeagueWin || 0);
      awardsList.push(`Drama League: ${wins.length} win${wins.length > 1 ? 's' : ''}`);
    }
  }

  return { points: Math.round(points * 100) / 100, awardsList };
}

// ── Supabase REST fetch ────────────────────────────────────────────

/**
 * Fetch fantasy entries from Supabase REST API.
 * Uses anon key (RLS allows public SELECT on fantasy_entries).
 *
 * @param {object} opts
 * @param {string} [opts.league]  — Filter by league_name
 * @param {string} [opts.email]   — Filter by email
 * @param {string} [opts.season]  — Season filter (default: current)
 * @returns {Promise<Array>} Array of entry objects
 */
async function fetchFantasyEntries(opts = {}) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY');
  }

  const params = new URLSearchParams({ select: '*', order: 'created_at.asc' });
  if (opts.season) params.append('season', `eq.${opts.season}`);
  if (opts.league) params.append('league_name', `eq.${opts.league}`);
  if (opts.email) params.append('email', `eq.${opts.email}`);

  const url = `${supabaseUrl}/rest/v1/fantasy_entries?${params}`;

  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      method: 'GET',
      headers: {
        'apikey': anonKey,
        'Authorization': `Bearer ${anonKey}`,
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(urlObj, options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Supabase fetch failed (HTTP ${res.statusCode}): ${body.substring(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`Invalid JSON from Supabase: ${body.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

// ── Leaderboard computation ────────────────────────────────────────

/**
 * Compute ranked leaderboard from entries + scores.
 * JS port of src/lib/data-fantasy.ts:computeLeaderboard().
 *
 * @param {Array} entries       — Fantasy entry objects from Supabase
 * @param {object} showScores   — showScores from fantasy-scores.json
 * @param {object} showConfig   — shows from fantasy-league.json
 * @returns {Array} Ranked leaderboard entries
 */
function computeLeaderboard(entries, showScores, showConfig) {
  const leaderboard = entries.map(entry => {
    const picks = (entry.picks || []);
    let totalCritic = 0;
    let totalAudience = 0;
    let totalBoxOffice = 0;
    let totalAwards = 0;

    const pickDetails = picks.map(showId => {
      const show = showConfig[showId];
      const score = showScores[showId];
      const points = score?.totalPoints ?? 0;

      if (score) {
        totalCritic += score.criticScorePoints;
        totalAudience += score.audienceGradePoints;
        totalBoxOffice += score.boxOfficePoints;
        totalAwards += score.awardsPoints;
      }

      return {
        showId,
        showTitle: show?.title ?? showId,
        price: show?.price ?? 0,
        points,
      };
    });

    const totalPoints = Math.round((totalCritic + totalAudience + totalBoxOffice + totalAwards) * 100) / 100;

    return {
      rank: 0,
      displayName: entry.team_name || maskEmail(entry.email),
      email: entry.email,
      totalPoints,
      picks: pickDetails,
      pointBreakdown: {
        criticScore: totalCritic,
        audienceGrade: totalAudience,
        boxOffice: Math.round(totalBoxOffice * 100) / 100,
        awards: totalAwards,
      },
    };
  });

  // Sort by total points descending, assign ranks (tied entries share rank)
  leaderboard.sort((a, b) => b.totalPoints - a.totalPoints);
  leaderboard.forEach((entry, i) => {
    if (i === 0) {
      entry.rank = 1;
    } else {
      entry.rank = entry.totalPoints === leaderboard[i - 1].totalPoints
        ? leaderboard[i - 1].rank
        : i + 1;
    }
  });

  return leaderboard;
}

/** Mask email for public display: tom@gmail.com → t***@gmail.com */
function maskEmail(email) {
  if (!email) return '***';
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  if (local.length <= 1) return `${local}***@${domain}`;
  return `${local[0]}***@${domain}`;
}

module.exports = {
  computeAwardsPoints,
  fetchFantasyEntries,
  computeLeaderboard,
  maskEmail,
};
