/**
 * BRO-282 residual half — scripts/lib/in-review-backlog.js.
 *
 * The bug this file exists to prevent recurring: 120 finished issues sat in
 * Linear's `In Review` state, 100 of them 14+ days, with nothing anywhere
 * reading that state. Every assertion below is written against a behaviour
 * that failure needed.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isRealInReview,
  buildInReviewRows,
  buildInReviewSection,
  IDLE_AFTER_MS,
  MAX_TITLE_CHARS,
  hasOwnerMarker,
  countTechnicalInReview,
  enrichForOwnerMarkers,
} = require('../../scripts/lib/in-review-backlog.js');

const NOW = new Date('2026-09-15T12:00:00.000Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

function issue(over = {}) {
  return {
    identifier: 'BRO-1',
    title: 'a finished thing',
    url: 'https://linear.app/x/issue/BRO-1',
    priority: 2,
    updatedAt: daysAgo(20),
    state: { name: 'In Review', type: 'started' },
    ...over,
  };
}

describe('isRealInReview', () => {
  test('accepts an In Review issue', () => {
    assert.equal(isRealInReview(issue()), true);
  });

  test('rejects every other state, including the other started-type one', () => {
    for (const name of ['In Progress', 'Todo', 'Backlog', 'Done', 'Canceled']) {
      assert.equal(isRealInReview(issue({ state: { name, type: 'started' } })), false, name);
    }
  });

  test('drops the automated producers that legitimately live in In Review', () => {
    assert.equal(isRealInReview(issue({ title: 'BSC Daily: Workflow repeat-failure: Test Suite' })), false);
    assert.equal(isRealInReview(issue({ title: 'CANARY: touch probe' })), false);
  });

  // Both ship-check reviewers caught this independently. An earlier draft
  // hand-rolled /^(CANARY:|BSC Daily:)/ and this test asserted the "Fix: "
  // variant was owner work. It is not: that is the email-worker's own title
  // for a pipeline-filed row, and every other layer in the repo treats it as
  // pipeline-owned. Live example on the board when this was written: BRO-212.
  // The fix was to stop restating the predicate and import
  // autofix-filed-marker.js's isAutofixFiledIssue instead.
  test('the email-worker "Fix: BSC Daily:" variant is pipeline noise, not owner work', () => {
    assert.equal(isRealInReview(issue({ title: 'Fix: BSC Daily: Workflow repeat-failure: Test Suite' })), false);
  });

  test('a title that merely mentions the words later on is real work', () => {
    assert.equal(isRealInReview(issue({ title: 'Audit why BSC Daily: rows double-file' })), true);
  });

  test('the autofix provenance marker in the description is noise even with a clean title', () => {
    const { AUTOFIX_FILED_MARKER } = require('../../scripts/lib/autofix-filed-marker.js');
    // The real shape linear-issue-create.js writes: a leading PARKED: line.
    assert.equal(
      isRealInReview(issue({ title: 'An ordinary looking title', description: `PARKED: ${AUTOFIX_FILED_MARKER} for row X` })),
      false
    );
  });

  test('an issue that merely QUOTES the marker while discussing the pipeline is real work', () => {
    const { AUTOFIX_FILED_MARKER } = require('../../scripts/lib/autofix-filed-marker.js');
    assert.equal(
      isRealInReview(issue({ title: 'Audit the autofix filer', description: `the filer stamps "${AUTOFIX_FILED_MARKER}"` })),
      true
    );
  });

  test('survives a malformed issue rather than throwing', () => {
    assert.equal(isRealInReview(null), false);
    assert.equal(isRealInReview({}), false);
    assert.equal(isRealInReview({ state: null }), false);
  });
});

describe('buildInReviewRows ranking', () => {
  test('urgent sorts above older non-urgent — an Urgent card must not be buried by age alone', () => {
    const rows = buildInReviewRows(
      [
        issue({ identifier: 'BRO-old', priority: 2, updatedAt: daysAgo(30) }),
        issue({ identifier: 'BRO-urgent', priority: 1, updatedAt: daysAgo(4) }),
      ],
      { now: NOW }
    );
    assert.deepEqual(rows.map((r) => r.title.split(':')[0]), ['BRO-urgent', 'BRO-old']);
  });

  test('oldest first within a tier', () => {
    const rows = buildInReviewRows(
      [
        issue({ identifier: 'BRO-newer', updatedAt: daysAgo(5) }),
        issue({ identifier: 'BRO-older', updatedAt: daysAgo(28) }),
      ],
      { now: NOW }
    );
    assert.deepEqual(rows.map((r) => r.title.split(':')[0]), ['BRO-older', 'BRO-newer']);
  });

  test('an undateable row sorts LAST, never to the top', () => {
    const rows = buildInReviewRows(
      [
        issue({ identifier: 'BRO-nodate', updatedAt: null }),
        issue({ identifier: 'BRO-dated', updatedAt: daysAgo(6) }),
      ],
      { now: NOW }
    );
    assert.deepEqual(rows.map((r) => r.title.split(':')[0]), ['BRO-dated', 'BRO-nodate']);
    assert.equal(rows[1].idleMs, null);
  });

  test('a garbage updatedAt is treated as undateable, not as age zero', () => {
    const [row] = buildInReviewRows([issue({ updatedAt: 'not-a-date' })], { now: NOW });
    assert.equal(row.idleMs, null);
    assert.equal(row.detail, 'finished; idle in review');
  });

  test('an updatedAt in the future clamps to zero rather than going negative', () => {
    const future = new Date(NOW.getTime() + 60 * 60 * 1000).toISOString();
    const [row] = buildInReviewRows([issue({ updatedAt: future })], { now: NOW });
    assert.equal(row.idleMs, 0);
  });

  test('the row carries the identifier and a working url so the owner can click through', () => {
    const [row] = buildInReviewRows([issue({ identifier: 'BRO-282', title: 'No channel tells the owner' })], { now: NOW });
    assert.equal(row.title, 'BRO-282: No channel tells the owner');
    assert.match(row.url, /^https:\/\//);
    assert.match(row.detail, /finished; idle in review 20d/);
  });
});

describe('buildInReviewSection', () => {
  test('returns null when nothing has crossed the idle threshold — no standing zero row', () => {
    assert.equal(buildInReviewSection([issue({ updatedAt: daysAgo(1) })], { now: NOW }), null);
    assert.equal(buildInReviewSection([], { now: NOW }), null);
    assert.equal(buildInReviewSection(null, { now: NOW }), null);
  });

  test('a card younger than the threshold is normal throughput, not a leak', () => {
    const justUnder = new Date(NOW.getTime() - IDLE_AFTER_MS + 1000).toISOString();
    assert.equal(buildInReviewSection([issue({ updatedAt: justUnder })], { now: NOW }), null);
  });

  test('the banner counts EVERY idle item, not just the printed rows', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      issue({ identifier: `BRO-${i}`, updatedAt: daysAgo(20 + i) })
    );
    const s = buildInReviewSection(many, { now: NOW });
    assert.match(s.bannerText, /^30 finished items waiting for your review/);
    assert.equal(s.items.length, 6);
    assert.equal(s.moreCount, 24);
  });

  test('banner calls out urgent and 14d+ counts, the two things that make this actionable', () => {
    const s = buildInReviewSection(
      [
        issue({ identifier: 'BRO-a', priority: 1, updatedAt: daysAgo(28) }),
        issue({ identifier: 'BRO-b', priority: 2, updatedAt: daysAgo(20) }),
        issue({ identifier: 'BRO-c', priority: 2, updatedAt: daysAgo(5) }),
      ],
      { now: NOW }
    );
    assert.equal(s.bannerText, '3 finished items waiting for your review · 1 urgent · oldest 28d · 2 idle 14d+');
  });

  test('singular reads correctly', () => {
    const s = buildInReviewSection([issue({ updatedAt: daysAgo(10) })], { now: NOW });
    assert.match(s.bannerText, /^1 finished item waiting for your review/);
    assert.equal(s.moreCount, 0);
  });

  test('noise and other states never reach the count', () => {
    const s = buildInReviewSection(
      [
        issue({ identifier: 'BRO-real', updatedAt: daysAgo(20) }),
        issue({ identifier: 'BRO-noise', title: 'CANARY: touch probe', updatedAt: daysAgo(20) }),
        issue({ identifier: 'BRO-prog', state: { name: 'In Progress', type: 'started' }, updatedAt: daysAgo(20) }),
      ],
      { now: NOW }
    );
    assert.equal(s.items.length, 1);
    assert.equal(s.items[0].title, 'BRO-real: a finished thing');
    assert.match(s.bannerText, /^1 finished item /);
  });

  test('the shape is renderNamedDigestBlock-compatible', () => {
    const s = buildInReviewSection([issue({ updatedAt: daysAgo(20) })], { now: NOW });
    assert.equal(typeof s.generatedAt, 'string');
    assert.equal(Number.isNaN(new Date(s.generatedAt).getTime()), false);
    assert.equal(typeof s.bannerText, 'string');
    assert.ok(Array.isArray(s.items));
    for (const it of s.items) {
      assert.equal(typeof it.title, 'string');
      assert.equal(typeof it.detail, 'string');
      assert.equal(typeof it.url, 'string');
    }
    assert.equal(typeof s.moreCount, 'number');
  });

  test('the real 2026-09-15 backlog shape reports the numbers that triggered this work', () => {
    // 120 real + 5 noise; 8 urgent; 100 at 14d+.
    const issues = [];
    for (let i = 0; i < 8; i++) issues.push(issue({ identifier: `BRO-u${i}`, priority: 1, updatedAt: daysAgo(20) }));
    for (let i = 0; i < 92; i++) issues.push(issue({ identifier: `BRO-s${i}`, priority: 2, updatedAt: daysAgo(18) }));
    for (let i = 0; i < 20; i++) issues.push(issue({ identifier: `BRO-f${i}`, priority: 2, updatedAt: daysAgo(6) }));
    for (let i = 0; i < 5; i++) issues.push(issue({ identifier: `BRO-n${i}`, title: 'BSC Daily: noise', updatedAt: daysAgo(20) }));
    const s = buildInReviewSection(issues, { now: NOW });
    assert.equal(s.bannerText, '120 finished items waiting for your review · 8 urgent · oldest 20d · 100 idle 14d+');
    assert.equal(s.moreCount, 114);
    // Urgent leads, but does NOT own the whole list: with 8 urgent items the
    // cap hands the last 2 slots to the oldest non-urgent rows. Without this,
    // a standing urgent set monopolises every email forever and the ageing
    // tail — the actual leak — is never seen again.
    assert.equal(s.items.filter((r) => r.urgent).length, 4);
    assert.equal(s.items.filter((r) => !r.urgent).length, 2);
    assert.ok(s.items.slice(0, 4).every((r) => r.urgent), 'urgent still sorts first');
  });

  test('the urgent cap never exceeds the row budget when maxRows is small', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      issue({ identifier: `BRO-u${i}`, priority: 1, updatedAt: daysAgo(20) })
    );
    const s = buildInReviewSection(many, { now: NOW, maxRows: 2 });
    assert.equal(s.items.length, 2);
    assert.equal(s.moreCount, 8);
  });

  test('a long title is truncated so one row cannot swallow the email', () => {
    const [row] = buildInReviewRows([issue({ title: 'x'.repeat(600) })], { now: NOW });
    assert.ok(row.title.length <= MAX_TITLE_CHARS + 'BRO-1: '.length, row.title.length);
    assert.ok(row.title.endsWith('…'));
  });

  test('a missing identifier or title never renders "undefined" into the inbox', () => {
    const [row] = buildInReviewRows(
      [{ url: 'https://linear.app/x', priority: 2, updatedAt: daysAgo(20), state: { name: 'In Review' } }],
      { now: NOW }
    );
    assert.equal(row.title, '(no id): (untitled)');
    assert.doesNotMatch(row.title, /undefined/);
  });
});

describe('owner split (BRO-5433): technical In Review cards are not owner decisions', () => {
  const marked = [
    issue({ identifier: 'BRO-10', title: '👑 OWNER: pick the vendor' }),
    issue({ identifier: 'BRO-11', title: 'DECISION NEEDED: cancel the plan' }),
    issue({ identifier: 'BRO-12', labels: { nodes: [{ name: 'awaiting-owner' }] } }),
  ];
  const technical = [issue({ identifier: 'BRO-20' }), issue({ identifier: 'BRO-21', title: 'fix the scraper' })];

  test('hasOwnerMarker: label, title marker or description marker; plain technical cards have none', () => {
    for (const i of marked) assert.equal(hasOwnerMarker(i), true, i.identifier);
    assert.equal(hasOwnerMarker(issue({ description: 'Why: DECISION NEEDED: pick one' })), true);
    for (const i of technical) assert.equal(hasOwnerMarker(i), false, i.identifier);
  });

  test('hasOwnerMarker: heading-form decision block counts (BRO-6443), settled stub and bare heading do not', () => {
    const real = require('../../scripts/lib/decision-card-parse.js');
    const heading = '## DECISION NEEDED\n\nShip the redesign this week?\n';
    assert.ok(real.findDecisionQuestion(heading), 'shared detector reads the heading form');
    assert.equal(hasOwnerMarker(issue({ description: heading })), true);
    assert.equal(hasOwnerMarker(issue({ description: '## DECISION NEEDED\n\n' })), false);
    assert.equal(hasOwnerMarker(issue({ description: '## DECISION NEEDED (resolved)\n\nNothing.' })), false);
  });

  test('ownerOnly keeps just the owner-marked cards; the default keeps every idle card', () => {
    const all = [...marked, ...technical];
    const ids = (o) => buildInReviewRows(all, { now: NOW, ...o }).map((r) => r.title.split(':')[0]);
    assert.deepEqual(ids({ ownerOnly: true }).sort(), ['BRO-10', 'BRO-11', 'BRO-12']);
    assert.equal(ids({}).length, 5);
    assert.equal(buildInReviewSection(technical, { now: NOW, ownerOnly: true }), null);
  });

  test('countTechnicalInReview counts idle unmarked cards only', () => {
    const fresh = issue({ identifier: 'BRO-30', updatedAt: daysAgo(1) });
    assert.equal(countTechnicalInReview([...marked, ...technical, fresh], { now: NOW }), 2);
    assert.equal(countTechnicalInReview([], { now: NOW }), 0);
  });

  test('enrichForOwnerMarkers: a marker in the body or a comment surfaces; unreadable cards fail toward the owner', async () => {
    const issues = [issue({ identifier: 'BRO-40' }), issue({ identifier: 'BRO-41' }), issue({ identifier: 'BRO-42' }), issue({ identifier: 'BRO-43' })];
    const bodies = {
      'BRO-40': { description: 'DECISION NEEDED: pick one', comments: { nodes: [] } },
      'BRO-41': { description: 'done', comments: { nodes: [{ body: 'report. DECISION NEEDED: approve the vendor' }] } },
      'BRO-42': { description: 'all technical', comments: { nodes: [{ body: 'merged' }] } },
    };
    const graphql = async (_q, { id }) => { if (id === 'BRO-43') throw new Error('boom'); return { issue: bodies[id] }; };
    await enrichForOwnerMarkers(issues, graphql, { now: NOW });
    const ids = buildInReviewRows(issues, { now: NOW, ownerOnly: true }).map((r) => r.title.split(':')[0]).sort();
    assert.deepEqual(ids, ['BRO-40', 'BRO-41', 'BRO-43']);
    assert.equal(countTechnicalInReview(issues, { now: NOW }), 1);
  });
});


describe('owner marker (BRO-6166): a mention is not a request for the owner', () => {
  // Real texts from the 2026-10-24 digest, where both cards were wrongly listed as the owner's.
  const bro5596 = issue({
    identifier: 'BRO-5596',
    title: 'Dispatch flow is DEAD — heartbeat is fine but nothing is being dispatched',
    description: 'The watchdog heartbeat looks healthy, but dispatch itself has stalled — check the 👑 OWNER watchdog tab and linear-next.js/bsc-next.js for a stuck sweep.',
  });
  const bro3425 = issue({
    identifier: 'BRO-3425',
    title: 'Main is always red: split code CI from data-health gates (investigation + 3 structural options)',
    description: 'Option A+C live.',
    commentText: "landed, verified on origin/main). Crown passed to cmux tab '👑 OWNER — main-green keep-green watch (BRO-3425)' with brief ~/Documents/x",
  });

  test('the two real cards that were wrongly shown to the owner are technical', () => {
    assert.equal(hasOwnerMarker(bro5596), false);
    assert.equal(hasOwnerMarker(bro3425), false);
  });

  test('prose that merely contains "owner-only" or "no DECISION NEEDED" or an echoed template is technical', () => {
    for (const text of [
      'Stopped at an owner-only stop; the worker continued.',
      'Owner-only signed links are not touched by this change.',
      'Checked: no DECISION NEEDED here, all technical.',
      'The card template says DECISION NEEDED: <what, one sentence> and this is not one.',
      'DECISION NEEDED: answered: we chose A',
    ]) assert.equal(hasOwnerMarker(issue({ description: text })), false, text);
  });

  test('real owner markers still count: decision line in the body or a comment, OWNER-ONLY: line, crown/OWNER titles, label', () => {
    assert.equal(hasOwnerMarker(issue({ description: 'Why.\nDECISION NEEDED: pick the vendor?' })), true);
    assert.equal(hasOwnerMarker(issue({ commentText: 'Report. DECISION NEEDED: pick A or B' })), true);
    assert.equal(hasOwnerMarker(issue({ commentText: 'report\nDECISION NEEDED: pick the vendor?' })), true);
    assert.equal(hasOwnerMarker(issue({ description: 'OWNER-ONLY: needs the owner login' })), true);
    // the forms the old bare match also caught: (owner) qualifier and dash separators
    assert.equal(hasOwnerMarker(issue({ commentText: 'Report. DECISION NEEDED (owner): pick A or B' })), true);
    assert.equal(hasOwnerMarker(issue({ commentText: 'DECISION NEEDED \u2014 approve the vendor?' })), true);
    assert.equal(hasOwnerMarker(issue({ commentText: 'DECISION NEEDED - none, all technical' })), false);
    assert.equal(hasOwnerMarker(issue({ title: '👑 OWNER — approve homepage' })), true);
    assert.equal(hasOwnerMarker(issue({ title: '❓ 👑 OWNER — approve homepage' })), true);
    assert.equal(hasOwnerMarker(issue({ title: '👑 🤖 OWNER — approve homepage' })), true);
    assert.equal(hasOwnerMarker(issue({ title: 'OWNER: approve homepage' })), true);
    // a crown alone, or a lowercase mention, is not an ask to the owner
    assert.equal(hasOwnerMarker(issue({ title: '👑 fix the scraper' })), false);
    assert.equal(hasOwnerMarker(issue({ title: 'ask the owner about the scraper' })), false);
    assert.equal(hasOwnerMarker(issue({ labels: { nodes: [{ name: 'awaiting-owner' }] } })), true);
    assert.equal(hasOwnerMarker(issue({ ownerMarkerUnknown: true })), true);
  });

  test('a Paused card is never listed as In Review work', () => {
    const paused = issue({ identifier: 'BRO-5597', title: '👑 OWNER: x', state: { name: 'Paused', type: 'backlog' } });
    assert.equal(buildInReviewRows([paused], { now: NOW, ownerOnly: true }).length, 0);
  });

  test('digest Review queue: the two real cards drop out, a real decision card stays', () => {
    const real = issue({ identifier: 'BRO-9001', title: 't', description: 'DECISION NEEDED: pick' });
    const rows = buildInReviewRows([bro5596, bro3425, real], { now: NOW, ownerOnly: true });
    assert.deepEqual(rows.map((r) => r.title.split(':')[0]), ['BRO-9001']);
  });
});
