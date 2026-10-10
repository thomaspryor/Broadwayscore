// rename-show-id (2026 data audit, S5-T6 + S5-T8).
//
// Builds a temp copy of a minimal three-tree fixture (web data/ + public/,
// core-data, review-texts as a git repo) holding a fixture id in every
// registered shape, runs planShowIdRename (must not write) and
// applyShowIdRename against the copies, then asserts `grep -rl <old-id>`
// over the copies returns only the aliases / redirect entries. Requires the
// real modules (CLAUDE.md §15) — never touches data/ or the private repos.
//
// Run: node --test tests/unit/rename-show-id.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SHOW_ID_KEYED_FILES, validateRegistry } = require('../../scripts/lib/show-id-keyed-files.js');
const {
  planShowIdRename, applyShowIdRename, buildSqlMigration, formatPlan,
  SUPABASE_SHOW_ID_TABLES, yearlessSlug,
} = require('../../scripts/lib/show-id-rename.js');

const OLD = 'fixture-musical-2026';
const NEW = 'fixture-musical-2027';
const OTHER = 'other-play-2024';
const RETIRED = 'retired-junk-2025';

function writeJson(file, doc, { minified = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, minified ? JSON.stringify(doc) : JSON.stringify(doc, null, 2) + '\n');
}

function git(cwd, args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Three trees under one temp dir. `slug` controls the show row's slug: equal
 * to the id (slug-keyed files then change too) or year-less (they do not).
 */
function buildFixture({ slug = OLD } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rename-show-id-'));
  const web = path.join(base, 'web');
  const core = path.join(base, 'core-data');
  const rt = path.join(base, 'review-texts');
  const D = (p) => path.join(web, 'data', p);
  const P = (p) => path.join(web, 'public', p);
  const C = (p) => path.join(core, p);

  // --- core-data
  writeJson(C('shows.json'), {
    _meta: { lastUpdated: '2026-09-01T00:00:00.000Z', totalShows: 2 },
    shows: [
      { id: OLD, title: 'Fixture Musical', slug, venue: 'Fixture Theatre', openingDate: '2027-03-01', status: 'upcoming',
        images: { hero: `/images/shows/${OLD}/hero.webp`, thumbnail: `/images/shows/${OLD}/thumbnail.webp` } },
      { id: OTHER, title: 'Other Play', slug: OTHER, venue: 'Other House', openingDate: '2024-05-01', status: 'closed',
        originalProductionId: OLD, transferOf: OLD, tourOf: OLD, priorRuns: [{ id: OLD, venue: 'Tryout' }] },
    ],
  });
  writeJson(C('reviews.json'), { _meta: {}, reviews: [{ showId: OLD, outletId: 'nytimes', assignedScore: 80 }, { showId: OTHER, outletId: 'variety', assignedScore: 60 }] });
  writeJson(C('audience-buzz.json'), { _meta: {}, shows: { [OLD]: { combinedScore: 90 }, [OTHER]: { combinedScore: 70 } }, lastUpdated: 'x' });
  writeJson(C('audience-reviews-lbo.json'), { [OLD]: { count: 1 } });
  writeJson(C('awards.json'), { _meta: {}, shows: { [OLD]: { tony: {} } } });
  writeJson(C('commercial.json'), { _meta: {}, shows: { [slug]: { recouped: false }, [OTHER]: { recouped: true } }, modelLastRun: 'x' });
  writeJson(C('critic-consensus.json'), { _meta: {}, shows: { [OLD]: { text: 'ok' } } });
  writeJson(C('grosses.json'), { lastUpdated: 'x', weekEnding: 'x', shows: { [slug]: { allTime: { gross: 1 } } } });
  writeJson(C('grosses-history.json'), { _meta: {}, weeks: { '2026-03-22': { [slug]: { gross: 1 }, [OTHER]: { gross: 2 } } } });
  writeJson(C('opening-night-sent.json'), { shows: { [OLD]: { sentAt: 'x' }, [`broadway:${OLD}`]: { sentAt: 'x' }, [`overdue-alert:${OLD}`]: { sentAt: 'x' }, [`preview:broadway:${OLD}:2027-03-01`]: { sentAt: 'x' }, [`preview:broadway:${OTHER}:2024-05-01`]: { sentAt: 'x' } } });
  writeJson(C('followers.json'), { _meta: {}, followers: { [OLD]: ['a@example.com'] } });
  writeJson(C('diary-shows.json'), { shows: [{ id: 'newsies-us-regional-abc', slug: 'newsies-us-regional-abc', title: 'Newsies' }], lastUpdated: 'x' });
  writeJson(C('audience-history/2026-09-28.json'), { _meta: {}, shows: { [OLD]: { combinedScore: 90 } } });
  writeJson(C('data/audience-reviews/show-score/' + OLD + '.json'), { showId: OLD, reviews: [] });
  writeJson(C('retired-show-ids.json'), [{ id: RETIRED, reason: 'junk', retiredAt: '2026-01-01T00:00:00.000Z', title: null, venue: null }]);
  writeJson(C('deleted-shows.json'), [{ id: RETIRED, title: 'Junk' }]);

  // --- web data/
  writeJson(D('dtli-slug-map.json'), { _meta: {}, shows: { [OLD]: 'fixture-musical', [OTHER]: 'other-play' }, updated: 'x' });
  writeJson(D('show-score-urls.json'), { _meta: {}, shows: { [OLD]: 'https://example.com/ss' }, _discoveryAttempts: { [OLD]: '2026-09-20' } });
  writeJson(D('image-sources.json'), { [OLD]: { hero: 'x' }, [OTHER]: { hero: 'y' } });
  writeJson(D('related-shows.json'), { _meta: {}, shows: { [OLD]: { relatedIds: [OTHER], relatedOpenIds: [] }, [OTHER]: { relatedIds: [OLD], relatedOpenIds: [OLD] } } });
  writeJson(D('gold-lists-computed.json'), { _meta: {}, seasons: [], lists: { 'critical-gold': { '2026-2027': [{ showId: OLD, slug, rank: 1, thumbnail: `/images/shows/${OLD}/thumbnail.webp` }] } }, memberships: { [OLD]: [{ listType: 'critical-gold' }] } });
  writeJson(D('tony-critic-picks.json'), { _meta: {}, sources: [], picks: { 'Best Musical': { nyt: OLD, variety: OTHER } }, shouldPicks: { 'Best Musical': { nyt: OLD } } });
  writeJson(D('tony-nominations.json'), { _meta: {}, nominations: [{ season: '2026-27', showId: OLD, category: 'Best Musical', won: false }] });
  writeJson(D('audience.json'), { _meta: {}, audience: [{ showId: OLD, platform: 'showscore' }] });
  writeJson(D('llm-scoring-runs.json'), [{ runId: 'r1', validation: [{ showId: OLD, hasDisagreement: false }] }, { runId: 'r2' }]);
  writeJson(D('commercial-pending-review.json'), { generatedAt: 'x', shows: { [slug]: { field: 'x' } } });
  writeJson(D('curated-images.json'), { _meta: {}, images: { [slug]: { square: 'x' } } });
  writeJson(D('digest-important-shows.json'), { _meta: {}, showIds: [OLD, OTHER] });
  writeJson(D('audience-snapshots/2026-27-as-of-2026-09-28.json'), { _meta: {}, shows: { [OLD]: { combinedScore: 90 } } });
  writeJson(D('slug-redirects.json'), { _meta: {}, redirects: { [yearlessSlug(OLD)]: { target: slug, permanent: true }, ...(slug === OLD ? {} : { [OLD]: { target: slug, permanent: true } }) } });
  writeJson(D('video-reviews.json'), { _meta: { note: 'x' }, [OLD]: [{ creatorName: 'c', score: 90 }] });
  writeJson(D('bww-roundup-urls.json'), { _comment: 'x', [OLD]: 'https://example.com/roundup' });
  writeJson(D(`cast/${OLD}.json`), { showId: OLD, openingNightCast: [] });
  writeJson(D(`llm-scores/${OLD}/nytimes--critic.json`), { showId: OLD, outletId: 'nytimes', score: 80 });
  fs.mkdirSync(D('opening-night-timeline'), { recursive: true });
  fs.writeFileSync(D(`opening-night-timeline/${OLD}.jsonl`), `{"t":"2026-05-12T08:49:41.471Z","rc":1}\n{"t":"2026-05-13T00:00:00.000Z","rc":2,"showId":"${OLD}"}\n`);
  writeJson(D(`social-pulse/${OLD}.json`), { _v: 3, showId: OLD, tier: 'Hidden' });
  writeJson(D(`collection-state/serp-last-run-${OLD}.json`), { at: 'x' });
  writeJson(D(`audit/orphan-unscored-${OLD}.json`), { showId: OLD, orphans: [] });
  writeJson(D('unregistered-map.json'), { [OLD]: { note: 'not in the registry — the residual scan must report me' } });

  // --- web public/
  writeJson(P(`data/shows/${OLD}.json`), { id: OLD, t: 'Fixture Musical', hi: `/images/shows/${OLD}/hero.webp` }, { minified: true });
  writeJson(P(`data/shows/${OLD}.social.json`), { _v: 3, t: 'Hidden' }, { minified: true });
  writeJson(P('data/search-shows.json'), [{ id: OLD, title: 'Fixture Musical', slug, images: { thumbnail: `/images/shows/${OLD}/thumbnail.webp` } }]);
  fs.mkdirSync(P(`images/shows/${OLD}`), { recursive: true });
  fs.writeFileSync(P(`images/shows/${OLD}/hero.webp`), Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00]));

  // --- review-texts (git repo, so the dir move exercises `git mv`)
  writeJson(path.join(rt, OLD, 'nytimes--jesse-green.json'), { showId: OLD, outletId: 'nytimes', criticName: 'Jesse Green', url: 'https://example.com/review', publishDate: '2027-03-02', fullText: 'A fine show, reviewed at length for the fixture.', archivePath: `data/archives/reviews/${OLD}/nytimes--jesse-green_2027-03-02.html` });
  writeJson(path.join(rt, OLD, 'variety--locked.json'), { showId: OLD, outletId: 'variety', criticName: 'Locked Critic', url: 'https://example.com/locked', publishDate: '2027-03-03', fullText: 'Locked review text for the fixture.', _locked: true });
  writeJson(path.join(rt, '_pending', OLD, 'guardian--pending.json'), { showId: OLD, outletId: 'guardian', criticName: 'Pending Critic', url: 'https://example.com/pending', publishDate: '2027-03-04', pendingReason: 'date_implausible' });
  writeJson(path.join(rt, '_superseded-misattributed', `${OLD}--dupe-standard--nick-curtis.json`), { showId: OLD, outletId: 'standard', criticName: 'Nick Curtis', url: 'https://example.com/superseded' });
  writeJson(path.join(rt, OTHER, 'variety--critic.json'), { showId: OTHER, outletId: 'variety', criticName: 'Some Critic', url: 'https://example.com/other', publishDate: '2024-05-02' });
  writeJson(path.join(rt, 'failed-fetches.json'), [{ reviewId: `${OLD}/nytimes--jesse-green.json`, showId: OLD, outlet: 'NYT', failureReason: 'x', archivePath: `data/archives/reviews/${OLD}/nytimes--jesse-green_2027-03-02.html` }, { reviewId: `${OTHER}/variety--critic.json`, showId: OTHER }]);
  fs.mkdirSync(path.join(rt, 'aggregator-archive', 'dtli'), { recursive: true });
  fs.writeFileSync(path.join(rt, 'aggregator-archive', 'dtli', `${OLD}.html`), '<html>dtli capture</html>\n');
  writeJson(path.join(rt, 'aggregator-archive', 'dtli', '_not-found.json'), { [OLD]: '2026-03-07', [OTHER]: '2024-01-01' });
  fs.mkdirSync(path.join(rt, 'aggregator-archive', 'show-score'), { recursive: true });
  fs.writeFileSync(path.join(rt, 'aggregator-archive', 'show-score', `${OLD}.html.mismatch`), '<html>mismatch</html>\n');
  writeJson(path.join(rt, 'aggregator-archive', 'nysr', 'api-page-1.json'), { page: 1, items: [] });
  git(rt, ['init', '-q']);
  git(rt, ['add', '-A']);
  git(rt, ['commit', '-q', '-m', 'init']);

  return { base, web, core, rt, trees: { web, coreData: core, reviewTexts: rt, scanCode: false } };
}

function hashTree(root) {
  const h = crypto.createHash('sha256');
  const walk = (d) => {
    for (const f of fs.readdirSync(d).sort()) {
      if (f === '.git') continue;
      const p = path.join(d, f);
      const st = fs.lstatSync(p);
      h.update(path.relative(root, p));
      if (st.isDirectory()) walk(p); else h.update(fs.readFileSync(p));
    }
  };
  walk(root);
  return h.digest('hex');
}

function grepFiles(needle, dirs) {
  const r = spawnSync('grep', ['-rlF', '--exclude-dir=.git', '--', needle, ...dirs], { encoding: 'utf8' });
  assert.ok(r.status === 0 || r.status === 1, `grep failed: ${r.stderr}`);
  return r.stdout.split('\n').filter(Boolean).sort();
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

test('registry is well-formed and covers the three repos', () => {
  assert.deepEqual(validateRegistry(), []);
  const repos = new Set(SHOW_ID_KEYED_FILES.map((e) => e.repo));
  assert.deepEqual([...repos].sort(), ['core-data', 'review-texts', 'web']);
  const shows = SHOW_ID_KEYED_FILES.find((e) => e.repo === 'core-data' && e.path === 'shows.json');
  assert.equal(shows.writeGuard, 'shows');
  assert.equal(SHOW_ID_KEYED_FILES.find((e) => e.path === 'commercial.json').keyedBy, 'slug');
  assert.equal(SHOW_ID_KEYED_FILES.find((e) => e.path === 'opening-night-sent.json').keyStyle, 'colon-segments');
  assert.equal(SHOW_ID_KEYED_FILES.find((e) => e.path === 'data/slug-redirects.json').rewrite, false);
});

test('dry-run plan lists every key, ref and path and writes nothing', () => {
  const fx = buildFixture();
  try {
    const before = hashTree(fx.base);
    const plan = planShowIdRename(OLD, NEW, fx.trees);
    assert.equal(hashTree(fx.base), before, 'planning must not write');
    assert.equal(plan.ok, true, plan.refusals.join('; '));
    assert.equal(plan.resume, false);
    assert.equal(plan.slugChanged, true);
    assert.deepEqual(plan.aliases, [OLD, 'fixture-musical']);

    const byPath = new Map(plan.changes.map((c) => [c.path, c]));
    const showsChange = plan.changes.find((c) => c.isShowsJson);
    assert.ok(showsChange, 'shows.json is planned');
    assert.equal(plan.changes[0], showsChange, 'shows.json is first');
    assert.equal(showsChange.writeGuard, 'shows');
    const ops = showsChange.edits.map((e) => `${e.op} ${e.at}`);
    assert.ok(ops.includes('set-field shows[0].id'), ops.join('\n'));
    assert.ok(ops.includes('set-field shows[0].slug'));
    assert.ok(ops.includes('replace-path shows[0].images.hero'));
    assert.ok(ops.includes('replace-value shows[1].originalProductionId'));
    assert.ok(ops.includes('replace-value shows[1].transferOf'));
    assert.ok(ops.includes('replace-value shows[1].tourOf'), 'tourOf follows a rename whatever the parent category (BRO-4931)');
    assert.ok(ops.includes('replace-value shows[1].priorRuns[0].id'));
    assert.ok(ops.some((o) => o.startsWith('set-aliases')));

    assert.equal(byPath.get('core-data:commercial.json').writeGuard, 'commercial');
    assert.equal(byPath.get('core-data:audience-buzz.json').writeGuard, 'audience-buzz');
    assert.equal(byPath.get('core-data:opening-night-sent.json').counts.keys, 4, 'colon-segment keys');
    assert.equal(byPath.get('core-data:grosses-history.json').counts.keys, 1, 'slug-keyed week map');
    assert.equal(byPath.get('web:data/show-score-urls.json').counts.keys, 2, 'shows + _discoveryAttempts');
    assert.equal(byPath.get('web:data/related-shows.json').counts.keys, 1);
    assert.equal(byPath.get('web:data/related-shows.json').counts.refs, 2, 'relatedIds + relatedOpenIds');
    assert.equal(byPath.get('web:data/llm-scoring-runs.json').counts.fields, 1);
    assert.equal(byPath.get('web:data/tony-critic-picks.json').counts.refs, 2);
    assert.ok(byPath.has('web:data/audience-snapshots/2026-27-as-of-2026-09-28.json'), 'glob entry');
    assert.ok(byPath.has('core-data:audience-history/2026-09-28.json'));
    assert.ok(byPath.has('web:public/data/search-shows.json'));
    assert.ok(!byPath.has('web:data/slug-redirects.json'), 'redirects are regenerated, never rewritten');
    assert.ok(!plan.changes.some((c) => /retired-show-ids|deleted-shows/.test(c.path)), 'retirement registry untouched');
    assert.ok(plan.skipped.some((s) => s.path === 'web:data/slug-redirects.json' && s.regenerate === 'node scripts/build-slug-redirects.js'));

    const moves = new Map(plan.moves.map((m) => [m.path, m]));
    const rtMove = moves.get(`review-texts:${OLD}`);
    assert.ok(rtMove, [...moves.keys()].join('\n'));
    assert.equal(rtMove.method, 'git mv');
    assert.equal(rtMove.isDir, true);
    assert.equal(rtMove.inner.length, 2);
    assert.ok(rtMove.inner.some((i) => i.locked), '_locked file is flagged');
    assert.equal(moves.get(`review-texts:_pending/${OLD}`).method, 'git mv');
    assert.equal(moves.get(`review-texts:_superseded-misattributed/${OLD}--dupe-standard--nick-curtis.json`).toPath, `review-texts:_superseded-misattributed/${NEW}--dupe-standard--nick-curtis.json`);
    assert.equal(moves.get(`web:data/cast/${OLD}.json`).method, 'rename', 'untracked path → plain rename');
    assert.equal(moves.get(`web:data/llm-scores/${OLD}`).inner[0].edits[0].at, 'showId');
    assert.ok(moves.get(`web:data/opening-night-timeline/${OLD}.jsonl`).inner[0].jsonl);
    assert.ok(moves.has(`web:public/images/shows/${OLD}`));
    assert.ok(moves.has(`web:public/data/shows/${OLD}.json`));
    assert.ok(moves.has(`web:public/data/shows/${OLD}.social.json`));
    assert.ok(moves.has(`web:data/collection-state/serp-last-run-${OLD}.json`));
    assert.ok(moves.has(`core-data:data/audience-reviews/show-score/${OLD}.json`));

    assert.equal(moves.get(`review-texts:aggregator-archive/dtli/${OLD}.html`).toPath, `review-texts:aggregator-archive/dtli/${NEW}.html`);
    assert.equal(moves.get(`review-texts:aggregator-archive/show-score/${OLD}.html.mismatch`).toPath, `review-texts:aggregator-archive/show-score/${NEW}.html.mismatch`);
    assert.equal(byPath.get('review-texts:aggregator-archive/dtli/_not-found.json').counts.keys, 1);
    const ff = byPath.get('review-texts:failed-fetches.json');
    assert.equal(ff.counts.fields, 1);
    assert.equal(ff.counts.paths, 1, 'reviewId <id>/<file> prefix follows the dir move');
    assert.ok(ff.edits.some((e) => e.op === 'replace-prefix' && e.to === `${NEW}/nytimes--jesse-green.json`));

    // The residual scan reports the unregistered map and the two archivePaths — nothing else
    // (the redirect file is listed under "regenerate", asserted above).
    const residual = plan.residual.map((r) => r.path).sort();
    assert.deepEqual(residual, [
      'review-texts:failed-fetches.json',
      `review-texts:${NEW}/nytimes--jesse-green.json`,
      'web:data/unregistered-map.json',
    ].sort(), residual.join('\n'));
    assert.equal(plan.residual.find((r) => r.path === 'web:data/unregistered-map.json').hits[0].kind, 'key');

    // SQL: one UPDATE per confirmed show_id table, nothing else guessed.
    for (const t of SUPABASE_SHOW_ID_TABLES) {
      assert.ok(plan.sql.statements.includes(`UPDATE ${t.table} SET ${t.column} = '${NEW}' WHERE ${t.column} = '${OLD}';`));
    }
    assert.equal(plan.sql.statements.length, 4);
    assert.ok(!plan.sql.text.includes('UPDATE unmatched_imports'));
    assert.ok(plan.sql.text.includes('resolved_show_id = diary-shows.json id'));
    const text = formatPlan(plan);
    assert.ok(text.includes('git mv: review-texts:' + OLD));
    assert.ok(text.includes('summary:'));
  } finally { fs.rmSync(fx.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('apply renames everything; grep over the copies finds only aliases and redirects', () => {
  const fx = buildFixture();
  try {
    const plan = planShowIdRename(OLD, NEW, fx.trees);
    assert.equal(plan.ok, true, plan.refusals.join('; '));
    const result = applyShowIdRename(plan);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.rewritten.length, plan.changes.length);
    assert.equal(result.moved.length, plan.moves.length);

    const left = grepFiles(OLD, [fx.web, fx.core, fx.rt]);
    assert.deepEqual(left, [
      path.join(fx.core, 'shows.json'),
      path.join(fx.rt, NEW, 'nytimes--jesse-green.json'),
      path.join(fx.rt, 'failed-fetches.json'),
      path.join(fx.web, 'data', 'slug-redirects.json'),
      path.join(fx.web, 'data', 'unregistered-map.json'),
    ].sort(), left.join('\n'));
    // review-texts extras: archive captures move, _not-found keys and reviewIds follow, archivePath stays
    assert.ok(fs.existsSync(path.join(fx.rt, 'aggregator-archive', 'dtli', `${NEW}.html`)));
    assert.ok(fs.existsSync(path.join(fx.rt, 'aggregator-archive', 'show-score', `${NEW}.html.mismatch`)));
    assert.deepEqual(Object.keys(readJson(path.join(fx.rt, 'aggregator-archive', 'dtli', '_not-found.json'))), [NEW, OTHER]);
    const ff = readJson(path.join(fx.rt, 'failed-fetches.json'));
    assert.equal(ff[0].showId, NEW);
    assert.equal(ff[0].reviewId, `${NEW}/nytimes--jesse-green.json`);
    assert.ok(ff[0].archivePath.includes(OLD), 'archivePath into the archives repo is left alone');
    assert.equal(ff[1].reviewId, `${OTHER}/variety--critic.json`);
    // shows.json: the old id survives ONLY inside aliases.
    const shows = readJson(path.join(fx.core, 'shows.json'));
    const row = shows.shows.find((s) => s.id === NEW);
    assert.ok(row);
    assert.equal(row.slug, NEW);
    assert.deepEqual(row.aliases, [OLD, 'fixture-musical']);
    assert.equal(row.images.hero, `/images/shows/${NEW}/hero.webp`);
    assert.equal(shows._meta.totalShows, 2, 'shows-write-guard stamped _meta');
    const stripped = shows.shows.map(({ aliases, ...rest }) => rest);
    assert.ok(!JSON.stringify(stripped).includes(OLD), 'old id only in aliases');
    assert.equal(shows.shows[1].originalProductionId, NEW);
    assert.equal(shows.shows[1].tourOf, NEW);
    assert.equal(shows.shows[1].priorRuns[0].id, NEW);
    assert.equal(shows.shows[0].id, NEW, 'row keeps its position');
    // the one review-texts leftover is the archivePath into the (untouched) aggregator-archive repo
    const review = readJson(path.join(fx.rt, NEW, 'nytimes--jesse-green.json'));
    assert.equal(review.showId, NEW);
    assert.ok(review.archivePath.includes(OLD));
    assert.equal(review.fullText, 'A fine show, reviewed at length for the fixture.');
    const locked = readJson(path.join(fx.rt, NEW, 'variety--locked.json'));
    assert.equal(locked.showId, NEW, '_locked file re-stamped');
    assert.equal(locked._locked, true);
    assert.equal(readJson(path.join(fx.rt, '_pending', NEW, 'guardian--pending.json')).showId, NEW);
    assert.equal(readJson(path.join(fx.rt, '_superseded-misattributed', `${NEW}--dupe-standard--nick-curtis.json`)).showId, NEW);
    assert.ok(!fs.existsSync(path.join(fx.rt, OLD)));
    const staged = git(fx.rt, ['ls-files', '--', NEW, 'aggregator-archive']);
    assert.ok(staged.includes(`${NEW}/nytimes--jesse-green.json`), 'git mv staged the move');
    assert.ok(staged.includes(`aggregator-archive/dtli/${NEW}.html`), 'git mv staged the archive capture');
    assert.ok(!git(fx.rt, ['ls-files']).includes(`${OLD}/`));
    assert.ok(!git(fx.rt, ['ls-files']).includes(`/${OLD}.html`));

    // web + core files
    assert.equal(readJson(path.join(fx.web, 'data', `cast/${NEW}.json`)).showId, NEW);
    assert.equal(readJson(path.join(fx.web, 'data', `llm-scores/${NEW}/nytimes--critic.json`)).showId, NEW);
    assert.equal(readJson(path.join(fx.web, 'data', `social-pulse/${NEW}.json`)).showId, NEW);
    assert.ok(fs.existsSync(path.join(fx.web, 'data', `collection-state/serp-last-run-${NEW}.json`)));
    assert.ok(fs.existsSync(path.join(fx.web, 'public', `images/shows/${NEW}/hero.webp`)));
    const timeline = fs.readFileSync(path.join(fx.web, 'data', `opening-night-timeline/${NEW}.jsonl`), 'utf8');
    assert.ok(timeline.includes(`"showId":"${NEW}"`));
    assert.equal(timeline.split('\n')[0], '{"t":"2026-05-12T08:49:41.471Z","rc":1}', 'untouched jsonl lines stay verbatim');
    const slim = fs.readFileSync(path.join(fx.web, 'public', `data/shows/${NEW}.json`), 'utf8');
    assert.ok(!slim.includes('\n'), 'minified file stays minified');
    assert.equal(JSON.parse(slim).hi, `/images/shows/${NEW}/hero.webp`);
    const pretty = fs.readFileSync(path.join(fx.web, 'data', 'dtli-slug-map.json'), 'utf8');
    assert.ok(pretty.startsWith('{\n  "_meta"'), 'pretty file keeps its indent');
    assert.deepEqual(Object.keys(readJson(path.join(fx.web, 'data', 'dtli-slug-map.json')).shows), [NEW, OTHER], 'key order preserved');
    assert.deepEqual(Object.keys(readJson(path.join(fx.core, 'opening-night-sent.json')).shows), [NEW, `broadway:${NEW}`, `overdue-alert:${NEW}`, `preview:broadway:${NEW}:2027-03-01`, `preview:broadway:${OTHER}:2024-05-01`]);
    assert.deepEqual(Object.keys(readJson(path.join(fx.core, 'commercial.json')).shows), [NEW, OTHER], 'slug-keyed commercial follows the slug');
    assert.deepEqual(Object.keys(readJson(path.join(fx.core, 'grosses-history.json')).weeks['2026-03-22']), [NEW, OTHER]);
    assert.equal(readJson(path.join(fx.core, 'reviews.json')).reviews[0].showId, NEW);
    assert.deepEqual(readJson(path.join(fx.web, 'data', 'related-shows.json')).shows[OTHER].relatedIds, [NEW]);
    assert.equal(readJson(path.join(fx.web, 'data', 'tony-critic-picks.json')).picks['Best Musical'].nyt, NEW);
    assert.equal(readJson(path.join(fx.web, 'data', 'llm-scoring-runs.json'))[0].validation[0].showId, NEW);
    assert.deepEqual(readJson(path.join(fx.web, 'data', 'digest-important-shows.json')).showIds, [NEW, OTHER]);
    assert.equal(readJson(path.join(fx.web, 'data', 'gold-lists-computed.json')).lists['critical-gold']['2026-2027'][0].thumbnail, `/images/shows/${NEW}/thumbnail.webp`);
    assert.equal(readJson(path.join(fx.web, 'public', 'data/search-shows.json'))[0].images.thumbnail, `/images/shows/${NEW}/thumbnail.webp`);
    // retirement registry + archive untouched, nothing retired
    assert.deepEqual(readJson(path.join(fx.core, 'retired-show-ids.json')).map((e) => e.id), [RETIRED]);
    assert.equal(readJson(path.join(fx.core, 'deleted-shows.json')).length, 1);

    // Re-planning after a full apply is a no-op resume, not a refusal.
    const again = planShowIdRename(OLD, NEW, fx.trees);
    assert.equal(again.ok, true, again.refusals.join('; '));
    assert.equal(again.resume, true);
    assert.equal(again.changes.length, 0);
    assert.equal(again.moves.length, 0);
  } finally { fs.rmSync(fx.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('year-less slug: slug-keyed files are left alone and the alias set still carries the year-less slug', () => {
  const fx = buildFixture({ slug: 'fixture-musical' });
  try {
    const plan = planShowIdRename(OLD, NEW, fx.trees);
    assert.equal(plan.ok, true, plan.refusals.join('; '));
    assert.equal(plan.slugChanged, false);
    assert.deepEqual(plan.aliases, [OLD]);
    const paths = plan.changes.map((c) => c.path);
    for (const p of ['core-data:commercial.json', 'core-data:grosses.json', 'core-data:grosses-history.json', 'web:data/commercial-pending-review.json', 'web:data/curated-images.json']) {
      assert.ok(!paths.includes(p), `${p} must not change when the slug is unchanged`);
    }
    applyShowIdRename(plan);
    const row = readJson(path.join(fx.core, 'shows.json')).shows[0];
    assert.equal(row.id, NEW);
    assert.equal(row.slug, 'fixture-musical');
    assert.deepEqual(row.aliases, [OLD]);
    assert.deepEqual(Object.keys(readJson(path.join(fx.core, 'commercial.json')).shows), ['fixture-musical', OTHER]);
  } finally { fs.rmSync(fx.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('refusals: target exists, old id missing, retired target, slug/alias clash, path collision, bad ids', () => {
  const fx = buildFixture();
  try {
    let plan = planShowIdRename(OLD, OTHER, fx.trees);
    assert.equal(plan.ok, false);
    assert.ok(plan.refusals.some((r) => r.includes(`target id ${OTHER} already exists in shows.json`)), plan.refusals.join('\n'));
    assert.throws(() => applyShowIdRename(plan), /refusing to apply/);

    plan = planShowIdRename('never-existed-2020', NEW, fx.trees);
    assert.equal(plan.ok, false);
    assert.ok(plan.refusals.some((r) => r.includes('never-existed-2020 is not in')));
    assert.equal(plan.changes.length, 0);

    plan = planShowIdRename(OLD, RETIRED, fx.trees);
    assert.equal(plan.ok, false);
    assert.ok(plan.refusals.some((r) => r.includes('is retired')));

    // slug of another show / alias of another show
    const showsPath = path.join(fx.core, 'shows.json');
    const shows = readJson(showsPath);
    shows.shows[1].aliases = ['some-old-alias-2020'];
    writeJson(showsPath, shows);
    plan = planShowIdRename(OLD, 'some-old-alias-2020', fx.trees);
    assert.ok(plan.refusals.some((r) => r.includes('already an alias of')));

    // an id-named path already present for the target refuses too
    fs.mkdirSync(path.join(fx.rt, NEW), { recursive: true });
    plan = planShowIdRename(OLD, NEW, fx.trees);
    assert.equal(plan.ok, false);
    assert.ok(plan.refusals.some((r) => r.includes(`review-texts:${NEW} already exists`)), plan.refusals.join('\n'));
    fs.rmSync(path.join(fx.rt, NEW), { recursive: true });

    // a registered map already holding the target key refuses (a merge is not a rename)
    const dtli = path.join(fx.web, 'data', 'dtli-slug-map.json');
    const d = readJson(dtli); d.shows[NEW] = 'clash'; writeJson(dtli, d);
    plan = planShowIdRename(OLD, NEW, fx.trees);
    assert.ok(plan.refusals.some((r) => r.includes('dtli-slug-map.json') && r.includes('already exists')), plan.refusals.join('\n'));
    delete d.shows[NEW]; writeJson(dtli, d);

    for (const [a, b] of [['Evita-2026', NEW], [OLD, 'bad id'], [OLD, OLD], ['', NEW]]) {
      const p = planShowIdRename(a, b, fx.trees);
      assert.equal(p.ok, false, `${a} -> ${b}`);
    }
    // never touches a tree it was not pointed at: no review-texts → its entries are skipped, not guessed
    const noRt = planShowIdRename(OLD, NEW, { web: fx.web, coreData: fx.core, reviewTexts: null, scanCode: false });
    assert.equal(noRt.ok, true, noRt.refusals.join('; '));
    assert.ok(!noRt.moves.some((m) => m.repo === 'review-texts'));
    assert.ok(noRt.skipped.some((s) => s.path.startsWith('review-texts:') && s.reason === 'review-texts tree not given'));
    // no core-data and no mirror → shows.json refusal names the fix
    const noCore = planShowIdRename(OLD, NEW, { web: fx.web, coreData: null, reviewTexts: fx.rt, scanCode: false });
    assert.equal(noCore.ok, false);
    assert.ok(noCore.refusals[0].includes('shows.json not found'));
  } finally { fs.rmSync(fx.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('buildSqlMigration emits one UPDATE per confirmed show_id table and documents the rest', () => {
  const sql = buildSqlMigration("it's-2026", 'its-2027');
  assert.deepEqual(sql.statements, [
    "UPDATE reviews SET show_id = 'its-2027' WHERE show_id = 'it''s-2026';",
    "UPDATE watchlist SET show_id = 'its-2027' WHERE show_id = 'it''s-2026';",
    "UPDATE list_items SET show_id = 'its-2027' WHERE show_id = 'it''s-2026';",
    "UPDATE seen_unrated SET show_id = 'its-2027' WHERE show_id = 'it''s-2026';",
  ]);
  assert.ok(sql.text.startsWith('-- Supabase migration'));
  assert.ok(sql.text.includes('BEGIN;') && sql.text.includes('COMMIT;'));
  assert.ok(sql.text.includes('fantasy_entries.picks'));
  assert.ok(sql.text.includes('push_tokens'));
  assert.equal(sql.jsonbStatements.length, 2);
  assert.ok(sql.jsonbStatements.every((s) => sql.text.includes(`-- ${s}`)), 'jsonb rewrites are commented, never live');
});
