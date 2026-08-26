// tests/unit/owner-approval-channel.test.mjs — BRO-282 acceptance criteria:
//
//   1. an issue in the awaiting-owner state/label is included in the
//      digest's "needs you" build function with a working issue link
//   2. an issue NOT in that state is excluded (zero-row case)
//   3. visual-qa crop attachment upload is exercised against a fixture and
//      the resulting issue has an attachment
//
// No live Linear calls — (1)/(2) exercise pure logic directly, (3) stubs
// globalThis.fetch the same way tests/unit/linear-client-backoff.test.mjs
// does for scripts/lib/linear-client.js's graphql() transport.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

process.env.LINEAR_API_KEY = process.env.LINEAR_API_KEY || 'test-key-not-used';

const {
  AWAITING_OWNER_LABEL,
  STALE_AFTER_MS,
  isAwaitingOwner,
  waitingSince,
  buildAwaitingOwnerRows,
  buildAwaitingOwnerSection,
  enrichWithComments,
} = require(path.join(REPO, 'scripts/lib/owner-approval-channel.js'));
const linear = require(path.join(REPO, 'scripts/lib/linear-client.js'));

function issueWithLabels(overrides, labelNames) {
  return {
    identifier: 'BRO-5',
    title: 'Show hero (redesign): tier label wraps mid-word at 360-414px',
    url: 'https://linear.app/broadway-scorecard/issue/BRO-5/show-hero-redesign',
    labels: { nodes: labelNames.map((name) => ({ name })) },
    ...overrides,
  };
}

// --- 1. included with a working link ---------------------------------------

test('isAwaitingOwner: true when the issue carries the awaiting-owner label', () => {
  const issue = issueWithLabels({}, [AWAITING_OWNER_LABEL, 'pilot']);
  assert.equal(isAwaitingOwner(issue), true);
});

test('buildAwaitingOwnerRows: includes the labeled issue with a working issue link', () => {
  const issue = issueWithLabels({}, [AWAITING_OWNER_LABEL]);
  const rows = buildAwaitingOwnerRows([issue]);
  assert.equal(rows.length, 1);
  assert.match(rows[0].title, /^BRO-5:/);
  assert.equal(rows[0].url, issue.url);
  assert.match(rows[0].url, /^https:\/\//);
});

test('buildAwaitingOwnerSection: non-empty banner + digest-shaped snapshot when something is waiting', () => {
  const issue = issueWithLabels({}, [AWAITING_OWNER_LABEL]);
  const section = buildAwaitingOwnerSection([issue], { now: new Date('2026-08-17T12:00:00Z') });
  assert.ok(section);
  assert.match(section.bannerText, /1 item waiting on your approval/);
  assert.equal(section.items.length, 1);
  assert.equal(section.generatedAt, '2026-08-17T12:00:00.000Z');
});

// --- 2. excluded / zero-row case --------------------------------------------

test('isAwaitingOwner: false for an issue in ordinary "In Review" with no awaiting-owner label', () => {
  // "In Review" is the generic dispatch-done state every session sets on
  // completion (linear-dispatch.js's seed prompt) — it must NOT by itself
  // trigger the owner-approval channel, or every finished issue would show
  // up as "waiting on you".
  const issue = issueWithLabels({ state: { name: 'In Review', type: 'started' } }, ['pilot']);
  assert.equal(isAwaitingOwner(issue), false);
});

test('buildAwaitingOwnerRows: excludes issues without the label', () => {
  const labeled = issueWithLabels({ identifier: 'BRO-5' }, [AWAITING_OWNER_LABEL]);
  const unlabeled = issueWithLabels({ identifier: 'BRO-6', title: 'unrelated' }, []);
  const rows = buildAwaitingOwnerRows([labeled, unlabeled]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title.startsWith('BRO-5'), true);
});

test('buildAwaitingOwnerSection: returns null (zero-row, digest omits the block) when nothing is waiting', () => {
  const unlabeled = issueWithLabels({}, ['pilot']);
  assert.equal(buildAwaitingOwnerSection([unlabeled]), null);
  assert.equal(buildAwaitingOwnerSection([]), null);
});

// --- BRO-420: stale-age signal (BRO-282 follow-up) --------------------------

const NOW = new Date('2026-08-26T12:00:00Z');

test('waitingSince: prefers the most recent linear-attach-approval.js summary comment over updatedAt', () => {
  const issue = issueWithLabels(
    {
      updatedAt: '2026-08-26T11:00:00Z', // e.g. the owner replied without unlabeling
      comments: {
        nodes: [
          { body: 'Waiting on your approval: 3 visual-qa crops attached above.', createdAt: '2026-08-20T09:00:00Z' },
          { body: 'looks close, one nit', createdAt: '2026-08-21T10:00:00Z' },
          { body: 'Waiting on your approval: 2 visual-qa crops attached above.', createdAt: '2026-08-22T08:00:00Z' },
        ],
      },
    },
    [AWAITING_OWNER_LABEL]
  );
  assert.equal(waitingSince(issue), '2026-08-22T08:00:00Z');
});

test('waitingSince: falls back to issue.updatedAt when no matching comment is present', () => {
  const issue = issueWithLabels({ updatedAt: '2026-08-24T00:00:00Z' }, [AWAITING_OWNER_LABEL]);
  assert.equal(waitingSince(issue), '2026-08-24T00:00:00Z');
});

test('waitingSince: null when neither comments nor updatedAt are available (age unknown, not zero)', () => {
  const issue = issueWithLabels({}, [AWAITING_OWNER_LABEL]);
  assert.equal(waitingSince(issue), null);
});

test('buildAwaitingOwnerRows: an item labeled today is NOT flagged stale', () => {
  const freshIssue = issueWithLabels(
    { identifier: 'BRO-100', updatedAt: '2026-08-26T10:00:00Z' },
    [AWAITING_OWNER_LABEL]
  );
  const [row] = buildAwaitingOwnerRows([freshIssue], { now: NOW });
  assert.equal(row.stale, false);
  assert.doesNotMatch(row.detail, /stale/);
});

test('buildAwaitingOwnerRows: an item untouched for 48h+ IS flagged stale and renders differently', () => {
  const staleIssue = issueWithLabels(
    { identifier: 'BRO-101', updatedAt: '2026-08-20T00:00:00Z' }, // 6+ days before NOW
    [AWAITING_OWNER_LABEL]
  );
  const [row] = buildAwaitingOwnerRows([staleIssue], { now: NOW });
  assert.equal(row.stale, true);
  assert.ok(row.ageMs >= STALE_AFTER_MS);
  assert.match(row.detail, /stale/);
  assert.notEqual(row.detail, 'Waiting on your approval');
});

test('buildAwaitingOwnerRows: sorted oldest-first, so the stalest item leads the digest row', () => {
  const fresh = issueWithLabels(
    { identifier: 'BRO-102', updatedAt: '2026-08-26T09:00:00Z' },
    [AWAITING_OWNER_LABEL]
  );
  const stale = issueWithLabels(
    { identifier: 'BRO-103', updatedAt: '2026-08-18T00:00:00Z' },
    [AWAITING_OWNER_LABEL]
  );
  const unknownAge = issueWithLabels({ identifier: 'BRO-104' }, [AWAITING_OWNER_LABEL]);
  const rows = buildAwaitingOwnerRows([fresh, stale, unknownAge], { now: NOW });
  assert.deepEqual(rows.map((r) => r.title.split(':')[0]), ['BRO-103', 'BRO-102', 'BRO-104']);
});

test('buildAwaitingOwnerSection: banner calls out the stale count when present', () => {
  const stale = issueWithLabels(
    { identifier: 'BRO-105', updatedAt: '2026-08-18T00:00:00Z' },
    [AWAITING_OWNER_LABEL]
  );
  const section = buildAwaitingOwnerSection([stale], { now: NOW });
  assert.match(section.bannerText, /1 item waiting on your approval \(1 stale 48h\+\)/);
});

// End-to-end at the row/section level: BRO-420's actual motivating example
// (owner replies without removing the label, so updatedAt is fresh but the
// original approval ask is stale) must NOT read as fresh just because
// updatedAt was bumped by unrelated activity.
test('buildAwaitingOwnerRows: owner-replied-without-unlabeling still reads as stale via the comment, not the fresher updatedAt', () => {
  const issue = issueWithLabels(
    {
      identifier: 'BRO-106',
      updatedAt: '2026-08-26T11:00:00Z', // bumped an hour before NOW by the reply
      comments: {
        nodes: [
          { body: 'Waiting on your approval: 1 visual-qa crop attached above.', createdAt: '2026-08-18T00:00:00Z' },
          { body: 'looks good, forgot to unlabel', createdAt: '2026-08-26T11:00:00Z' },
        ],
      },
    },
    [AWAITING_OWNER_LABEL]
  );
  const [row] = buildAwaitingOwnerRows([issue], { now: NOW });
  assert.equal(row.stale, true);
  assert.equal(row.waitingSince, '2026-08-18T00:00:00Z');
  assert.match(row.detail, /stale/);
});

// --- enrichWithComments: I/O orchestration, injected getIssue -------------

test('enrichWithComments: merges comments from the injected getIssue for each awaiting-owner issue', async () => {
  const issues = [
    issueWithLabels({ identifier: 'BRO-107' }, [AWAITING_OWNER_LABEL]),
    issueWithLabels({ identifier: 'BRO-108' }, [AWAITING_OWNER_LABEL]),
  ];
  const getIssue = async (identifier) => ({
    comments: { nodes: [{ body: 'Waiting on your approval: x', createdAt: `${identifier}-ts` }] },
  });
  const result = await enrichWithComments(issues, { getIssue });
  assert.equal(result.length, 2);
  assert.equal(result[0].comments.nodes[0].createdAt, 'BRO-107-ts');
  assert.equal(result[1].comments.nodes[0].createdAt, 'BRO-108-ts');
});

test('enrichWithComments: empty input returns empty, no getIssue calls', async () => {
  let called = false;
  const result = await enrichWithComments([], { getIssue: async () => { called = true; } });
  assert.deepEqual(result, []);
  assert.equal(called, false);
});

test('enrichWithComments: a per-issue getIssue failure falls back to that issue unenriched, others unaffected', async () => {
  const issues = [
    issueWithLabels({ identifier: 'BRO-109' }, [AWAITING_OWNER_LABEL]),
    issueWithLabels({ identifier: 'BRO-110' }, [AWAITING_OWNER_LABEL]),
  ];
  const errors = [];
  const getIssue = async (identifier) => {
    if (identifier === 'BRO-109') throw new Error('boom');
    return { comments: { nodes: [{ body: 'Waiting on your approval: x', createdAt: 'ok-ts' }] } };
  };
  const result = await enrichWithComments(issues, { getIssue, onError: (issue, err) => errors.push({ issue, err }) });
  assert.equal(result[0].comments, undefined, 'the errored issue stays unenriched, not crashed');
  assert.equal(result[1].comments.nodes[0].createdAt, 'ok-ts');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].issue.identifier, 'BRO-109');
});

test('enrichWithComments: a whole-batch timeout falls back to the original un-enriched issues', async () => {
  const issues = [issueWithLabels({ identifier: 'BRO-111', updatedAt: '2026-08-20T00:00:00Z' }, [AWAITING_OWNER_LABEL])];
  const getIssue = () => new Promise(() => {}); // never resolves
  let timedOut = false;
  const result = await enrichWithComments(issues, {
    getIssue,
    timeoutMs: 20,
    onError: (issue, err) => {
      if (!issue) timedOut = true;
      assert.match(err.message, /timed out/);
    },
  });
  assert.equal(timedOut, true);
  assert.deepEqual(result, issues);
});

// --- 3. visual-qa crop attachment upload, exercised against a fixture ------

function stubFetchSequence(responders) {
  const original = globalThis.fetch;
  const calls = [];
  let i = 0;
  globalThis.fetch = async (url, opts) => {
    const responder = responders[i++];
    calls.push({ url, opts });
    if (!responder) throw new Error(`no stubbed fetch response for call #${i}`);
    return responder(url, opts);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('attachFileToIssue: uploads a fixture crop and the resulting issue has an attachment', async () => {
  const fixturePath = path.join(REPO, 'tests/fixtures/owner-approval-channel/sample-crop.png');
  const fakeIssue = { id: 'issue-uuid-1', attachments: [] };

  const s = stubFetchSequence([
    // 1. fileUpload mutation (via graphql())
    async () => ({
      status: 200,
      headers: {},
      json: async () => ({
        data: {
          fileUpload: {
            success: true,
            uploadFile: {
              assetUrl: 'https://uploads.linear.app/assets/sample-crop.png',
              uploadUrl: 'https://uploads.linear.app/put/sample-crop.png',
              headers: [{ key: 'x-amz-acl', value: 'public-read' }],
            },
          },
        },
      }),
    }),
    // 2. raw PUT of the file bytes to the signed upload URL
    async (url, opts) => {
      assert.equal(url, 'https://uploads.linear.app/put/sample-crop.png');
      assert.equal(opts.method, 'PUT');
      assert.equal(opts.headers['x-amz-acl'], 'public-read');
      assert.ok(Buffer.isBuffer(opts.body) || opts.body instanceof Uint8Array);
      return { ok: true, status: 200 };
    },
    // 3. attachmentCreate mutation (via graphql())
    async (url, opts) => {
      const body = JSON.parse(opts.body);
      assert.equal(body.variables.input.issueId, fakeIssue.id);
      assert.equal(body.variables.input.url, 'https://uploads.linear.app/assets/sample-crop.png');
      const attachment = { id: 'att-1', url: body.variables.input.url, title: body.variables.input.title };
      fakeIssue.attachments.push(attachment);
      return {
        status: 200,
        headers: {},
        json: async () => ({ data: { attachmentCreate: { success: true, attachment } } }),
      };
    },
  ]);

  try {
    const result = await linear.attachFileToIssue({
      issueId: fakeIssue.id,
      filePath: fixturePath,
      title: 'BRO-5 — sample-crop.png',
    });
    assert.equal(result.id, 'att-1');
    assert.equal(result.url, 'https://uploads.linear.app/assets/sample-crop.png');
    assert.equal(fakeIssue.attachments.length, 1, 'the resulting issue must carry the attachment');
    assert.equal(fakeIssue.attachments[0].title, 'BRO-5 — sample-crop.png');
    assert.equal(s.calls.length, 3, 'fileUpload -> PUT -> attachmentCreate, no more');
  } finally {
    s.restore();
  }
});
