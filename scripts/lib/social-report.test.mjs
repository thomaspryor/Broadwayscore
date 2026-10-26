// BRO-6377: Social section of the Monday traffic email.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildSocialReport, normalizeMetrics, attributeVisits, buildPostRows, monthlySuggestion, suggestedReply } = require('./social-report.js');
const { socialHtml, loadSocialSection } = require('./traffic-report-email.js');
const { writeLedger } = require('../social-autopost/run.js');

const NOW = Date.parse('2026-11-02T09:30:00Z'); // a first Monday of the month
const m = (o) => Object.entries(o).map(([type, value]) => ({ type, value }));
const ledger = {
  posts: [
    { type: 'score', date: '2026-11-01', showId: 'x', skipped: 'backlog at go-live' },
    {
      type: 'score', showId: 'invalid-2026', slug: 'the-imaginary-invalid', title: 'The Imaginary Invalid',
      text: "... a Critic Score of 67 (Worth Seeing) from 20 critics' reviews.",
      channels: { threads: { postId: 't1', link: 'https://threads/t1' }, instagram: { postId: 'i1' }, bluesky: { postId: 'b1' } },
    },
  ],
};
const buffer = [
  { id: 't1', service: 'threads', sentAt: '2026-10-30T17:00:00Z', text: 'x\nhttps://broadwayscorecard.com/show/the-imaginary-invalid?utm_source=threads', metrics: m({ views: 10, reactions: 1, comments: 2 }) },
  { id: 'i1', service: 'instagram', sentAt: '2026-10-30T17:00:00Z', externalLink: 'https://ig/i1', text: 'link in bio', metrics: m({ views: 50, reach: 20, reactions: 3, saves: 1 }) },
  { id: 'b1', service: 'bluesky', sentAt: '2026-10-30T17:00:00Z', text: 'x', metrics: m({ reactions: 0, comments: 0, reposts: 0 }) },
  { id: 'v1', service: 'youtube', sentAt: '2026-10-31T16:00:00Z', isVideo: true, text: "Here's how we score a show.", metrics: m({ views: 0 }) },
];

test('normalizeMetrics: views fall back to impressions; Bluesky has none', () => {
  assert.deepEqual(normalizeMetrics(m({ impressions: 7, clicks: 2, reactions: 1, shares: 1 })), { views: 7, interactions: 2, clicks: 2, comments: 0 });
  assert.equal(normalizeMetrics(m({ reactions: 0, reposts: 0 })).views, null);
});

test('lanes come from the ledger, hand-posted videos from the asset type', () => {
  const rows = buildPostRows(buffer, ledger);
  assert.deepEqual(rows.map((r) => r.lane), ['score', 'score', 'score', 'video']);
  assert.equal(rows[0].reviewCount, 20);
  assert.equal(rows[0].link, 'https://threads/t1');
});

test('a West End account set (ledger key service@set) still matches and keeps its link', () => {
  const we = { posts: [{ type: 'score', slug: 'x', title: 'X', channels: { 'threads@westend': { postId: 'w1', link: 'https://threads/w1' } } }] };
  const [row] = buildPostRows([{ id: 'w1', service: 'threads', sentAt: '2026-10-30T17:00:00Z', text: '', metrics: [] }], we);
  assert.equal(row.lane, 'score');
  assert.equal(row.link, 'https://threads/w1');
});

test('same-day visits count; Instagram gets clicks through the bio page; a visit before the post does not', () => {
  const rows = buildPostRows(buffer, ledger);
  const unmatched = attributeVisits(rows, {
    utmRows: [
      { source: 'threads', path: '/show/the-imaginary-invalid', day: '2026-10-30', views: 2 },
      { source: 'threads', path: '/show/the-imaginary-invalid', day: '2026-10-29', views: 5 },
    ],
    bioRows: [
      { source: 'instagram', path: '/show/the-imaginary-invalid', day: '2026-10-31', views: 3 },
      { source: 'none', path: '/show/the-imaginary-invalid', day: '2026-10-31', views: 1 },
    ],
  });
  assert.equal(rows.find((r) => r.id === 't1').visits, 2);
  assert.equal(rows.find((r) => r.id === 'i1').visits, 3);
  assert.equal(unmatched, 6); // the early visit + the untagged bio click
});

test('report: best by visits, worst only among settled posts, comments carry a reply, monthly on day <= 7', () => {
  const r = buildSocialReport({ bufferPosts: buffer, ledger, utmRows: [], bioRows: [{ source: 'instagram', path: '/show/the-imaginary-invalid', day: '2026-10-30', views: 4 }], now: NOW });
  assert.equal(r.weekly.best.id, 'i1');
  assert.ok(r.weekly.worst && r.weekly.worst.id !== 'i1');
  assert.equal(r.weekly.comments.length, 1);
  assert.match(r.weekly.comments[0].suggestedReply, /all 20 critic reviews/);
  assert.match(r.weekly.takeaway, /4 site visits, most from Instagram/);
  assert.ok(r.monthly && r.monthly.lines.length);
  assert.equal(buildSocialReport({ bufferPosts: buffer, ledger, now: Date.parse('2026-11-09T09:30:00Z') }).monthly, null);
  assert.equal(r.weekly.shows.length, 2); // the show (3 networks) + the video
});

test('a week where every post tied names no best or worst', () => {
  const flat = buffer.map((b) => ({ ...b, metrics: [] }));
  const r = buildSocialReport({ bufferPosts: flat, ledger, now: NOW });
  assert.equal(r.weekly.best, null);
  assert.equal(r.weekly.worst, null);
  assert.ok(socialHtml(r).length > 0);
});

test('monthlySuggestion: too few posts says so; a dead network with 5+ posts is flagged', () => {
  assert.match(monthlySuggestion([])[0], /Not enough posts yet/);
  const dead = Array.from({ length: 5 }, (_, i) => ({ lane: 'score', service: 'twitter', visits: 0, interactions: 0, id: `x${i}` }));
  const live = Array.from({ length: 5 }, (_, i) => ({ lane: 'score', service: 'threads', visits: 2, interactions: 1, id: `t${i}` }));
  const lines = monthlySuggestion([...dead, ...live]);
  assert.ok(lines.some((l) => /Best network: Threads/.test(l)));
  assert.ok(lines.some((l) => /dropping X/.test(l)));
});

test('suggestedReply never invents a link for an unknown post', () => {
  assert.doesNotMatch(suggestedReply({ lane: 'other' }), /http|\.com\/show/);
});

test('socialHtml escapes post titles and renders the error line', () => {
  const r = buildSocialReport({ bufferPosts: [{ ...buffer[3], text: '<script>x</script>' }], ledger: { posts: [] }, now: NOW });
  const html = socialHtml(r);
  assert.match(html, /<h2[^>]*>Social<\/h2>/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(socialHtml({ generatedAt: 'x', error: 'Buffer HTTP 401' }), /unavailable this week \(Buffer HTTP 401\)/);
  assert.equal(socialHtml(null), '');
});

test('loadSocialSection drops stale or missing files but keeps a fresh error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-'));
  const f = path.join(dir, 's.json');
  fs.writeFileSync(f, JSON.stringify({ generatedAt: new Date(NOW).toISOString(), error: 'boom' }));
  assert.equal(loadSocialSection(f, NOW).error, 'boom');
  assert.equal(loadSocialSection(f, NOW + 4 * 86400000), null);
  assert.equal(loadSocialSection(path.join(dir, 'missing.json'), NOW), null);
});

test('writeLedger leaves the file alone when only lastUpdated would change (no hourly deploy)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  const f = path.join(dir, 'l.json');
  writeLedger({ posts: [{ showId: 'a' }], _meta: {} }, f);
  const first = fs.readFileSync(f, 'utf8');
  writeLedger(JSON.parse(first), f);
  assert.equal(fs.readFileSync(f, 'utf8'), first);
  writeLedger({ ...JSON.parse(first), posts: [{ showId: 'a' }, { showId: 'b' }] }, f);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).posts.length, 2);
});
