#!/usr/bin/env node
/**
 * audit-image-aspect.js
 *
 * Sharp-metadata-only audit of poster/thumbnail/hero aspect ratios across
 * the entire archive. No LLM calls — cheap geometry check.
 *
 * Same lifecycle as audit-images-llm.js:
 *   1. Scan public/images/shows/{showId}/{role}.{webp,jpg,jpeg,png}
 *   2. For each violating file: archive to data/audit/deleted-images/{showId}/
 *      and (if --apply) null out shows.images[role] so re-fetch picks it up
 *   3. Re-fetch via fetch-show-images-auto.js --bad-images on next run
 *
 * Why separate from audit-images-llm.js: that script is thumbnail-specific
 * end-to-end (applyChanges hardcodes thumbnail at :635, scan loop reads
 * only show.images.thumbnail at :475). Retrofitting would touch the heart
 * of the LLM-identity audit. Single-responsibility split keeps blast radius small.
 *
 * Usage:
 *   node scripts/audit-image-aspect.js                  # Dry-run report
 *   node scripts/audit-image-aspect.js --apply          # Archive bad files + null shows.json entries
 *   node scripts/audit-image-aspect.js --show=<id>      # Single show
 *   node scripts/audit-image-aspect.js --json           # Machine-readable output
 *
 * Outputs: data/audit/image-aspect-audit.json (always written)
 */

const fs = require('fs');
const path = require('path');

let sharp;
try {
  sharp = require('sharp');
} catch {
  console.error('audit-image-aspect: sharp not installed — run npm install');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');
const IMAGES_DIR = path.join(ROOT, 'public', 'images', 'shows');
const AUDIT_DIR = path.join(ROOT, 'data', 'audit');
const DELETED_DIR = path.join(AUDIT_DIR, 'deleted-images');
const OUTPUT_PATH = path.join(AUDIT_DIR, 'image-aspect-audit.json');

// Thresholds set at "definitely visually broken" line — image renders as a sliver
// inside its container. Looser bounds avoid flagging legitimate edge cases:
//   - square IBDB posters (h/w=1.00) render acceptably in aspect-[2/3] (center-cropped top/bottom)
//   - portrait thumbnails (h/w<=1.70) render fine in square containers (center-cropped sides keep subject)
// See `scripts/check-image-aspect.js` for the matching pre-commit thresholds.
const THRESHOLDS = {
  poster:    { minRatio: 1.00, maxRatio: Infinity, expected: 'portrait or square (h/w >= 1.0)' },
  thumbnail: { minRatio: 0.85, maxRatio: 1.70,     expected: 'square or mild-portrait (0.85 <= h/w <= 1.70)' },
  hero:      { minRatio: 0,    maxRatio: 0.85,     expected: 'landscape (h/w <= 0.85)' },
};

const ROLES = ['poster', 'thumbnail', 'hero'];
const EXTENSIONS = ['webp', 'jpg', 'jpeg', 'png'];

function findRoleFile(showId, role) {
  const dir = path.join(IMAGES_DIR, showId);
  if (!fs.existsSync(dir)) return null;
  for (const ext of EXTENSIONS) {
    const p = path.join(dir, `${role}.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function checkRole(showId, role) {
  const filePath = findRoleFile(showId, role);
  if (!filePath) return null; // no file at this role

  const t = THRESHOLDS[role];
  let meta;
  try {
    meta = await sharp(filePath).metadata();
  } catch (err) {
    return { showId, role, filePath, ok: false, reason: `sharp read failed: ${err.message}` };
  }
  if (!meta.width || !meta.height) {
    return { showId, role, filePath, ok: false, reason: 'no width/height in metadata' };
  }
  const ratio = meta.height / meta.width;
  const ok = ratio >= t.minRatio && ratio <= t.maxRatio;
  return {
    showId, role, filePath,
    width: meta.width, height: meta.height,
    ratio: +ratio.toFixed(3),
    ok,
    reason: ok ? null : `${meta.width}x${meta.height} h/w=${ratio.toFixed(2)} — expected ${t.expected}`,
  };
}

function archiveAndDelete(filePath, showId) {
  const archiveDir = path.join(DELETED_DIR, showId);
  fs.mkdirSync(archiveDir, { recursive: true });
  const archivePath = path.join(archiveDir, path.basename(filePath));
  // If archive already exists from a prior run, suffix to avoid clobber
  let target = archivePath;
  let n = 1;
  while (fs.existsSync(target)) {
    const ext = path.extname(archivePath);
    const base = archivePath.slice(0, -ext.length);
    target = `${base}.${n}${ext}`;
    n++;
  }
  fs.copyFileSync(filePath, target);
  fs.unlinkSync(filePath);
  return target;
}

function nullOutShowsJson(violations) {
  // Surgical merge per .github/workflows/CLAUDE.md "Public Show JSON Safety":
  // read the existing object, mutate only the affected images.{role}, write back.
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const showsArr = showsData.shows || showsData;
  const isObject = !Array.isArray(showsArr);

  let updated = 0;
  for (const v of violations) {
    let show;
    if (isObject) {
      show = showsArr[v.showId];
    } else {
      show = showsArr.find(s => s.id === v.showId);
    }
    if (!show || !show.images) continue;
    if (show.images[v.role] != null) {
      show.images[v.role] = null;
      updated++;
    }
  }
  fs.writeFileSync(SHOWS_PATH, JSON.stringify(showsData, null, 2) + '\n');
  return updated;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const jsonOut = args.includes('--json');
  const singleShow = args.find(a => a.startsWith('--show='))?.split('=')[1] || null;

  if (!fs.existsSync(SHOWS_PATH)) {
    console.error(`shows.json not found at ${SHOWS_PATH}`);
    process.exit(1);
  }
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const showsArr = showsData.shows || showsData;
  const shows = Array.isArray(showsArr) ? showsArr : Object.values(showsArr);

  const targetShows = singleShow ? shows.filter(s => s.id === singleShow) : shows;
  if (singleShow && targetShows.length === 0) {
    console.error(`Show not found: ${singleShow}`);
    process.exit(1);
  }

  if (!jsonOut) {
    console.log(`Auditing ${targetShows.length} show(s) × ${ROLES.length} roles...`);
  }

  const results = []; // every check (ok or not)
  const violations = []; // ok=false subset
  for (const show of targetShows) {
    for (const role of ROLES) {
      const r = await checkRole(show.id, role);
      if (!r) continue;
      results.push(r);
      if (!r.ok) violations.push(r);
    }
  }

  const summary = {
    auditedAt: new Date().toISOString(),
    totalShows: targetShows.length,
    totalChecks: results.length,
    violations: violations.length,
    byRole: {
      poster: violations.filter(v => v.role === 'poster').length,
      thumbnail: violations.filter(v => v.role === 'thumbnail').length,
      hero: violations.filter(v => v.role === 'hero').length,
    },
    apply,
  };

  // Always write the report
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ summary, violations }, null, 2) + '\n');

  if (jsonOut) {
    console.log(JSON.stringify({ summary, violations }, null, 2));
  } else {
    console.log('');
    console.log(`Total checks:    ${summary.totalChecks}`);
    console.log(`Violations:      ${summary.violations}`);
    console.log(`  poster:        ${summary.byRole.poster}`);
    console.log(`  thumbnail:     ${summary.byRole.thumbnail}`);
    console.log(`  hero:          ${summary.byRole.hero}`);
    console.log('');

    if (violations.length > 0 && !apply) {
      const sample = violations.slice(0, 10);
      console.log('First 10 violations:');
      for (const v of sample) {
        const rel = path.relative(ROOT, v.filePath);
        console.log(`  ${rel}  (${v.reason})`);
      }
      if (violations.length > 10) console.log(`  ... and ${violations.length - 10} more (see ${path.relative(ROOT, OUTPUT_PATH)})`);
      console.log('');
      console.log('Re-run with --apply to archive bad files and null images.{role} in shows.json.');
      console.log('Then run: node scripts/fetch-show-images-auto.js --bad-images');
    }
  }

  if (apply && violations.length > 0) {
    let archived = 0;
    for (const v of violations) {
      try {
        archiveAndDelete(v.filePath, v.showId);
        archived++;
      } catch (err) {
        console.error(`  failed to archive ${v.filePath}: ${err.message}`);
      }
    }
    const updated = nullOutShowsJson(violations);
    if (!jsonOut) {
      console.log(`Archived ${archived} bad files to ${path.relative(ROOT, DELETED_DIR)}/`);
      console.log(`Nulled ${updated} entries in shows.json (images.{role} = null)`);
      console.log('');
      console.log('Next: node scripts/fetch-show-images-auto.js --bad-images');
    }
  }

  process.exit(violations.length > 0 && !apply ? 1 : 0);
}

main().catch(err => {
  console.error('audit-image-aspect: unexpected error:', err);
  process.exit(2);
});
