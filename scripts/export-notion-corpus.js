#!/usr/bin/env node
/**
 * export-notion-corpus.js — the complete, reproducible archive of the Notion
 * brain, taken before Notion is retired (Sprint 2 of
 * sprint-plan-notion-linear-cutover.md).
 *
 * "Corpus", not "archive": Archive already means the Linear Archive project,
 * and the two must not be confusable in a runbook read at 3am.
 *
 * THE FAILURE MODE THIS IS BUILT AGAINST
 * The pre-mortem's secondary scenario is this script succeeding and being
 * wrong: an export that reports the right number of cards while having
 * truncated the longest, most valuable ones. That happens because ~2,183 of
 * the ~4,981 cards keep most of their text in the PAGE BODY, not the property
 * — 73% of it, on the card measured by hand — and `has_children` is false or
 * absent on every page, so nothing cheap tells you a body exists. Hence:
 *   * blocks.children.list is called UNCONDITIONALLY on every page (S2-T2)
 *   * any non-2xx is fatal for that page and lands in an error manifest that
 *     fails the run — a 429 silently read as "no children" is the documented
 *     way this goes wrong (S2-T4)
 *   * the verifier asserts CHARACTER VOLUME, not card count (S2-T5), because
 *     card count passes on a truncated export
 *   * records carry no timestamps or run ids, and are sorted by id before the
 *     final write, so two independent runs diff clean (S2-T6)
 *
 * Usage:
 *   node scripts/export-notion-corpus.js --out=<dir> [--limit=N] [--rate=3]
 *                                        [--no-comments] [--resume] [--fresh]
 *
 *   --out        output directory (required)
 *   --limit      stop after N pages (smoke tests only — a limited run is
 *                marked partial in the manifest and can never be verified)
 *   --rate       max Notion requests/sec (default 3, Notion's documented avg)
 *   --no-comments  skip the best-effort comment sweep (halves the runtime)
 *   --resume     continue a previous run in --out instead of starting over
 *   --fresh      delete any previous partial output in --out first
 *   --simulate-429-at=N  inject a fake 429 on the Nth page (S2-T4 test hook)
 *
 * Exit 0 only when the error manifest is empty.
 */

require('./lib/load-env').loadEnv();

const fs = require('node:fs');
const path = require('node:path');
const { Client, APIResponseError } = require('@notionhq/client');
const { BRAIN_DATABASE_ID, NOTION_VERSION } = require('./lib/notion-constants');
const corpus = require('./lib/notion-corpus');
const { hasHelpFlag } = require('./lib/cli-help');

const USAGE = `export-notion-corpus.js — complete, reproducible export of the Notion brain.

  --out=<dir>            output directory (required)
  --limit=N              stop after N pages (smoke test; marks the run partial)
  --rate=N               max Notion requests/sec (default 3)
  --no-comments          skip the best-effort comment sweep
  --resume               continue a previous run in --out
  --fresh                delete previous partial output in --out first
  --simulate-429-at=N    inject a fake 429 on the Nth page (test hook)
  --help, -h             this message

Writes <out>/corpus.ndjson (sorted, deterministic), <out>/errors.json,
<out>/manifest.json. Exit non-zero if the error manifest is non-empty.`;

const PARTIAL = 'corpus.partial.ndjson';
const FINAL = 'corpus.ndjson';
const ERRORS = 'errors.json';
const MANIFEST = 'manifest.json';
const CHECKPOINT = 'checkpoint.json';

function parseArgs(argv) {
  const args = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) args[m[1]] = m[2] === undefined ? true : m[2];
  }
  return args;
}

/**
 * Token-bucket pacer. Notion documents an average of 3 requests/second and
 * answers a burst with a 429 — which this script treats as FATAL rather than
 * retrying (S2-T4), so staying under the limit is the only strategy available.
 */
function makePacer(perSecond) {
  const minGapMs = 1000 / Math.max(0.1, perSecond);
  let next = 0;
  return async function pace() {
    const now = Date.now();
    const wait = Math.max(0, next - now);
    next = Math.max(now, next) + minGapMs;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  };
}

function isRateLimit(err) {
  return !!(err && (err.status === 429 || err.code === 'rate_limited'));
}

// The error shape recorded in the manifest. Deliberately keeps `status` and
// `code` separate from the message: the manifest is read by a human deciding
// whether to re-run, and "429 on 3 pages" is a different decision from
// "object_not_found on 3 pages".
function toErrorEntry(pageId, phase, err) {
  return {
    pageId,
    phase,
    status: (err && err.status) || null,
    code: (err && err.code) || null,
    message: String((err && err.message) || err).slice(0, 500),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    console.log(USAGE);
    return;
  }
  const args = parseArgs(argv);
  const outDir = args.out;
  if (!outDir) {
    console.error(USAGE);
    process.exit(1);
  }
  const limit = args.limit ? Number(args.limit) : null;
  const rate = args.rate ? Number(args.rate) : 3;
  const withComments = args['no-comments'] !== true;
  const simulate429At = args['simulate-429-at'] ? Number(args['simulate-429-at']) : null;

  fs.mkdirSync(outDir, { recursive: true });
  const partialPath = path.join(outDir, PARTIAL);
  const finalPath = path.join(outDir, FINAL);
  const errorsPath = path.join(outDir, ERRORS);
  const manifestPath = path.join(outDir, MANIFEST);
  const checkpointPath = path.join(outDir, CHECKPOINT);

  if (args.fresh) {
    for (const p of [partialPath, finalPath, errorsPath, manifestPath, checkpointPath]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  }

  // Resume = "which page ids already have a complete record on disk". Keyed on
  // the records themselves rather than on a saved cursor: Notion's cursors are
  // opaque and can expire, and re-walking the query costs ~50 cheap requests
  // against ~10,000 expensive ones. Skipping a page here skips its block and
  // comment fetches, which is where all the time goes.
  const done = new Set();
  if (fs.existsSync(partialPath)) {
    if (!args.resume && !args.fresh) {
      console.error(
        `❌ ${partialPath} already exists. Pass --resume to continue it, or --fresh to discard it.\n` +
          `   Refusing to guess: silently appending would corrupt the export, and silently\n` +
          `   overwriting would throw away a run that may have taken an hour.`
      );
      process.exit(1);
    }
    if (args.resume) {
      for (const line of fs.readFileSync(partialPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          done.add(JSON.parse(line).id);
        } catch {
          // A torn last line from a kill mid-write. Dropped here and re-fetched
          // below; the sort-and-dedupe at finalize keeps the output clean.
        }
      }
      console.error(`↻ resuming: ${done.size} page(s) already exported`);
    }
  }

  const notion = new Client({ auth: process.env.NOTION_API_KEY, notionVersion: NOTION_VERSION });
  const pace = makePacer(rate);
  const errors = [];
  const out = fs.createWriteStream(partialPath, { flags: 'a' });

  let seen = 0;
  let exported = 0;
  let skipped = 0;
  let blockRequests = 0;
  let commentRequests = 0;
  let totalComments = 0;
  const unknownBlockTypes = new Set();
  let maxDepthSeen = 0;
  const startedAt = Date.now();

  async function listAllChildrenDeep(blockId, depth = 0) {
    const all = [];
    let cursor;
    do {
      await pace();
      blockRequests++;
      const resp = await notion.blocks.children.list({
        block_id: blockId,
        start_cursor: cursor,
        page_size: 100,
      });
      all.push(...resp.results);
      cursor = resp.has_more ? resp.next_cursor : undefined;
    } while (cursor);

    if (depth + 1 > maxDepthSeen && all.length) maxDepthSeen = Math.max(maxDepthSeen, depth);
    for (const b of all) {
      // has_children IS reliable at BLOCK level (unlike page level, where it is
      // false or absent for every one of the 4,981 rows) — so this recursion is
      // conditional while the top-level call is not.
      if (b && b.has_children) {
        b._children = await listAllChildrenDeep(b.id, depth + 1);
      }
    }
    return all;
  }

  let cursor;
  outer: do {
    await pace();
    let resp;
    try {
      resp = await notion.dataSources.query({
        data_source_id: BRAIN_DATABASE_ID,
        page_size: 100,
        start_cursor: cursor,
      });
    } catch (err) {
      // A failed QUERY page is not recoverable per-page: it means an unknown
      // number of cards were never even enumerated, so the export cannot claim
      // completeness. Fail the whole run loudly rather than exporting a subset
      // that looks whole.
      errors.push(toErrorEntry(null, 'query', err));
      console.error(`❌ dataSources.query failed: ${err.message}`);
      break;
    }

    for (const page of resp.results) {
      seen++;
      if (limit !== null && exported + skipped >= limit) break outer;
      if (done.has(page.id)) {
        skipped++;
        continue;
      }

      let blocks = [];
      try {
        if (simulate429At !== null && seen === simulate429At) {
          const fake = new Error('simulated rate_limited for S2-T4');
          fake.status = 429;
          fake.code = 'rate_limited';
          throw fake;
        }
        blocks = await listAllChildrenDeep(page.id);
      } catch (err) {
        // THE central rule: a 429 (or any non-2xx) here must never be read as
        // "this page has no body". Record it, skip the page, fail the run.
        errors.push(toErrorEntry(page.id, 'blocks', err));
        console.error(`  ✗ blocks ${page.id}: ${isRateLimit(err) ? 'RATE LIMITED' : err.message}`);
        continue;
      }

      let comments = [];
      if (withComments) {
        try {
          await pace();
          commentRequests++;
          const c = await notion.comments.list({ block_id: page.id });
          comments = c.results || [];
          totalComments += comments.length;
        } catch (err) {
          // BEST EFFORT (S2-T3): Sprint 0 found zero comments across 100 pages,
          // so this is a sweep for completeness, not a dependency. A failure
          // here is recorded for visibility but does NOT enter `errors` and
          // does NOT fail the run — blocking a 4,981-page export on an optional
          // field would be the wrong trade.
          console.error(`  ~ comments ${page.id} (non-fatal): ${err.message}`);
        }
      }

      corpus.collectUnknownBlockTypes(blocks, unknownBlockTypes);
      const record = corpus.buildRecord(page, blocks, comments);
      maxDepthSeen = Math.max(maxDepthSeen, record.body.maxDepth);
      out.write(`${JSON.stringify(record)}\n`);
      exported++;

      if (exported % 100 === 0) {
        const rateNow = (exported / ((Date.now() - startedAt) / 1000)).toFixed(2);
        console.error(`  … ${exported} exported (${skipped} skipped), ${rateNow} pages/s`);
        // Checkpoint is advisory — the NDJSON is the real record — but it makes
        // "did this run get anywhere" answerable without parsing the corpus.
        fs.writeFileSync(
          checkpointPath,
          `${JSON.stringify({ exported, skipped, seen, errors: errors.length }, null, 2)}\n`
        );
      }
    }

    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);

  await new Promise((resolve) => out.end(resolve));

  // --- finalize: sort by id, dedupe, write the canonical file ---------------
  // Sorting is what makes S2-T6's double-run diff possible at all: a resumed
  // run visits pages in a different order than a clean one, and an unsorted
  // NDJSON would differ byte-for-byte while containing identical content.
  const byId = new Map();
  for (const line of fs.readFileSync(partialPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    byId.set(rec.id, rec); // last write wins — a re-fetched torn record supersedes
  }
  const records = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  fs.writeFileSync(finalPath, records.map((r) => `${JSON.stringify(r)}\n`).join(''));

  const volume = corpus.charVolume(records);
  const partial = limit !== null;
  const manifest = {
    // Run metadata lives HERE and never in a record — corpus.ndjson must be
    // byte-identical across runs, and a timestamp inside it would guarantee
    // it never is.
    generatedAt: new Date().toISOString(),
    durationSec: Math.round((Date.now() - startedAt) / 10) / 100,
    partial,
    dataSourceId: BRAIN_DATABASE_ID,
    notionVersion: NOTION_VERSION,
    pagesSeen: seen,
    pagesExported: records.length,
    pagesSkippedAlreadyDone: skipped,
    blockRequests,
    commentRequests,
    commentsFound: totalComments,
    commentSweep: withComments ? 'run' : 'skipped',
    maxBlockDepth: maxDepthSeen,
    unknownBlockTypes: [...unknownBlockTypes].sort(),
    errorCount: errors.length,
    volume,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(errorsPath, `${JSON.stringify(errors, null, 2)}\n`);

  console.error('');
  console.error(`── corpus export ${partial ? '(PARTIAL — --limit was set)' : ''} ──`);
  console.error(`  pages exported     ${records.length}`);
  console.error(`  block requests     ${blockRequests}`);
  console.error(`  comments found     ${totalComments} (${withComments ? 'sweep run' : 'sweep skipped'})`);
  console.error(`  max block depth    ${maxDepthSeen}`);
  console.error(`  chars notes        ${volume.totals.notes.toLocaleString()}`);
  console.error(`  chars outcome      ${volume.totals.outcome.toLocaleString()}`);
  console.error(`  chars keyFiles     ${volume.totals.keyFiles.toLocaleString()}`);
  console.error(`  chars body         ${volume.totals.body.toLocaleString()}`);
  console.error(`  overflow markers left in stitched fields: ${volume.withOverflowMarker}`);
  if (unknownBlockTypes.size) {
    console.error(`  ⚠ unknown block types: ${[...unknownBlockTypes].join(', ')}`);
  }
  console.error(`  errors             ${errors.length}`);
  console.error(`  → ${finalPath}`);

  if (errors.length) {
    console.error(`\n❌ export FAILED: ${errors.length} page(s) in ${errorsPath}. Re-run with --resume.`);
    process.exit(1);
  }
  console.error('\n✅ export clean.');
}

main().catch((err) => {
  console.error(`\n❌ ${err instanceof APIResponseError ? `${err.status} ${err.code}: ` : ''}${err.message}\n`);
  process.exit(1);
});
