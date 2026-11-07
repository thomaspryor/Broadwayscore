// BRO-7040: the quiet morning digest. Calls the REAL composeDigestEmail /
// buildOwnerView / renderOwnerTopBlock (CLAUDE.md §15), never a copy of their logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

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
// BRO-7075: what the inbox shows (bodyHtml) and the attachment (reportHtml). `html` is every section together.
function mail(health, { now = NOW, sections = {} } = {}) {
  return composeDigestEmail({ sections: { health, ...sections }, now, dispatchSecret: null, dispatchConfigPath: NO_CFG });
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
  const top = mail(health).bodyHtml;
  assert.ok(!top.includes('no audience score'), 'held warning must not be named in the email body');
  assert.match(top, /1 new item is under watch/);
});

test('age gate: a warning past 48h is shown, in plain words with the show names and a since-date', () => {
  const health = healthWith({ warns: [{ name: 'Quality: Show Score gap', message: SHOW_SCORE_MSG, firstSeen: iso(72) }] });
  const h = html(health);
  assert.match(h, /Midnight and Parcel From America have no audience score yet/);
  assert.match(h, /since Nov 3/);
  const m = mail(health);
  assert.ok(!m.bodyHtml.includes('Quality: Show Score gap'), 'raw check name never appears in the email body');
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

test('board stats, spend and technical details ride in the attachment, not the email body (BRO-7075)', () => {
  const m = mail(healthWith({ warns: [{ name: 'SEO: LCP elevated', message: 'x', firstSeen: iso(100) }] }));
  assert.ok(!/<details/.test(m.bodyHtml), 'Gmail ignores <details>; the body must not rely on it');
  assert.ok(!m.bodyHtml.includes('Technical details'), 'technical heading belongs in the report');
  assert.ok(!m.bodyHtml.includes('Behind the scenes'));
  assert.match(m.reportHtml, /^<!doctype html>/);
  assert.ok(m.reportHtml.includes('Technical details'));
  assert.ok(m.reportHtml.includes('Behind the scenes'));
  assert.ok(m.html.includes('Technical details'), 'the all-sections string still carries the report');
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
  const top = mail(healthWith({ warns: [{ name: 'Quality: Show Score gap', message: SHOW_SCORE_MSG, firstSeen: iso(10) }] })).bodyHtml;
  const text = top.replace(/<[^>]+>/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
  assert.ok(text.length < 25, `owner-visible top has ${text.length} non-empty lines`);
});

test('renderOwnerTopBlock no longer emits the Behind the scenes line', () => {
  const view = buildOwnerView({ health: healthWith(), nowMs: NOW.getTime() });
  assert.ok(!renderOwnerTopBlock(view, {}).includes('Behind the scenes'));
});

test('a dead auto-fix loop alarm stays in the email body, not the attachment', () => {
  const sections = { health: healthWith() };
  const { buildHtmlParts } = require('../../scripts/send-morning-digest.js');
  const p = buildHtmlParts({ sections, now: NOW, loopDeadMsg: 'Loop stalled for test' });
  assert.ok(p.body.includes('Loop stalled for test'), 'alarm is in the email body');
  assert.ok(!(p.report || '').includes('Loop stalled for test'), 'alarm is not buried in the attachment');
});

test('cleared line: machinery rows and rows whose plain twin is still open are left out', () => {
  const health = healthWith({
    warns: [{ name: 'Data quality: slug-mismatch lifetime sweep', message: 'x', firstSeen: iso(100) }],
    cleared: {
      'Autofix: throughput': { at: iso(2), firstSeen: iso(200), status: 'warn' },
      'Data quality: cv-wrongproduction lifetime sweep': { at: iso(2), firstSeen: iso(200), status: 'warn' },
      'Revenue: affiliate health': { at: iso(2), firstSeen: iso(200), status: 'warn' },
    },
  });
  const view = buildOwnerView({ health, nowMs: NOW.getTime() });
  assert.deepEqual(view.cleared, ['A review may belong to a different production', 'Ticket-link click numbers look unusual']);
  const twin = healthWith({
    warns: [{ name: 'Data quality: slug-mismatch lifetime sweep', message: 'x', firstSeen: iso(100) }],
    cleared: { 'Data quality: slug-mismatch lifetime sweep': { at: iso(2), firstSeen: iso(200), status: 'warn' } },
  });
  assert.deepEqual(buildOwnerView({ health: twin, nowMs: NOW.getTime() }).cleared, []);
});

test('an expired-login row is never held by the 48h gate', () => {
  const health = healthWith({ warns: [{ name: 'Login expired: Stagedoor needs you to sign in again', message: 'x', firstSeen: iso(1) }] });
  const view = buildOwnerView({ health, nowMs: NOW.getTime() });
  assert.equal(view.settling, 0);
  assert.equal(view.visitorItems.length, 1);
});

test('subject and body use the same clock for the hold', () => {
  const health = healthWith({ warns: [{ name: 'SEO: LCP elevated', message: 'x', firstSeen: iso(10) }] });
  const { subject } = composeDigestEmail({ sections: { health }, now: NOW, dispatchSecret: null, dispatchConfigPath: NO_CFG });
  assert.match(subject, /site (?:is )?(?:ok|fine)|nothing needs you/i, subject);
  assert.ok(!/minor visitor issue/i.test(subject), subject);
});

// BRO-7040 follow-up: check-name families that carry a file or job name must
// never reach the owner as the raw check name ("Freshness: audit/x.json").
test('plain wording: Freshness / Push verify / Cron / Pipeline families are translated', () => {
  const names = [
    'Freshness: reviews.json', 'Freshness: audit/same-title-confusion.json',
    'Push verify: shows.json', 'Cron: Update Show Status',
    'Cron: failing every scheduled run', 'Pipeline: weekly-grosses',
  ];
  for (const n of names) {
    const line = plainHealthLine(n, '');
    assert.notEqual(line, n, `${n} still shows its raw check name`);
    assert.match(line, /^[A-Z]/, `${n}: sentence should start with a capital`);
    assert.doesNotMatch(line, /\.json|audit\//, `${n}: leaks a file name`);
  }
  // A specific mapping still wins over the family fallback.
  assert.equal(plainHealthLine('Cron failed: x', ''), 'The automated "x" job keeps failing');
});

// BRO-7047 ratchet: every visitor-classified check name must map to a plain
// sentence. The fixed list pins the 34 names fixed here; the history sweep
// catches any new check that lands in health-check-history.json without one.
test('plain wording: no visitor-facing health check shows its raw name (BRO-7047)', () => {
  const { classifyHealthCheck } = require('../../scripts/lib/digest-audience.js');
  const fixed = [
    "Data: review-texts checkout coverage",
    "Sync: review-texts vs reviews.json",
    "Sync: open show coverage",
    "Sync: phantom show detection",
    "Sync: grosses weekEnding",
    "Data: UK regional opening dates",
    "Scoring: batch state",
    "Quality: scored review ratio",
    "Quality: missing contentTier",
    "Quality: outlet stub rate",
    "Quality: outlet invalid-content rate",
    "Data quality: provider spend ledger",
    "Data quality: roundup-url-mismatch lifetime sweep",
    "Data: OB shows no closing signal can detect",
    "Memory: cloud mirror reconcile failing",
    "Memory: cloud notes not reaching the Mac",
    "Data: Tours To You pages not checked",
    "Data: closed national tours reopened automatically",
    "Data: closed national tour lists new dates",
    "Quality: standingCoverage drift",
    "Quality: coverageExpectation drift",
    "Quality: outlet-heartbeat red flags",
    "Quality: outlet feed staleness",
    "Commercial pending-review queue",
    "Commercial: rows held for a person",
    "Commercial model: Boring Waltz fit",
    "Commercial model: running-show bar revisit",
    "Commercial: season share cards",
    "Cookies: expiration",
    "CWV: performance",
    "Data: published scores outside the critic's rating",
    "Data: early publish dates awaiting page-date recheck",
    "Data: duplicate-flag leaks (a wrong twin dropping a good review)",
    "Data: stale-slot squatters (current-year review slots held by another production)",
  ];
  let history = [];
  try { history = (JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/audit/health-check-history.json'), 'utf8')).results || []).map((x) => x.name); } catch { /* data absent: fixed list only */ }
  for (const n of new Set([...fixed, ...history])) {
    if (classifyHealthCheck({ name: n }) !== 'visitors') continue;
    const line = plainHealthLine(n, '');
    assert.notEqual(line, n, `${n} still shows its raw check name: add a PLAIN_HEALTH entry`);
    assert.match(line, /^[A-Z]/, `${n}: sentence should start with a capital`);
    assert.doesNotMatch(line, /\.json|audit\/|\u2014/, `${n}: leaks a file name or em dash`);
  }
});

// ---- BRO-7075: readable in Gmail ----

test('email body type floor: nothing in the body renders below 14px', () => {
  const sections = { needsYou: { items: [{ title: 'BRO-1: Pick one', url: 'https://linear.app/x/BRO-1', ageDays: 15 }], moreCount: 0 } };
  const { bodyHtml } = mail(healthWith({ warns: [{ name: 'Quality: Show Score gap', message: SHOW_SCORE_MSG, firstSeen: iso(100) }] }), { sections });
  const sizes = [...bodyHtml.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((x) => Number(x[1]));
  assert.ok(sizes.length > 5);
  assert.ok(Math.min(...sizes) >= 14, `smallest font in the body is ${Math.min(...sizes)}px`);
});

test('enforceBodyTypeFloor raises small sizes and leaves large ones alone', () => {
  const { enforceBodyTypeFloor } = require('../../scripts/send-morning-digest.js');
  assert.equal(enforceBodyTypeFloor('<p style="font-size:11px">a</p><p style="font-size:20px">b</p><p style="font-size: 12.5px">c</p>'),
    '<p style="font-size:14px">a</p><p style="font-size:20px">b</p><p style="font-size:14px">c</p>');
});

test('the email body stays short: under 20 KB and well under the old 100 KB wall', () => {
  const m = mail(healthWith({ warns: [{ name: 'SEO: LCP elevated', message: 'x', firstSeen: iso(100) }] }));
  assert.ok(Buffer.byteLength(m.bodyHtml) < 20000, `body is ${Buffer.byteLength(m.bodyHtml)} bytes`);
});

test('the body points at the attachment when there is one, and never when there is not', () => {
  const m = mail(healthWith());
  assert.ok(m.reportHtml);
  assert.match(m.bodyHtml, /attached to this email/);
});

test('Needs your attention shows each item once: the question, not the question plus the same text again', () => {
  const { renderNeedsAttentionBlock } = require('../../scripts/lib/autonomous-email-render.js');
  const out = renderNeedsAttentionBlock([{ title: 'Spend over budget', description: 'LONG DESCRIPTION TEXT', decisionPrompt: 'Decision needed: Buy more credits?', url: 'https://linear.app/x/BRO-5', actionUrl: 'https://broadwayscorecard.com/api/dispatch?x=1' }]);
  assert.equal((out.match(/Buy more credits\?/g) || []).length, 1);
  assert.ok(!out.includes('LONG DESCRIPTION TEXT'), 'description is only the fallback when there is no question');
  assert.ok(!/>https?:\/\//.test(out), 'no raw URL is ever printed as text');
  assert.match(out, />Open</);
  assert.match(out, /Dispatch a fix/);
});

test('Resend payload: the report is a base64 text/html attachment named for the day; no report means no attachments key', () => {
  const { buildResendPayload } = require('../../scripts/send-morning-digest.js');
  const withReport = buildResendPayload({ to: 'o@example.com', subject: 'S', bodyHtml: '<p>b</p>', reportHtml: '<!doctype html><p>r</p>', dayKey: '2026-11-07' });
  assert.deepEqual(withReport.to, ['o@example.com']);
  assert.equal(withReport.html, '<p>b</p>');
  assert.equal(withReport.attachments.length, 1);
  assert.equal(withReport.attachments[0].filename, 'morning-digest-report-2026-11-07.html');
  assert.equal(withReport.attachments[0].content_type, 'text/html');
  assert.equal(Buffer.from(withReport.attachments[0].content, 'base64').toString('utf8'), '<!doctype html><p>r</p>');
  assert.ok(!('attachments' in buildResendPayload({ to: 'o@example.com', subject: 'S', bodyHtml: 'b', reportHtml: null, dayKey: 'd' })));
});

test('the send site builds its payload with buildResendPayload and retries a 4xx without the attachment', () => {
  const src = require('node:fs').readFileSync(new URL('../../scripts/send-morning-digest.js', import.meta.url), 'utf8');
  assert.match(src, /buildResendPayload\(\{ to: sendTo,/);
  assert.match(src, /retrying without the attachment/);
});

// ---- BRO-7075 ship-check follow-ups ----

test('body invariants: a decision card with no button, leaked report content and <details> are all caught; the real body passes', () => {
  const { assertBodyInvariants } = require('../../scripts/lib/digest-content-invariants.js');
  assert.equal(assertBodyInvariants('<div>Needs your attention</div><p>text only</p>').ok, false);
  assert.equal(assertBodyInvariants('<div>Needs your attention</div><a href="https://linear.app/x">Open</a>').ok, true);
  assert.equal(assertBodyInvariants('<h2>Technical details</h2>').ok, false);
  assert.equal(assertBodyInvariants('<details><summary>x</summary></details>').ok, false);
  const sections = { needsYou: { items: [{ title: 'BRO-1: Pick one', url: 'https://linear.app/x/BRO-1', ageDays: 15 }], moreCount: 0 } };
  const real = mail(healthWith(), { sections });
  assert.deepEqual(assertBodyInvariants(real.bodyHtml).violations, []);
});

test('the attachment note and its not-attached twin both exist, and the body claims an attachment only when there is one', () => {
  const { REPORT_ATTACHED_NOTE, REPORT_NOT_ATTACHED_NOTE, buildHtmlParts } = require('../../scripts/send-morning-digest.js');
  assert.ok(mail(healthWith()).bodyHtml.includes(REPORT_ATTACHED_NOTE));
  assert.ok(!REPORT_NOT_ATTACHED_NOTE.includes('is attached'));
  const none = buildHtmlParts({ sections: {}, now: NOW });
  assert.ok(none.report === null || none.body.includes(REPORT_ATTACHED_NOTE));
  assert.ok(!/<p[^>]*><\/p>/.test(none.body), 'no empty paragraph when there is nothing to point at');
});

test('Stuck tile: the glance points at the attachment, the in-report copy points at the table below', () => {
  const { tilesFor } = require('../../scripts/lib/board-summary.js');
  const m = { waiting: 0, stuckCards: 1, daily: null, lanes: {}, cost: {} };
  assert.match(tilesFor(m, { startedIdle: 7, compact: true })[2][2], /attached report/);
  assert.match(tilesFor(m, { startedIdle: 7 })[2][2], /row below/);
});
