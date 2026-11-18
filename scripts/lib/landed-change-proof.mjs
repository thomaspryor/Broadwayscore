// BRO-7790: daily landed-change proof audit. Every code commit on main (cloud, Mac, Codex, bots) is checked against
// evidence the session did not produce itself: an Actions run that contains the commit and runs the changed file, or a
// READY Vercel production deploy that contains it. Session Stop gates (live-run-stop.mjs) only see cloud sessions and
// grade their own homework; this audit is the independent denominator.
//
// Pure functions only. The CLI (scripts/landed-change-proof-audit.js) does the git / GitHub / Vercel I/O.
// Owner number: digestLine(), folded into the morning digest (send-morning-digest.js).
//
// Verdicts, worst first (a commit takes the worst verdict of its non-exempt files):
//   failed     a run of a workflow that runs the file, containing the commit, failed and none succeeded
//   not_run    a workflow runs the file, and no run containing the commit has finished since it landed
//   unknown    the evidence could not be read (runs API / deploy lookup failed). Missing data is never 'proven'.
//   no_signal  code nothing independent runs (hooks, gates, scripts no workflow runs)
//   waiting    only scheduled (cron) runs succeeded: it ran, but nobody dispatched it on purpose
//   deployed   site code inside the live READY production deploy
//   proven     a non-cron run containing the commit, of a workflow that runs the file, succeeded
//   exempt     tests, docs, data, memory
import { workflowScriptIndex } from './live-run-stop.mjs';
import { isUsageOnlyOutput } from './usage-output.mjs';

export { workflowScriptIndex, isUsageOnlyOutput };
export const VERDICT_ORDER = ['failed', 'not_run', 'unknown', 'no_signal', 'waiting', 'deployed', 'proven', 'exempt'];
export const LEDGER_PATH = 'data/audit/landed-change-proof.jsonl';

/** PURE. Where a commit came from: 'cloud' | 'codex' | 'mac' | 'none'. */
export function sourceOf({ authorName = '', authorEmail = '', body = '' } = {}) {
  if (/^Claude-Session:\s*\S/m.test(body)) return 'cloud';
  // Codex runner commits carry no trailer; the author and the body line "Worked by the daily Codex runner" mark them.
  if (/codex/i.test(authorEmail) || /codex/i.test(authorName) || /^Codex[\w-]*:\s*\S/m.test(body) || /\bCodex runner\b/i.test(body)) return 'codex';
  // Cloud sessions commit as Claude <noreply@anthropic.com>; a few land without the Claude-Session trailer.
  if (/noreply@anthropic\.com/i.test(authorEmail) && /^Claude$/i.test(authorName)) return 'cloud';
  if (/\[bot\]|github-actions|^GitHub Action$/i.test(authorName) || /noreply@github\.com|action@github\.com/i.test(authorEmail)) return 'none';
  // Mac sessions and the owner commit under the owner's git identity (Claude on the Mac adds a Co-Authored-By trailer).
  return 'mac';
}

const EXEMPT_RE = /(?:^|\/)(?:tests?|__tests__|fixtures?|__snapshots__)\/|\.(?:test|spec)\.\w+$|\.(?:md|txt|png|jpe?g|webp|gif|svg|ico|csv)$|^(?:data|public|memory|cloud-memory|docs|\.claude\/commands|\.claude\/skills|review-texts)\//;
const HOOK_RE = /^\.claude\/(?:hooks|settings)|^\.husky\/|^scripts\/lib\/[\w-]*(?:-stop|-gate|review-gate|review-coverage|transcript-scan)\.m?js$|^\.claude\/[\w-]+\.(?:sh|mjs|js|json)$/;
const SRC_RE = /^src\/|^(?:next\.config\.js|tailwind\.config\.\w+|postcss\.config\.\w+|tsconfig\.json|package(?:-lock)?\.json|vercel\.json|middleware\.ts)$/;

/**
 * PURE. Classify one changed path. -> { kind: 'workflow'|'script'|'lib'|'src'|'hook'|'other'|'exempt', workflows: [] }
 * index: workflowScriptIndex(); libIndex: libWorkflowIndex().
 */
export function classifyPath(file, { index = new Map(), libIndex = new Map() } = {}) {
  const f = String(file || '');
  const wf = f.match(/^\.github\/workflows\/([^/]+\.ya?ml)$/);
  if (wf) return { kind: 'workflow', workflows: [wf[1]] };
  if (index.has(f)) return { kind: 'script', workflows: index.get(f) };
  if (EXEMPT_RE.test(f)) return { kind: 'exempt', workflows: [] };
  if (HOOK_RE.test(f)) return { kind: 'hook', workflows: [] };
  if (libIndex.has(f)) return { kind: 'lib', workflows: libIndex.get(f) };
  if (SRC_RE.test(f)) return { kind: 'src', workflows: [] };
  return { kind: 'other', workflows: [] };
}

const IMPORT_RE = /(?:require\(\s*|from\s+|import\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
/** PURE. Relative imports in a source text, resolved against its repo path (extension added when missing). */
export function relativeImports(fromPath, text, exists = () => true) {
  const dir = fromPath.split('/').slice(0, -1);
  const out = new Set();
  for (const m of String(text || '').matchAll(IMPORT_RE)) {
    const parts = [...dir];
    for (const seg of m[1].split('/')) { if (seg === '..') parts.pop(); else if (seg !== '.') parts.push(seg); }
    const base = parts.join('/');
    const cand = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}.ts`, `${base}/index.js`].find((c) => /\.\w+$/.test(c) && exists(c));
    if (cand) out.add(cand);
  }
  return [...out];
}

/** PURE. lib path -> [workflows] for files a workflow script imports, 2 levels deep (same depth BRO-7738 measured). */
export function libWorkflowIndex(index, readFile, exists = () => true) {
  const out = new Map();
  const add = (lib, wfs) => { if (index.has(lib)) return; const s = out.get(lib) || new Set(); wfs.forEach((w) => s.add(w)); out.set(lib, s); };
  for (const [script, wfs] of index) {
    let level = [script];
    for (let depth = 0; depth < 2; depth++) {
      const next = [];
      for (const f of level) {
        let text = '';
        try { text = readFile(f) || ''; } catch { continue; }
        for (const dep of relativeImports(f, text, exists)) { add(dep, wfs); next.push(dep); }
      }
      level = next;
    }
  }
  return new Map([...out].map(([k, v]) => [k, [...v]]));
}

/**
 * PURE. Evidence for one file of a landed commit.
 * runs: [{ workflow, event, conclusion, headSha }] (completed runs on main); posOf: Map sha -> position on main
 * (higher = newer). A run contains the commit when its head is at or after the commit on main's linear history.
 * isDeployed(sha) -> true | false | null (null = could not tell).
 */
export function fileVerdict(file, commitSha, { cls, runs, runsFor = null, runsOk = true, incomplete = new Set(), posOf, headPos = posOf, isDeployed = () => null, ranWork = () => true }) {
  const { kind, workflows } = cls;
  if (kind === 'exempt') return { file, kind, verdict: 'exempt' };
  if (kind === 'hook' || kind === 'other') return { file, kind, verdict: 'no_signal' };
  if (kind === 'src') {
    const d = isDeployed(commitSha);
    return { file, kind, verdict: d === true ? 'deployed' : d === false ? 'not_run' : 'unknown' };
  }
  if (!runsOk) return { file, kind, verdict: 'unknown', workflows };
  const at = posOf.get(commitSha);
  if (at === undefined) return { file, kind, verdict: 'unknown', workflows };
  // runsFor(workflow) may fetch lazily (the CLI's API budget): stop at the first workflow with a non-cron green run.
  const listFor = runsFor || ((w) => (runs || []).filter((r) => r.workflow === w));
  // Run heads must be on main's first-parent line (headPos): a side commit a merge brought in shares the merge's
  // position, so a run on one branch commit would otherwise 'contain' a later commit of the same branch.
  const contains = (r) => headPos.has(r.headSha) && headPos.get(r.headSha) >= at;
  const mine = [];
  for (const w of workflows) {
    mine.push(...listFor(w).filter(contains));
    if (mine.some((r) => r.conclusion === 'success' && r.event !== 'schedule' && ranWork(r) !== false)) break;
  }
  // ranWork(run): false when every job of a green run was skipped (an if: or path filter ran nothing). The CLI reads
  // the run's jobs; step-level skips inside a job that ran are not visible to this check.
  // Lazy: ranWork may cost an API call, so stop at the first run that did work.
  const green = mine.filter((r) => r.conclusion === 'success');
  const manual = green.filter((r) => r.event !== 'schedule').find((r) => ranWork(r) !== false);
  if (manual) return { file, kind, verdict: 'proven', workflows, run: manual.id ?? null, event: manual.event };
  const sched = green.filter((r) => r.event === 'schedule').find((r) => ranWork(r) !== false);
  if (sched) return { file, kind, verdict: 'waiting', workflows, run: sched.id ?? null, event: 'schedule' };
  // A workflow whose run list could not be read in full (API error, or more runs than one query returns) never
  // yields not_run or failed: the missing page might hold the success.
  if (workflows.some((w) => incomplete.has(w))) return { file, kind, verdict: 'unknown', workflows };
  const bad = mine.find((r) => r.conclusion === 'failure' || r.conclusion === 'timed_out');
  if (bad) return { file, kind, verdict: 'failed', workflows, run: bad.id ?? null, event: bad.event };
  return { file, kind, verdict: 'not_run', workflows };
}

export const worst = (verdicts) => verdicts.reduce((a, v) => (VERDICT_ORDER.indexOf(v) < VERDICT_ORDER.indexOf(a) ? v : a), 'exempt');

/**
 * PURE. One ledger row per commit. commit: { sha, landedAt, authorName, authorEmail, body, subject, files: [] }.
 */
export function auditCommit(commit, ctx) {
  const { index = new Map(), libIndex = new Map(), auditDay } = ctx;
  const files = (commit.files || []).map((f) => fileVerdict(f, commit.sha, { ...ctx, cls: classifyPath(f, { index, libIndex }) }));
  const verdict = worst(files.map((f) => f.verdict));
  return {
    auditDay,
    sha: commit.sha,
    landedAt: commit.landedAt,
    landedDay: String(commit.landedAt || '').slice(0, 10),
    source: sourceOf(commit),
    session: (String(commit.body || '').match(/^Claude-Session:\s*(\S+)/m) || [])[1] || null,
    subject: String(commit.subject || '').slice(0, 120),
    verdict,
    files: files.filter((f) => f.verdict !== 'exempt').slice(0, 25),
  };
}

/** PURE. YYYY-MM-DD n days before day. */
export const dayMinus = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) - n * 864e5).toISOString().slice(0, 10);

/**
 * PURE. Rows to append. The ledger is append-only (never rewrite rows) and kept small: a commit that landed the day
 * before the audit always gets a row (the digest reads it); an older commit in the window gets one only when its
 * verdict changed since its last row. Never two rows for one sha on one audit day.
 */
export function newRows(existing, rows) {
  const seen = new Set(existing.map((r) => `${r.auditDay}|${r.sha}`));
  const last = new Map();
  for (const r of existing) if (!last.has(r.sha) || r.auditDay >= last.get(r.sha).auditDay) last.set(r.sha, r);
  return rows.filter((r) => {
    if (seen.has(`${r.auditDay}|${r.sha}`)) return false;
    if (r.marker || r.card) return true; // a carded row must reach the ledger, or the next night cards it again
    // A safe run or dispatch is the point of this audit and the dedupe for the next one: it must reach the ledger.
    if ((r.files || []).some((f) => f.safeRun || f.dispatch)) return true;
    if (r.landedDay === dayMinus(r.auditDay, 1)) return true;
    return !last.has(r.sha) || last.get(r.sha).verdict !== r.verdict;
  });
}

/** PURE. The row every audit run appends (even with no code commits), so the digest can tell "no changes" from "did not run". */
export const runMarker = (auditDay, extra = {}) => ({ auditDay, sha: '_run', landedDay: '', verdict: 'exempt', marker: 'audit-ran', ...extra });

/** PURE. Counts by verdict and by source, over code commits (exempt-only commits are not changes that went live). */
export function summarize(rows) {
  const code = rows.filter((r) => r.verdict !== 'exempt' && !r.marker);
  const by = (k) => code.reduce((m, r) => ((m[r[k]] = (m[r[k]] || 0) + 1), m), {});
  return { total: code.length, verdicts: by('verdict'), sources: by('source') };
}

/**
 * PURE. The owner's one plain line. Reads the latest audit's rows for commits that landed the day before it ran.
 * -> string | null (null when there is no audit to report).
 */
export function digestLine(ledgerRows, { now = new Date() } = {}) {
  if (!ledgerRows.length) return null;
  const latest = ledgerRows.reduce((a, r) => (r.auditDay > a ? r.auditDay : a), '');
  // Only today's audit describes "yesterday": an older one would print the day before yesterday as yesterday.
  if (latest !== now.toISOString().slice(0, 10)) return `Changes proven running: not measured this morning (the check last ran ${latest}).`;
  const day = dayMinus(latest, 1);
  const s = summarize(ledgerRows.filter((r) => r.auditDay === latest && r.landedDay === day));
  if (!s.total) return `Yesterday no code changes went live.`;
  const v = s.verdicts;
  const proven = (v.proven || 0) + (v.deployed || 0);
  const parts = [`${proven} proven running`];
  if (v.waiting) parts.push(`${v.waiting} only ran on their schedule`);
  if (v.failed) parts.push(`${v.failed} ran and failed`);
  const selfRun = ledgerRows.filter((r) => r.auditDay === latest && r.landedDay === day && r.verdict === 'not_run'
    && (r.files || []).some((f) => f.safeRun?.ok)).length;
  if (v.not_run) parts.push(`${v.not_run} not run since landing${selfRun ? ` (${selfRun} run by the check itself and passed)` : ''}`);
  if (v.no_signal) parts.push(`${v.no_signal} with nothing that runs them on their own`);
  if (v.unknown) parts.push(`${v.unknown} could not be checked`);
  return `Yesterday ${s.total} code change${s.total === 1 ? '' : 's'} went live: ${parts.join(', ')}.`;
}

/**
 * PURE. The command the audit may run itself to prove a not-run script, or null. A bare `node <file>` is never
 * accepted by the vetted read-only safe-form gate (autonomous-triage-core.js explainUnsafeCheckCommand, kind:shape), so
 * the proof is the file's own unit test: colocated `<name>.test.{mjs,js}`, then `scripts/tests/<name>.test.*`, then
 * `tests/unit/<name>.test.mjs`, run as `node --test <test>`. Only a test that exists and that the gate accepts is
 * returned; a script with no test gets null (the card says so). BRO-7796: the old `node <file>` mapping was dead.
 * exists(path) -> boolean (repo-relative); defaults to "nothing exists" so a missing oracle never invents a command.
 */
export function safeRunCommand(file, explain, exists = () => false) {
  const m = /^(scripts\/(?:[\w.-]+\/)*)([\w.-]+?)\.(?:m?js|cjs)$/.exec(file);
  if (!m || /\.test\.[mc]?js$/.test(file)) return null;
  const [, dir, base] = m;
  const candidates = [];
  for (const ext of ['mjs', 'js']) candidates.push(`${dir}${base}.test.${ext}`);
  for (const ext of ['mjs', 'js']) candidates.push(`scripts/tests/${base}.test.${ext}`);
  candidates.push(`tests/unit/${base}.test.mjs`);
  for (const t of candidates) {
    let present = false;
    try { present = !!exists(t); } catch { present = false; }
    if (!present) continue;
    const cmd = `node --test ${t}`;
    try { if (explain(cmd)?.ok) return cmd; } catch { /* gate error: never run anything */ }
  }
  return null;
}

// Workflows the audit may dispatch to prove a change: no spend, no email, no data writes (CLAUDE.md sections 8, 17).
// Each entry was read by hand (BRO-7796, second-opinion reviewed): contents: read only, no push step, no secret that
// spends or emails (notify-failure at severity warning posts nothing but a step summary), last 6 runs green.
//   check-cutoff-freshness.yml    node scripts/check-cutoff-freshness.js: tsc into a tmp dir, reads files
//   check-linear-drain-health.yml linear-drain-parked.js --dry-run (no ledger, no dispatch) + a read-only Linear query
// When unsure, leave a workflow out. The dispatch job in landed-change-proof.yml repeats this list (it must not trust
// the audit's output alone); tests/unit/landed-change-proof-allowlist.test.mjs fails when the two drift apart or an
// entry stops being read-only.
export const DISPATCH_ALLOWLIST = new Set(['check-cutoff-freshness.yml']);
export const DISPATCH_CAP = 3;

/**
 * PURE. Which allowlisted workflows to dispatch tonight to prove not-run files. rows: this night's audit rows;
 * existing: ledger rows. One dispatch per workflow per night (any green non-cron run of it proves every file it runs),
 * never for a sha that an earlier ledger row already requested, at most `cap`.
 * -> [{ workflow, shas: [sha], files: [{ sha, file }] }]
 */
export function dispatchPlan(rows, existing = [], { cap = DISPATCH_CAP, allow = DISPATCH_ALLOWLIST } = {}) {
  const asked = new Set(existing.filter((r) => (r.files || []).some((f) => f.dispatch?.requested)).map((r) => r.sha));
  const plan = new Map();
  for (const r of rows) {
    if (r.verdict !== 'not_run' || asked.has(r.sha)) continue;
    for (const f of (r.files || []).filter((x) => x.verdict === 'not_run')) {
      const wf = (f.workflows || []).find((w) => allow.has(w));
      if (!wf) continue;
      if (!plan.has(wf) && plan.size >= cap) continue;
      const e = plan.get(wf) || { workflow: wf, shas: [], files: [] };
      if (!e.shas.includes(r.sha)) e.shas.push(r.sha);
      e.files.push({ sha: r.sha, file: f.file });
      plan.set(wf, e);
    }
  }
  return [...plan.values()];
}

/** PURE. Rows that still need someone: failed / not_run code, after the audit's own safe runs. */
export function needsFollowUp(rows, existing = []) {
  // Only commits that have had a full day: a daily cron script that landed last evening has not had its run yet
  // (plan review: timing false misses). A commit is carded once: any earlier ledger row with a card skips it, and a
  // missed audit night is caught up by the next one (landedDay <= auditDay - 2, inside the window).
  const carded = new Set(existing.filter((r) => r.card).map((r) => r.sha));
  const selfProven = (r) => {
    // A file the audit ran itself and passed, or whose proving workflow it dispatched tonight, is not a miss yet:
    // the next night reads the run (a dispatch that never lands shows up again as not_run and is carded then).
    const open = (r.files || []).filter((f) => f.verdict === 'not_run');
    return r.verdict === 'not_run' && open.length > 0 && open.every((f) => (f.safeRun && f.safeRun.ok) || f.dispatch?.requested);
  };
  return rows.filter((r) => r.landedDay && r.landedDay <= dayMinus(r.auditDay, 2) && !carded.has(r.sha)
    && (r.verdict === 'failed' || r.verdict === 'not_run') && !selfProven(r));
}

/** PURE. Body of the one batched card per day. Cloud-session misses name the session check that should have caught them. */
export function cardBody(rows, { auditDay }) {
  const fmt = (r) => `- ${r.sha.slice(0, 10)} [${r.source}] ${r.verdict}: ${r.subject} (${r.files.filter((f) => f.verdict === r.verdict).map((f) => f.file).slice(0, 4).join(', ')})`;
  const cloud = rows.filter((r) => r.source === 'cloud');
  return [
    `Landed-change proof audit ${auditDay} (BRO-7790): ${rows.length} code change(s) on main with no independent run evidence, or a failed run.`,
    '',
    '## Changes',
    ...rows.slice(0, 60).map(fmt),
    '',
    '## Cloud-session misses (the session Stop check scripts/lib/live-run-stop.mjs should have asked for a run)',
    ...(cloud.length ? cloud.slice(0, 30).map((r) => `- ${r.sha.slice(0, 10)} ${r.session || ''}: ${r.files.map((f) => f.file).slice(0, 3).join(', ')}`) : ['- none']),
    '',
    '## What to do',
    'For each change: run it for real now (a --dry-run counts, --help does not), or dispatch the workflow that runs it and read the run. If it failed, fix it.',
    '',
    '## Acceptance criteria',
    `VERIFY: node scripts/landed-change-proof-audit.js --dry-run --sha=${rows.map((r) => r.sha.slice(0, 10)).slice(0, 10).join(',')} --expect-proven`,
  ].join('\n');
}
