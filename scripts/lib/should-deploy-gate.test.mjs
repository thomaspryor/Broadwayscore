// Colocated tests for the content-aware should-deploy gate (vercel-deploy.yml).
// Runs in the scripts/lib/*.test.mjs glob batch in test.yml.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decide, classifyDiffExit, SITE_PATHS, STALENESS_BACKSTOP_SEC } = require('./should-deploy-gate.js');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

const base = {
  eventName: 'schedule',
  gateDisabled: false,
  baselineSha: A,
  deployAgeSec: 600,
  headSha: B,
  diffResult: 'clean',
};

test('schedule: baseline == HEAD skips (no-new-commits)', () => {
  const r = decide({ ...base, headSha: A });
  assert.deepEqual(r, { proceed: false, reason: 'no-new-commits' });
});

test('schedule: unknown baseline fails OPEN (deploys)', () => {
  const r = decide({ ...base, baselineSha: null });
  assert.equal(r.proceed, true);
  assert.equal(r.reason, 'no-baseline-fail-open');
});

test('schedule: clean site diff + fresh deploy skips (content-gate)', () => {
  const r = decide({ ...base });
  assert.deepEqual(r, { proceed: false, reason: 'content-gate' });
});

// BRO-554: the "skip if deployed within 30 min" intent, delivered by the
// content-aware gate (stronger: it skips for the whole 6h window while nothing
// site-relevant changed). A cron tick inside 30 min of a live deploy must never
// rebuild when the site and core data are unchanged, and must still ship a real change.
test('BRO-554: ticks within 30 min of a live deploy skip when nothing changed, ship when something did', () => {
  for (const deployAgeSec of [60, 5 * 60, 15 * 60, 29 * 60]) {
    assert.deepEqual(decide({ ...base, deployAgeSec }), { proceed: false, reason: 'content-gate' }, `age ${deployAgeSec}s`);
    assert.equal(decide({ ...base, deployAgeSec, diffResult: 'dirty' }).proceed, true, `dirty at ${deployAgeSec}s must ship`);
  }
});

test('schedule: dirty site diff deploys (content-changed)', () => {
  const r = decide({ ...base, diffResult: 'dirty' });
  assert.deepEqual(r, { proceed: true, reason: 'content-changed' });
});

test('schedule: staleness backstop fires at >6h even with clean diff (seconds math)', () => {
  // check-prod-deploy.js --json returns ageSec (already converted from Vercel's
  // epoch-ms createdAt) — assert exact-boundary semantics so an ms/sec mixup or
  // an off-by-one can never silently disable the backstop.
  const atBoundary = decide({ ...base, deployAgeSec: STALENESS_BACKSTOP_SEC });
  assert.equal(atBoundary.proceed, false, '6h exactly is NOT stale');
  const past = decide({ ...base, deployAgeSec: STALENESS_BACKSTOP_SEC + 1 });
  assert.deepEqual(past, { proceed: true, reason: 'staleness-backstop' });
  assert.equal(STALENESS_BACKSTOP_SEC, 21600);
});

test('schedule: unknown deploy age fails OPEN', () => {
  const r = decide({ ...base, deployAgeSec: null });
  assert.deepEqual(r, { proceed: true, reason: 'no-age-fail-open' });
});

test('schedule: diff error fails OPEN', () => {
  for (const diffResult of ['error', null, undefined]) {
    const r = decide({ ...base, diffResult });
    assert.equal(r.proceed, true, `diffResult=${diffResult} must fail open`);
  }
});

test('workflow_dispatch: proceeds unless SHA already live', () => {
  assert.deepEqual(
    decide({ ...base, eventName: 'workflow_dispatch', diffResult: null }),
    { proceed: true, reason: 'explicit-ship' }
  );
  // 'already-live' dedup requires a POSITIVELY clean data signal — see the
  // BRO-3149 code-review fix test below for the unknown-signal case.
  assert.deepEqual(
    decide({ ...base, eventName: 'workflow_dispatch', headSha: A, dataDiffResult: 'clean' }),
    { proceed: false, reason: 'already-live' }
  );
});

test('workflow_dispatch: Vercel API down still ships (no dedup possible)', () => {
  const r = decide({ ...base, eventName: 'workflow_dispatch', baselineSha: null, deployAgeSec: null });
  assert.equal(r.proceed, true);
});

test('workflow_run: same semantics as dispatch', () => {
  assert.equal(decide({ ...base, eventName: 'workflow_run' }).proceed, true);
  assert.equal(decide({ ...base, eventName: 'workflow_run', headSha: A, dataDiffResult: 'clean' }).proceed, false);
});

// Codex adversarial /code-review (BRO-3149, post-merge): the non-schedule
// dedup branch used to treat an UNKNOWN dataDiffResult exactly like a
// positively-clean one and skip — reproducing the original bug via the
// workflow_run/workflow_dispatch lane instead of the schedule lane (this is
// the trigger rebuild-fast.yml's direct post-push dispatch uses, arguably
// the highest-value path for this fix). Unknown status must fail OPEN here,
// unlike the schedule branch (which has an age-gated backstop to lean on
// instead of a blanket fail-open).
test('workflow_dispatch: HEAD already live, data status UNKNOWN — fails open (does not silently dedup)', () => {
  for (const dataDiffResult of ['error', null, undefined]) {
    const r = decide({ ...base, eventName: 'workflow_dispatch', headSha: A, dataDiffResult });
    assert.deepEqual(r, { proceed: true, reason: 'data-unknown-fail-open' });
  }
});

test('workflow_run: HEAD already live, data status UNKNOWN — fails open (same lane rebuild-fast.yml dispatches through)', () => {
  const r = decide({ ...base, eventName: 'workflow_run', headSha: A, dataDiffResult: 'error' });
  assert.deepEqual(r, { proceed: true, reason: 'data-unknown-fail-open' });
});

// BRO-3149: reviews.json/shows.json live in the private core-data repo and
// never touch this repo's git tree, so the site-path diff alone is blind to
// a core-data-only change. dataDiffResult carries that signal in separately —
// see should-deploy-gate.js header comment for the full incident writeup.
test('schedule: core data advanced but web HEAD did not — still proceeds (data-changed)', () => {
  const r = decide({ ...base, diffResult: 'clean', dataDiffResult: 'dirty' });
  assert.deepEqual(r, { proceed: true, reason: 'data-changed' });
});

test('schedule: baseline == HEAD but core data advanced — still proceeds (data-changed)', () => {
  const r = decide({ ...base, headSha: A, dataDiffResult: 'dirty' });
  assert.deepEqual(r, { proceed: true, reason: 'data-changed' });
});

test('schedule: neither site nor core data changed — skips (content-gate)', () => {
  const r = decide({ ...base, diffResult: 'clean', dataDiffResult: 'clean' });
  assert.deepEqual(r, { proceed: false, reason: 'content-gate' });
});

test('schedule: data diff lookup unavailable falls through to site-diff signal unchanged', () => {
  for (const dataDiffResult of ['error', null, undefined]) {
    const clean = decide({ ...base, diffResult: 'clean', dataDiffResult });
    assert.deepEqual(clean, { proceed: false, reason: 'content-gate' });
    const dirty = decide({ ...base, diffResult: 'dirty', dataDiffResult });
    assert.deepEqual(dirty, { proceed: true, reason: 'content-changed' });
  }
});

test('workflow_dispatch: already-live dedup still fires when core data has NOT advanced', () => {
  const r = decide({ ...base, eventName: 'workflow_dispatch', headSha: A, dataDiffResult: 'clean' });
  assert.deepEqual(r, { proceed: false, reason: 'already-live' });
});

test('workflow_dispatch: HEAD already live but core data advanced — proceeds (data-changed)', () => {
  const r = decide({ ...base, eventName: 'workflow_dispatch', headSha: A, dataDiffResult: 'dirty' });
  assert.deepEqual(r, { proceed: true, reason: 'data-changed' });
});

// Codex adversarial review (BRO-3149): the `baselineSha === headSha` branch
// used to return before the staleness-backstop age check ever ran. A
// persistently-broken data lookup (missing token, API outage) combined with
// a genuinely idle public repo could therefore strand core-data staleness
// indefinitely — the ONE case in this file where an unknown signal used to
// bypass the 6h backstop entirely rather than falling back to it.
test('schedule: baseline == HEAD, data status unknown, deploy is stale — backstop still fires', () => {
  const r = decide({ ...base, headSha: A, dataDiffResult: 'error', deployAgeSec: STALENESS_BACKSTOP_SEC + 1 });
  assert.deepEqual(r, { proceed: true, reason: 'staleness-backstop' });
});

test('schedule: baseline == HEAD, data status unknown, deploy is fresh — still skips (no false proceed)', () => {
  const r = decide({ ...base, headSha: A, dataDiffResult: 'error', deployAgeSec: 600 });
  assert.deepEqual(r, { proceed: false, reason: 'no-new-commits' });
});

test('schedule: baseline == HEAD, data positively clean, deploy is stale — skips WITHOUT checking age (genuine no-op)', () => {
  const r = decide({ ...base, headSha: A, dataDiffResult: 'clean', deployAgeSec: STALENESS_BACKSTOP_SEC + 1 });
  assert.deepEqual(r, { proceed: false, reason: 'no-new-commits' });
});

test('kill switch forces proceed on every event, even baseline==HEAD', () => {
  for (const eventName of ['schedule', 'workflow_dispatch', 'workflow_run']) {
    const r = decide({ ...base, eventName, gateDisabled: true, headSha: A });
    assert.deepEqual(r, { proceed: true, reason: 'kill-switch' });
  }
});

test('classifyDiffExit: 0=clean, 1=dirty, anything else=error', () => {
  assert.equal(classifyDiffExit(0), 'clean');
  assert.equal(classifyDiffExit(1), 'dirty');
  assert.equal(classifyDiffExit(2), 'error');
  assert.equal(classifyDiffExit(128), 'error');
});

test('SITE_PATHS keeps its load-bearing entries', () => {
  // public/ carries the rebuilt public/data/shows/*.json (review scores);
  // scripts/ carries prebuild scripts; content/ carries content/reviews.
  // Removing one silently narrows the gate (pre-mortem scenario 2).
  for (const p of ['src/', 'public/', 'content/', 'scripts/', 'package.json', 'next.config.js']) {
    assert.ok(SITE_PATHS.includes(p), `SITE_PATHS must include ${p}`);
  }
});

// ─── BRO-3618: more core-data files tracked, generic compare ───────────────
const { compareDataShas, DATA_TRACKED_FILES } = require('./should-deploy-gate.js');
const { blobShaMetaKey, pickBlobShaMeta } = require('./core-data-blob-meta.js');
const fs = await import('node:fs');
const cp = await import('node:child_process');
const os = await import('node:os');

const allNow = (over = {}) => Object.fromEntries(DATA_TRACKED_FILES.map((f) => [f, 'n-' + f]).concat(Object.entries(over)));
const allBase = (over = {}) => Object.fromEntries(DATA_TRACKED_FILES.map((f) => [blobShaMetaKey(f), 'n-' + f]).concat(Object.entries(over)));

test('tracked set covers reviews, shows and the other private files read at build', () => {
  for (const f of ['reviews.json', 'shows.json', 'commercial.json', 'grosses.json', 'grosses-history.json', 'critic-consensus.json']) {
    assert.ok(DATA_TRACKED_FILES.includes(f), f);
  }
  // churn guard: audience-buzz is rewritten by ~16 workflows; it rides the 6h backstop.
  assert.ok(!DATA_TRACKED_FILES.includes('audience-buzz.json'));
});

test('blobShaMetaKey: stable names, legacy keys unchanged', () => {
  assert.equal(blobShaMetaKey('reviews.json'), 'reviewsBlobSha');
  assert.equal(blobShaMetaKey('shows.json'), 'showsBlobSha');
  assert.equal(blobShaMetaKey('critic-consensus.json'), 'criticConsensusBlobSha');
  assert.deepEqual(pickBlobShaMeta({ githubCommitSha: 'x', grossesBlobSha: 'g', junkBlobSha: '' }), { grossesBlobSha: 'g' });
});

test('compareDataShas: every tracked file alone, with no public diff, flips the verdict to dirty', () => {
  for (const f of DATA_TRACKED_FILES) {
    assert.equal(compareDataShas(allNow({ [f]: 'CHANGED' }), allBase()), 'dirty', f);
    // and decide() then proceeds on that signal alone (no public-repo diff)
    const r = decide({ ...base, diffResult: 'clean', dataDiffResult: compareDataShas(allNow({ [f]: 'CHANGED' }), allBase()) });
    assert.deepEqual([r.proceed, r.reason], [true, 'data-changed'], f);
  }
});

// BRO-5044: a weekly grosses-history.json update alone must trigger a deploy.
test('grosses-history.json alone changing proceeds with data-changed (no public diff)', () => {
  const verdict = compareDataShas(allNow({ 'grosses-history.json': 'CHANGED' }), allBase());
  assert.equal(verdict, 'dirty');
  const r = decide({ ...base, diffResult: 'clean', dataDiffResult: verdict });
  assert.deepEqual([r.proceed, r.reason], [true, 'data-changed']);
  assert.equal(blobShaMetaKey('grosses-history.json'), 'grossesHistoryBlobSha');
});

test('compareDataShas: identical -> clean; lookup failed -> error/null', () => {
  assert.equal(compareDataShas(allNow(), allBase()), 'clean');
  assert.equal(compareDataShas(null, allBase()), 'error');
  assert.equal(compareDataShas(null, {}), null);
});

test('compareDataShas: first rollout (baseline stamped without new files) is error, not dirty or clean', () => {
  const legacyBase = { reviewsBlobSha: 'n-reviews.json', showsBlobSha: 'n-shows.json' };
  assert.equal(compareDataShas(allNow(), legacyBase), 'error');
  // a real reviews change still wins over the rollout ambiguity
  assert.equal(compareDataShas(allNow({ 'reviews.json': 'X' }), legacyBase), 'dirty');
});

test('compareDataShas: a file absent on both sides is ignored, absent on one side is error', () => {
  const now = allNow({ 'grosses.json': null });
  const b = allBase();
  delete b.grossesBlobSha;
  assert.equal(compareDataShas(now, b), 'clean');
  assert.equal(compareDataShas(allNow({ 'grosses.json': null }), allBase()), 'error');
});

test('workflow stamps exactly what the gate tracks (drift guard)', () => {
  const y = fs.readFileSync(new URL('../../.github/workflows/vercel-deploy.yml', import.meta.url), 'utf8');
  assert.match(y, /should-deploy-gate\.js --meta-args/);
  assert.match(y, /META_ARGS\+=\(--meta "\$line"\)/);
  assert.doesNotMatch(y, /--meta "reviewsBlobSha=/); // hard-coded pair is gone
  assert.match(y, /"\$\{META_ARGS\[@\]\}"/);
});

test('--meta-args prints one <name>BlobSha=<git blob sha> per tracked file present in data/', () => {
  const dir = fs.mkdtempSync(os.tmpdir() + '/gate-meta-');
  fs.mkdirSync(dir + '/data');
  fs.writeFileSync(dir + '/data/reviews.json', '{"a":1}\n');
  fs.writeFileSync(dir + '/data/critic-consensus.json', '{}\n');
  const out = cp.execFileSync('node', [new URL('./should-deploy-gate.js', import.meta.url).pathname, '--meta-args'], { cwd: dir, encoding: 'utf8' });
  const want = (f) => cp.execFileSync('git', ['hash-object', dir + '/data/' + f], { encoding: 'utf8' }).trim();
  assert.equal(out, `reviewsBlobSha=${want('reviews.json')}\ncriticConsensusBlobSha=${want('critic-consensus.json')}\n`);
});

// BRO-4614: tracked data/*.json that src/ imports must be in the diff list, or
// a commit that changes one is skipped as bookkeeping. The list is committed
// (SITE_DATA_FILES) so the gate stays deterministic; this fails on drift.
test('SITE_DATA_FILES matches the tracked data files src/ imports (BRO-4614)', () => {
  const { scanSiteDataImports } = require('./site-data-imports.js');
  const { SITE_DATA_FILES } = require('./should-deploy-gate.js');
  assert.deepEqual([...SITE_DATA_FILES], scanSiteDataImports(), 'regenerate with: node scripts/lib/site-data-imports.js');
  for (const f of SITE_DATA_FILES) assert.ok(SITE_PATHS.includes(f), `${f} must be diffed by the gate`);
});

test('SITE_DATA_FILES never admits data/audit bookkeeping or a bare data/ prefix (BRO-4614)', () => {
  const { SITE_DATA_FILES } = require('./should-deploy-gate.js');
  assert.ok(!SITE_DATA_FILES.some((f) => f.startsWith('data/audit/')));
  assert.ok(!SITE_PATHS.includes('data/'));
  assert.ok(SITE_DATA_FILES.includes('data/tour-schedules.json'));
});

test('a committed change to an imported data file is dirty for the real git diff (BRO-4614)', async () => {
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-data-'));
  const g = (...a) => execFileSync('git', a, { cwd: d, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  try {
    g('init', '-q');
    fs.mkdirSync(path.join(d, 'data/audit'), { recursive: true });
    fs.writeFileSync(path.join(d, 'data/tour-schedules.json'), '{"v":1}');
    fs.writeFileSync(path.join(d, 'data/audit/x.json'), '{"v":1}');
    g('add', '-A'); g('commit', '-qm', 'a');
    const a = g('rev-parse', 'HEAD').trim();
    fs.writeFileSync(path.join(d, 'data/audit/x.json'), '{"v":2}');
    g('commit', '-qam', 'bookkeeping');
    const b = g('rev-parse', 'HEAD').trim();
    const dirty = (x, y) => { try { g('diff', '--quiet', '--no-renames', x, y, '--', ...SITE_PATHS); return false; } catch (e) { return e.status === 1; } };
    assert.equal(dirty(a, b), false, 'audit churn must not trigger a deploy');
    fs.writeFileSync(path.join(d, 'data/tour-schedules.json'), '{"v":2}');
    g('commit', '-qam', 'tour');
    assert.equal(dirty(b, g('rev-parse', 'HEAD').trim()), true, 'an imported data file change must trigger a deploy');
  } finally {
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
