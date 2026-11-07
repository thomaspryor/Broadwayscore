#!/usr/bin/env node
/**
 * Build the stunt-casting study dataset behind /biz/stunt-casting (BRO-5848).
 *
 * 1. Picks every Broadway play and musical that opened since 2004-05
 *    (scripts/lib/stunt-casting.js selectStudyShows).
 * 2. Classifies each production's headliners (who led it, and whether they
 *    were a film/TV, music or other celebrity at opening) with Claude through
 *    the headless CLI. Answers are cached in
 *    public/data/research/stunt-casting-headliners.json keyed by an input
 *    hash, so a rerun only classifies new or changed shows. The cache is
 *    written after every batch.
 * 3. Joins weekly grosses (data/grosses-history.json) and the commercial
 *    designation (data/commercial.json), and writes
 *    public/data/research/stunt-casting.json.
 *
 * Usage:
 *   node scripts/build-stunt-casting-dataset.js             # classify missing, write dataset
 *   node scripts/build-stunt-casting-dataset.js --limit=20  # classify at most 20 shows
 *   node scripts/build-stunt-casting-dataset.js --no-classify  # rebuild from cache only
 *   node scripts/build-stunt-casting-dataset.js --check     # exit 1 if cache or dataset is stale
 *   node scripts/build-stunt-casting-dataset.js --adjudicate=objections.json
 *       # re-ask about disputed shows ({ showId: objection }), keeping the audit trail in the cache
 */
'use strict';
require('./lib/cli-help').exitOnHelp(module);

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runClaudeCli } = require('./lib/claude-cli');
const { DISPATCH_OPUS } = require('./lib/models');
const sc = require('./lib/stunt-casting');
const { castFileMismatchReason } = require('./lib/cast-tombstone');

const ROOT = path.join(__dirname, '..');
const SHOWS_JSON = path.join(ROOT, 'data/shows.json');
const GROSSES_JSON = path.join(ROOT, 'data/grosses-history.json');
const COMMERCIAL_JSON = path.join(ROOT, 'data/commercial.json');
const CAST_DIR = path.join(ROOT, 'data/cast');
const CACHE_PATH = path.join(ROOT, 'public/data/research/stunt-casting-headliners.json');
const OUT_PATH = path.join(ROOT, 'public/data/research/stunt-casting.json');

const BATCH_SIZE = 20;
const CONCURRENCY = 3;

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const opt = name => {
  const a = args.find(x => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : null;
};

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {
    if (fallback !== undefined) return fallback;
    throw e;
  }
}

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

/**
 * `objections` (adjudication only): { [showId]: text } from independent
 * auditors who disputed an earlier answer. The model sees the same rules plus
 * the objection and decides; it is not told to accept it.
 */
function buildPrompt(batch, objections = null) {
  const items = batch.map(s => ({
    id: s.id,
    title: s.title,
    opened: s.openingDate,
    type: s.type,
    revival: !!s.isRevival,
    venue: s.venue || '', // venue-write-guard-ok: prompt context only, never written to show data
    cast: sc.promptCast(s),
    ...(objections && objections[s.id] ? { objection: objections[s.id] } : {}),
  }));
  const adjudication = objections
    ? `\nEach production below also carries an "objection": independent auditors disputed an earlier answer for it. Weigh each objection strictly against the rules above, as of the opening date. Adopt it only where it is correct under those rules; reject it where the person was a working actor with minor or occasional screen credits, or where their screen fame came after this opening.\n`
    : '';
  return `You are a Broadway historian. Do not use any tools. Answer from your own knowledge only.

For each Broadway production below, identify its HEADLINERS: the 1 to 4 performers who led this specific production when it opened (billed above the title, or playing the leading roles). Pick names ONLY from the cast list given for that production, spelled exactly as given. The cast list is the opening-night company in alphabetical order, not billing order. If the show has no lead at all (a pure ensemble dance revue), return an empty headliners list.

For each headliner, classify their public fame AS OF THE OPENING DATE (not today):
- "screen": best known to the general public from film or television (movie stars, leads or well-known regulars of TV series, sitcom, SNL or late-night personalities). A theater actor with occasional TV guest spots is NOT screen.
- "music": best known as a pop, rock, R&B, hip-hop or country recording artist.
- "other": a celebrity from outside acting and music (athlete, reality TV, model, comedian known mainly for stand-up, talk-show host).
- "stage": famous mainly for theater work (e.g. Audra McDonald, Sutton Foster, Patti LuPone).
- "none": a working actor without broad public recognition at that time.
If someone was famous on screen first and later became a theater regular (e.g. Daniel Radcliffe, Hugh Jackman), use "screen".
Be conservative: when unsure whether a person had broad screen fame at that date, choose "stage" or "none".
${adjudication}
Reply with ONLY a JSON array, one object per production, in the same order:
[{"id": "...", "headliners": [{"name": "...", "fame": "screen|music|other|stage|none", "knownFor": "<6 words max, e.g. 'Succession (HBO)'>"}]}]

Productions:
${JSON.stringify(items, null, 1)}`;
}

function parseJsonArray(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('no JSON array in reply');
  return JSON.parse(text.slice(start, end + 1));
}

async function classifyBatch(batch, workDir, objections = null) {
  const r = await runClaudeCli({
    prompt: buildPrompt(batch, objections),
    cwd: workDir,
    model: DISPATCH_OPUS,
    timeoutMs: 10 * 60 * 1000,
  });
  if (!r.ok) throw new Error(`claude CLI ${r.stage}: ${r.errorDetail || ''}`.trim());
  const answers = parseJsonArray(r.resultText);
  const byId = new Map(answers.map(a => [a && a.id, a]));
  const out = {};
  const errors = [];
  for (const s of batch) {
    const v = sc.validateClassification(byId.get(s.id), s);
    if (v.ok) out[s.id] = v.value;
    else errors.push(`${s.id}: ${v.error}`);
  }
  return { out, errors, costUSD: r.costUSD || 0 };
}

async function classifyMissing(shows, cache, limit, objections = null) {
  const todo = objections
    ? shows.filter(s => objections[s.id])
    : shows.filter(s => !cache[s.id] || cache[s.id].hash !== sc.classificationInputHash(s));
  const queue = limit ? todo.slice(0, limit) : todo;
  console.log(`classify: ${todo.length} need classification, running ${queue.length}`);
  if (!queue.length) return { classified: 0, failed: 0 };

  // An empty scratch dir: the headless session must not see or touch the repo.
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stunt-casting-'));
  const batches = [];
  for (let i = 0; i < queue.length; i += BATCH_SIZE) batches.push(queue.slice(i, i + BATCH_SIZE));

  let classified = 0, failed = 0, cost = 0, next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const idx = next++;
      const batch = batches[idx];
      try {
        const { out, errors, costUSD } = await classifyBatch(batch, workDir, objections);
        const now = new Date().toISOString();
        for (const s of batch) {
          if (!out[s.id]) continue;
          cache[s.id] = {
            hash: sc.classificationInputHash(s), model: DISPATCH_OPUS, classifiedAt: now, ...out[s.id],
            // Keep the audit trail: what was disputed and what the answer was before.
            ...(objections ? { adjudicated: { objection: objections[s.id], previous: (cache[s.id] || {}).headliners || null } } : {}),
          };
          classified++;
        }
        failed += errors.length;
        cost += costUSD;
        for (const e of errors) console.warn(`  rejected ${e}`);
        writeJson(CACHE_PATH, sortKeys(cache)); // checkpoint every batch
        console.log(`  batch ${idx + 1}/${batches.length}: ${Object.keys(out).length}/${batch.length} ok (running cost ~$${cost.toFixed(2)})`);
      } catch (e) {
        failed += batch.length;
        console.warn(`  batch ${idx + 1}/${batches.length} failed: ${e.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  fs.rmSync(workDir, { recursive: true, force: true });
  return { classified, failed };
}

function sortKeys(o) {
  return Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]]));
}

function buildDataset(shows, cache, grossesWeeks, commercialShows) {
  const review = adjudicationSummary(shows, cache);
  const medians = sc.weeklyMedians(grossesWeeks);
  const rows = [];
  for (const s of shows) {
    const c = cache[s.id];
    if (!c || c.hash !== sc.classificationInputHash(s)) continue;
    const designation = (commercialShows[s.slug] || commercialShows[s.id] || {}).designation || null;
    rows.push({
      id: s.id,
      slug: s.slug,
      title: s.title,
      type: s.type,
      season: s.studySeason,
      openingDate: s.openingDate,
      isRevival: !!s.isRevival,
      headliners: c.headliners,
      screenStar: sc.hasScreenStar(c.headliners),
      celebrity: sc.hasCelebrity(c.headliners),
      grosses: sc.grossSummary(grossesWeeks, medians, [...new Set([s.id, s.slug].filter(Boolean))]),
      designation,
      outcome: sc.commercialOutcome(designation),
    });
  }
  return {
    generated: new Date().toISOString().slice(0, 10),
    method: {
      scope: `Broadway plays and musicals that opened from the ${sc.FIRST_SEASON} season on (seasons run July 1 to June 30). Opening casts only; replacement casting is not counted.`,
      classification: 'Claude (Opus) picked the 1 to 4 headliners of each production from its opening cast and classified their fame as of the opening date. "Film/TV star" is a broad bar: anyone best known to the public from screen work at the time, including regulars of a TV series, not only A-list movie stars. A production counts if any of its headliners qualifies. Every headliner is listed on the page for checking.',
      grossIndex: `Average weekly gross over a production's first ${sc.OPENING_WINDOW_WEEKS} reported weeks (when the opening cast is usually still in place; some stars leave sooner), divided by the median gross of all Broadway shows that same week (1.00 = a typical show that week). Ticket price and capacity use the same weeks.`,
      recoupment: 'Profitability Scorecard designations. Recouped = Miracle, Windfall, Easy Winner or Trickle. Not recouped = Flop, Fizzle or Did Not Recoup. TBD and tour-stop rows are left out of the recoupment rate, and nonprofit-theater productions are left out of the whole comparison. A show still running counts only once it has recouped or closed, so the rates lean toward finished runs and early hits.',
      ...(review.disputed
        ? { classifierReview: `Gemini and Codex audited the classifications. Opus re-examined the ${review.disputed} productions they disputed, under the same rules, and changed ${review.changed} of them.` }
        : {}),
    },
    counts: { productions: rows.length, studyShows: shows.length },
    eras: sc.byEra(rows),
    seasons: sc.bySeason(rows),
    commercial: sc.commercialComparison(rows),
    // This file is served publicly from a public repo. Per-show commercial
    // designations are held data (feature-flags.ts PROD_HELD_FEATURES), so
    // rows carry only what the page lists; the aggregates above are the
    // only commercial output.
    rows: rows.map(({ grosses, designation, outcome, ...pub }) => pub),
  };
}

/** Disputed and changed counts, read from the adjudication trail in the cache. */
function adjudicationSummary(shows, cache) {
  let disputed = 0, changed = 0;
  for (const s of shows) {
    const c = cache[s.id];
    if (!c || !c.adjudicated || c.hash !== sc.classificationInputHash(s)) continue;
    disputed++;
    const before = JSON.stringify((c.adjudicated.previous || []).map(h => [h.name, h.fame]));
    const after = JSON.stringify(c.headliners.map(h => [h.name, h.fame]));
    if (before !== after) changed++;
  }
  return { disputed, changed };
}

function stripVolatile(d) {
  return JSON.stringify({ ...d, generated: null });
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const { shows: allShows } = readJson(SHOWS_JSON);
  for (const s of allShows) {
    const f = path.join(CAST_DIR, `${s.id}.json`);
    if (s.category !== 'broadway' || !fs.existsSync(f)) continue;
    const castData = readJson(f, {});
    // Same guard as enrich-cast-from-files.js: a cast file scraped from
    // another production of the title must not supply this one's headliners.
    const mismatch = castFileMismatchReason(castData, s);
    if (mismatch) { console.warn(`  skip cast file ${s.id}: ${mismatch}`); continue; }
    s.openingCast = castData.openingNightCast || [];
  }
  const shows = sc.selectStudyShows(allShows, { today });
  const cache = readJson(CACHE_PATH, {});
  const grossesWeeks = readJson(GROSSES_JSON).weeks;
  const commercialShows = readJson(COMMERCIAL_JSON).shows;

  if (flag('check')) {
    const missing = shows.filter(s => !cache[s.id] || cache[s.id].hash !== sc.classificationInputHash(s));
    const fresh = buildDataset(shows, cache, grossesWeeks, commercialShows);
    const current = readJson(OUT_PATH, null);
    const stale = !current || stripVolatile(current) !== stripVolatile(fresh);
    console.log(`check: ${shows.length} study shows, ${missing.length} unclassified, dataset ${stale ? 'STALE' : 'current'}`);
    if (missing.length) console.log(`  unclassified: ${missing.slice(0, 10).map(s => s.id).join(', ')}${missing.length > 10 ? ' ...' : ''}`);
    const leaked = current && (current.rows || []).some(r => 'designation' in r || 'outcome' in r);
    if (leaked) console.log('  public rows carry per-show commercial designations (held data)');
    // A handful of unclassifiable shows is tolerated; a stale or leaking dataset is not.
    process.exit(stale || leaked || missing.length > shows.length * 0.02 ? 1 : 0);
  }

  let failed = 0;
  if (!flag('no-classify')) {
    const limit = opt('limit') ? Number(opt('limit')) : null;
    // --adjudicate=<file.json>: { showId: objection } from an outside audit.
    const objections = opt('adjudicate') ? readJson(path.resolve(opt('adjudicate'))) : null;
    if (objections) {
      // A real run would otherwise re-ask about shows that are not in the study.
      const unknown = Object.keys(objections).filter(id => !shows.some(s => s.id === id));
      if (unknown.length) { console.error(`adjudicate: not study shows: ${unknown.join(', ')}`); process.exit(1); }
    }
    const r = await classifyMissing(shows, cache, limit, objections);
    failed = r.failed;
    console.log(`classify: ${r.classified} classified, ${r.failed} failed`);
    // A failed adjudication batch leaves the old answers in place with valid
    // hashes, so the coverage check below cannot see it. Re-run instead.
    if (objections && failed) {
      console.error(`refusing to write ${path.relative(ROOT, OUT_PATH)}: ${failed} disputed shows not re-examined (re-run --adjudicate)`);
      process.exit(1);
    }
  }

  const data = buildDataset(shows, cache, grossesWeeks, commercialShows);
  // Unclassified shows drop out of every denominator, so a partial run must
  // not replace the published dataset. The cache keeps what did succeed.
  const unclassified = data.counts.studyShows - data.counts.productions;
  if (unclassified > data.counts.studyShows * 0.02) {
    console.error(`refusing to write ${path.relative(ROOT, OUT_PATH)}: ${unclassified} of ${data.counts.studyShows} study shows unclassified (re-run to finish)`);
    process.exit(1);
  }
  writeJson(OUT_PATH, data);
  console.log(`wrote ${path.relative(ROOT, OUT_PATH)}: ${data.counts.productions}/${data.counts.studyShows} productions classified`);
  for (const e of data.eras) {
    console.log(`  ${e.label}: plays ${e.screen.plays.pct}% (n=${e.screen.plays.n}), musicals ${e.screen.musicals.pct}% (n=${e.screen.musicals.n})`);
  }
  if (failed) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exit(1); });
