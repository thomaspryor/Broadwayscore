// BRO-7040: the quiet morning digest. Calls the REAL composeDigestEmail /
// buildOwnerView / renderOwnerTopBlock (CLAUDE.md §15), never a copy of their logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { composeDigestEmail } = require('../../scripts/send-morning-digest.js');
const { buildOwnerView, renderOwnerTopBlock, plainHealthLine, prettyShowSlug } = require('../../scripts/lib/autonomous-email-render.js');

const NOW = new Date('2026-11-06T12:00:00Z'); // Friday
const MONDAY = new Date('2026-11-09T12:00:00Z');
const iso = (hoursAgo, from = NOW) => new Date(from.getTime() - hoursAgo * 3600 * 1000).toISOString();
const NO_CFG = '/nonexistent/morning-digest-quiet-config.json';

const SHOW_SCORE_MSG = '2 opened show(s) have a cached Show Score URL but no Show Score audience score (midnight-2026, parcel-from-america-2026)';

function healthWith({ warns = [], errors = [], cleared = {} } = {}) {
  return { generatedAt: NOW.toISOString(), errors, warns, queued: [], cleared };
}
function html(health, { now = NOW, sections = {} } = {}) {
  return composeDigestEmail({ sections: { health, ...sections }, now, dispatchSecret: null, dispatchConfigPath: NO_CFG }).html;
}

test('age gate: a 20h-old warning is held out of the email and counted as under watch', () => {
  const health = healthWith({ warns: [{ name: 'Quality: Show Score gap', message: SHOW_SCORE_MSG, firstSeen: iso(20) }] });
  const view = buildOwnerView({ health, nowMs: NOW.getTime() });
  assert.equal(view.visitorItems.length, 0);
  assert.equal(view.settling, 1);
  assert.equal(view.siteState, 'ok');
  const h = html(health);
  const top = h.slice(0, h.indexOf('<details'));
  assert.ok(!top.includes('no audience score'), 'held warning must not be named above the collapsed section');
  assert.match(top, /1 new item is under watch/);
});

test('age gate: a warning past 48h is shown, in plain words with the show names and a since-date', () => {
  const health = healthWith({ warns: [{ name: 'Quality: Show Score gap', message: SHOW_SCORE_MSG, firstSeen: iso(72) }] });
  const h = html(health);
  assert.match(h, /Midnight and Parcel From America have no audience score yet/);
  assert.match(h, /since Nov 3/);
  assert.ok(!h.includes('Quality: Show Score gap') || h.indexOf('Quality: Show Score gap') > h.indexOf('<details'), 'raw check name only inside the collapsed section');
});

test('age gate fail-safe: no firstSeen means the warning is shown', () => {
  const health = healthWith({ warns: [{ name: 'Quality: Show Score gap', message: SHOW_SCORE_MSG }] });
  const view = buildOwnerView({ health, nowMs: NOW.getTime() });
  assert.equal(view.visitorItems.length, 1);
  assert.equal(view.settling, 0);
});

test('age gate never holds an error, even a brand-new one', () => {
  const health = healthWith({ errors: [{ name: 'Deploy: production freshness', message: 'x', firstSeen: iso(1) }] });
  const view = buildOwnerView({ health, nowMs: NOW.getTime() });
  assert.equal(view.visitorItems.length, 1);
  assert.equal(view.siteState, 'affected');
});

test('plain wording: the two rows from 2026-11-05 no longer show their raw check names', () => {
  assert.equal(plainHealthLine('Revenue: affiliate health'), 'Ticket-link click numbers look unusual');
  assert.equal(plainHealthLine('Quality: Show Score gap', SHOW_SCORE_MSG), 'Midnight and Parcel From America have no audience score yet');
  assert.equal(plainHealthLine('Quality: Show Score gap', '1 opened show(s) have a cached Show Score URL but no Show Score audience score (midnight-2026)'), 'Midnight has no audience score yet');
  assert.equal(plainHealthLine('Quality: Show Score gap', 'unparseable'), 'Some shows have no audience score yet');
  assert.equal(prettyShowSlug('parcel-from-america-2026'), 'Parcel From America');
});

test('cleared line: shown for a warning that outlasted the hold, not for one that cleared inside it', () => {
  const shown = healthWith({ cleared: { 'Revenue: affiliate health': { at: iso(2), firstSeen: iso(100), status: 'warn' } } });
  assert.match(html(shown), /Cleared since yesterday:<\/b> Ticket-link click numbers look unusual/);
  const quiet = healthWith({ cleared: { 'Revenue: affiliate health': { at: iso(2), firstSeen: iso(20), status: 'warn' } } });
  assert.ok(!html(quiet).includes('Cleared since yesterday'));
});

test('board stats, spend and technical details sit in one collapsed section at the bottom', () => {
  const h = html(healthWith({ warns: [{ name: 'SEO: LCP elevated', message: 'x', firstSeen: iso(100) }] }));
  const open = h.indexOf('<details');
  assert.ok(open > 0);
  assert.equal((h.match(/<details/g) || []).length, 1);
  assert.match(h, /Board, spend and technical details/);
  assert.ok(h.indexOf('Behind the scenes') > open, 'behind-the-scenes line is inside the collapsed section');
  assert.ok(h.indexOf('Technical details') > open);
  assert.ok(h.indexOf('</details>') < h.indexOf('Broadway Scorecard morning digest'));
});

test('decisions: long how-to paragraph only on Mondays', () => {
  const sections = { needsYou: { items: [{ title: 'BRO-1: Pick one', url: 'https://linear.app/x/BRO-1', ageDays: 15 }], moreCount: 0 } };
  const weekday = html(healthWith(), { sections });
  const monday = html(healthWith(), { now: MONDAY, sections });
  assert.ok(!weekday.includes('Twice a day your answer is read'));
  assert.match(weekday, /Tap Open/);
  assert.match(monday, /Twice a day your answer is read/);
});

test('decisions: one already waiting 2+ days is a compact card on weekdays, full on Mondays', () => {
  const item = { title: 'BRO-1: Pick one', url: 'https://linear.app/x/BRO-1', ageDays: 15, detail: 'LONG-CONTEXT-SENTENCE' };
  const sections = { needsYou: { items: [item], moreCount: 0 } };
  const weekday = html(healthWith(), { sections });
  const monday = html(healthWith(), { now: MONDAY, sections });
  assert.match(weekday, /waiting 15 days/);
  assert.ok(!weekday.includes('LONG-CONTEXT-SENTENCE'));
  assert.ok(monday.includes('LONG-CONTEXT-SENTENCE'));
  const fresh = html(healthWith(), { sections: { needsYou: { items: [{ ...item, ageDays: 0 }], moreCount: 0 } } });
  assert.ok(fresh.includes('LONG-CONTEXT-SENTENCE'), 'a new decision is shown in full');
});

test('quiet morning: owner-visible part (above the collapsed section) stays short', () => {
  const h = html(healthWith({ warns: [{ name: 'Quality: Show Score gap', message: SHOW_SCORE_MSG, firstSeen: iso(10) }] }));
  const top = h.slice(0, h.indexOf('<details'));
  const text = top.replace(/<[^>]+>/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
  assert.ok(text.length < 25, `owner-visible top has ${text.length} non-empty lines`);
});

test('renderOwnerTopBlock no longer emits the Behind the scenes line', () => {
  const view = buildOwnerView({ health: healthWith(), nowMs: NOW.getTime() });
  assert.ok(!renderOwnerTopBlock(view, {}).includes('Behind the scenes'));
});
