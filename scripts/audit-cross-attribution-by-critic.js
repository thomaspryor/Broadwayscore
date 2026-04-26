#!/usr/bin/env node
/**
 * audit-cross-attribution-by-critic.js
 *
 * Content-based cross-attribution audit. For each review-text file, build a
 * "show fingerprint" of distinctive tokens (title words, cast names, creative
 * team, venue) for every show in shows.json, then score the file's content
 * against every show's fingerprint. If the dominant content match is NOT the
 * show the file is filed under, flag as a cross-attribution candidate.
 *
 * Output: data/audit/cross-attribution-report.json
 *   - summary by confidence tier
 *   - groups by critic (sorted by # of cross-attributions)
 *   - per-file detail: filed showId, detected showId, score, margin, evidence
 *
 * Usage:
 *   node scripts/audit-cross-attribution-by-critic.js
 *   node scripts/audit-cross-attribution-by-critic.js --apply        # high-conf auto-flag
 *   node scripts/audit-cross-attribution-by-critic.js --critic="Stuart King"
 *   node scripts/audit-cross-attribution-by-critic.js --review-texts-dir=/path
 *   node scripts/audit-cross-attribution-by-critic.js --min-score=8 --min-margin=3
 *   node scripts/audit-cross-attribution-by-critic.js --verbose
 *
 * Source-of-truth note: writes (--apply) target the private review-texts repo
 * at ~/broadway-review-texts (see memory/feedback_review_texts_not_symlink.md).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { wrongShowCleared } = require('./lib/review-guards');

const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const m = args.find(a => a.startsWith(`--${name}=`));
  return m ? m.split('=').slice(1).join('=') : fallback;
}
const APPLY = args.includes('--apply');
const VERBOSE = args.includes('--verbose');
const CRITIC_FILTER = arg('critic', null);
const MIN_SCORE = Number(arg('min-score', '8'));
const MIN_MARGIN = Number(arg('min-margin', '3'));
const MIN_FILED_RATIO = Number(arg('min-filed-ratio', '0.25'));

const REVIEW_TEXTS_DIR = arg('review-texts-dir',
  path.join(os.homedir(), 'broadway-review-texts'));
const SHOWS_PATH = arg('shows-path',
  path.join(__dirname, '..', 'data', 'shows.json'));
const REPORT_PATH = arg('report-path',
  path.join(__dirname, '..', 'data', 'audit', 'cross-attribution-report.json'));

function log(...m) { if (VERBOSE) console.log(...m); }

if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
  console.error(`Review-texts dir not found: ${REVIEW_TEXTS_DIR}`);
  console.error(`Pass --review-texts-dir=/path to override.`);
  process.exit(2);
}
if (!fs.existsSync(SHOWS_PATH)) {
  console.error(`shows.json not found: ${SHOWS_PATH}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Tokenization & stopwords
// ---------------------------------------------------------------------------

function normalizeForMatching(s) {
  if (!s) return '';
  return String(s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .toLowerCase();
}

function tokenize(text) {
  return normalizeForMatching(text)
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 3);
}

// English + theater + market noise. Anything in this set is excluded from
// fingerprints AND from per-file content tokens (so it can't contribute to a
// score either way).
const STOPWORDS = new Set([
  // articles, prepositions, common verbs / pronouns
  'the','and','for','with','from','that','this','have','has','had','was','were',
  'are','will','would','could','should','been','being','about','into','onto',
  'over','under','after','before','during','through','above','below','out','off',
  'too','more','most','some','such','than','then','they','them','their','there',
  'these','those','what','when','where','which','while','who','whom','whose',
  'how','why','any','all','can','one','two','three','four','five','its','his',
  'her','hers','him','our','ours','your','yours','you','not','but','also','only',
  'just','very','much','many','none','own','say','said','says','see','seen',
  'show','shows','play','plays','musical','musicals','theatre','theater',
  'theatres','theaters','stage','staged','staging','review','reviews','reviewing',
  'production','productions','star','stars','starring','starred','direct',
  'directed','director','directs','book','lyrics','music','choreography',
  'choreographer','set','sets','design','designer','designs','costume','costumes',
  'lighting','sound','script','scripts','scene','scenes','cast','casting',
  'opens','opening','closes','closing','open','close','closed','run','runs',
  'running','tour','touring','toured','transfer','transfers','transferred',
  'preview','previews','previewing','curtain','intermission','interval','act',
  'acts','seat','seats','seated','seating','audience','audiences','tickets',
  'ticket','price','prices','box','office','venue','venues','house',
  // markets / cities
  'broadway','off','west','end','london','new','york','manhattan','nyc',
  'street','avenue','square','road','district','uk','britain','british',
  'american','america','american','english','royal',
  // outlet / aggregator / scoring noise
  'rating','rated','score','stars','starz','critic','critics','verdict',
  'roundup','roundups','round','wrap','wrapup','digest','summary','feature',
  'article','articles','column','blog','post','posts','news','editor',
  // generic adjectives common in theater writing
  'good','great','best','worst','better','worse','strong','weak','beautiful',
  'wonderful','excellent','superb','dazzling','brilliant','funny','sad',
  'happy','dark','light','small','big','large','huge','little','high','low',
  'old','young','first','last','next','final','early','late','recent',
  'modern','classic','original','revival','revised','updated','adapted',
  'based','inspired','told','tells','telling','story','stories','tale','tales',
  // calendar
  'monday','tuesday','wednesday','thursday','friday','saturday','sunday',
  'january','february','march','april','may','june','july','august','september',
  'october','november','december',
  // pronouns / fillers
  'mr','mrs','ms','sir','dame','dont','wont','isnt','wasnt','arent','werent',
  'nyc','com','org','net','www','http','https','html',
  // theater verbs / nouns common across many reviews
  'performance','performances','perform','performed','performs','performer',
  'performers','role','roles','character','characters','dialogue','songs',
  'song','singing','dance','dancing','dancers','dancer','number','numbers',
  'moment','moments','version','versions','feel','feels','felt','look','looks',
  'looked','find','found','finds','make','made','makes','take','took','taken',
  'takes','give','gave','given','gives','come','came','comes','put','puts',
  'getting','let','lets','letting','keep','kept','keeps','seem','seems','seemed',
  // years
  ...Array.from({ length: 60 }, (_, i) => String(1980 + i)),
]);

function isUsableToken(t) {
  if (t.length < 3) return false;
  if (STOPWORDS.has(t)) return false;
  if (/^\d+$/.test(t)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Build per-show fingerprints
// ---------------------------------------------------------------------------

console.log('Loading shows.json…');
const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
const shows = showsData.shows || showsData;
console.log(`  ${shows.length} shows`);

function fingerprintTokens(show) {
  const tokens = new Set();

  // Title (pre- and post-colon, both)
  for (const part of [show.title, show.subtitle].filter(Boolean)) {
    for (const t of tokenize(part)) if (isUsableToken(t)) tokens.add(t);
  }

  // Cast: full names AND last names. Last names are most distinctive.
  for (const c of (show.cast || [])) {
    if (!c?.name) continue;
    for (const t of tokenize(c.name)) if (isUsableToken(t)) tokens.add(t);
  }

  // Creative team — director/writer/composer names show up in reviews.
  for (const c of (show.creativeTeam || show.creative || [])) {
    if (!c?.name) continue;
    for (const t of tokenize(c.name)) if (isUsableToken(t)) tokens.add(t);
  }

  // Venue: distinctive theater names (Bridge, Globe, Booth, etc.)
  for (const v of [show.venue, show.theatreName, show.theaterName].filter(Boolean)) {
    for (const t of tokenize(v)) if (isUsableToken(t)) tokens.add(t);
  }

  return tokens;
}

console.log('Building fingerprints…');
const fingerprints = new Map(); // showId → Set(tokens)
const showById = new Map();
for (const s of shows) {
  if (!s.id) continue;
  showById.set(s.id, s);
  fingerprints.set(s.id, fingerprintTokens(s));
}

// Inverted index: token → Set(showIds)
const tokenToShows = new Map();
for (const [showId, tokens] of fingerprints) {
  for (const t of tokens) {
    let set = tokenToShows.get(t);
    if (!set) { set = new Set(); tokenToShows.set(t, set); }
    set.add(showId);
  }
}

// IDF weight per token. Uses doc-freq = number of show fingerprints containing
// the token. Very common tokens (e.g., a popular actor name in many shows)
// approach 0; tokens unique to one show approach log(N).
const N = shows.length;
const idf = new Map();
for (const [t, set] of tokenToShows) {
  // Add-1 smoothing in denominator so single-show tokens don't divide by zero.
  idf.set(t, Math.log(N / (1 + set.size)));
}

console.log(`  vocabulary: ${tokenToShows.size} tokens, ${fingerprints.size} show fingerprints`);

// ---------------------------------------------------------------------------
// Walk review-texts and score each file
// ---------------------------------------------------------------------------

function extractContent(data) {
  // Concatenate every text field that might carry the review's actual content.
  // wrongFullText is included intentionally — when a file was flagged as
  // wrongProduction, the original content was preserved here, and that's
  // exactly what reveals which show the text really belongs to.
  const parts = [
    data.fullText,
    data.wrongFullText,
    data.excerpt,
    data.lboRoundupExcerpt,
    data.dtliRoundupExcerpt,
    data.bwwRoundupExcerpt,
    data.bwwReviewExcerpt,
    data.playbillVerdictExcerpt,
    data.showScoreExcerpt,
    data.theatreReviewsExcerpt,
    data.westEndTheatreExcerpt,
    data.stagedoorExcerpt,
    data.stageRoundupExcerpt,
    data.nycTheatreRoundupExcerpt,
    data.snippet,
    data.summary,
    data.headline,
    data.title,
    data.contentVerification?.reasoning,
  ].filter(Boolean);
  return parts.join(' \n ');
}

function scoreFileAgainstShows(content, filedShowId) {
  // Walk content tokens, accumulate per-show scores via inverted index.
  const tokens = tokenize(content).filter(isUsableToken);
  if (tokens.length === 0) return null;

  const scores = new Map(); // showId → weighted score
  const evidenceByShow = new Map(); // showId → Map(token → count)

  // De-duplicate tokens within content but track raw multiplicity for evidence.
  const tokenCounts = new Map();
  for (const t of tokens) tokenCounts.set(t, (tokenCounts.get(t) || 0) + 1);

  for (const [t, count] of tokenCounts) {
    const showSet = tokenToShows.get(t);
    if (!showSet) continue;
    const weight = idf.get(t) * Math.log(1 + count);
    for (const showId of showSet) {
      scores.set(showId, (scores.get(showId) || 0) + weight);
      let ev = evidenceByShow.get(showId);
      if (!ev) { ev = new Map(); evidenceByShow.set(showId, ev); }
      ev.set(t, count);
    }
  }

  if (scores.size === 0) return null;

  // Top 3
  const ranked = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([showId, score]) => ({
      showId,
      score: Number(score.toFixed(3)),
      title: showById.get(showId)?.title || null,
      topTokens: [...(evidenceByShow.get(showId) || new Map()).entries()]
        .sort((a, b) => (idf.get(b[0]) || 0) - (idf.get(a[0]) || 0))
        .slice(0, 6)
        .map(([t, c]) => ({ token: t, count: c, idf: Number((idf.get(t) || 0).toFixed(2)) })),
    }));

  const filedScore = scores.get(filedShowId) || 0;
  return {
    ranked,
    filedScore: Number(filedScore.toFixed(3)),
    contentTokenCount: tokens.length,
  };
}

console.log(`Scanning ${REVIEW_TEXTS_DIR}…`);
const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR).filter(d => {
  if (d.startsWith('.') || d === '_pending') return false;
  return fs.statSync(path.join(REVIEW_TEXTS_DIR, d)).isDirectory();
});

let totalFiles = 0;
let scanned = 0;
let skippedFlagged = 0;
let skippedRoundup = 0;
let skippedNoContent = 0;
let skippedFiledNotInShows = 0;
const flags = []; // cross-attribution candidates

for (const dirId of showDirs) {
  const showDir = path.join(REVIEW_TEXTS_DIR, dirId);
  const files = fs.readdirSync(showDir)
    .filter(f => f.endsWith('.json') && f !== 'failed-fetches.json' && !f.startsWith('.'));

  for (const file of files) {
    totalFiles++;
    const filePath = path.join(showDir, file);
    let data;
    try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch { continue; }

    if (CRITIC_FILTER && data.criticName !== CRITIC_FILTER) continue;

    // Skip already-flagged or roundup files — they're already excluded from
    // scoring, so they're not active cross-attributions. (The historical
    // contamination evidence in wrongFullText is preserved for debugging but
    // doesn't need re-flagging.)
    if (data.isRoundupArticle || data.isCombinedReview) { skippedRoundup++; continue; }
    if (data.wrongShow || data.wrongProduction || data.duplicateOf) { skippedFlagged++; continue; }

    if (!fingerprints.has(dirId)) {
      // Filed-under directory has no entry in shows.json. We can still detect
      // the actual show but the "filed" baseline is meaningless. Skip for
      // signal cleanliness — the orphaned-dir audit handles these separately.
      skippedFiledNotInShows++;
      continue;
    }

    const content = extractContent(data);
    if (!content || content.length < 80) { skippedNoContent++; continue; }

    const result = scoreFileAgainstShows(content, dirId);
    if (!result) { skippedNoContent++; continue; }
    scanned++;

    const top = result.ranked[0];
    const second = result.ranked[1];
    if (!top || top.showId === dirId) continue; // best match is filed show → fine

    const margin = result.filedScore > 0
      ? top.score / result.filedScore
      : top.score / Math.max(0.01, second?.score || 0.01);
    const filedRatio = top.score > 0 ? result.filedScore / top.score : 0;

    if (top.score < MIN_SCORE) continue;
    if (margin < MIN_MARGIN) continue;

    // Same-base revival pairs: file says "the-play-2024", best match says
    // "the-play-2017". This is real cross-attribution but probably handled by
    // the URL-collision audit; flag only at lower confidence.
    const baseFiled = dirId.replace(/-\d{4}$/, '').replace(/-(?:off-)?(?:broadway|west-end|off-west-end)(?:-\d{4})?$/, '');
    const baseTop = top.showId.replace(/-\d{4}$/, '').replace(/-(?:off-)?(?:broadway|west-end|off-west-end)(?:-\d{4})?$/, '');
    const sameBase = baseFiled === baseTop;

    let confidence;
    if (sameBase) {
      confidence = 'low'; // revival URL collision — use existing audit
    } else if (margin >= 5 && filedRatio < MIN_FILED_RATIO && top.score >= MIN_SCORE * 1.5) {
      confidence = 'high';
    } else if (margin >= MIN_MARGIN && filedRatio < MIN_FILED_RATIO) {
      confidence = 'medium';
    } else {
      confidence = 'low';
    }

    flags.push({
      filedShowId: dirId,
      filedShowTitle: showById.get(dirId)?.title || null,
      file,
      filePath,
      criticName: data.criticName || null,
      outletId: data.outletId || null,
      url: data.url || null,
      detectedShowId: top.showId,
      detectedShowTitle: top.title,
      score: top.score,
      filedScore: result.filedScore,
      margin: Number(margin.toFixed(2)),
      filedRatio: Number(filedRatio.toFixed(3)),
      confidence,
      contentTokenCount: result.contentTokenCount,
      hasFullText: !!(data.fullText && data.fullText.length > 100),
      hasWrongFullText: !!(data.wrongFullText && data.wrongFullText.length > 100),
      wrongProduction: !!data.wrongProduction,
      ranked: result.ranked,
    });

    log(`  [${confidence}] ${dirId}/${file}`);
    log(`    detected: ${top.showId} (${top.score} vs filed ${result.filedScore}, margin ${margin.toFixed(1)}x)`);
  }
}

console.log('');
console.log(`Files in tree:           ${totalFiles}`);
console.log(`Scanned (had content):   ${scanned}`);
console.log(`Skipped — already flagged: ${skippedFlagged}`);
console.log(`Skipped — roundups:        ${skippedRoundup}`);
console.log(`Skipped — no content:      ${skippedNoContent}`);
console.log(`Skipped — filed dir not in shows.json: ${skippedFiledNotInShows}`);
console.log('');

const byConf = { high: 0, medium: 0, low: 0 };
for (const f of flags) byConf[f.confidence]++;
console.log(`Cross-attribution candidates: ${flags.length}`);
console.log(`  high:   ${byConf.high}`);
console.log(`  medium: ${byConf.medium}`);
console.log(`  low:    ${byConf.low}`);

// ---------------------------------------------------------------------------
// Group by critic
// ---------------------------------------------------------------------------

const byCritic = new Map();
for (const f of flags) {
  const key = f.criticName || '(unknown)';
  let group = byCritic.get(key);
  if (!group) {
    group = { criticName: key, total: 0, high: 0, medium: 0, low: 0, files: [] };
    byCritic.set(key, group);
  }
  group.total++;
  group[f.confidence]++;
  group.files.push(f);
}

const criticRanking = [...byCritic.values()]
  .sort((a, b) => (b.high - a.high) || (b.total - a.total))
  .map(g => ({
    criticName: g.criticName,
    total: g.total,
    high: g.high,
    medium: g.medium,
    low: g.low,
    files: g.files
      .sort((a, b) => (a.confidence === 'high' ? -1 : 0) - (b.confidence === 'high' ? -1 : 0)
        || b.score - a.score),
  }));

// ---------------------------------------------------------------------------
// Write report
// ---------------------------------------------------------------------------

fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
const report = {
  generatedAt: new Date().toISOString(),
  config: {
    reviewTextsDir: REVIEW_TEXTS_DIR,
    showsPath: SHOWS_PATH,
    minScore: MIN_SCORE,
    minMargin: MIN_MARGIN,
    minFiledRatio: MIN_FILED_RATIO,
    criticFilter: CRITIC_FILTER,
  },
  summary: {
    totalFiles,
    scanned,
    skipped: {
      alreadyFlagged: skippedFlagged,
      roundups: skippedRoundup,
      noContent: skippedNoContent,
      filedDirNotInShows: skippedFiledNotInShows,
    },
    candidates: flags.length,
    byConfidence: byConf,
    criticsAffected: criticRanking.length,
  },
  topCritics: criticRanking.slice(0, 50).map(c => ({
    criticName: c.criticName,
    total: c.total,
    high: c.high,
    medium: c.medium,
    low: c.low,
  })),
  byCritic: criticRanking,
};
fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
console.log(`\nReport written: ${REPORT_PATH}`);
console.log(`Critics affected: ${criticRanking.length}`);
console.log('Top 10 critics by high-confidence cross-attributions:');
for (const c of criticRanking.slice(0, 10)) {
  console.log(`  ${c.criticName.padEnd(30)} total=${String(c.total).padStart(3)} high=${String(c.high).padStart(3)} med=${String(c.medium).padStart(3)} low=${String(c.low).padStart(3)}`);
}

// ---------------------------------------------------------------------------
// Apply: high-confidence auto-flag
// ---------------------------------------------------------------------------

if (APPLY) {
  console.log('\n=== APPLYING HIGH-CONFIDENCE FLAGS ===');
  if (REVIEW_TEXTS_DIR !== path.join(os.homedir(), 'broadway-review-texts')) {
    console.log(`Note: writing to ${REVIEW_TEXTS_DIR} (not the private repo).`);
  } else {
    console.log(`Writing to private repo: ${REVIEW_TEXTS_DIR}`);
    console.log('Run git status / commit / push there afterwards.');
  }

  let flagged = 0;
  for (const f of flags) {
    if (f.confidence !== 'high') continue;
    try {
      const data = JSON.parse(fs.readFileSync(f.filePath, 'utf8'));
      if (data.wrongShow || data.wrongProduction || wrongShowCleared(data)) continue; // already flagged or manually cleared
      data.wrongShow = true;
      data.wrongShowReason = `Cross-attribution: content matches ${f.detectedShowId} (score ${f.score} vs filed ${f.filedScore}, margin ${f.margin}x)`;
      data.crossAttributionAudit = {
        detectedShowId: f.detectedShowId,
        score: f.score,
        filedScore: f.filedScore,
        margin: f.margin,
        topTokens: f.ranked[0]?.topTokens || [],
        flaggedAt: new Date().toISOString(),
      };
      const tmp = f.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
      fs.renameSync(tmp, f.filePath);
      flagged++;
      log(`  Flagged: ${f.filedShowId}/${f.file} → belongs to ${f.detectedShowId}`);
    } catch (e) {
      console.error(`  Error: ${f.filePath}: ${e.message}`);
    }
  }
  console.log(`Flagged ${flagged} high-confidence files as wrongShow.`);
} else {
  console.log('\nRun with --apply to flag high-confidence cross-attributions as wrongShow.');
}
