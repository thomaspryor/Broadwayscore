/**
 * BRO-8214 (BRO-8056 plan v14-final §1.5): the show-refresh publisher. L1 is
 * DRY-RUN ONLY: it plans what it would publish and writes a report; it never
 * writes to the store.
 *
 *   npx tsx scripts/publish-show-refresh.ts [--dry-run] [--manifest=<file|url>]
 *     [--report=<json>] [--flagged-file=<path>] [--rebuild-step] [--parity[=all]] [--cap=40]
 *
 * Steps: load the live build manifest (default: the deployed static route) ->
 * heal HEAD shows.json like pre-deploy-check.js, but with today = the build's
 * date -> compute every show at the build's instant (computeShowStates, the
 * builder's own compute) -> read home/kill from the store when its env is set
 * (anon read; absent env = no previous home) -> planPublish -> report.
 *
 * --parity: for each target (or every computed, non-held show with
 * --parity=all) render the JSON round-tripped slice the way renderFromSlice
 * does and deep-compare it with the direct HEAD compute; the count of
 * differences goes in the report.
 *
 * --write exits 2: writes are not enabled in L1 (and are refused outside CI).
 * Every planned outcome, including an unreachable or unusable manifest, exits 0.
 */
import fs from 'fs';
import path from 'path';
import { isDeepStrictEqual } from 'util';
import { computeOneShow } from '../src/lib/compute-one-show';
import type { RawShow, RawReview, RawAudience, RawBuzzThread } from '../src/lib/engine';
import { computeShowStates } from './lib/show-refresh/compute-show-states';

/* eslint-disable @typescript-eslint/no-require-imports */
const { planPublish, OUTCOMES, DEFAULT_CAP } = require('./lib/show-refresh/publish-plan');
const { isUsableManifest } = require('./lib/show-refresh/manifest');
const { coverageInputsFromSlice } = require('./lib/show-refresh/slice');
const store = require('./lib/show-refresh/store');
const { healShows } = require('./lib/heal-shows');
/* eslint-enable @typescript-eslint/no-require-imports */

const ROOT = path.join(__dirname, '..');
export const DEFAULT_MANIFEST_URL = 'https://broadwayscorecard.com/api/show-refresh/manifest';

export interface PublishArgs {
  manifest: string;
  mode: 'dry-run' | 'write';
  report: string | null;
  flaggedFile: string | null;
  rebuildStep: boolean;
  parity: false | 'targets' | 'all';
  cap: number;
  help: boolean;
}

/** Pure argv parser. Unknown flags throw (a typo must not silently publish). */
export function parseArgs(argv: string[]): PublishArgs {
  const a: PublishArgs = { manifest: DEFAULT_MANIFEST_URL, mode: 'dry-run', report: null, flaggedFile: null, rebuildStep: false, parity: false, cap: DEFAULT_CAP, help: false };
  let sawDry = false;
  let sawWrite = false;
  for (const arg of argv) {
    const [k, ...rest] = arg.split('=');
    const v = rest.join('=');
    const need = () => { if (!v) throw new Error(`${k} needs a value`); return v; };
    switch (k) {
      case '--help': case '-h': a.help = true; break;
      case '--dry-run': sawDry = true; break;
      case '--write': sawWrite = true; a.mode = 'write'; break;
      case '--manifest': a.manifest = need(); break;
      case '--report': a.report = need(); break;
      case '--flagged-file': a.flaggedFile = need(); break;
      case '--rebuild-step': a.rebuildStep = true; break;
      case '--parity':
        if (v && v !== 'all' && v !== 'targets') throw new Error(`--parity takes no value, =targets or =all (got ${v})`);
        a.parity = v === 'all' ? 'all' : 'targets'; break;
      case '--cap': {
        const n = Number(need());
        if (!Number.isInteger(n) || n < 0) throw new Error(`--cap must be a non-negative integer (got ${v})`);
        a.cap = n; break;
      }
      default: throw new Error(`unknown argument ${arg}`);
    }
  }
  if (sawDry && sawWrite) throw new Error('--dry-run and --write are exclusive');
  return a;
}

/** Whitespace-separated ids (the --flagged-file format publish-live-scores.ts reads). */
export function readFlagged(file: string | null): Set<string> {
  if (!file || !fs.existsSync(file)) return new Set();
  return new Set(fs.readFileSync(file, 'utf8').split(/\s+/).filter(Boolean));
}

/** The manifest from a file or URL, or { manifest: null, error } (never throws). */
export async function loadManifest(src: string, fetchImpl: typeof fetch = fetch): Promise<{ manifest: unknown; error: string | null }> {
  try {
    if (/^https?:\/\//.test(src)) {
      const res = await fetchImpl(src, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) return { manifest: null, error: `HTTP ${res.status} from ${src}` };
      return { manifest: await res.json(), error: null };
    }
    return { manifest: JSON.parse(fs.readFileSync(src, 'utf8')), error: null };
  } catch (e) {
    return { manifest: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Heal HEAD shows.json exactly like pre-deploy-check.js, with the build's date. */
function healedHeadShows(dataDir: string, today: string) {
  const showsData = JSON.parse(fs.readFileSync(path.join(dataDir, 'shows.json'), 'utf8'));
  const imagesDir = path.join(ROOT, 'public', 'images', 'shows');
  const publicDir = path.join(ROOT, 'public');
  let imageSources = {};
  try { imageSources = JSON.parse(fs.readFileSync(path.join(dataDir, 'image-sources.json'), 'utf8')); } catch { /* as pre-deploy-check */ }
  const reviewsData = JSON.parse(fs.readFileSync(path.join(dataDir, 'reviews.json'), 'utf8'));
  const reviewCountByShow: Record<string, number> = {};
  for (const r of (reviewsData.reviews || reviewsData || [])) reviewCountByShow[r.showId] = (reviewCountByShow[r.showId] || 0) + 1;
  const heal = healShows(showsData, {
    today,
    imagesPresent: fs.existsSync(imagesDir),
    imageExists: (p: string) => fs.existsSync(path.join(publicDir, p)),
    imageSources,
    reviewCountByShow,
  });
  return { showsData, healChanged: heal.changed as boolean };
}

/** home + kill from the store when its env is present; never throws. */
async function readStore(env: NodeJS.ProcessEnv) {
  if (!(env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL) || !env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return { prevHome: null, kill: null, storeNote: 'store env absent: no previous home read' };
  }
  try {
    const st = store.readerStateFromEnv(env, { timeoutMs: 10000 });
    const [home, kill] = await Promise.all([store.readJsonObject(st, store.PATHS.home), store.readJsonObject(st, store.PATHS.kill)]);
    return {
      prevHome: home.state === 'ok' ? home.value : null,
      kill: store.effectiveKill(kill) as { killed: boolean; reason: string },
      storeNote: `home ${home.state}, kill ${kill.state}`,
    };
  } catch (e) {
    return { prevHome: null, kill: null, storeNote: `store read failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function writeReport(file: string | null, report: object) {
  if (!file) return;
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
}

function summaryLine(r: { outcome: string; counts?: { targets?: number; changed?: number; removed?: number; dirty?: number; eligible?: number }; parity?: { checked: number; diffs: number } | null; ms?: number }) {
  const c = r.counts || {};
  const parts = [`outcome=${r.outcome}`, `targets=${c.targets ?? 0}`];
  if (c.eligible != null) parts.push(`eligible=${c.eligible}`, `changed=${c.changed ?? 0}`, `removed=${c.removed ?? 0}`, `dirty=${c.dirty ?? 0}`);
  if (r.parity) parts.push(`parity=${r.parity.diffs}/${r.parity.checked} diffs`);
  if (r.ms != null) parts.push(`${r.ms}ms`);
  return `[publish-show-refresh] dry-run ${parts.join(' ')}`;
}

export async function main(argv = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const t0 = Date.now();
  let args: PublishArgs;
  try { args = parseArgs(argv); } catch (e) {
    console.error(`[publish-show-refresh] ${e instanceof Error ? e.message : e}`);
    return 2;
  }
  if (args.help) {
    console.log('Usage: npx tsx scripts/publish-show-refresh.ts [--dry-run] [--manifest=<file|url>] [--report=<json>] [--flagged-file=<path>] [--rebuild-step] [--parity[=all]] [--cap=N]');
    return 0;
  }
  if (args.mode === 'write') {
    const why = env.GITHUB_ACTIONS === 'true' ? 'writes not enabled in L1' : '--write is refused outside GitHub Actions';
    console.error(`[publish-show-refresh] ${why}`);
    writeReport(args.report, { outcome: 'write-refused', reason: why });
    return 2;
  }

  const { manifest, error: manifestError } = await loadManifest(args.manifest);
  if (!isUsableManifest(manifest)) {
    const report = { outcome: OUTCOMES.MANIFEST_UNUSABLE, manifestSource: args.manifest, manifestError, counts: { targets: 0 } };
    writeReport(args.report, report);
    console.log(`${summaryLine(report)} (${manifestError || 'manifest not usable'})`);
    return 0;
  }
  const m = manifest as { manifestId: string; buildInstant: number; buildDate: string; coreSha: string | null; shows: Record<string, { hash: string; held: boolean }> };
  const now = m.buildInstant;
  const dataDir = path.join(ROOT, 'data');

  const tHeal = Date.now();
  const { showsData, healChanged } = healedHeadShows(dataDir, m.buildDate);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { recentShowSlugsFrom } = require('../src/lib/data-core');
  const prerenderedSlugs = recentShowSlugsFrom(showsData.shows, now) as string[];
  const tCompute = Date.now();
  const states = computeShowStates({ dataDir, now, showsOverride: showsData, prerenderedSlugs, extraIds: Object.keys(m.shows), catchErrors: true });
  const computeMs = Date.now() - tCompute;

  const headShows: Record<string, object> = {};
  const headHashes: Record<string, string | null> = {};
  let maxSliceBytes = 0;
  let maxSliceId: string | null = null;
  for (const id of states.order) {
    const s = states.perShow[id];
    headShows[id] = s.error ? { error: s.error } : { hash: s.hash, held: s.held, imagesSig: s.imagesSig, reviewCount: s.reviewCount, reviewsSig: s.reviewsSig };
    headHashes[id] = s.hash ?? null;
    if (s.slice) {
      const bytes = Buffer.byteLength(JSON.stringify(s.slice));
      if (bytes > maxSliceBytes) { maxSliceBytes = bytes; maxSliceId = id; }
    }
  }
  const head = { registrySha: states.registrySha, sliceVersion: states.sliceVersion, shows: headShows };

  const { prevHome, kill, storeNote } = await readStore(env);
  const flagged = readFlagged(args.flaggedFile);
  const plan = planPublish({ manifest: m, head, prevHome, flagged, rebuildStep: args.rebuildStep, cap: args.cap, now: Date.now() });
  let outcome: string = plan.outcome;
  if (kill && kill.killed) outcome = OUTCOMES.KILLED;

  let parity: { mode: string; checked: number; diffs: number; diffIds: string[]; errors: Record<string, string> } | null = null;
  if (args.parity) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { versionedImagePath } = require('../src/lib/versioned-image-path');
    const ids = args.parity === 'all'
      ? states.order.filter((id) => states.perShow[id].slice && !states.perShow[id].held)
      : plan.targets.map((t: { id: string }) => t.id);
    parity = { mode: args.parity, checked: 0, diffs: 0, diffIds: [], errors: {} };
    for (const id of ids) {
      const st = states.perShow[id];
      try {
        const row = st.slice!.row as RawShow;
        const direct = computeOneShow(row, (states.inputs.reviewsByShowId.get(id) || []) as RawReview[], {
          blogReviews: (states.inputs.blogReviewsByShowId.get(id) || []) as RawReview[],
          audience: states.inputs.audience as RawAudience[],
          buzz: states.inputs.buzz as RawBuzzThread[],
          coverageFloorInputs: states.coverageFloorInputs as Parameters<typeof computeOneShow>[2]['coverageFloorInputs'],
          versionImage: versionedImagePath,
          now,
          registry: states.registryFile.outlets as Parameters<typeof computeOneShow>[2]['registry'],
        });
        // As the reader receives it: JSON from the store, rendered by renderFromSlice's compute.
        const slice = JSON.parse(JSON.stringify(st.slice));
        const fromSlice = computeOneShow(slice.row, slice.reviews, {
          blogReviews: slice.blogReviews,
          audience: slice.audience,
          buzz: slice.buzz,
          coverageFloorInputs: coverageInputsFromSlice(slice),
          versionImage: versionedImagePath,
          now,
        });
        parity.checked++;
        if (!isDeepStrictEqual(JSON.parse(JSON.stringify(direct)), JSON.parse(JSON.stringify(fromSlice)))) {
          parity.diffs++;
          if (parity.diffIds.length < 50) parity.diffIds.push(id);
        }
      } catch (e) {
        parity.diffs++;
        parity.errors[id] = e instanceof Error ? e.message : String(e);
      }
    }
  }

  const ms = Date.now() - t0;
  const report = {
    outcome,
    plannedOutcome: plan.outcome,
    mode: 'dry-run',
    manifestSource: args.manifest,
    manifestId: m.manifestId,
    buildInstant: m.buildInstant,
    buildDate: m.buildDate,
    coreSha: m.coreSha,
    rebuildStep: args.rebuildStep,
    healChanged,
    store: storeNote,
    kill,
    counts: plan.counts,
    targets: plan.targets,
    skips: plan.skips,
    dirty: plan.dirty,
    nextHome: plan.nextHome,
    parity,
    maxSliceBytes,
    maxSliceId,
    timings: { totalMs: ms, healMs: tCompute - tHeal, computeMs },
    headHashes,
  };
  writeReport(args.report, report);
  console.log(summaryLine({ outcome, counts: plan.counts, parity, ms }));
  return 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    console.error(`[publish-show-refresh] failed: ${e instanceof Error ? e.stack : e}`);
    process.exitCode = 1;
  });
}
