/**
 * BRO-8214 (BRO-8056 plan v14-final §1.5): the show-refresh publisher.
 * --dry-run (default) plans what it would publish and writes a report; it
 * never writes. --write (GitHub Actions only, service key) also uploads the
 * target slices and swaps the home pointer (scripts/lib/show-refresh/publish-write.js).
 *
 *   npx tsx scripts/publish-show-refresh.ts [--dry-run|--write] [--manifest=<file|url>]
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
 * --write: refused outside GitHub Actions (exit 2). Always checks parity on the
 * targets and refuses to write if any differ (exit 1). Kill switch: the store's
 * kill row stops the run before any write. Writes the pointer only when it
 * changes, as a compare-and-swap on home.generation.
 * Write also refuses (code-mismatch) unless the checked-out commit is the
 * manifest's publicSha: slices must be made by the code that will render them.
 * Every planned outcome (including killed, cas-lost, code-mismatch, an
 * unreachable or unusable manifest) exits 0 with a ::warning:: annotation. A failed write exits 1 with the old pointer in place.
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
const { writePublish } = require('./lib/show-refresh/publish-write');
const { revalidateWithQueue } = require('./lib/show-refresh/revalidate-queue');
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

/** The commit the checked-out code is at: PUBLISH_CODE_SHA, else git HEAD, else null. */
export function codeShaOf(env: NodeJS.ProcessEnv): string | null {
  return env.PUBLISH_CODE_SHA || gitHead(ROOT);
}

function gitHead(cwd: string): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { return null; }
}

/**
 * Paths whose content decides how a slice is computed and rendered. data/ is
 * deliberately absent: HEAD data moving past the deploy is the point.
 */
export const CODE_PATHS = ['src', 'scripts', 'package.json', 'package-lock.json', 'next.config.js', 'tsconfig.json'];
/** Data files that live under src/ and that bots commit (rebuild-fast, fetch-tour-schedules): data, not code. */
export const CODE_PATH_DATA_EXCLUDES = ['src/config/genre-tags.json', 'src/config/onboarding-tour-art.json'];

/**
 * Always compared when the closure is used: dependency versions, compile
 * settings, and every JSON under the code dirs, because code reads config at
 * runtime that no import graph shows (outlet-tiers.js reads
 * src/config/outlet-tiers.json). Bot-written JSON stays excluded below.
 */
export const CLOSURE_ALWAYS = ['package.json', 'package-lock.json', 'tsconfig.json', ':(glob)src/**/*.json', ':(glob)scripts/**/*.json'];
/** The slice computation's entry points: the publisher and the build-time manifest/slice writer. */
// The build's prebuild generators write slice inputs (SLICE_INPUT_FILES) the
// publisher reads from its own checkout, so their code is part of the slice too.
export const SLICE_ENTRY_POINTS = [
  'scripts/publish-show-refresh.ts', 'scripts/build-show-refresh-manifest.ts', 'scripts/run-show-refresh-manifest.js',
  'scripts/generate-blog-reviews-for-scoring.js', 'scripts/build-coverage-floor-snapshot.js',
];

/**
 * Repo files (no node_modules, no data/) statically imported by the slice entry
 * points, via esbuild's metafile. null when it cannot be computed (caller falls
 * back to the coarse CODE_PATHS diff). Runtime fs reads are not in the graph:
 * data/ ones are data by design, code-dir JSON is covered by CLOSURE_ALWAYS.
 * The closure has no dynamic require/import (checked when this was written).
 */
export function sliceCodeClosure(cwd: string = ROOT): string[] | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cp = require('child_process');
    const prog = `require('esbuild').build({entryPoints:${JSON.stringify(SLICE_ENTRY_POINTS)},bundle:true,platform:'node',write:false,metafile:true,logLevel:'silent',absWorkingDir:process.cwd(),packages:'external',format:'esm',outdir:'/tmp/show-refresh-closure',plugins:[{name:'data-external',setup(b){const D=require('path').join(process.cwd(),'data')+require('path').sep;b.onResolve({filter:/(^|\\/)data\\//},a=>require('path').resolve(a.resolveDir,a.path).startsWith(D)?{path:a.path,external:true}:undefined)}}]}).then(r=>{if(r.warnings.length){process.stderr.write('esbuild warnings: '+r.warnings.length);process.exit(1)}process.stdout.write(JSON.stringify(Object.keys(r.metafile.inputs)))},e=>{process.stderr.write(String(e&&e.message));process.exit(1)})`;
    const r = cp.spawnSync(process.execPath, ['-e', prog], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
    if (r.status !== 0) return null;
    const files = (JSON.parse(r.stdout) as string[]).filter((f) => !f.startsWith('data/') && !f.includes('node_modules/') && !f.includes(':') && !f.startsWith('/') && !f.startsWith('..'));
    if (!SLICE_ENTRY_POINTS.every((e) => files.includes(e))) return null;
    return [...new Set(files)].sort();
  } catch { return null; }
}

/**
 * Whether the checked-out code computes slices the way the deployed commit
 * does: the same commit, or no change under CODE_PATHS between the two
 * (data-only commits since the deploy are the normal case on main).
 * PUBLISH_CODE_SHA (tests) pins HEAD and skips git; PUBLISH_CODE_FETCH=0 skips
 * fetching a deployed commit the shallow checkout lacks.
 */
export function codeMatchOf(env: NodeJS.ProcessEnv, publicSha: string | null | undefined, cwd: string = ROOT): { codeSha: string | null; match: boolean; how: string } {
  const codeSha = env.PUBLISH_CODE_SHA || gitHead(cwd);
  if (!publicSha || !/^[0-9a-f]{40}$/.test(publicSha)) return { codeSha, match: false, how: 'manifest has no publicSha' };
  if (!codeSha) return { codeSha, match: false, how: 'checked-out commit unknown' };
  if (codeSha === publicSha) return { codeSha, match: true, how: 'same commit' };
  if (env.PUBLISH_CODE_SHA) return { codeSha, match: false, how: 'different commit (pinned)' };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cp = require('child_process');
  const git = (args: string[]) => cp.spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
  if (git(['cat-file', '-e', `${publicSha}^{commit}`]).status !== 0 && env.PUBLISH_CODE_FETCH !== '0') {
    git(['fetch', '--no-tags', '--depth=1', 'origin', publicSha]);
  }
  // Narrow to the files the slice computation actually imports (BRO-8214: any
  // scripts/ change blocked every write until the next deploy). No closure =>
  // the coarse CODE_PATHS diff, which is never looser.
  const closure = env.PUBLISH_CODE_CLOSURE === '0' ? null : sliceCodeClosure(cwd);
  const paths = closure ? [...closure, ...CLOSURE_ALWAYS] : CODE_PATHS;
  const scope = closure ? `slice code (${closure.length} files)` : 'code';
  const d = git(['diff', '--quiet', publicSha, 'HEAD', '--', ...paths, ...CODE_PATH_DATA_EXCLUDES.map((f) => `:(exclude)${f}`)]);
  if (d.status === 0) return { codeSha, match: true, how: `no ${scope} change since the deployed commit` };
  if (d.status === 1) return { codeSha, match: false, how: `${scope} changed since the deployed commit` };
  return { codeSha, match: false, how: `cannot compare with the deployed commit (${(d.stderr || '').trim().split('\n')[0] || 'git failed'})` };
}

/** --rebuild-step counts only with the rebuild's staleness verdict: SHOW_REFRESH_SAFE=true. */
export function rebuildStepAllowed(env: NodeJS.ProcessEnv): boolean {
  return env.SHOW_REFRESH_SAFE === 'true';
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

/**
 * home + kill from the store when its env is present; never throws. Write mode
 * reads with the service key (the rows it will compare-and-swap).
 */
async function readStore(env: NodeJS.ProcessEnv, write = false) {
  const keyName = write ? 'SUPABASE_SERVICE_ROLE_KEY' : 'NEXT_PUBLIC_SUPABASE_ANON_KEY';
  if (!(env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL) || !env[keyName]) {
    return { prevHome: null, kill: null, storeNote: 'store env absent: no previous home read' };
  }
  try {
    const st = write ? store.stateFromEnv(env, { timeoutMs: 10000 }) : store.readerStateFromEnv(env, { timeoutMs: 10000 });
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

function summaryLine(r: { mode?: string; outcome: string; counts?: { targets?: number; changed?: number; removed?: number; dirty?: number; eligible?: number }; parity?: { checked: number; diffs: number } | null; ms?: number }) {
  const c = r.counts || {};
  const parts = [`outcome=${r.outcome}`, `targets=${c.targets ?? 0}`];
  if (c.eligible != null) parts.push(`eligible=${c.eligible}`, `changed=${c.changed ?? 0}`, `removed=${c.removed ?? 0}`, `dirty=${c.dirty ?? 0}`);
  if (r.parity) parts.push(`parity=${r.parity.diffs}/${r.parity.checked} diffs`);
  if (r.ms != null) parts.push(`${r.ms}ms`);
  return `[publish-show-refresh] ${r.mode || 'dry-run'} ${parts.join(' ')}`;
}

export async function main(argv = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const t0 = Date.now();
  let args: PublishArgs;
  try { args = parseArgs(argv); } catch (e) {
    console.error(`[publish-show-refresh] ${e instanceof Error ? e.message : e}`);
    return 2;
  }
  if (args.help) {
    console.log('Usage: npx tsx scripts/publish-show-refresh.ts [--dry-run|--write] [--manifest=<file|url>] [--report=<json>] [--flagged-file=<path>] [--rebuild-step] [--parity[=all]] [--cap=N]');
    return 0;
  }
  const write = args.mode === 'write';
  if (write) {
    let why: string | null = null;
    if (env.GITHUB_ACTIONS !== 'true') why = '--write is refused outside GitHub Actions';
    else if (!(env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL) || !env.SUPABASE_SERVICE_ROLE_KEY) why = '--write needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY';
    if (why) {
      console.error(`[publish-show-refresh] ${why}`);
      writeReport(args.report, { outcome: 'write-refused', reason: why });
      return 2;
    }
    // Write mode always proves the targets render like the build before uploading them.
    if (!args.parity) args.parity = 'targets';
  }

  const { manifest, error: manifestError } = await loadManifest(args.manifest);
  if (!isUsableManifest(manifest)) {
    const report = { outcome: OUTCOMES.MANIFEST_UNUSABLE, mode: args.mode, manifestSource: args.manifest, manifestError, counts: { targets: 0 } };
    writeReport(args.report, report);
    console.log(`${summaryLine(report)} (${manifestError || 'manifest not usable'})`);
    console.log(`::warning::show-refresh: live manifest not usable (${manifestError || 'unusable'}); nothing published`);
    return 0;
  }
  const m = manifest as { manifestId: string; buildInstant: number; buildDate: string; coreSha: string | null; publicSha?: string | null; shows: Record<string, { hash: string; held: boolean; slug?: string }> };
  // The reader renders slices with the DEPLOYED code, so slices (and their
  // parity proof) must come from that same commit. Write refuses otherwise.
  const { codeSha, match: codeMatch, how: codeHow } = codeMatchOf(env, m.publicSha);
  if (write && !codeMatch) {
    const why = `checked-out code ${codeSha ? codeSha.slice(0, 9) : 'unknown'} does not match the deployed commit ${m.publicSha ? m.publicSha.slice(0, 9) : '(manifest has none)'}: ${codeHow}`;
    const report = { outcome: 'code-mismatch', mode: args.mode, manifestId: m.manifestId, publicSha: m.publicSha ?? null, codeSha, reason: why, counts: { targets: 0 } };
    writeReport(args.report, report);
    console.log(`${summaryLine(report)} (${why})`);
    console.log(`::warning::show-refresh: ${why}; nothing written`);
    return 0;
  }
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
    headShows[id] = s.error ? { error: s.error } : { hash: s.hash, held: s.held, slug: s.slug, imagesSig: s.imagesSig, reviewCount: s.reviewCount, reviewsSig: s.reviewsSig };
    headHashes[id] = s.hash ?? null;
    if (s.slice) {
      const bytes = Buffer.byteLength(JSON.stringify(s.slice));
      if (bytes > maxSliceBytes) { maxSliceBytes = bytes; maxSliceId = id; }
    }
  }
  const head = { registrySha: states.registrySha, sliceVersion: states.sliceVersion, shows: headShows };

  const { prevHome, kill, storeNote } = await readStore(env, write);
  const flagged = readFlagged(args.flaggedFile);
  // --rebuild-step vouches for changed review lists, so it needs the rebuild's
  // staleness verdict (as publish-live-scores needs LIVE_SCORES_SAFE). Without it
  // the run still publishes, as a backstop run would.
  if (args.rebuildStep && !rebuildStepAllowed(env)) {
    console.log(`::warning::show-refresh: --rebuild-step without SHOW_REFRESH_SAFE=true (got ${env.SHOW_REFRESH_SAFE ?? 'unset'}); review-list changes are not published this run`);
    args.rebuildStep = false;
  }
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

  // Write step (phase 3a). Never on a kill, a parity difference or a plan with no home.
  let writeResult: { outcome: string; uploaded: string[]; existing: string[]; homeWritten: boolean; generation: number | null; changedIds: string[]; log: string[] } | null = null;
  let revalidate: string | null = null;
  let exitCode = 0;
  if (write && outcome !== OUTCOMES.KILLED && plan.nextHome) {
    if (parity && parity.diffs > 0) {
      outcome = 'parity-failed';
      exitCode = 1;
      console.error(`::error::show-refresh: ${parity.diffs} target(s) render differently from a full build (${parity.diffIds.join(', ')}); nothing written`);
    } else {
      try {
        writeResult = await writePublish({
          storage: store.storeFromEnv(env, { timeoutMs: 15000 }),
          state: store.stateFromEnv(env, { timeoutMs: 10000 }),
          plan,
          manifest: m,
          sliceFor: (id: string) => states.perShow[id],
          expectGeneration: prevHome && Number.isInteger((prevHome as { generation?: unknown }).generation) ? (prevHome as { generation: number }).generation : null,
          now: Date.now(),
        });
        outcome = writeResult!.outcome;
        for (const line of writeResult!.log) console.log(`[publish-show-refresh] ${line}`);
        if (outcome === OUTCOMES.CAS_LOST) console.log('::warning::show-refresh: another run moved the home pointer first; this run wrote no pointer');
      } catch (e) {
        outcome = 'write-failed';
        exitCode = 1;
        const swapped = !!(e && typeof e === 'object' && (e as { pointerSwapped?: boolean }).pointerSwapped);
        console.error(`::error::show-refresh write failed (${swapped ? 'the NEW pointer is live; check the home row' : 'old pointer left in place'}): ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  // BRO-8410: revalidate this run's changed slugs and drain earlier failures.
  // Runs on every write-mode run (a backstop run with nothing to publish still
  // retries the queue); the queue lives in private Storage, never the reader's path.
  let revalidateQueue: { retried: string[]; pending: string[]; abandoned: string[]; queueNote: string } | null = null;
  if (write && outcome !== 'parity-failed') {
    const newSlugs = writeResult && writeResult.homeWritten
      ? writeResult.changedIds.map((id) => m.shows[id] && m.shows[id].slug).filter(Boolean) as string[]
      : [];
    let storage: ReturnType<typeof store.storeFromEnv> | null = null;
    try { storage = store.storeFromEnv(env, { timeoutMs: 15000 }); } catch { storage = null; }
    const r = await revalidateWithQueue({ env, storage, newSlugs });
    revalidate = r.message;
    revalidateQueue = { retried: r.retried, pending: r.pending, abandoned: r.abandoned, queueNote: r.queueNote };
    if (r.message !== 'skipped (no slugs)') console.log(`[publish-show-refresh] revalidate: ${r.message}`);
  }

  const ms = Date.now() - t0;
  const report = {
    outcome,
    plannedOutcome: plan.outcome,
    mode: args.mode,
    write: writeResult,
    revalidate,
    revalidateQueue,
    manifestSource: args.manifest,
    manifestId: m.manifestId,
    publicSha: m.publicSha ?? null,
    codeSha,
    codeMatch,
    codeHow,
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
  console.log(summaryLine({ mode: args.mode, outcome, counts: plan.counts, parity, ms }));
  if (outcome === OUTCOMES.KILLED) console.log(`::warning::show-refresh: stopped by the kill switch (${(kill && kill.reason) || 'see write log'})`);
  if (!codeMatch) console.log(`::notice::show-refresh: code ${codeSha ? codeSha.slice(0, 9) : 'unknown'} vs deployed ${m.publicSha ? m.publicSha.slice(0, 9) : '(none)'}: ${codeHow}; a write would be refused`);
  return exitCode;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    console.error(`[publish-show-refresh] failed: ${e instanceof Error ? e.stack : e}`);
    process.exitCode = 1;
  });
}
