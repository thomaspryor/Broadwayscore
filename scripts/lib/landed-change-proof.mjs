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

const EXEMPT_RE = /(?:^|\/)(?:tests?|__tests__|fixtures?|__snapshots__)\/|\.(?:test|spec)\.\w+$|\.(?:md|txt|png|jpe?g|webp|gif|svg|ico|csv)$|^(?:data|memory|cloud-memory|docs|\.claude\/commands|\.claude\/skills|review-texts)\//;
const HOOK_RE = /^\.claude\/(?:hooks|settings)|^\.husky\/|^scripts\/lib\/[\w-]*(?:-stop|-gate|review-gate)\.m?js$|^\.claude\/[\w-]+\.(?:sh|mjs|js|json)$/;
const SRC_RE = /^(?:src|public)\/|^(?:next\.config\.js|tailwind\.config\.\w+|postcss\.config\.\w+|tsconfig\.json|package(?:-lock)?\.json|vercel\.json|middleware\.ts)$/;

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
  if (libIndex.has(f)) return { kind: 'lib', workflows: libIndex.get(f) };
  if (HOOK_RE.test(f)) return { kind: 'hook', workflows: [] };
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
export function fileVerdict(file, commitSha, { cls, runs, runsOk = true, incomplete = new Set(), posOf, isDeployed = () => null }) {
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
  const wfs = new Set(workflows);
  const mine = (runs || []).filter((r) => wfs.has(r.workflow) && posOf.has(r.headSha) && posOf.get(r.headSha) >= at);
  const ok = mine.filter((r) => r.conclusion === 'success');
  const manual = ok.find((r) => r.event !== 'schedule');
  if (manual) return { file, kind, verdict: 'proven', workflows, run: manual.id ?? null, event: manual.event };
  if (ok.length) return { file, kind, verdict: 'waiting', workflows, run: ok[0].id ?? null, event: 'schedule' };
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
    if (r.landedDay === dayMinus(r.auditDay, 1)) return true;
    return !last.has(r.sha) || last.get(r.sha).verdict !== r.verdict;
  });
}

/** PURE. Counts by verdict and by source, over code commits (exempt-only commits are not changes that went live). */
export function summarize(rows) {
  const code = rows.filter((r) => r.verdict !== 'exempt');
  const by = (k) => code.reduce((m, r) => ((m[r[k]] = (m[r[k]] || 0) + 1), m), {});
  return { total: code.length, verdicts: by('verdict'), sources: by('source') };
}

/**
 * PURE. The owner's one plain line. Reads the latest audit's rows for commits that landed the day before it ran.
 * -> string | null (null when there is no audit to report).
 */
export function digestLine(ledgerRows, { now = new Date(), maxAgeH = 48 } = {}) {
  if (!ledgerRows.length) return null;
  const latest = ledgerRows.reduce((a, r) => (r.auditDay > a ? r.auditDay : a), '');
  const ageH = (now.getTime() - Date.parse(`${latest}T00:00:00Z`)) / 36e5;
  if (!(ageH < maxAgeH)) return `Changes proven running: not measured this morning (the check last ran ${latest}).`;
  const day = dayMinus(latest, 1);
  const s = summarize(ledgerRows.filter((r) => r.auditDay === latest && r.landedDay === day));
  if (!s.total) return `Yesterday no code changes went live.`;
  const v = s.verdicts;
  const proven = (v.proven || 0) + (v.deployed || 0);
  const parts = [`${proven} proven running`];
  if (v.waiting) parts.push(`${v.waiting} only ran on their schedule`);
  if (v.failed) parts.push(`${v.failed} ran and failed`);
  const selfRun = ledgerRows.filter((r) => r.auditDay === latest && r.landedDay === day && r.verdict === 'not_run' && r.safeRun?.ok).length;
  if (v.not_run) parts.push(`${v.not_run} not run since landing${selfRun ? ` (${selfRun} run by the check itself and passed)` : ''}`);
  if (v.no_signal) parts.push(`${v.no_signal} with nothing that runs them on their own`);
  if (v.unknown) parts.push(`${v.unknown} could not be checked`);
  return `Yesterday ${s.total} code change${s.total === 1 ? '' : 's'} went live: ${parts.join(', ')}.`;
}

/**
 * PURE. The command the audit may run itself to prove a not-run script, or null. Only commands the vetted read-only
 * safe-form gate accepts (autonomous-triage-core.js explainUnsafeCheckCommand, re-verified by
 * audit-safe-form-allowlist.js): no word lists, no --dry-run trust (BRO-7790 plan review P0).
 */
export function safeRunCommand(file, explain) {
  if (!/^scripts\/[\w./-]+\.(?:m?js|cjs)$/.test(file)) return null;
  const cmd = `node ${file}`;
  try { return explain(cmd)?.ok ? cmd : null; } catch { return null; }
}

// Workflows the audit may dispatch to prove a change: no spend, no email, no data writes (CLAUDE.md sections 8, 17).
// Empty until each entry is checked by hand.
export const DISPATCH_ALLOWLIST = new Set([]);

/** PURE. Rows that still need someone: failed / not_run code, after the audit's own safe runs. */
export function needsFollowUp(rows) {
  // Only commits that have had a full day: a daily cron script that landed last evening has not had its run yet
  // (plan review: timing false misses). Each commit lands in exactly one day's card (landedDay = auditDay - 2).
  return rows.filter((r) => r.landedDay === dayMinus(r.auditDay, 2)
    && (r.verdict === 'failed' || r.verdict === 'not_run') && !(r.safeRun && r.safeRun.ok));
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
    `VERIFY: node scripts/landed-change-proof-audit.js --dry-run --days=1 --sha=${rows.map((r) => r.sha.slice(0, 10)).slice(0, 10).join(',')} --expect-proven`,
  ].join('\n');
}
