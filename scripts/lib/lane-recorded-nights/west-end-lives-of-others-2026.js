'use strict';
/**
 * BRO-5956: the West End opening-night fixture for The Lives of Others (Adelphi Theatre, opened 2026-10-29), replayed
 * through the lane's West End adapters (opening-night-lane/west-end-adapters.js: WET, theatre.reviews, Stagedoor,
 * The Stage, London Box Office).
 *
 * Two fixtures, one replay:
 *   - SYNTHETIC (committed, public): every page below is invented. Only the page STRUCTURE follows the real sites'
 *     markup (WET's WP-API post list and .reviewnew* blocks, theatre.reviews' star-tier paragraphs, The Stage's
 *     "Outlet, ★★★" links, LBO's h4-per-outlet blocks, Stagedoor's 2026 redirect to a ticketing site). Every review URL
 *     is on a real outlet's host so outlet resolution runs for real, but the paths say "synthetic-fixture" and no such
 *     article exists. No sentence of any review or page is copied. The timestamps are invented too.
 *   - REAL (private, optional): the pages the adapters really fetched, in the lane-recordings archive layout
 *     (<root>/<show>/<night>/recording/{fetches.jsonl, pages/<sha>.html.gz, meta.json}; recording-night.js loads it,
 *     scripts/capture-lane-night.js writes it). It lives only in the private review-texts repo or a git-ignored local
 *     dir, because the pages are copyrighted. When it is absent the real replay is skipped, never faked.
 *
 * Replays serve each URL the body current at the virtual time (recording-night.replayFetchFrom), so a page recorded
 * later in the night is a 404 before then, as it was live. Every URL the adapters ask for that the fixture never
 * recorded is listed in `unrecorded`, so a strict test can pin the fixture to what the adapters read.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { replayFetchFrom, loadRecording } = require('./recording-night');

const SHOW = {
  id: 'the-lives-of-others-west-end-2026', title: 'The Lives of Others', venue: 'Adelphi Theatre',
  openingDate: '2026-10-29', category: 'west-end', market: 'west-end',
};
const NIGHT = '2026-10-29';
const KIND = 'recording';
const T0 = Date.parse('2026-10-29T18:00:00Z'); // synthetic fixture start: press night, before curtain
const HOUR = 3600e3;
const DAY = 24 * HOUR;

// ---- synthetic pages ---------------------------------------------------------------------------------------------
const WET_SEARCH = `https://www.westendtheatre.com/wp-json/wp/v2/posts?categories=10&per_page=20&search=${encodeURIComponent('The Lives of Others')}`;
const WET_POST = 'https://www.westendtheatre.com/900001/news/the-lives-of-others-reviews/';
const TR_ROUNDUP = 'https://theatre.reviews/reviews-roundup/the-lives-of-others-adelphi-reviews/';
const TR_PLAIN = 'https://theatre.reviews/reviews-roundup/the-lives-of-others-reviews/';
const TR_SEARCH = `https://theatre.reviews/wp-json/wp/v2/posts?per_page=5&search=${encodeURIComponent('The Lives of Others')}`;
const TS_LISTING = 'https://www.thestage.co.uk/review-round-ups';
const TS_INDEX = 'https://www.thestage.co.uk/SiteMap_TheStage_index.xml';
const TS_ARTICLES = 'https://www.thestage.co.uk/SiteMap_TheStage_Articles1_v2.xml';
const TS_ROUNDUP = 'https://www.thestage.co.uk/review-round-ups/the-lives-of-others-at-the-adelphi-review-round-up';
const LBO_SITEMAP = 'https://www.londonboxoffice.co.uk/news-sitemap.xml';
const LBO_ROUNDUP = 'https://www.londonboxoffice.co.uk/news/post/review-roundup-the-lives-of-others-adelphi-theatre';
const STAGEDOOR = 'https://stagedoor.com/';

/** Invented review URLs on real outlet hosts. No such articles exist. */
const R = {
  guardian: 'https://www.theguardian.com/stage/2026/oct/30/the-lives-of-others-review-synthetic-fixture',
  times: 'https://www.thetimes.com/culture/theatre-dance/article/the-lives-of-others-review-synthetic-fixture-zz9000001',
  telegraph: 'https://www.telegraph.co.uk/theatre/what-to-see/the-lives-of-others-review-synthetic-fixture/',
  standard: 'https://www.standard.co.uk/culture/theatre/the-lives-of-others-review-synthetic-fixture-b9000001.html',
  whatsonstage: 'https://www.whatsonstage.com/news/the-lives-of-others-review-synthetic-fixture_9000001/',
  independent: 'https://www.independent.co.uk/arts-entertainment/theatre-dance/reviews/the-lives-of-others-review-synthetic-fixture-b9000002.html',
  ft: 'https://www.ft.com/content/00000000-0000-4000-8000-000000005956',
  thestage: 'https://www.thestage.co.uk/reviews/the-lives-of-others-review-synthetic-fixture',
  // A round-up row that is not a review: an interview path. Cited by WET; the lane must refuse it.
  interview: 'https://www.whatsonstage.com/news/the-lives-of-others-cast-interview-synthetic-fixture_9000002/',
};
const quote = (n) => `Synthetic fixture quote ${n}: invented placeholder words standing in for a critic's line, long enough to count as an excerpt.`;

const wetSearch = (withPost) => JSON.stringify(withPost ? [{
  id: 900001, date: '2026-10-30T12:00:00', link: WET_POST,
  title: { rendered: 'The Lives of Others Reviews: synthetic fixture headline' },
  content: { rendered: '<p>Synthetic fixture intro paragraph with no ratings in it.</p>' },
}] : []);
const wetBlock = (outlet, stars, critic, url) => `<p class="reviewnewpubhead">${outlet}</p>
<p class="reviewnewstars">${'★'.repeat(stars)}</p>
<p class="reviewnewauthor">${url ? `<a href="${url}">${critic}</a>` : critic}</p>
<p>${quote(outlet)}</p>`;
const wetPage = `<!doctype html><html><head><title>The Lives of Others Reviews - West End Theatre</title>
<link rel="canonical" href="${WET_POST}"><meta property="article:published_time" content="2026-10-30T12:00:00+00:00"></head>
<body><article><div class="entry-content">
${wetBlock('The Guardian', 4, 'Synthetic Critic Alpha', R.guardian)}
${wetBlock('The Times', 3, 'Synthetic Critic Beta', R.times)}
${wetBlock('WhatsOnStage', 4, 'Synthetic Critic Gamma', R.interview)}
${wetBlock('West End Theatre', 4, 'Synthetic House Critic', '')}
</div></article></body></html>`;

const trPara = (url, outlet, critic) => `<p><a href="${url}">${outlet}</a>’s ${critic} said: “${quote(outlet)}”</p>`;
const trPage = `<!doctype html><html><head><title>Theatre reviews roundup: The Lives of Others - theatre.reviews</title>
<meta property="article:published_time" content="2026-10-31T09:00:00+00:00"></head>
<body><article><div class="entry-content">
<p>Synthetic fixture: what the critics thought of The Lives of Others at the Adelphi Theatre.</p>
<p>4 stars ⭑⭑⭑⭑</p>
${trPara(R.telegraph, 'The Telegraph', 'Synthetic Critic Delta')}
<p>3 stars ⭑⭑⭑</p>
${trPara(R.guardian, 'The Guardian', 'Synthetic Critic Alpha')}
<p>Critics’ Average Rating: 3.5</p>
${'<p>Synthetic padding paragraph so the page reads as a full round-up rather than site chrome.</p>'.repeat(6)}
</div></article></body></html>`;

const tsListing = (withRoundup) => `<!doctype html><html><head><title>Review round-ups | The Stage</title></head><body><main>
${withRoundup ? `<a href="${TS_ROUNDUP}">The Lives of Others at the Adelphi: review round-up</a>` : ''}
<a href="https://www.thestage.co.uk/review-round-ups/an-older-synthetic-show-review-round-up">An older synthetic show</a>
</main></body></html>`;
const tsIndex = `<?xml version="1.0" encoding="UTF-8"?><sitemapindex><sitemap><loc>${TS_ARTICLES}</loc></sitemap></sitemapindex>`;
const tsArticles = `<?xml version="1.0" encoding="UTF-8"?><urlset><url><loc>https://www.thestage.co.uk/review-round-ups/an-older-synthetic-show-review-round-up</loc></url></urlset>`;
const tsPage = `<!doctype html><html><head><title>The Lives of Others at the Adelphi: review round-up | The Stage</title>
<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-10-30T15:00:00Z"}</script></head>
<body><main><article>
<p>Synthetic fixture prose. Synthetic Critic Epsilon (<a href="${R.standard}">Evening Standard, ★★★★</a>) wrote an invented line.</p>
<p>Synthetic Critic Zeta (<a href="${R.thestage}">The Stage, ★★★</a>) wrote another invented line.</p>
</article></main></body></html>`;
const tsGated = `<!doctype html><html><head><title>The Lives of Others at the Adelphi: review round-up | The Stage</title>
<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-10-30T15:00:00Z"}</script></head>
<body><main><p>Synthetic gate: create a free account to keep reading.</p><a href="/register?utm_source=Reggate">Register</a></main></body></html>`;

const lboSitemap = (withRoundup) => `<?xml version="1.0" encoding="UTF-8"?><urlset>
<url><loc>https://www.londonboxoffice.co.uk/news/post/an-older-synthetic-show-review</loc></url>
${withRoundup ? `<url><loc>${LBO_ROUNDUP}</loc></url>` : ''}
</urlset>`;
const lboBlock = (outlet, stars, critic, url) => `<h4>${outlet}</h4><p>${'★'.repeat(stars)}</p><p><strong>Reviewer:</strong> ${critic}</p>
<p>${quote(outlet)}${url ? ` <a href="${url}">Read the review</a>` : ''}</p>`;
const lboPage = `<!doctype html><html><head><title>Review Round-Up: The Lives of Others at the Adelphi Theatre | London Box Office</title>
<meta property="article:published_time" content="2026-11-02T10:00:00+00:00"></head>
<body><article>
<p>Synthetic fixture: The Lives of Others opened at the Adelphi Theatre on 29 October 2026.</p>
${lboBlock('London Box Office', 4, 'Synthetic House Critic', '')}
${lboBlock('The Independent', 4, 'Synthetic Critic Eta', R.independent)}
${lboBlock('Financial Times', 4, 'Synthetic Critic Theta', R.ft)}
${lboBlock('WhatsOnStage', 5, 'Synthetic Critic Iota', R.whatsonstage)}
</article></body></html>`;

// Stagedoor since 2026-06-25: the domain answers with a ticketing site's homepage.
const stagedoorGone = `<!doctype html><html><head><title>Synthetic ticketing homepage</title>
<link rel="canonical" href="https://www.londontheatredirect.com/"></head><body><p>Synthetic fixture.</p></body></html>`;

const err404 = (url, t) => ({ url, t, error: '404 Not Found', httpStatus: 404 });

/**
 * The synthetic night: what each source answered and when (`t`, ms after T0). Early fetches see no round-ups yet, as a
 * real press night does; round-ups appear the next days, as WET, theatre.reviews, The Stage and LBO publish them.
 */
function syntheticPages({ theStageGated = false } = {}) {
  return [
    // before any round-up exists (press night, 30 min in)
    { url: WET_SEARCH, t: 0.5 * HOUR, body: wetSearch(false), contentType: 'json' },
    err404(TR_ROUNDUP, 0.5 * HOUR), err404(TR_PLAIN, 0.5 * HOUR),
    { url: TR_SEARCH, t: 0.5 * HOUR, body: '[]', contentType: 'json' },
    { url: STAGEDOOR, t: 0.5 * HOUR, body: stagedoorGone },
    { url: TS_LISTING, t: 0.5 * HOUR, body: tsListing(false) },
    { url: TS_INDEX, t: 0.5 * HOUR, body: tsIndex },
    { url: TS_ARTICLES, t: 0.5 * HOUR, body: tsArticles },
    { url: LBO_SITEMAP, t: 0.5 * HOUR, body: lboSitemap(false) },
    // the round-ups, as each is published
    { url: WET_SEARCH, t: 1 * DAY, body: wetSearch(true), contentType: 'json' },
    { url: WET_POST, t: 1 * DAY, body: wetPage },
    { url: TR_ROUNDUP, t: 2 * DAY, body: trPage },
    { url: TS_LISTING, t: 1 * DAY + 3 * HOUR, body: tsListing(true) },
    { url: TS_ROUNDUP, t: 1 * DAY + 3 * HOUR, body: theStageGated ? tsGated : tsPage },
    { url: LBO_SITEMAP, t: 4 * DAY, body: lboSitemap(true) },
    { url: LBO_ROUNDUP, t: 4 * DAY, body: lboPage },
  ];
}

/** What the synthetic round-ups cite, by adapter: the reviews a replay at the end of the fixture must admit. */
const SYNTHETIC_EXPECTED = {
  'wet-roundup': [R.guardian, R.times],
  'theatre-reviews': [R.telegraph, R.guardian],
  'thestage-roundup': [R.standard, R.thestage],
  'lbo-roundup': [R.independent, R.ft, R.whatsonstage],
  stagedoor: [],
};
const SYNTHETIC_REFUSED = [R.interview];
const SYNTHETIC_END_MS = 5 * DAY;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Pages -> the recording shape replayFetchFrom reads ({entries, page, spanMs}), with ISO `at` timestamps. */
function recordingFromPages(pages, { t0 = T0 } = {}) {
  const bodies = new Map();
  const entries = pages.map((p) => {
    const at = new Date(t0 + p.t).toISOString();
    if (p.error) return { url: p.url, t: p.t, at, status: 'error', error: p.error, ...(p.httpStatus ? { httpStatus: p.httpStatus } : {}) };
    const sha = sha256(p.body);
    bodies.set(sha, p.body);
    return { url: p.url, t: p.t, at, status: 'ok', sha, bytes: Buffer.byteLength(p.body), ...(p.finalUrl ? { finalUrl: p.finalUrl } : {}) };
  });
  return { entries, page: (sha) => (bodies.has(sha) ? bodies.get(sha) : null), spanMs: entries.reduce((m, e) => Math.max(m, e.t || 0), 0) };
}

function syntheticRecording(opts) { return recordingFromPages(syntheticPages(opts)); }

/**
 * Where a real recorded fixture for this night may live, first that exists: $LANE_RECORDINGS_DIR, the git-ignored
 * data/lane-recordings, the private review-texts clone's lane-recordings (data/review-texts or ~/broadway-review-texts).
 * @returns {string|null} the recording dir (holding fetches.jsonl), or null
 */
function realFixtureDir({ env = process.env, repoRoot = path.join(__dirname, '..', '..', '..'), show = SHOW.id, night = NIGHT } = {}) {
  const roots = [
    env.LANE_RECORDINGS_DIR,
    path.join(repoRoot, 'data', 'lane-recordings'),
    path.join(repoRoot, 'data', 'review-texts', 'lane-recordings'),
    path.join(os.homedir(), 'broadway-review-texts', 'lane-recordings'),
  ].filter(Boolean);
  for (const root of roots) {
    const dir = path.join(root, show, night, KIND);
    if (fs.existsSync(path.join(dir, 'fetches.jsonl'))) return dir;
  }
  return null;
}

/**
 * Replay one recording through the West End adapters at virtual time `at` (ms after the recording's first fetch;
 * default: its end, every page published). Returns the discovery pass plus the URLs asked and the ones the recording
 * never had, and each admitted review's validation problem (west-end-adapters.westEndCandidateProblem), if any.
 */
async function replayWestEndNight(recording, { at = null, show = SHOW, night = NIGHT, adapters = null } = {}) {
  const d = require('../opening-night-lane/discovery');
  const we = require('../opening-night-lane/west-end-adapters');
  const startMs = 0;
  const clock = at === null ? recording.spanMs : at;
  const now = () => clock;
  const recorded = new Set(recording.entries.map((e) => e.url));
  const asked = [];
  const unrecorded = [];
  const replay = replayFetchFrom(recording, { now, startMs });
  const fetchText = d.fetchTextFrom(async (url, opts) => {
    asked.push(url);
    if (!recorded.has(url)) unrecorded.push(url);
    return replay(url, opts);
  });
  // The Stage's login fetch is off: a replay reads only what was recorded.
  const list = adapters || we.westEndAdapters({ now, fetchGated: null });
  const pass = await d.runDiscoveryPass({
    show, night, now: Date.parse(`${night}T18:00:00Z`) + clock, startedAt: Date.parse(`${night}T18:00:00Z`),
    fetchText, adapters: list, timeZone: 'Europe/London', deadlineMs: 10 * 60e3,
  });
  const problems = pass.admitted.map((a) => ({ url: a.key, adapter: a.adapter, problem: we.westEndCandidateProblem(a) })).filter((p) => p.problem);
  return { ...pass, asked, unrecorded, problems };
}

/**
 * Capture the night's pages as a real fixture: run the West End adapters once with a live fetchPage, record every
 * fetch (fetch-recording.js, an ephemeral key), then import it into `root` in the private archive layout
 * (recording-import.importRecording). `root` must be outside the public worktree or git-ignored (assertPrivateDest).
 * @returns {Promise<{dir: string, import: object, pass: object}>}
 */
async function captureWestEndNight({ root, fetchPage, show = SHOW, night = NIGHT, meta = {} }) {
  const { createFetchRecorder } = require('../opening-night-lane/fetch-recording');
  const imp = require('./recording-import');
  const d = require('../opening-night-lane/discovery');
  const we = require('../opening-night-lane/west-end-adapters');
  const dest = imp.assertPrivateDest(root);
  const key = crypto.randomBytes(32);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'we-capture-'));
  try {
    const rec = createFetchRecorder({ dir: path.join(tmp, 'rec'), key });
    const fetchText = rec.wrapFetchText(d.fetchTextFrom(fetchPage));
    const pass = await d.runDiscoveryPass({
      show, night, now: Date.now(), startedAt: Date.parse(`${night}T18:00:00Z`), fetchText,
      adapters: we.westEndAdapters({ fetchGated: null }), timeZone: 'Europe/London', deadlineMs: 10 * 60e3, fetchTimeoutMs: 120e3,
    });
    const result = imp.importRecording({
      srcDir: tmp, root: dest, show: show.id, night, kind: KIND, candidates: [{ id: 'ephemeral', key }],
      meta: { capturedBy: 'capture-lane-night.js (BRO-5956)', capturedAt: new Date().toISOString(), ...meta },
    });
    return { dir: path.join(dest, show.id, night, KIND), import: result, pass };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = {
  SHOW, NIGHT, KIND, T0, R, SYNTHETIC_EXPECTED, SYNTHETIC_REFUSED, SYNTHETIC_END_MS,
  syntheticPages, syntheticRecording, recordingFromPages, realFixtureDir, loadRecording, replayWestEndNight, captureWestEndNight,
};
