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

const require = createRequire(import.meta.url);
const mod = require('./reconcile-broadcast-state.js');
const { main, SENT_PATH } = mod;

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
    const resp = queue.shift() || { statusCode: 404, body: '' };
    const res = {
      statusCode: resp.statusCode,
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
