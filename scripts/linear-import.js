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
 * Idempotency: every created issue is appended to the mapping file
 * (data/linear-import-mapping.json) immediately after creation, keyed by
 * local mirror task id. A run skips any task already in the mapping file, and
 * defensively skips any task whose exact title already exists in team BRO
 * (covers the case where a prior run crashed after issueCreate succeeded but
 * before the mapping write landed).
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

const {
  extractNotionId,
  extractPriorityTag,
  mapPriorityToLinear,
  mapStatusToLinearState,
  classifyNoise,
  classifyProject,
} = require('./lib/linear-import-rules');
const linear = require('./lib/linear-client');

const REPO_ROOT = path.join(__dirname, '..');
const MIRROR_DIR =
  process.env.LINEAR_IMPORT_MIRROR_DIR || path.join(os.homedir(), '.claude/tasks/broadwayscore');
const MAPPING_PATH = path.join(REPO_ROOT, 'data/linear-import-mapping.json');

const WORKSTREAM_PROJECTS = [
  'Coverage pipeline',
  'Scoring quality',
  'Opening night',
  'Commercial',
  'iOS',
  'Marketing/distribution',
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

function saveMapping(mapping) {
  fs.mkdirSync(path.dirname(MAPPING_PATH), { recursive: true });
  fs.writeFileSync(MAPPING_PATH, JSON.stringify(mapping, null, 2) + '\n');
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

// Returns a Set of Notion page IDs that are P2-Later, "Not started", and have
// not been edited in 30+ days — the population step 2 of the card routes to
// the Archive project. Queried live because local mirror file mtimes reflect
// the last mirror resync, not the underlying Notion edit time (verified
// against the mirror on 2026-08-11 — every file had the same resync mtime).
function getStalePendingP2NotionIds() {
  let out;
  try {
    out = execFileSync(
      'node',
      [
        path.join(REPO_ROOT, 'scripts/notion-brain.js'),
        'list',
        '--priority',
        'P2 Later',
        '--status',
        'Not started',
        '--stale-days',
        '30',
        '--limit',
        '500',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000 }
    );
  } catch (err) {
    console.error(`notion-brain.js list failed, treating stale-P2 set as empty: ${err.message}`);
    return new Set();
  }
  let rows;
  try {
    rows = JSON.parse(out);
  } catch {
    return new Set();
  }
  return new Set(rows.map((r) => r.id));
}

function classifyTask(task, stalePendingP2Ids) {
  const subject = (task.subject || '').trim();
  if (!subject) return { skip: 'blank_title' };
  if (task.status === 'completed') return { skip: 'completed' };

  const noise = classifyNoise(subject);
  if (noise) return { skip: `noise:${noise}` };

  const notionId = extractNotionId(task.description || '');
  const priorityTag = extractPriorityTag(task.description || '');
  const isStaleP2 =
    task.status === 'pending' && priorityTag === 'P2 Later' && notionId && stalePendingP2Ids.has(notionId);

  return {
    skip: null,
    subject,
    notionId,
    priorityTag,
    linearPriority: mapPriorityToLinear(priorityTag),
    stateName: mapStatusToLinearState(task.status),
    project: isStaleP2 ? ARCHIVE_PROJECT : classifyProject(subject),
    archivedForStaleness: isStaleP2,
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

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const mirrorTasks = readMirrorTasks();
  const mapping = loadMapping();
  const stalePendingP2Ids = getStalePendingP2NotionIds();

  const skipCounts = {};
  const byProject = {};
  const candidates = [];
  let alreadyImported = 0;

  for (const task of mirrorTasks) {
    if (mapping[task.id]) {
      alreadyImported++;
      continue;
    }
    const c = classifyTask(task, stalePendingP2Ids);
    if (c.skip) {
      skipCounts[c.skip] = (skipCounts[c.skip] || 0) + 1;
      continue;
    }
    candidates.push({ taskId: task.id, description: task.description || '', ...c });
    byProject[c.project] = (byProject[c.project] || 0) + 1;
  }

  const summary = {
    mirrorRecords: mirrorTasks.length,
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
  const existingTitles = await linear.listAllIssueTitles(team.id);
  const seenTitles = new Set(existingTitles.keys());

  let created = 0;
  let titleCollisions = 0;

  for (const c of candidates) {
    if (seenTitles.has(c.subject)) {
      titleCollisions++;
      console.error(`skip (title exists in BRO): ${c.subject}`);
      continue;
    }
    const stateId = stateByName.get(c.stateName);
    const projectId = projects[c.project].id;
    const issue = await linear.createIssue({
      teamId: team.id,
      title: c.subject,
      description: c.description,
      priority: c.linearPriority,
      stateId,
      projectId,
    });
    seenTitles.add(c.subject);
    mapping[c.taskId] = {
      linearId: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      project: c.project,
    };
    saveMapping(mapping); // after EVERY create — a killed run resumes, never double-creates
    created++;
    console.error(`created ${issue.identifier}: ${issue.title}`);
  }

  console.log(
    JSON.stringify({ ...summary, created, titleCollisions, mappingTotal: Object.keys(mapping).length }, null, 2)
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}

module.exports = { readMirrorTasks, classifyTask, MIRROR_DIR, MAPPING_PATH };
