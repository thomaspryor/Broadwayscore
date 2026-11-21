'use strict';

// One archived review through the real fetch/scoring ports, with all writes and publishing in a sandbox.
// Replay time is the show's opening night; the fetched article's byline/date still come only from its HTML.
const fs = require('fs');
const path = require('path');
const { createInlineScoring, ensembleScoreText, realFetchPorts } = require('./inline-score');
const { runLaneNight } = require('./lane-runner');
const publish = require('./publish');
const { nonReviewReason, canonicalUrl } = require('./discovery');
const { resolveOutletFromUrl } = require('../review-normalization');

async function runLiveSmoke({ show, review, workDir, fetchPorts, scorer } = {}) {
  if (!show?.id || !show.openingDate || review?.showId !== show.id || !review.url || !review.outletId || !workDir) {
    throw new Error('live smoke: show, archived review and sandbox workDir are required');
  }
  // Discovery silently drops URLs it does not take for a review (e.g. a /news/ path), which shows up only as admitted:0.
  // Say why up front instead, before any paid call.
  if (!canonicalUrl(review.url)) throw new Error(`live smoke: discovery would reject ${review.url} (wrapped-url)`);
  const notReview = nonReviewReason(review.url);
  if (notReview) throw new Error(`live smoke: discovery would reject ${review.url} (${notReview}); pick a review article URL`);
  if (!resolveOutletFromUrl(review.url)) throw new Error(`live smoke: discovery would reject ${review.url} (unknown-outlet-host)`);
  // Preflight before a fetch or write. Both scraper providers must be available to exercise their fallback chain.
  const required = [
    ...(!fetchPorts ? ['BRIGHTDATA_TOKEN', 'SCRAPINGBEE_API_KEY'] : []),
    ...(!scorer ? ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] : []),
  ];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) throw new Error(`live smoke: missing credentials: ${missing.join(', ')}`);
  if (!scorer) {
    require('ts-node').register({ project: path.resolve(__dirname, '../../tsconfig.json'), transpileOnly: true });
    const { EnsembleReviewScorer } = require('../../llm-scoring/ensemble-scorer');
    // Two models suffice for the smoke. Optional vendors are deliberately not enabled, bounding paid work.
    scorer = new EnsembleReviewScorer(process.env.ANTHROPIC_API_KEY, process.env.OPENAI_API_KEY);
  }
  const ports = fetchPorts || realFetchPorts();
  const night = show.openingDate;
  let t = Date.parse(`${night}T12:00:00Z`);
  const now = () => t;
  const wait = async ms => { t += ms; };
  const ledgerDir = path.join(workDir, 'ledger');
  const reviewTextsDir = path.join(workDir, 'data', 'review-texts');
  const reviewsFile = path.join(workDir, 'data', 'reviews.json');
  // A smoke must use a fresh sandbox so a previous ledger cannot skip the paid paths and claim a new pass.
  if (fs.existsSync(workDir) && fs.readdirSync(workDir).length) throw new Error('live smoke: sandbox must be empty');
  fs.mkdirSync(path.dirname(reviewsFile), { recursive: true });
  fs.writeFileSync(reviewsFile, JSON.stringify({ reviews: [] }));
  const liveDir = path.join(workDir, 'live');
  fs.mkdirSync(liveDir);
  const server = await publish.startStaticServer(liveDir);
  try {
    const scoring = createInlineScoring({ show, night, ledgerDir, now, ...ports, scoreText: ensembleScoreText(scorer), retryMs: [] });
    const run = await runLaneNight({
      show, night, openingDate: night, ledgerDir, reviewTextsDir, now, wait, ...scoring,
      // reviews.json supplies an archived review candidate. No discovery fetch or URL metadata inference.
      adapters: [{ name: 'archived-review', discover: async () => [{ url: review.url, outletId: review.outletId, source: 'aggregator', aggregatorCited: true }] }],
      fetchText: async () => { throw new Error('live smoke: unexpected discovery fetch'); },
      publishPorts: {
        ...publish.createReviewsFilePort(reviewsFile),
        regenShow: async () => {
          const doc = JSON.parse(fs.readFileSync(reviewsFile, 'utf8'));
          const dir = path.join(liveDir, 'data', 'shows');
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, `${show.id}.json`), JSON.stringify({ rv: doc.reviews.map(r => ({ u: r.url })) }));
        },
        deploy: async () => {},
        fetchLiveShow: publish.fetchLiveShowFrom(server.baseUrl),
      },
      dryRun: true, maxPasses: 1,
    });
    const files = fs.existsSync(path.join(reviewTextsDir, show.id)) ? fs.readdirSync(path.join(reviewTextsDir, show.id)) : [];
    const verified = run.published.reduce((n, p) => n + p.verified.length, 0);
    const pass = run.admitted.length === 1 && run.errors.length === 0 && files.length === 1 && verified === 1;
    return { pass, admitted: run.admitted.length, persisted: files.length, verified, errors: run.errors, workDir };
  } finally { await server.close(); }
}

/** CLI entry for the existing poller; this flag never starts a normal discovery cycle. */
async function liveSmokeFromArgs(args = process.argv.slice(2)) {
  const arg = name => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const showId = arg('show');
  const url = arg('url');
  if (!showId || !url) throw new Error('live smoke requires --show=ID and --url=URL of an archived review in reviews.json');
  const dataDir = path.resolve(__dirname, '../../../data');
  const showsDoc = JSON.parse(fs.readFileSync(path.join(dataDir, 'shows.json'), 'utf8'));
  const show = (Array.isArray(showsDoc) ? showsDoc : showsDoc.shows).find(s => s.id === showId);
  const review = JSON.parse(fs.readFileSync(path.join(dataDir, 'reviews.json'), 'utf8')).reviews.find(r => r.showId === showId && r.url === url);
  const workDir = arg('out') || fs.mkdtempSync(path.join(require('os').tmpdir(), 'lane-live-smoke-'));
  return runLiveSmoke({ show, review, workDir });
}

module.exports = { runLiveSmoke, liveSmokeFromArgs };
