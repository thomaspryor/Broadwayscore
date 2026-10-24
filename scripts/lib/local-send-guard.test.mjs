// BRO-791: subscriber email senders must not run twice at once. Unit tests for
// the decision, a real-process check that a local real send exits 2 before any
// network call, and a scan that every scripts/send-*.js has a declared
// concurrency story. Never sends email.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decideLocalSend } = require('./local-send-guard.js');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const LOCAL = { GITHUB_ACTIONS: '', CI: '' };
const W = 'send-x.yml';
const P = ['--dry-run', '--test-send', '--send-to='];

test('CI always sends', () => {
  assert.equal(decideLocalSend({ argv: [], env: { GITHUB_ACTIONS: 'true' }, workflow: W, previewFlags: P, activeRuns: 0 }).allow, true);
});

test('local previews always run', () => {
  for (const argv of [['--dry-run'], ['--test-send'], ['--send-to=a@b.c']]) {
    assert.equal(decideLocalSend({ argv, env: LOCAL, workflow: W, previewFlags: P, activeRuns: null }).allow, true, argv.join(' '));
  }
});

test('a flag the script does not honour is not a preview, and CI=true alone is not CI', () => {
  // send-follow-notifications ignores --send-to=, so for it that is a real send.
  assert.equal(decideLocalSend({ argv: ['--send-to=a@b.c'], env: LOCAL, workflow: W, previewFlags: ['--dry-run'], activeRuns: 0 }).allow, false);
  assert.equal(decideLocalSend({ argv: [], env: { CI: 'true' }, workflow: W, previewFlags: P, activeRuns: 0 }).allow, false);
  assert.throws(() => decideLocalSend({ argv: [], env: LOCAL, workflow: W, activeRuns: 0 }), /previewFlags/);
});

test('the wired senders exit 2 on --send-to= locally when they do not honour it', () => {
  const r = spawnSync('node', [path.join(ROOT, 'scripts', 'send-follow-notifications.js'), '--send-to=a@b.c'], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, ...LOCAL, RESEND_API_KEY: 're_invalid_test_key', DISCORD_WEBHOOK_ALERTS: '' },
  });
  assert.equal(r.status, 2, r.stdout + r.stderr);
});

test('local real send is refused without the override', () => {
  const d = decideLocalSend({ argv: [], env: LOCAL, workflow: W, previewFlags: P, activeRuns: 0 });
  assert.equal(d.allow, false);
  assert.match(d.reason, /--allow-local-send/);
});

test('override still refuses while the workflow runs or cannot be checked', () => {
  assert.equal(decideLocalSend({ argv: ['--allow-local-send'], env: LOCAL, workflow: W, previewFlags: P, activeRuns: 1 }).allow, false);
  assert.equal(decideLocalSend({ argv: ['--allow-local-send'], env: LOCAL, workflow: W, previewFlags: P, activeRuns: null }).allow, false);
  assert.equal(decideLocalSend({ argv: ['--allow-local-send'], env: LOCAL, workflow: W, previewFlags: P, activeRuns: 0 }).allow, true);
});

test('the wired senders exit 2 locally before touching the network', () => {
  for (const s of ['send-follow-notifications.js', 'send-welcome-emails.js']) {
    const r = spawnSync('node', [path.join(ROOT, 'scripts', s)], {
      encoding: 'utf8', timeout: 30000,
      // Bogus keys: if the guard failed, any send attempt would fail auth, never deliver.
      env: { ...process.env, ...LOCAL, RESEND_API_KEY: 're_invalid_test_key', SUPABASE_SERVICE_ROLE_KEY: '', NEXT_PUBLIC_SUPABASE_URL: '', DISCORD_WEBHOOK_ALERTS: '' },
    });
    assert.equal(r.status, 2, `${s}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /Refusing a real send/);
  }
});

// Every sender must be in exactly one bucket. A new scripts/send-*.js fails
// here until someone decides how it avoids double sends.
const CLASSES = {
  LOCKED: ['send-opening-night-broadcast.js'], // scripts/lib/send-lock.js
  GUARDED: ['send-follow-notifications.js', 'send-welcome-emails.js'], // local-send-guard
  OWNER_ONLY: ['send-opening-digest.js', 'send-morning-digest.js', 'send-reddit-post-email.js', 'send-owner-decision-emails.js'], // mail the owner only (CI-only, per-decision Resend idempotency key + ODE marker)
  NO_SEND: ['send-daily-digest.js'], // routes through the alert digest, no Resend call
  CLI_ONLY: ['send-btc-results.js', 'send-btc-confirmation-emails.js'], // no sending workflow; dedup state files
};

test('every scripts/send-*.js has a declared concurrency class', () => {
  const actual = fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => /^send-.*\.js$/.test(f)).sort();
  const declared = Object.values(CLASSES).flat().sort();
  assert.deepEqual(actual, declared, 'classify the new sender in CLASSES (BRO-791)');
  const src = (f) => fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8');
  for (const f of CLASSES.LOCKED) assert.match(src(f), /send-lock/, `${f} must use send-lock`);
  for (const f of CLASSES.GUARDED) assert.match(src(f), /enforceLocalSendGuard\(/, `${f} must call the guard`);
});
