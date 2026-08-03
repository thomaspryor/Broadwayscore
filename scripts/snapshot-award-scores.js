#!/usr/bin/env node
/**
 * Snapshot Site Award Scores for all open shows.
 *
 * Writes data/award-score-history/YYYY-MM-DD.json so the newsletter generator
 * can diff week-over-week and surface the biggest "Award Score Movers".
 *
 * Pure-JS port of src/lib/awards-scoring.ts → computeSiteAwardScore().
 * MUST stay in sync with the TS source. If you change weights/buckets there,
 * change them here. (See `memory/feedback_dual_repo_data_files.md` style of
 * parity warning; same idea applied to TS ↔ JS.)
 *
 * Usage:
 *   node scripts/snapshot-award-scores.js                  # writes today
 *   node scripts/snapshot-award-scores.js --date=2026-05-23
 *   node scripts/snapshot-award-scores.js --markets=broadway,west-end
 *   node scripts/snapshot-award-scores.js --stdout         # dry-run, no write
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const AWARDS_PATH = path.join(ROOT, 'data', 'awards.json');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');
const OUT_DIR = path.join(ROOT, 'data', 'award-score-history');

// ----- Port of awards-scoring.ts constants -----

const POINTS = {
  tony:         { S: { win: 200, nom: 20 }, A: { win: 75, nom: 9 }, B: { win: 35, nom: 5 }, C: { win: 25, nom: 3 } },
  pulitzer:     { S: { win: 110, nom: 18 } },
  olivier_bway: { S: { win: 50,  nom: 6 },  A: { win: 25, nom: 3 },  B: { win: 15, nom: 2 }, C: { win: 12, nom: 2 } },
  olivier_we:   { S: { win: 110, nom: 14 }, A: { win: 55, nom: 7 },  B: { win: 32, nom: 4 }, C: { win: 24, nom: 3 } },
  nydcc:        { S: { win: 45,  nom: 0 } },
  occ:          { S: { win: 30,  nom: 5 },  A: { win: 20, nom: 3 },  B: { win: 12, nom: 2 }, C: { win: 8,  nom: 1 } },
  dramaLeague:  { S: { win: 35,  nom: 5 },  A: { win: 22, nom: 3 } },
  dramaDesk:    { S: { win: 28,  nom: 4 },  A: { win: 18, nom: 2 },  B: { win: 12, nom: 2 }, C: { win: 8,  nom: 1 } },
  obie:         { S: { win: 18,  nom: 0 },  A: { win: 12, nom: 0 },  B: { win: 8,  nom: 0 }, C: { win: 5,  nom: 0 } },
  lortel:       { S: { win: 20,  nom: 3 },  A: { win: 12, nom: 2 },  B: { win: 8,  nom: 1 }, C: { win: 5,  nom: 1 } },
  criticsCircle:{ S: { win: 30,  nom: 0 },  A: { win: 18, nom: 0 },  B: { win: 10, nom: 0 }, C: { win: 6,  nom: 0 } },
  eveningStandard: { S: { win: 60, nom: 8 }, A: { win: 30, nom: 4 }, B: { win: 18, nom: 2 }, C: { win: 12, nom: 2 } },
  whatsOnStage:    { S: { win: 35, nom: 5 }, A: { win: 22, nom: 3 }, B: { win: 12, nom: 2 }, C: { win: 8,  nom: 1 } },
};

const A_PLUS_MULTIPLIER = 1.2;
const REVIVAL_DISCOUNT = 0.85;
const C_STACKING = [1.0, 0.7, 0.5, 0.4, 0.4, 0.4];

// Inline the Tony cutoffs we need for `inProgress`. Only ceremonyDate matters
// for tonyCeremonyIsFuture(); we copy the recent rows (2023-onwards) since no
// open show today will have a ceremony year older than that. If a show points
// at a label we don't have here, we conservatively return false.
const TONY_CEREMONY_DATE_BY_LABEL = {
  '2023-24': null,         // ceremony already happened (2024-06-16)
  '2024-25': '2025-06-08',
  '2025-26': '2026-06-07',
  '2026-27': null,         // provisional — no scheduled date
};
const TONY_END_BY_LABEL = {
  '2023-24': '2024-04-25',
  '2024-25': '2025-04-27',
  '2025-26': '2026-04-26',
  '2026-27': '2027-04-25',
};

function tonyCeremonyIsFuture(season, today = new Date()) {
  if (!season) return false;
  const cer = TONY_CEREMONY_DATE_BY_LABEL[season];
  if (cer) {
    const ceremonyMs = new Date(cer + 'T00:00:00Z').getTime();
    if (!Number.isFinite(ceremonyMs)) return false;
    return ceremonyMs > today.getTime();
  }
  const endIso = TONY_END_BY_LABEL[season];
  if (!endIso) return false;
  const endMs = new Date(endIso + 'T00:00:00Z').getTime();
  if (!Number.isFinite(endMs)) return false;
  const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;
  return (endMs + NINETY_DAYS) > today.getTime();
}

function classifyCategory(category) {
  const c = (category || '').toLowerCase();
  if (/revival of a musical|musical revival/.test(c)) return { tier: 'S', revival: true };
  if (/revival of a play|play revival/.test(c)) return { tier: 'S', revival: true };
  if (/^outstanding revival$/.test(c)) return { tier: 'S', revival: true };
  if (/best musical$|outstanding musical$|outstanding new (broadway|off-broadway) musical|outstanding production of a (broadway or off-broadway )?musical/.test(c)) return { tier: 'S', revival: false };
  if (/best play$|outstanding play$|outstanding new (broadway|off-broadway) play|outstanding production of a play/.test(c)) return { tier: 'S', revival: false };
  if (/best new play/.test(c)) return { tier: 'S', revival: false };
  if (/^best revival$/.test(c)) return { tier: 'S', revival: true };
  if (/^drama$/.test(c)) return { tier: 'S', revival: false };
  if (/best (original )?score|outstanding (new )?score|outstanding music\b|outstanding lyrics|outstanding music in a play/.test(c)) return { tier: 'A+', revival: false };
  if (/best book|outstanding book/.test(c)) return { tier: 'A+', revival: false };
  if (/direction|director/.test(c)) return { tier: 'A', revival: false };
  if (/choreograph/.test(c)) return { tier: 'A', revival: false };
  if (/distinguished performance/.test(c)) return { tier: 'A', revival: false };
  if (/best (actor|actress) in a (play|musical)|outstanding (actor|actress) in a (play|musical)/.test(c)) return { tier: 'A', revival: false };
  if (/^best (actor|actress)$/.test(c)) return { tier: 'A', revival: false };
  if (/outstanding lead (performance|performer|actor|actress) in an? (broadway |off-broadway )?(play|musical)/.test(c)) return { tier: 'A', revival: false };
  if (/best supporting performer in a/.test(c)) return { tier: 'B', revival: false };
  if (/best performer in a/.test(c)) return { tier: 'A', revival: false };
  if (/best supporting (actor|actress)/.test(c)) return { tier: 'B', revival: false };
  if (/best off.?west.?end production/.test(c)) return { tier: 'S', revival: false };
  if (/best original music\b/.test(c)) return { tier: 'A+', revival: false };
  if (/video design/.test(c)) return { tier: 'C', revival: false };
  if (/featured (actor|actress)/.test(c)) return { tier: 'B', revival: false };
  if (/best (actor|actress) in a supporting role/.test(c)) return { tier: 'B', revival: false };
  if (/outstanding featured (performance|performer|actor|actress) in an? (broadway |off-broadway )?(play|musical)/.test(c)) return { tier: 'B', revival: false };
  if (/orchestration/.test(c)) return { tier: 'B', revival: false };
  if (/ensemble/.test(c)) return { tier: 'B', revival: false };
  if (/scenic|set design/.test(c)) return { tier: 'C', revival: false };
  if (/costume/.test(c)) return { tier: 'C', revival: false };
  if (/lighting/.test(c)) return { tier: 'C', revival: false };
  if (/sound/.test(c)) return { tier: 'C', revival: false };
  if (/projection design/.test(c)) return { tier: 'C', revival: false };
  if (/solo performance|solo show/.test(c)) return { tier: 'B', revival: false };
  if (/john gassner award|most promising playwright/.test(c)) return { tier: 'C', revival: false };
  if (/best foreign play/.test(c)) return { tier: 'S', revival: false };
  if (/best new american play|outstanding new american play/.test(c)) return { tier: 'S', revival: false };
  if (/best new musical/.test(c)) return { tier: 'S', revival: false };
  if (/\bbest performance\b/.test(c)) return { tier: 'B', revival: false };
  if (/special achievement|body of work/.test(c)) return null;
  return null;
}

function applyMultipliers(points, tier, isRevival) {
  let p = points;
  if (tier === 'A+') p *= A_PLUS_MULTIPLIER;
  if (isRevival) p *= REVIVAL_DISCOUNT;
  return p;
}

function pointsForTier(table, tier) {
  if (tier === 'A+') return table.A || null;
  return table[tier] || null;
}

function scoreCeremony(display, key, wins, noms, unknownNomCount = 0) {
  const table = POINTS[key];
  const items = [];
  const winCount = {};
  const nomCount = {};
  for (const w of wins) winCount[w] = (winCount[w] || 0) + 1;
  for (const n of noms) nomCount[n] = (nomCount[n] || 0) + 1;
  let cWinsSeen = 0;
  for (const [cat, count] of Object.entries(winCount)) {
    const cls = classifyCategory(cat);
    if (!cls) continue;
    const pts = pointsForTier(table, cls.tier);
    if (!pts) continue;
    for (let i = 0; i < count; i++) {
      let raw = pts.win;
      if (cls.tier === 'C') {
        raw *= C_STACKING[Math.min(cWinsSeen, C_STACKING.length - 1)];
        cWinsSeen++;
      }
      items.push({ category: cat, tier: cls.tier, revival: cls.revival, result: 'win', points: applyMultipliers(raw, cls.tier, cls.revival) });
    }
  }
  for (const [cat, count] of Object.entries(nomCount)) {
    const cls = classifyCategory(cat);
    if (!cls) continue;
    const pts = pointsForTier(table, cls.tier);
    if (!pts || pts.nom <= 0) continue;
    const losing = Math.max(0, count - (winCount[cat] || 0));
    for (let i = 0; i < losing; i++) {
      items.push({ category: cat, tier: cls.tier, revival: cls.revival, result: 'nom', points: applyMultipliers(pts.nom, cls.tier, cls.revival) });
    }
  }
  if (unknownNomCount > 0 && table.C && table.C.nom > 0) {
    for (let i = 0; i < unknownNomCount; i++) {
      items.push({ category: '(uncategorized)', tier: 'C', revival: false, result: 'nom', points: table.C.nom });
    }
  }
  const subtotal = items.reduce((s, x) => s + x.points, 0);
  return { ceremony: display, items, subtotal };
}

function unknownNoms(totalCount, enumeratedWins, enumeratedNoms) {
  if (!totalCount) return 0;
  const enumerated = new Set([...enumeratedWins, ...enumeratedNoms]).size;
  return Math.max(0, totalCount - enumerated);
}

function computeSiteAwardScore(showId, awardsShows, market = 'broadway', today = new Date()) {
  const entry = awardsShows[showId];
  if (!entry) {
    return { rawPoints: 0, displayScore: 0, badge: 'eligible', inProgress: false, tonyWins: 0, tonyNoms: 0, tonySeason: undefined };
  }
  const breakdown = [];
  if (entry.tony) {
    const wins = entry.tony.wins || [];
    const noms = entry.tony.nominatedFor || [];
    breakdown.push(scoreCeremony('Tony Awards', 'tony', wins, noms, unknownNoms(entry.tony.nominations, wins, noms)));
  }
  if (entry.pulitzer || entry.pulitzerFinalist) {
    const wins = (entry.pulitzer && entry.pulitzer.wins) || [];
    const finalists = (entry.pulitzer && entry.pulitzer.finalist) ? [...entry.pulitzer.finalist] : [];
    if (entry.pulitzerFinalist) finalists.push('Drama');
    breakdown.push(scoreCeremony('Pulitzer Prize', 'pulitzer', wins, finalists));
  }
  if (entry.olivier) {
    const key = market === 'broadway' ? 'olivier_bway' : 'olivier_we';
    const wins = entry.olivier.wins || [];
    const noms = entry.olivier.nominatedFor || [];
    breakdown.push(scoreCeremony('Olivier Awards', key, wins, noms, unknownNoms(entry.olivier.nominations, wins, noms)));
  }
  if (entry.nyDramaCritics && !entry.nyDramaCritics.noAward) {
    breakdown.push(scoreCeremony("NY Drama Critics' Circle", 'nydcc', entry.nyDramaCritics.wins || [], []));
  }
  if (entry.outerCriticsCircle) {
    const wins = entry.outerCriticsCircle.wins || [];
    const noms = entry.outerCriticsCircle.nominatedFor || [];
    breakdown.push(scoreCeremony('Outer Critics Circle', 'occ', wins, noms, unknownNoms(entry.outerCriticsCircle.nominations, wins, noms)));
  }
  if (entry.dramaLeague) {
    const wins = entry.dramaLeague.wins || [];
    const noms = entry.dramaLeague.nominatedFor || [];
    breakdown.push(scoreCeremony('Drama League', 'dramaLeague', wins, noms));
  }
  if (entry.dramadesk) {
    const wins = entry.dramadesk.wins || [];
    const noms = entry.dramadesk.nominatedFor || [];
    breakdown.push(scoreCeremony('Drama Desk', 'dramaDesk', wins, noms, unknownNoms(entry.dramadesk.nominations, wins, noms)));
  }
  if (entry.obie) {
    const wins = entry.obie.wins || [];
    breakdown.push(scoreCeremony('Obie Awards', 'obie', wins, []));
  }
  if (entry.lortel) {
    const wins = entry.lortel.wins || [];
    const noms = entry.lortel.nominatedFor || [];
    breakdown.push(scoreCeremony('Lucille Lortel Awards', 'lortel', wins, noms, unknownNoms(entry.lortel.nominations, wins, noms)));
  }
  if (entry.criticsCircle) {
    const wins = entry.criticsCircle.wins || [];
    const noms = entry.criticsCircle.nominatedFor || [];
    breakdown.push(scoreCeremony("Critics' Circle Theatre Awards", 'criticsCircle', wins, noms));
  }
  if (entry.eveningStandard) {
    const wins = entry.eveningStandard.wins || [];
    const noms = entry.eveningStandard.nominatedFor || [];
    breakdown.push(scoreCeremony('Evening Standard Theatre Awards', 'eveningStandard', wins, noms));
  }
  if (entry.whatsOnStage) {
    const wins = entry.whatsOnStage.wins || [];
    const noms = entry.whatsOnStage.nominatedFor || [];
    breakdown.push(scoreCeremony('WhatsOnStage Awards', 'whatsOnStage', wins, noms));
  }
  const rawPoints = breakdown.reduce((s, b) => s + b.subtotal, 0);
  const displayScore = Math.max(0, Math.min(100, Math.round(40 * Math.log10(1 + rawPoints / 4))));
  const totalWins = breakdown.reduce((s, b) => s + b.items.filter((i) => i.result === 'win').length, 0);
  let badge;
  if (displayScore === 0) badge = 'eligible';
  else if (totalWins === 0) badge = 'nominated';
  else if (displayScore <= 69) badge = 'honored';
  else if (displayScore <= 89) badge = 'decorated';
  else badge = 'sweeper';
  const showSeason = entry.tony && entry.tony.season;
  const tonyDone = ((entry.tony && entry.tony.wins) ? entry.tony.wins.length : 0) > 0;
  const inProgress = !!showSeason && !tonyDone && tonyCeremonyIsFuture(showSeason, today);
  const tonyWins = (entry.tony && entry.tony.wins) ? entry.tony.wins.length : 0;
  const tonyNoms = (entry.tony && entry.tony.nominatedFor) ? entry.tony.nominatedFor.length : 0;
  return { rawPoints, displayScore, badge, inProgress, tonyWins, tonyNoms, tonySeason: showSeason };
}

// ----- Main -----

function parseArgs(argv) {
  const args = { date: null, markets: ['broadway'], stdout: false };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--date=')) args.date = a.slice('--date='.length);
    else if (a.startsWith('--markets=')) args.markets = a.slice('--markets='.length).split(',').map((x) => x.trim()).filter(Boolean);
    else if (a === '--stdout') args.stdout = true;
    else if (a === '--all-markets') args.markets = ['broadway', 'west-end'];
    else if (a === '-h' || a === '--help') {
      console.log('Usage: snapshot-award-scores.js [--date=YYYY-MM-DD] [--markets=broadway,west-end] [--stdout]');
      process.exit(0);
    }
  }
  if (!args.date) args.date = new Date().toISOString().slice(0, 10);
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  const awards = JSON.parse(fs.readFileSync(AWARDS_PATH, 'utf8'));
  const showsRaw = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const showsArr = Array.isArray(showsRaw) ? showsRaw : (showsRaw.shows || []);
  const showById = new Map();
  for (const s of showsArr) showById.set(s.id, s);

  const awardsShows = awards.shows || {};
  const today = new Date(args.date + 'T12:00:00Z');

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const results = [];
  for (const market of args.markets) {
    const openShows = showsArr.filter((s) => s.status === 'open' && s.category === market);
    const shows = {};
    for (const s of openShows) {
      const result = computeSiteAwardScore(s.id, awardsShows, market, today);
      shows[s.id] = {
        title: s.title,
        displayScore: result.displayScore,
        rawPoints: Math.round(result.rawPoints * 100) / 100,
        badge: result.badge,
        inProgress: result.inProgress,
        tonyWins: result.tonyWins,
        tonyNoms: result.tonyNoms,
        tonySeason: result.tonySeason || null,
      };
    }
    const snapshot = {
      snapshotDate: args.date,
      market,
      generatedAt: new Date().toISOString(),
      showCount: Object.keys(shows).length,
      shows,
    };
    if (args.stdout) {
      console.log(JSON.stringify(snapshot, null, 2));
    } else {
      const fname = args.markets.length === 1 && market === 'broadway'
        ? `${args.date}.json`
        : `${args.date}-${market}.json`;
      const outPath = path.join(OUT_DIR, fname);
      fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + '\n');
      results.push({ market, path: outPath, count: snapshot.showCount });
    }
  }

  if (!args.stdout) {
    for (const r of results) {
      console.log(`wrote ${r.count} ${r.market} shows → ${path.relative(ROOT, r.path)}`);
    }
  }
}

if (require.main === module) {
  main();
}

// Reusable export — generate-mobile-show-details.js consumes the same
// computation so the mobile Awards Scorecard matches the site (task: card parity).
module.exports = { computeSiteAwardScore };
