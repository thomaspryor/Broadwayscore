#!/usr/bin/env node
'use strict';
/**
 * new-fix-plan.js (BRO-5892): write a data/pending-fixes plan with the traps of hand-written plans filled in
 * (BRO-5853 hit each one): oldValue read from current data, chained through earlier edits in the same plan;
 * review-file-op paths made relative to the review-texts tree; split into <id>.json, <id>-b.json, ... at
 * MAX_PLAN_ACTIONS; issueNumber = file name; fresh planId; status "pending". Then it runs preflight, force-adds
 * the files (data/pending-fixes is gitignored) and prints the dispatch command for after the land.
 *
 * Usage:
 *   node scripts/new-fix-plan.js --id=bro-N --summary="..." [edits...] [--risk=low] [--dry-run] [--force]
 *   Edits (repeatable; VALUE is JSON, or a bare string when it is not valid JSON):
 *     --edit='<showId>.<field>=VALUE'              shows.json data-edit
 *     --commercial-edit='<slug>.<field>=VALUE'     commercial.json data-edit
 *     --buzz-edit='<showId>.<field>=VALUE'         audience-buzz.json data-edit
 *     --review-edit='<show>/<file>.json:<field>=VALUE'   review-field-edit
 *     --actions=<file.json>                        a JSON array of actions; oldValue is filled where absent
 *   --dry-run prints the plan(s) and the preflight result and writes nothing.
 * Exit 0 written (or dry run) and preflight clean, 1 preflight failed or an edit was refused, 2 bad usage.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { applyDataEdit, dataEditAllowProblem } = require('./lib/data-edit-action');
const { MAX_PLAN_ACTIONS } = require('./lib/pending-fix-limits');
const { preflight, pickReviewTextsTree, pickCoreDataDir } = require('./lib/preflight-review-fix-plan');
const { refreshDataClone } = require('./lib/data-clone-refresh');

const ROOT = path.join(__dirname, '..');
const PLAN_DIR = path.join(ROOT, 'data', 'pending-fixes');
const USAGE = 'Usage: node scripts/new-fix-plan.js --id=bro-N --summary="..." (--edit=<showId>.<field>=VALUE | --commercial-edit=... | --buzz-edit=... | --review-edit=<show>/<file>.json:<field>=VALUE | --actions=<file.json>)... [--risk=low] [--dry-run] [--force]';

function parseValue(raw) {
  try { return JSON.parse(raw); } catch { return raw; }
}

/** '<key>.<field>=VALUE' -> { key, field, value }. The key is everything before the last dot ahead of '='. */
function parseDotted(spec) {
  const eq = spec.indexOf('=');
  if (eq < 0) return null;
  const left = spec.slice(0, eq);
  const dot = left.lastIndexOf('.');
  if (dot <= 0 || dot === left.length - 1) return null;
  return { key: left.slice(0, dot), field: left.slice(dot + 1), value: parseValue(spec.slice(eq + 1)) };
}

/** CLI flags -> actions without oldValue. Throws on a malformed flag. */
function actionsFromArgs(args, { readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  const actions = [];
  for (const arg of args) {
    const m = /^--(edit|commercial-edit|buzz-edit|review-edit|actions)=(.*)$/s.exec(arg);
    if (!m) continue;
    const [, kind, spec] = m;
    if (kind === 'actions') {
      const list = JSON.parse(readFile(spec));
      if (!Array.isArray(list)) throw new Error(`--actions ${spec}: expected a JSON array`);
      actions.push(...list);
    } else if (kind === 'review-edit') {
      const rm = /^(.+?\.json):([A-Za-z0-9_]+)=(.*)$/s.exec(spec);
      if (!rm) throw new Error(`--review-edit "${spec}": expected <show>/<file>.json:<field>=VALUE`);
      actions.push({ type: 'review-field-edit', file: rm[1], field: rm[2], newValue: parseValue(rm[3]) });
    } else {
      const d = parseDotted(spec);
      if (!d) throw new Error(`--${kind} "${spec}": expected <id>.<field>=VALUE`);
      const file = { edit: 'shows.json', 'commercial-edit': 'commercial.json', 'buzz-edit': 'audience-buzz.json' }[kind];
      const a = { type: 'data-edit', file, field: d.field, newValue: d.value };
      if (file === 'commercial.json') a.showSlug = d.key; else a.showId = d.key;
      actions.push(a);
    }
  }
  return actions;
}

const REVIEW_TEXTS_PREFIX = /^(\.\/)?data\/review-texts\//;

/**
 * Fill oldValue in plan order and normalize paths. Data edits are applied to `data` copies with the executor's own
 * applyDataEdit, so a later edit sees an earlier one's value and stamps (openingDate -> openingDateSource).
 * Pure over `loadData` / `readReview`. Returns { actions, problems }.
 */
/** VALUE is parsed as JSON, so `150` becomes a number. Refuse an edit that changes a set field's type. */
function typeChangeProblem(a) {
  const kind = (v) => (v === null || v === undefined ? null : Array.isArray(v) ? 'array' : typeof v);
  const from = kind(a.oldValue), to = kind(a.newValue);
  if (!from || !to || from === to) return null;
  const hint = from === 'string' ? ` (to keep it a string, quote it as JSON: ${a.field}='${JSON.stringify(String(a.newValue))}')` : '';
  return `${a.field} would change from ${from} to ${to}${hint}`;
}

function completeActions(actions, { loadData, readReview }) {
  const problems = [];
  const reviewNow = new Map(); // `${file}|${field}` -> value after earlier edits
  const out = actions.map((orig, i) => {
    const a = { ...orig };
    const where = `action ${i + 1} (${a.type})`;
    if (a.type === 'data-edit') {
      const notAllowed = dataEditAllowProblem(a);
      if (notAllowed) { problems.push(`${where}: ${notAllowed}`); return a; }
      const data = loadData(a.file);
      if (!('oldValue' in a)) a.oldValue = currentDataValue(data, a);
      if (a.oldValue === undefined) { problems.push(`${where}: no ${a.file} entry for ${a.showSlug || a.showId}`); return a; }
      const typeProblem = typeChangeProblem(a);
      if (typeProblem) { problems.push(`${where}: ${typeProblem}`); return a; }
      const res = applyDataEdit(data, a);
      if (!res.ok) problems.push(`${where}: ${res.reason}`);
      if (!a.description) a.description = `${a.file}: ${a.showSlug || a.showId}.${a.field}`;
    } else if (a.type === 'review-field-edit') {
      a.file = String(a.file || '').replace(REVIEW_TEXTS_PREFIX, '');
      if (path.isAbsolute(a.file) || a.file.split(/[\\/]/).includes('..')) { problems.push(`${where}: review file must be <show>/<file>.json inside the review texts: ${a.file}`); return a; }
      const key = `${a.file}|${a.field}`;
      if (!('oldValue' in a)) {
        if (reviewNow.has(key)) a.oldValue = reviewNow.get(key);
        else {
          const rec = readReview(a.file);
          if (!rec) { problems.push(`${where}: review file not found: ${a.file}`); return a; }
          a.oldValue = rec[a.field] ?? null;
        }
      }
      const typeProblem = typeChangeProblem(a);
      if (typeProblem) { problems.push(`${where}: ${typeProblem}`); return a; }
      reviewNow.set(key, a.newValue);
      if (!a.description) a.description = `${a.file}: ${a.field}`;
    } else if (a.type === 'review-file-op') {
      for (const k of ['sourcePath', 'destPath']) if (typeof a[k] === 'string') a[k] = a[k].replace(REVIEW_TEXTS_PREFIX, '');
      // The executor reads destPath only; a misnamed key fails at apply time (BRO-6481).
      if ((a.operation === 'move' || a.operation === 'rename') && !a.destPath) problems.push(`${where}: ${a.operation} needs destPath`);
    }
    return ordered(a);
  });
  return { actions: out, problems };
}

// Reviewers read oldValue next to newValue.
const KEY_ORDER = ['type', 'file', 'showId', 'showSlug', 'operation', 'sourcePath', 'destPath', 'field', 'oldValue', 'newValue', 'description'];
function ordered(a) {
  const out = {};
  for (const k of KEY_ORDER) if (k in a) out[k] = a[k];
  return Object.assign(out, a);
}

function currentDataValue(data, a) {
  if (a.file === 'shows.json') {
    const show = (data.shows || data).find((s) => s.id === a.showId);
    return show ? show[a.field] ?? null : undefined;
  }
  const rec = data.shows && data.shows[a.file === 'commercial.json' ? (a.showSlug || a.showId) : a.showId];
  return rec ? rec[a.field] ?? null : undefined;
}

/** bro-N, bro-N-b, bro-N-c, ... */
function splitName(id, index) {
  return index === 0 ? id : `${id}-${String.fromCharCode(97 + index)}`;
}

/**
 * Chunks of at most `max` actions. One show's consecutive actions stay in one chunk (BRO-6487): a later action
 * on the same field chains its oldValue through the earlier edit, and plans apply in file-name order, so a
 * split put "openingDateSource" ahead of the "openingDate" edit that stamps its oldValue and the plan was refused.
 */
function chunkActions(actions, max) {
  const key = (a) => a.showId || a.showSlug || a.file;
  const groups = [];
  for (const a of actions) {
    const g = groups[groups.length - 1];
    if (g && key(g[0]) === key(a)) g.push(a); else groups.push([a]);
  }
  const chunks = [];
  let cur = [];
  for (const g of groups) {
    if (g.length > max) { // one show with more than a plan's worth: no choice but to split it
      if (cur.length) { chunks.push(cur); cur = []; }
      for (let i = 0; i < g.length; i += max) chunks.push(g.slice(i, i + max));
      continue;
    }
    if (cur.length + g.length > max) { chunks.push(cur); cur = []; }
    cur.push(...g);
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** Split actions into plan objects of at most `max` actions each. Pure apart from planId/createdAt. */
function buildPlans(id, summary, actions, { risk = 'low', max = MAX_PLAN_ACTIONS, now = new Date().toISOString(), uuid = crypto.randomUUID } = {}) {
  const plans = [];
  const chunks = chunkActions(actions, max);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const name = splitName(id, i);
    const total = chunks.length;
    plans.push({
      name,
      plan: {
        issueNumber: name,
        planId: uuid(),
        status: 'pending',
        createdAt: now,
        submitter: { name: null, email: null },
        plan: {
          summary: total > 1 ? `${summary} (part ${i + 1} of ${total})` : summary,
          steps: chunk.map((a) => a.description || a.type),
          riskLevel: risk,
          actions: chunk,
        },
      },
    });
  }
  return plans;
}

function main(argv) {
  const get = (k) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
  const id = get('id');
  const summary = get('summary');
  if (!id || !/^bro-\d+[a-z0-9-]*$/.test(id) || !summary) { console.error(USAGE); return 2; }
  const dryRun = argv.includes('--dry-run');
  let raw;
  try { raw = actionsFromArgs(argv); } catch (e) { console.error(e.message); return 2; }
  if (!raw.length) { console.error(`No edits given.\n${USAGE}`); return 2; }

  const coreDataDir = pickCoreDataDir();
  // BRO-5851: oldValue is read from this clone, and a clone 36 commits behind
  // wrote null for posters that had landed an hour earlier. Bring it current
  // first; a dirty or diverged clone is refused rather than read.
  const ownData = path.join(ROOT, 'data');
  if (path.resolve(coreDataDir) !== path.resolve(ownData) && fs.existsSync(path.join(coreDataDir, '.git'))) {
    const fresh = refreshDataClone(ROOT, { dataRepo: coreDataDir, memoize: false });
    if (fresh.status === 'unsafe') { console.error(`REFUSED core data clone ${coreDataDir} is behind origin and cannot be fast-forwarded: ${fresh.detail}`); return 1; }
    if (fresh.status === 'unknown') console.error(`warning: could not check ${coreDataDir} against origin (${fresh.detail}); oldValues may be stale`);
    else if (fresh.status === 'fast-forwarded') console.log(`core data clone fast-forwarded to origin/main`);
  }
  const reviewTextsDir = pickReviewTextsTree();
  const cache = {};
  const loadData = (file) => (cache[file] ||= JSON.parse(fs.readFileSync(path.join(coreDataDir, file), 'utf8')));
  const readReview = (rel) => { try { return JSON.parse(fs.readFileSync(path.join(reviewTextsDir, rel), 'utf8')); } catch { return null; } };
  console.log(`core data: ${coreDataDir}\nreview texts: ${reviewTextsDir}`);

  const { actions, problems } = completeActions(raw, { loadData, readReview });
  if (problems.length) { for (const p of problems) console.error(`  REFUSED ${p}`); return 1; }

  const plans = buildPlans(id, summary, actions, { risk: get('risk') || 'low' });
  const files = plans.map((p) => path.join(PLAN_DIR, `${p.name}.json`));
  const existing = files.filter((f) => fs.existsSync(f));
  // --force re-writes a plan still being drafted; an executed plan is the audit
  // record of what was applied, so it is never overwritten (BRO-4490: a second
  // round nearly replaced the applied bro-4490.json). Use a new --id (bro-N-2).
  const executed = executedPlanFiles(existing);
  if (executed.length && !dryRun) {
    console.error(`Already executed: ${executed.map((f) => path.relative(ROOT, f)).join(', ')} (pick a new --id, e.g. ${id}-2)`);
    return 2;
  }
  if (existing.length && !argv.includes('--force') && !dryRun) {
    console.error(`Already exists: ${existing.map((f) => path.relative(ROOT, f)).join(', ')} (--force to overwrite)`);
    return 2;
  }
  const outDir = dryRun ? fs.mkdtempSync(path.join(require('os').tmpdir(), 'new-fix-plan-')) : PLAN_DIR;
  const written = plans.map((p) => {
    const f = path.join(outDir, `${p.name}.json`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(p.plan, null, 2) + '\n');
    return f;
  });
  if (dryRun) for (const p of plans) console.log(JSON.stringify(p.plan, null, 2));

  const { failed } = preflight(written, { reviewTextsDir, coreDataDir });
  if (dryRun) { fs.rmSync(outDir, { recursive: true, force: true }); return failed ? 1 : 0; }
  if (failed) { console.error(`Preflight failed; ${written.length} file(s) written but not staged. Fix and re-run with --force.`); return 1; }

  execFileSync('git', ['add', '-f', ...written], { cwd: ROOT, stdio: 'inherit' });
  console.log(`\nStaged ${written.map((f) => path.relative(ROOT, f)).join(', ')}. Land it, then apply each plan:`);
  for (const p of plans) {
    console.log(`  node scripts/cloud-dispatch.js execute-approved-fix.yml -f issue_number=${p.name} -f plan_id=${p.plan.planId} -f mode=apply --wait`);
  }
  return 0;
}

// Statuses execute-approved-fix.js leaves on a plan that ran (or was turned
// down): the record of what reached the private repos. 'validation-failed'
// changed nothing, so a --force repair of it stays allowed.
const EXECUTED_PLAN_STATUSES = new Set(['applied', 'partial', 'rejected']);

/** Plan files that already ran: never overwritten, even with --force. */
function executedPlanFiles(files) {
  return files.filter((f) => {
    try { return EXECUTED_PLAN_STATUSES.has(JSON.parse(fs.readFileSync(f, 'utf8')).status); } catch { return false; }
  });
}

module.exports = { executedPlanFiles, actionsFromArgs, completeActions, buildPlans, splitName, parseDotted };

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (require('./lib/cli-help').hasHelpFlag(argv)) { console.log(USAGE); process.exit(0); }
  process.exit(main(argv));
}
