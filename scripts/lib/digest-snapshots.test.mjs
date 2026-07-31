import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSnapshot, readAllSnapshots, describeProblems, SNAPSHOTS, readFreshnessReport, summarizeFreshnessHighSeverity, summarizeClosingSoon } from './digest-snapshots.js';
import { classifySubject } from './scheduled-email-count-rules.js';
import digestSender from '../send-morning-digest.js';

const { buildSubject, buildHtml } = digestSender;

const NOW = new Date('2026-07-28T11:30:00Z').getTime();

function tmpAudit() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'digest-snapshots-test-'));
}

function write(dir, file, obj) {
  fs.writeFileSync(path.join(dir, file), typeof obj === 'string' ? obj : JSON.stringify(obj));
}

test('readSnapshot: fresh / stale / missing / invalid', () => {
  const dir = tmpAudit();
  const freshAt = new Date(NOW - 2 * 3600e3).toISOString();
  const staleAt = new Date(NOW - 48 * 3600e3).toISOString();

  write(dir, 'fresh.json', { generatedAt: freshAt, hello: 1 });
  write(dir, 'stale.json', { generatedAt: staleAt });
  write(dir, 'garbage.json', '{not json');
  write(dir, 'no-date.json', { hello: 1 });
  // JSON literal null parses fine but must not crash (ship-check QA P0)
  write(dir, 'null.json', 'null');
  write(dir, 'array.json', '[1,2]');
  // Future generatedAt = producer clock bug, not fresh (ship-check codex P1)
  write(dir, 'future.json', { generatedAt: new Date(NOW + 100 * 3600e3).toISOString() });

  const fresh = readSnapshot(path.join(dir, 'fresh.json'), 36, NOW);
  assert.equal(fresh.status, 'fresh');
  assert.equal(fresh.snapshot.hello, 1);

  assert.equal(readSnapshot(path.join(dir, 'stale.json'), 36, NOW).status, 'stale');
  assert.equal(readSnapshot(path.join(dir, 'stale.json'), 36, NOW).generatedAt, staleAt);
  assert.equal(readSnapshot(path.join(dir, 'absent.json'), 36, NOW).status, 'missing');
  assert.equal(readSnapshot(path.join(dir, 'garbage.json'), 36, NOW).status, 'invalid');
  assert.equal(readSnapshot(path.join(dir, 'no-date.json'), 36, NOW).status, 'invalid');
  assert.equal(readSnapshot(path.join(dir, 'null.json'), 36, NOW).status, 'invalid');
  assert.equal(readSnapshot(path.join(dir, 'array.json'), 36, NOW).status, 'invalid');
  assert.equal(readSnapshot(path.join(dir, 'future.json'), 36, NOW).status, 'invalid');
});

test('readAllSnapshots: fresh sections render, everything else lands in problems', () => {
  const dir = tmpAudit();
  const freshAt = new Date(NOW - 1 * 3600e3).toISOString();
  write(dir, 'health-digest-snapshot.json', { generatedAt: freshAt, errors: [], warns: [] });
  write(dir, 'daily-digest-snapshot.json', { generatedAt: new Date(NOW - 50 * 3600e3).toISOString() });
  // reddit + backlog-drain snapshots absent on purpose

  const { sections, problems } = readAllSnapshots({ auditDir: dir, now: NOW });
  assert.ok(sections.health);
  assert.equal(sections.dailyDigest, null);
  assert.equal(sections.redditDigest, null);
  assert.equal(sections.backlogDrain, null);
  // backlogDrain is optionalIfMissing (disabled-by-default launchd plist) —
  // its absence must NOT land in problems, only reddit's genuine gap does.
  assert.equal(problems.length, 2);
  assert.deepEqual(problems.map((p) => p.status).sort(), ['missing', 'stale']);
  assert.ok(!problems.some((p) => p.key === 'backlogDrain'));
});

test('readAllSnapshots: an optionalIfMissing snapshot that EXISTS and goes stale still reports (producer broke, not just never-enabled)', () => {
  const dir = tmpAudit();
  write(dir, 'backlog-drain-metric.json', { generatedAt: new Date(NOW - 50 * 3600e3).toISOString() });

  const { problems } = readAllSnapshots({ auditDir: dir, now: NOW });
  const backlogProblem = problems.find((p) => p.key === 'backlogDrain');
  assert.ok(backlogProblem, 'a stale (not missing) optionalIfMissing snapshot must still be reported');
  assert.equal(backlogProblem.status, 'stale');
});

test('describeProblems names every non-fresh source; null when all fresh', () => {
  assert.equal(describeProblems([]), null);
  const note = describeProblems([
    { key: 'health', label: 'site health', status: 'stale', generatedAt: '2026-07-26T03:12:00.000Z' },
    { key: 'redditDigest', label: 'Reddit engagement', status: 'missing', generatedAt: null },
  ]);
  assert.match(note, /site health \(last update 2026-07-26 03:12 UTC\)/);
  assert.match(note, /Reddit engagement \(no data\)/);
  assert.match(note, /^didn't update overnight:/);
});

test('registry covers exactly the folded digests (opening digest is standalone again since 2026-07-30; backlogDrain added #654)', () => {
  assert.deepEqual(SNAPSHOTS.map((s) => s.key).sort(), ['backlogDrain', 'dailyDigest', 'health', 'providerSpend', 'redditDigest']);
});

// The contract the plan review flagged as a P0: the monitor's classifier and
// the sender's subject builder must never drift apart, or the one-email-per-
// day guard silently stops guarding.
test('buildSubject output classifies as the morning-digest scheduled sender', () => {
  const quiet = buildSubject({ health: null, now: new Date('2026-07-28T11:30:00Z') });
  assert.equal(classifySubject(quiet)?.key, 'morning-digest');
  const noisy = buildSubject({
    health: { subject: 'BSC URGENT (day 3): 2 unresolved errors', errors: ['a', 'b'], warns: ['c'] },
    now: new Date('2026-07-28T11:30:00Z'),
  });
  assert.equal(classifySubject(noisy)?.key, 'morning-digest');
  assert.match(noisy, /⛔ site health: 2 errors, 1 warning/);
  // Never a bare count that can degrade to "0 items" (owner feedback).
  assert.doesNotMatch(quiet, /\d+ items?/);
});

test('buildHtml never renders loop language; empty day reads calm, not broken', () => {
  const empty = buildHtml({ sections: {}, problemsNote: null, changesHtml: null, now: new Date('2026-07-28T11:30:00Z') });
  assert.match(empty, /Nothing needs your attention this morning/);
  assert.match(empty, /All quiet — no overnight changes to report/);
  for (const banned of ['Auto tag', 'needs your triage', 'awaiting your tap', 'stalling the loop', 'autonomous loop', 'Approve', 'clear the Auto']) {
    assert.ok(!empty.includes(banned), `digest HTML must never contain "${banned}"`);
  }
});

test('buildHtml: top verdict NAMES the failing check; warnings demote to a routine line', () => {
  const html = buildHtml({
    sections: { health: { generatedAt: '2026-07-28T09:00:00Z', errors: [{ name: 'Sync: cast coverage', message: '29 empty casts' }], warns: ['w1', 'w2'], checks: [] } },
    problemsNote: "didn't update overnight: Reddit engagement (no data)",
    changesHtml: null,
    now: new Date('2026-07-28T11:30:00Z'),
  });
  assert.match(html, /Fix needed: Sync: cast coverage/);
  assert.match(html, /2 routine warnings below/);
  assert.match(html, /didn't update overnight: Reddit engagement/);
  assert.doesNotMatch(html, /Nothing needs your attention/);
});

// ── data/freshness-report.json consumer (task #689) — the generator existed
// and wrote high-severity signals (missing_poster, missing_tickets) daily
// with zero readers. These tests cover the new reader + transform + render
// wiring end to end. ───────────────────────────────────────────────────────
test('readFreshnessReport: fresh / stale / missing, honors dataDir override', () => {
  const dir = tmpAudit();
  const freshAt = new Date(NOW - 2 * 3600e3).toISOString();
  write(dir, 'freshness-report.json', { generatedAt: freshAt, dataQuality: { hasIssues: [] } });

  assert.equal(readFreshnessReport({ dataDir: dir, now: NOW }).status, 'fresh');
  assert.equal(readFreshnessReport({ dataDir: dir, now: NOW + 100 * 3600e3 }).status, 'stale');
  assert.equal(readFreshnessReport({ dataDir: path.join(dir, 'nope'), now: NOW }).status, 'missing');
});

test('summarizeFreshnessHighSeverity: names show IDs for high-severity issues on open shows, ignores low/medium/info', () => {
  const report = {
    generatedAt: '2026-07-30T06:54:26.128Z',
    dataQuality: {
      hasIssues: [
        {
          id: 'les-mis-arena-2026', title: 'Les Mis Arena Concert',
          issues: [
            { type: 'missing_poster', severity: 'high' },
            { type: 'missing_tickets', severity: 'high' },
            { type: 'missing_runtime', severity: 'low' },
          ],
        },
        {
          id: 'quiet-show-2026', title: 'Quiet Show',
          issues: [
            { type: 'missing_thumbnail', severity: 'low' },
            { type: 'no_closing_date', severity: 'info' },
          ],
        },
      ],
    },
  };
  const summary = summarizeFreshnessHighSeverity(report);
  assert.ok(summary);
  assert.equal(summary.bannerText, '1 open show missing critical data (poster/tickets/synopsis)');
  assert.equal(summary.items.length, 1);
  assert.match(summary.items[0].detail, /les-mis-arena-2026/);
  assert.match(summary.items[0].detail, /poster/);
  assert.match(summary.items[0].detail, /tickets/);
});

// ship-check finding: a hasIssues entry missing id/title must not leak a
// literal "undefined — poster, tickets" line into the owner's inbox.
test('summarizeFreshnessHighSeverity: entries missing id or title are skipped, not rendered as "undefined"', () => {
  const report = {
    generatedAt: '2026-07-30T06:54:26.128Z',
    dataQuality: {
      hasIssues: [
        { title: 'No ID', issues: [{ type: 'missing_tickets', severity: 'high' }] },
        { id: 'no-title-2026', issues: [{ type: 'missing_tickets', severity: 'high' }] },
        { id: 'good-2026', title: 'Good Show', issues: [{ type: 'missing_tickets', severity: 'high' }] },
      ],
    },
  };
  const summary = summarizeFreshnessHighSeverity(report);
  assert.equal(summary.count, 1);
  assert.match(summary.items[0].detail, /good-2026/);
  assert.doesNotMatch(JSON.stringify(summary), /undefined/);
});

// ship-check finding: revenue-impacting gaps (tickets/poster) must survive
// the maxItems truncation ahead of lower-stakes synopsis-only gaps, instead
// of being buried by arbitrary source order.
test('summarizeFreshnessHighSeverity: tickets/poster rows sort ahead of synopsis-only rows when truncating', () => {
  const report = {
    generatedAt: '2026-07-30T06:54:26.128Z',
    dataQuality: {
      hasIssues: [
        { id: 'synopsis-only-2026', title: 'Synopsis Only', issues: [{ type: 'missing_synopsis', severity: 'high' }] },
        { id: 'tickets-2026', title: 'Tickets Gap', issues: [{ type: 'missing_tickets', severity: 'high' }] },
      ],
    },
  };
  const summary = summarizeFreshnessHighSeverity(report, { maxItems: 1 });
  assert.equal(summary.moreCount, 1);
  assert.match(summary.items[0].detail, /tickets-2026/);
});

test('summarizeFreshnessHighSeverity: no high-severity issues -> null (quiet day renders no block)', () => {
  const report = {
    generatedAt: '2026-07-30T06:54:26.128Z',
    dataQuality: { hasIssues: [{ id: 'x', title: 'X', issues: [{ type: 'missing_runtime', severity: 'low' }] }] },
  };
  assert.equal(summarizeFreshnessHighSeverity(report), null);
  assert.equal(summarizeFreshnessHighSeverity(null), null);
  assert.equal(summarizeFreshnessHighSeverity({}), null);
});

// second-opinion correctness warning: a malformed hasIssues entry (null, or
// issues not an array) must degrade that one entry, not throw and kill the
// whole digest send.
test('summarizeFreshnessHighSeverity: malformed hasIssues entries degrade gracefully, real entries still surface', () => {
  const report = {
    generatedAt: '2026-07-30T06:54:26.128Z',
    dataQuality: {
      hasIssues: [
        null,
        { id: 'no-issues-array', title: 'Bad Entry', issues: 'not-an-array' },
        { id: 'real-show-2026', title: 'Real Show', issues: [{ type: 'missing_tickets', severity: 'high' }] },
      ],
    },
  };
  assert.doesNotThrow(() => summarizeFreshnessHighSeverity(report));
  const summary = summarizeFreshnessHighSeverity(report);
  assert.equal(summary.count, 1);
  assert.match(summary.items[0].detail, /real-show-2026/);
});

// second-opinion design blocker: high-severity freshness gaps (missing
// tickets/poster — revenue-impacting) must escalate the top "2-second
// verdict", not sit demoted in the context box below where the whole point
// of this fix (task #689) is that they'd stay easy to miss.
test('buildHtml: freshness high-severity count escalates the top verdict, not just the section below', () => {
  const html = buildHtml({
    sections: { freshness: { count: 2, bannerText: '2 open shows missing critical data', items: [], moreCount: 0 } },
    now: new Date('2026-07-30T12:00:00Z'),
  });
  assert.match(html, /2 open shows missing tickets\/poster\/synopsis/);
  assert.doesNotMatch(html, /Nothing needs your attention/);
});

// Acceptance criterion 2 (task #689): a deliberately blanked ticketLinks on
// one open show must appear in the next digest run, named by show ID — not
// just a count.
test('acceptance: a blanked-tickets open show appears in the rendered digest by show ID, not just a count', () => {
  const report = {
    generatedAt: '2026-07-30T06:54:26.128Z',
    dataQuality: {
      hasIssues: [{
        id: 'les-mis-arena-concert-2026', title: 'Les Mis Arena Concert Spectacular',
        issues: [{ type: 'missing_tickets', severity: 'high' }],
      }],
    },
  };
  const summary = summarizeFreshnessHighSeverity(report);
  const html = buildHtml({ sections: { freshness: summary }, now: new Date('2026-07-30T12:00:00Z') });
  assert.match(html, /les-mis-arena-concert-2026/);
  assert.match(html, /tickets/);
});

test('summarizeClosingSoon: names show IDs/titles, sorted by daysLeft, urgentCount only counts <=14 days', () => {
  const report = {
    generatedAt: '2026-07-30T06:54:26.128Z',
    closingSoon: [
      { id: 'far-off-2026', title: 'Far Off Show', closingDate: '2026-09-20', daysLeft: 52 },
      { id: 'soon-2026', title: 'Soon Show', closingDate: '2026-08-05', daysLeft: 6 },
    ],
  };
  const summary = summarizeClosingSoon(report);
  assert.ok(summary);
  assert.equal(summary.count, 1);
  assert.equal(summary.bannerText, '2 open shows closing within 60 days (1 within 14 days)');
  // sorted by daysLeft ascending regardless of source order
  assert.equal(summary.items[0].title, 'Soon Show');
  assert.match(summary.items[0].detail, /soon-2026/);
  assert.match(summary.items[0].detail, /2026-08-05/);
  assert.match(summary.items[1].title, /Far Off Show/);
});

// same fail-soft contract as summarizeFreshnessHighSeverity: malformed
// entries must be skipped, never render as "undefined", never throw.
test('summarizeClosingSoon: malformed/expired entries skipped, no throw, no "undefined" leak', () => {
  const report = {
    generatedAt: '2026-07-30T06:54:26.128Z',
    closingSoon: [
      null,
      { title: 'No ID', daysLeft: 5 },
      { id: 'no-days', title: 'No Days Left' },
      { id: 'expired-2026', title: 'Already Closed', daysLeft: 0 },
      { id: 'no-closing-date-2026', title: 'No Closing Date', daysLeft: 5 },
      { id: 'good-2026', title: 'Good Show', closingDate: '2026-08-10', daysLeft: 11 },
    ],
  };
  assert.doesNotThrow(() => summarizeClosingSoon(report));
  const summary = summarizeClosingSoon(report);
  assert.equal(summary.items.length, 1);
  assert.match(summary.items[0].detail, /good-2026/);
  assert.doesNotMatch(JSON.stringify(summary), /undefined/);
});

test('summarizeClosingSoon: quiet day -> null', () => {
  assert.equal(summarizeClosingSoon({ generatedAt: '2026-07-30T06:54:26.128Z', closingSoon: [] }), null);
  assert.equal(summarizeClosingSoon(null), null);
  assert.equal(summarizeClosingSoon({}), null);
});

test('summarizeClosingSoon: maxItems truncation keeps the soonest-closing rows, moreCount reflects the rest', () => {
  const report = {
    generatedAt: '2026-07-30T06:54:26.128Z',
    closingSoon: [
      { id: 'a-2026', title: 'A', closingDate: '2026-08-01', daysLeft: 2 },
      { id: 'b-2026', title: 'B', closingDate: '2026-08-20', daysLeft: 21 },
      { id: 'c-2026', title: 'C', closingDate: '2026-08-10', daysLeft: 11 },
    ],
  };
  const summary = summarizeClosingSoon(report, { maxItems: 2 });
  assert.equal(summary.moreCount, 1);
  assert.match(summary.items[0].detail, /a-2026/);
  assert.match(summary.items[1].detail, /c-2026/);
});

// Acceptance criterion 3 (task #690): real closing-soon shows must render in
// the digest HTML named by show ID, not just a count, same contract as
// summarizeFreshnessHighSeverity's acceptance test above.
test('acceptance: a closing-soon show appears in the rendered digest by show ID', () => {
  const report = {
    generatedAt: '2026-07-30T06:54:26.128Z',
    closingSoon: [{ id: 'les-mis-arena-concert-2026', title: 'Les Mis Arena Concert Spectacular', closingDate: '2026-08-02', daysLeft: 3 }],
  };
  const summary = summarizeClosingSoon(report);
  const html = buildHtml({ sections: { closingSoon: summary }, now: new Date('2026-07-30T12:00:00Z') });
  assert.match(html, /les-mis-arena-concert-2026/);
  assert.match(html, /Closing soon/);
});

test('buildHtml: closingSoon urgent count (<=14 days) escalates the top verdict', () => {
  const html = buildHtml({
    sections: { closingSoon: { count: 2, bannerText: '2 open shows closing within 60 days (2 within 14 days)', items: [], moreCount: 0 } },
    now: new Date('2026-07-30T12:00:00Z'),
  });
  assert.match(html, /2 shows closing within 2 weeks/);
  assert.doesNotMatch(html, /Nothing needs your attention/);
});

test('buildHtml: warnings-only day reads calm ("Nothing urgent"), stuck signals escalate the verdict', () => {
  const warnsOnly = buildHtml({
    sections: { health: { generatedAt: '2026-07-28T09:00:00Z', errors: [], warns: ['w1'], checks: [] } },
    now: new Date('2026-07-28T11:30:00Z'),
  });
  assert.match(warnsOnly, /Nothing urgent this morning/);
  assert.match(warnsOnly, /1 routine warning below/);

  const stuck = buildHtml({
    sections: {},
    stuckCount: 2,
    now: new Date('2026-07-28T11:30:00Z'),
  });
  assert.match(stuck, /2 pipeline items flagged &quot;possibly stuck&quot; below/);
});
