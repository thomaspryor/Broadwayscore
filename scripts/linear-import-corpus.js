#!/usr/bin/env node
/**
 * linear-import-corpus.js — migrate the un-Done Notion backlog into Linear from
 * the FROZEN Sprint 2 corpus (S3-T4/T5/T6/T7b of
 * sprint-plan-notion-linear-cutover.md).
 *
 * ── WHY THIS IS NOT A FLAG ON linear-import.js ────────────────────────────
 *
 * linear-import.js imports the LOCAL MIRROR. The mirror holds 460 files; the
 * un-Done Notion backlog is 1,949 pages (measured off the corpus 2026-08-17).
 * It syncs P0/P1 and in-progress only, so a mirror-sourced run structurally
 * cannot see three quarters of what Sprint 3 exists to migrate — that is a
 * different source, a different key, and a different destination shape, not a
 * flag.
 *
 * The same reasoning already split migrate-import-ledger.js out of the
 * importer: a one-shot data migration and a repeatable tool have different
 * failure modes. It applies with more force here. This writes ~1,949 issues
 * into a board with NO BULK DELETE, once. linear-import.js's --reconcile is a
 * live convergence tool the owner still uses. Sharing one process means every
 * flag combination multiplies against the riskiest write in the plan.
 *
 * What IS shared, deliberately: every curation rule
 * (scripts/lib/linear-import-rules.js) and the pageId ledger
 * (scripts/lib/import-ledger.js). The decisions live in one place; only the
 * driving loop differs.
 *
 * ── WHY THE CORPUS AND NOT A LIVE QUERY ───────────────────────────────────
 *
 * The board gains cards hourly. Importing from a moving source means the
 * anti-join can never close: pages created mid-run are neither imported nor
 * accounted for, and no run can prove it was complete. The corpus is a frozen,
 * hash-verified snapshot of 4,994 pages, so "every un-Done page has a ledger
 * row" is a decidable question. Cards created after the export are Sprint 8's
 * problem, by design, and they are still in Notion until then.
 *
 * ── SAFETY, IN THE ORDER IT MATTERS ───────────────────────────────────────
 *
 * 1. IDEMPOTENT. Every create carries a deterministic client-supplied id
 *    derived from the Notion pageId. Replaying a create cannot duplicate: the
 *    server refuses it as an id conflict, which this script counts as
 *    "already imported" and moves past. Verified live end-to-end, not assumed —
 *    and NOT by the mechanism the plan describes (see linear-import-rules.js;
 *    Linear rejects UUIDv5 outright and a replay is a 400, not a silent no-op).
 * 2. LEDGER-FIRST. The append-only pageId ledger is consulted before every
 *    create and appended after every one, so a killed run resumes exactly.
 * 3. BATCHED WITH AN ABORT THRESHOLD. Work is chunked; the first unexpected
 *    disposition stops the run at the end of its batch rather than continuing
 *    into 1,800 more of the same mistake.
 * 4. PACED. A minimum interval between requests. Without it the S1-T1 backoff
 *    becomes the de-facto pacer — up to five sleeps per request across 1,949
 *    items, which is indistinguishable from a hang.
 * 5. REVERSIBLE. --rollback Cancels and labels `import-rollback` every issue
 *    this ledger created. Nothing is deleted, because nothing can be.
 *
 * Usage:
 *   node scripts/linear-import-corpus.js --dry-run [--json]   # writes NOTHING
 *   node scripts/linear-import-corpus.js --apply              # the real write
 *   node scripts/linear-import-corpus.js --rollback --apply
 *
 *   --corpus=<dir>     Sprint 2 corpus (default ~/broadway-scorecard-data/notion-corpus)
 *   --ledger=<path>    pageId ledger (default data/linear-import-mapping.jsonl)
 *   --limit=N          import only the first N candidates (rehearsal)
 *   --batch=N          batch size (default 100)
 *   --spacing-ms=N     minimum ms between write requests (default 350)
 *   --dry-run          classify and report; never touch Linear
 *   --apply            actually write
 */

require('./lib/load-env').loadEnv();

const os = require('node:os');
const path = require('node:path');

const rules = require('./lib/linear-import-rules');
const ledgerLib = require('./lib/import-ledger');
const corpusIo = require('./lib/notion-corpus-io');
const corpus = require('./lib/notion-corpus');
const { runBatched } = require('./lib/batch-runner');
const linear = require('./lib/linear-client');
const { hasHelpFlag } = require('./lib/cli-help');

const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_CORPUS = path.join(os.homedir(), 'broadway-scorecard-data/notion-corpus');

const USAGE = `linear-import-corpus.js — migrate the un-Done Notion backlog into Linear from the Sprint 2 corpus.

  --dry-run          classify everything and print the disposition report; writes NOTHING
  --apply            perform the import
  --rollback         Cancel + label every issue this ledger created (needs --apply)
  --corpus=<dir>     Sprint 2 corpus dir (default ~/broadway-scorecard-data/notion-corpus)
  --ledger=<path>    pageId ledger (default data/linear-import-mapping.jsonl)
  --limit=N          only the first N candidates
  --batch=N          batch size (default 100)
  --spacing-ms=N     minimum ms between write requests (default 350)
  --json             machine-readable output
  --help, -h         this message`;

function parseArgs(argv) {
  const args = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) args[m[1]] = m[2] === undefined ? true : m[2];
  }
  return args;
}

/**
 * A flag must be OFF unless it is unambiguously on. `--apply=false` parses to
 * the string "false", which is truthy, so a plain `!!args.apply` would perform
 * an irreversible 1,705-issue import for someone who typed the opposite of what
 * they meant. Fail closed, and reject anything that is neither.
 */
function boolFlag(value, name) {
  if (value === undefined) return false;
  if (value === true || value === 'true' || value === '1' || value === '') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`--${name} takes no value (or true/false), got ${JSON.stringify(value)}`);
}

/**
 * A numeric option must be a real number. `--limit=abc` becoming NaN silently
 * imports ZERO items and reports success, and `--limit 50` (space-separated)
 * leaves limit === true, which Number() turns into 1 — a "run" that imports one
 * card and looks like it worked.
 */
function numFlag(value, name, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (value === true || !Number.isFinite(n) || n < 0) {
    throw new Error(`--${name} needs a number, e.g. --${name}=100 (got ${JSON.stringify(value)})`);
  }
  return n;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The issue body. The Notion page's own text, plus a provenance header naming
 * the page it came from.
 *
 * The corpus record's `fields` carry the REASSEMBLED long text — property
 * preview plus the page-body overflow section stitched back together by
 * notion-corpus.js. Reading `properties` alone would import the 1,800-character
 * preview and silently drop the rest, which is the single failure mode Sprint 2
 * was built to prevent; doing it here would waste that entire sprint.
 */
function buildDescription(record) {
  const f = record.fields || {};
  const p = record.properties || {};
  const parts = [];
  parts.push(`_Migrated from Notion — page \`${record.id}\`${record.url ? ` · [open](${record.url})` : ''}_`);
  const meta = [
    p.Status ? `Status: ${p.Status}` : null,
    p.Priority ? `Priority: ${p.Priority}` : null,
    p.Type ? `Type: ${p.Type}` : null,
    p.Category ? `Category: ${p.Category}` : null,
    p.Tags ? `Tags: ${Array.isArray(p.Tags) ? p.Tags.join(', ') : p.Tags}` : null,
    record.createdTime ? `Created: ${String(record.createdTime).slice(0, 10)}` : null,
  ].filter(Boolean);
  if (meta.length) parts.push(meta.join(' · '));

  const notes = f.notes || p.Notes;
  const outcome = f.outcome || p.Outcome;
  const keyFiles = f.keyFiles || p['Key Files'];
  if (notes) parts.push(`## Notes\n\n${notes}`);
  if (outcome) parts.push(`## Outcome\n\n${outcome}`);
  if (keyFiles) parts.push(`## Key Files\n\n${keyFiles}`);

  // The FREE-FORM page body — what someone typed on the page itself rather than
  // into a property. `fields` above only ever holds the `[auto:*]` overflow
  // sections, so a page written directly in the body has EMPTY fields and all
  // its content here. Measured on the corpus: 67 obligations have >500 chars of
  // body and nothing in notes/outcome/keyFiles, and without this they import as
  // a three-line provenance stub — 86,388 characters dropped, unrecoverable
  // after Sprint 8 deletes Notion. This is the same silent-truncation failure
  // Sprint 2 was built to prevent, one step further down the pipeline.
  //
  // nonAutoBodyText() excludes the auto sections specifically so this cannot
  // double-render the text `fields` already carries.
  const body = corpus.nonAutoBodyText(record.body);
  if (body) parts.push(`## Page body\n\n${body}`);

  const comments = (record.comments && record.comments.items) || [];
  if (comments.length) {
    parts.push(
      `## Comments (${comments.length}, migrated)\n\n${comments
        .map((c) => `- ${String(c.text || c.plainText || '').trim()}`)
        .filter((l) => l !== '-')
        .join('\n')}`
    );
  }
  return parts.join('\n\n');
}

/** Every disposition, counted, with nothing able to fall outside a named bucket. */
function buildReport(records, alreadyByPageId) {
  const counts = { live: 0, archive: 0, skip: 0, alreadyImported: 0 };
  const skipReasons = {};
  const unknownPriorities = {};
  const candidates = [];
  // EVERY live-tier card, whether or not this run will create it. The label
  // vocabulary is derived from this rather than from `candidates`, so a resumed
  // run derives the SAME vocabulary as the first one — deriving from what is
  // still pending would shrink the label set as the import progressed.
  const liveAll = [];
  for (const record of records) {
    const c = rules.classifyCorpusRecord(record);
    if (c.disposition === 'skip') {
      counts.skip++;
      skipReasons[c.reason] = (skipReasons[c.reason] || 0) + 1;
      continue;
    }
    if (c.disposition === 'live') liveAll.push({ record, c });
    // A Priority string the rules do not recognise normalises to null, which
    // routes the card to the ARCHIVE side. That default is correct — an unknown
    // priority is not proven live work — but it must never be SILENT: a new
    // spelling added to the Notion schema after the corpus export would park
    // real P0 work in Canceled with nothing to notice it by. Counted here and
    // printed in the dry-run so it is a decision, not an accident.
    const rawPriority = String((record.properties && record.properties.Priority) || '').trim();
    if (rawPriority && !rules.PRIORITY_SPELLINGS.includes(rawPriority)) {
      unknownPriorities[rawPriority] = (unknownPriorities[rawPriority] || 0) + 1;
    }
    if (alreadyByPageId.has(record.id)) {
      counts.alreadyImported++;
      continue;
    }
    counts[c.disposition]++;
    candidates.push({ record, c });
  }
  return { counts, skipReasons, candidates, liveAll, unknownPriorities };
}

// A label needs at least this many LIVE cards to be worth existing.
const MIN_LABEL_USES = 2;

/**
 * S3-T5: the label vocabulary is DERIVED, never hand-picked. Two filters, both
 * from the plan or from the data rather than from taste:
 *
 *   * LIVE cards only. The plan's CHANGED block is explicit — derive from the
 *     tags on the live-imported cards. Deriving from everything yields 545
 *     labels, which is not a vocabulary, it is the raw tag column.
 *   * Used by at least MIN_LABEL_USES live cards. Of the 227 tags on live
 *     cards, 143 appear exactly once. A tag one card carries cannot group
 *     anything; it is a note, and it survives in full where notes belong —
 *     the corpus, and the `Tags:` line of the issue body this script writes.
 *
 * Nothing is lost by not minting it as a label, which is the only reason it is
 * safe to filter at all.
 */
function deriveLabelSet(candidates) {
  const freq = new Map();
  for (const { c } of candidates) {
    if (c.disposition !== 'live') continue;
    for (const l of c.labels || []) freq.set(l, (freq.get(l) || 0) + 1);
  }
  const set = new Set([rules.ARCHIVE_LABEL]);
  for (const [name, n] of [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    if (n >= MIN_LABEL_USES) set.add(name);
  }
  return { labels: [...set], freq };
}

/**
 * Ensure every derived label exists, and hand back a lookup keyed by the
 * DERIVED name.
 *
 * Linear label names are unique CASE-INSENSITIVELY. normalizeLabelName()
 * lowercases, and the board already carries Linear's stock `Bug`, `Feature`,
 * `Improvement` — so creating `bug` fails with "duplicate label name" and, on a
 * naive implementation, takes the whole import down at whichever card first
 * carries that tag. Found by running the 3-card rehearsal, which is the only
 * reason it was not found by running 1,708 of them.
 *
 * So: match case-insensitively and REUSE the existing label with its original
 * casing. Two labels differing only in case cannot both exist, and minting a
 * near-twin would split one idea across two filters even if it were allowed.
 */
async function ensureLabels(names, teamId, { apply }) {
  const existing = await linear.listLabels(teamId);
  const byLower = new Map(existing.map((l) => [l.name.toLowerCase(), l]));
  const byName = new Map();
  const created = [];
  const reusedWithDifferentCase = [];

  for (const name of names) {
    const hit = byLower.get(name.toLowerCase());
    if (hit) {
      byName.set(name, hit);
      if (hit.name !== name) reusedWithDifferentCase.push(`${name} -> ${hit.name}`);
      continue;
    }
    if (!apply) {
      created.push(name);
      continue;
    }
    // findOrCreateLabel already owns the create-race retry (BRO-282) — reused
    // rather than reimplemented. The case-insensitive matching above is what it
    // does NOT do: it looks names up by exact match, which is why `bug` against
    // an existing `Bug` has to be resolved here before it is ever called.
    const label = await linear.findOrCreateLabel(teamId, name);
    byLower.set(name.toLowerCase(), label);
    byName.set(name, label);
    created.push(name);
  }
  return { byName, created, reusedWithDifferentCase };
}

/**
 * --rollback: Cancel and label every issue THIS importer created.
 *
 * WHAT ROLLBACK IS NOT — read before relying on it. It marks the import
 * abandoned; it does NOT restore the board to its pre-import state, and it does
 * not let you import those pages again afterwards. Two facts make that
 * permanent, and neither is fixable here:
 *
 *   * Linear has no bulk delete, so "undo" can only ever mean Cancel + label.
 *   * The issue id is DERIVED from the Notion pageId, so the id is spent. A
 *     later re-import of the same page is refused by the server as an id
 *     conflict and recorded as recovered-existing; the card stays Canceled.
 *
 * Rolling back is therefore a one-way decision per page. Verified against the
 * rehearsal ledger: after rollback the page is still present in
 * indexByPageId(), so the importer counts it as already imported and never
 * re-creates it.
 *
 * Running it twice is a no-op — the appended rollback rows become the newest
 * per pageId, so the `corpus-import` filter below stops matching them.
 */
async function runRollback({ ledgerPath, apply, spacingMs }) {
  const rows = ledgerLib.readRows(ledgerPath);
  // Only what THIS importer created. Legacy-migration rows name issues that
  // existed before Sprint 3 and predate the corpus import entirely — cancelling
  // those would roll back work nobody asked to roll back.
  const mine = [...ledgerLib.indexByPageId(rows).values()].filter((r) => r.source === 'corpus-import' && r.linearId);
  console.error(`rollback: ${mine.length} issue(s) created by the corpus import`);
  if (!apply) {
    console.log(JSON.stringify({ rollback: true, applied: false, wouldCancel: mine.length }, null, 2));
    return;
  }
  const team = await linear.getTeam();
  const stateByName = new Map(team.states.nodes.map((s) => [s.name, s.id]));
  const canceledId = stateByName.get('Canceled') || stateByName.get('Cancelled');
  if (!canceledId) throw new Error('no Canceled workflow state in this team');
  const rollbackLabelId = (await linear.findOrCreateLabel(team.id, rules.ROLLBACK_LABEL)).id;

  let cancelled = 0;
  for (const r of mine) {
    // labelIds REPLACES the label set, it does not add to it. Passing only the
    // rollback label strips `notion-archive` off every archived card, so a
    // rolled-back import stops being findable by the filter it was imported
    // under — the rehearsal on BRO-416 showed exactly that. addLabelToIssue is
    // the repo's existing additive primitive (BRO-282): it re-reads the current
    // labels immediately before the write, so it is used here rather than a
    // second hand-rolled read-modify-write.
    await linear.updateIssue(r.linearId, { stateId: canceledId });
    await linear.addLabelToIssue(r.linearId, rollbackLabelId);
    ledgerLib.appendRow(ledgerPath, ledgerLib.makeRow({
      pageId: r.pageId, linearId: r.linearId, identifier: r.identifier, title: r.title,
      source: 'corpus-import-rollback', retiredReason: 'rollback',
    }));
    cancelled++;
    await sleep(spacingMs);
  }
  console.log(JSON.stringify({ rollback: true, applied: true, cancelled }, null, 2));
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    console.log(USAGE);
    return;
  }
  const args = parseArgs(argv);
  const apply = boolFlag(args.apply, 'apply');
  const dryRun = !apply;
  const ledgerPath = args.ledger || path.join(REPO_ROOT, ledgerLib.DEFAULT_LEDGER);
  const spacingMs = numFlag(args['spacing-ms'], 'spacing-ms', 350);
  const batchSize = numFlag(args.batch, 'batch', 100);
  if (batchSize <= 0) throw new Error('--batch must be positive');
  // Parsed HERE, with every other flag, and not at its point of use — that sits
  // after ensureLabels() and the project pre-flight, so a typo'd --limit would
  // reject only AFTER the run had already created labels on the board.
  const limitArg = args.limit === undefined ? null : numFlag(args.limit, 'limit', null);

  if (boolFlag(args.rollback, 'rollback')) {
    await runRollback({ ledgerPath, apply, spacingMs });
    return;
  }

  const { file, records, malformed } = corpusIo.readCorpusRecords(args.corpus || DEFAULT_CORPUS);
  if (malformed) throw new Error(`${malformed} malformed corpus line(s) — re-verify the archive before importing`);

  const rows = ledgerLib.readRows(ledgerPath);
  const alreadyByPageId = ledgerLib.indexByPageId(rows);
  const { counts, skipReasons, candidates, liveAll, unknownPriorities } = buildReport(records, alreadyByPageId);
  const { labels, freq } = deriveLabelSet(liveAll);

  // S3-T6's acceptance criterion, asserted by the script rather than eyeballed:
  // every single record landed in exactly one named bucket.
  const accounted = counts.live + counts.archive + counts.skip + counts.alreadyImported;
  const balanced = accounted === records.length;

  const summary = {
    corpus: file,
    records: records.length,
    ledgerRows: rows.length,
    disposition: counts,
    skipReasons,
    accounted,
    balanced,
    unaccounted: records.length - accounted,
    unknownPriorities,
    labelsDerived: labels.length,
    topLabels: [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
  };

  if (!balanced) {
    console.error(JSON.stringify(summary, null, 2));
    throw new Error(`disposition does not balance: ${accounted} accounted vs ${records.length} records`);
  }

  if (dryRun) {
    if (args.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log('── corpus import: dry run (NOTHING written) ─────────');
      console.log(`  corpus                ${file}`);
      console.log(`  records               ${records.length}`);
      console.log(`  → live (P0/P1)        ${counts.live}`);
      console.log(`  → archive (Canceled)  ${counts.archive}`);
      console.log(`  → already imported    ${counts.alreadyImported}`);
      console.log(`  → skipped             ${counts.skip}`);
      for (const [r, n] of Object.entries(skipReasons).sort((a, b) => b[1] - a[1])) {
        console.log(`       ${String(n).padStart(5)}  ${r}`);
      }
      console.log(`  accounted             ${accounted} / ${records.length}  ${balanced ? '✅ balances' : '❌'}`);
      const unk = Object.entries(unknownPriorities);
      if (unk.length) {
        console.log(`  ⚠ ${unk.length} UNRECOGNISED priority spelling(s) — these archive by default:`);
        for (const [p, n] of unk.sort((a, b) => b[1] - a[1])) console.log(`       ${String(n).padStart(5)}  ${JSON.stringify(p)}`);
      }
      console.log(`  labels to ensure      ${labels.length}`);
      console.log(`  to create this run    ${candidates.length}`);
    }
    return;
  }

  // ── the real write ──────────────────────────────────────────────────────
  const limit = limitArg === null ? candidates.length : limitArg;
  const work = candidates.slice(0, limit);
  console.error(`importing ${work.length} of ${candidates.length} candidate(s), batches of ${batchSize}, ${spacingMs}ms spacing`);

  const team = await linear.getTeam();
  const stateByName = new Map(team.states.nodes.map((s) => [s.name, s.id]));
  const canceledId = stateByName.get('Canceled') || stateByName.get('Cancelled');
  if (!canceledId) throw new Error('no Canceled workflow state in this team — the archive half of the import cannot run');
  // PRE-FLIGHT: every project the run needs must exist BEFORE the first create.
  //
  // `projectsByName.get(name)` returning undefined does not throw — it produces
  // `projectId: undefined`, which Linear accepts, and the card lands with NO
  // project at all. Silently. Across 1,705 cards that is a board nobody can
  // triage, discovered only by looking. All nine names happen to exist today,
  // so this is a latent failure waiting on a rename, which is exactly the kind
  // that gets rediscovered at 3am rather than caught. Create what is missing
  // (linear-import.js's ensureProjects does the same) and fail loudly if that
  // does not work, before anything is written.
  const allProjects = await linear.listProjects();
  // listProjects() asks for `first: 100` and does not paginate. At 13 projects
  // that is fine, but if it ever returns exactly the page size the list may be
  // truncated — and a project that exists but is not in the list would be
  // CREATED again as a duplicate by the pre-flight below.
  if (allProjects.length >= 100) {
    throw new Error('listProjects returned a full page — it may be truncated; paginate before importing');
  }
  const projectsByName = new Map(allProjects.map((p) => [p.name, p]));
  const neededProjects = [...new Set(work.map(({ c }) => c.project))];
  for (const name of neededProjects) {
    if (projectsByName.has(name)) continue;
    console.error(`project "${name}" does not exist — creating it`);
    projectsByName.set(name, await linear.createProject(name, team.id));
  }
  const stillMissing = neededProjects.filter((n) => !projectsByName.get(n) || !projectsByName.get(n).id);
  if (stillMissing.length) {
    throw new Error(`refusing to import: project(s) unavailable — ${stillMissing.join(', ')}`);
  }
  const { byName: labelByName } = await ensureLabels(labels, team.id, { apply: true });

  let created = 0;
  let alreadyOnBoard = 0;

  const outcome = await runBatched({
    items: work,
    batchSize,
    betweenItems: () => sleep(spacingMs),
    onItem: async ({ record, c }) => {
      const id = rules.deriveIssueId(record.id);
      const isArchive = c.disposition === 'archive';
      const labelIds = [
        ...(isArchive ? [labelByName.get(rules.ARCHIVE_LABEL)] : []),
        ...(c.labels || []).map((l) => labelByName.get(l)),
      ]
        .filter(Boolean)
        .map((l) => l.id);
      const project = projectsByName.get(c.project);

      try {
        const issue = await linear.createIssue({
          teamId: team.id,
          title: c.title,
          description: buildDescription(record),
          priority: c.linearPriority,
          // The archive half lands Canceled: searchable by label, invisible to
          // linear-next --list, which reads open issues only.
          stateId: isArchive ? canceledId : stateByName.get(c.stateName),
          projectId: project ? project.id : undefined,
          labelIds,
          id,
          // Safe ONLY because of the deterministic id above: a replay after an
          // ambiguous 5xx either creates what never landed or is refused as a
          // conflict. Without the id this would mint duplicates (S1-T1).
          retryMutationsOn5xx: true,
        });
        ledgerLib.appendRow(ledgerPath, ledgerLib.makeRow({
          pageId: record.id, linearId: issue.id, identifier: issue.identifier,
          title: issue.title, project: c.project, source: 'corpus-import',
        }));
        created++;
        return { ok: true };
      } catch (err) {
        if (rules.isAlreadyExistsError(err)) {
          // Created by an earlier run that died before its ledger append. Record
          // it now so the anti-join sees it, and move on — this is a SUCCESS,
          // not a failure: the post-condition (the card is on the board) holds.
          alreadyOnBoard++;
          ledgerLib.appendRow(ledgerPath, ledgerLib.makeRow({
            pageId: record.id, linearId: id, identifier: null, title: c.title,
            project: c.project, source: 'corpus-import', retiredReason: 'recovered-existing',
          }));
          return { ok: true };
        }
        return { ok: false, pageId: record.id, title: c.title, error: err.message };
      }
    },
    onBatchEnd: ({ batch, failures }) => {
      console.error(`batch ${batch}: created ${created}, existing ${alreadyOnBoard}, failed ${failures.length}`);
    },
  });

  if (outcome.aborted) {
    console.error(JSON.stringify(outcome.failures.slice(0, 10), null, 2));
    throw new Error(
      `aborted after batch ${outcome.batches}: ${outcome.failures.length} unexpected failure(s). ` +
        `${created} issue(s) created and recorded in the ledger; re-run to resume from there.`
    );
  }

  console.log(JSON.stringify({ created, alreadyOnBoard, failures: outcome.failures.length, batches: outcome.batches, ledger: ledgerPath }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}

module.exports = { buildDescription, buildReport, deriveLabelSet };
