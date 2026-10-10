#!/usr/bin/env node
/**
 * Beat the Critics — standalone smoke test
 *
 * Usage:
 *   node scripts/btc-smoke-test.js [--url=https://broadwayscorecard.com] [--skip-rate-limit]
 *
 * Exit 0 if all checks pass, exit 1 on first failure.
 * Requires: node-fetch (already installed), gh CLI (authenticated).
 */

'use strict';

const { execSync } = require('child_process');
const fetch = (() => {
  try { return require('node-fetch'); } catch {
    // node 18+ has built-in fetch
    return globalThis.fetch;
  }
})();

const args = process.argv.slice(2);
const BASE_URL = (args.find(a => a.startsWith('--url=')) || '').replace('--url=', '') || 'https://broadwayscorecard.com';
const SKIP_RATE_LIMIT = args.includes('--skip-rate-limit');

const TEST_EMAIL = 'btc-smoke-test@broadwayscorecard.com';
const SUBMISSIONS_REPO = 'thomaspryor/broadway-scorecard-data';
const SUBMISSIONS_PATH = 'data/beat-the-critics-submissions.jsonl';

let passed = 0;
let failed = 0;

function pass(name) {
  console.log(`✓ ${name}`);
  passed++;
}

function fail(name, reason) {
  console.error(`✗ ${name}: ${reason}`);
  failed++;
  process.exit(1);
}

async function run() {
  console.log(`\nBeat the Critics smoke test — ${BASE_URL}\n`);

  // ── 1. Landing page renders ──────────────────────────────────────────────
  {
    const res = await fetch(`${BASE_URL}/beat-the-critics`);
    if (!res.ok) fail('GET /beat-the-critics returns 200', `HTTP ${res.status}`);
    const html = await res.text();
    if (!html.includes('Beat the Critics')) fail('GET /beat-the-critics contains "Beat the Critics"', 'text not found in HTML');
    pass('GET /beat-the-critics returns 200 with "Beat the Critics"');
  }

  // ── 2. Rules page renders ────────────────────────────────────────────────
  {
    const res = await fetch(`${BASE_URL}/beat-the-critics/rules`);
    if (!res.ok) fail('GET /beat-the-critics/rules returns 200', `HTTP ${res.status}`);
    const html = await res.text();
    if (!html.includes('Official Rules')) fail('GET /beat-the-critics/rules contains "Official Rules"', 'text not found in HTML');
    pass('GET /beat-the-critics/rules returns 200 with "Official Rules"');
  }

  // ── 3. POST with invalid email returns 400 ───────────────────────────────
  {
    const res = await fetch(`${BASE_URL}/api/beat-the-critics/send-picks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', picks: {}, ceremonyYear: 2026 }),
    });
    if (res.status !== 400) fail('POST with invalid email returns 400', `HTTP ${res.status}`);
    pass('POST with invalid email returns 400');
  }

  // ── 4. POST with valid test payload returns {success:true} ───────────────
  {
    const res = await fetch(`${BASE_URL}/api/beat-the-critics/send-picks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Unique IP so rate-limit window starts fresh for this test run
        'x-forwarded-for': `10.smoke.${Date.now() % 255}.1`,
      },
      body: JSON.stringify({
        email: TEST_EMAIL,
        picks: { 'Best Musical': 'TEST-SMOKE-DO-NOT-ENTER' },
        ceremonyYear: 2026,
      }),
    });
    if (!res.ok) fail('POST valid payload returns 2xx', `HTTP ${res.status}`);
    const json = await res.json().catch(() => ({}));
    if (!json.success) fail('POST valid payload returns {success:true}', JSON.stringify(json));
    pass('POST valid payload returns {success:true}');
  }

  // ── 5. Entry appears in GitHub JSONL ────────────────────────────────────
  // Allow up to 15 s for the GitHub write to propagate.
  let foundSha = null;
  let foundLine = null;
  {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const raw = execSync(
          `gh api repos/${SUBMISSIONS_REPO}/contents/${SUBMISSIONS_PATH}`,
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
        );
        const { content, sha } = JSON.parse(raw);
        const decoded = Buffer.from(content.replace(/\n/g, ''), 'base64').toString('utf8');
        const lines = decoded.split('\n').filter(Boolean);
        const match = lines.find(l => {
          try { const r = JSON.parse(l); return r.email === TEST_EMAIL && r.picks?.['Best Musical'] === 'TEST-SMOKE-DO-NOT-ENTER'; }
          catch { return false; }
        });
        if (match) { foundSha = sha; foundLine = match; break; }
      } catch { /* file may not exist yet */ }
      await new Promise(r => setTimeout(r, 2000));
    }
    if (!foundLine) fail('Entry appears in GitHub JSONL', `test entry not found after 15 s — check ${SUBMISSIONS_PATH}`);
    pass('Entry appears in GitHub JSONL');
  }

  // ── 6. Clean up test entry ───────────────────────────────────────────────
  {
    try {
      // Re-read to get fresh content + sha
      const raw = execSync(
        `gh api repos/${SUBMISSIONS_REPO}/contents/${SUBMISSIONS_PATH}`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const { content, sha } = JSON.parse(raw);
      const decoded = Buffer.from(content.replace(/\n/g, ''), 'base64').toString('utf8');
      const cleaned = decoded
        .split('\n')
        .filter(l => {
          if (!l.trim()) return false;
          try { const r = JSON.parse(l); return !(r.email === TEST_EMAIL && r.picks?.['Best Musical'] === 'TEST-SMOKE-DO-NOT-ENTER'); }
          catch { return true; }
        })
        .join('\n') + '\n';

      const newContent = Buffer.from(cleaned).toString('base64');
      execSync(
        `gh api repos/${SUBMISSIONS_REPO}/contents/${SUBMISSIONS_PATH} \
          -X PUT \
          -F message='chore: remove smoke-test entry [skip ci]' \
          -F content='${newContent}' \
          -F sha='${sha}'`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      pass('Cleaned up test entry from GitHub JSONL');
    } catch (err) {
      // Non-fatal: warn but don't fail the suite — cleanup failures shouldn't block CI
      console.warn(`  (warning) Cleanup failed: ${err.message} — remove manually`);
      passed++;
    }
  }

  // ── 7. Rate-limit check ──────────────────────────────────────────────────
  if (SKIP_RATE_LIMIT) {
    console.log(`  (skipped) Rate-limit check — --skip-rate-limit passed`);
  } else {
    // Use a shared spoofed IP that hasn't been used this session.
    const spoofedIp = `10.ratelimit.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    const headers = {
      'Content-Type': 'application/json',
      'x-forwarded-for': spoofedIp,
    };
    const body = JSON.stringify({
      email: `btc-ratelimit-${Date.now()}@test.example`,
      picks: { 'Best Musical': 'RATE-LIMIT-TEST' },
      ceremonyYear: 2026,
    });

    let got429 = false;
    for (let i = 1; i <= 4; i++) {
      const res = await fetch(`${BASE_URL}/api/beat-the-critics/send-picks`, { method: 'POST', headers, body });
      if (res.status === 429) { got429 = true; break; }
    }
    if (!got429) fail('Rate limit: 4th rapid POST returns 429', 'no 429 received after 4 requests from same IP');
    pass('Rate limit: 4th rapid POST returns 429');
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed\n`);
}

run().catch(err => {
  console.error('\nUnhandled error:', err.message);
  process.exit(1);
});
