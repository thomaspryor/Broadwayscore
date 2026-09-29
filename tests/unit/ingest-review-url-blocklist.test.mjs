/**
 * Regression test (BRO-3247, 2026-09-15): the per-show URL blocklist was not
 * honored by scripts/ingest-review-from-url.js.
 *
 * scripts/lib/poller-blocklist.js exists for exactly one purpose — making an
 * operator's deletion STICK, after the Rocky Horror 2026-04-23 incident where a
 * deleted duplicate was rediscovered and re-created hours later.
 * gather-reviews.js has honored it ever since. ingest-review-from-url.js never
 * did — and that script is BOTH the public /submit-review path AND the target
 * of audit-aggregator-gap's auto-recovery (audit-t1-silent-gaps.js's
 * recoverFromOwnUrl exec's it).
 *
 * Live consequence: a wrong-production Lighting & Sound America review of a
 * DIFFERENT "Safe House" (the 2025 Enda Walsh production at St. Ann's
 * Warehouse) was deleted from safe-house-off-broadway-2026 on 2026-09-14 and
 * automatically re-ingested within hours — twice — because deleting a file
 * leaves nothing behind that this entry point consults.
 *
 * Runs the REAL script via execFileSync against a temp corpus (--data-dir),
 * not a reimplementation of its logic (CLAUDE.md rule 15). The refusal happens
 * BEFORE any fetch, so these cases make no network calls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', '..', 'scripts', 'ingest-review-from-url.js');
const SHOW = 'safe-house-off-broadway-2026';
const BLOCKED = 'http://www.lightingandsoundamerica.com/news/story.asp?ID=-4LGZPY';

function makeCorpus() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro3247-blocklist-'));
  fs.mkdirSync(path.join(root, SHOW), { recursive: true });
  fs.writeFileSync(
    path.join(root, SHOW, '_blocklist.json'),
    JSON.stringify({
      urls: [{
        url: BLOCKED,
        reason: 'wrong production — 2025 Enda Walsh staging at St. Ann\'s Warehouse',
        blockedAt: '2026-09-15T00:00:00Z',
      }],
    }),
  );
  return root;
}

/** Run the real CLI; return {code, out}. Never throws on non-zero exit. */
function run(root, url) {
  try {
    const out = execFileSync('node', [
      SCRIPT, `--show=${SHOW}`, `--url=${url}`,
      '--outlet=lighting-and-sound-america', `--data-dir=${root}`,
    ], { encoding: 'utf8', stdio: 'pipe', timeout: 60000 });
    return { code: 0, out };
  } catch (e) {
    return {
      code: e.status === undefined ? -1 : e.status,
      out: `${e.stdout || ''}${e.stderr || ''}`,
    };
  }
}

test('a blocklisted URL is refused before any fetch', () => {
  const root = makeCorpus();
  const r = run(root, BLOCKED);
  assert.equal(r.code, 1, 'must exit non-zero');
  assert.match(r.out, /blocklisted/i);
  // Proof it never reached the network: the fetch stage logs "Fetching:".
  assert.doesNotMatch(r.out, /Fetching:/);
  // And it wrote nothing into the corpus beyond the blocklist itself.
  const files = fs.readdirSync(path.join(root, SHOW));
  assert.deepEqual(files, ['_blocklist.json']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('blocklist matching ignores tracking params', () => {
  // The Rocky Horror incident re-ingested the same article carrying a
  // ?triedRedirect param, which is why poller-blocklist normalizes.
  const root = makeCorpus();
  const r = run(root, `${BLOCKED}&utm_source=newsletter`);
  assert.equal(r.code, 1);
  assert.match(r.out, /blocklisted/i);
  assert.doesNotMatch(r.out, /Fetching:/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a show with no blocklist is unaffected (guard is selective)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro3247-noblocklist-'));
  fs.mkdirSync(path.join(root, SHOW), { recursive: true });
  // Uses a ticketing domain so the NEXT guard (domain-filters' isBlockedReviewUrl)
  // stops it immediately. That keeps this case hermetic — no network — while
  // still proving the per-show blocklist guard did not fire for a show that has
  // no blocklist.
  const r = run(root, 'https://www.telecharge.com/Broadway/Safe-House/Overview');
  assert.doesNotMatch(r.out, /is blocklisted for/);
  assert.match(r.out, /known non-review domain/);
  assert.doesNotMatch(r.out, /Fetching:/);
  fs.rmSync(root, { recursive: true, force: true });
});
