// BRO-2684: the five BRO-155 off-off-Broadway stubs were added with image
// paths that pointed at files nobody had fetched. This pins the backfill:
// every stub has art committed (any format, so a .webp re-source still passes).
// Review counts and the shows.json image paths are deliberately NOT asserted:
// both are world state written by other pipelines, and test.yml must only
// fail when code breaks (.github/workflows/CLAUDE.md, BRO-4434).
// The reviews themselves were checked with verify-review-recovery.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STUBS = [
  'matchbook-fest-off-broadway-2026',
  'brooklyns-bridge-off-broadway-2026',
  'the-whole-sky-all-diamonds-off-broadway-2026',
  'the-bathroom-attendant-off-broadway-2026',
  'michael-r-jackson-wake-up-call-off-broadway-2026',
];
const IMAGE_RE = /\.(?:jpe?g|png|webp|avif)$/i;

// Both kinds, each in any format: Matchbook had a thumbnail and no poster,
// which is the 404 BRO-2684 fixed (BRO-5261 retro-review).
test('every BRO-155 stub has thumbnail and poster art committed in public/images (any image format)', () => {
  for (const id of STUBS) {
    const dir = path.join(REPO, 'public', 'images', 'shows', id);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => IMAGE_RE.test(f)) : [];
    for (const kind of ['thumbnail', 'poster']) {
      assert.ok(
        files.some((f) => f.startsWith(`${kind}.`) && fs.statSync(path.join(dir, f)).size > 1000),
        `${id} has no ${kind} image in public/images/shows`,
      );
    }
  }
});
