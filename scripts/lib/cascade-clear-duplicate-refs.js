/**
 * cascade-clear-duplicate-refs.js
 *
 * When a review-text file is deleted (typically a `*--unknown.json` junk
 * file swept by rebuild-all-reviews's stale-unknown-or-outlet-mismatch
 * cleanup), any sibling review file in the same show directory that
 * carries `duplicateOf: <deleted-filename>` becomes a dangling reference.
 *
 * The audit-duplicate-of-url-mismatch.js CI gate then flags those siblings
 * as "sibling-missing" and fails Data Validation until someone runs --fix.
 * The 2026-05-26 incident saw this pattern silently accumulate hundreds of
 * dangling references across two cleanup waves.
 *
 * This helper makes the deletion + cascade-clear atomic at the source:
 *   1. Read every other .json file in the same directory.
 *   2. For each whose `duplicateOf` points at the file we're about to
 *      delete, clear the duplicateOf + duplicateReason and stamp a
 *      duplicateClearReason breadcrumb so the audit log shows why.
 *   3. Persist the cleared sibling.
 *
 * The function is exported as a pure-ish unit so it can be tested without
 * touching the rebuild pipeline. Persist is parameterised via writeFile
 * so tests can use plain fs.writeFileSync (skipping safeWriteReview's
 * URL-collision detector, which would re-create duplicate flags during
 * cleanup).
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * Scan a directory for sibling .json files whose `duplicateOf` references
 * the to-be-deleted filename, and clear the references. Returns the list
 * of affected sibling files (relative names) so the caller can log.
 *
 * @param {string} dirPath  Absolute path to the show directory.
 * @param {string} deletedFilename  Basename (with .json) of the file about
 *   to be deleted. Must include the .json suffix to match duplicateOf
 *   syntax exactly.
 * @param {object} opts
 * @param {(p: string, json: object) => void} [opts.writeFile]
 *   Persistence injection. Default writes via fs.writeFileSync with
 *   2-space JSON. Tests pass a custom writer to assert behavior; rebuild
 *   pipeline uses the default because safeWriteReview would race here.
 * @param {(msg: string) => void} [opts.log]  Console.warn replacement.
 * @returns {string[]} cleared sibling filenames
 */
function cascadeClearDuplicateRefs(dirPath, deletedFilename, opts = {}) {
  const writeFile = opts.writeFile || ((p, json) => {
    fs.writeFileSync(p, JSON.stringify(json, null, 2) + '\n');
  });
  const log = opts.log || (() => {});
  const cleared = [];

  if (!fs.existsSync(dirPath) || !deletedFilename) return cleared;

  let entries;
  try {
    entries = fs.readdirSync(dirPath);
  } catch {
    return cleared;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    if (entry === deletedFilename) continue;
    const siblingPath = path.join(dirPath, entry);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(siblingPath, 'utf8'));
    } catch {
      continue; // unreadable / not JSON — skip
    }
    if (data.duplicateOf !== deletedFilename) continue;

    data.duplicateClearReason = `cascade-cleared: sibling ${deletedFilename} was deleted`;
    data.duplicateOf = null;
    data.duplicateReason = null;
    try {
      writeFile(siblingPath, data);
      cleared.push(entry);
      log(`[cascade-clear] cleared duplicateOf in ${entry} (was pointing at deleted ${deletedFilename})`);
    } catch {
      // best-effort — a write failure during the cleanup phase shouldn't
      // block the deletion itself
    }
  }

  return cleared;
}

module.exports = { cascadeClearDuplicateRefs };
