// BRO-8323: ScrapingBee market gate. Real functions only (CLAUDE.md rule 15).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const g = require('./sb-market-gate.js');
const { serpChainOrder } = require('./url-discovery.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbgate-'));
const showsPath = path.join(dir, 'shows.json');
fs.writeFileSync(showsPath, JSON.stringify({ shows: [
  { id: 'bway-show', category: 'broadway' },
  { id: 'ob-show', category: 'off-broadway' },
  { id: 'we-show', category: 'west-end' },
  { id: 'nocat-show' },
] }));
g._setShowsPathForTests(showsPath);
const NOW = Date.parse('2026-11-25T12:00:00Z');
const H = 3600 * 1000;

test('serp: Broadway and unknown shows keep ScrapingBee, others drop it', () => {
  assert.equal(g.sbSerpMarketSkips('bway-show', {}).size, 0);
  assert.equal(g.sbSerpMarketSkips('nocat-show', {}).size, 0);
  assert.equal(g.sbSerpMarketSkips('not-in-file', {}).size, 0);
  assert.equal(g.sbSerpMarketSkips(null, {}).size, 0);
  for (const id of ['ob-show', 'we-show']) assert.ok(g.sbSerpMarketSkips(id, {}).has('scrapingbee'));
});

test('serp: composed chain for Broadway is unchanged, non-Broadway is BD only', () => {
  for (const speed of [true, false]) {
    const b = serpChainOrder(speed, g.sbSerpMarketSkips('bway-show', {}));
    assert.deepEqual(b, serpChainOrder(speed, new Set()));
    assert.ok(b.includes('scrapingbee'));
    assert.deepEqual(serpChainOrder(speed, g.sbSerpMarketSkips('we-show', {})), ['brightdata']);
  }
});

test('serp: kill switch restores the old chain', () => {
  assert.equal(g.sbSerpMarketSkips('we-show', { SB_MARKET_GATE_DISABLED: '1' }).size, 0);
});

test('render gap: edges and fail-open cases', () => {
  const d = (o) => g.renderGapDecision({ nowMs: NOW, env: {}, ...o });
  assert.equal(d({ category: 'broadway', lastRenderMs: NOW - 60000 }).skip, false);
  assert.equal(d({ category: null, lastRenderMs: NOW - 60000 }).skip, false);
  assert.equal(d({ category: 'west-end', lastRenderMs: null }).skip, false);
  assert.equal(d({ category: 'west-end', lastRenderMs: NOW - 0.4 * H }).skip, true);
  assert.equal(d({ category: 'west-end', lastRenderMs: NOW - 0.5 * H }).skip, false);
  assert.equal(d({ category: 'west-end', lastRenderMs: NOW - 2 * H }).skip, false);
  assert.equal(d({ category: 'west-end', lastRenderMs: NOW + H }).skip, false); // clock skew
  assert.equal(d({ category: 'west-end', lastRenderMs: NOW - H, env: { SB_RENDER_GAP_HOURS: '0' } }).skip, false);
  assert.equal(d({ category: 'west-end', lastRenderMs: NOW - H, env: { SB_MARKET_GATE_DISABLED: '1' } }).skip, false);
  assert.equal(d({ category: 'west-end', lastRenderMs: NOW - 5 * H, env: { SB_RENDER_GAP_HOURS: '6' } }).skip, true);
});

test('lastSbRenderMs: newest successful SB render for show+host only', () => {
  g._resetIndexForTests();
  const led = path.join(dir, 'ledger.jsonl');
  const row = (o) => JSON.stringify({ provider: 'scrapingbee', fn: 'render', success: true, host: 'thestage.co.uk', showId: 'we-show', ...o });
  fs.writeFileSync(led, [
    row({ ts: '2026-11-25T08:00:00Z' }),
    row({ ts: '2026-11-25T10:00:00Z' }),
    row({ ts: '2026-11-25T11:30:00Z', showId: 'other' }),
    row({ ts: '2026-11-25T11:40:00Z', host: 'other.com' }),
    row({ ts: '2026-11-25T11:50:00Z', provider: 'scrapingdog' }),
    row({ ts: '2026-11-25T11:55:00Z', fn: 'serp' }),
    row({ ts: '2026-11-25T11:58:00Z', success: false }), // failed render must not count
    row({ ts: '2026-11-25T09:00:00Z', host: 'www.news.example.org' }),
    'not json "scrapingbee"',
  ].join('\n') + '\n');
  assert.equal(g.lastSbRenderMs(led, 'we-show', 'thestage.co.uk'), Date.parse('2026-11-25T10:00:00Z'));
  assert.equal(g.lastSbRenderMs(led, 'we-show', 'nothere.com'), null);
  assert.equal(g.lastSbRenderMs(led, 'we-show', 'news.example.org'), Date.parse('2026-11-25T09:00:00Z')); // www. ignored
  assert.equal(g.lastSbRenderMs(led, 'we-show', 'www.thestage.co.uk'), Date.parse('2026-11-25T10:00:00Z'));
  assert.equal(g.lastSbRenderMs(path.join(dir, 'missing'), 'we-show', 'x'), null);
});

test('unknown category is never gated', () => {
  assert.equal(g.skipSbSerpForCategory('some-new-market', {}), false);
  assert.equal(g.renderGapDecision({ category: 'some-new-market', lastRenderMs: NOW - 60000, nowMs: NOW, env: {} }).skip, false);
});

test('wiring: url-discovery and site-search call the gate', () => {
  const root = path.dirname(new URL(import.meta.url).pathname);
  assert.match(fs.readFileSync(path.join(root, 'url-discovery.js'), 'utf8'), /sbSerpMarketSkips\(currentSpendShowId\(\)\)/);
  assert.match(fs.readFileSync(path.join(root, 'site-search-discovery.js'), 'utf8'), /renderGapDecision/);
});

test.after(() => g._setShowsPathForTests(null));
