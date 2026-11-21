// LIVE-DATA-LANE: reads data/shows.json (untracked core data). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { classifyRelativeUrl } = require('./relative-review-url.js');
const { scan, main } = require('./audit-relative-review-urls.js');

test('classifier: absolute and empty urls are fine', () => {
  assert.equal(classifyRelativeUrl('https://www.nytimes.com/x', 'nytimes').category, 'ok');
  assert.equal(classifyRelativeUrl('', 'nytimes').category, 'ok');
  assert.equal(classifyRelativeUrl(undefined, 'nytimes').category, 'ok');
});

test('classifier: BroadwayWorld relatives get the host, other outlets do not', () => {
  assert.deepEqual(classifyRelativeUrl('/chicago/article/BWW-Review-X', 'broadwayworld'), { category: 'bww-relative', fixedUrl: 'https://www.broadwayworld.com/chicago/article/BWW-Review-X' });
  assert.equal(classifyRelativeUrl('/article/Review-Y', 'broadwayworld').fixedUrl, 'https://www.broadwayworld.com/article/Review-Y');
  assert.equal(classifyRelativeUrl('/article/Review-Y', 'nypost').category, 'other');
});

test('classifier: typos and schemeless hosts repair, profile and saved-page paths do not', () => {
  assert.equal(classifyRelativeUrl('hhttp://abcnews.go.com/a', 'ap').fixedUrl, 'http://abcnews.go.com/a');
  assert.equal(classifyRelativeUrl('ttps://nystagereview.com/a', 'nysr').fixedUrl, 'https://nystagereview.com/a');
  assert.equal(classifyRelativeUrl(' https://www.nytimes.com/a', 'nytimes').fixedUrl, 'https://www.nytimes.com/a');
  assert.equal(classifyRelativeUrl('www.vulture.com/2023/04/x.html', 'vulture').fixedUrl, 'https://www.vulture.com/2023/04/x.html');
  assert.equal(classifyRelativeUrl('variety.com/2023/legit/x', 'variety').category, 'schemeless');
  assert.equal(classifyRelativeUrl('/people/Ben-Brantley', 'nytimes').category, 'people');
  assert.equal(classifyRelativeUrl('../reviews/thurgood/nypostreview.html', 'nypost').category, 'dotdot');
  assert.equal(classifyRelativeUrl("There's enough energy in the first act", 'nypost').category, 'other');
});

test('audit scan: counts categories on a fixture tree and --strict fails on any', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-url-'));
  fs.mkdirSync(path.join(root, 'show-a'));
  fs.writeFileSync(path.join(root, 'show-a', 'ok.json'), JSON.stringify({ url: 'https://a.com/x', outletId: 'a' }));
  fs.writeFileSync(path.join(root, 'show-a', 'bww.json'), JSON.stringify({ url: '/article/Z', outletId: 'broadwayworld' }));
  const rows = scan(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fixedUrl, 'https://www.broadwayworld.com/article/Z');
  const log = console.log; console.log = () => {};
  try { assert.equal(main([`--root=${root}`, '--strict']), 1); } finally { console.log = log; }
  fs.rmSync(path.join(root, 'show-a', 'bww.json'));
  console.log = () => {};
  try { assert.equal(main([`--root=${root}`, '--strict']), 0); } finally { console.log = log; }
});

// BRO-5075: the approved-fix url repair. A malformed url written back as its own
// deterministic repair is the same article, so the url-change invariant must
// keep the score and flags, and the field edit must accept a real BWW review
// path that classifyReviewUrl would reject as aggregator nav.
test('invariant: a relative-to-absolute repair is not a url change; a different article still is', () => {
  const { urlCanonicallyChanged } = require('./url-change-invariant.js');
  const rel = '/chicago/article/BWW-Review-X-20240101';
  assert.equal(urlCanonicallyChanged(rel, `https://www.broadwayworld.com${rel}`), false);
  assert.equal(urlCanonicallyChanged('/article/Review-Y', 'https://www.broadwayworld.com/article/Review-Y'), false);
  assert.equal(urlCanonicallyChanged('hhttp://abcnews.go.com/a', 'http://abcnews.go.com/a'), false);
  assert.equal(urlCanonicallyChanged('www.vulture.com/2023/04/x.html', 'https://www.vulture.com/2023/04/x.html'), false);
  assert.equal(urlCanonicallyChanged(rel, 'https://www.broadwayworld.com/chicago/article/Other-20240101'), true);
  assert.equal(urlCanonicallyChanged('/people/Ben-Brantley/', 'https://www.nytimes.com/2020/01/01/theater/x-review.html'), true);
  // the BWW host is inferred only for a broadwayworld.com target
  assert.equal(urlCanonicallyChanged('/article/Review-Y', 'https://www.playbill.com/article/Review-Y'), true);
});

test('field edit: the deterministic repair is accepted, anything else on a relative url keeps the old rules', () => {
  const { applyReviewFieldEdit } = require('./review-field-edit.js');
  const stamp = { fixId: 'bro-5075', at: '2026-11-02T00:00:00Z' };
  const rel = '/article/BWW-Review-HAMILTON-Victoria-Palace-Theatre-20171221';
  const rec = { outletId: 'broadwayworld', outlet: 'BroadwayWorld', criticName: 'Marianka Swain', url: rel, assignedScore: 79 };
  const ok = applyReviewFieldEdit(rec, { field: 'url', oldValue: rel, newValue: `https://www.broadwayworld.com${rel}` }, stamp);
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(ok.record.url, `https://www.broadwayworld.com${rel}`);
  const typo = applyReviewFieldEdit({ outletId: 'nysr', url: 'ttps://nystagereview.com/2025/09/16/a/' }, { field: 'url', oldValue: 'ttps://nystagereview.com/2025/09/16/a/', newValue: 'https://nystagereview.com/2025/09/16/a/' }, stamp);
  assert.equal(typo.ok, true, typo.reason);
  // a different BWW path on the same relative file still faces the review-candidate check
  const other = applyReviewFieldEdit(rec, { field: 'url', oldValue: rel, newValue: 'https://www.broadwayworld.com/article/Some-Other-Page' }, stamp);
  assert.equal(other.ok, false);
});

test('field edit + real write guard: the repair keeps score and wrongProduction', async () => {
  process.env.EXCLUSION_LOGGER_AUDIT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-url-audit-'));
  const { executeReviewFieldEditIn } = require('./review-field-edit.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-url-exec-'));
  fs.mkdirSync(path.join(root, 'parade-2023'));
  const rel = '/cleveland/article/Review-PARADE-at-Connor-Palace-20250101';
  const file = 'parade-2023/broadwayworld--roy-berko.json';
  fs.writeFileSync(path.join(root, file), JSON.stringify({
    showId: 'parade-2023', outletId: 'broadwayworld', outlet: 'BroadwayWorld', criticName: 'Roy Berko', url: rel,
    assignedScore: 80, scoreSource: 'llm-v6', wrongProduction: true, wrongProductionReason: 'BWW regional/tour review (cleveland)',
  }, null, 2));
  const res = executeReviewFieldEditIn(root, { file, field: 'url', oldValue: rel, newValue: `https://www.broadwayworld.com${rel}` }, { fixId: 'bro-5075', at: '2026-11-02T00:00:00Z' });
  assert.equal(res.ok, true, res.reason);
  const after = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  assert.equal(after.url, `https://www.broadwayworld.com${rel}`);
  assert.equal(after.assignedScore, 80);
  assert.equal(after.wrongProduction, true);
  assert.equal(after._urlChangedClear, undefined);
});

// BRO-6981: a url glued to a copy of itself (NYSR Giulia, NYT Mrs. Warren's Profession).
test('classifier: a self-repeated url collapses to its first copy; urls that carry another url do not', () => {
  const g = 'https://nystagereview.com/2026/07/10/giulia-x/';
  assert.deepEqual(classifyRelativeUrl(`${g}${g}`, 'nysr'), { category: 'doubled', fixedUrl: g });
  const n = 'https://theater.nytimes.com/2010/10/04/theater/reviews/04mrs.html?ref=theater';
  assert.equal(classifyRelativeUrl(`${n}${n.replace('https', 'http')}http://`, 'nytimes').fixedUrl, n);
  assert.equal(classifyRelativeUrl('https://web.archive.org/web/20121108174124/http://www.villagevoice.com/2000-04-11/theater/x/', 'village-voice').category, 'ok');
  assert.equal(classifyRelativeUrl('http://online.wsj.com/articles/x-1403230337?mg=reno64-wsj&url=http://online.wsj.com/article/SB1000142405', 'wsj').category, 'ok');
  assert.equal(classifyRelativeUrl('https://bway.ly/04r8b#http://nypost.com/2016/09/29/x/', 'nypost').category, 'ok');
});

test('invariant: collapsing a self-repeated url keeps the article; another url is still a change', () => {
  const { urlCanonicallyChanged } = require('./url-change-invariant.js');
  const g = 'https://nystagereview.com/2026/07/10/giulia-x/';
  assert.equal(urlCanonicallyChanged(`${g}${g}`, g), false);
  assert.equal(urlCanonicallyChanged(`${g}${g}`, 'https://nystagereview.com/2026/07/10/other/'), true);
});
