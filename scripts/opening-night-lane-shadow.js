#!/usr/bin/env node
'use strict';
/**
 * Opening-night lane in SHADOW mode (BRO-5201). Runs the lane's real discovery -> fetch -> ensemble score for one show's
 * night beside the regular pipeline. It takes no night lease and publishes nothing, so the poller, gather and rebuild
 * keep the show. Every scored review, and the first time each review appears on the live site, goes into a report:
 * scripts/lib/opening-night-lane-shadow.js.
 *
 *   npx tsx scripts/opening-night-lane-shadow.js --show=ID --night=YYYY-MM-DD --out=DIR
 *       [--window-min=300] [--live-base=https://broadwayscorecard.com] [--adapters=config.json]
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
  const ledgerDir = path.resolve(outDir, 'ledger');
  fs.mkdirSync(ledgerDir, { recursive: true });

  const discovery = require('./lib/opening-night-lane/discovery');
  const inline = require('./lib/opening-night-lane/inline-score');
  const publish = require('./lib/opening-night-lane/publish');
  // Talkin' Broadway through one Browserbase session, shared by discovery and review fetch, as in the driver (BRO-6073).
  const laneFetch = require('./lib/opening-night-lane/browserbase-fetch').createLaneFetch({ env });
  const { EnsembleReviewScorer } = require('./llm-scoring/ensemble-scorer.ts');
  // Three models, like production (llm-ensemble-score.yml leaves OPENROUTER_API_KEY out: "Kimi disabled"). With the key
  // the scorer adds Kimi, whose 300 s OpenRouter timeouts and retries cost ~15 minutes per review in the first CI run.
  const scorer = new EnsembleReviewScorer(env.ANTHROPIC_API_KEY, env.OPENAI_API_KEY, env.GEMINI_API_KEY);
  const scoring = inline.createInlineScoring({ show, night, ledgerDir, now: Date.now, ...inline.realFetchPorts({ fetchPage: laneFetch.fetchPage }), scoreText: inline.ensembleScoreText(scorer) });
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
  const rows = [];
  const scores = shadow.createScoreRecorder({ logFile: path.join(out, 'lane-scores.jsonl') });
  // A live fetch with no timeout could hang the recorder past the window; 20 s is a missed poll, not a stall.
  const fetchImpl = (url, opts = {}) => globalThis.fetch(url, { ...opts, signal: AbortSignal.timeout(20000) });
  const live = shadow.createLiveRecorder({ fetchLiveShow: publish.fetchLiveShowFrom(liveBase, { fetchImpl }), showId, logFile: path.join(out, 'live-first-seen.jsonl') });
  const startedAt = Date.now();
  let result = null; let endedAt = null;
  const writeReport = () => shadow.writeShadowReport(out, shadow.buildShadowReport({
    show, night, ledgerDir, scores: scores.snapshot(), rows, live: live.snapshot(), startedAt, endedAt, result,
  }));
  await live.poll();
  const timer = setInterval(() => {
    live.poll().catch(() => {}).finally(() => { try { writeReport(); } catch (e) { console.error(`shadow: report write failed: ${e.message}`); } });
  }, 2 * 60 * 1000);
  // A cancelled or timed-out step gets SIGTERM before the kill: leave the report as it stands.
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, () => {
      try { endedAt = Date.now(); writeReport(); console.error(`shadow: ${sig}, report written`); } finally {
        // Release the Browserbase session rather than leave it billing to its timeout; never wait more than 3 s on it.
        require('./lib/with-timeout').withTimeout(laneFetch.close(), 3000, { resolveWith: null }).catch(() => {}).finally(() => process.exit(143));
      }
    });
  }
  console.log(`shadow: ${showId} ${night}, window ${windowMin} min, live site ${liveBase}; no lease, no publish`);
  try {
    result = await shadow.runShadowNight({
      show, night, openingDate: show.openingDate, timeZone: show.market === 'west-end' ? 'Europe/London' : 'America/New_York',
      ledgerDir, fetchText, windowMs: windowMin * 60 * 1000, dryRun: true,
      adapters: require('./lib/opening-night-lane/adapters').laneAdapters({
        showScoreGuards, adaptersConfig, search: serpSearch, decodeImpl: require('./lib/google-news-decode').decodeGoogleNewsLink, now: Date.now, ledgerDir,
      }),
      missingOutlets: ({ seen }) => discovery.laneMissingOutlets({ show, seen, adaptersConfig }),
      fetchReview: scoring.fetchReview, scoreReview: scores.wrapScore(scoring.scoreReview),
      // No reviewTextsDir and no onDiskUrls: the shadow must find every review itself, including ones the regular
      // pipeline already published, and must not write review files the regular pipeline also writes. onDiskRows
      // only feeds the syndication check, as in the real lane: a primary already on the site drops its copy.
      onDiskRows: require('./lib/opening-night-lane/driver').onDiskRowsFor(path.join(repoDir, 'data', 'reviews.json'), showId),
      publishPorts: shadow.createShadowPublishPorts({ onRows: (applied, at) => {
        for (const row of applied) { rows.push({ row, at }); scores.onRow(row); console.log(`shadow: scored ${row.outlet || row.outletId} ${row.assignedScore} ${row.url}`); }
      } }),
      now: Date.now, wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
  } finally {
    clearInterval(timer);
    await laneFetch.close();
    await live.poll();
    endedAt = Date.now();
    const md = writeReport();
    console.log(md);
    if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, md);
  }
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((e) => { console.error(`opening-night-lane-shadow: ${e.message}`); process.exitCode = 1; });
