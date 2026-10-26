#!/usr/bin/env node
/**
 * Right-size per-show images in place (BRO-5990).
 *
 *   node scripts/resize-show-images.js            # re-encode oversized files (same path + extension)
 *   node scripts/resize-show-images.js --check    # list oversized files, exit 1 if any
 *   node scripts/resize-show-images.js --dry-run  # report what would change
 *   node scripts/resize-show-images.js --variants        # also write missing/stale <show>/sm/ list variants (BRO-6277)
 *   node scripts/resize-show-images.js --check-variants  # list originals without a variant, exit 1 if any (advisory)
 *
 * Widths come from scripts/lib/show-image-caps.js. A file is only rewritten when
 * the re-encoded result is smaller. sharp drops metadata by default.
 */
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { listShowDirs } = require('./lib/list-show-dirs.js');
const { VARIANT_WIDTHS, variantPathFor, writeVariant, IMAGE_WIDTH_CAPS, encodeToCap, WIDTH_CAP_EXCEPTIONS, imageRoleFromFilename, exceedsWidthCap } = require('./lib/show-image-caps');

const IMAGES_DIR = path.join(__dirname, '..', 'public', 'images', 'shows');

function listImageFiles(dir = IMAGES_DIR) {
  const out = [];
  for (const d of listShowDirs(dir, { silent: true })) {
    const p = path.join(dir, d);
    for (const f of fs.readdirSync(p)) {
      const role = imageRoleFromFilename(f);
      if (role) out.push({ abs: path.join(p, f), rel: `${d}/${f}`, role, ext: f.split('.').pop().toLowerCase().replace('jpeg', 'jpg') });
    }
  }
  return out;
}

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log('Usage: node scripts/resize-show-images.js [--check | --dry-run | --variants [--staged] | --check-variants]\n  (no flag) re-encode oversized posters/thumbnails in place; --check lists them and exits 1 if any'); return; }
  if (process.argv.includes('--check-variants')) {
    const sharp = require('sharp');
    const missing = [];
    let total = 0;
    for (const f of listImageFiles()) {
      const out = variantPathFor(f.abs);
      if (!out || f.role === 'hero') continue;
      let width; try { width = (await sharp(f.abs).metadata()).width; } catch { continue; }
      if (width <= VARIANT_WIDTHS[f.role]) continue; // already small: srcset needs no variant
      total++;
      if (!fs.existsSync(out)) missing.push(f.rel);
    }
    // A variant whose original is gone would be served by srcset with no fallback.
    for (const d of fs.readdirSync(IMAGES_DIR)) {
      const smDir = path.join(IMAGES_DIR, d, 'sm');
      if (!fs.existsSync(smDir)) continue;
      const names = fs.readdirSync(path.join(IMAGES_DIR, d)).map(n => n.toLowerCase());
      for (const v of fs.readdirSync(smDir)) if (!names.includes(v.replace(/\.webp$/, ''))) missing.push(`${d}/sm/${v} (orphan)`);
    }
    missing.slice(0, 40).forEach(m => console.log(`no sm/ variant: ${m}`));
    console.log(`${missing.length} of ${total} poster/thumbnail originals lack a list variant (fix: node scripts/resize-show-images.js --variants)`);
    process.exit(missing.length ? 1 : 0);
  }
  if (process.argv.includes('--variants')) {
    const tally = {};
    // --staged (CI commit steps): only originals staged for commit, run AFTER
    // check-image-aspect --quarantine so rejected art never gets a variant, then
    // stage the variants next to them.
    const staged = process.argv.includes('--staged');
    let files = listImageFiles();
    if (staged) {
      const { execFileSync } = require('child_process');
      const names = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '--', 'public/images/shows'], { encoding: 'utf8' }).split('\n').filter(Boolean);
      const set = new Set(names);
      files = files.filter(f => set.has(`public/images/shows/${f.rel}`));
    }
    const written = [];
    for (const f of files) {
      if (f.role === 'hero' || !variantPathFor(f.abs)) continue;
      const r = await writeVariant(f.abs, { force: staged });
      tally[r] = (tally[r] || 0) + 1;
      if (r === 'written') written.push(variantPathFor(f.abs));
    }
    // A variant whose original is gone (deleted or quarantined) must not outlive it.
    for (const d of fs.readdirSync(IMAGES_DIR)) {
      const smDir = path.join(IMAGES_DIR, d, 'sm');
      if (!fs.existsSync(smDir)) continue;
      for (const v of fs.readdirSync(smDir)) {
        const orig = v.replace(/\.webp$/, '');
        const hasOrig = fs.readdirSync(path.join(IMAGES_DIR, d)).some(n => n.toLowerCase() === orig);
        if (!hasOrig) { fs.rmSync(path.join(smDir, v)); tally.pruned = (tally.pruned || 0) + 1; }
      }
    }
    if (staged) {
      const { execFileSync } = require('child_process');
      const smDirs = fs.readdirSync(IMAGES_DIR).map(d => path.join(IMAGES_DIR, d, 'sm')).filter(p => fs.existsSync(p));
      // Never run a path-less `git add -A` (it would stage the whole tree).
      if (smDirs.length) execFileSync('git', ['add', '-A', '--', ...smDirs], { stdio: 'inherit' });
    }
    console.log('variants:', JSON.stringify(tally));
    return;
  }
  const check = process.argv.includes('--check');
  const dry = process.argv.includes('--dry-run');
  const sharp = require('sharp');
  const files = listImageFiles();
  let over = 0, rewritten = 0, kept = 0, before = 0, after = 0;
  const list = [];
  for (const f of files) {
    let width;
    try { width = (await sharp(f.abs).metadata()).width; } catch { continue; }
    if (!exceedsWidthCap(f.role, width) || WIDTH_CAP_EXCEPTIONS[f.rel]) continue;
    over++;
    if (check) { list.push(`${f.rel} ${width}px > ${IMAGE_WIDTH_CAPS[f.role]}`); continue; }
    const buf = fs.readFileSync(f.abs);
    const out = await encodeToCap(buf, f.role, f.ext);
    if (out.length >= buf.length) { kept++; continue; }
    before += buf.length; after += out.length; rewritten++;
    if (!dry) fs.writeFileSync(f.abs, out);
  }
  if (check) {
    list.slice(0, 40).forEach(l => console.log(l));
    console.log(`${over} oversized of ${files.length} images (poster>${IMAGE_WIDTH_CAPS.poster}px, thumbnail>${IMAGE_WIDTH_CAPS.thumbnail}px, hero>${IMAGE_WIDTH_CAPS.hero}px)`);
    process.exit(over ? 1 : 0);
  }
  console.log(`oversized ${over}; ${dry ? 'would rewrite' : 'rewrote'} ${rewritten}; kept ${kept} (not smaller); ${(before / 1048576).toFixed(1)}MB -> ${(after / 1048576).toFixed(1)}MB`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(2); });
module.exports = { listImageFiles };
