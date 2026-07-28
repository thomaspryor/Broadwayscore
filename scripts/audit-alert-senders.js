#!/usr/bin/env node
/**
 * Sender inventory for the alert-noise regression audit (card #475).
 *
 * Mechanically scans scripts/ + .github/workflows/ for every call site that
 * can page the owner by email, and classifies each one:
 *   - 'router'  — goes through scripts/lib/owner-alert-router.js (routeAlert),
 *                 which enforces the ACTION-only bar + per-condition dedup.
 *   - 'digest'  — an owner-confirmed scheduled digest that hits Resend
 *                 directly (send-daily-digest.js, autonomous-email.js, etc.
 *                 — the KEEP list in lint-resend-calls.js's ALLOWLIST).
 *   - 'direct'  — calls sendAlert(...) with an emailable severity directly,
 *                 bypassing the router's dedup/actionability gate. This is
 *                 the bypass class the card is about — each one needs either
 *                 migration onto routeAlert() or an explicit reviewed
 *                 justification (the 4 real-time-critical workflows named in
 *                 CLAUDE.md: vercel-deploy, opening-night-broadcast,
 *                 opening-night-poller, data-health-check use their own
 *                 notify-failure severity:'critical' path, tracked
 *                 separately, not scanned here).
 *
 * Modes:
 *   node scripts/audit-alert-senders.js            inventory snapshot (writes
 *                                                  data/audit/alert-sender-inventory.json)
 *   node scripts/audit-alert-senders.js --json     same, JSON to stdout
 *   node scripts/audit-alert-senders.js --check    CI lint gate (read-only):
 *                                                  fail on any direct sender in a file
 *                                                  not in scripts/.alert-sender-baseline.json,
 *                                                  or a baselined file's count growing.
 *                                                  Shrinking counts warn (run
 *                                                  --update-baseline), never fail.
 *   node scripts/audit-alert-senders.js --update-baseline
 *                                                  regenerate the baseline from current
 *                                                  direct findings (review the diff!)
 *
 * The baseline is a {relPath: directCallCount} map, NOT a flat file list (its
 * sibling gate, audit-help-flag-safety.js's baseline, is per-file boolean; this
 * one needs counts because audit-t1-silent-gaps.js has 2 sites and a new bypass
 * added to an already-baselined file must still fail). Never stores line
 * numbers — they churn. Baselined debt is tracked: audit-t1-silent-gaps.js
 * drain is card #531; opening-night-broadcast.yml + opening-night-poller.js are
 * the two permanent real-time-critical senders (CLAUDE.md rule 14's critical
 * workflows) and stay in the baseline deliberately.
 *
 * Known accepted limitations:
 * - Within a baselined file, swapping one direct call for a different one
 *   keeps the count flat and passes — per-call-site fingerprints would churn
 *   on every refactor and were deliberately rejected. The gate's claim is
 *   "no NEW files and no per-file growth", same trust model as
 *   audit-help-flag-safety.js's baseline.
 * - Severity-variable resolution is scope-blind: an outer
 *   `const level = 'warning'` shadowed by a same-named function parameter in
 *   the ±8/10-line window resolves to the outer literal and can skip a real
 *   sender. Scope tracking is an AST job, out of reach for this regex gate;
 *   the ambiguity guard (all assignments must agree on ONE literal) covers
 *   the realistic reassignment case, and shadowed severity idents around a
 *   sendAlert call don't exist in this corpus today.
 *
 * Second check (card #616): routeAlert()'s disposition='human' path can now
 * silently downgrade to result.action==='digest' (the page-worthy allowlist
 * gate, card #611) — a caller that requested 'human' and branches on
 * result.action but was written before #611 may only handle 'silent'/'human'
 * and treat a downgraded 'digest' result as "nobody was told", double-firing
 * a fallback notifier or getting stuck retrying forever. For every
 * routeAlert(...) call site with disposition:'human', if the caller's
 * result-handling code inspects `<resultVar>.action` (via a same-line
 * `const x = await routeAlert(` assignment, a reassignment to a pre-declared
 * var, a destructured `const { action } = await routeAlert(`, or a later
 * `.then((x) => ...)`), that same post-call code must also mention the
 * literal string "digest" — otherwise it's flagged as a
 * 'human-caller-ignores-digest' finding. Baselined the same way as the
 * direct-sender gate above, in scripts/.human-caller-digest-baseline.json.
 * Known limitations (both regex-inherent, same trust model as the rest of
 * this gate):
 * - A call site that stores `result.action` into a field nobody branches on
 *   (informational logging only) still flags — annotate with a comment
 *   naming why (see dispatch-orphan-rescore-requeue.js's `alertRouted` field
 *   for the pattern) rather than trying to make the gate infer intent.
 * - Calls routed through a local wrapper/alias (an injectable `route =
 *   routeAlert` default param, or a `function alert(opts) { return
 *   routeAlert(opts); }` helper — scripts/lib/opening-night-sla.js and
 *   scripts/opening-night-monitor-launch.js both do this) are now resolved
 *   mechanically by findWrapperNames() and folded into every check in this
 *   file, not just this one. A wrapper whose own body is more than ~300
 *   chars, or an alias assigned via anything other than a literal default
 *   param / thin pass-through, still evades detection — true AST-level
 *   alias resolution is out of reach for a regex gate.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `audit-alert-senders.js — inventory + CI gate for direct sendAlert(email:true) bypasses
and routeAlert(disposition:'human') callers that ignore a downgraded 'digest' result.

Usage:
  node scripts/audit-alert-senders.js                    inventory snapshot (writes data/audit/)
  node scripts/audit-alert-senders.js --json             same, JSON to stdout
  node scripts/audit-alert-senders.js --check            CI gate: fail on new/grown direct senders
                                                          or new/grown human-caller-ignores-digest sites
  node scripts/audit-alert-senders.js --update-baseline  regenerate both baseline files
  node scripts/audit-alert-senders.js --help, -h         print this usage and exit
`;

const REPO_ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['scripts', '.github/workflows'];
const SCAN_EXTENSIONS = new Set(['.js', '.mjs', '.yml', '.yaml']);
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', '.next', 'dist', 'build']);

// Scheduled digests + already-reviewed direct Resend callers (owner
// email-consolidation plan 2026-07-21/22) — not part of the ad-hoc-alert
// bypass class this audit targets. Mirrors the KEEP + grandfathered sections
// of lint-resend-calls.js's ALLOWLIST; kept as a separate list here (rather
// than importing it) so this script's classification doesn't silently change
// if that lint's allowlist is edited for an unrelated reason.
const DIGEST_OR_REVIEWED = new Set([
  'scripts/send-daily-digest.js',
  'scripts/send-opening-digest.js',
  'scripts/reddit-engagement-digest.js',
  'scripts/fantasy-weekly-email.js',
  'scripts/generate-remediation-plan.js',
  'scripts/lib/brand-mention-email.js',
  'scripts/autonomous-email.js',
  'scripts/lib/discord-notify.js',
  'scripts/lib/owner-alert-router.js',
]);

function walk(dir, files) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (SCAN_EXTENSIONS.has(path.extname(entry.name))) files.push(full);
  }
}

// Card #616: a routeAlert(...) call site requesting disposition:'human' may
// get silently downgraded to result.action==='digest' by the page-worthy
// allowlist gate (card #611). A caller written before #611 that branches on
// result.action but only accounts for 'silent'/'human' will misread a
// downgraded 'digest' result as "the owner was never told" — see the real
// regressions ship-check caught in opening-night-broadcast.yml and
// audit-show-review-gap.js (card #611 commit d4128a2024a).
//
// Best-effort, not an AST parse. Two adversarial-review fixes shape the
// window math below (both proved as live false positives/negatives on this
// corpus, not hypotheticals):
// - A single fixed-size window from the call's OPENING line burns budget on
//   the call's own (sometimes long) argument list, then bleeds into the
//   NEXT unrelated routeAlert()/sendAlert() call if one follows soon after —
//   either hides a real finding (digest mention borrowed from later code) or
//   fabricates one (.action usage borrowed from later code). Fixed by
//   locating the call's own closing `});` first (findCallBodyEnd) and
//   scoping "does this caller inspect .action" / "does it mention digest"
//   to the POST-call portion only, capped at the next alert call site.
// - "digest" search must exclude the call's OWN argument lines — a
//   conditionKey or title literally containing the word "digest" (e.g.
//   'daily-digest-missing') would silence a real finding if searched.
const CALL_BODY_MAX_LINES = 40; // generous cap on one routeAlert({...}) call's own arg list
const POST_CALL_WINDOW = 20; // lines after the call closes, for result-handling inspection

// A line whose parens are already balanced (net 0 or negative unclosed opens)
// is a complete, single-line call — e.g. a wrapper's own pass-through
// `return await routeAlert(opts);`, as opposed to the usual multi-line
// `routeAlert({` object-literal call this file's real callers all use.
function parensBalanced(line) {
  let depth = 0;
  for (const ch of line) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
  }
  return depth <= 0;
}

// Locates the line where a routeAlert({...}) call's argument object closes
// (first line after the call opens whose trimmed text starts with '})'),
// capped at CALL_BODY_MAX_LINES so a malformed call can't scan past it. A
// call that's already balanced on its own line (findCallBodyEnd's caller
// line) needs no forward scan at all — scanning anyway would walk past this
// call's own end and bleed a LATER unrelated call's disposition/digest text
// into it (real bug: a wrapper's single-line `routeAlert(opts);` pass-
// through, which has no `})` of its own to stop at).
function findCallBodyEnd(lines, callLineIdx) {
  if (parensBalanced(lines[callLineIdx])) return callLineIdx;
  const limit = Math.min(lines.length, callLineIdx + CALL_BODY_MAX_LINES);
  for (let j = callLineIdx + 1; j < limit; j++) {
    if (/^\s*\}\)/.test(lines[j])) return j;
  }
  return limit - 1;
}

// Some callers route through a local wrapper instead of calling routeAlert()
// directly, which evades every literal `routeAlert(` regex in this file (not
// just the digest check) — e.g. scripts/lib/opening-night-sla.js's
// injectable-for-tests default param (`route = routeAlert`) and
// scripts/opening-night-monitor-launch.js's thin pass-through
// (`function alert(opts) { return routeAlert(opts); }`). Detected
// mechanically (not AST): a function whose body opens with `routeAlert(`
// within ~300 chars of its own opening brace is a wrapper; a default
// parameter literally assigned `routeAlert` is the injectable-test-double
// pattern. Both resolve their own name to routeAlert for the rest of this
// scan. Known remaining gap: a wrapper that itself takes an options object
// passed through unexamined (as both real cases do) still can't have its
// disposition/digest-handling inspected AT the wrapper definition — only at
// each call site, which is what this resolves.
// Strips comments from a small extracted window before testing it for a
// routeAlert mention — an unrelated `// ...routeAlert(...)` remark inside a
// wrapper candidate's first 300 chars would otherwise misclassify a function
// that never actually calls routeAlert as a wrapper (adversarial-review find,
// card #616 follow-up).
function stripCommentsForWrapperScan(str) {
  return str.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function findWrapperNames(rawLines) {
  const src = rawLines.join('\n');
  const names = new Set();
  const funcRe = /(?:async\s+)?function\s+(\w+)\s*\([^)]*\)\s*\{([\s\S]{0,300})/g;
  let m;
  while ((m = funcRe.exec(src))) {
    if (/\brouteAlert\s*\(/.test(stripCommentsForWrapperScan(m[2]))) names.add(m[1]);
  }
  const paramRe = /\b(\w+)\s*=\s*routeAlert\s*[,}]/g;
  while ((m = paramRe.exec(src))) names.add(m[1]);
  return names;
}

function scanHumanDispositionCaller(lines, callLineIdx, relPath, rawLines, calleeAlt) {
  const bodyEnd = findCallBodyEnd(lines, callLineIdx);
  const callee = calleeAlt || 'routeAlert';

  // Post-call window starts AT the closing line (so `}).then((result) => {`
  // on the same line as the close is included) and stops at the next
  // routeAlert(/sendAlert(/wrapper( call site if one appears first.
  let windowEnd = Math.min(lines.length, bodyEnd + POST_CALL_WINDOW);
  // (?<!\.) keeps a wrapper named e.g. `alert` from matching an unrelated
  // `logger.alert(...)`/`window.alert(...)` member access and prematurely
  // truncating the window before a real .action check (adversarial-review
  // find, card #616 follow-up).
  const nextCallRe = new RegExp(`(?<!\\.)\\b(?:${callee}|sendAlert)\\s*\\(`);
  for (let j = bodyEnd + 1; j < windowEnd; j++) {
    if (nextCallRe.test(lines[j])) { windowEnd = j; break; }
  }
  const postCall = lines.slice(bodyEnd, windowEnd).join('\n');

  // Result binding, in priority order: destructured `const { action } = await
  // routeAlert(`; a plain assignment `const x = await routeAlert(` OR a
  // reassignment to a pre-declared variable `x = await routeAlert(` (no
  // const/let/var — the injectable-for-tests pattern some callers use); or a
  // later `.then((x) => ...)` promise chain.
  const assignMatch = lines[callLineIdx].match(new RegExp(`(?:(?:const|let|var)\\s+)?(\\w+)\\s*=\\s*await\\s+(?:${callee})\\s*\\(`));
  const destructureMatch = !assignMatch && lines[callLineIdx].match(new RegExp(`(?:const|let|var)\\s*\\{\\s*([^}]*)\\}\\s*=\\s*await\\s+(?:${callee})\\s*\\(`));
  const thenMatch = !assignMatch && !destructureMatch && (
    postCall.match(/\.then\s*\(\s*(?:async\s*)?\(?\s*(\w+)\s*\)?\s*=>/) ||
    postCall.match(/\.then\s*\(\s*function\s*\(\s*(\w+)\s*\)/)
  );

  let resultVar = null;
  let usesAction = false;
  if (destructureMatch) {
    const names = destructureMatch[1].split(',').map((s) => s.trim().split(':')[0].trim());
    if (names.includes('action')) {
      resultVar = '{ action }';
      usesAction = true; // destructuring `action` out IS using it
    }
  } else {
    resultVar = assignMatch ? assignMatch[1] : (thenMatch ? thenMatch[1] : null);
    if (resultVar) usesAction = new RegExp(`\\b${resultVar}\\.action\\b`).test(postCall);
  }
  if (!resultVar) return null; // fire-and-forget (.catch() only, or result discarded) — no assumption to break
  if (!usesAction) return null; // captured but never inspects .action

  // Search the RAW (pre-stripTrailingComment) POST-CALL lines for "digest" —
  // stripTrailingComment blanks whole `//`-only lines (it treats leading
  // whitespace + `//` as a "trailing" comment marker at index 0), which would
  // erase exactly the explanatory comments this escape hatch is meant to
  // recognize. Scoped to post-call only (excludes the call's own arg lines)
  // so an unrelated "digest" substring in a conditionKey/title can't
  // silence a real finding.
  const rawPostCall = (rawLines || lines).slice(bodyEnd, windowEnd).join('\n');
  if (/digest/i.test(rawPostCall)) return null; // already accounts for the downgraded case

  return {
    file: relPath,
    line: callLineIdx + 1,
    kind: 'human-caller-ignores-digest',
    resultVar,
  };
}

// Best-effort: does this sendAlert(...) call site's surrounding ~8 lines
// carry an emailable disposition (email: true, or severity 'error'/'critical'
// alongside email logic)? Regex-based, not an AST parse — good enough for an
// inventory snapshot; false positives/negatives get corrected by hand as
// senders are migrated (this script re-runs cheaply to re-check).
function scanFile(absPath, relPath) {
  const findings = [];
  let content;
  try { content = fs.readFileSync(absPath, 'utf8'); } catch { return findings; }
  const ext = path.extname(relPath);
  const isYaml = ext === '.yml' || ext === '.yaml';
  // Truncate a line at a whitespace-preceded trailing comment marker so prose
  // like `'foo.js', // sendAlert() path, email: true` can't read as a real
  // call site (adversarial review finding — a false positive here REDS the
  // blocking CI gate, not just the inventory). The leading-whitespace guard
  // keeps `https://` (preceded by ':') intact; YAML uses `#`.
  const stripTrailingComment = (l) => {
    const m = (isYaml ? /(^|\s)#/ : /(^|\s)\/\//).exec(l);
    return m ? l.slice(0, m.index) : l;
  };
  const rawLines = content.split('\n');
  const lines = rawLines.map(stripTrailingComment);

  // Resolve any local wrapper names (injectable default param, thin
  // pass-through function) to routeAlert so calls made through them aren't
  // invisible to this whole scan (card #616 follow-up). The negative
  // lookbehinds exclude (a) the wrapper's OWN `function alert(...)`
  // declaration line from matching itself as a call site, and (b) a member
  // access on an unrelated object — a wrapper named e.g. `alert` must not
  // match `logger.alert(...)` or `window.alert(...)`, which \b alone allows
  // since "." is a non-word char (adversarial-review find, card #616
  // follow-up: this previously both mis-flagged a safe caller AND could
  // prematurely end a real call's post-call scan window at the false match).
  const wrapperNames = findWrapperNames(rawLines);
  const calleeAlt = ['routeAlert', ...wrapperNames].join('|');
  const callSiteRe = new RegExp(`(?<!function\\s+)(?<!\\.)\\b(?:${calleeAlt})\\s*\\(`);

  for (let i = 0; i < lines.length; i++) {
    // Skip comment lines (this file, opening-night-sla.js, and ux-walkthrough.yml
    // all have prose referencing "sendAlert(" inside // // # or * comments
    // describing PAST bugs or migrations — real matches, not real call sites).
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) continue;
    if (callSiteRe.test(lines[i])) {
      // Bounded by the call's OWN closing '});' (findCallBodyEnd), not a
      // fixed line count — a fixed window either truncates a long argument
      // list (misclassifying a real disposition:'human' as 'unknown', card
      // #616 ship-check finding) or bleeds into the NEXT unrelated call's
      // disposition if one follows soon after (adversarial review finding).
      // Quotes: `['"]`, not just `'` — .yml-embedded JS in this repo uses
      // double quotes at some call sites (e.g. check-cron-health.yml,
      // update-show-status.yml), which a single-quote-only regex misses
      // entirely (adversarial review finding).
      const bodyEnd = findCallBodyEnd(lines, i);
      const window = lines.slice(i, bodyEnd + 1).join('\n');
      const dispositionMatch = window.match(/disposition:\s*['"](\w+)['"]/);
      const disposition = dispositionMatch ? dispositionMatch[1] : 'unknown';
      findings.push({
        file: relPath, line: i + 1, kind: 'routeAlert',
        classification: 'router',
        disposition,
      });
      if (disposition === 'human') {
        const digestFinding = scanHumanDispositionCaller(lines, i, relPath, rawLines, calleeAlt);
        if (digestFinding) findings.push(digestFinding);
      }
    }
    if (/\bsendAlert\s*\(/.test(lines[i]) && !/function sendAlert/.test(lines[i])) {
      const window = lines.slice(i, i + 10).join('\n');
      const hasEmailTrue = /email:\s*true/.test(window);
      const severityMatch = window.match(/severity:\s*'(\w+)'/);
      let severity = severityMatch ? severityMatch[1] : null;
      if (severity === null) {
        // severity passed as a variable (e.g. `severity: alertSeverity` where
        // `const alertSeverity = 'warning'` sits nearby so shouldEmailAlert()
        // can reuse it — check-opening-night-completeness.js / verify-all-scored.js
        // pattern, card #532). Resolve it from single-quoted literal
        // assignments in the surrounding lines, but ONLY when every assignment
        // to that name agrees on one literal — a reassignment like
        // `let sev = 'warning'; if (bad) sev = 'error';` must NOT resolve to
        // the first match and silently skip a real emailable call. Anything
        // unresolved or ambiguous stays null → treated as emailable
        // (fail-noisy). The 8-line backward window is headroom over the real
        // sites, which declare the const 1 line above the call.
        const identMatch = window.match(/severity:\s*([A-Za-z_$][\w$]*)/);
        if (identMatch) {
          const nearby = lines.slice(Math.max(0, i - 8), i + 10).join('\n');
          const identPattern = identMatch[1].replace(/\$/g, '\\$');
          const literals = new Set(
            [...nearby.matchAll(new RegExp(`\\b${identPattern}\\s*=\\s*'(\\w+)'`, 'g'))].map((m) => m[1])
          );
          if (literals.size === 1) severity = [...literals][0];
        }
      }
      const emailable = hasEmailTrue && (severity === 'error' || severity === 'critical' || severity === null);
      if (!emailable) continue; // warning/info-only sendAlert calls are log-only, not owner-facing email
      findings.push({
        file: relPath, line: i + 1, kind: 'sendAlert-direct',
        classification: DIGEST_OR_REVIEWED.has(relPath) ? 'digest' : 'direct',
        severity,
      });
    }
  }
  return findings;
}

const BASELINE_PATH = path.join(__dirname, '.alert-sender-baseline.json');
const HUMAN_DIGEST_BASELINE_PATH = path.join(__dirname, '.human-caller-digest-baseline.json');

function collectFindings() {
  const files = [];
  for (const dir of SCAN_DIRS) walk(path.join(REPO_ROOT, dir), files);

  let all = [];
  for (const absPath of files) {
    const relPath = path.relative(REPO_ROOT, absPath).split(path.sep).join('/');
    if (relPath.endsWith('.test.mjs') || relPath.endsWith('.test.js')) continue;
    // Self-exclude: this script's usage text and gate messages quote the
    // "sendAlert(email:true)" pattern verbatim in non-comment lines, which the
    // regex scanner would flag as 4 phantom direct senders (same reason
    // audit-help-flag-safety.js filters out its own basename).
    if (relPath === 'scripts/' + path.basename(__filename)) continue;
    all = all.concat(scanFile(absPath, relPath));
  }
  return all;
}

/** {relPath: count} of direct-classified findings, keys sorted. */
function buildDirectCounts(findings) {
  const counts = {};
  for (const f of findings) {
    if (f.classification !== 'direct') continue;
    counts[f.file] = (counts[f.file] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

/** {relPath: count} of human-caller-ignores-digest findings, keys sorted. */
function buildHumanDigestCounts(findings) {
  const counts = {};
  for (const f of findings) {
    if (f.kind !== 'human-caller-ignores-digest') continue;
    counts[f.file] = (counts[f.file] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Pure baseline comparison. `newFiles` and `grown` are regressions (blocking);
 * `shrunk` and `stale` mean the baseline is behind reality (warn: run
 * --update-baseline so the frozen debt keeps shrinking with the drain cards).
 */
function compareToBaseline(counts, rawBaseline) {
  // Fail-noisy on malformed baseline entries: a non-integer value (e.g. a
  // hand-edited "unknown", null, or a nested object) would make BOTH the
  // growth and shrink numeric comparisons false, silently accepting any
  // count for that file (adversarial review finding, this card). Dropping
  // the entry instead means the file reads as un-baselined → blocking.
  const baseline = {};
  for (const [f, v] of Object.entries(rawBaseline || {})) {
    if (Number.isInteger(v) && v >= 0) baseline[f] = v;
  }
  const newFiles = Object.keys(counts).filter((f) => !(f in baseline));
  const grown = Object.keys(counts)
    .filter((f) => f in baseline && counts[f] > baseline[f])
    .map((f) => ({ file: f, baseline: baseline[f], current: counts[f] }));
  const shrunk = Object.keys(counts)
    .filter((f) => f in baseline && counts[f] < baseline[f])
    .map((f) => ({ file: f, baseline: baseline[f], current: counts[f] }));
  const stale = Object.keys(baseline).filter((f) => !(f in counts));
  return { newFiles, grown, shrunk, stale, ok: newFiles.length === 0 && grown.length === 0 };
}

function loadBaseline() {
  try { return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')); } catch { return {}; }
}

function loadHumanDigestBaseline() {
  try { return JSON.parse(fs.readFileSync(HUMAN_DIGEST_BASELINE_PATH, 'utf8')); } catch { return {}; }
}

function runCheck() {
  const all = collectFindings();
  const counts = buildDirectCounts(all);
  const result = compareToBaseline(counts, loadBaseline());
  const digestCounts = buildHumanDigestCounts(all);
  const digestResult = compareToBaseline(digestCounts, loadHumanDigestBaseline());

  for (const f of result.stale) {
    console.log(`ℹ️  baseline entry already drained (no direct senders left): ${f} — run --update-baseline to shrink the list.`);
  }
  for (const s of result.shrunk) {
    console.log(`ℹ️  ${s.file}: direct senders shrank ${s.baseline} → ${s.current} — run --update-baseline to lock in the improvement.`);
  }

  if (result.ok) {
    const debt = Object.values(counts).reduce((a, b) => a + b, 0);
    console.log(`✅ Alert-sender gate: no new direct sendAlert(email:true) bypasses (${debt} baselined call site(s) remain — drain tracked in #531 etc.).`);
  } else {
    console.log(`🚨 Alert-sender gate: new direct sendAlert(email:true) bypass(es) of owner-alert-router:\n`);
    for (const f of result.newFiles) {
      console.log(`  ${f} (${counts[f]} call site(s)) — not in ${path.basename(BASELINE_PATH)}`);
    }
    for (const g of result.grown) {
      console.log(`  ${g.file} — direct call sites grew ${g.baseline} → ${g.current}`);
    }
    console.log(`\nFix: route the alert through routeAlert() from scripts/lib/owner-alert-router.js`);
    console.log(`(ACTION-only bar + per-condition dedup) instead of calling sendAlert(email:true)`);
    console.log(`directly. If the sender is genuinely real-time-critical (opening-night class,`);
    console.log(`CLAUDE.md rule 14), get it reviewed and freeze it via --update-baseline.\n`);
    process.exitCode = 1;
  }

  for (const f of digestResult.stale) {
    console.log(`ℹ️  human-caller-digest baseline entry already drained: ${f} — run --update-baseline to shrink the list.`);
  }
  for (const s of digestResult.shrunk) {
    console.log(`ℹ️  ${s.file}: human-caller-ignores-digest sites shrank ${s.baseline} → ${s.current} — run --update-baseline.`);
  }

  if (digestResult.ok) {
    const debt = Object.values(digestCounts).reduce((a, b) => a + b, 0);
    console.log(`✅ Human-disposition digest gate: no routeAlert(disposition:'human') caller ignores a downgraded 'digest' result (${debt} baselined call site(s) remain).`);
    return;
  }

  console.log(`🚨 Human-disposition digest gate: routeAlert(disposition:'human') caller(s) that branch on result.action but never mention 'digest':\n`);
  for (const f of digestResult.newFiles) {
    console.log(`  ${f} (${digestCounts[f]} call site(s)) — not in ${path.basename(HUMAN_DIGEST_BASELINE_PATH)}`);
  }
  for (const g of digestResult.grown) {
    console.log(`  ${g.file} — sites grew ${g.baseline} → ${g.current}`);
  }
  console.log(`\nFix: the page-worthy allowlist gate (card #611) can downgrade disposition:'human' to`);
  console.log(`result.action==='digest' — add a branch (or comment) that treats 'digest' the same as`);
  console.log(`a delivered 'human' result (the owner WILL see it in the next digest). See the fixes in`);
  console.log(`opening-night-broadcast.yml / audit-show-review-gap.js from card #611's commit for the pattern.\n`);
  process.exitCode = 1;
}

function updateBaseline() {
  const all = collectFindings();
  const counts = buildDirectCounts(all);
  const old = loadBaseline();
  const added = Object.keys(counts).filter((f) => !(f in old));
  const removed = Object.keys(old).filter((f) => !(f in counts));
  const changed = Object.keys(counts).filter((f) => f in old && old[f] !== counts[f]);
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(counts, null, 2) + '\n');
  console.log(`Wrote ${Object.keys(counts).length} file entr${Object.keys(counts).length === 1 ? 'y' : 'ies'} to ${path.relative(process.cwd(), BASELINE_PATH)} (was ${Object.keys(old).length}). Review the diff!`);
  if (added.length) console.log(`  + added: ${added.join(', ')}`);
  if (removed.length) console.log(`  - removed: ${removed.join(', ')}`);
  for (const f of changed) console.log(`  ~ ${f}: ${old[f]} → ${counts[f]}`);

  const digestCounts = buildHumanDigestCounts(all);
  const oldDigest = loadHumanDigestBaseline();
  const addedDigest = Object.keys(digestCounts).filter((f) => !(f in oldDigest));
  const removedDigest = Object.keys(oldDigest).filter((f) => !(f in digestCounts));
  const changedDigest = Object.keys(digestCounts).filter((f) => f in oldDigest && oldDigest[f] !== digestCounts[f]);
  fs.writeFileSync(HUMAN_DIGEST_BASELINE_PATH, JSON.stringify(digestCounts, null, 2) + '\n');
  console.log(`Wrote ${Object.keys(digestCounts).length} file entr${Object.keys(digestCounts).length === 1 ? 'y' : 'ies'} to ${path.relative(process.cwd(), HUMAN_DIGEST_BASELINE_PATH)} (was ${Object.keys(oldDigest).length}). Review the diff!`);
  if (addedDigest.length) console.log(`  + added: ${addedDigest.join(', ')}`);
  if (removedDigest.length) console.log(`  - removed: ${removedDigest.join(', ')}`);
  for (const f of changedDigest) console.log(`  ~ ${f}: ${oldDigest[f]} → ${digestCounts[f]}`);
}

function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  if (process.argv.includes('--check')) return runCheck();
  if (process.argv.includes('--update-baseline')) return updateBaseline();

  const all = collectFindings();

  const summary = {
    generatedAt: new Date().toISOString(),
    counts: {
      router: all.filter(f => f.classification === 'router').length,
      digest: all.filter(f => f.classification === 'digest').length,
      direct: all.filter(f => f.classification === 'direct').length,
      humanCallerIgnoresDigest: all.filter(f => f.kind === 'human-caller-ignores-digest').length,
    },
    senders: all.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
  };

  const outPath = path.join(REPO_ROOT, 'data', 'audit', 'alert-sender-inventory.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n');

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`=== Alert Sender Inventory (${summary.senders.length} call site(s)) ===\n`);
  console.log(`router (owner-alert-router, ACTION-only + dedup):  ${summary.counts.router}`);
  console.log(`digest (reviewed scheduled email, direct Resend):  ${summary.counts.digest}`);
  console.log(`direct (bypasses router — migration candidates):  ${summary.counts.direct}`);
  console.log(`human-caller-ignores-digest (card #616):           ${summary.counts.humanCallerIgnoresDigest}\n`);

  const direct = summary.senders.filter(f => f.classification === 'direct');
  if (direct.length) {
    console.log('Direct-bypass call sites (candidates for routeAlert migration):');
    for (const f of direct) console.log(`  - ${f.file}:${f.line} (severity: ${f.severity || 'unknown'})`);
  }
  const digestIgnored = summary.senders.filter(f => f.kind === 'human-caller-ignores-digest');
  if (digestIgnored.length) {
    console.log('\nroutedAlert(disposition:\'human\') callers ignoring a downgraded \'digest\' result:');
    for (const f of digestIgnored) console.log(`  - ${f.file}:${f.line} (result var: ${f.resultVar})`);
  }
  console.log(`\nWritten to data/audit/alert-sender-inventory.json`);
}

module.exports = {
  scanFile,
  buildDirectCounts,
  buildHumanDigestCounts,
  compareToBaseline,
  DIGEST_OR_REVIEWED,
  scanHumanDispositionCaller,
};

if (require.main === module) main();
