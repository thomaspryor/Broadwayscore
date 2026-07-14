#!/usr/bin/env node
/**
 * check-image-aspect.js
 *
 * Validates aspect ratios for show poster/thumbnail/hero images.
 *
 * Why: parallel sessions and bulk imports have committed wide landscape
 * production stills as poster.webp, which then render as a vertical
 * sliver inside the show page's `aspect-[2/3] object-cover` container.
 * See evita-west-end-2025 (commit a71c3defe4).
 *
 * Modes:
 *   --staged           Check only files staged for commit (pre-commit hook use)
 *   --audit            Scan entire public/images/shows/ and report
 *   --files <paths...> Check specific paths (space-separated)
 *   --quarantine       With --staged: instead of failing the commit, unstage +
 *                      restore/delete each violating file and exit 0 so the
 *                      REST of the batch commits. One landscape thumbnail was
 *                      aborting entire CI image batches (fetch-all-image-formats
 *                      failed 2x on 2026-07-14, discarding all fetched images).
 *
 * Thresholds (calibrated from existing catalog distribution + show-page rendering):
 *   poster.*    h/w >= 1.00            (rejects landscape; allows square/portrait)
 *   thumbnail.* 0.85 <= h/w <= 1.70    (rejects landscape; allows square/mild-portrait)
 *   hero.*      h/w <= 0.85            (rejects portrait/square; allows landscape)
 *
 * Rationale: the "broken" class is when an image renders as a sliver inside its
 * container. poster.webp inside aspect-[2/3] needs h/w >= ~1; landscape poster
 * gets vertical-sliver-cropped (Evita case). thumbnail.* in a square container
 * is OK as portrait (center-crop keeps subject). hero needs to be landscape.
 * Square posters and mild-portrait thumbnails render acceptably and are common
 * in legacy IBDB art — don't flag them.
 *
 * Exit: 0 = all pass, 1 = at least one violation
 */

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

let sharp;
try {
  sharp = require('sharp');
} catch {
  console.error('check-image-aspect: sharp not installed — skipping check');
  process.exit(0); // soft-pass when sharp missing (e.g. fresh clone before npm install)
}

const ROOT = path.resolve(__dirname, '..');
const SHOWS_DIR = path.join(ROOT, 'public', 'images', 'shows');

const THRESHOLDS = {
  poster:    { minRatio: 1.00, maxRatio: Infinity, expected: 'portrait or square (h/w >= 1.0)' },
  thumbnail: { minRatio: 0.85, maxRatio: 1.70,     expected: 'square or mild-portrait (0.85 <= h/w <= 1.70)' },
  hero:      { minRatio: 0,    maxRatio: 0.85,     expected: 'landscape (h/w <= 0.85)' },
};

const FILENAME_RE = /\/(poster|thumbnail|hero)\.(webp|jpg|jpeg|png)$/i;

function classify(filePath) {
  const m = filePath.match(FILENAME_RE);
  return m ? m[1].toLowerCase() : null;
}

async function checkFile(absPath) {
  const role = classify(absPath);
  if (!role) return null; // not a tracked image role

  const t = THRESHOLDS[role];
  if (!t) return null;

  let meta;
  try {
    meta = await sharp(absPath).metadata();
  } catch (err) {
    return { role, absPath, ok: false, reason: `sharp failed to read: ${err.message}` };
  }

  if (!meta.width || !meta.height) {
    return { role, absPath, ok: false, reason: 'no width/height in metadata' };
  }

  const ratio = meta.height / meta.width;
  if (ratio < t.minRatio || ratio > t.maxRatio) {
    return {
      role, absPath, ok: false,
      width: meta.width, height: meta.height, ratio,
      reason: `${meta.width}x${meta.height} h/w=${ratio.toFixed(2)} — expected ${t.expected}`,
    };
  }
  return { role, absPath, ok: true, width: meta.width, height: meta.height, ratio };
}

function listStagedImageFiles() {
  let out;
  try {
    out = execSync('git diff --cached --name-only --diff-filter=ACMR', { encoding: 'utf8' });
  } catch {
    return [];
  }
  return out.split('\n')
    .filter(p => p && FILENAME_RE.test(p) && p.startsWith('public/images/shows/'))
    .map(p => path.join(ROOT, p));
}

function listChangedImageFiles(range) {
  // CI mode: list image files added/modified in the given git range (e.g. "main..HEAD" or "<sha>..<sha>").
  // Pre-existing legacy violations don't block — only files touched by this push/PR are checked.
  let out;
  try {
    out = execSync(`git diff --name-only --diff-filter=ACMR ${range}`, { encoding: 'utf8' });
  } catch {
    return [];
  }
  return out.split('\n')
    .filter(p => p && FILENAME_RE.test(p) && p.startsWith('public/images/shows/'))
    .map(p => path.join(ROOT, p))
    .filter(p => fs.existsSync(p)); // file may have been deleted
}

function listAllArchiveImages() {
  if (!fs.existsSync(SHOWS_DIR)) return [];
  const out = [];
  for (const showId of fs.readdirSync(SHOWS_DIR)) {
    const dir = path.join(SHOWS_DIR, showId);
    let stat;
    try { stat = fs.statSync(dir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (FILENAME_RE.test('/' + f)) out.push(path.join(dir, f));
    }
  }
  return out;
}

function reportViolations(violations, mode) {
  if (violations.length === 0) {
    if (mode !== 'staged') console.log('✓ All images pass aspect-ratio check');
    return 0;
  }

  console.error('');
  console.error(`✗ Found ${violations.length} aspect-ratio violation(s):`);
  console.error('');
  for (const v of violations) {
    const rel = path.relative(ROOT, v.absPath);
    console.error(`  ${rel}`);
    console.error(`    role=${v.role}  ${v.reason}`);
  }
  console.error('');
  console.error('How to fix:');
  console.error('  • Manual commit? Don\'t commit raw images directly. Run:');
  console.error('      node scripts/fetch-show-images-auto.js --show=<show-id> --bad-images');
  console.error('    The auto-fetcher pulls portrait poster art from TodayTix/IBDB/Broadway.org.');
  console.error('  • Bypass for legacy/regional shows with no portrait art available?');
  console.error('    Add the show id to PINNED_IMAGES in scripts/fetch-show-images-auto.js,');
  console.error('    then commit with --no-verify after manual review.');
  console.error('');
  return 1;
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.includes('--staged') ? 'staged'
             : args.includes('--audit') ? 'audit'
             : args.includes('--changed') ? 'changed'
             : args.includes('--files') ? 'files'
             : 'staged'; // default to staged for pre-commit

  let files;
  if (mode === 'staged') {
    files = listStagedImageFiles();
    if (files.length === 0) process.exit(0);
  } else if (mode === 'audit') {
    files = listAllArchiveImages();
    console.log(`Auditing ${files.length} archive images...`);
  } else if (mode === 'changed') {
    const idx = args.indexOf('--changed');
    const range = args[idx + 1] && !args[idx + 1].startsWith('--') ? args[idx + 1] : 'HEAD~1..HEAD';
    files = listChangedImageFiles(range);
    if (files.length === 0) {
      console.log(`No image files changed in range ${range}`);
      process.exit(0);
    }
    console.log(`Checking ${files.length} image file(s) changed in range ${range}...`);
  } else {
    const idx = args.indexOf('--files');
    files = args.slice(idx + 1).map(p => path.isAbsolute(p) ? p : path.resolve(p));
  }

  const violations = [];
  let checked = 0;
  for (const f of files) {
    const r = await checkFile(f);
    if (!r) continue;
    checked++;
    if (!r.ok) violations.push(r);
  }

  if (mode === 'audit') {
    console.log(`Checked ${checked} role-tagged files.`);
  }

  if (args.includes('--quarantine') && mode === 'staged' && violations.length > 0) {
    console.log(`Quarantining ${violations.length} aspect-ratio violation(s) so the rest of the batch can commit:`);
    const removedNewFiles = []; // repo-relative paths whose file no longer exists
    for (const v of violations) {
      const rel = path.relative(ROOT, v.absPath);
      console.log(`  QUARANTINED ${rel} — role=${v.role} ${v.reason}`);
      try {
        execFileSync('git', ['restore', '--staged', '--', rel], { cwd: ROOT });
        // New file (not in HEAD) → delete it; modified file → restore committed version.
        const inHead = (() => {
          try { execFileSync('git', ['cat-file', '-e', `HEAD:${rel}`], { cwd: ROOT, stdio: 'ignore' }); return true; } catch { return false; }
        })();
        if (inHead) {
          execFileSync('git', ['checkout', '--', rel], { cwd: ROOT });
        } else {
          fs.unlinkSync(v.absPath);
          removedNewFiles.push(rel);
        }
      } catch (err) {
        // A failed quarantine leaves the violator staged → the pre-commit
        // gate will abort the batch exactly like before. Make it loud.
        console.error(`::error::quarantine failed for ${rel}: ${err.message}`);
        process.exitCode = 1;
      }
    }

    // A deleted image must not stay referenced from shows.json — that's the
    // dangling-path bug this replaces (steve-burns-alive class). Null the
    // matching images.{role} field for each removed NEW file and restage.
    if (removedNewFiles.length > 0) {
      const showsFile = path.join(ROOT, 'data', 'shows.json');
      try {
        const data = JSON.parse(fs.readFileSync(showsFile, 'utf8'));
        let changed = 0;
        for (const rel of removedNewFiles) {
          const m = rel.match(/^public\/images\/shows\/([^/]+)\/(poster|thumbnail|hero)\./i);
          if (!m) continue;
          const [, showId, role] = m;
          const show = data.shows.find(s => s.id === showId);
          const webPath = '/' + rel.replace(/^public\//, '');
          if (show && show.images && show.images[role.toLowerCase()] === webPath) {
            show.images[role.toLowerCase()] = null;
            changed++;
            console.log(`  cleared shows.json images.${role.toLowerCase()} for ${showId}`);
          } else if (show && show.images && show.images[role.toLowerCase()]) {
            // Path drift between the deleted file and the recorded field means
            // a dangling reference may ship — the exact bug this fix prevents.
            console.error(`::warning::deleted ${rel} but ${showId} images.${role.toLowerCase()} is "${show.images[role.toLowerCase()]}" (no exact match) — check for a dangling path`);
          }
        }
        if (changed > 0) {
          fs.writeFileSync(showsFile, JSON.stringify(data, null, 2) + '\n');
        }
      } catch (err) {
        console.error(`::error::shows.json cleanup failed after quarantine: ${err.message}`);
        process.exitCode = 1;
      }
    }
    process.exit(0);
  }

  process.exit(reportViolations(violations, mode));
}

main().catch(err => {
  console.error('check-image-aspect: unexpected error:', err);
  process.exit(2);
});
