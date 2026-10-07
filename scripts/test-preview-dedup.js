#!/usr/bin/env node
/**
 * Tests for scripts/lib/preview-dedup.js
 *
 * Covers the 2026-04-11 duplicate-preview incident and the fix semantics.
 * Run: node scripts/test-preview-dedup.js
 */

const {
  checkPreviewDedup,
  hasRecentPreviewForShow,
  hasRecentOverdueAlert,
} = require('./lib/preview-dedup');

const tests = [
  {
    name: 'no previous preview → send',
    sentData: { shows: {} },
    broadcastKey: 'broadway:foo-2026',
    currentReviewCount: 15,
    now: new Date('2026-04-10T12:00:00Z').getTime(),
    expected: 'send',
  },

  {
    name: 'recent preview, zero new reviews → skip',
    sentData: {
      shows: {
        'preview:broadway:foo-2026:2026-04-10': {
          sentAt: '2026-04-10T12:00:00Z',
          reviewCount: 20,
          previewTo: 'owner@example.com',
        },
      },
    },
    broadcastKey: 'broadway:foo-2026',
    currentReviewCount: 20,
    now: new Date('2026-04-10T18:00:00Z').getTime(),
    expected: 'skip',
  },

  {
    name: 'recent preview, 2 new reviews → skip (below threshold)',
    sentData: {
      shows: {
        'preview:broadway:foo-2026:2026-04-10': {
          sentAt: '2026-04-10T12:00:00Z',
          reviewCount: 20,
        },
      },
    },
    broadcastKey: 'broadway:foo-2026',
    currentReviewCount: 22,
    now: new Date('2026-04-10T18:00:00Z').getTime(),
    expected: 'skip',
  },

  {
    name: 'recent preview, 3+ new reviews → resend',
    sentData: {
      shows: {
        'preview:broadway:foo-2026:2026-04-10': {
          sentAt: '2026-04-10T12:00:00Z',
          reviewCount: 20,
        },
      },
    },
    broadcastKey: 'broadway:foo-2026',
    currentReviewCount: 24,
    now: new Date('2026-04-10T18:00:00Z').getTime(),
    expected: 'resend',
  },

  {
    name: '>24h old preview, zero new reviews → send',
    sentData: {
      shows: {
        'preview:broadway:foo-2026:2026-04-09': {
          sentAt: '2026-04-09T12:00:00Z',
          reviewCount: 20,
        },
      },
    },
    broadcastKey: 'broadway:foo-2026',
    currentReviewCount: 20,
    now: new Date('2026-04-10T18:00:00Z').getTime(),
    expected: 'send',
  },

  {
    name: 'UTC ROLLOVER INCIDENT — 12:16 UTC Apr 10 preview, 02:09 UTC Apr 11 retry, same review count → skip (regression test)',
    sentData: {
      shows: {
        'preview:broadway:death-of-a-salesman-2026:2026-04-10': {
          sentAt: '2026-04-10T12:16:02.177Z',
          previewTo: 'thomas.pryor@gmail.com',
          reviewCount: 24,
        },
      },
    },
    broadcastKey: 'broadway:death-of-a-salesman-2026',
    currentReviewCount: 24,
    now: new Date('2026-04-11T02:09:30Z').getTime(),
    expected: 'skip',
  },

  {
    name: 'multi-day history, most recent within 24h with 3+ new reviews → resend',
    sentData: {
      shows: {
        'preview:broadway:foo-2026:2026-04-08': {
          sentAt: '2026-04-08T12:00:00Z',
          reviewCount: 10,
        },
        'preview:broadway:foo-2026:2026-04-09': {
          sentAt: '2026-04-09T15:00:00Z',
          reviewCount: 18,
        },
      },
    },
    broadcastKey: 'broadway:foo-2026',
    currentReviewCount: 22,
    now: new Date('2026-04-10T10:00:00Z').getTime(),
    expected: 'resend',
  },

  {
    name: 'different show has recent preview → current show still sends',
    sentData: {
      shows: {
        'preview:broadway:other-show-2026:2026-04-10': {
          sentAt: '2026-04-10T12:00:00Z',
          reviewCount: 20,
        },
      },
    },
    broadcastKey: 'broadway:foo-2026',
    currentReviewCount: 15,
    now: new Date('2026-04-10T18:00:00Z').getTime(),
    expected: 'send',
  },

  {
    name: 'different market (west-end) has recent preview for same show slug → broadway still sends',
    sentData: {
      shows: {
        'preview:west-end:foo-2026:2026-04-10': {
          sentAt: '2026-04-10T12:00:00Z',
          reviewCount: 15,
        },
      },
    },
    broadcastKey: 'broadway:foo-2026',
    currentReviewCount: 15,
    now: new Date('2026-04-10T18:00:00Z').getTime(),
    expected: 'send',
  },

  {
    name: 'entry with null sentAt is ignored',
    sentData: {
      shows: {
        'preview:broadway:foo-2026:2026-04-10': { sentAt: null, reviewCount: 20 },
      },
    },
    broadcastKey: 'broadway:foo-2026',
    currentReviewCount: 20,
    now: new Date('2026-04-10T18:00:00Z').getTime(),
    expected: 'send',
  },

  {
    name: 'empty sentData → send',
    sentData: null,
    broadcastKey: 'broadway:foo-2026',
    currentReviewCount: 15,
    now: new Date('2026-04-10T12:00:00Z').getTime(),
    expected: 'send',
  },
];

let passed = 0;
let failed = 0;

for (const t of tests) {
  const result = checkPreviewDedup(t.sentData, t.broadcastKey, t.currentReviewCount, t.now);
  const ok = result.action === t.expected;
  const marker = ok ? '\u2713' : '\u2717';
  console.log(`${marker} ${t.name}`);
  if (!ok) {
    console.log(`  expected action='${t.expected}', got action='${result.action}'`);
    console.log(`  full result:`, JSON.stringify(result, null, 2));
    failed++;
  } else {
    passed++;
  }
}

console.log('');
console.log(`checkPreviewDedup: ${passed}/${tests.length} passed`);

// ---------------------------------------------------------------------------
// hasRecentPreviewForShow — the workflow's "Check already broadcast" gate.
// Mirrors the semantics of the workflow step at opening-night-broadcast.yml.
// Regression lock for the 2026-04-11 UTC-rollover incident (startsWith(today)).
// ---------------------------------------------------------------------------

const workflowTests = [
  {
    name: 'no entries → not blocked',
    sent: {},
    showId: 'titanique-2026',
    now: new Date('2026-04-11T14:00:00Z').getTime(),
    expected: false,
  },
  {
    name: 'preview sent 2h ago → blocked',
    sent: {
      'preview:broadway:titanique-2026:2026-04-11': {
        sentAt: '2026-04-11T12:00:00Z',
        reviewCount: 20,
      },
    },
    showId: 'titanique-2026',
    now: new Date('2026-04-11T14:00:00Z').getTime(),
    expected: true,
  },
  {
    name: 'UTC ROLLOVER INCIDENT — preview at 12:16 UTC Apr 10, workflow check at 02:09 UTC Apr 11 → blocked',
    sent: {
      'preview:broadway:death-of-a-salesman-2026:2026-04-10': {
        sentAt: '2026-04-10T12:16:02.177Z',
        previewTo: 'thomas.pryor@gmail.com',
        reviewCount: 24,
      },
    },
    showId: 'death-of-a-salesman-2026',
    now: new Date('2026-04-11T02:09:30Z').getTime(),
    expected: true,
  },
  {
    name: 'UTC ROLLOVER INCIDENT — preview at 02:09 UTC Apr 11, workflow check at 12:21 UTC Apr 11 → blocked (the actual incident reverse)',
    sent: {
      'preview:broadway:death-of-a-salesman-2026:2026-04-11': {
        sentAt: '2026-04-11T02:09:00Z',
        previewTo: 'thomas.pryor@gmail.com',
        reviewCount: 24,
      },
    },
    showId: 'death-of-a-salesman-2026',
    now: new Date('2026-04-11T12:21:00Z').getTime(),
    expected: true,
  },
  {
    name: 'preview sent 14h ago → still blocked (within 24h default window)',
    sent: {
      'preview:broadway:titanique-2026:2026-04-10': {
        sentAt: '2026-04-10T22:00:00Z',
        reviewCount: 20,
      },
    },
    showId: 'titanique-2026',
    now: new Date('2026-04-11T12:30:00Z').getTime(),
    expected: true,
  },
  {
    name: 'preview sent 25h ago → not blocked (outside 24h window)',
    sent: {
      'preview:broadway:titanique-2026:2026-04-10': {
        sentAt: '2026-04-10T11:00:00Z',
        reviewCount: 20,
      },
    },
    showId: 'titanique-2026',
    now: new Date('2026-04-11T12:30:00Z').getTime(),
    expected: false,
  },
  {
    name: 'preview for a different show → not blocked',
    sent: {
      'preview:broadway:other-show-2026:2026-04-11': {
        sentAt: '2026-04-11T12:00:00Z',
        reviewCount: 20,
      },
    },
    showId: 'titanique-2026',
    now: new Date('2026-04-11T14:00:00Z').getTime(),
    expected: false,
  },
  {
    name: 'preview entry with null sentAt → ignored (not blocked)',
    sent: {
      'preview:broadway:titanique-2026:2026-04-11': {
        sentAt: null,
        reviewCount: 20,
      },
    },
    showId: 'titanique-2026',
    now: new Date('2026-04-11T14:00:00Z').getTime(),
    expected: false,
  },
];

let wfPassed = 0, wfFailed = 0;
for (const t of workflowTests) {
  // Default 24h window — matches workflow caller.
  const got = hasRecentPreviewForShow(t.sent, t.showId, 24 * 3600 * 1000, t.now);
  const ok = got === t.expected;
  console.log(`${ok ? '\u2713' : '\u2717'} [workflow preview] ${t.name}`);
  if (!ok) {
    console.log(`  expected ${t.expected}, got ${got}`);
    wfFailed++;
  } else {
    wfPassed++;
  }
}

console.log('');
console.log(`hasRecentPreviewForShow: ${wfPassed}/${workflowTests.length} passed`);

// ---------------------------------------------------------------------------
// hasRecentOverdueAlert — the workflow's "Alert if broadcast overdue" gate.
// Stable key (`overdue-alert:${id}`), so the test is simpler than the preview one.
// ---------------------------------------------------------------------------

const alertTests = [
  {
    name: 'no alert entry → not blocked',
    sent: {},
    showId: 'titanique-2026',
    now: new Date('2026-04-11T14:00:00Z').getTime(),
    expected: false,
  },
  {
    name: 'alert fired 1h ago → blocked',
    sent: {
      'overdue-alert:titanique-2026': { sentAt: '2026-04-11T13:00:00Z' },
    },
    showId: 'titanique-2026',
    now: new Date('2026-04-11T14:00:00Z').getTime(),
    expected: true,
  },
  {
    name: 'UTC ROLLOVER — alert fired 2h ago but across UTC midnight → blocked',
    sent: {
      'overdue-alert:death-of-a-salesman-2026': { sentAt: '2026-04-10T23:30:00Z' },
    },
    showId: 'death-of-a-salesman-2026',
    now: new Date('2026-04-11T01:30:00Z').getTime(),
    expected: true,
  },
  {
    name: 'alert fired 25h ago → not blocked (outside 24h window)',
    sent: {
      'overdue-alert:titanique-2026': { sentAt: '2026-04-10T13:00:00Z' },
    },
    showId: 'titanique-2026',
    now: new Date('2026-04-11T14:00:00Z').getTime(),
    expected: false,
  },
  {
    name: 'alert entry exists for different show → not blocked',
    sent: {
      'overdue-alert:other-show-2026': { sentAt: '2026-04-11T13:00:00Z' },
    },
    showId: 'titanique-2026',
    now: new Date('2026-04-11T14:00:00Z').getTime(),
    expected: false,
  },
];

let alertPassed = 0, alertFailed = 0;
for (const t of alertTests) {
  const got = hasRecentOverdueAlert(t.sent, t.showId, 24 * 3600 * 1000, t.now);
  const ok = got === t.expected;
  console.log(`${ok ? '\u2713' : '\u2717'} [workflow overdue] ${t.name}`);
  if (!ok) {
    console.log(`  expected ${t.expected}, got ${got}`);
    alertFailed++;
  } else {
    alertPassed++;
  }
}

console.log('');
console.log(`hasRecentOverdueAlert: ${alertPassed}/${alertTests.length} passed`);

const totalFailed = failed + wfFailed + alertFailed;
const totalPassed = passed + wfPassed + alertPassed;
const totalTests = tests.length + workflowTests.length + alertTests.length;
console.log('');
console.log(`TOTAL: ${totalPassed}/${totalTests} passed`);
if (totalFailed > 0) {
  console.error(`${totalFailed} test(s) FAILED`);
  process.exit(1);
}
