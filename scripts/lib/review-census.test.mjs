import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { unionCensus, censusVerdict, buildCensusFromArchives, CI_UNFETCHABLE_OUTLETS,
  sourceExtractors, parseBwwRoundup, parseShowScore } = require('./review-census.js');

test('unionCensus dedups by normalized outlet, merges sources, keeps URL + real critic', () => {
  const c = unionCensus([
    { source: 'theatre-reviews', reviews: [
      { outlet: 'The Guardian', outletId: 'guardian', critic: 'Arifa Akbar', stars: 3, url: 'g.com/r' },
      { outlet: 'WhatsOnStage', outletId: 'whatsonstage', critic: 'Unknown', stars: 3, url: '' },
    ]},
    { source: 'lbo', reviews: [
      { outlet: 'WhatsOnStage', outletId: 'whatsonstage', critic: 'Sarah Crompton', stars: 3, url: 'wos.com/r' },
    ]},
  ]);
  assert.equal(c.count, 2);
  assert.equal(c.hadAnySource, true);
  assert.deepEqual(c.sourcesPresent, ['theatre-reviews', 'lbo']);
  const wos = c.entries.find(e => e.outletId === 'whatsonstage');
  assert.equal(wos.critic, 'Sarah Crompton', 'real critic beats Unknown');
  assert.equal(wos.url, 'wos.com/r', 'URL filled from the source that had it');
  assert.deepEqual(wos.sources.sort(), ['lbo', 'theatre-reviews']);
});

test('empty / no-source census → hadAnySource false', () => {
  assert.equal(unionCensus([]).hadAnySource, false);
  assert.equal(unionCensus([{ source: 'theatre-reviews', reviews: [] }]).hadAnySource, false);
  assert.equal(unionCensus([{ source: 'x', reviews: [] }]).count, 0);
});

// THE KILLER TEST (reviewers): an empty census must NEVER read complete.
test('no-census-yet: empty census is never "complete", even with reviews present', () => {
  const empty = unionCensus([]); // no roundup published yet
  const covered = new Set(['guardian', 'times-uk', 'telegraph']); // we DO have some scored
  const v = censusVerdict(empty, covered);
  assert.equal(v.verdict, 'no-census-yet');
  assert.notEqual(v.verdict, 'complete');
});

test('verdict complete only when every censused outlet is present AND scored', () => {
  const census = unionCensus([{ source: 'theatre-reviews', reviews: [
    { outletId: 'guardian', outlet: 'The Guardian', critic: 'A', stars: 3, url: 'u1' },
    { outletId: 'whatsonstage', outlet: 'WhatsOnStage', critic: 'B', stars: 3, url: 'u2' },
  ]}]);
  // both present + scored → complete
  assert.equal(censusVerdict(census, new Set(['guardian', 'whatsonstage'])).verdict, 'complete');
  // whatsonstage missing → incomplete, listed
  const inc = censusVerdict(census, new Set(['guardian']));
  assert.equal(inc.verdict, 'incomplete');
  assert.deepEqual(inc.missing.map(m => m.outletId), ['whatsonstage']);
});

test('present-but-unscored counts as missing (MJ/All My Sons class)', () => {
  // coveredScoredOutlets only includes outlets with assignedScore != null.
  // whatsonstage has a FILE but no score → caller does NOT put it in the set → missing.
  const census = unionCensus([{ source: 'theatre-reviews', reviews: [
    { outletId: 'whatsonstage', outlet: 'WhatsOnStage', critic: 'B', stars: 3, url: 'u2' },
  ]}]);
  assert.equal(censusVerdict(census, new Set([])).verdict, 'incomplete');
});

test('market-suffix tolerance: census "timeout" matches reviews "timeout-london"', () => {
  const census = unionCensus([{ source: 'theatre-reviews', reviews: [
    { outletId: 'timeout', outlet: 'Time Out', critic: 'A', stars: 4, url: 'u1' },     // roundup bare label
    { outletId: 'guardian', outlet: 'The Guardian', critic: 'B', stars: 3, url: 'u2' },
  ]}]);
  assert.equal(censusVerdict(census, new Set(['timeout-london', 'guardian'])).verdict, 'complete');
  // reverse direction: census -london, reviews bare
  const census2 = unionCensus([{ source: 'lbo', reviews: [
    { outletId: 'timeout-london', outlet: 'Time Out London', critic: 'A', stars: 4, url: 'u1' },
  ]}]);
  assert.equal(censusVerdict(census2, new Set(['timeout'])).verdict, 'complete');
});

test('suppressed (unfetchable T1) keeps the show incomplete + visible, never complete', () => {
  const census = unionCensus([{ source: 'theatre-reviews', reviews: [
    { outletId: 'guardian', outlet: 'The Guardian', critic: 'A', stars: 3, url: 'u1' },
    { outletId: 'nytimes', outlet: 'The New York Times', critic: 'C', stars: null, url: 'u3' },
  ]}]);
  const v = censusVerdict(census, new Set(['guardian']), { suppressed: new Set(['nytimes']) });
  assert.equal(v.verdict, 'incomplete', 'suppressed-missing must NOT flip to complete');
  assert.deepEqual(v.suppressedMissing.map(m => m.outletId), ['nytimes']);
  assert.deepEqual(v.missing.map(m => m.outletId), []);
});

test('CI_UNFETCHABLE_OUTLETS is exported and covers the CI-IP-blocked outlets', () => {
  assert.ok(CI_UNFETCHABLE_OUTLETS instanceof Set);
  assert.ok(CI_UNFETCHABLE_OUTLETS.has('wsj'));
  assert.ok(CI_UNFETCHABLE_OUTLETS.has('newyorker'));
});

test('buildCensusFromArchives flags zeroExtract: archive present but parser returns 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'census-'));
  // Two source archives EXIST on disk; one extractor parses fine, one returns [].
  fs.mkdirSync(path.join(dir, 'good'));
  fs.mkdirSync(path.join(dir, 'broke'));
  fs.writeFileSync(path.join(dir, 'good', 'show-x.html'), '<html>ok</html>');
  fs.writeFileSync(path.join(dir, 'broke', 'show-x.html'), '<html>changed DOM</html>');
  const sources = [
    { name: 'good', dir: 'good', fn: () => [{ outletId: 'guardian', outlet: 'The Guardian', critic: 'A', stars: 3, url: 'u' }] },
    { name: 'broke', dir: 'broke', fn: () => [] }, // parser drift → 0 reviews despite a present archive
  ];
  const census = buildCensusFromArchives('show-x', { archiveDir: dir, sources });
  assert.deepEqual(census.archivesPresent.sort(), ['broke', 'good'], 'both files were present');
  assert.deepEqual(census.zeroExtract, ['broke'], 'the broken parser is flagged, not silently swallowed');
  assert.equal(census.hadAnySource, true, 'the working source still yields a census');
  assert.equal(census.count, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── WET + The Stage wiring (real sourceExtractors, real per-source ext) ─────────
// These exercise the actual default sources, not injected stubs: a regression in
// the WET JSON parser, the ratings fallback, or the Stage extractor fails here.

test('buildCensusFromArchives reads WestEndTheatre .json (rich reviews shape)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'census-wet-'));
  fs.mkdirSync(path.join(dir, 'westendtheatre'));
  fs.writeFileSync(path.join(dir, 'westendtheatre', 'show-w.json'), JSON.stringify({
    reviews: [
      { outlet: 'The Guardian', outletId: 'guardian', critic: 'Arifa Akbar', stars: 4, url: 'g.com/r' },
      { outlet: 'The Stage', outletId: 'thestage', critic: 'Tim Bano', stars: 3, url: 's.com/r' },
    ],
  }));
  const c = buildCensusFromArchives('show-w', { archiveDir: dir });
  assert.equal(c.hadAnySource, true);
  assert.deepEqual(c.sourcesPresent, ['westendtheatre']);
  assert.equal(c.count, 2);
  assert.deepEqual(c.zeroExtract, [], 'rich archive must not flag zeroExtract');
  const g = c.entries.find((e) => e.outletId === 'guardian');
  assert.equal(g.url, 'g.com/r');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('WET .json ratings-only shape is unioned (NOT silently dropped) — outletId + reviewUrl normalized', () => {
  // ~1/3 of real WET archives carry only the star table {ratings:[{outlet,stars}]},
  // no outletId/url. Reading only `reviews` would zero them — the silent-gate trap.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'census-wetr-'));
  fs.mkdirSync(path.join(dir, 'westendtheatre'));
  fs.writeFileSync(path.join(dir, 'westendtheatre', 'show-r.json'), JSON.stringify({
    ratings: [
      { outlet: 'The Standard', stars: 5 },
      { outlet: 'The Telegraph', stars: 4, critic: 'Claire Allfree', reviewUrl: 't.com/r' },
    ],
  }));
  const c = buildCensusFromArchives('show-r', { archiveDir: dir });
  assert.equal(c.count, 2, 'ratings-only archive contributes to the census');
  assert.deepEqual(c.zeroExtract, [], 'ratings fallback means the archive is NOT zeroExtract');
  const tel = c.entries.find((e) => e.outletId === 'telegraph');
  assert.ok(tel, 'outletId derived via normalizeOutlet from "The Telegraph"');
  assert.equal(tel.critic, 'Claire Allfree');
  assert.equal(tel.url, 't.com/r', 'reviewUrl mapped to census url');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('WET rich row with a STALE baked outletId is re-normalized from the outlet name', () => {
  // WET archives are pre-extracted/frozen; their baked outletId reflects an OLD
  // normalizeOutlet (Daily Express→"the-express", The Sunday Times→"the-sun") that
  // no longer matches reviews.json ("express-uk"/"times-uk"). Trusting it splits one
  // outlet into two census entries → present+scored outlet reads as missing →
  // false-incomplete → needless re-dispatch. Re-derive outletId from the name.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'census-wetn-'));
  fs.mkdirSync(path.join(dir, 'westendtheatre'));
  fs.writeFileSync(path.join(dir, 'westendtheatre', 'show-n.json'), JSON.stringify({
    reviews: [
      { outlet: 'Daily Express', outletId: 'the-express', critic: 'A', stars: 4, url: 'e.com/r' },
      { outlet: 'The Sunday Times', outletId: 'the-sun', critic: 'B', stars: 3, url: 's.com/r' },
    ],
  }));
  const c = buildCensusFromArchives('show-n', { archiveDir: dir });
  const ids = c.entries.map((e) => e.outletId).sort();
  // normalizeOutlet collapses these to the canonical ids reviews.json uses.
  assert.deepEqual(ids, ['express-uk', 'times-uk'], 'stale baked ids re-normalized, not trusted');
  assert.ok(!ids.includes('the-express') && !ids.includes('the-sun'), 'no stale id leaks into the census');
  // Now a show whose reviews.json HAS express-uk scored reads as complete, not missing.
  assert.equal(censusVerdict(c, new Set(['express-uk', 'times-uk'])).verdict, 'complete');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('truly-empty WET archive (no reviews, no ratings) → zeroExtract, never silent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'census-wete-'));
  fs.mkdirSync(path.join(dir, 'westendtheatre'));
  fs.writeFileSync(path.join(dir, 'westendtheatre', 'show-e.json'), JSON.stringify({ ratings: [] }));
  const c = buildCensusFromArchives('show-e', { archiveDir: dir });
  assert.deepEqual(c.archivesPresent, ['westendtheatre'], 'file was present');
  assert.deepEqual(c.zeroExtract, ['westendtheatre'], 'empty archive flags its own blindness');
  assert.equal(c.hadAnySource, false);
});

test('buildCensusFromArchives reads The Stage .html via the pure (playwright-free) extractor', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'census-stage-'));
  fs.mkdirSync(path.join(dir, 'thestage-roundups'));
  fs.writeFileSync(path.join(dir, 'thestage-roundups', 'show-s.html'),
    '<html><body><p>Susannah Clapp (<a href="https://www.theguardian.com/x">Guardian, ★★★★</a>) admired it.</p></body></html>');
  const c = buildCensusFromArchives('show-s', { archiveDir: dir });
  assert.deepEqual(c.sourcesPresent, ['thestage'], 'The Stage source is wired into the default census');
  const g = c.entries.find((e) => e.outletId === 'guardian');
  assert.ok(g, 'Stage extractor parsed the Guardian rating');
  assert.equal(g.stars, 4);
  fs.rmSync(dir, { recursive: true, force: true });
});


// --- Cross-show archive guard (page-level via verifyAggregatorUrl) ---
const TR = (title, venue, bodyExtra = '') =>
  `<html><head><title>Theatre reviews roundup: ${title}</title>` +
  `<link rel="canonical" href="https://theatre.reviews/reviews-roundup/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-reviews/"></head>` +
  `<body>⭑⭑⭑⭑ ${title} at ${venue}. ${bodyExtra}</body></html>`;

test('wrongRoundup: a War Horse archive that is actually the Equus roundup is rejected (page-level)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'census-tr-'));
  fs.mkdirSync(path.join(dir, 'theatre-reviews'));
  fs.writeFileSync(path.join(dir, 'theatre-reviews', 'war-horse-west-end-2026.html'), TR('Equus', 'The Menier'));
  // The extractor would happily return Equus entries — but validation runs FIRST.
  const sources = [{ name: 'theatre-reviews', dir: 'theatre-reviews', validate: true,
    fn: () => ([{ outletId: 'guardian', outlet: 'The Guardian', critic: 'X', url: 'https://x/equus' }]) }];
  const census = buildCensusFromArchives('war-horse-west-end-2026', {
    archiveDir: dir, sources, show: { title: 'War Horse', venue: 'National Theatre' } });
  assert.equal(census.count, 0, 'Equus page yields no War Horse census');
  assert.deepEqual(census.wrongRoundup, ['theatre-reviews']);
  assert.equal(census.zeroExtract.length, 0, 'parser never ran — not flagged broken');
});

test('a genuine roundup whose entries are STAR/headline slugs is kept (no false-drop)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'census-cab-'));
  fs.mkdirSync(path.join(dir, 'theatre-reviews'));
  // Page title names the show (Cabaret); the review URLs are star slugs (redmayne).
  fs.writeFileSync(path.join(dir, 'theatre-reviews', 'cabaret-2026.html'), TR('Cabaret', 'Kit Kat Club'));
  const sources = [{ name: 'theatre-reviews', dir: 'theatre-reviews', validate: true,
    fn: () => ([
      { outletId: 'standard', outlet: 'Standard', critic: 'A', url: 'https://x/eddie-redmayne-kit-kat-club' },
      { outletId: 'guardian', outlet: 'The Guardian', critic: 'B', url: 'https://x/cabaret-review' },
    ]) }];
  const census = buildCensusFromArchives('cabaret-2026', {
    archiveDir: dir, sources, show: { title: 'Cabaret', venue: 'Kit Kat Club' } });
  assert.deepEqual(census.entries.map((e) => e.outletId).sort(), ['guardian', 'standard'],
    'headline-slug Standard review is NOT dropped — page validated by title, not per-URL token');
  assert.equal(census.wrongRoundup.length, 0);
});

test('validation is a no-op without opts.show (back-compat) and for non-validate sources', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'census-noval-'));
  fs.mkdirSync(path.join(dir, 'lbo-roundups'));
  fs.writeFileSync(path.join(dir, 'lbo-roundups', 's.html'), '<html><title>anything</title></html>');
  const sources = [{ name: 'lbo', dir: 'lbo-roundups', /* no validate */
    fn: () => ([{ outletId: 'guardian', outlet: 'The Guardian', critic: 'A', url: 'u' }]) }];
  // even with a show passed, a non-validate source is not page-checked
  const census = buildCensusFromArchives('s', { archiveDir: dir, sources, show: { title: 'Whatever' } });
  assert.equal(census.count, 1, 'non-validate source extracts normally');
  assert.equal(census.wrongRoundup.length, 0);
});

// ─── NYC census sources (BWW / DTLI / Playbill Verdict / Show Score) ──────────
// Every new NYC extractor needs a both-shapes test (the WET two-shapes lesson has
// NYC cousins): BWW ships BlogPosting-per-critic AND single-article articleBody.

const LD = (obj) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;

test('parseBwwRoundup shape 1: JSON-LD BlogPosting-per-critic (author "Outlet - Critic")', () => {
  const html = '<html><body>' +
    LD([
      { '@type': 'BlogPosting', author: { name: 'The New York Times - Jesse Green' }, url: 'https://nyt/r' },
      { '@type': 'BlogPosting', author: { name: 'Variety - Naveen Kumar' }, url: 'https://variety/r' },
      { '@type': 'BlogPosting', author: { name: 'Time Out New York' }, url: 'https://to/r' }, // outlet only, no critic
    ]) + '</body></html>';
  const rows = parseBwwRoundup(html, 'show-x');
  assert.equal(rows.length, 3);
  const nyt = rows.find((r) => /New York Times/.test(r.outlet));
  assert.equal(nyt.critic, 'Jesse Green');
  assert.equal(nyt.url, 'https://nyt/r');
  assert.equal(rows.find((r) => /Time Out/.test(r.outlet)).critic, 'Unknown', 'outlet-only author → Unknown critic');
});

test('parseBwwRoundup shape 2: articleBody "Critic, Outlet:" fallback when no BlogPosting', () => {
  const body = "Let's see what the critics had to say... " +
    'Jesse Green, The New York Times: A triumph. ' +
    'Adam Feldman, Time Out: Dazzling.';
  const html = '<html><body>' + LD({ '@type': 'NewsArticle', articleBody: body }) + '</body></html>';
  const rows = parseBwwRoundup(html, 'show-y');
  const outlets = rows.map((r) => r.outlet);
  assert.ok(outlets.some((o) => /New York Times/.test(o)), 'articleBody NYT parsed');
  assert.ok(outlets.some((o) => /Time Out/.test(o)), 'articleBody Time Out parsed');
  assert.ok(rows.every((r) => r.url === ''), 'articleBody pairs carry no per-review URL');
});

test('parseBwwRoundup drops junk "outlets" (sentence fragments as authors)', () => {
  const html = '<html><body>' + LD([
    { '@type': 'BlogPosting', author: { name: 'Variety - Naveen Kumar' }, url: 'u1' },
    { '@type': 'BlogPosting', author: { name: 'are likely to inspire a heavy outpouring of adjectives and superlatives' }, url: 'u2' },
  ]) + '</body></html>';
  const rows = parseBwwRoundup(html, 'show-z');
  assert.deepEqual(rows.map((r) => r.outlet), ['Variety'], 'sentence-fragment author filtered by isJunkOutlet');
});

test('parseShowScore soft-fails on an asset-shell page (0 rows, no throw)', () => {
  // Archived Show Score pages are often SPA shells whose only links are CDN assets.
  const html = '<html><body><a href="https://d2kbhv4d9rykxy.cloudfront.net/app.css">css</a></body></html>';
  const rows = parseShowScore(html, 'show-ss');
  assert.deepEqual(rows, [], 'no registry outlet resolvable → empty, not an error');
});

test('sourceExtractors routes market: NYC set vs West End set', () => {
  const nyc = sourceExtractors('broadway').map((s) => s.name);
  assert.deepEqual(nyc, ['bww-roundup', 'dtli', 'playbill-verdict', 'show-score']);
  const ss = sourceExtractors('broadway').find((s) => s.name === 'show-score');
  assert.equal(ss.softFail, true, 'show-score is soft-fail (SPA shells extract 0 normally)');
  const we = sourceExtractors('west-end').map((s) => s.name);
  assert.ok(we.includes('westendtheatre'), 'WE set unchanged');
  assert.ok(!we.includes('bww-roundup'), 'NYC sources not in the WE set');
  // default (legacy callers) stays West End
  assert.ok(sourceExtractors().map((s) => s.name).includes('westendtheatre'));
});

test('softFail source: present archive extracting 0 does NOT trip zeroExtract', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'census-soft-'));
  fs.mkdirSync(path.join(dir, 'good'));
  fs.mkdirSync(path.join(dir, 'soft'));
  fs.writeFileSync(path.join(dir, 'good', 'show-s.html'), '<html>ok</html>');
  fs.writeFileSync(path.join(dir, 'soft', 'show-s.html'), '<html>spa shell</html>');
  const sources = [
    { name: 'good', dir: 'good', fn: () => [{ outletId: 'nytimes', outlet: 'NYT', critic: 'A', url: 'u' }] },
    { name: 'soft', dir: 'soft', softFail: true, fn: () => [] },
  ];
  const c = buildCensusFromArchives('show-s', { archiveDir: dir, sources });
  assert.deepEqual(c.archivesPresent.sort(), ['good', 'soft']);
  assert.deepEqual(c.zeroExtract, [], 'soft-fail source present-but-0 is NOT flagged broken');
  assert.equal(c.count, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fail-open: an unverifiable zero-token title (2:22) is NOT rejected as wrong-show', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'census-222-'));
  fs.mkdirSync(path.join(dir, 'theatre-reviews'));
  // titleTokens('2:22') === [] → verifyAggregatorUrl returns no-significant-title-tokens.
  // That's "can't judge", not "wrong show" — the real roundup must survive.
  fs.writeFileSync(path.join(dir, 'theatre-reviews', '222-west-end-2026.html'),
    '<html><head><title>Theatre reviews roundup: 2:22 A Ghost Story</title></head><body>⭑⭑⭑⭑</body></html>');
  const sources = [{ name: 'theatre-reviews', dir: 'theatre-reviews', validate: true,
    fn: () => ([{ outletId: 'guardian', outlet: 'The Guardian', critic: 'A', url: 'https://x/222-review' }]) }];
  const census = buildCensusFromArchives('222-west-end-2026', {
    archiveDir: dir, sources, show: { title: '2:22' } });
  assert.equal(census.count, 1, 'unverifiable title fails OPEN — roundup kept');
  assert.equal(census.wrongRoundup.length, 0, 'not flagged wrong-show');
});

// ─── B1: standingOutlets pseudo-source ───────────────────────────────────────

test('standingOutlets pseudo-source only activates when opts.outlets is passed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'census-standing-'));
  const outlets = { nytimes: { displayName: 'The New York Times', standingCoverage: true, standingMarkets: ['broadway'] } };
  // No archives at all — without outlets, a show with zero roundups has no census.
  const noOutlets = buildCensusFromArchives('show-no-roundup', { archiveDir: dir, market: 'broadway' });
  assert.equal(noOutlets.hadAnySource, false);
  // With outlets passed, the standing outlet itself becomes the census — silence
  // is now visible instead of collapsing to "no-census-yet".
  const withOutlets = buildCensusFromArchives('show-no-roundup', { archiveDir: dir, market: 'broadway', outlets });
  assert.equal(withOutlets.hadAnySource, true);
  assert.equal(withOutlets.count, 1);
  assert.equal(withOutlets.entries[0].outletId, 'nytimes');
  assert.deepEqual(withOutlets.sourcesPresent, ['standing-outlets']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('standingOutlets pseudo-source unions with real archive sources (dedup by outlet)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'census-standing-union-'));
  fs.mkdirSync(path.join(dir, 'bww-roundups'));
  // A real BWW roundup already names nytimes (with a real critic + URL) plus one
  // other outlet the standing list doesn't know about.
  fs.writeFileSync(path.join(dir, 'bww-roundups', 'show-x.html'), `<html><head></head><body>
    <script type="application/ld+json">{"@type":"BlogPosting","author":{"name":"The New York Times - Jesse Green"},"url":"https://nytimes.com/r"}</script>
    <script type="application/ld+json">{"@type":"BlogPosting","author":{"name":"Vulture"},"url":"https://vulture.com/r"}</script>
  </body></html>`);
  const outlets = {
    nytimes: { displayName: 'The New York Times', standingCoverage: true, standingMarkets: ['broadway'] },
    nypost: { displayName: 'New York Post', standingCoverage: true, standingMarkets: ['broadway'] },
  };
  const sources = [{ name: 'bww-roundup', dir: 'bww-roundups', fn: (html, id) => {
    const { parseBwwRoundup } = require('./review-census.js');
    return parseBwwRoundup(html, id);
  }}];
  const census = buildCensusFromArchives('show-x', { archiveDir: dir, market: 'broadway', outlets, sources });
  // 3 total: nytimes (real critic wins over the pseudo-source's 'Unknown'), vulture, nypost (standing-only).
  assert.equal(census.count, 3);
  const nyt = census.entries.find((e) => e.outletId === 'nytimes');
  assert.equal(nyt.critic, 'Jesse Green', 'real critic from the archive beats the pseudo-source Unknown');
  assert.ok(nyt.sources.includes('bww-roundup') && nyt.sources.includes('standing-outlets'), 'both sources merged');
  const nypost = census.entries.find((e) => e.outletId === 'nypost');
  assert.deepEqual(nypost.sources, ['standing-outlets'], 'nypost is standing-only — no roundup names it');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('standingOutlets pseudo-source respects market scoping (west-end outlet does not leak into broadway)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'census-standing-market-'));
  const outlets = { timeout: { displayName: 'Time Out', standingCoverage: true, standingMarkets: ['west-end'] } };
  const census = buildCensusFromArchives('show-bway', { archiveDir: dir, market: 'broadway', outlets });
  assert.equal(census.hadAnySource, false, 'west-end-only standing outlet must not apply to a broadway show');
  fs.rmSync(dir, { recursive: true, force: true });
});
