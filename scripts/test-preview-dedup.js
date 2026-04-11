#!/usr/bin/env node
/**
 * Tests for scripts/lib/preview-dedup.js
 *
 * Covers the 2026-04-11 duplicate-preview incident and the fix semantics.
 * Run: node scripts/test-preview-dedup.js
 */

const { checkPreviewDedup } = require('./lib/preview-dedup');

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
console.log(`${passed}/${tests.length} passed`);
if (failed > 0) {
  console.error(`${failed} test(s) FAILED`);
  process.exit(1);
}
