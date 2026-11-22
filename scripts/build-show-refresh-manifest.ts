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
import { computeOneShow } from '../src/lib/compute-one-show';
import { computeShowTBD } from '../src/lib/show-score-tbd';
import type { RawShow, RawReview, RawAudience, RawBuzzThread } from '../src/lib/engine';

/* eslint-disable @typescript-eslint/no-require-imports */
const { buildShowInputs, computableShows } = require('./lib/show-refresh/inputs');
const { indexForSlices, sliceFor, sliceHash } = require('./lib/show-refresh/slice');
const { buildManifest, MANIFEST_FILE } = require('./lib/show-refresh/manifest');
const { readCoverageFloorInputs } = require('./lib/coverage-floor-inputs');
const { writeSiteImageVersions } = require('./lib/site-image-versions');
/* eslint-enable @typescript-eslint/no-require-imports */

const ROOT = path.join(__dirname, '..');

/**
 * Every data file a slice, or the compute of a slice, reads. A change to any
 * of them can change a show's page, so the postbuild verifier checks none of
 * them moved during the build. Required files must exist; the optional ones
 * are read fail-open by their loaders (coverage floor), so absent is allowed.
 */
export const SLICE_REQUIRED_FILES = [
  'shows.json',
  'reviews.json',
  'blog-reviews-for-scoring.json',
  'audience.json',
  'buzz.json',
  'outlet-registry.json',
  'critic-consensus.json',
  'audience-buzz.json',
  'score-gate-overrides.json',
];
export const SLICE_OPTIONAL_FILES = [
  'coverage-floor-snapshot.json',
  'audit/show-review-gap.json',
  'audit/score-public-since.json',
  'audit/t1-coverage-ack.json',
];
export const SLICE_INPUT_FILES = [...SLICE_REQUIRED_FILES, ...SLICE_OPTIONAL_FILES];

/** This repo's commit: git HEAD, else the CI-provided sha, else null. */
export function resolvePublicSha(env: NodeJS.ProcessEnv = process.env, cwd = ROOT): string | null {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (/^[0-9a-f]{40}$/.test(sha)) return sha;
  } catch { /* no git (tarball build) */ }
  return env.VERCEL_GIT_COMMIT_SHA || env.GITHUB_SHA || null;
}

function readDataFiles(dataDir: string): { files: Record<string, Buffer>; absent: string[] } {
  const files: Record<string, Buffer> = {};
  const absent: string[] = [];
  for (const name of SLICE_INPUT_FILES) {
    const file = path.join(dataDir, name);
    if (!fs.existsSync(file)) {
      if (SLICE_REQUIRED_FILES.includes(name)) throw new Error(`required data file missing: data/${name}`);
      absent.push(name);
      continue;
    }
    files[name] = fs.readFileSync(file);
  }
  return { files, absent };
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
  const { files: dataFiles, absent: absentFiles } = readDataFiles(dataDir);
  const json = (name: string) => JSON.parse(dataFiles[name].toString('utf8'));

  const inputs = buildShowInputs({
    showsData: json('shows.json'),
    reviews: json('reviews.json').reviews,
    blogReviews: json('blog-reviews-for-scoring.json').reviews,
    audience: json('audience.json').audience,
    buzz: json('buzz.json').threads,
  });
  const registryFile = json('outlet-registry.json');
  const coverageFloorInputs = readCoverageFloorInputs({
    gapAudit: path.join(dataDir, 'audit', 'show-review-gap.json'),
    stamps: path.join(dataDir, 'audit', 'score-public-since.json'),
    acks: path.join(dataDir, 'audit', 't1-coverage-ack.json'),
    snapshot: path.join(dataDir, 'coverage-floor-snapshot.json'),
  });
  const index = indexForSlices(inputs, {
    consensusById: json('critic-consensus.json').shows,
    audienceBuzzById: json('audience-buzz.json').shows,
    coverageFloorInputs,
  });

  // Same images map next.config.js writes; written here first so the versioned
  // image paths below match the ones this build's pages render.
  const imageVersions: Record<string, unknown> = writeSiteImageVersions();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { versionedImagePath } = require('../src/lib/versioned-image-path');
  // The shows the show page prerenders (generateStaticParams), by the same
  // function, so the manifest names exactly what this build rendered.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getRecentShowSlugs } = require('../src/lib/data-core');
  const prerendered = new Set<string>(getRecentShowSlugs());

  const shows: Array<{ id: string; slug: string; images?: object }> = [];
  const sliceHashById = new Map<string, string>();
  const heldById = new Map<string, boolean>();
  for (const row of computableShows(inputs) as RawShow[]) {
    if (!prerendered.has(row.slug)) continue;
    const computed = computeOneShow(row, (inputs.reviewsByShowId.get(row.id) || []) as RawReview[], {
      blogReviews: (inputs.blogReviewsByShowId.get(row.id) || []) as RawReview[],
      audience: inputs.audience as RawAudience[],
      buzz: inputs.buzz as RawBuzzThread[],
      coverageFloorInputs,
      versionImage: versionedImagePath,
      now: buildInstant,
      registry: registryFile.outlets,
    });
    const slice = sliceFor(row.id, index);
    if (!slice) continue;
    shows.push({ id: computed.id, slug: computed.slug, images: computed.images });
    sliceHashById.set(row.id, sliceHash(slice));
    heldById.set(row.id, computeShowTBD(computed, buildInstant));
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
  });
  const text = JSON.stringify(manifest);
  writeAtomic(path.join(ROOT, MANIFEST_FILE), text);
  const held = Object.values(manifest.shows).filter((s) => (s as { held: boolean }).held).length;
  console.log(`[show-refresh-manifest] ${manifest.showCount} shows (${held} held), ${Math.round(text.length / 1024)}KB -> ${MANIFEST_FILE}`);
}

if (require.main === module) main();
