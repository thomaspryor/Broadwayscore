'use strict';

// BRO-7308: a build-time reference travels with the deployment. Never compare
// today's checkout with yesterday's HTML. Only public scores/counts are emitted.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { load } = require('cheerio');

const ROOT = path.resolve(__dirname, '../..');
const SNAPSHOT_PATH = '/data/prod-data-parity.json';
const CONDITION = 'prod-data-parity:mismatch';

function selectSample(shows, { limit = 20, now = new Date() } = {}) {
  const sorted = [...shows].sort((a, b) => a.id.localeCompare(b.id));
  const markets = [...new Set(sorted.map(s => s.category))].sort();
  const picked = new Map();
  const add = s => { if (s && picked.size < limit) picked.set(s.id, s); };
  // Each market gets a recent opening, long runner, closed show and no score.
  const strata = markets.map(category => {
    const group = sorted.filter(s => s.category === category);
    const open = group.filter(s => s.status === 'open');
    const rotation = Math.floor(now.getTime() / 86400000);
    const closed = group.filter(s => s.status === 'closed');
    const unscored = group.filter(s => s.score === null);
    return [
      [...open].sort((a, b) => (b.openingDate || '').localeCompare(a.openingDate || ''))[0] || group[0],
      unscored[rotation % unscored.length],
      closed[rotation % closed.length],
      [...open].sort((a, b) => (a.openingDate || '9999').localeCompare(b.openingDate || '9999'))[0],
    ];
  });
  // Round robin prevents alphabetically late markets (West End) being dropped.
  for (let i = 0; i < 4; i++) for (const picks of strata) add(picks[i]);
  const offset = Math.floor(now.getTime() / 86400000) % (sorted.length || 1);
  for (let i = 0; i < sorted.length && picked.size < limit; i++) add(sorted[(offset + i) % sorted.length]);
  return [...picked.values()];
}

function blobSha(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function buildSnapshot() {
  const readData = name => fs.readFileSync(path.join(ROOT, 'data', name));
  const showsBytes = readData('shows.json');
  const reviewsBytes = readData('reviews.json');
  // Fail closed before loadReviewsWithBlog's permissive missing-file fallback.
  const shows = JSON.parse(showsBytes).shows;
  const reviews = JSON.parse(reviewsBytes).reviews;
  if (!Array.isArray(shows) || !shows.length || !Array.isArray(reviews) || !reviews.length) {
    throw new Error('Parity snapshot requires real shows.json and reviews.json');
  }
  const { getCriticScore, resetCache } = require('tsx/cjs/api').require('./canonical-critic-scores.ts', __filename);
  const { loadReviewsWithBlog } = require('./load-reviews-with-blog');
  const { computeSlimCriticScore } = require('./slim-critic-score');
  const registry = JSON.parse(readData('outlet-registry.json')).outlets;
  const byShow = new Map();
  for (const review of loadReviewsWithBlog()) {
    if (!byShow.has(review.showId)) byShow.set(review.showId, []);
    byShow.get(review.showId).push(review);
  }
  resetCache();
  const candidates = shows.filter(s => s.slug && fs.existsSync(path.join(ROOT, 'public/data/shows', `${s.id}.json`)))
    .map(s => ({ id: s.id, slug: s.slug, category: s.category || 'broadway', status: s.status,
      openingDate: s.openingDate || null, score: getCriticScore(s.id) }));
  const originals = new Map(shows.map(s => [s.id, s]));
  const sample = selectSample(candidates).map(s => {
    // Count scored, deduplicated, visible reviews, just as the site does. Slim
    // rc is null below the score threshold even when the page has 1-4 reviews.
    const { scoreResult } = computeSlimCriticScore(originals.get(s.id), byShow.get(s.id), registry);
    return { ...s, reviewCount: scoreResult?.rc || 0 };
  });
  if (!sample.length) throw new Error('No generated show details; run the show-details generator first');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const snapshot = { version: 1, commit, showsBlobSha: blobSha(showsBytes), reviewsBlobSha: blobSha(reviewsBytes), sample };
  snapshot.id = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  return snapshot;
}

function validateSnapshot(snapshot) {
  if (snapshot?.version !== 1 || !/^[a-f0-9]{40}$/.test(snapshot.commit || '')
      || !/^[a-f0-9]{40}$/.test(snapshot.showsBlobSha || '') || !/^[a-f0-9]{40}$/.test(snapshot.reviewsBlobSha || '')
      || !/^[a-f0-9]{64}$/.test(snapshot.id || '') || !Array.isArray(snapshot.sample)
      || !snapshot.sample.length || snapshot.sample.length > 20) throw new Error('Invalid deployed parity snapshot');
  const ids = new Set();
  for (const s of snapshot.sample) {
    if (!s.id || ids.has(s.id) || !/^[a-z0-9-]+$/.test(s.slug || '')
        || !(s.score === null || (Number.isInteger(s.score) && s.score >= 0 && s.score <= 100))
        || !Number.isInteger(s.reviewCount) || s.reviewCount < 0) throw new Error('Invalid parity sample row');
    ids.add(s.id);
  }
  return snapshot;
}

function readPage(html) {
  const $ = load(html);
  $('script, style, template').remove();
  const heading = $('main h1').first();
  if (!heading.length) throw new Error('Missing show heading (error or bot checkpoint page)');
  // The redesigned hero deliberately omits the badge below the score gate.
  // Require its explicit empty-state marker, not merely absence of a number.
  const awaiting = $('main [data-testid="awaiting-reviews"], main [data-testid="no-reviews-expected"], main [data-testid="reviews-syncing"]');
  if (awaiting.length) {
    const text = awaiting.parent().text().replace(/\s+/g, ' ');
    const count = text.match(/(\d+)\s*reviews? collected/i)
      || $('#critic-reviews').text().match(/Critic Scorecard\s*(\d+)\s*reviews?/i);
    return { score: null, reviewCount: count ? Number(count[1]) : 0 };
  }
  // The hero contains the heading and both responsive badges, but excludes
  // recommendation cards and individual review scores further down the page.
  let hero = heading.closest('[data-testid="show-hero-redesign"]');
  if (!hero.length) {
    hero = heading.parent();
    while (hero.length && !hero.find('.score-badge').length && !hero.is('main, body')) hero = hero.parent();
  }
  if (hero.is('main, body') || !hero.length) throw new Error('Missing hero critic badge');
  const badges = hero.find('.score-badge').map((i, el) => $(el).text().trim()).get();
  if (!badges.length) throw new Error('Missing hero critic badge');
  const scores = badges.map(value => {
    if (/^\d{1,3}$/.test(value) && Number(value) <= 100) return Number(value);
    if (['TBD', '–', '-'].includes(value)) return null;
    throw new Error('Unrecognized critic badge');
  });
  if (new Set(scores).size !== 1) throw new Error('Responsive critic badges disagree');
  const countDom = hero.clone();
  countDom.find('.score-badge').remove();
  countDom.find('p, a, div').append(' ');
  const text = countDom.text().replace(/\s+/g, ' ');
  const counts = [...text.matchAll(/(\d+)\s*Critic\s*Reviews?/gi)].map(m => Number(m[1]));
  const partial = text.match(/(\d+)\s*reviews?\s*[·•]\s*\d+\s*more for a CriticScore/i);
  if (partial) counts.push(Number(partial[1]));
  if (new Set(counts).size > 1) throw new Error('Responsive critic review counts disagree');
  // An absent count on a scored page is a rendering defect, never a zero.
  if (!counts.length && scores[0] !== null) throw new Error('Missing critic review count');
  return { score: scores[0], reviewCount: counts[0] || 0 };
}

function comparePage(expected, actual) {
  return ['score', 'reviewCount'].filter(key => expected[key] !== actual[key])
    .map(field => ({ field, expected: expected[field], actual: actual[field] }));
}

async function probe({ base = 'https://broadwayscorecard.com', fetchImpl = fetch } = {}) {
  // Own-site uptime/numeric monitoring, not third-party scraping. No paid proxy.
  async function get(url, json = false) {
    const response = await fetchImpl(url, { cache: 'no-store', headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${new URL(url).pathname}`);
    return json ? response.json() : response.text();
  }
  const result = { matched: 0, mismatched: 0, unavailable: 0, rows: [], exitCode: 2 };
  try {
    const snapshot = validateSnapshot(await get(new URL(SNAPSHOT_PATH, base), true));
    result.commit = snapshot.commit;
    // Four concurrent requests, each bounded at 20s. A daily 20-show sample
    // costs 22 free CDN GETs, including the deployment-race check below.
    let next = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (next < snapshot.sample.length) {
        const expected = snapshot.sample[next++];
        try {
          const html = await get(new URL(`/show/${expected.slug}`, base));
          let actual;
          try { actual = readPage(html); }
          catch (err) {
            result.mismatched++;
            result.rows.push({ id: expected.id, differences: [{ field: 'rendered critic data', expected, actual: err.message }] });
            continue;
          }
          const differences = comparePage(expected, actual);
          result.rows.push({ id: expected.id, expected, actual, differences });
          if (differences.length) result.mismatched++; else result.matched++;
        } catch (err) {
          result.unavailable++;
          result.rows.push({ id: expected.id, error: err.message });
        }
      }
    }));
    const after = validateSnapshot(await get(new URL(SNAPSHOT_PATH, base), true));
    if (after.id !== snapshot.id) {
      result.error = 'Deployment changed during probe; retry against a stable deployment';
      result.matched = 0;
      result.mismatched = 0;
      result.unavailable = snapshot.sample.length;
      result.rows = [];
    } else result.exitCode = result.mismatched ? 1 : result.unavailable ? 2 : 0;
  } catch (err) {
    // No alert based on partial readings if the final deployment check failed.
    result.error = err.message;
    result.unavailable = result.rows.length || 1;
    result.matched = 0;
    result.mismatched = 0;
    result.rows = [];
  }
  return result;
}

async function runProbe({ alert = false, log = console.log, router, ...options } = {}) {
  const result = await probe(options);
  log(`Prod data parity: matched=${result.matched} mismatched=${result.mismatched} unavailable=${result.unavailable}${result.error ? ` (${result.error})` : ''}`);
  for (const row of result.rows.filter(r => r.error || r.differences?.length)) log(JSON.stringify(row));
  if (alert) {
    const { routeAlert, resolveCondition } = router || require('./owner-alert-router');
    if (result.mismatched) {
      const routed = await routeAlert({
        conditionKey: CONDITION, title: 'Production show pages disagree with deployed critic data',
        description: `Deployed commit: ${result.commit}\n${result.mismatched} of ${result.rows.length} show pages differ.\n`
          + result.rows.filter(r => r.differences?.length).map(r => `${r.id}: ${JSON.stringify(r.differences)}`).join('\n')
          + '\nVERIFY: node scripts/lib/prod-data-parity.js',
        severity: 'error', disposition: 'auto', cooldownHours: 24,
      });
      log(`Prod data parity alert: ${routed.action}`);
    } else if (result.exitCode === 0) resolveCondition(CONDITION, { reason: 'All sampled production pages match their deployed data' });
    // An unavailable/racing deployment never resolves an existing mismatch.
  }
  return result;
}

async function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) {
    console.log('node scripts/lib/prod-data-parity.js [--snapshot | --alert] [--base=URL]\nDefault: read-only live comparison; exits 0 matched, 1 mismatched, 2 unavailable.');
    return 0;
  }
  if (args.includes('--snapshot')) {
    const snapshot = buildSnapshot();
    fs.writeFileSync(path.join(ROOT, 'public', SNAPSHOT_PATH), JSON.stringify(snapshot) + '\n');
    console.log(`Prod data parity reference: ${snapshot.sample.length} shows at ${snapshot.commit}`);
    return 0;
  }
  const base = args.find(a => a.startsWith('--base='))?.slice(7);
  const result = await runProbe({ alert: args.includes('--alert'), ...(base ? { base } : {}) });
  return result.exitCode;
}

if (require.main === module) main().then(code => { process.exitCode = code; }).catch(err => { console.error(err.message); process.exitCode = 2; });
module.exports = { selectSample, buildSnapshot, validateSnapshot, readPage, comparePage, probe, runProbe, main };
