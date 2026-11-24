/**
 * BRO-8056 phase 1b: write data/show-refresh-manifest.json at prebuild.
 *
 * Names exactly what this build rendered: each show's slice hash, its held
 * (TBD) verdict at the build instant, its image identity, plus the sha of
 * every data file a slice is cut from. The publisher (1d) and the reader
 * (phase 2) use it to tell which shows changed since this build.
 *
 * Run through scripts/run-show-refresh-manifest.js (fail-soft: a failure here
 * never fails the build, it only leaves no manifest, and show refresh stays off
 * for that build). The pure parts live in scripts/lib/show-refresh/.
 *
 *   node --import tsx scripts/build-show-refresh-manifest.ts
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { computeShowStates } from './lib/show-refresh/compute-show-states';

/* eslint-disable @typescript-eslint/no-require-imports */
const manifestLib = require('./lib/show-refresh/manifest');
const { buildManifest, MANIFEST_FILE } = manifestLib;
const { writeSiteImageVersions } = require('./lib/site-image-versions');
/* eslint-enable @typescript-eslint/no-require-imports */

const ROOT = path.join(__dirname, '..');

/** The slice input files (defined in show-refresh/manifest.js, shared with the verifier). */
export const SLICE_REQUIRED_FILES: string[] = manifestLib.SLICE_REQUIRED_FILES;
export const SLICE_OPTIONAL_FILES: string[] = manifestLib.SLICE_OPTIONAL_FILES;
export const SLICE_INPUT_FILES: string[] = manifestLib.SLICE_INPUT_FILES;

/** This repo's commit: git HEAD, else the CI-provided sha, else null. */
export function resolvePublicSha(env: NodeJS.ProcessEnv = process.env, cwd = ROOT): string | null {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (/^[0-9a-f]{40}$/.test(sha)) return sha;
  } catch { /* no git (tarball build) */ }
  return env.VERCEL_GIT_COMMIT_SHA || env.GITHUB_SHA || null;
}

function writeAtomic(file: string, text: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: node --import tsx scripts/build-show-refresh-manifest.ts\nWrites data/show-refresh-manifest.json (BRO-8056).');
    return;
  }
  const dataDir = path.join(ROOT, 'data');
  const buildInstant = Date.now();
  // Same images map next.config.js writes; written here first so the versioned
  // image paths below match the ones this build's pages render, and before the
  // data read so its hash is in dataShas.
  const imageVersions: Record<string, unknown> = writeSiteImageVersions();
  // The per-show compute (slice hash, held verdict, images, review meta) is
  // shared with the publisher (BRO-8214), so both name a show the same way.
  const states = computeShowStates({ dataDir, now: buildInstant });
  const { dataFiles, absentFiles, registryFile } = states;

  const shows: Array<{ id: string; slug: string; images?: object }> = [];
  const sliceHashById = new Map<string, string>();
  const heldById = new Map<string, boolean>();
  const reviewMetaById = new Map<string, { reviewCount: number; reviewsSig: string }>();
  for (const id of states.order) {
    const st = states.perShow[id];
    shows.push({ id, slug: st.slug, images: st.images });
    sliceHashById.set(id, st.hash as string);
    heldById.set(id, st.held === true);
    reviewMetaById.set(id, { reviewCount: st.reviewCount as number, reviewsSig: st.reviewsSig as string });
  }

  const coreShaFile = path.join(dataDir, '.core-data-sha');
  const coreSha = fs.existsSync(coreShaFile) ? fs.readFileSync(coreShaFile, 'utf8').trim() || null : null;
  const manifest = buildManifest({
    manifestId: crypto.randomUUID(),
    buildInstant,
    coreSha,
    publicSha: resolvePublicSha(),
    registryFile,
    dataFiles,
    absentFiles,
    imageKeys: Object.keys(imageVersions),
    shows,
    sliceHashById,
    heldById,
    reviewMetaById,
  });
  const text = JSON.stringify(manifest);
  writeAtomic(path.join(ROOT, MANIFEST_FILE), text);
  const held = Object.values(manifest.shows).filter((s) => (s as { held: boolean }).held).length;
  console.log(`[show-refresh-manifest] ${manifest.showCount} shows (${held} held), ${Math.round(text.length / 1024)}KB -> ${MANIFEST_FILE}`);
}

if (require.main === module) main();
