import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const { selectSample, readPage, comparePage, probe, runProbe, validateSnapshot } = require('../../scripts/lib/prod-data-parity');

const page = (score, count = 12) => `<main><div><h1>A show</h1><div class="score-badge">${score}</div><p>Based on <!-- -->${count}<!-- --> Critic Reviews</p></div><aside><div class="score-badge">99</div>Based on 999 Critic Reviews</aside></main>`;
const sample = [{ id: 'a', slug: 'a', score: 82, reviewCount: 12 }, { id: 'b', slug: 'b', score: null, reviewCount: 0 }];
const snapshot = () => ({ version: 1, commit: 'a'.repeat(40), id: 'b'.repeat(64), showsBlobSha: 'c'.repeat(40), reviewsBlobSha: 'd'.repeat(40), sample });
const empty = '<main><div><h1>Unscored show</h1><div class="score-badge">TBD</div></div></main>';

test('reads rendered integer badge and count without confusing audience, SEO or recommendation scores', () => {
  const html = page(82).replace('<main>', '<main><script type="application/ld+json">{"ratingValue":4.3}</script>');
  assert.deepEqual(readPage(html), { score: 82, reviewCount: 12 });
  assert.deepEqual(comparePage(sample[0], readPage(html)), []);
  assert.deepEqual(comparePage({ score: 81, reviewCount: 13 }, readPage(html)), [
    { field: 'score', expected: 81, actual: 82 }, { field: 'reviewCount', expected: 13, actual: 12 },
  ]);
});

test('distinguishes unscored, low-review, missing and inconsistent responsive badges', () => {
  assert.deepEqual(readPage(empty), { score: null, reviewCount: 0 });
  const awaiting = '<main><div><h1>Show</h1></div><div><p data-testid="awaiting-reviews">Awaiting reviews</p><a>Not enough reviews yet · 3 reviews collected · 2 more for a CriticScore</a></div></main>';
  assert.deepEqual(readPage(awaiting), { score: null, reviewCount: 3 });
  assert.deepEqual(readPage(awaiting.replace('3 reviews collected · ', '')), { score: null, reviewCount: 0 });
  for (const state of ['no-reviews-expected', 'reviews-syncing']) {
    assert.deepEqual(readPage(awaiting.replace('awaiting-reviews', state)), { score: null, reviewCount: 3 });
  }
  assert.deepEqual(readPage(empty.replace('</div></main>', '<a>1 review · 4 more for a CriticScore</a></div></main>')), { score: null, reviewCount: 1 });
  assert.throws(() => readPage('<h1>Vercel checkpoint</h1>'), /heading/);
  assert.throws(() => readPage('<main><h1>Show</h1><aside class="score-badge">91</aside></main>'), /hero/);
  assert.throws(() => readPage(empty.replace('TBD', '82')), /count/);
  assert.throws(() => readPage(page(82).replace('<p>', '<div class="score-badge">83</div><p>')), /disagree/);
  assert.throws(() => readPage(page('garbled')), /Unrecognized/);
  const responsive = '<main><div data-testid="show-hero-redesign"><div><h1>Show</h1><div class="score-badge">82</div>Based on 12 Critic Reviews</div><div class="score-badge">82</div><p>12 critic reviews</p></div></main>';
  assert.deepEqual(readPage(responsive), { score: 82, reviewCount: 12 });
  assert.throws(() => readPage(responsive.replace('<p>12', '<p>9')), /counts disagree/);
  assert.throws(() => readPage(responsive.replace('</div><div class="score-badge">82', '</div><div class="score-badge">17')), /badges disagree/);
});

test('20-show stratified sample includes all six markets, recent/long-running/closed/no-score and rotates', () => {
  const markets = ['broadway', 'off-broadway', 'off-west-end', 'regional', 'tour', 'west-end'];
  const shows = markets.flatMap(category => [
    { id: `${category}-recent`, category, status: 'open', score: 80, openingDate: '2026-11-01' },
    { id: `${category}-long`, category, status: 'open', score: 90, openingDate: '1999-01-01' },
    ...Array.from({ length: 4 }, (_, i) => ({ id: `${category}-closed-${i}`, category, status: 'closed', score: null })),
  ]);
  const picks = selectSample(shows, { now: new Date('2026-11-11') });
  assert.equal(picks.length, 20);
  assert.equal(new Set(picks.map(s => s.id)).size, 20);
  assert.deepEqual([...new Set(picks.map(s => s.category))].sort(), markets);
  for (const suffix of ['-recent', '-long']) assert.ok(picks.some(s => s.id.endsWith(suffix)));
  assert.ok(picks.some(s => s.status === 'closed'));
  assert.ok(picks.some(s => s.score === null));
  assert.notDeepEqual(picks, selectSample(shows, { now: new Date('2026-11-12') }));
  assert.deepEqual(selectSample([]), []);
});

test('rejects missing, empty or malformed deployed baselines instead of reporting a pass', () => {
  for (const bad of [null, {}, { ...snapshot(), sample: [] }, { ...snapshot(), sample: [{ ...sample[0], score: '82' }] }]) {
    assert.throws(() => validateSnapshot(bad), /Invalid/);
  }
});

function transport({ mismatch = false, race = false, failedPage = false } = {}) {
  let reads = 0;
  return async url => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('.json')) return { ok: true, json: async () => ({ ...snapshot(), id: (++reads > 1 && race ? 'e' : 'b').repeat(64) }) };
    return { ok: !failedPage, status: 503, text: async () => pathname === '/show/a' ? page(mismatch ? 81 : 82) : empty };
  };
}

test('uses only deployed baseline, reports mismatches, and distinguishes network failures and deploy races', async () => {
  const good = await probe({ fetchImpl: transport() });
  assert.deepEqual([good.exitCode, good.matched, good.mismatched, good.unavailable], [0, 2, 0, 0]);
  const bad = await probe({ fetchImpl: transport({ mismatch: true }) });
  assert.deepEqual([bad.exitCode, bad.matched, bad.mismatched], [1, 1, 1]);
  const failed = await probe({ fetchImpl: transport({ failedPage: true }) });
  assert.deepEqual([failed.exitCode, failed.matched, failed.unavailable], [2, 0, 2]);
  const race = await probe({ fetchImpl: transport({ mismatch: true, race: true }) });
  assert.deepEqual([race.exitCode, race.mismatched, race.unavailable], [2, 0, 2]);
  assert.match(race.error, /Deployment changed/);
  const missing = await probe({ fetchImpl: async () => ({ ok: false, status: 404 }) });
  assert.equal(missing.exitCode, 2);
  const badHtml = await probe({ fetchImpl: async (url, opts) => new URL(url).pathname.endsWith('.json')
    ? transport()(url, opts) : { ok: true, text: async () => '<main><h1>Show</h1></main>' } });
  assert.deepEqual([badHtml.exitCode, badHtml.mismatched], [1, 2]);
  let reads = 0;
  const unstable = await probe({ fetchImpl: async (url, opts) => {
    if (new URL(url).pathname.endsWith('.json') && ++reads > 1) throw new Error('Final GET failed');
    return transport({ mismatch: true })(url, opts);
  } });
  assert.equal(unstable.exitCode, 2);
  assert.equal(unstable.mismatched, 0);
});

test('actual CLI prints counts and exits non-zero on a seeded mismatch', async t => {
  const server = createServer((req, res) => {
    if (req.url.endsWith('.json')) res.end(JSON.stringify(snapshot()));
    else res.end(req.url === '/show/a' ? page(81) : empty);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const child = spawn(process.execPath, ['scripts/lib/prod-data-parity.js', `--base=http://127.0.0.1:${server.address().port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { out += chunk; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(code, 1, out);
  assert.match(out, /matched=1 mismatched=1 unavailable=0/);
});

test('one router condition covers all mismatches and only a complete pass resolves it', async () => {
  const calls = [];
  const router = { routeAlert: async input => { calls.push(input); return { action: 'silent' }; }, resolveCondition: key => calls.push(key) };
  await runProbe({ alert: true, log: () => {}, router, fetchImpl: transport({ mismatch: true }) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].conditionKey, 'prod-data-parity:mismatch');
  assert.equal(calls[0].disposition, 'auto');
  await runProbe({ alert: true, log: () => {}, router, fetchImpl: transport({ failedPage: true }) });
  assert.equal(calls.length, 1);
  await runProbe({ alert: true, log: () => {}, router, fetchImpl: transport() });
  assert.equal(calls[1], 'prod-data-parity:mismatch');
});

// BRO-8056 G1: a page the show-refresh reader rendered from a published slice
// carries <meta name="show-refresh-rev" content="<hash>">; the probe compares it
// against that slice's expectation, never the prebuild row.
const H1 = '0123456789abcdef';
const marked = (html, rev) => html.replace('<main>', `<meta name="show-refresh-rev" content="${rev}"/><main>`);
function refreshTransport(aHtml) {
  return async url => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('.json')) return { ok: true, json: async () => ({ ...snapshot(), refreshBuildInstant: 1 }) };
    return { ok: true, text: async () => pathname === '/show/a' ? aHtml : empty };
  };
}

test('G1: refresh marker picks the expectation (base, hash + overlay, stale prebuild, disagreement, store down)', async () => {
  const { readRefreshMarker } = require('../../scripts/lib/prod-data-parity');
  assert.deepEqual(readRefreshMarker(page(82)), { kind: 'base', value: null });
  assert.equal(readRefreshMarker(marked(page(82), 'base-error')).kind, 'base');
  assert.deepEqual(readRefreshMarker(marked(page(82), H1)), { kind: 'hash', value: H1 });
  assert.equal(readRefreshMarker(marked(page(82), 'zz')).kind, 'invalid');

  const never = async () => { throw new Error('overlay must not be read for a base page'); };
  const base = await probe({ fetchImpl: refreshTransport(marked(page(82), 'base')), refreshExpectation: never });
  assert.deepEqual([base.exitCode, base.matched, base.mismatched], [0, 2, 0]);

  const calls = [];
  const overlay = row => async (id, hash, snap) => { calls.push([id, hash, snap.refreshBuildInstant]); return row; };
  // Prebuild row says 82/12; the refreshed page shows the slice's 88/14 => matched through the overlay.
  const refreshed = await probe({ fetchImpl: refreshTransport(marked(page(88, 14), H1)), refreshExpectation: overlay({ score: 88, reviewCount: 14 }) });
  assert.deepEqual([refreshed.exitCode, refreshed.matched, refreshed.mismatched], [0, 2, 0]);
  assert.deepEqual(calls, [['a', H1, 1]]);
  // Same page checked against the stale prebuild row only would mismatch: proves the overlay is what matched.
  const stale = await probe({ fetchImpl: refreshTransport(page(88, 14)), refreshExpectation: never });
  assert.equal(stale.mismatched, 1);
  // Overlay disagrees with what the page rendered => mismatched.
  const wrong = await probe({ fetchImpl: refreshTransport(marked(page(88, 14), H1)), refreshExpectation: overlay({ score: 70, reviewCount: 14 }) });
  assert.deepEqual([wrong.exitCode, wrong.mismatched], [1, 1]);
  // Store unreadable for a hashed page => unavailable, never mismatched.
  const down = await probe({ fetchImpl: refreshTransport(marked(page(88, 14), H1)), refreshExpectation: async () => { throw new Error('store down'); } });
  assert.deepEqual([down.exitCode, down.mismatched, down.unavailable], [2, 0, 1]);
  // A marker that is neither base nor a hash is a rendering defect.
  const garbled = await probe({ fetchImpl: refreshTransport(marked(page(82), 'zz')), refreshExpectation: never });
  assert.deepEqual([garbled.exitCode, garbled.mismatched], [1, 1]);
});

// BRO-8227: class guard. The hero's trailing date ("Closes Feb 28, 2027") abuts the
// "Critic reviews after opening night" empty state; the year must never read as a count.
test('hero date year before "Critic reviews" is not a review count (BRO-8227)', () => {
  const hero = tail => `<main><div data-testid="show-hero-redesign"><h1>Texas in Paris</h1><div class="score-badge">TBD</div><p>Previews from Jan 14, 2027 · Closes Feb 28, 2027</p>${tail}</div></main>`;
  assert.deepEqual(readPage(hero('<p>Critic reviews after opening night</p>')), { score: null, reviewCount: 0 });
  assert.deepEqual(readPage(hero('<span>Critic reviews after opening night</span>')), { score: null, reviewCount: 0 });
  assert.deepEqual(readPage(hero('<p>12 Critic Reviews</p>')), { score: null, reviewCount: 12 });
  assert.deepEqual(readPage(hero('<p>Updated today, 12 Critic Reviews</p>')), { score: null, reviewCount: 12 });
  assert.deepEqual(readPage(hero('<p>1,234 Critic Reviews</p>')), { score: null, reviewCount: 1234 });
  // A venue name ending in a digit sits right before the empty-state label.
  assert.deepEqual(readPage(hero('<p>Stage 42</p><p>Critic reviews after opening night</p>')), { score: null, reviewCount: 0 });
});

