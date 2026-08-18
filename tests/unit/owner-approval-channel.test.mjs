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
  isAwaitingOwner,
  buildAwaitingOwnerRows,
  buildAwaitingOwnerSection,
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
