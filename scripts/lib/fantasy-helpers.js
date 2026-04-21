/**
 * fantasy-helpers.js — Shared logic for fantasy league scripts
 *
 * Used by: compute-fantasy-scores.js, fantasy-admin.js, fantasy-weekly-email.js
 *
 * Exports:
 *   computeAwardsPoints(showId, awardsData, scoringConfig) — awards.json → fantasy points
 *   fetchFantasyEntries(opts)                              — Supabase REST fetch
 *   computeLeaderboard(entries, showScores, showConfig)    — ranked standings
 *   sumGrossesInRange(slug, weeks, start, end)             — realized BO grosses
 *   projectRemainingGrosses(slug, weeks, asOf, end, opts)  — BO projection forward
 *   computeExpectedAwardsPoints(showId, predictions, cfg)  — E[awards pts] from probs
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

  // ── NY Drama Critics' Circle ──────────────────────────────────
  if (showAwards.nydcc) {
    const nydcc = showAwards.nydcc;
    const wins = nydcc.wins || [];
    if (wins.length > 0) {
      points += wins.length * (scoringConfig.nydccWin || 0);
      awardsList.push(`NYDCC: ${wins.length} win${wins.length > 1 ? 's' : ''}`);
    }
  }

  // ── Lucille Lortel Awards ────────────────────────────────────
  if (showAwards.lortel) {
    const lortel = showAwards.lortel;
    const wins = lortel.wins || [];
    const totalNoms = lortel.nominations ?? wins.length;
    const nomOnly = Math.max(0, totalNoms - wins.length);

    if (nomOnly > 0) {
      points += nomOnly * (scoringConfig.lortelNom || 0);
      awardsList.push(`Lortel: ${nomOnly} nom${nomOnly > 1 ? 's' : ''}`);
    }
    if (wins.length > 0) {
      points += wins.length * (scoringConfig.lortelWin || 0);
      awardsList.push(`Lortel: ${wins.length} win${wins.length > 1 ? 's' : ''}`);
    }
  }

  // ── Obie Awards ──────────────────────────────────────────────
  if (showAwards.obie) {
    const obie = showAwards.obie;
    const awards = obie.awards || obie.wins || [];
    if (awards.length > 0) {
      points += awards.length * (scoringConfig.obieAward || 0);
      awardsList.push(`Obie: ${awards.length} award${awards.length > 1 ? 's' : ''}`);
    }
  }

  return { points: Math.round(points * 100) / 100, awardsList };
}

// ── Supabase REST fetch ────────────────────────────────────────────

/**
 * Fetch fantasy entries from Supabase REST API.
 *
 * Reads via the public view `fantasy_entries_public` using the anon key —
 * emails are server-side masked (display_email) and tiebreakers not exposed.
 * For admin scripts that need raw email / tiebreakers, set
 * SUPABASE_SERVICE_ROLE_KEY (falls back to anon→view if not set).
 *
 * @param {object} opts
 * @param {string} [opts.league]   — Filter by league_name
 * @param {string} [opts.email]    — Filter by email (requires service role)
 * @param {string} [opts.season]   — Season filter (default: current)
 * @param {boolean} [opts.admin]   — Force service-role query against base table
 * @returns {Promise<Array>} Array of entry objects
 */
async function fetchFantasyEntries(opts = {}) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !anonKey) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY');
  }

  const wantsAdmin = opts.admin || opts.email;
  const useAdmin = wantsAdmin && !!serviceKey;
  const table = useAdmin ? 'fantasy_entries' : 'fantasy_entries_public';
  const key = useAdmin ? serviceKey : anonKey;

  if (wantsAdmin && !serviceKey) {
    console.warn('fetchFantasyEntries: admin/email filter requested but SUPABASE_SERVICE_ROLE_KEY not set — falling back to public view (masked emails, no tiebreakers).');
  }

  const params = new URLSearchParams({ select: '*', order: 'created_at.asc' });
  if (opts.season) params.append('season', `eq.${opts.season}`);
  if (opts.league) params.append('league_name', `eq.${opts.league}`);
  if (opts.email && useAdmin) params.append('email', `eq.${opts.email}`);

  const url = `${supabaseUrl}/rest/v1/${table}?${params}`;

  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      method: 'GET',
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
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
          const rows = JSON.parse(body);
          // View returns display_email (server-masked); normalize to email so
          // downstream readers (computeLeaderboard etc.) don't need to branch.
          // maskEmail() is idempotent, so code that re-masks is still safe.
          if (!useAdmin && Array.isArray(rows)) {
            for (const r of rows) {
              if (r && r.display_email != null && r.email == null) r.email = r.display_email;
            }
          }
          resolve(rows);
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

// ── Box office: realized + projection ───────────────────────────────

/**
 * Sum weekly grosses for a show in a date window [start, end] inclusive.
 * Returns { totalGross, weekCount, lastObservedWeek }.
 *
 * @param {string} showSlug
 * @param {object} weeksByDate  — grossesHistory.weeks
 * @param {string} startDate    — 'YYYY-MM-DD'
 * @param {string} endDate      — 'YYYY-MM-DD'
 */
function sumGrossesInRange(showSlug, weeksByDate, startDate, endDate) {
  let totalGross = 0;
  let weekCount = 0;
  let lastObservedWeek = null;
  const sortedWeeks = Object.keys(weeksByDate).sort();
  for (const w of sortedWeeks) {
    if (w < startDate || w > endDate) continue;
    const row = weeksByDate[w]?.[showSlug];
    if (row && row.gross) {
      totalGross += row.gross;
      weekCount += 1;
      lastObservedWeek = w;
    }
  }
  return { totalGross, weekCount, lastObservedWeek };
}

/**
 * Project expected remaining grosses for a show from `asOfDate` to `endDate`.
 * Uses the average of the last `trailingWeeks` observed weekly grosses
 * (defaults to 4-week trailing average) as the per-week estimate.
 *
 * Closed shows: expected remaining = $0.
 * Shows with < 2 weeks of data: low confidence, use the single week or 0.
 *
 * Returns { expectedRemaining, weeksRemaining, trailingAvg, confidence }.
 *   confidence: 'high' (≥4 weeks observed), 'medium' (2-3), 'low' (<2), 'closed'
 */
function projectRemainingGrosses(showSlug, weeksByDate, asOfDate, endDate, opts = {}) {
  const { trailingWeeks = 4, isClosed = false } = opts;

  if (isClosed) {
    return { expectedRemaining: 0, weeksRemaining: 0, trailingAvg: 0, confidence: 'closed' };
  }

  const sortedWeeks = Object.keys(weeksByDate).sort();
  const observed = [];
  for (const w of sortedWeeks) {
    if (w > asOfDate) break;
    const row = weeksByDate[w]?.[showSlug];
    if (row && typeof row.gross === 'number' && row.gross > 0) {
      observed.push({ week: w, gross: row.gross });
    }
  }

  if (observed.length === 0) {
    return { expectedRemaining: 0, weeksRemaining: 0, trailingAvg: 0, confidence: 'low' };
  }

  const trailing = observed.slice(-trailingWeeks);
  const trailingAvg = trailing.reduce((s, x) => s + x.gross, 0) / trailing.length;

  // Weeks remaining = whole weeks between (asOfDate+1 day) and endDate, inclusive of endDate.
  const asOf = new Date(asOfDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  const days = Math.max(0, Math.floor((end - asOf) / (1000 * 60 * 60 * 24)));
  const weeksRemaining = Math.max(0, Math.floor(days / 7));

  const confidence = observed.length >= 4 ? 'high' : observed.length >= 2 ? 'medium' : 'low';
  const expectedRemaining = Math.round(trailingAvg * weeksRemaining);
  return { expectedRemaining, weeksRemaining, trailingAvg: Math.round(trailingAvg), confidence };
}

// ── Expected awards points (pre-event, analytic) ────────────────────

/**
 * Compute expected awards points from Tony win probabilities.
 *
 * `tonyPredictions` shape:
 *   {
 *     _meta: { hasNominations: bool, lastUpdated, source },
 *     shows: {
 *       [showId]: {
 *         categories: {
 *           [category]: { pNom: 0..1 (optional if hasNominations), pWin: 0..1 }
 *         }
 *       }
 *     }
 *   }
 *
 * Post-noms: pNom forced to 1.0 for nominated shows, 0 for non-nominees.
 * Pre-noms: pNom + pWin used; Best-Musical/Play bonus applied to pWin only.
 *
 * Only Tony-specific scoring keys are used here (tonyNom, tonyWin,
 * tonyBestMusical, tonyBestPlay). Pre-Tony ceremonies are handled by
 * realized-points (computeAwardsPoints) once nominations are announced.
 *
 * @param {string} showId
 * @param {object} tonyPredictions
 * @param {object} scoringConfig  — scoring.awards from fantasy-league.json
 * @returns {{ points: number, breakdown: object }}
 */
function computeExpectedAwardsPoints(showId, tonyPredictions, scoringConfig) {
  const show = tonyPredictions?.shows?.[showId];
  if (!show || !show.categories) return { points: 0, breakdown: { expectedNoms: 0, expectedWins: 0 } };

  const hasNoms = !!tonyPredictions?._meta?.hasNominations;
  let expectedNomPoints = 0;
  let expectedWinPoints = 0;
  let expectedBestBonusPoints = 0;
  let expectedNoms = 0;
  let expectedWins = 0;

  for (const [category, probs] of Object.entries(show.categories)) {
    const pNom = hasNoms ? 1.0 : (probs.pNom ?? 0);
    const pWin = probs.pWin ?? 0;

    // E[noms] only counts nomination-only credit (non-winning noms): pNom × (1 - pWin)
    expectedNomPoints += (pNom * (1 - pWin)) * (scoringConfig.tonyNom || 0);
    expectedWinPoints += (pNom * pWin) * (scoringConfig.tonyWin || 0);
    expectedNoms += pNom;
    expectedWins += pNom * pWin;

    if (category === 'Best Musical') {
      expectedBestBonusPoints += (pNom * pWin) * (scoringConfig.tonyBestMusical || 0);
    } else if (category === 'Best Play') {
      expectedBestBonusPoints += (pNom * pWin) * (scoringConfig.tonyBestPlay || 0);
    }
  }

  const points = expectedNomPoints + expectedWinPoints + expectedBestBonusPoints;
  return {
    points: Math.round(points * 100) / 100,
    breakdown: {
      expectedNoms: Math.round(expectedNoms * 100) / 100,
      expectedWins: Math.round(expectedWins * 100) / 100,
      expectedNomPoints: Math.round(expectedNomPoints * 100) / 100,
      expectedWinPoints: Math.round(expectedWinPoints * 100) / 100,
      expectedBestBonusPoints: Math.round(expectedBestBonusPoints * 100) / 100,
    },
  };
}

/**
 * Validate a tony-win-probabilities.json payload.
 * Returns { ok: bool, reason: string, stats: {...} }.
 *
 * Rejects:
 *   - empty shows object
 *   - any per-category probability out of [0, 1]
 *   - fewer than N shows (default 15) — signals scraper drift
 */
function validateTonyPredictions(data, opts = {}) {
  const { minShows = 15, requireCategories = ['Best Musical'] } = opts;
  if (!data || typeof data !== 'object') return { ok: false, reason: 'not an object' };
  if (!data.shows || typeof data.shows !== 'object') return { ok: false, reason: 'missing shows' };
  const showIds = Object.keys(data.shows);
  if (showIds.length < minShows) {
    return { ok: false, reason: `only ${showIds.length} shows (need ≥${minShows})`, stats: { showCount: showIds.length } };
  }
  const categoriesSeen = new Set();
  let probabilityCount = 0;
  for (const sid of showIds) {
    const cats = data.shows[sid]?.categories;
    if (!cats) continue;
    for (const [cat, probs] of Object.entries(cats)) {
      categoriesSeen.add(cat);
      for (const key of ['pNom', 'pWin']) {
        if (probs[key] == null) continue;
        if (typeof probs[key] !== 'number' || probs[key] < 0 || probs[key] > 1) {
          return { ok: false, reason: `${sid}.${cat}.${key} out of range: ${probs[key]}` };
        }
        probabilityCount += 1;
      }
    }
  }
  for (const required of requireCategories) {
    if (!categoriesSeen.has(required)) {
      return { ok: false, reason: `missing required category: ${required}` };
    }
  }
  return {
    ok: true,
    stats: { showCount: showIds.length, categoryCount: categoriesSeen.size, probabilityCount },
  };
}

module.exports = {
  computeAwardsPoints,
  fetchFantasyEntries,
  computeLeaderboard,
  maskEmail,
  sumGrossesInRange,
  projectRemainingGrosses,
  computeExpectedAwardsPoints,
  validateTonyPredictions,
};
