#!/usr/bin/env node
/**
 * fantasy-admin.js — Admin CLI for Broadway Fantasy League
 *
 * Subcommands:
 *   standings [--league=NAME] [--json]  — Leaderboard rankings
 *   entries  [--email=X] [--league=NAME] — List draft entries
 *   show <show-id>                      — Scoring breakdown for a show
 *   scores [--dry-run]                  — Recompute fantasy scores (delegates)
 *   email [--dry-run|--draft]           — Generate/create weekly email (delegates)
 *   winner                              — Declare the season winner
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY
 *
 * Usage: node scripts/fantasy-admin.js <command> [options]
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { fetchFantasyEntries, computeLeaderboard, computeAwardsPoints } = require('./lib/fantasy-helpers');

const dataDir = path.join(__dirname, '..', 'data');

// ── Arg parsing ────────────────────────────────────────────────────
const args = process.argv.slice(2);
const command = args[0];

function getFlag(name) {
  const arg = args.find(a => a.startsWith(`--${name}=`));
  return arg ? arg.split('=').slice(1).join('=') : null;
}
function hasFlag(name) {
  return args.includes(`--${name}`);
}

// ── Commands ───────────────────────────────────────────────────────

async function cmdStandings() {
  const leagueFilter = getFlag('league');
  const jsonOutput = hasFlag('json');

  const leagueData = loadJSON('fantasy-league.json');
  const scoresData = loadJSON('fantasy-scores.json');

  const entries = await fetchFantasyEntries({
    season: leagueData._meta.season,
    league: leagueFilter,
  });

  if (entries.length === 0) {
    console.log('No entries found.' + (leagueFilter ? ` (league: ${leagueFilter})` : ''));
    return;
  }

  const leaderboard = computeLeaderboard(entries, scoresData.showScores, leagueData.shows);

  if (jsonOutput) {
    console.log(JSON.stringify(leaderboard, null, 2));
    return;
  }

  console.log(`\n  Broadway Fantasy League — Standings`);
  console.log(`  Season: ${leagueData._meta.season}  |  Scored: ${scoresData._meta.lastUpdated.split('T')[0]}`);
  if (leagueFilter) console.log(`  League: ${leagueFilter}`);
  console.log(`  ${'─'.repeat(70)}`);
  console.log(`  ${'Rank'.padEnd(6)}${'Team'.padEnd(30)}${'Points'.padStart(8)}  ${'CS'.padStart(4)} ${'AG'.padStart(4)} ${'BO'.padStart(6)} ${'AW'.padStart(4)}`);
  console.log(`  ${'─'.repeat(70)}`);

  for (const entry of leaderboard) {
    const b = entry.pointBreakdown;
    console.log(
      `  ${('#' + entry.rank).padEnd(6)}` +
      `${entry.displayName.substring(0, 28).padEnd(30)}` +
      `${entry.totalPoints.toFixed(1).padStart(8)}  ` +
      `${b.criticScore.toString().padStart(4)} ` +
      `${b.audienceGrade.toString().padStart(4)} ` +
      `${b.boxOffice.toFixed(1).padStart(6)} ` +
      `${b.awards.toString().padStart(4)}`
    );
  }
  console.log(`\n  ${entries.length} entries total\n`);
}

async function cmdEntries() {
  const leagueFilter = getFlag('league');
  const emailFilter = getFlag('email');

  const leagueData = loadJSON('fantasy-league.json');
  const entries = await fetchFantasyEntries({
    season: leagueData._meta.season,
    league: leagueFilter,
    email: emailFilter,
  });

  if (entries.length === 0) {
    console.log('No entries found.');
    return;
  }

  console.log(`\n  Fantasy Entries (${entries.length})\n`);

  for (const entry of entries) {
    const picks = entry.picks || [];
    console.log(`  ${entry.team_name || '(no team name)'}  —  ${entry.email}`);
    console.log(`  League: ${entry.league_name || '(none)'}  |  Cost: $${entry.total_cost}  |  Drafted: ${entry.created_at.split('T')[0]}`);
    console.log(`  Picks:`);
    for (const showId of picks) {
      const show = leagueData.shows[showId];
      console.log(`    $${(show?.price || '?').toString().padStart(2)}  ${show?.title || showId}`);
    }
    console.log();
  }
}

function cmdShow() {
  const showId = args[1];
  if (!showId) {
    console.error('Usage: fantasy-admin.js show <show-id>');
    process.exit(1);
  }

  const leagueData = loadJSON('fantasy-league.json');
  const scoresData = loadJSON('fantasy-scores.json');
  const awardsData = loadJSON('awards.json');
  const show = leagueData.shows[showId];
  const score = scoresData.showScores[showId];

  if (!show) {
    console.error(`Show not found in fantasy league: ${showId}`);
    const similar = Object.keys(leagueData.shows).filter(id => id.includes(showId.split('-')[0]));
    if (similar.length) console.error(`  Did you mean: ${similar.join(', ')}`);
    process.exit(1);
  }

  const awards = computeAwardsPoints(showId, awardsData, leagueData.scoring.awards);

  console.log(`\n  ${show.title}`);
  console.log(`  ${'─'.repeat(50)}`);
  console.log(`  ID:       ${showId}`);
  console.log(`  Price:    $${show.price}`);
  console.log(`  Type:     ${show.type} (${show.category})`);
  console.log(`  Status:   ${show.status}`);
  console.log(`  Opening:  ${show.openingDate || 'TBD'}`);
  console.log();
  console.log(`  Scoring Breakdown:`);
  if (score) {
    console.log(`    CriticScore:    ${score.criticScorePoints.toString().padStart(6)} pts  (${score.breakdown.criticTier || 'N/A'})`);
    console.log(`    AudienceGrade:  ${score.audienceGradePoints.toString().padStart(6)} pts  (${score.breakdown.audienceGrade || 'N/A'})`);
    console.log(`    Box Office:     ${score.boxOfficePoints.toFixed(1).padStart(6)} pts  (${score.breakdown.boxOfficeWeeks} weeks, ${score.breakdown.boxOfficeTotal})`);
    console.log(`    Awards:         ${score.awardsPoints.toString().padStart(6)} pts`);
    if (awards.awardsList.length > 0) {
      awards.awardsList.forEach(a => console.log(`                           ${a}`));
    } else {
      console.log(`                           (none yet)`);
    }
    console.log(`    ${'─'.repeat(30)}`);
    console.log(`    TOTAL:          ${score.totalPoints.toFixed(1).padStart(6)} pts`);
  } else {
    console.log(`    (no scores computed yet — run: node scripts/compute-fantasy-scores.js)`);
  }

  console.log(`\n  Eligibility:`);
  console.log(`    CriticScore:  ${show.eligible.criticScore ? '✓' : '✗ (locked)'}`);
  console.log(`    Audience:     ${show.eligible.audienceGrade ? '✓' : '✗'}`);
  console.log(`    Box Office:   ${show.eligible.boxOffice ? '✓' : '✗ (off-broadway)'}`);
  console.log(`    Tonys:        ${show.eligible.tonys ? '✓' : '✗ (off-broadway)'}`);
  console.log();
}

function cmdScores() {
  const dryRun = hasFlag('dry-run') ? ' --dry-run' : '';
  console.log(`Running: node scripts/compute-fantasy-scores.js${dryRun}`);
  execSync(`node ${path.join(__dirname, 'compute-fantasy-scores.js')}${dryRun}`, { stdio: 'inherit' });
}

function cmdEmail() {
  const flags = args.slice(1).join(' ');
  console.log(`Running: node scripts/fantasy-weekly-email.js ${flags}`);
  execSync(`node ${path.join(__dirname, 'fantasy-weekly-email.js')} ${flags}`, { stdio: 'inherit' });
}

async function cmdWinner() {
  const leagueData = loadJSON('fantasy-league.json');
  const scoresData = loadJSON('fantasy-scores.json');

  const entries = await fetchFantasyEntries({ season: leagueData._meta.season });
  if (entries.length === 0) {
    console.log('No entries found — no winner to declare.');
    return;
  }

  const leaderboard = computeLeaderboard(entries, scoresData.showScores, leagueData.shows);
  const winners = leaderboard.filter(e => e.rank === 1);

  console.log(`\n  Broadway Fantasy League — Season Winner${winners.length > 1 ? 's (tied)' : ''}`);
  console.log(`  Season: ${leagueData._meta.season}`);
  console.log(`  Prize:  $500 TodayTix voucher`);
  console.log(`  ${'─'.repeat(70)}`);

  for (const w of winners) {
    console.log(`  ${w.displayName}  —  ${w.email}`);
    console.log(`  Points: ${w.totalPoints.toFixed(1)}`);
    console.log(`  Picks:`);
    for (const p of w.picks) {
      console.log(`    $${p.price.toString().padStart(2)}  ${p.showTitle}  (+${p.points.toFixed(1)} pts)`);
    }
    console.log();
  }

  if (winners.length > 1) {
    console.log(`  ${winners.length} winners tied. Apply tiebreaker questions (see fantasy-league.json tiebreakers).`);
  }
  console.log(`  ${entries.length} total entries scored.\n`);
}

// ── Helpers ────────────────────────────────────────────────────────

function loadJSON(filename) {
  const filepath = path.join(dataDir, filename);
  if (!fs.existsSync(filepath)) {
    console.error(`Missing: ${filepath}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(filepath, 'utf8'));
}

function printUsage() {
  console.log(`
  fantasy-admin.js — Broadway Fantasy League Admin CLI

  Usage: node scripts/fantasy-admin.js <command> [options]

  Commands:
    standings [--league=NAME] [--json]    Leaderboard rankings
    entries   [--email=X] [--league=NAME] List draft entries
    show      <show-id>                   Scoring breakdown for a show
    scores    [--dry-run]                 Recompute fantasy scores
    email     [--dry-run|--draft]         Generate/create weekly email
    winner                                Declare the season winner

  Env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY
`);
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  switch (command) {
    case 'standings': return cmdStandings();
    case 'entries': return cmdEntries();
    case 'show': return cmdShow();
    case 'scores': return cmdScores();
    case 'email': return cmdEmail();
    case 'winner': return cmdWinner();
    default:
      printUsage();
      if (command) console.error(`Unknown command: ${command}`);
      process.exit(command ? 1 : 0);
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
