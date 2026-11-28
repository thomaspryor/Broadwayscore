/**
 * BRO-8214: the per-show compute the manifest builder and the show-refresh
 * publisher share, so both name a show by the same slice hash, held verdict,
 * image identity and review meta. Extracted from
 * scripts/build-show-refresh-manifest.ts without behaviour change (the builder
 * writes a byte-identical manifest for the same inputs).
 *
 * Reads the slice input files from `dataDir`; never writes. The caller decides
 * the clock (`now`): the builder uses its build instant, the publisher the
 * manifest's buildInstant.
 */
import fs from 'fs';
import path from 'path';
import { computeOneShow } from '../../../src/lib/compute-one-show';
import { computeShowTBD } from '../../../src/lib/show-score-tbd';
import type { RawShow, RawReview, RawAudience, RawBuzzThread } from '../../../src/lib/engine';

/* eslint-disable @typescript-eslint/no-require-imports */
const { buildShowInputs, computableShows } = require('./inputs');
const { indexForSlices, sliceFor, sliceHash, reviewMeta, SLICE_VERSION } = require('./slice');
const manifestLib = require('./manifest');
const { readCoverageFloorInputs } = require('../coverage-floor-inputs');
/* eslint-enable @typescript-eslint/no-require-imports */

const SLICE_REQUIRED_FILES: string[] = manifestLib.SLICE_REQUIRED_FILES;
const SLICE_INPUT_FILES: string[] = manifestLib.SLICE_INPUT_FILES;

export const DEFAULT_DATA_DIR = path.join(__dirname, '..', '..', '..', 'data');

export function readDataFiles(dataDir: string): { files: Record<string, Buffer>; absent: string[] } {
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

export interface ShowState {
  slug: string;
  slice?: Record<string, unknown>;
  hash?: string;
  held?: boolean;
  images?: object;
  imagesSig?: string;
  reviewCount?: number;
  reviewsSig?: string;
  error?: string;
}

export interface ComputeShowStatesOptions {
  /** Directory holding the slice input files (default: this repo's data/). */
  dataDir?: string;
  /** ms epoch: the clock every compute uses. */
  now: number;
  /** Parsed shows.json to use instead of the file (e.g. healed HEAD rows). dataFiles still hash the file. */
  showsOverride?: { shows: unknown[] };
  /** Slugs to compute (the build's prerendered set). Default: data-core getRecentShowSlugs(). */
  prerenderedSlugs?: Iterable<string>;
  /** Also compute these ids even when their slug is not in prerenderedSlugs. */
  extraIds?: Iterable<string>;
  /** Record a throwing show as { error } instead of failing the whole run (publisher). */
  catchErrors?: boolean;
}

export interface ShowStates {
  sliceVersion: number;
  registrySha: string;
  registryFile: { outlets: unknown; [k: string]: unknown };
  dataFiles: Record<string, Buffer>;
  absentFiles: string[];
  /** Computed ids in shows.json order (computableShows order). */
  order: string[];
  perShow: Record<string, ShowState>;
  /** The coverage floor as built (COVERAGE_GATE_DISABLED applied), for callers that recompute. */
  coverageFloorInputs: unknown;
  inputs: ReturnType<typeof buildShowInputs>;
}

export function computeShowStates(o: ComputeShowStatesOptions): ShowStates {
  if (!Number.isFinite(o.now)) throw new Error('computeShowStates: now (ms epoch) is required');
  const dataDir = o.dataDir || DEFAULT_DATA_DIR;
  const now = o.now;
  const { files: dataFiles, absent: absentFiles } = readDataFiles(dataDir);
  const json = (name: string) => JSON.parse(dataFiles[name].toString('utf8'));

  const inputs = buildShowInputs({
    showsData: o.showsOverride || json('shows.json'),
    reviews: json('reviews.json').reviews,
    blogReviews: json('blog-reviews-for-scoring.json').reviews,
    audience: json('audience.json').audience,
    buzz: json('buzz.json').threads,
  });
  const registryFile = json('outlet-registry.json');
  const coverageFiles = {
    gapAudit: path.join(dataDir, 'audit', 'show-review-gap.json'),
    stamps: path.join(dataDir, 'audit', 'score-public-since.json'),
    acks: path.join(dataDir, 'audit', 't1-coverage-ack.json'),
    snapshot: path.join(dataDir, 'coverage-floor-snapshot.json'),
  };
  // As built (COVERAGE_GATE_DISABLED applied), for this build's held verdicts.
  const coverageFloorInputs = readCoverageFloorInputs(coverageFiles);
  const index = indexForSlices(inputs, {
    consensusById: json('critic-consensus.json').shows,
    audienceBuzzById: json('audience-buzz.json').shows,
    // Slices carry coverage with the kill switch ignored ({} env), like the
    // coverage-floor snapshot: slice.js applies it at render time, so slice
    // hashes do not depend on the environment.
    coverageFloorInputs: readCoverageFloorInputs(coverageFiles, {}),
  });

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { versionedImagePath } = require('../../../src/lib/versioned-image-path');
  let prerenderedSlugs = o.prerenderedSlugs;
  if (!prerenderedSlugs) {
    // The shows the show page prerenders (generateStaticParams), by the same
    // function, so the manifest names exactly what this build rendered.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getRecentShowSlugs } = require('../../../src/lib/data-core');
    prerenderedSlugs = getRecentShowSlugs() as string[];
  }
  const prerendered = new Set<string>(prerenderedSlugs);
  const extra = new Set<string>(o.extraIds || []);

  const order: string[] = [];
  const perShow: Record<string, ShowState> = {};
  for (const row of computableShows(inputs) as RawShow[]) {
    if (!prerendered.has(row.slug) && !extra.has(row.id)) continue;
    try {
      const computed = computeOneShow(row, (inputs.reviewsByShowId.get(row.id) || []) as RawReview[], {
        blogReviews: (inputs.blogReviewsByShowId.get(row.id) || []) as RawReview[],
        audience: inputs.audience as RawAudience[],
        buzz: inputs.buzz as RawBuzzThread[],
        coverageFloorInputs,
        versionImage: versionedImagePath,
        now,
        registry: registryFile.outlets,
      });
      const slice = sliceFor(row.id, index);
      if (!slice) continue;
      const meta = reviewMeta(slice);
      perShow[row.id] = {
        slug: computed.slug,
        slice,
        hash: sliceHash(slice),
        held: computeShowTBD(computed, now),
        images: computed.images,
        imagesSig: manifestLib.imagesSig(computed.images),
        reviewCount: meta.reviewCount,
        reviewsSig: meta.reviewsSig,
      };
      order.push(row.id);
    } catch (e) {
      if (!o.catchErrors) throw e;
      perShow[row.id] = { slug: row.slug, error: e instanceof Error ? e.message : String(e) };
      order.push(row.id);
    }
  }
  return {
    sliceVersion: SLICE_VERSION,
    registrySha: manifestLib.registrySha(registryFile),
    registryFile,
    dataFiles,
    absentFiles,
    order,
    perShow,
    coverageFloorInputs,
    inputs,
  };
}
