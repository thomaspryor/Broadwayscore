#!/usr/bin/env node
/**
 * linear-import.js — Day 1 of the Linear migration (card #1283, owner-approved
 * Option A, 2026-08-11). Additive, resumable import of the local task mirror
 * into Linear team BRO. Notion stays authoritative until Day 3 decommission —
 * this script only ever creates in Linear, it never touches Notion or the
 * local mirror.
 *
 * Usage:
 *   node scripts/linear-import.js --dry-run     # print counts, no writes
 *   node scripts/linear-import.js                # real run, resumable
 *
 * Idempotency (S3-T3, 2026-08-18): every created issue is appended to the
 * mapping file (data/linear-import-mapping.json) immediately after creation,
 * keyed by local mirror task id, and every create carries a DETERMINISTIC
 * client-supplied id derived from the card's Notion page (or, failing that, its
 * mirror task id). A run skips any task already in the mapping file; a task the
 * mapping does not know about — the prior run crashed after issueCreate
 * succeeded but before the mapping write landed — is refused by the server as
 * an id conflict and counted, not re-created.
 *
 * This REPLACED an exact-title skip. Titles are not identity: measured against
 * the Sprint 2 corpus, 28 titles are shared by 69 distinct un-Done cards, so
 * the title check silently collapsed 41 real cards. Page identity does not have
 * that failure mode.
 *
 * Curation rules live in scripts/lib/linear-import-rules.js (unit tested).
 * Summary:
 *   - completed local tasks are never imported (Notion/mirror already closed them)
 *   - 6 noise categories are skipped entirely, not archived (see classifyNoise)
 *   - everything else is filed into one of 7 workstream projects by keyword
 *   - pending P2-Later cards untouched in Notion for 30+ days route to the
 *     Archive project instead of their workstream (reversible, not deleted)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const rules = require('./lib/linear-import-rules');
const {
  extractNotionId,
  extractPriorityTag,
  mapPriorityToLinear,
  mapStatusToLinearState,
  classifyNoise,
  classifyProject,
  isIdleArchive,
} = rules;
const linear = require('./lib/linear-client');
const ledgerLib = require('./lib/import-ledger');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `linear-import.js — Day 1 of the Linear migration: additive, resumable import of the local task mirror into Linear team BRO.

Usage:
  node scripts/linear-import.js [--dry-run] [--reconcile] [--apply] [--refresh-snapshot]
  node scripts/linear-import.js --help, -h    print this usage and exit
`;

const REPO_ROOT = path.join(__dirname, '..');
const MIRROR_DIR =
  process.env.LINEAR_IMPORT_MIRROR_DIR || path.join(os.homedir(), '.claude/tasks/broadwayscore');
const MAPPING_PATH = path.join(REPO_ROOT, 'data/linear-import-mapping.json');
const SNAPSHOT_PATH = path.join(REPO_ROOT, 'data/audit/linear-notion-snapshot.json');
const MUTATION_LOG_PATH = path.join(REPO_ROOT, 'data/audit/linear-reconcile-mutations.jsonl');

const WORKSTREAM_PROJECTS = [
  'Coverage pipeline',
  'Scoring quality',
  'Opening night',
  'Commercial',
  'iOS',
  'Marketing/distribution',
  'Site & product',
  'Infrastructure',
];
const ARCHIVE_PROJECT = 'Archive';
const ALL_PROJECTS = [...WORKSTREAM_PROJECTS, ARCHIVE_PROJECT];

function loadMapping() {
  try {
    return JSON.parse(fs.readFileSync(MAPPING_PATH, 'utf8'));
  } catch {
    return {};
  }
}

// Write to a temp file and rename. A plain writeFileSync truncates in place,
// so a kill mid-write leaves invalid JSON — and loadMapping() swallows the
// parse error as {}, which would make the next run re-create every issue whose
// title it does not happen to observe. rename() is atomic on the same
// filesystem, so the file is either the old mapping or the new one.
function saveMapping(mapping) {
  fs.mkdirSync(path.dirname(MAPPING_PATH), { recursive: true });
  const tmp = `${MAPPING_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(mapping, null, 2) + '\n');
  fs.renameSync(tmp, MAPPING_PATH);
}

/**
 * Also append to the pageId ledger (S3-T2's data/linear-import-mapping.jsonl).
 *
 * WHY BOTH. This script's own idempotency key is the local mirror task id, and
 * that stays in the legacy JSON — nothing about --reconcile changes. But the
 * Sprint 3 anti-join joins on NOTION PAGE ID, and it reads the JSONL. An issue
 * this script creates without leaving a JSONL row is invisible to the
 * completeness check: verify-linear-migration.js would report its Notion page
 * as unaccounted and the corpus importer would try to create it again (getting
 * an id conflict, harmless but noisy). Two ledgers that disagree about what is
 * on the board is exactly the state Sprint 3 exists to leave behind.
 *
 * A task with no [notion:] marker has no pageId and is skipped here on purpose:
 * a row with pageId null cannot be joined on and the ledger already reports how
 * many of those it holds.
 */
function appendPageLedger(c, linearId, identifier) {
  if (!c.notionId) return;
  try {
    ledgerLib.appendRow(path.join(REPO_ROOT, ledgerLib.DEFAULT_LEDGER), ledgerLib.makeRow({
      pageId: c.notionId,
      taskId: c.taskId,
      linearId,
      identifier,
      title: c.subject,
      project: c.project,
      source: 'mirror-import',
    }));
  } catch (err) {
    // Never fail a create over a bookkeeping write — the issue already exists
    // on the board at this point, and losing the run would be worse than losing
    // the row (which the anti-join will surface anyway).
    console.error(`warning: could not append pageId ledger row: ${err.message}`);
  }
}

// Every board mutation, appended before it is applied: the issue, the field,
// and the value it held BEFORE. --reconcile --apply moves issues between
// projects and sets state=Done, and without this there is no record of what to
// put back — rollback would mean reconstructing the prior board by hand.
function logMutation(entry) {
  fs.mkdirSync(path.dirname(MUTATION_LOG_PATH), { recursive: true });
  fs.appendFileSync(MUTATION_LOG_PATH, JSON.stringify(entry) + '\n');
}

function readMirrorTasks() {
  const files = fs
    .readdirSync(MIRROR_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10)); // deterministic order
  const tasks = [];
  for (const f of files) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(MIRROR_DIR, f), 'utf8'));
    } catch (err) {
      console.error(`skipping unreadable mirror file ${f}: ${err.message}`);
      continue;
    }
    tasks.push(raw);
  }
  return tasks;
}

// Notion state the curation needs, keyed by page id: which cards are already
// Done, and how many days since each open card was last edited.
//
// Read from a committed FILE snapshot rather than queried live, for two
// reasons. (1) Determinism: the card's acceptance criterion is that two
// consecutive --dry-runs print identical counts, which a live query cannot
// promise. (2) Auditability: the snapshot is the evidence for every
// archive/skip decision this run made. Refresh it explicitly with
// --refresh-snapshot. Mirror file mtimes are NOT a substitute — they all
// reflect the last mirror resync, not the underlying Notion edit time.
function refreshNotionSnapshot(mirrorTasks) {
  const referenced = new Set();
  for (const t of mirrorTasks) {
    const id = extractNotionId(t.description || '');
    if (id) referenced.add(id);
  }
  const doneIds = [];
  const openAgeDays = {};
  for (const status of ['Done', 'Not started', 'In progress', 'Paused']) {
    let rows;
    try {
      const out = execFileSync(
        'node',
        [path.join(REPO_ROOT, 'scripts/notion-brain.js'), 'list', '--status', status, '--limit', '5000'],
        { cwd: REPO_ROOT, encoding: 'utf8', timeout: 300_000, maxBuffer: 256 * 1024 * 1024 }
      );
      rows = JSON.parse(out);
    } catch (err) {
      throw new Error(`notion-brain.js list --status "${status}" failed: ${err.message}`);
    }
    for (const r of rows) {
      if (!referenced.has(r.id)) continue;
      if (status === 'Done') doneIds.push(r.id);
      else openAgeDays[r.id] = r.ageDays;
    }
  }
  const snapshot = {
    generatedAt: new Date().toISOString().slice(0, 10),
    source: 'scripts/notion-brain.js list --status <s>',
    referencedByMirror: referenced.size,
    doneIds: doneIds.sort(),
    openAgeDays: Object.fromEntries(Object.entries(openAgeDays).sort(([a], [b]) => a.localeCompare(b))),
  };
  fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + '\n');
  return snapshot;
}

function loadNotionSnapshot() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
  } catch {
    throw new Error(
      `no Notion snapshot at ${SNAPSHOT_PATH} — run: node scripts/linear-import.js --refresh-snapshot`
    );
  }
  return {
    generatedAt: raw.generatedAt,
    doneIds: new Set(raw.doneIds || []),
    ageDays: new Map(Object.entries(raw.openAgeDays || {})),
  };
}

function classifyTask(task, notionState) {
  const subject = (task.subject || '').trim();
  if (!subject) return { skip: 'blank_title' };
  if (task.status === 'completed') return { skip: 'completed' };

  const notionId = extractNotionId(task.description || '');

  // Notion stays authoritative until Day 3, and the mirror lags it: ~50 records
  // sit pending/in_progress locally while their card is already Done. Importing
  // those recreates the dispatch-waste class task #1272 measured (work handed
  // out that was already finished), so the card's status outranks the mirror's.
  // Checked BEFORE the noise rules so the skip reason names the real cause.
  if (notionId && notionState.doneIds.has(notionId)) return { skip: 'notion_done' };

  const noise = classifyNoise(subject);
  if (noise) return { skip: `noise:${noise}` };

  const priorityTag = extractPriorityTag(task.description || '');
  const ageDays = notionId && notionState.ageDays.has(notionId) ? notionState.ageDays.get(notionId) : null;
  const idle = isIdleArchive(task.status, ageDays);

  return {
    skip: null,
    subject,
    notionId,
    priorityTag,
    ageDays,
    // An archived issue drops to Low so an "all High priority" board view stays
    // a view of live work. The original priority survives in the issue body.
    linearPriority: idle ? 4 : mapPriorityToLinear(priorityTag),
    stateName: mapStatusToLinearState(task.status),
    project: idle ? ARCHIVE_PROJECT : classifyProject(subject),
    archivedForStaleness: idle,
  };
}

async function ensureProjects(teamId) {
  const existing = await linear.listProjects();
  const byName = new Map(existing.map((p) => [p.name, p]));
  const projects = {};
  for (const name of ALL_PROJECTS) {
    if (byName.has(name)) {
      projects[name] = byName.get(name);
    } else {
      projects[name] = await linear.createProject(name, teamId);
      console.error(`created project: ${name}`);
    }
  }
  return projects;
}

/**
 * Diff the curation against issues that already exist in BRO, keyed by title.
 *
 * Not hypothetical: two workspaces were dispatched on this same migration card
 * (#1281's duplicate-dispatch class) and the other one's import landed first,
 * so the importer has to be able to CONVERGE a populated board. Without this,
 * the only way to apply a curation correction to 250 already-created issues is
 * to delete and re-import.
 *
 * @param {Array} classified  [{task, c}] where c is classifyTask's output
 * @param {Map} byTitle       title -> {id, identifier, project, state, url}
 */
function reconcile(classified, byTitle) {
  const out = { mapped: [], missing: [], notCurated: [], reproject: [] };
  for (const { task, c } of classified) {
    const issue = byTitle.get((task.subject || '').trim());
    if (c.skip) {
      // 'completed' is a local-only state — it says nothing about whether the
      // card belongs on the board, so it never drives a Linear change.
      if (issue && c.skip !== 'completed') out.notCurated.push({ task, c, issue });
      continue;
    }
    if (!issue) { out.missing.push({ task, c }); continue; }
    out.mapped.push({ task, c, issue });
    if (issue.project !== c.project) out.reproject.push({ task, c, issue });
  }
  return out;
}

async function runReconcile({ classified, mapping, apply }) {
  const team = await linear.getTeam();
  const stateByName = new Map(team.states.nodes.map((s) => [s.name, s.id]));
  const projects = await ensureProjects(team.id);
  const issues = await linear.listIssues(team.id);
  const byTitle = new Map(issues.map((i) => [i.title, i]));
  const r = reconcile(classified, byTitle);

  const notCuratedBy = {};
  for (const n of r.notCurated) notCuratedBy[n.c.skip] = (notCuratedBy[n.c.skip] || 0) + 1;
  console.error(
    `reconcile vs ${issues.length} issues in ${linear.TEAM_KEY}: matched ${r.mapped.length} · ` +
      `missing ${r.missing.length} · not-curated-in ${r.notCurated.length} ${JSON.stringify(notCuratedBy)} · ` +
      `wrong project ${r.reproject.length}`
  );
  for (const m of r.missing) console.error(`  missing: #${m.task.id} ${m.c.project} | ${m.task.subject.slice(0, 70)}`);

  if (!apply) {
    console.log(JSON.stringify({
      reconcile: true, applied: false, issues: issues.length,
      matched: r.mapped.length, missing: r.missing.length,
      notCurated: r.notCurated.length, notCuratedBy, reproject: r.reproject.length,
    }, null, 2));
    return;
  }

  let moved = 0;
  let retired = 0;
  let recorded = 0;
  // A card whose Notion page is already Done, or that the curation excludes as
  // noise/fleet, is finished or deleted work: park it in Archive at Done so the
  // live board stops offering it. Nothing is deleted.
  for (const { task, c, issue } of r.notCurated) {
    if (issue.project !== ARCHIVE_PROJECT || issue.state !== 'Done') {
      logMutation({
        identifier: issue.identifier, taskId: task.id, action: 'retire', reason: c.skip,
        fromProject: issue.project, fromState: issue.state,
        toProject: ARCHIVE_PROJECT, toState: 'Done',
      });
      await linear.updateIssue(issue.id, {
        projectId: projects[ARCHIVE_PROJECT].id,
        stateId: stateByName.get('Done'),
      });
      retired++;
    }
    // retiredReason is the provenance the revive path gates on, so it has to be
    // stamped on EVERY retire — including a task whose mapping row already
    // carries an identifier from an earlier run. Writing it only when the row
    // was missing (the first version of this) meant an already-mapped issue
    // could be retired and then never revived when its Notion card reopened:
    // the revive check would see no retiredReason and leave it at Done forever.
    if (!mapping[task.id] || !mapping[task.id].identifier) {
      mapping[task.id] = { linearId: issue.id, identifier: issue.identifier, title: issue.title, project: ARCHIVE_PROJECT, retiredReason: c.skip };
      saveMapping(mapping);
      recorded++;
    } else if (mapping[task.id].retiredReason !== c.skip) {
      mapping[task.id].retiredReason = c.skip;
      mapping[task.id].project = ARCHIVE_PROJECT;
      saveMapping(mapping);
    }
  }
  let revived = 0;
  for (const { task, c, issue } of r.mapped) {
    if (issue.project !== c.project) {
      logMutation({
        identifier: issue.identifier, taskId: task.id, action: 'reproject', reason: c.archivedForStaleness ? 'idle' : 'route',
        fromProject: issue.project, toProject: c.project,
      });
      await linear.updateIssue(issue.id, { projectId: projects[c.project].id });
      moved++;
    }
    // A card THIS tool retired, whose Notion page has since reopened, comes
    // back as curated-in — but it is still sitting at Done, invisible in every
    // active board view. Nothing else puts it back, so reconcile has to.
    //
    // Gated on retiredReason on purpose: an issue the OWNER marked Done in
    // Linear must stay Done. Reviving anything merely because the mirror still
    // says pending would mean the tool reopens work the owner just closed.
    const wasRetiredByUs = mapping[task.id] && mapping[task.id].retiredReason;
    if (wasRetiredByUs && issue.state === 'Done' && c.stateName !== 'Done') {
      logMutation({
        identifier: issue.identifier, taskId: task.id, action: 'revive', reason: 'curated-in but Done',
        fromState: issue.state, toState: c.stateName,
      });
      await linear.updateIssue(issue.id, { stateId: stateByName.get(c.stateName) });
      delete mapping[task.id].retiredReason;
      saveMapping(mapping);
      revived++;
    }
    if (!mapping[task.id] || !mapping[task.id].identifier) {
      mapping[task.id] = { linearId: issue.id, identifier: issue.identifier, title: issue.title, project: c.project };
      saveMapping(mapping);
      recorded++;
    }
  }
  console.log(JSON.stringify({
    reconcile: true, applied: true, moved, retired, revived, recorded,
    missing: r.missing.length, mappingTotal: Object.keys(mapping).length,
    mutationLog: MUTATION_LOG_PATH,
  }, null, 2));
}

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const dryRun = process.argv.includes('--dry-run');
  const wantReconcile = process.argv.includes('--reconcile');
  const apply = process.argv.includes('--apply');

  const mirrorTasks = readMirrorTasks();

  if (process.argv.includes('--refresh-snapshot')) {
    const snap = refreshNotionSnapshot(mirrorTasks);
    console.log(JSON.stringify({
      snapshot: SNAPSHOT_PATH, generatedAt: snap.generatedAt,
      referencedByMirror: snap.referencedByMirror,
      done: snap.doneIds.length, open: Object.keys(snap.openAgeDays).length,
    }, null, 2));
    return;
  }

  const mapping = loadMapping();
  const notionState = loadNotionSnapshot();

  // Classify EVERY record first (independent of the mapping), because
  // --reconcile needs the full curation to diff against the board, not just
  // the not-yet-imported tail.
  const classified = mirrorTasks.map((task) => ({ task, c: classifyTask(task, notionState) }));

  if (wantReconcile) {
    await runReconcile({ classified, mapping, apply });
    return;
  }

  const skipCounts = {};
  const byProject = {};
  const candidates = [];
  let alreadyImported = 0;

  for (const { task, c } of classified) {
    if (mapping[task.id]) {
      alreadyImported++;
      continue;
    }
    if (c.skip) {
      skipCounts[c.skip] = (skipCounts[c.skip] || 0) + 1;
      continue;
    }
    candidates.push({ taskId: task.id, description: task.description || '', ...c });
    byProject[c.project] = (byProject[c.project] || 0) + 1;
  }

  const summary = {
    mirrorRecords: mirrorTasks.length,
    notionSnapshot: notionState.generatedAt,
    alreadyImported,
    skipped: skipCounts,
    skippedTotal: Object.values(skipCounts).reduce((a, b) => a + b, 0),
    importCandidates: candidates.length,
    byProject,
  };

  if (dryRun) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.error(`Dry-run summary:\n${JSON.stringify(summary, null, 2)}`);

  const team = await linear.getTeam();
  const stateByName = new Map(team.states.nodes.map((s) => [s.name, s.id]));
  const projects = await ensureProjects(team.id);

  // S3-T3: the exact-title dedupe is GONE.
  //
  // It skipped any candidate whose title already existed anywhere in BRO. That
  // is wrong on the data: measured against the Sprint 2 corpus, 28 titles are
  // shared by 69 distinct un-Done cards (four cards named "BSC Daily: Sync:
  // baseline drift", the three "main red" P0s, and so on), so title-dedupe
  // silently collapses 41 real cards into one issue each and reports it as a
  // successful skip.
  //
  // It is replaced, NOT merely deleted — it was the only duplicate guard this
  // script had. The replacement is strictly stronger and has two layers:
  //
  //   1. the local ledger (below), which skips anything already imported, and
  //   2. a client-supplied deterministic id on every create, so even a create
  //      the ledger did not record — the crash-after-issueCreate-before-write
  //      case the title check was actually defending against — is a server-side
  //      no-op on replay rather than a second issue.
  //
  // Landing (1) without (2) would leave the board unprotected in between, which
  // is why these two are one commit and not two.
  let created = 0;
  // A create whose id already exists comes back as the EXISTING issue rather
  // than a new one, so this counts replays that the ledger did not know about
  // — the crash-recovery case, now visible instead of silent.
  let alreadyOnBoard = 0;

  for (const c of candidates) {
    const stateId = stateByName.get(c.stateName);
    const projectId = projects[c.project].id;
    // A mirror task's Notion page id when it has one; otherwise a stable key
    // from the mirror task id. Both are namespaced so the two id spaces cannot
    // collide, and both are deterministic, which is the whole point.
    const issueId = c.notionId
      ? rules.deriveIssueId(c.notionId)
      : rules.deriveIssueId(String(c.taskId), 'mirror-task');
    let issue;
    try {
      issue = await linear.createIssue({
        teamId: team.id,
        title: c.subject,
        description: c.description,
        priority: c.linearPriority,
        stateId,
        projectId,
        id: issueId,
      });
    } catch (err) {
      // The id is already on the board: a previous run created this issue and
      // died before the mapping write landed. That is the exact case the old
      // title check was for, and the server now answers it definitively —
      // by page identity rather than by a title that other cards may share.
      if (rules.isAlreadyExistsError(err)) {
        // RECORD IT. Skipping the mapping write here means the mapping never
        // converges: every future run re-attempts a create for this card
        // forever, and --reconcile's mapping[task.id] lookups cannot retire or
        // revive it because there is no row. The issue id is deterministic, so
        // it is already in hand — there is nothing to look up.
        alreadyOnBoard++;
        mapping[c.taskId] = {
          linearId: issueId,
          identifier: (mapping[c.taskId] || {}).identifier || null,
          title: c.subject,
          project: c.project,
        };
        saveMapping(mapping);
        appendPageLedger(c, issueId, null);
        console.error(`already on board (id ${issueId}): ${c.subject}`);
        continue;
      }
      throw err;
    }
    mapping[c.taskId] = {
      linearId: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      project: c.project,
    };
    saveMapping(mapping); // after EVERY create — a killed run resumes, never double-creates
    appendPageLedger(c, issue.id, issue.identifier);
    created++;
    console.error(`created ${issue.identifier}: ${issue.title}`);
  }

  console.log(
    JSON.stringify(
      { ...summary, created, alreadyOnBoard, mappingTotal: Object.keys(mapping).length },
      null,
      2
    )
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}

module.exports = { readMirrorTasks, classifyTask, reconcile, MIRROR_DIR, MAPPING_PATH, SNAPSHOT_PATH };
