import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSyncStdinFile } from '../helpers/spawn-stdin-file.mjs';
import { realNowMs } from '../helpers/clock-shift.mjs';

const require = createRequire(import.meta.url);
const { notifyBlockedApproval, issueFromContext, findCrops, main } = require('../../scripts/lib/linear-attach-approval.js');
const root = fileURLToPath(new URL('../../', import.meta.url));
const hook = join(root, '.claude/hooks/pre-push-visual-gate.sh');
const logger = { log() {}, error() {} };

function fixture(t, branch = 'codex/bro-419', workspace = 'repo') {
  const temp = mkdtempSync(join(tmpdir(), 'bro419-'));
  t.after(() => rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const repo = join(temp, workspace);
  const home = join(temp, 'home');
  mkdirSync(repo);
  mkdirSync(home);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('GIT_') && !key.startsWith('VISUAL_QA_') && key !== 'NODE_OPTIONS'));
  Object.assign(env, { HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', CLAUDE_LOG_DIR: join(temp, 'logs') });
  const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  for (const [key, value] of Object.entries({ 'user.name': 'Test', 'user.email': 'test@example.com', 'commit.gpgsign': 'false', 'gc.auto': '0', 'maintenance.auto': 'false' })) git('config', key, value);
  writeFileSync(join(repo, 'README.md'), 'base\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '-qb', branch);
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src/Widget.tsx'), 'export const Widget = () => <div className="p-4" />;\n');
  git('add', '.');
  git('commit', '-qm', 'UI change');
  symlinkSync(join(root, 'scripts'), join(repo, 'scripts'), 'dir');
  const dir = join(repo, '.claude/visual-qa', branch);
  mkdirSync(join(dir, 'home'), { recursive: true });
  const verdict = { schemaVersion: 2, overallPass: true, contentHash: 'current-hash' };
  const writeVerdict = (extra = {}) => writeFileSync(join(dir, 'verdict.json'), JSON.stringify({ ...verdict, ...extra }));
  writeVerdict();
  // Pixels are irrelevant to routing. Include both page captures and nested crops.
  writeFileSync(join(dir, 'home/360.png'), 'page');
  writeFileSync(join(dir, 'home/360__card.png'), 'mobile crop');
  writeFileSync(join(dir, 'home/1440__card.jpg'), 'desktop crop');
  return { temp, repo, branch, dir, env, git, writeVerdict };
}

function fakeClient(events, fail = false) {
  return {
    async getIssue(id) { events.push(['issue', id]); if (fail === 'hang') return new Promise(() => {}); return { id }; },
    async getTeam() { return { id: 'team' }; },
    async findOrCreateLabel(team, name) { events.push(['label', name]); return { id: name }; },
    async addLabelToIssue(issue, label) { events.push(['labeled', issue, label]); },
    async attachFileToIssue(args) { events.push(['crop', args.filePath]); if (fail) throw new Error('upload unavailable'); return { url: 'https://example.test/crop' }; },
    async createComment(issue, body) { events.push(['comment', issue, body]); },
    async listIssueComments(ids) { return new Map(ids.map((id) => [id, []])); },
  };
}

// Exercise the actual hook, CLI and attachment code; replace only external Linear I/O.
function installClient(fx, fail = false) {
  const events = join(fx.temp, 'events.jsonl');
  const preload = join(fx.temp, 'linear-client.cjs');
  writeFileSync(preload, `
const fs = require('fs');
const client = require(${JSON.stringify(join(root, 'scripts/lib/linear-client.js'))});
const events = [];
events.push = function(row) { fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify(row) + '\\n'); };
Object.assign(client, (${fakeClient.toString()})(events, ${JSON.stringify(fail)}));
`);
  return { events, env: { ...fx.env, NODE_OPTIONS: `--require=${preload}` } };
}

function runHook(fx, { user = 'Please check the spacing', command = `git push origin ${fx.branch}`, fail = false } = {}) {
  const { events, env } = installClient(fx, fail);
  const transcript = join(fx.temp, 'transcript.jsonl');
  writeFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: user } }) + '\n');
  const result = spawnSyncStdinFile('bash', [hook], {
    cwd: fx.repo, encoding: 'utf8', timeout: 60_000,
    env,
    input: JSON.stringify({ tool_input: { command }, transcript_path: transcript, session_id: 'bro419-test' }),
  });
  assert.ifError(result.error);
  return { ...result, events: existsSync(events) ? readFileSync(events, 'utf8').trim().split('\n').map(JSON.parse) : [] };
}

test('blocked UI push attaches current crops and labels the branch issue, once', (t) => {
  const fx = fixture(t);
  const first = runHook(fx);
  assert.equal(first.status, 2, first.stderr);
  assert.match(first.stderr, /owner channel: attached \(BRO-419\)/);
  assert.deepEqual(first.events.slice(0, 3), [['issue', 'BRO-419'], ['label', 'awaiting-owner'], ['labeled', 'BRO-419', 'awaiting-owner']]);
  assert.deepEqual(first.events.filter(([type]) => type === 'crop').map(([, file]) => file).sort(), findCrops(fx.dir));
  assert.match(first.events.at(-1)[2], /^Waiting on your approval: 2/);
  const second = runHook(fx);
  assert.equal(second.status, 2);
  assert.match(second.stderr, /already-attached/);
  assert.equal(second.events.length, first.events.length, 'a repeated push must not call Linear');
});

test('workspace name supplies issue for current branch, but not an explicit other branch', (t) => {
  const fx = fixture(t, 'feature', 'job-linear-BRO-406-msxc1v2h');
  assert.equal(issueFromContext('feature', fx.repo), 'BRO-406');
  assert.equal(issueFromContext('main', fx.repo), null);
  const result = runHook(fx);
  assert.equal(result.status, 2, result.stderr);
  assert.deepEqual(result.events[0], ['issue', 'BRO-406']);
});

test('issue extraction rejects ambiguous/malformed names and prefers explicit branch', (t) => {
  const fx = fixture(t, 'feature', 'job-linear-BRO-406-msxc1v2h');
  for (const branch of ['codex/BRO-12-BRO-13', 'BRO-12abc', 'xBRO-12', 'BRO-0']) assert.equal(issueFromContext(branch, fx.repo), null, branch);
  assert.equal(issueFromContext('fix/BRO-419', fx.repo), 'BRO-419');
  assert.equal(issueFromContext('fix/BRO-419-BRO-419', fx.repo), 'BRO-419');
});

test('failed upload keeps push blocked and retries without a success marker', (t) => {
  const fx = fixture(t);
  const failed = runHook(fx, { fail: true });
  assert.equal(failed.status, 2, failed.stderr);
  assert.match(failed.stderr, /Could not attach approval evidence/);
  assert.equal(existsSync(join(fx.dir, '.linear-approval.json')), false);
  assert.equal(existsSync(join(fx.dir, '.linear-approval.lock')), false);
  assert.match(failed.events.at(-1)[2], /^Waiting on your approval: 0 of 2/);
  assert.match(runHook(fx).stderr, /owner channel: attached/);
});

test('approved and bypassed pushes do not notify Linear', (t) => {
  const fx = fixture(t);
  for (const options of [{ command: `git push origin ${fx.branch} # NO-VERIFY: inspected this change manually` }, { user: 'ship it' }]) {
    const result = runHook(fx, options);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.events.length, 0);
  }
});

test('missing/stale/failed verdicts and missing crops do not notify', (t) => {
  const fx = fixture(t);
  for (const extra of [{ schemaVersion: 1 }, { contentHash: '' }, { overallPass: false }]) {
    fx.writeVerdict(extra);
    const result = runHook(fx);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.events.length, 0);
  }
  fx.writeVerdict();
  rmSync(join(fx.dir, 'home'), { recursive: true });
  assert.equal(runHook(fx).events.length, 0);
  rmSync(join(fx.dir, 'verdict.json'));
  assert.equal(runHook(fx).events.length, 0);
});

test('non-issue branches stay blocked without external calls', (t) => {
  const fx = fixture(t, 'feature');
  const result = runHook(fx);
  assert.equal(result.status, 2);
  assert.equal(result.events.length, 0);
});

test('changed crop bytes and verdict hashes each trigger fresh evidence', async (t) => {
  const fx = fixture(t);
  const events = [];
  const deps = { client: fakeClient(events), logger };
  assert.equal((await notifyBlockedApproval(fx, deps)).status, 'attached');
  assert.equal((await notifyBlockedApproval(fx, deps)).status, 'already-attached');
  writeFileSync(join(fx.dir, 'home/360__card.png'), 'changed pixels');
  assert.equal((await notifyBlockedApproval(fx, deps)).status, 'attached');
  fx.writeVerdict({ contentHash: 'new-hash' });
  assert.equal((await notifyBlockedApproval(fx, deps)).status, 'attached');
  assert.equal(events.filter(([type]) => type === 'comment').length, 3);
});

test('concurrent uploads skip and expired locks recover after a killed process', async (t) => {
  const fx = fixture(t);
  const events = [];
  const client = fakeClient(events);
  const lock = join(fx.dir, '.linear-approval.lock');
  let release;
  client.getIssue = () => new Promise((resolveIssue) => { release = () => resolveIssue({ id: 'BRO-419' }); });
  const first = notifyBlockedApproval(fx, { client, logger });
  // The in-process reader uses the audit's clock; filesystem mtimes do not.
  const acquired = new Date();
  utimesSync(lock, acquired, acquired);
  assert.equal((await notifyBlockedApproval(fx, { client, logger })).reason, 'upload already in progress');
  release();
  await first;
  rmSync(join(fx.dir, '.linear-approval.json'));
  writeFileSync(lock, '');
  const expired = new Date(Date.now() - 100_000);
  utimesSync(lock, expired, expired);
  assert.equal((await notifyBlockedApproval(fx, { client: fakeClient(events), logger })).status, 'attached');
});

test('parallel processes reclaim an expired lease without duplicate uploads', async (t) => {
  const fx = fixture(t);
  const { env, events } = installClient(fx);
  const lock = join(fx.dir, '.linear-approval.lock');
  writeFileSync(lock, '');
  // Spawned CLI readers do not inherit the audit's --import clock preload.
  const expired = new Date(realNowMs() - 100_000);
  utimesSync(lock, expired, expired);
  await Promise.all(Array.from({ length: 8 }, () => new Promise((resolveChild, reject) => {
    const child = spawn(process.execPath, [join(root, 'scripts/lib/linear-attach-approval.js'), `--branch=${fx.branch}`, `--repo=${fx.repo}`, `--dir=${fx.dir}`], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolveChild() : reject(new Error(stderr)));
  })));
  const rows = readFileSync(events, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(([type]) => type === 'issue').length, 1);
  assert.equal(rows.filter(([type]) => type === 'crop').length, 2);
});

test('a hung Linear request times out and the actual hook still blocks', (t) => {
  const fx = fixture(t);
  const result = runHook(fx, { fail: 'hang' });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /Linear approval attachment timed out/);
  assert.equal(existsSync(join(fx.dir, '.linear-approval.json')), false);
});

test('manual CLI implementation retains argument parsing, recursive crops and error propagation', async (t) => {
  const fx = fixture(t);
  const events = [];
  await main(['--issue=BRO-419', `--dir=${fx.dir}`], { client: fakeClient(events), logger });
  assert.equal(events.filter(([type]) => type === 'crop').length, 2);
  await assert.rejects(main([], { logger }), /Usage:/);
  await assert.rejects(main(['--issue=BRO-419', `--dir=${resolve(fx.dir, 'missing')}`], { logger }), /No crop images/);
});

// BRO-6539: BRO-4303 got a second "Waiting on your approval" 2.5h after the owner approved,
// because the only dedupe was a marker file in one worktree.
test('a card that already carries this evidence gets no new ask; an old legacy approval does not vouch for new evidence', async (t) => {
  const approved = fixture(t);
  const events = [];
  const client = fakeClient(events);
  client.listIssueComments = async () => new Map([['BRO-419', [
    { body: 'Waiting on your approval: 2 visual-qa crops attached above.', createdAt: '2026-10-29T12:00:00Z' },
    { body: '**Owner decision** (answered by the owner through the email link, 2026-10-29 UTC)\n\nChose: Approve', createdAt: '2026-10-29T14:33:00Z' },
  ]]]);
  const result = await notifyBlockedApproval(approved, { client, logger });
  assert.equal(result.status, 'attached');

  // Fresh worktree, no local marker: the card's own fingerprint stops the repeat.
  const fresh = fixture(t);
  const ev2 = [];
  const c2 = fakeClient(ev2);
  const comments = [];
  c2.createComment = async (issue, body) => { ev2.push(['comment', issue, body]); comments.push({ body, createdAt: new Date().toISOString() }); };
  c2.listIssueComments = async () => new Map([['BRO-419', comments]]);
  assert.equal((await notifyBlockedApproval(fresh, { client: c2, logger })).status, 'attached');
  rmSync(join(fresh.dir, '.linear-approval.json'));
  const again = await notifyBlockedApproval(fresh, { client: c2, logger });
  assert.equal(again.status, 'skipped');
  assert.match(again.reason, /already on the card/);
  assert.equal(ev2.filter(([type]) => type === 'comment').length, 1);
});
