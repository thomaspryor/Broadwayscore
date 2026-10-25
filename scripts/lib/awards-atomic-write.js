/**
 * Atomic dual-repo write helper for awards.json.
 *
 * Why this exists: scripts/enrich-awards-with-precursors.js writes awards.json
 * to BOTH the public repo (data/awards.json — symlinked from private repo
 * but the symlink-resolved write goes through to the private file too) AND
 * the private repo (~/broadway-scorecard-data/awards.json) as a separate
 * write. If the second write throws (e.g. disk full, private repo busy),
 * the public file is updated but the private file is stale — they silently
 * drift. Codex flagged this as a P1 production failure mode in the
 * 6-reviewer plan-review.
 *
 * This helper provides:
 *   - Temp-file + atomic rename for each write (no half-written files)
 *   - Pre-write snapshot of each target file
 *   - On second-write failure: revert the first target from snapshot, then
 *     throw — leaving both files in their pre-write state
 *
 * Caller passes the parsed awards object. Helper handles serialization.
 *
 * Usage:
 *   const { writeAwardsJsonAtomic } = require('./scripts/lib/awards-atomic-write');
 *   writeAwardsJsonAtomic(awardsData, {
 *     publicPath: 'data/awards.json',
 *     privatePath: '/Users/tompryor/broadway-scorecard-data/awards.json',
 *   });
 */

const fs = require('fs');
const path = require('path');

function serialize(awards) {
  return JSON.stringify(awards, null, 2) + '\n';
}

function readSnapshot(filepath) {
  try {
    return fs.readFileSync(filepath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;  // file didn't exist — restore = delete
    throw e;
  }
}

function restoreFromSnapshot(filepath, snapshot) {
  if (snapshot === null) {
    try { fs.unlinkSync(filepath); } catch (_) { /* ignore */ }
  } else {
    fs.writeFileSync(filepath, snapshot);
  }
}

function atomicWrite(filepath, contents) {
  // Resolve symlinks: rename() onto a symlink replaces the link with a regular
  // file, orphaning the real target (same trap fixed in atomic-shows-write.js).
  try {
    filepath = fs.realpathSync(filepath);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const dir = path.dirname(filepath);
  const tmp = path.join(dir, `.${path.basename(filepath)}.tmp.${process.pid}.${Date.now()}`);
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, filepath);
}

/**
 * Atomically write the awards object to both targets. On second-target
 * failure, restore the first target from its pre-write snapshot.
 *
 * Returns { publicBytes, privateBytes, identical } when both writes succeed.
 * Throws on failure (after attempting rollback).
 */
function writeAwardsJsonAtomic(awards, { publicPath, privatePath }) {
  if (!publicPath || !privatePath) {
    throw new Error('writeAwardsJsonAtomic requires { publicPath, privatePath }');
  }
  const contents = serialize(awards);

  const publicSnapshot = readSnapshot(publicPath);
  const privateSnapshot = readSnapshot(privatePath);

  // Public first (typically the symlink-resolved write). If it throws,
  // nothing else has changed.
  atomicWrite(publicPath, contents);

  // Private second. If it throws, roll back public.
  try {
    atomicWrite(privatePath, contents);
  } catch (e) {
    try {
      restoreFromSnapshot(publicPath, publicSnapshot);
    } catch (restoreErr) {
      const composite = new Error(
        `Private write failed AND public rollback also failed.\n` +
        `Original error: ${e.message}\n` +
        `Rollback error: ${restoreErr.message}\n` +
        `Public file MAY be in a partially-written state — check ${publicPath} manually.`
      );
      composite.original = e;
      composite.rollback = restoreErr;
      throw composite;
    }
    const wrapped = new Error(`Private write failed; public rolled back to pre-write state. ${e.message}`);
    wrapped.original = e;
    throw wrapped;
  }

  // Belt-and-suspenders: verify both files end byte-identical.
  const publicAfter = fs.readFileSync(publicPath);
  const privateAfter = fs.readFileSync(privatePath);
  const identical = Buffer.compare(publicAfter, privateAfter) === 0;
  if (!identical) {
    // Roll both back
    restoreFromSnapshot(publicPath, publicSnapshot);
    restoreFromSnapshot(privatePath, privateSnapshot);
    throw new Error(`awards.json diverged after dual write — both files rolled back. public=${publicAfter.length} bytes, private=${privateAfter.length} bytes`);
  }

  return {
    publicBytes: publicAfter.length,
    privateBytes: privateAfter.length,
    identical: true,
  };
}

module.exports = { writeAwardsJsonAtomic };
