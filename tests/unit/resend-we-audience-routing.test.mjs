/**
 * Guard: West End subscribers must route to their OWN Resend audience, and the
 * opening-night broadcast must target that same WE audience.
 *
 * Regression (2026-05-30): sync-followers.js merged Broadway + WE subscribers
 * into a single "General" audience while send-opening-night-broadcast.js
 * --market=west-end targeted a separate, empty WE audience — so WE broadcasts
 * reached ~0 of the real WE subscribers. The fix split the audiences. It was
 * then SILENTLY REVERTED twice by unrelated commits that bundled a stale copy of
 * these files (e.g. 382bd873e1 "clarify rules page wording"). This structural
 * guard fails CI the moment either file regresses to the single-audience shape.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sync = readFileSync(join(ROOT, 'scripts/sync-followers.js'), 'utf8');
const broadcast = readFileSync(join(ROOT, 'scripts/send-opening-night-broadcast.js'), 'utf8');

const WE_AUDIENCE = '0b17260b-6a72-4a5a-a700-7b7526f18d87';
const BW_AUDIENCE = '472ec5ef-d7cc-4c48-8007-c0a6a302e7a4';

describe('Resend WE/Broadway audience split', () => {
  test('sync-followers.js routes to two separate audiences', () => {
    assert.ok(sync.includes('syncResendAudience'),
      'sync-followers.js must use syncResendAudience() to populate each market audience separately');
    assert.ok(sync.includes(WE_AUDIENCE),
      'sync-followers.js must reference the West End Resend audience id');
    assert.ok(sync.includes(BW_AUDIENCE),
      'sync-followers.js must reference the Broadway/General Resend audience id');
    assert.ok(!/Resend uses one audience/.test(sync),
      'sync-followers.js regressed to the single-audience model (WE subs merged into Broadway)');
  });

  test('opening-night broadcast targets the WE audience for west-end', () => {
    assert.ok(broadcast.includes(WE_AUDIENCE),
      'send-opening-night-broadcast.js must carry the WE audience id (fallback) so WE drafts target real subscribers');
  });
});
