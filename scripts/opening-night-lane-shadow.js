#!/usr/bin/env node
'use strict';
/**
 * Opening-night lane in SHADOW mode (BRO-5201). Runs the lane's real discovery -> fetch -> ensemble score for one show's
 * night beside the regular pipeline. It takes no night lease and publishes nothing, so the poller, gather and rebuild
 * keep the show. Every scored review, and the first time each review appears on the live site, goes into a report:
 * scripts/lib/opening-night-lane-shadow.js.
 *
 *   npx tsx scripts/opening-night-lane-shadow.js --show=ID --night=YYYY-MM-DD --out=DIR
 *       [--window-min=300] [--live-base=https://broadwayscorecard.com] [--adapters=config.json] [--replay]
 *
 * REPLAY (BRO-6872): a night more than SEEN_AFTER_DAYS old (or any night with --replay) runs on a clock that starts at
 * the night's embargo, so the lane's trust window judges rows as on the night. Its batches then go through the real
 * publish merge (mergeShowRows) into a modelled site (lib/lane-replay-grade.js createReplaySitePorts) instead of
 * being dropped, and the report is graded (lib/lane-shadow-grade.js: recall, false positives, duplicates, score gaps,
 * time to score) into shadow-grade.{json,md}. Nothing outside --out is written either way.
 *
 * tsx is needed because the ensemble scorer is TypeScript. Writes only under --out: ledger/, live-first-seen.jsonl and
 * lane-scores.jsonl as they happen, shadow-report.{json,md} every 2 minutes and at the end (also on SIGTERM). Spends scraper
 * credits (aggregator pages every 2 minutes, each review page once) and one ensemble scoring call per review.
 *
 * The adapter list comes from lib/opening-night-lane/adapters.js laneAdapters, the same factory the production driver
 * uses, so the shadow cannot test a different lane (BRO-5201: its old hand-copied list had lost the Google News decoder).
 */
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help');
const shadow = require('./lib/opening-night-lane-shadow');

const argv = process.argv.slice(2);
const arg = (n) => (argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3) || null;


async function main() {
  if (hasHelpFlag(argv)) { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); return 0; }
  const repoDir = path.resolve(__dirname, '..');
  const showId = arg('show'); const night = arg('night'); const outDir = arg('out');
  if (!showId || !/^\d{4}-\d{2}-\d{2}$/.test(night || '') || !outDir) { console.error('usage: --show=ID --night=YYYY-MM-DD --out=DIR (see --help)'); return 2; }
  const env = process.env;
  const missing = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'].filter((k) => !env[k]);
  if (missing.length) { console.error(`shadow: missing scorer keys ${missing.join(', ')}`); return 2; }
  const shows = JSON.parse(fs.readFileSync(path.join(repoDir, 'data', 'shows.json'), 'utf8'));
  const show = (Array.isArray(shows) ? shows : shows.shows || []).find((s) => s.id === showId);
  if (!show) { console.error(`unknown show ${showId}`); return 2; }
  // trust-model.isLaneReview rejects every row whose night is not the show's opening date, so another night would
  // run all evening and score nothing.
  if (String(show.openingDate || '').slice(0, 10) !== night) { console.error(`shadow: --night ${night} is not ${showId}'s opening date (${show.openingDate})`); return 2; }
  const windowMin = Number(arg('window-min')) > 0 ? Number(arg('window-min')) : 300;
  const liveBase = arg('live-base') || 'https://broadwayscorecard.com';
  const adaptersConfig = arg('adapters') ? JSON.parse(fs.readFileSync(arg('adapters'), 'utf8')) : {};
  const replay = shadow.replayClock({ show, night, force: argv.includes('--replay') });
  const now = replay ? replay.now : Date.now;
  const ledgerDir = path.resolve(outDir, 'ledger');
  fs.mkdirSync(ledgerDir, { recursive: true });

  const discovery = require('./lib/opening-night-lane/discovery');
  const inline = require('./lib/opening-night-lane/inline-score');
  const publish = require('./lib/opening-night-lane/publish');
  // Talkin' Broadway through one Browserbase session, shared by discovery and review fetch, as in the driver (BRO-6073).
  // Tagged as the shadow caller: no allowance, so a shadow run or replay never spends the live night's (BRO-6872).
  const bbFetch = require('./lib/opening-night-lane/browserbase-fetch');
  const laneFetch = bbFetch.createLaneFetch({ env, caller: bbFetch.SHADOW_CALLER });
  const { EnsembleReviewScorer } = require('./llm-scoring/ensemble-scorer.ts');
  // Three models, like production (llm-ensemble-score.yml leaves OPENROUTER_API_KEY out: "Kimi disabled"). With the key
  // the scorer adds Kimi, whose 300 s OpenRouter timeouts and retries cost ~15 minutes per review in the first CI run.
  const scorer = new EnsembleReviewScorer(env.ANTHROPIC_API_KEY, env.OPENAI_API_KEY, env.GEMINI_API_KEY);
  const scoring = inline.createInlineScoring({ show, night, ledgerDir, now, ...inline.realFetchPorts({ fetchPage: laneFetch.fetchPage }), scoreText: inline.ensembleScoreText(scorer), allShows: Array.isArray(shows) ? shows : shows.shows || [] });
  // BRO-6651: record the aggregator/index pages each pass reads, encrypted (the repo is public) beside the report artifact.
  const recorder = require('./lib/opening-night-lane/driver').recorderFromEnv({ ...env, LANE_RECORD_DIR: env.LANE_RECORD_DIR || path.resolve(outDir, 'recording') });
  const fetchText = recorder.wrapFetchText(discovery.fetchTextFrom(laneFetch.fetchPage));
  const ss = require('./lib/show-score-discover');
  const showScoreGuards = { urlMap: ss.loadShowScoreUrlMap(repoDir), allShows: Array.isArray(shows) ? shows : shows.shows || [] };
  const serpSearch = async (query) => {
    if (!env.BRIGHTDATA_TOKEN && !env.SCRAPINGBEE_API_KEY) throw new Error('SERP: no BRIGHTDATA_TOKEN or SCRAPINGBEE_API_KEY');
    const { serpQuery } = require('./lib/url-discovery');
    return (await serpQuery(query, { nbResults: 10, emptyAuthoritative: false, brightDataKey: env.BRIGHTDATA_TOKEN, scrapingBeeKey: env.SCRAPINGBEE_API_KEY, log: () => {} })) || [];
  };

  const out = path.resolve(outDir);
  const grader = require('./lib/lane-shadow-grade');
  // Replay: the real merge into a modelled site; the live shadow keeps its apply-nothing ports.
  const site = require('./lib/lane-replay-grade').createReplaySitePorts({ now });
  const rows = [];
  const scores = shadow.createScoreRecorder({ logFile: path.join(out, 'lane-scores.jsonl'), now });
  // A live fetch with no timeout could hang the recorder past the window; 20 s is a missed poll, not a stall.
  const fetchImpl = (url, opts = {}) => globalThis.fetch(url, { ...opts, signal: AbortSignal.timeout(20000) });
  const live = shadow.createLiveRecorder({ fetchLiveShow: publish.fetchLiveShowFrom(liveBase, { fetchImpl }), showId, now, logFile: path.join(out, 'live-first-seen.jsonl') });
  // The regular pipeline's first sighting of each site review (firstSeenAt, sources), read from the private review
  // files (metadata only, the text is dropped), settles undated pages and reader submissions in the grade. A failed
  // read grades by publish dates alone and says so.
  // The answer key's own ensemble spread per review: a lane/site gap smaller than it is model variance on the same
  // text, not a lane defect (BRO-6872). Absent reviews.json, every gap falls back to the flat GAP_PTS rule.
  const siteScoreSpread = replay ? grader.loadSiteScoreSpread(path.join(repoDir, 'data', 'reviews.json'), showId) : null;
  const siteMeta = replay ? await shadow.loadSiteMeta({ repoDir, showId, token: env.REVIEW_TEXTS_TOKEN }).catch((e) => { console.error(`shadow: site review metadata unavailable (${e.message}); grading by publish dates only`); return null; }) : null;
  const startedAt = now();
  let result = null; let endedAt = null;
  // BRO-6872: CI passes froze the event loop for 2-7 s (never locally), which cut off connections mid-handshake. Log every
  // freeze over 500 ms with its wall time so it can be lined up against recording/fetches.jsonl and the ledger.
  const loopDelay = require('perf_hooks').monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  const stalls = []; let lastTick = Date.now();
  setInterval(() => {
    const t = Date.now(); const ms = t - lastTick - 50; lastTick = t;
    if (ms > 500 && stalls.length < 1000) stalls.push({ at: new Date(t - ms).toISOString(), ms });
  }, 50).unref();
  const writeEventLoop = () => fs.writeFileSync(path.join(out, 'event-loop.json'), JSON.stringify({
    maxMs: Math.round(loopDelay.max / 1e6), p99Ms: Math.round(loopDelay.percentile(99) / 1e6), meanMs: Math.round(loopDelay.mean / 1e6),
    stallsOver500ms: stalls.length, stalls,
    // BRO-6988: wall clock and monotonic clock read together, so a stall's wall time converts to a --cpu-prof sample
    // offset (V8 profile timestamps are CLOCK_MONOTONIC microseconds, the same clock as process.hrtime).
    clockAnchor: { wallMs: Date.now(), monoUs: Number(process.hrtime.bigint() / 1000n) },
  }, null, 1));
  const writeReport = () => {
    try { writeEventLoop(); } catch (e) { console.error(`shadow: event-loop log failed: ${e.message}`); }
    const rep = shadow.buildShadowReport({ show, night, ledgerDir, scores: scores.snapshot(), rows, live: live.snapshot(), startedAt, endedAt, result });
    const md = shadow.writeShadowReport(out, rep);
    if (!replay) return md;
    return md + grader.writeGrade(out, grader.gradeShadowReport(rep, { replayAnchorAt: replay.anchorAt, sandbox: site.live(), siteMeta, siteScoreSpread }));
  };
  await live.poll();
  const timer = setInterval(() => {
    live.poll().catch(() => {}).finally(() => { try { writeReport(); } catch (e) { console.error(`shadow: report write failed: ${e.message}`); } });
  }, 2 * 60 * 1000);
  // A cancelled or timed-out step gets SIGTERM before the kill: leave the report as it stands.
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, () => {
      try { endedAt = now(); writeReport(); console.error(`shadow: ${sig}, report written`); } finally {
        // Release the Browserbase session rather than leave it billing to its timeout; never wait more than 3 s on it.
        require('./lib/with-timeout').withTimeout(laneFetch.close(), 3000, { resolveWith: null }).catch(() => {}).finally(() => process.exit(143));
      }
    });
  }
  console.log(`shadow: ${showId} ${night}, window ${windowMin} min, live site ${liveBase}; no lease, no publish${replay ? `; REPLAY clock from ${replay.anchorAt}, sandbox merge` : ''}`);
  const onRows = (applied, at) => {
    for (const row of applied) { rows.push({ row, at }); scores.onRow(row); console.log(`shadow: scored ${row.outlet || row.outletId} ${row.assignedScore} ${row.url}`); }
  };
  const publishPorts = replay
    ? { ...site, async updateReviews(fn) { const r = await site.updateReviews(fn); onRows(r.applied || [], now()); return r; } }
    : shadow.createShadowPublishPorts({ onRows, now });
  try {
    result = await shadow.runShadowNight({
      show, night, openingDate: show.openingDate, timeZone: show.market === 'west-end' ? 'Europe/London' : 'America/New_York',
      ledgerDir, fetchText, windowMs: windowMin * 60 * 1000, dryRun: true, spendNow: Date.now,
      adapters: require('./lib/opening-night-lane/adapters').laneAdapters({
        showScoreGuards, adaptersConfig, search: serpSearch, decodeImpl: require('./lib/google-news-decode').decodeGoogleNewsLink, now, ledgerDir,
      }),
      missingOutlets: ({ seen }) => discovery.laneMissingOutlets({ show, seen, adaptersConfig }),
      fetchReview: scoring.fetchReview, scoreReview: scores.wrapScore(scoring.scoreReview),
      // No reviewTextsDir and no onDiskUrls: the shadow must find every review itself, including ones the regular
      // pipeline already published, and must not write review files the regular pipeline also writes. onDiskRows
      // only feeds the syndication check, as in the real lane: a primary already on the site drops its copy.
      onDiskRows: require('./lib/opening-night-lane/driver').onDiskRowsFor(path.join(repoDir, 'data', 'reviews.json'), showId),
      publishPorts,
      now, wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
  } finally {
    clearInterval(timer);
    await laneFetch.close();
    await live.poll();
    endedAt = now();
    const md = writeReport();
    console.log(md);
    if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, md);
  }
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((e) => { console.error(`opening-night-lane-shadow: ${e.message}`); process.exitCode = 1; });
