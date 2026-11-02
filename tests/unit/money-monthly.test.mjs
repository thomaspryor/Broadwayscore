import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('../../scripts/money-monthly/lib.js');
const { renderHtml } = require('../../scripts/money-monthly/render.js');
const { planAudienceSync, readAllContactPages } = require('../../scripts/money-monthly/audience.js');

const show = (o) => ({ market: 'broadway', status: 'open', type: 'musical', ...o });
const W = { start: '2026-10-01', end: '2026-10-31', label: 'October', monthKey: '2026-10', catchup: false };

test('resolveWindow: previous calendar month, year rollover, since, bad input', () => {
  assert.deepEqual(L.resolveWindow({ today: '2026-11-02' }).start, '2026-10-01');
  assert.equal(L.resolveWindow({ today: '2026-11-02' }).end, '2026-10-31');
  assert.equal(L.resolveWindow({ today: '2027-01-04' }).monthKey, '2026-12');
  assert.equal(L.resolveWindow({ today: '2026-03-02' }).end, '2026-02-28');
  assert.equal(L.resolveWindow({ today: '2026-11-01', since: '2026-09-01' }).catchup, true);
  assert.throws(() => L.resolveWindow({ today: '2026-11-01', month: 'nope' }));
});

test('recoupments: fresh ones only, bulk-backfill days are skipped', () => {
  const commercial = {
    fresh: { recouped: true, recoupedDate: '2026-10', firstAdded: '2026-10-15T00:00:00Z', designation: 'Trickle' },
    old: { recouped: true, recoupedDate: '2024-04', firstAdded: '2026-10-15T00:00:00Z' },
  };
  // 12 other entries stamped the same day make 2026-10-20 a bulk day
  for (let i = 0; i < 12; i++) commercial[`bulk${i}`] = { recouped: true, recoupedDate: '2026-10', firstAdded: '2026-10-20T00:00:00Z' };
  const shows = [show({ slug: 'fresh', title: 'Fresh' }), show({ slug: 'old', title: 'Old' }), ...Array.from({ length: 12 }, (_, i) => show({ slug: `bulk${i}`, title: `B${i}` }))];
  const issue = L.buildIssue({ commercial, shows, snapshot: null, window: W });
  assert.deepEqual(issue.sections.recoupments.map((r) => r.slug), ['fresh']);
});

test('closings: final label in window only; TBD, nonprofit, off-window and non-Broadway skipped', () => {
  const commercial = {
    a: { designation: 'Flop', capitalization: 9e6 }, b: { designation: 'TBD' }, c: { designation: 'Flop', nonprofitOrg: 'X' },
    d: { designation: 'Flop' }, e: { designation: 'Fizzle' },
  };
  const shows = [
    show({ slug: 'a', title: 'A', status: 'closed', closingDate: '2026-10-12' }),
    show({ slug: 'b', title: 'B', status: 'closed', closingDate: '2026-10-12' }),
    show({ slug: 'c', title: 'C', status: 'closed', closingDate: '2026-10-12' }),
    show({ slug: 'd', title: 'D', status: 'closed', closingDate: '2026-09-12' }),
    show({ slug: 'e', title: 'E', status: 'closed', closingDate: '2026-10-12', market: 'west-end' }),
  ];
  const issue = L.buildIssue({ commercial, shows, snapshot: null, window: W });
  assert.deepEqual(issue.sections.closings.map((c) => c.slug), ['a']);
});

test('estimate moves need a baseline and ignore small or recouped shows', () => {
  const commercial = { a: { modelRecoupmentPct: [10, 40, 70] }, b: { modelRecoupmentPct: [10, 45, 70] }, c: { modelRecoupmentPct: [0, 90, 100], recouped: true } };
  const shows = ['a', 'b', 'c'].map((s) => show({ slug: s, title: s }));
  assert.equal(L.buildIssue({ commercial, shows, snapshot: null, window: W }).sections.moves.length, 0);
  const snapshot = { a: { pct: 20, cap: null }, b: { pct: 42, cap: null }, c: { pct: 10, cap: null } };
  const moves = L.buildIssue({ commercial, shows, snapshot, window: W }).sections.moves;
  assert.deepEqual(moves.map((m) => [m.slug, m.delta]), [['a', 20]]);
});

test('capitalization: skips estimates, unsourced, "no verified source" and old closed shows', () => {
  const base = { firstAdded: '2026-10-05T00:00:00Z', capitalization: 5e6 };
  const commercial = {
    ok: { ...base, capitalizationSource: 'SEC Form D (filed Oct 3, 2026)' },
    nosrc: { ...base, capitalizationSource: 'No verified public source found' },
    est: { ...base, capitalizationSource: 'x', modelCapitalizationEstimate: 5e6 },
    oldclosed: { ...base, capitalizationSource: 'Playbill 2013' },
  };
  const shows = [show({ slug: 'ok', title: 'ok' }), show({ slug: 'nosrc', title: 'n' }), show({ slug: 'est', title: 'e' }), show({ slug: 'oldclosed', title: 'o', status: 'closed', closingDate: '2013-01-01' })];
  assert.deepEqual(L.buildIssue({ commercial, shows, snapshot: null, window: W }).sections.capitalization.map((c) => c.slug), ['ok']);
});

test('quiet month: subject says so and the email says nothing crossed the bar', () => {
  const issue = L.buildIssue({ commercial: {}, shows: [], snapshot: null, window: W });
  assert.equal(issue.quiet, true);
  assert.match(L.buildSubject(issue), /a quiet month/);
  assert.match(renderHtml(issue), /Nothing crossed our bar/);
});

test('email copy: no em dashes, first-party links carry UTMs, unsubscribe link stays clean', () => {
  const commercial = { a: { designation: 'Flop', capitalization: 9e6 } };
  const issue = L.buildIssue({ commercial, shows: [show({ slug: 'a', title: 'A', status: 'closed', closingDate: '2026-10-12' })], snapshot: null, window: W });
  const html = renderHtml(issue, { unsubscribeUrl: 'https://broadwayscorecard.com/unsubscribe?email=x%40y.com' });
  assert.ok(!html.includes('—') && !L.buildSubject(issue).includes('—'));
  assert.match(html, /show\/a\?utm_source=money-list/);
  assert.match(html, /href="https:\/\/broadwayscorecard\.com\/unsubscribe\?email=x%40y\.com"/);
  assert.match(L.buildSubject(issue), /A closed as a Flop/);
});

test('audience sync plan: dedupes against General, existing contacts, owner test and duplicates', () => {
  const plan = planAudienceSync({
    signups: [{ email: 'New@x.com' }, { email: 'new@x.com' }, { email: 'gen@x.com' }, { email: 'have@x.com' }, { email: 'bad' }, { email: '' }],
    general: [{ email: 'GEN@x.com' }], existing: [{ email: 'have@x.com' }],
  });
  assert.deepEqual(plan.toAdd, ['new@x.com']);
  assert.deepEqual(plan.inGeneral, ['gen@x.com']);
  assert.deepEqual(plan.alreadyThere, ['have@x.com']);
  assert.equal(plan.skipped, 3);
});

test('catch-up window: a backfilled older recoupment does not ride in on firstAdded', () => {
  const w = L.resolveWindow({ today: '2026-10-31', since: '2026-06-01' });
  assert.equal(L.isRecoupmentNews({ recouped: true, recoupedDate: '2026-05', firstAdded: '2026-07-20' }, w), false);
  assert.equal(L.isRecoupmentNews({ recouped: true, recoupedDate: '2026-07', firstAdded: '2026-07-20' }, w), true);
  assert.equal(L.isRecoupmentNews({ recouped: true, recoupedDate: '2026-08', firstAdded: '2026-09-02' }, w), true); // middle month
});

test('subject counts every item even when the list is capped at 5', () => {
  const commercial = {}; const shows = [];
  for (let i = 0; i < 7; i++) {
    commercial[`s${i}`] = { recouped: true, recoupedDate: '2026-09', firstAdded: `2026-09-0${i + 1}`, designation: 'Easy Winner' };
    shows.push({ slug: `s${i}`, title: `Show ${i}`, market: 'broadway', status: 'open' });
  }
  const issue = L.buildIssue({ commercial, shows, snapshot: null, window: L.resolveWindow({ today: '2026-10-02', month: '2026-09' }) });
  assert.equal(issue.sections.recoupments.length, 5);
  assert.match(L.buildSubject(issue), /7 recoupments/);
});

test('with a baseline, a brand-new production whose source is dated in the window counts as new', () => {
  const commercial = { newshow: { capitalization: 12e6, capitalizationSource: 'SEC Form D, filed Sep 9, 2026', firstAdded: '2026-09-10' } };
  const shows = [{ slug: 'newshow', title: 'New Show', market: 'broadway', status: 'open' }];
  const issue = L.buildIssue({ commercial, shows, snapshot: {}, window: L.resolveWindow({ today: '2026-10-02', month: '2026-09' }) });
  assert.equal(issue.sections.capitalization.length, 1);
});

test('BRO-6309: unsubscribed sign-ups are never added and are flagged if already in the audience', async () => {
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const { planAudienceSync } = req('../../scripts/money-monthly/audience.js');
  const plan = planAudienceSync({
    signups: [
      { email: 'gone@real.org', unsubscribed_at: '2026-11-02' },
      { email: 'gone2@real.org', unsubscribed_at: '2026-11-02' },
      { email: 'stay@real.org', unsubscribed_at: null },
    ],
    general: [],
    existing: [{ id: 'c1', email: 'gone@real.org', unsubscribed: false }],
  });
  assert.deepEqual(plan.toAdd, ['stay@real.org']);
  assert.deepEqual(plan.toUnsubscribe.map((c) => c.id), ['c1']);
});

test('readAllContactPages follows has_more so an unsubscribed contact on page 2 is never re-added', async () => {
  const pages = [
    { data: [{ id: 'a', email: 'x@e.com' }], has_more: true },
    { data: [{ id: 'b', email: 'gone@e.com', unsubscribed: true }], has_more: false },
  ];
  const seen = [];
  const all = await readAllContactPages(async (after) => { seen.push(after); return pages[seen.length - 1]; });
  assert.deepEqual(seen, [null, 'a']);
  assert.equal(all.length, 2);
  const plan = planAudienceSync({ signups: [{ email: 'gone@e.com' }], general: [], existing: all });
  assert.deepEqual(plan.toAdd, []);
  await assert.rejects(readAllContactPages(async () => ({ data: [], has_more: true })), /empty/);
});

test('sync-audience never posts unsubscribed:false', () => {
  const src = require('node:fs').readFileSync(new URL('../../scripts/money-monthly/sync-audience.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /unsubscribed:\s*false/);
});

test('capitalization: only figures published inside the window, whenever we added them (Oct 2026 issue)', () => {
  const add = { firstAdded: '2026-10-17T07:48:36Z', capitalization: 3e7 };
  const commercial = {
    aug: { ...add, capitalizationSource: 'Broadway Journal (Philip Boroff, Aug 12, 2026): "X ($30 million)"' },
    old: { ...add, capitalizationSource: 'SEC Form D/A (filed Jan 22, 2025): offering capitalized at $16,000,000' },
    undated: { ...add, capitalizationSource: 'Broadway News' },
    octLateAdd: { firstAdded: '2026-11-01T00:00:00Z', capitalization: 2e7, capitalizationSource: 'SEC Form D, filed 2026-10-20' },
    cites: { ...add, capitalizationSource: 'Deadline (October 9, 2026), citing a SEC filing dated Mar 1, 2025' },
  };
  const shows = Object.keys(commercial).map((slug) => show({ slug, title: slug }));
  const got = L.buildIssue({ commercial, shows, snapshot: {}, window: W }).sections.capitalization.map((c) => c.slug).sort();
  assert.deepEqual(got, ['cites', 'octLateAdd']);
  assert.equal(L.capitalizationPublishedDate('filed Jan 22, 2025 and Sept. 3, 2026'), '2025-01-22');
  assert.equal(L.capitalizationPublishedDate('no date here 2024'), null);
  assert.equal(L.capitalizationPublishedDate('Variety (Oct. 3rd, 2026), show opens April 18, 2027', '2026-10-31'), '2026-10-03');
  assert.deepEqual(L.buildIssue({ commercial, shows, snapshot: {}, window: W }).undatedCapitalization, ['undated']);
});

test('one-number sentence reads cleanly', () => {
  const commercial = {};
  for (let i = 0; i < 25; i++) commercial['s' + i] = { designation: i < 5 ? 'Recouped' : 'Flop' };
  const shows = Object.keys(commercial).map((slug) => show({ slug, title: slug, status: 'closed', closingDate: '2020-01-01' }));
  const html = renderHtml(L.buildIssue({ commercial, shows, snapshot: null, window: W }));
  assert.match(html, /Of the 25 closed Broadway shows with a final money label, 5 recouped \(20%\)\./);
});

test('capitalization date: primary (first) source wins, strict month names, real dates, more formats', () => {
  const p = L.capitalizationPublishedDate;
  assert.equal(p('The New York Times (Jun 8, 2026): $8M. The Hollywood Reporter (Aug 11, 2026) repeated it.'), '2026-06-08');
  assert.equal(p('opens April 18, 2027; Variety (Oct 2, 2026)', '2026-10-31'), '2026-10-02');
  assert.equal(p('Mayor 3, 2026; Marched 5, 2026; Octagon 4, 2026'), null);
  assert.equal(p('Sep 31, 2026'), null);
  assert.equal(p('Deadline Oct 3 2026'), '2026-10-03');
  assert.equal(p('The Stage, 3 October 2026'), '2026-10-03');
});

test('capitalization: snapshot guard, late-ingest grace, catch-up gets no grace', () => {
  const commercial = {
    had: { capitalization: 1e7, capitalizationSource: 'Variety (Oct 5, 2026)', firstAdded: '2026-09-01' },
    late: { capitalization: 1e7, capitalizationSource: 'Variety (Sep 28, 2026)', firstAdded: '2026-10-02' },
    early: { capitalization: 1e7, capitalizationSource: 'Variety (Sep 2, 2026)', firstAdded: '2026-10-02' },
  };
  const shows = Object.keys(commercial).map((slug) => show({ slug, title: slug }));
  const got = (snapshot, w) => L.buildIssue({ commercial, shows, snapshot, window: w }).sections.capitalization.map((c) => c.slug).sort();
  assert.deepEqual(got({ had: { cap: 1e7 } }, W), ['late']);
  assert.deepEqual(got(null, { ...W, catchup: true }), ['had']);
});
