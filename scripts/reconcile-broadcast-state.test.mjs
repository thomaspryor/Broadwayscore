import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

// RESEND_API_KEY is read into a module-level const at require time (not
// per-call), so it must be set before the require() below, not just before
// main() runs.
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'fake-key-for-test';
// No real pacing/backoff sleeps in tests (read at require time, same as above).
process.env.RESEND_POLL_INTERVAL_MS = '0';

const require = createRequire(import.meta.url);
const mod = require('./reconcile-broadcast-state.js');
const { main, SENT_PATH, retryDelayMs } = mod;

// Task #1853 (BRO-60 follow-up): reconcile-broadcast-state.js wrote corrected
// draftStatus/sentAt/recipientCount/lastReconciledAt fields to SENT_PATH via a
// raw fs.writeFileSync with NO sync-to-origin call at all. In the hourly cron
// this is masked by the workflow's own push-core-data step, but a manual
// `--show=X` CLI correction left the fix local-only and invisible to CI/other
// sessions until the next scheduled cron overwrote it (or a human happened to
// push the private data repo).
//
// This spins up a fake `gh` binary on PATH (same pattern as
// send-opening-night-broadcast.test.mjs's BRO-60 test) that stands in for
// origin/main, and stubs https.request so getBroadcast() never makes a real
// Resend API call.

function makeFakeGh(remoteFile) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gh-bin-'));
  const ghPath = path.join(binDir, 'gh');
  const script = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const remoteFile = ${JSON.stringify(remoteFile)};

if (args[0] === 'auth' && args[1] === 'status') {
  process.exit(0);
}

if (args[0] === 'api') {
  const rest = args.slice(1);
  const methodIdx = rest.indexOf('--method');
  if (methodIdx !== -1 && rest[methodIdx + 1] === 'PUT') {
    const inputIdx = rest.indexOf('--input');
    const inputFile = rest[inputIdx + 1];
    const payload = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
    const content = Buffer.from(payload.content, 'base64').toString('utf8');
    fs.writeFileSync(remoteFile, content);
    fs.writeFileSync(remoteFile + '.sha', 'sha-' + Date.now());
    process.stdout.write(JSON.stringify({ content: { sha: 'sha-' + Date.now() } }));
    process.exit(0);
  }
  // GET repos/OWNER/REPO/contents/PATH?ref=main
  let existing = '{"shows":{}}';
  let sha = 'initial-sha';
  if (fs.existsSync(remoteFile)) existing = fs.readFileSync(remoteFile, 'utf8');
  if (fs.existsSync(remoteFile + '.sha')) sha = fs.readFileSync(remoteFile + '.sha', 'utf8');
  process.stdout.write(JSON.stringify({ sha, content: Buffer.from(existing, 'utf8').toString('base64') }));
  process.exit(0);
}
process.exit(1);
`;
  fs.writeFileSync(ghPath, script);
  fs.chmodSync(ghPath, 0o755);
  return binDir;
}

// Stands in for a real GET /broadcasts/{id} response so getBroadcast() never
// hits the network. Returns a fake req object matching the subset of the
// http.ClientRequest interface reconcile-broadcast-state.js actually uses.
function fakeHttpsRequest(responses) {
  const queue = [...responses];
  return (_options, callback) => {
    fakeHttpsRequest.calls = (fakeHttpsRequest.calls || 0) + 1;
    const resp = queue.shift() || { statusCode: 404, body: '' };
    const res = {
      statusCode: resp.statusCode,
      headers: resp.headers || {},
      on(event, cb) {
        if (event === 'data' && resp.body) cb(Buffer.from(resp.body));
        if (event === 'end') cb();
      },
    };
    return {
      on() {},
      end() { callback(res); },
      destroy() {},
    };
  };
}

async function withFakeEnv({ localSentData, httpsResponses }, fn) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-origin-'));
  const remoteFile = path.join(workDir, 'origin-opening-night-sent.json');
  const binDir = makeFakeGh(remoteFile);

  const savedPath = process.env.PATH;
  const savedGithubActions = process.env.GITHUB_ACTIONS;
  process.env.PATH = `${binDir}${path.delimiter}${savedPath}`;
  delete process.env.GITHUB_ACTIONS;

  // Divert reads/writes of the real data/opening-night-sent.json to an
  // in-memory fixture — this test must never touch the actual local tracker.
  const realExistsSync = fs.existsSync;
  const realReadFileSync = fs.readFileSync;
  const realWriteFileSync = fs.writeFileSync;
  const localWrites = [];
  fs.existsSync = (p, ...rest) => (p === SENT_PATH ? true : realExistsSync.call(fs, p, ...rest));
  fs.readFileSync = (p, ...rest) => (p === SENT_PATH ? JSON.stringify(localSentData) : realReadFileSync.call(fs, p, ...rest));
  fs.writeFileSync = (p, data, ...rest) => {
    if (p === SENT_PATH) { localWrites.push(data); return undefined; }
    return realWriteFileSync.call(fs, p, data, ...rest);
  };

  const realHttpsRequest = https.request;
  https.request = fakeHttpsRequest(httpsResponses);

  try {
    return await fn({ remoteFile, localWrites });
  } finally {
    fs.existsSync = realExistsSync;
    fs.readFileSync = realReadFileSync;
    fs.writeFileSync = realWriteFileSync;
    https.request = realHttpsRequest;
    process.env.PATH = savedPath;
    if (savedGithubActions === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = savedGithubActions;
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  }
}

test('main(): a local reconcile correction syncs to origin/main, not just local disk', async () => {
  await withFakeEnv(
    {
      localSentData: {
        shows: {
          'giant-2026': {
            draftId: 'broadcast-id-abc',
            draftStatus: 'draft',
            completed: false,
          },
        },
      },
      httpsResponses: [
        {
          statusCode: 200,
          body: JSON.stringify({ id: 'broadcast-id-abc', status: 'sent', sent_at: '2026-04-22T10:05:00Z', total_recipients: 200 }),
        },
      ],
    },
    async ({ remoteFile, localWrites }) => {
      await main();

      assert.equal(localWrites.length, 1, 'expected exactly one local writeFileSync to SENT_PATH');
      const savedLocal = JSON.parse(localWrites[0]);
      assert.equal(savedLocal.shows['giant-2026'].draftStatus, 'sent');

      assert.ok(fs.existsSync(remoteFile), 'expected the reconcile correction to reach origin/main via syncTrackerToOrigin');
      const origin = JSON.parse(fs.readFileSync(remoteFile, 'utf8'));
      assert.ok(origin.shows['giant-2026'], 'origin state missing the reconciled show entry');
      assert.equal(origin.shows['giant-2026'].draftStatus, 'sent', 'origin entry must reflect the reconciled status, not the stale draft state');
      assert.equal(origin.shows['giant-2026'].recipientCount, 200);
    },
  );
});

test('main(): a stale local copy of an untouched (already-terminal) show never clobbers its fresher origin state', async () => {
  // The real-world failure this guards against: data/opening-night-sent.json
  // is gitignored and can be stale on the machine running a manual CLI
  // reconcile — nothing refreshes it besides a manual checkout-core-data pull
  // — while the hourly cron (or a later manual fix) keeps writing fresher
  // state to origin for shows this run never touches. 'other-show-2026' is
  // already terminal (draftStatus:'sent' + sentAt) so main() skips it
  // entirely (no re-poll, per the "Terminal success" comment) — but its
  // local recipientCount here is stale (150) versus origin's corrected value
  // (300). If main() synced the WHOLE local `shows` table (not just what it
  // re-verified this run), mergeTrackerEntries' whole-key last-write-wins
  // would silently roll origin's 300 back to this stale local 150.
  await withFakeEnv(
    {
      localSentData: {
        shows: {
          'giant-2026': { draftId: 'broadcast-id-abc', draftStatus: 'draft', completed: false },
          'other-show-2026': {
            draftId: 'broadcast-id-other',
            draftStatus: 'sent',
            sentAt: '2026-04-22T09:00:00Z',
            recipientCount: 150, // stale on this machine
            completed: true,
          },
        },
      },
      httpsResponses: [
        { statusCode: 200, body: JSON.stringify({ id: 'broadcast-id-abc', status: 'sent', sent_at: '2026-04-22T10:05:00Z', total_recipients: 200 }) },
      ],
    },
    async ({ remoteFile }) => {
      fs.writeFileSync(remoteFile, JSON.stringify({
        shows: {
          'other-show-2026': {
            draftId: 'broadcast-id-other',
            draftStatus: 'sent',
            sentAt: '2026-04-22T09:00:00Z',
            recipientCount: 300, // corrected fresher value already on origin
            completed: true,
          },
        },
      }));
      fs.writeFileSync(remoteFile + '.sha', 'preexisting-sha');

      await main();

      const origin = JSON.parse(fs.readFileSync(remoteFile, 'utf8'));
      assert.equal(origin.shows['giant-2026'].draftStatus, 'sent', 'the actually-reconciled show must reach origin');
      assert.equal(
        origin.shows['other-show-2026'].recipientCount,
        300,
        'an untouched (skipped, terminal) show must keep its fresher origin value, not get rolled back by this run\'s stale local copy',
      );
    },
  );
});

// BRO-4474: School Girls (sent from the Resend UI 2026-09-29 18:55 UTC) is
// recorded under `broadway:<id>` AND a per-show mirror with the same draftId.
// The reconciler polled both back to back; Resend 429'd the mirror's GET on
// the 9/29 and 9/30 runs ("10 requests per second"), the mirror stayed
// `draft`, and check-missed-broadcasts paged the owner for an email they had
// sent. One GET per draftId, retried on 429, must update every mirror.
test('main(): mirrors sharing a draftId are polled once, and a 429 is retried, not left stale', async () => {
  fakeHttpsRequest.calls = 0;
  await withFakeEnv(
    {
      localSentData: {
        shows: {
          'broadway:school-girls-2026': { draftId: 'sg-draft', draftStatus: 'draft', completed: true, draftCreatedAt: '2026-09-29T18:50:29.729Z' },
          'school-girls-2026': { draftId: 'sg-draft', draftStatus: 'draft', completed: true, draftCreatedAt: '2026-09-29T18:50:29.729Z', broadcastKey: 'broadway:school-girls-2026' },
        },
      },
      httpsResponses: [
        { statusCode: 429, headers: { 'retry-after': '1' }, body: '{"statusCode":429,"message":"Too many requests."}' },
        { statusCode: 200, body: JSON.stringify({ id: 'sg-draft', status: 'sent', sent_at: '2026-09-29 18:55:52.397843+00' }) },
      ],
    },
    async ({ localWrites }) => {
      await main();
      const saved = JSON.parse(localWrites[0]);
      assert.equal(saved.shows['broadway:school-girls-2026'].draftStatus, 'sent');
      assert.equal(saved.shows['school-girls-2026'].draftStatus, 'sent', 'the per-show mirror must not be left at draft');
      assert.equal(fakeHttpsRequest.calls, 2, 'one 429 + one retry; the mirror reuses the poll instead of a third GET');
    },
  );
});

test('retryDelayMs: honors Retry-After seconds (capped), else exponential backoff', () => {
  assert.equal(retryDelayMs(0, '2', 250), 2000);
  assert.equal(retryDelayMs(0, '600', 250), 10_000);
  assert.equal(retryDelayMs(0, undefined, 250), 500);
  assert.equal(retryDelayMs(2, undefined, 250), 2000);
  assert.equal(retryDelayMs(10, undefined, 250), 10_000);
});

// BRO-4474 review: the sent twin is terminal and skipped, so the stale mirror
// used to be polled alone; after Resend's ~24h reap that poll 404s and the
// mirror flips to deleted + completed:false (re-queueable). The sibling's
// observed send must be copied over with no GET at all.
test('main(): a stale mirror inherits its sibling\'s observed send without polling (survives the post-reap 404)', async () => {
  fakeHttpsRequest.calls = 0;
  await withFakeEnv(
    {
      localSentData: {
        shows: {
          'broadway:sg-2026': { draftId: 'sg', draftStatus: 'sent', sentAt: '2026-09-29 18:55:52.397843+00', completed: true, recipientCount: 812, draftCreatedAt: '2026-09-29T18:50:29.729Z' },
          'sg-2026': { draftId: 'sg', draftStatus: 'draft', sentAt: null, completed: true, draftCreatedAt: '2026-09-29T18:50:29.729Z', broadcastKey: 'broadway:sg-2026' },
        },
      },
      httpsResponses: [{ statusCode: 404, body: '' }],
    },
    async ({ localWrites }) => {
      await main();
      const m = JSON.parse(localWrites[0]).shows['sg-2026'];
      assert.equal(m.draftStatus, 'sent');
      assert.equal(m.completed, true);
      assert.equal(m.sentAt, '2026-09-29 18:55:52.397843+00');
      assert.equal(m.recipientCount, 812);
      assert.equal(fakeHttpsRequest.calls, 0, 'no GET: the 404 must never be consulted');
    },
  );
});

test('main(): --show=X also reconciles the other records sharing X\'s draftId', async () => {
  fakeHttpsRequest.calls = 0;
  const savedArgv = process.argv;
  // showFilter is parsed at require time, so load a fresh module instance.
  process.argv = [...savedArgv.slice(0, 2), '--show=sg-2026'];
  delete require.cache[require.resolve('./reconcile-broadcast-state.js')];
  const fresh = require('./reconcile-broadcast-state.js');
  process.argv = savedArgv;
  try {
    await withFakeEnv(
      {
        localSentData: {
          shows: {
            'broadway:sg-2026': { draftId: 'sg', draftStatus: 'draft', completed: true },
            'sg-2026': { draftId: 'sg', draftStatus: 'draft', completed: true, broadcastKey: 'broadway:sg-2026' },
            'unrelated-2026': { draftId: 'zz', draftStatus: 'draft', completed: true },
          },
        },
        httpsResponses: [{ statusCode: 200, body: JSON.stringify({ id: 'sg', status: 'sent', sent_at: '2026-09-29T18:55:52Z' }) }],
      },
      async ({ localWrites }) => {
        await fresh.main();
        const out = JSON.parse(localWrites[0]).shows;
        assert.equal(out['sg-2026'].draftStatus, 'sent');
        assert.equal(out['broadway:sg-2026'].draftStatus, 'sent', 'the broadway: twin must not be left behind');
        assert.equal(out['unrelated-2026'].draftStatus, 'draft', 'unfiltered drafts stay untouched');
        assert.equal(fakeHttpsRequest.calls, 1);
      },
    );
  } finally {
    delete require.cache[require.resolve('./reconcile-broadcast-state.js')];
  }
});
