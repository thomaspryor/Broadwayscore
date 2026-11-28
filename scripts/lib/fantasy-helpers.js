/**
 * fantasy-helpers.js — Shared logic for fantasy league scripts
 *
 * Used by: compute-fantasy-scores.js, fantasy-admin.js, fantasy-weekly-email.js
 *
 * Exports:
 *   computeAwardsPoints(showId, awardsData, scoringConfig) — awards.json → fantasy points
 *   fetchFantasyEntries(opts)                              — Supabase REST fetch
 *   computeLeaderboard(entries, showScores, showConfig)    — ranked standings (per-entry rules)
 *   scoringFromDate / isScoreLockedForEntry / entryPickPoints — per-entry scoring rules
 *   sumGrossesInRange(slug, weeks, start, end)             — realized BO grosses
 *   projectRemainingGrosses(slug, weeks, asOf, end, opts)  — BO projection forward
 *   computeExpectedAwardsPoints(showId, predictions, cfg)  — E[awards pts] from probs
 */

const https = require('https');
const { DEFAULT_GOLD_THRESHOLD, RECOMMENDED_MIN, WORTH_SEEING_MIN, MIXED_MIN } = require('./score-tiers');

// ── Awards computation ─────────────────────────────────────────────

/**
 * Map a show's awards data to fantasy points.
 *
 * @param {string} showId        — Show ID (e.g., "chicago-1996")
 * @param {object} awardsData    — Parsed awards.json
 * @param {object} scoringConfig — scoring.awards from fantasy-league.json
 * @returns {{ points: number, awardsList: string[] }}
 */
function computeAwardsPoints(showId, awardsData, scoringConfig, opts = {}) {
  const rawAwards = awardsData.shows?.[showId];
  if (!rawAwards) return { points: 0, awardsList: [] };
  // opts.season ('2026-27', the Tony window label): only that season's
  // records score. A show that transferred in can carry last season's
  // Off-Broadway Lortel/Drama Desk records under the same id, and a record
  // with no season cannot prove it is this season's, so it does not score
  // either (BRO-5548 audit; today only unscored Pulitzer records lack one).
  const showAwards = {};
  for (const [key, rec] of Object.entries(rawAwards)) {
    if (opts.season && rec && typeof rec === 'object' && rec.season !== opts.season) continue;
    showAwards[key] = rec;
  }

  let points = 0;
  const awardsList = [];

  // ── Tony Awards ──────────────────────────────────────────────
  if (showAwards.tony) {
    const tony = showAwards.tony;
    const wins = tony.wins || [];
    const totalNoms = nominationCount(tony);
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
    const totalNoms = nominationCount(dd);
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
    const totalNoms = nominationCount(occ);
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
    const totalNoms = nominationCount(dl);
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
  // awards.json writes nyDramaCritics; nydcc is the old key (never populated).
  const nydccRecord = showAwards.nyDramaCritics ?? showAwards.nydcc;
  if (nydccRecord) {
    const nydcc = nydccRecord;
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
    const totalNoms = nominationCount(lortel);
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
  // Not in the current scoring table (Obies land after scoring ends); a zero
  // weight must not list an award that earned nothing.
  if (showAwards.obie && scoringConfig.obieAward) {
    const obie = showAwards.obie;
    const awards = obie.awards || obie.wins || [];
    if (awards.length > 0) {
      points += awards.length * (scoringConfig.obieAward || 0);
      awardsList.push(`Obie: ${awards.length} award${awards.length > 1 ? 's' : ''}`);
    }
  }

  return { points: Math.round(points * 100) / 100, awardsList };
}

/**
 * Nominations a show received from one ceremony. The precursor scrapers
 * write only `nominatedFor` (one entry per nomination, so a category can
 * repeat for two performers) and no `nominations` count; reading
 * `nominations ?? wins.length` scored zero nominations for 895 of 926 Drama
 * Desk records (BRO-5424). Without a count, wins missing from nominatedFor
 * count too.
 */
function nominationCount(rec) {
  const wins = rec.wins || [];
  // An explicit count is authoritative: win names are often worded slightly
  // differently from the nominee list ("Lighting Design for/of a Musical"),
  // so counting the lists would double-count those.
  if (rec.nominations != null) return Math.max(rec.nominations, wins.length);
  const nominatedFor = rec.nominatedFor || [];
  return nominatedFor.length + wins.filter(w => !nominatedFor.includes(w)).length;
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

  // PostgREST caps a response at 1000 rows: page until a short page, with id
  // as the tie-breaker so offset paging never skips or repeats a row.
  const PAGE = 1000;
  const all = [];
  for (let offset = 0; ; offset += PAGE) {
    const params = new URLSearchParams({ select: '*', order: 'created_at.asc,id.asc', limit: String(PAGE), offset: String(offset) });
    // Always one season: practice teams (BRO-5487) share this table, so a
    // caller that forgets the season must still get the real one only.
    params.append('season', `eq.${opts.season || seasonConfig.season}`);
    if (opts.league) params.append('league_name', `eq.${opts.league}`);
    if (opts.email && useAdmin) params.append('email', `eq.${opts.email}`);
    const rows = await fetchEntriesPage(`${supabaseUrl}/rest/v1/${table}?${params}`, key, useAdmin);
    all.push(...rows);
    if (rows.length < PAGE) return all;
  }
}

function fetchEntriesPage(url, key, useAdmin) {
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
          if (!Array.isArray(rows)) {
            reject(new Error(`Unexpected Supabase response: ${body.substring(0, 200)}`));
            return;
          }
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
    req.setTimeout(60000, () => req.destroy(new Error('request timed out after 60s idle')));

    req.on('error', reject);
    req.end();
  });
}

// ── Tier mappers (one copy for every fantasy script) ───────────────
// Mirror src/config/scoring.ts getCriticLabel and
// src/lib/audience-grade-utils.ts getAudienceGrade; pinned by
// tests/unit/fantasy-tier-parity.test.ts.

// DATA labels: Broadway/default bands from score-tiers.js; 55-64 stays
// "Skippable" because it keys the fantasy points map.
function criticLabelForScore(score) {
  if (score >= DEFAULT_GOLD_THRESHOLD) return 'Critical Gold';
  if (score >= RECOMMENDED_MIN) return 'Recommended';
  if (score >= WORTH_SEEING_MIN) return 'Worth Seeing';
  if (score >= MIXED_MIN) return 'Skippable';
  return 'Critical Miss';
}

function audienceGradeForScore(score) {
  if (score == null) return null;
  if (score >= 90) return 'A+';
  if (score >= 88) return 'A';
  if (score >= 83) return 'A-';
  if (score >= 78) return 'B+';
  if (score >= 73) return 'B';
  if (score >= 68) return 'B-';
  if (score >= 63) return 'C+';
  if (score >= 58) return 'C';
  if (score >= 53) return 'C-';
  if (score >= 48) return 'D';
  return 'F';
}

// ── Per-entry scoring rules ────────────────────────────────────────
// Mirrors src/config/fantasy.ts (nyDate, scoringFromDate,
// isScoreLockedForEntry). tests/unit/fantasy-leaderboard-parity.test.ts
// runs both implementations on the same fixtures.

const seasonConfig = require('../../src/config/fantasy-season.json');

/** New York calendar date (YYYY-MM-DD) for an ISO timestamp. */
const NY_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});

function nyDate(iso) {
  return NY_DAY.format(new Date(iso));
}

/** Mirrors src/config/fantasy.ts draftedDay: the stamp's NY day, clamped to the deadline day. */
function draftedDay(createdAtIso, cfg = seasonConfig) {
  const stamped = nyDate(createdAtIso);
  const lastDay = nyDate(cfg.draftDeadline || seasonConfig.draftDeadline);
  return stamped > lastDay ? lastDay : stamped;
}

/**
 * The date an entry starts earning box office points: early-bird entries
 * (drafted on or before earlyBirdCutoff, NY time) score from scoringStart;
 * later entries score from the day they draft.
 */
function scoringFromDate(createdAtIso, cfg = seasonConfig) {
  if (!createdAtIso) return cfg.scoringStart;
  const drafted = draftedDay(createdAtIso, cfg);
  if (drafted <= cfg.earlyBirdCutoff) return cfg.scoringStart;
  // Monday of the draft week (same weeks scored; see src/config/fantasy.ts).
  const d = new Date(`${drafted}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  const monday = d.toISOString().slice(0, 10);
  return monday < cfg.scoringStart ? cfg.scoringStart : monday;
}

/**
 * Critic/audience points are locked for an entry when the show had opened on
 * or before the NY date the entry was drafted (reviews drop on opening night).
 */
function isScoreLockedForEntry(openingDate, createdAtIso) {
  if (!openingDate || !createdAtIso) return false;
  return openingDate <= draftedDay(createdAtIso);
}

/** Mirrors src/config/fantasy.ts isAudienceLockedForEntry. */
function isAudienceLockedForEntry(audienceGradeSince, createdAtIso) {
  if (!audienceGradeSince || !createdAtIso) return false;
  return audienceGradeSince <= draftedDay(createdAtIso);
}

/**
 * Whether an entry may appear in the standings: 1..teamSize distinct string
 * show ids that exist in the catalog, within budget, drafted by the deadline.
 * Mirrors src/lib/data-fantasy.ts isValidLeaderboardEntry (the anon key can
 * insert rows straight into Supabase, skipping the draft route's checks).
 */
function isValidLeaderboardEntry(entry, showConfig, cfgOverrides = seasonConfig, now = Date.now()) {
  // A partial cfg (tests pass just the dates) must not switch off the budget,
  // roster or deadline checks.
  const cfg = { ...seasonConfig, ...cfgOverrides };
  const picks = entry && entry.picks;
  if (!Array.isArray(picks) || picks.length < 1 || picks.length > cfg.teamSize) return false;
  // While the draft is open the database sends N copies of 'hidden' instead of show ids
  // (20261019_fantasy_hide_rosters_until_draft_closes.sql): the team counts, its shows can't be checked.
  // Only while the draft is open: after the reveal a placeholder roster is not a real team.
  const hiddenRoster = now <= Date.parse(cfg.draftDeadline) && picks.every(id => id === HIDDEN_PICK);
  if (!hiddenRoster) {
    for (const id of picks) {
      if (typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(showConfig, id)) return false;
    }
    if (new Set(picks).size !== picks.length) return false;
    const cost = picks.reduce((sum, id) => sum + (showConfig[id].price || 0), 0);
    if (cost > cfg.budget) return false;
  }
  // Same 5-minute grace as src/config/fantasy.ts DEADLINE_GRACE_MS: the
  // database stamps created_at just after the route's deadline check.
  if (entry.created_at && Date.parse(entry.created_at) > Date.parse(cfg.draftDeadline) + DEADLINE_GRACE_MS) return false;
  // Mirrors src/lib/data-fantasy.ts: nothing real is drafted before the draft opens.
  if (entry.created_at && cfg.draftOpens && nyDate(entry.created_at) < cfg.draftOpens) return false;
  return true;
}

const DEADLINE_GRACE_MS = 5 * 60 * 1000;

/** Mirrors HIDDEN_PICK in src/lib/fantasy-roster-privacy.ts. */
const HIDDEN_PICK = 'hidden';

/**
 * Whether the weekly fantasy job should run on this New York date: from two
 * weeks before the draft opens (prices are provisional and repriced each
 * run until then, and audience grades get stamped before launch) through two
 * weeks after Tony night (the final week of grosses and Tony results land
 * after the ceremony). Reads the season file, not the generated league
 * config, which can be a run behind.
 */
function fantasyJobWindow(todayNy, cfg = seasonConfig) {
  const shift = (ymd, days) => {
    const d = new Date(`${ymd}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  const start = shift(cfg.draftOpens, -14);
  const end = shift(cfg.scoringEnd, 14);
  // Repricing stops the day before the draft opens (generate-fantasy-config.js).
  return { run: todayNy >= start && todayNy <= end, start, end, pricesProvisional: todayNy < shift(cfg.draftOpens, -1) };
}

/**
 * Points one entry earns from one drafted show.
 * @returns {{ critic, audience, boxOffice, awards, total, locked }}
 */
function entryPickPoints(score, openingDate, createdAtIso, cfg = seasonConfig) {
  if (!score) return { critic: 0, audience: 0, boxOffice: 0, awards: 0, total: 0, locked: false };
  const locked = isScoreLockedForEntry(openingDate ?? score.openingDate, createdAtIso);
  const critic = locked ? 0 : (score.criticScorePoints || 0);
  // Audience grades can be public during previews: also locked once the
  // grade was out on the draft day (src/config/fantasy.ts isAudienceLockedForEntry).
  const audienceLocked = locked || isAudienceLockedForEntry(score.audienceGradeSince, createdAtIso);
  const audience = audienceLocked ? 0 : (score.audienceGradePoints || 0);
  const from = scoringFromDate(createdAtIso, cfg);
  let boxOffice;
  if (score.weeklyBoxOffice && typeof score.weeklyBoxOffice === 'object') {
    boxOffice = 0;
    for (const [weekEnding, pts] of Object.entries(score.weeklyBoxOffice)) {
      if (weekEnding >= from) boxOffice += pts || 0;
    }
  } else {
    // Legacy snapshot without a weekly breakdown: all-or-nothing.
    boxOffice = from <= cfg.scoringStart ? (score.boxOfficePoints || 0) : 0;
  }
  boxOffice = Math.round(boxOffice * 100) / 100;
  const awards = score.awardsPoints || 0;
  const total = Math.round((critic + audience + boxOffice + awards) * 100) / 100;
  return { critic, audience, boxOffice, awards, total, locked };
}

// ── Leaderboard computation ────────────────────────────────────────

/**
 * Compute ranked leaderboard from entries + scores.
 * JS port of src/lib/data-fantasy.ts:computeLeaderboard().
 *
 * Each entry is scored from the week it drafted (scoringFromDate) and earns
 * no critic/audience points for shows that had already opened when it
 * drafted (isScoreLockedForEntry). Awards count for every entry.
 *
 * @param {Array} entries       — Fantasy entry objects from Supabase
 * @param {object} showScores   — showScores from fantasy-scores.json
 * @param {object} showConfig   — shows from fantasy-league.json
 * @returns {Array} Ranked leaderboard entries
 */
function computeLeaderboard(entries, showScores, showConfig, cfg = seasonConfig) {
  const leaderboard = entries.filter(e => isValidLeaderboardEntry(e, showConfig, cfg)).map(entry => {
    const picks = (entry.picks || []);
    let totalCritic = 0;
    let totalAudience = 0;
    let totalBoxOffice = 0;
    let totalAwards = 0;
    const scoringFrom = scoringFromDate(entry.created_at, cfg);

    const pickDetails = picks.map(showId => {
      const show = showConfig[showId];
      const score = showScores[showId];
      const p = entryPickPoints(score, show?.openingDate ?? score?.openingDate ?? null, entry.created_at, cfg);

      totalCritic += p.critic;
      totalAudience += p.audience;
      totalBoxOffice += p.boxOffice;
      totalAwards += p.awards;

      return {
        showId,
        showTitle: show?.title ?? showId,
        price: show?.price ?? 0,
        points: p.total,
        scoreLocked: p.locked,
      };
    });

    const totalPoints = Math.round((totalCritic + totalAudience + totalBoxOffice + totalAwards) * 100) / 100;

    return {
      id: entry.id,
      rank: 0,
      displayName: entry.team_name || maskEmail(entry.email),
      email: entry.email,
      totalPoints,
      scoringFrom,
      picks: pickDetails,
      pointBreakdown: {
        criticScore: Math.round(totalCritic * 100) / 100,
        audienceGrade: Math.round(totalAudience * 100) / 100,
        boxOffice: Math.round(totalBoxOffice * 100) / 100,
        awards: Math.round(totalAwards * 100) / 100,
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

// ── Weekly movers (for fantasy-weekly-email.js) ─────────────────────

/**
 * Diff two weekly fantasy-scores.json snapshots to find biggest point
 * swings and plain-language reasons a show's points changed.
 *
 * @param {object|null} prevShowScores — showScores from the prior week's
 *   snapshot (fantasy-scores-prev.json), or null/undefined on the first
 *   scored week (no prior snapshot exists yet).
 * @param {object} currShowScores      — showScores from the current snapshot
 * @param {object} shows                — fantasy-league.json shows (id → show)
 * @param {number} [limit=5]            — max movers to return
 * @returns {{ movers: Array<{showId, title, deltaPoints}>, events: Array<{showId, title, reason}> }}
 */
function computeWeeklyMovers(prevShowScores, currShowScores, shows, limit = 5) {
  if (!prevShowScores) return { movers: [], events: [] };

  const deltas = [];
  const events = [];

  for (const [showId, curr] of Object.entries(currShowScores)) {
    const prev = prevShowScores[showId];
    const title = shows[showId]?.title ?? showId;
    const deltaPoints = Math.round(((curr.totalPoints ?? 0) - (prev?.totalPoints ?? 0)) * 100) / 100;

    if (deltaPoints !== 0) {
      deltas.push({ showId, title, deltaPoints });
    }

    // Plain-language reasons: new grosses weeks, CriticScore tier change,
    // AudienceGrade change, or new awards since last week.
    if (!prev) continue;

    const currBreak = curr.breakdown || {};
    const prevBreak = prev.breakdown || {};

    if (currBreak.boxOfficeWeeks > (prevBreak.boxOfficeWeeks ?? 0)) {
      events.push({ showId, title, reason: `new grosses posted (${currBreak.boxOfficeTotal ?? 'updated'})` });
    }
    if (currBreak.criticTier && currBreak.criticTier !== prevBreak.criticTier) {
      events.push({ showId, title, reason: `CriticScore tier moved: ${prevBreak.criticTier ?? 'unscored'} → ${currBreak.criticTier}` });
    }
    if (currBreak.audienceGrade && currBreak.audienceGrade !== prevBreak.audienceGrade) {
      events.push({ showId, title, reason: `AudienceGrade changed: ${prevBreak.audienceGrade ?? 'ungraded'} → ${currBreak.audienceGrade}` });
    }
    const prevAwards = new Set(prevBreak.awards || []);
    const newAwards = (currBreak.awards || []).filter(a => !prevAwards.has(a));
    for (const award of newAwards) {
      events.push({ showId, title, reason: award });
    }
  }

  deltas.sort((a, b) => Math.abs(b.deltaPoints) - Math.abs(a.deltaPoints));

  return { movers: deltas.slice(0, limit), events };
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
  computeWeeklyMovers,
  maskEmail,
  criticLabelForScore,
  audienceGradeForScore,
  nyDate,
  scoringFromDate,
  isScoreLockedForEntry,
  isAudienceLockedForEntry,
  isValidLeaderboardEntry,
  fantasyJobWindow,
  nominationCount,
  entryPickPoints,
  sumGrossesInRange,
  projectRemainingGrosses,
  computeExpectedAwardsPoints,
  validateTonyPredictions,
};
