#!/usr/bin/env node
/**
 * Dependency audit gate with an expiring allowlist for unfixable advisories.
 *
 * Replaced the raw `npm audit --audit-level=critical` CI step that test.yml's
 * "Dependency Audit" job ran until 2026-07-11 (the job itself left test.yml
 * on 2026-09-30, see BRO-4434 below). A raw step has no exemption mechanism, so a critical
 * advisory with NO patched release (e.g. decompress GHSA-mp2f-45pm-3cg9,
 * range <=4.2.1 — 4.2.1 IS the latest version) turns CI permanently red until
 * a breaking major upgrade of the dependent (sanity) ships. `|| true` is
 * banned house-wide (silent-masking), so this wrapper:
 *   - fails on ANY critical-severity ADVISORY not in ALLOWLIST
 *   - fails on any allowlisted entry past its expiry (forces re-triage)
 *   - fails when npm audit itself errored (registry outage must be red,
 *     not silently green)
 *   - prints what was allowlisted so the log never reads as "clean"
 *
 * Detection is per-ADVISORY, not per-package: every advisory appears as an
 * object entry in the `via` array of the package it directly affects, with
 * its own `severity` field. Scanning all vulnerabilities' object vias for
 * severity === 'critical' therefore covers arbitrary-depth transitive chains
 * without graph walking, and does not false-positive on lower-severity
 * advisories that share a package with a critical one (2026-07-11 ship-check:
 * the first version walked one transitive level — both unsound directions).
 *
 * Adding an entry requires: the GHSA id, `reason` (why it can't be fixed),
 * `exposure` (whether THIS deployment is actually reachable by the advisory —
 * hosting platform, whether the affected code path is even live, what input an
 * anonymous caller controls), `issue` (the Linear id that granted the
 * exemption), and an expiry date ~90 days out (shorter for a live,
 * patched-upstream critical).
 *
 * BRO-4434 (2026-09-30): this audit no longer runs inside test.yml. Main's
 * Test Suite color means "the code is healthy"; the npm advisory feed and the
 * allowlist's expiry dates are outside state and turned main red with no code
 * change (run 36712608792: GHSA-hrh2 published the day before, unallowlisted).
 * It now runs daily from .github/workflows/audit-dependencies.yml with
 * `--alert`, which files ONE Linear card per finding through
 * owner-alert-router.js (disposition 'auto'):
 *   - an unallowlisted critical / expired or disqualified entry → a card
 *     dispatched at filing (`dependency-audit:<ghsa>`);
 *   - an entry expiring within `--warn-days` → a parked card two weeks early
 *     (`dependency-audit:expiring:<ghsa>`), so the expiry date is a reminder,
 *     not a red day.
 * A clean run resolves every open `dependency-audit:` condition.
 *
 * Usage:
 *   node scripts/audit-dependencies.js                 # print findings; exit 0
 *   node scripts/audit-dependencies.js --strict        # exit 1 on findings (local gate)
 *   node scripts/audit-dependencies.js --warn-days=14  # also list entries expiring within 14 days
 *   node scripts/audit-dependencies.js --alert         # route findings to Linear cards
 *   node scripts/audit-dependencies.js --out=<file>    # write the JSON verdict to a file
 *
 * Exit codes (same contract as scripts/audit-time-bomb-tests.js):
 *   0 — ran; findings (if any) were printed and, with --alert, filed
 *   1 — findings AND --strict
 *   2 — the audit could not run (npm audit errored / no report)
 *   3 — --alert was asked for and at least one dispatch did NOT produce a
 *       tracker. owner-alert-router.js never throws on a dispatch failure: it
 *       returns { dispatchOk: false } and leaves the ledger untouched, so a
 *       rotated LINEAR_API_KEY would otherwise be a green run with phantom
 *       "cards filed" (plan-review pre-mortem, BRO-4434).
 *
 * `exposure` and `issue` are REQUIRED and validated: allowlisting a live RCE
 * without writing down why it can't reach us defeats the entire gate, so an
 * entry that skipped the assessment is DISQUALIFIED — it is reported as an
 * error and stops exempting anything, which means the advisory it used to
 * cover fails the build in the same run (BRO-3202).
 *
 * The `exposure` length floor is a floor, not a standard: 40 characters of
 * nothing passes it. `issue` is the half a reviewer can pull on, and the text
 * is printed into the CI log on every run so a hollow one is visible. If
 * exemptions ever start reading as boilerplate, the fix is a named approver,
 * not a bigger number here.
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help');

const USAGE = `Usage: node scripts/audit-dependencies.js [--strict] [--warn-days=N] [--alert] [--out=<file>]

Critical-severity npm advisory gate with an expiring allowlist.
  --strict        exit 1 when there are findings (default: exit 0, findings printed)
  --warn-days=N   also report allowlist entries expiring within N days
  --alert         file one Linear card per finding via owner-alert-router.js
  --out=<file>    write the JSON verdict {ok, findings, expiringSoon, allowedHits, alerts}
Exit: 0 ran / 1 findings+--strict / 2 could not run / 3 --alert dispatch failed.`;

/** Ledger conditionKey prefix. Every key this script opens starts with it, so
 * a clean run can sweep-resolve everything it ever filed (a dependency that
 * got upgraded must not leave its card's condition open forever). */
const CONDITION_PREFIX = 'dependency-audit:';
const EXPIRING_KEY_INFIX = 'expiring:';

/** Safe-form acceptance lines for the filed cards (autonomous-triage-core.js
 * SAFE_CHECK_FORMS accepts `node --test <file>`). The `VERIFY: ` prefix is
 * load-bearing: buildCardNotes() drops `verify.line` into the card raw and
 * extractVerifyCmd() only harvests `VERIFY:` lines or backticked spans — a
 * bare command is prose, the card is "no-safe-verify", and neither the
 * red-first dispatcher nor the parked drain will ever pick it up (BRO-3881;
 * caught again by this landing's ship-check). The two live tests run the
 * REAL `npm audit` and are deliberately absent from every unit manifest. */
const VERIFY_CLEAN = 'VERIFY: node --test tests/live/audit-dependencies-clean.test.mjs';
const VERIFY_NO_EXPIRING = 'VERIFY: node --test tests/live/audit-dependencies-no-expiring.test.mjs';

/** Minimum length of an `exposure` assessment — long enough to be a sentence. */
const MIN_EXPOSURE_CHARS = 40;

/** Linear issue id an exemption must cite, e.g. BRO-3202. A length check alone
 * is easy to satisfy with 40 characters of nothing; requiring a tracked issue
 * is the part a reviewer can actually pull on. */
const ISSUE_RE = /^BRO-\d+$/;

/** Strict ISO date. `expires` is compared as a STRING against today, so a
 * plausible-looking typo silently disables the only mechanism that forces
 * re-triage: `undefined <= '2026-09-13'` is false, and so is
 * `'2026-9-1' <= '2026-09-13'` — both mean "never expires" rather than
 * "expired months ago". Validated, not trusted (BRO-3202 ship-check). */
const EXPIRES_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True when `value` is a strict ISO date that names a real calendar day
 * (rejects 2026-02-30 and 2026-13-01, which the regex alone would accept). */
function isValidExpiry(value) {
  if (typeof value !== 'string' || !EXPIRES_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const ALLOWLIST = [
  {
    ghsa: 'GHSA-mp2f-45pm-3cg9',
    module: 'decompress',
    reason: 'No patched release exists (advisory range <=4.2.1; 4.2.1 is latest). '
      + 'Removal requires the breaking sanity major upgrade.',
    exposure: 'Not exposed: reached only via the sanity CLI toolchain (dev-time CMS tooling). '
      + 'It is never bundled into the site runtime, so no attacker-supplied archive ever '
      + 'reaches it — the extraction path only runs against files a developer already has.',
    issue: 'BRO-3202',
    expires: '2026-10-15',
  },
  {
    // Published 2026-09-29 23:49Z (symlink-chain path traversal). Same package,
    // same unpatched range (<=4.2.1, 4.2.1 is latest; only the @xhmikosr fork
    // has fixes) and the same single path as GHSA-mp2f-45pm-3cg9 above:
    // decompress <- @sanity/cli <- sanity (package-lock.json, 2026-09-30).
    // sanity is a regular dependency, but no script, workflow or src/ code runs
    // the sanity CLI (grep 2026-09-30); src/sanity/schemas imports only types.
    ghsa: 'GHSA-hrh2-vp3x-79xf',
    module: 'decompress',
    reason: 'No patched release of decompress exists (advisory range <=4.2.1; 4.2.1 is latest). '
      + 'Removal requires the breaking sanity major upgrade.',
    exposure: 'Not exposed: reached only via the sanity CLI, which no site runtime path, script or CI workflow invokes. '
      + 'It is never bundled into the site runtime, so no attacker-supplied archive ever '
      + 'reaches it — the extraction path only runs against files a developer already has.',
    issue: 'BRO-3202',
    expires: '2026-10-15',
  },
  // --- Next.js 14.2.35: both advisories' first patched release is 15.5.24 ---
  // 14.2.35 is the LAST 14.x release (npm view next versions, 2026-09-13) —
  // there is no 14.x backport, so "just patch it" is a Next 14 -> 15/16 major
  // (React 19 + async request APIs). That upgrade is tracked separately; these
  // entries carry a SHORT expiry (not the usual ~90d) because they are live
  // criticals, not permanently-unfixable transitive cruft like decompress.
  // Exposure was measured, not assumed — see BRO-3202.
  {
    ghsa: 'GHSA-p293-qw3h-jr36',
    module: 'next',
    reason: 'Range >=13.4.0 <15.5.24 — first patched release is 15.5.24, and 14.2.35 is the '
      + 'last 14.x, so there is no patch reachable without the Next 14 -> 15/16 major.',
    exposure: 'Not exposed: the advisory is Windows-filesystem-only ("when the server is hosted '
      + 'on machines using a Windows filesystem"). Prod runs on Vercel (Linux serverless) and '
      + 'every CI job runs on ubuntu-latest — this repo has no Windows runtime anywhere.',
    issue: 'BRO-3202',
    expires: '2026-11-15',
  },
  {
    ghsa: 'GHSA-2xp9-vwfh-vxw4',
    module: 'next',
    reason: 'Range >=10.0.0 <15.5.24 — first patched release is 15.5.24, and 14.2.35 is the '
      + 'last 14.x, so there is no patch reachable without the Next 14 -> 15/16 major.',
    exposure: 'Assessed, not waved through: /_next/image IS live on prod (the OG route at '
      + 'src/app/show/[slug]/opengraph-image.tsx self-calls it), so the affected endpoint is '
      + 'reachable. Closed from both ends. (1) Attacker-supplied input removed: next.config.js '
      + 'remotePatterns no longer carries host-only entries for the multi-tenant CDNs '
      + 'res.cloudinary.com and **.amazonaws.com — verified 2026-09-13 that an arbitrary AVIF '
      + 'under res.cloudinary.com/demo/ returned 200 through prod /_next/image. Remote input is '
      + 'now scoped to our own Contentful space, and same-origin /images/** holds zero .avif '
      + 'files; output formats is pinned to webp so libheif is never used to encode either. '
      + '(2) Vercel has the platform mitigation the advisory describes ("optimization of AVIF '
      + 'files is disabled"): an AVIF through prod /_next/image came back byte-identical at '
      + 'w=64/256/640 (43247 B each), i.e. passed through, never decoded.',
    issue: 'BRO-3202',
    expires: '2026-11-15',
  },
];

/**
 * Pure decision core — exported for tests/unit/audit-dependencies.test.mjs.
 *
 * @param {object} report - parsed `npm audit --json` output
 * @param {Array<{ghsa:string,module:string,reason:string,expires:string}>} allowlist
 * @param {string} today - YYYY-MM-DD
 * @param {{ warnDays?: number }} [opts] - warnDays > 0 also lists valid entries
 *   whose `expires` is within that many days (inclusive) as `expiringSoon`.
 *   Never affects `ok`.
 * @returns {{ ok: boolean, couldNotRun: boolean, errors: string[],
 *   findings: Array<{kind: string, ghsa: string, module: string, message: string}>,
 *   allowedHits: Array<{ghsa:string,module:string,reason:string,expires:string}>,
 *   expiringSoon: Array<{ghsa:string,module:string,expires:string,daysLeft:number}> }}
 *   `errors` is `findings.map(f => f.message)` — kept for the CI log and older
 *   callers. Card conditionKeys are built from `findings[].ghsa`, never from
 *   the prose (a wording change must not become a duplicate card).
 */
function evaluateAuditReport(report, allowlist, today, { warnDays = 0 } = {}) {
  const findings = [];
  const pushFinding = (kind, ghsa, module, message) => findings.push({ kind, ghsa, module, message });
  const couldNotRun = (message) => ({
    ok: false, couldNotRun: true, errors: [message], findings: [], allowedHits: [], expiringSoon: [],
  });

  // Registry outage / npm error: npm emits {"error":{...}} as valid JSON, and
  // a report with no vulnerabilities object is not a clean bill of health.
  if (!report || typeof report !== 'object') {
    return couldNotRun('npm audit produced no report object');
  }
  if (report.error) {
    const e = report.error;
    return couldNotRun(`npm audit itself errored: ${e.code || ''} ${e.summary || JSON.stringify(e).slice(0, 200)}`);
  }
  if (!report.vulnerabilities || typeof report.vulnerabilities !== 'object') {
    return couldNotRun('npm audit report has no vulnerabilities object — refusing to treat as clean');
  }

  // An allowlist entry that is malformed or expired is DISQUALIFIED: it is
  // reported as its own error AND stops exempting anything, so the advisory it
  // used to cover resurfaces in the scan below.
  //
  // Deliberately no early return here (BRO-3202 ship-check). Returning early
  // made the gate report the wrong problem: with a dormant entry one character
  // short, a brand-new critical RCE elsewhere in the tree was never scanned
  // for, so CI printed only "fix your prose" and hid the actionable finding
  // until someone fixed the prose and pushed again. Every reason the audit
  // fails should be on the FIRST red run — an audit that reveals its findings
  // one round-trip at a time is worse than one that says everything at once.
  const disqualified = new Set();

  const expiringSoon = [];
  const warnUntil = warnDays > 0 ? addDays(today, warnDays) : null;

  for (const a of allowlist) {
    const ghsa = (a && a.ghsa) || '(unnamed)';
    const module = (a && a.module) || '(unknown module)';
    if (!a || typeof a.exposure !== 'string' || a.exposure.trim().length < MIN_EXPOSURE_CHARS) {
      disqualified.add(ghsa);
      pushFinding('missing-exposure', ghsa, module,
        `allowlist entry ${ghsa} has no usable \`exposure\` assessment `
        + `(required, >= ${MIN_EXPOSURE_CHARS} chars) — say why THIS deployment can't be reached`);
      continue; // one error per entry; no need to also report its expiry
    }
    if (typeof a.issue !== 'string' || !ISSUE_RE.test(a.issue.trim())) {
      // An exemption nobody can trace back to a decision is an anonymous one.
      disqualified.add(ghsa);
      pushFinding('missing-issue', ghsa, module,
        `allowlist entry ${ghsa} has no \`issue\` reference (required, e.g. 'BRO-3202') `
        + '— every exemption must point at the decision that granted it');
      continue;
    }
    if (!isValidExpiry(a.expires)) {
      // An unparseable expiry is worse than an expired one: string comparison
      // makes it read as "in the future" forever.
      disqualified.add(ghsa);
      pushFinding('invalid-expiry', ghsa, module,
        `allowlist entry ${ghsa} has an invalid \`expires\` (${JSON.stringify(a.expires)}) `
        + '— must be a real calendar date in strict YYYY-MM-DD form, or it never expires');
      continue;
    }
    if (a.expires <= today) {
      disqualified.add(ghsa);
      pushFinding('expired', ghsa, module,
        `expired allowlist entry: ${a.ghsa} (${a.module}) expired ${a.expires} — re-triage or extend with a reason`);
      continue;
    }
    // Still valid: is the expiry inside the warning window? Boundary is
    // inclusive (expires == today+warnDays counts). Today itself is `expired`
    // above, so daysLeft here is always >= 1.
    if (warnUntil && a.expires <= warnUntil) {
      expiringSoon.push({ ghsa, module, expires: a.expires, daysLeft: daysBetween(today, a.expires) });
    }
  }

  // Two entries for the same GHSA silently collapsed into one (last wins) when
  // the map was built, so a stale exemption could shadow a re-triaged one.
  const byGhsaCount = new Map();
  for (const a of allowlist) {
    const ghsa = (a && a.ghsa) || '(unnamed)';
    byGhsaCount.set(ghsa, (byGhsaCount.get(ghsa) || 0) + 1);
  }
  for (const [ghsa, count] of byGhsaCount) {
    if (count > 1) {
      disqualified.add(ghsa);
      pushFinding('duplicate-entry', ghsa, '(allowlist)',
        `allowlist has ${count} entries for ${ghsa} — collapse them into one, they silently shadow each other`);
    }
  }

  const allowByGhsa = new Map(
    allowlist
      .filter((a) => a && a.ghsa && !disqualified.has(a.ghsa))
      .map((a) => [a.ghsa, a]),
  );

  // Per-advisory scan: object entries in `via` are the advisories themselves,
  // each with its own severity. String entries are pointers to other package
  // keys, whose own object vias are scanned when we reach that key.
  const allowedHits = new Map();
  const failing = new Map(); // ghsa/url -> { module, message }
  for (const [pkgName, vuln] of Object.entries(report.vulnerabilities)) {
    for (const via of (vuln.via || [])) {
      if (typeof via !== 'object' || via === null) continue;
      if (via.severity !== 'critical') continue;
      const id = String(via.url || '').split('/').pop() || `unknown:${pkgName}:${via.title}`;
      const allowed = allowByGhsa.get(id);
      if (allowed) {
        allowedHits.set(id, allowed);
      } else {
        failing.set(id, { module: pkgName, message: `critical advisory not in allowlist — ${pkgName}: ${via.title} (${via.url || 'no advisory url'})` });
      }
    }
  }

  for (const [id, f] of failing) pushFinding('unallowlisted', id, f.module, f.message);
  // Only the surviving (not disqualified, not expired) entries reach the
  // window above, so an expired entry never appears in both lists.
  return {
    ok: findings.length === 0,
    couldNotRun: false,
    errors: findings.map((f) => f.message),
    findings,
    allowedHits: Array.from(allowedHits.values()),
    expiringSoon,
  };
}

/** YYYY-MM-DD + n days, in UTC (string dates compare lexically). */
function addDays(isoDay, n) {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromIsoDay, toIsoDay) {
  return Math.round((Date.parse(`${toIsoDay}T00:00:00Z`) - Date.parse(`${fromIsoDay}T00:00:00Z`)) / 86400e3);
}

/**
 * Exit policy, separated so the step summary can print the reason and the
 * test can pin the table. Precedence: could-not-run beats everything (a
 * report that never existed has no findings to trust); a failed alert
 * dispatch beats --strict (the job must go red for the LOUDER reason).
 * @returns {{ exitCode: 0|1|2|3, reason: string }}
 */
function decideExitCode({ couldNotRun = false, findingsCount = 0, strict = false, alertDispatchFailed = false } = {}) {
  if (couldNotRun) return { exitCode: 2, reason: 'audit could not run' };
  if (alertDispatchFailed) return { exitCode: 3, reason: '--alert: at least one finding has no tracker' };
  if (findingsCount > 0 && strict) return { exitCode: 1, reason: `${findingsCount} finding(s) and --strict` };
  return { exitCode: 0, reason: findingsCount > 0 ? `${findingsCount} finding(s) reported` : 'clean' };
}

/** conditionKey for a finding (unallowlisted / expired / disqualified). */
function findingKey(ghsa) { return `${CONDITION_PREFIX}${ghsa}`; }
/** conditionKey for the parked "expires soon" reminder. */
function expiringKey(ghsa) { return `${CONDITION_PREFIX}${EXPIRING_KEY_INFIX}${ghsa}`; }

/**
 * Route findings + expiring-soon entries through the owner alert router.
 * Injectable `router` ({ routeAlert, resolveCondition, loadLedger }) so the
 * unit test exercises the REAL contract of owner-alert-router.js: routeAlert
 * resolves with `{ action, dispatchOk, linearIdentifier }` and never throws on
 * a dispatch failure.
 *
 * Rules:
 *  - a clean run (or any run) first sweep-resolves every open
 *    `dependency-audit:` key that is not in this run's set — an upgraded
 *    dependency or an extended expiry closes its own condition;
 *  - each finding files a dispatched-at-filing card (`dependency-audit:<ghsa>`)
 *    and resolves that GHSA's parked expiring reminder (the pair would
 *    otherwise sit open together after the expiry date, one of them false);
 *  - each expiring-soon entry files a PARKED card (no dispatchAtFiling: the
 *    decision to extend an exemption is a judgment call, not mechanical);
 *  - `dispatchOk === false`, or an 'auto' result with no linearIdentifier,
 *    counts as a dispatch failure (the router does not throw).
 *
 * @returns {{ alerts: Array<object>, alertDispatchFailed: boolean }}
 */
async function runAlerts({ findings, expiringSoon, allowlist, router, runContext = {}, warnDays = 0, log = console.error }) {
  const { routeAlert, resolveCondition, loadLedger } = router;
  const byGhsa = new Map((allowlist || []).filter((a) => a && a.ghsa).map((a) => [a.ghsa, a]));

  // One card per GHSA: evaluateAuditReport can report the same id more than
  // once (a disqualified entry that is ALSO duplicated), and a second
  // routeAlert on the same key would only add a cooldown-silent row.
  const seen = new Set();
  findings = findings.filter((f) => (seen.has(f.ghsa) ? false : (seen.add(f.ghsa), true)));

  const currentKeys = new Set([
    ...findings.map((f) => findingKey(f.ghsa)),
    ...expiringSoon.map((e) => expiringKey(e.ghsa)),
  ]);

  // Sweep-resolve what this run no longer reports. A run with no warning
  // window (warnDays 0) says nothing about reminders, so it must not close
  // them — only a windowed run is authoritative for `expiring:` keys.
  const expiringPrefix = `${CONDITION_PREFIX}${EXPIRING_KEY_INFIX}`;
  const ledger = loadLedger();
  for (const key of Object.keys((ledger && ledger.conditions) || {})) {
    if (!key.startsWith(CONDITION_PREFIX)) continue;
    if (ledger.conditions[key].status !== 'open') continue;
    if (currentKeys.has(key)) continue;
    if (warnDays === 0 && key.startsWith(expiringPrefix)) continue;
    resolveCondition(key, { reason: 'audit-dependencies: no longer reported' });
  }

  const dispatchAtFiling = runContext.runId
    ? { runId: runContext.runId, runUrl: runContext.runUrl || null }
    : undefined;

  const alerts = [];
  let alertDispatchFailed = false;
  const record = (conditionKey, result) => {
    // 'auto' must have filed a tracker; 'silent' (ledger cooldown or Linear
    // duplicate) must NAME the tracker it is deferring to. The router only
    // records a condition as notified after a successful dispatch, so a
    // silent result with no identifier means the ledger claims a card that
    // nothing can point at — loud, not green (ship-check finding).
    const failed = result.dispatchOk === false
      || (result.action === 'auto' && !result.linearIdentifier)
      || (result.action === 'silent' && !result.linearIdentifier);
    if (failed) {
      alertDispatchFailed = true;
      log(`[alert] dispatch failed for ${conditionKey}: ${result.dispatchError || 'no tracker identifier returned'}`);
    }
    alerts.push({ conditionKey, action: result.action, linearIdentifier: result.linearIdentifier || null, dispatchOk: !failed });
  };

  for (const f of findings) {
    const entry = byGhsa.get(f.ghsa);
    const exemption = entry
      ? `\n\nCurrent allowlist entry — reason: ${entry.reason}\nexposure: ${entry.exposure}\nissue: ${entry.issue}\nexpires: ${entry.expires}`
      : '';
    const key = findingKey(f.ghsa);
    // The reminder for this GHSA is superseded by the real finding — resolve
    // it BEFORE filing so a throwing routeAlert cannot leave the pair open.
    resolveCondition(expiringKey(f.ghsa), { reason: 'superseded by finding' });
    try {
      const result = await routeAlert({
        conditionKey: key,
        // Plain words first, id last (owner-reader review): the owner reads
        // the board, not the code. Say who acts and what ignoring it means.
        title: `Security issue in ${f.module} — needs a decision (${f.ghsa})`,
        description: `A helper session is assigned to this card automatically; the owner does not need to act. If nothing is done, the site keeps running with an unreviewed critical advisory in a dependency, and the daily audit re-files this card after its 7-day cooldown.\n\nTechnical: ${f.message}${exemption}\n\nFound by \`node scripts/audit-dependencies.js\` (daily, .github/workflows/audit-dependencies.yml). Main's Test Suite no longer goes red for this (BRO-4434); this card is the only signal.`,
        hint: f.kind === 'unallowlisted'
          ? 'Upgrade the dependency if a patched release exists. Otherwise add an ALLOWLIST entry in scripts/audit-dependencies.js with a real `exposure` assessment (is the affected code path reachable on prod?), the granting `issue`, and an `expires` ~90 days out.'
          : 'Re-triage the ALLOWLIST entry in scripts/audit-dependencies.js: fix the field it is missing, or extend `expires` with a fresh reason if the advisory still has no fix.',
        severity: 'error',
        disposition: 'auto',
        cardAction: 'Fix',
        dispatchAtFiling,
        verify: { line: VERIFY_CLEAN, note: 'runs the real npm audit; passes only when no unallowlisted, expired or disqualified critical remains' },
      });
      record(key, result);
    } catch (err) {
      alertDispatchFailed = true;
      log(`[alert] routeAlert threw for ${key}: ${err.message}`);
      alerts.push({ conditionKey: key, action: 'error', linearIdentifier: null, dispatchOk: false });
    }
  }

  for (const e of expiringSoon) {
    const key = expiringKey(e.ghsa);
    try {
      const result = await routeAlert({
        conditionKey: key,
        title: `Security exception for ${e.module} ends on ${e.expires} — extend or fix (${e.ghsa})`,
        description: `Nothing breaks on ${e.expires}: that day the daily audit files a "needs a decision" card and assigns it to a helper session automatically. This reminder (${e.daysLeft} day(s) ahead) exists so the decision can be made calmly beforehand; the owner does not need to act.\n\nTechnical: the ALLOWLIST entry for ${e.ghsa} (${e.module}) in scripts/audit-dependencies.js expires on ${e.expires}. Check whether a patched release now exists; if not, extend \`expires\` with a fresh reason.`,
        hint: 'Check the advisory for a patched release. If none: extend `expires` (~90 days) and refresh `reason`/`exposure` in scripts/audit-dependencies.js. If one exists: upgrade and delete the entry.',
        severity: 'warning',
        disposition: 'auto',
        cardAction: 'Investigate',
        verify: { line: VERIFY_NO_EXPIRING, note: 'runs the real audit with a 14-day window; passes when nothing expires within it' },
      });
      record(key, result);
    } catch (err) {
      alertDispatchFailed = true;
      log(`[alert] routeAlert threw for ${key}: ${err.message}`);
      alerts.push({ conditionKey: key, action: 'error', linearIdentifier: null, dispatchOk: false });
    }
  }

  return { alerts, alertDispatchFailed };
}

function parseArgs(argv) {
  const opts = { strict: false, alert: false, warnDays: 0, out: null, help: false };
  for (const arg of argv) {
    if (arg === '--strict') opts.strict = true;
    else if (arg === '--alert') opts.alert = true;
    else if (arg.startsWith('--warn-days=')) {
      const n = Number(arg.slice('--warn-days='.length));
      if (!Number.isInteger(n) || n < 0) throw new Error(`--warn-days must be a non-negative integer, got ${JSON.stringify(arg)}`);
      opts.warnDays = n;
    } else if (arg.startsWith('--out=')) opts.out = arg.slice('--out='.length);
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`);
  }
  return opts;
}

/** Runs `npm audit --json` and returns the parsed report, or null when the
 * command produced nothing parseable (the caller treats that as could-not-run). */
function runNpmAudit() {
  let raw;
  try {
    raw = execSync('npm audit --json', {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    // npm audit exits non-zero when vulnerabilities exist — the JSON is still
    // on stdout. A missing stdout means the command itself broke.
    raw = e.stdout;
    if (!raw) {
      console.error('npm audit failed to produce output:', e.message);
      return null;
    }
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error('npm audit output is not JSON:', e.message);
    return null;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(e.message);
    console.error(USAGE);
    process.exit(2);
  }

  const today = new Date().toISOString().slice(0, 10);
  const report = runNpmAudit();
  const result = report
    ? evaluateAuditReport(report, ALLOWLIST, today, { warnDays: opts.warnDays })
    : evaluateAuditReport(null, ALLOWLIST, today, { warnDays: opts.warnDays });

  if (result.allowedHits.length) {
    console.log('⚠️  Allowlisted critical advisories (NOT clean — tracked, unfixable today):');
    for (const a of result.allowedHits) {
      console.log(`   ${a.ghsa} (${a.module}) — ${a.reason} [expires ${a.expires}]`);
      console.log(`      exposure: ${a.exposure}`);
    }
  }
  if (result.expiringSoon.length) {
    console.log(`⏳ Allowlist entries expiring within ${opts.warnDays} day(s):`);
    for (const e of result.expiringSoon) {
      console.log(`   ${e.ghsa} (${e.module}) — expires ${e.expires} (${e.daysLeft} day(s) left)`);
    }
  }

  if (result.couldNotRun) {
    console.error('💥 Dependency audit could not run:');
    for (const err of result.errors) console.error(`   ${err}`);
  } else if (!result.ok) {
    console.error(`❌ Dependency audit: ${result.findings.length} finding(s):`);
    for (const err of result.errors) console.error(`   ${err}`);
  } else {
    console.log('✅ No unallowlisted critical advisories.');
  }

  let alerts = [];
  let alertDispatchFailed = false;
  if (opts.alert && !result.couldNotRun) {
    const router = require('./lib/owner-alert-router');
    const runContext = process.env.GITHUB_RUN_ID
      ? {
        runId: process.env.GITHUB_RUN_ID,
        runUrl: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
          ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
          : null,
      }
      : {};
    ({ alerts, alertDispatchFailed } = await runAlerts({
      findings: result.findings,
      expiringSoon: result.expiringSoon,
      allowlist: ALLOWLIST,
      router,
      runContext,
      warnDays: opts.warnDays,
    }));
    for (const a of alerts) {
      console.log(`   [alert] ${a.conditionKey} → ${a.action}${a.linearIdentifier ? ` (${a.linearIdentifier})` : ''}${a.dispatchOk ? '' : ' — DISPATCH FAILED'}`);
    }
  }

  const verdict = decideExitCode({
    couldNotRun: result.couldNotRun,
    findingsCount: result.findings.length,
    strict: opts.strict,
    alertDispatchFailed,
  });

  if (opts.out) {
    // --out, not `--json > file`: with --alert the router writes its own
    // informational lines to stdout, which would corrupt a redirected file.
    fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
    fs.writeFileSync(opts.out, JSON.stringify({
      today,
      warnDays: opts.warnDays,
      ok: result.ok,
      couldNotRun: result.couldNotRun,
      findings: result.findings,
      expiringSoon: result.expiringSoon,
      allowedHits: result.allowedHits,
      alerts,
      exit: verdict,
    }, null, 2) + '\n');
  }

  if (verdict.exitCode !== 0) console.error(`exit ${verdict.exitCode}: ${verdict.reason}`);
  process.exit(verdict.exitCode);
}

module.exports = {
  evaluateAuditReport,
  decideExitCode,
  runAlerts,
  parseArgs,
  findingKey,
  expiringKey,
  CONDITION_PREFIX,
  VERIFY_CLEAN,
  VERIFY_NO_EXPIRING,
  ALLOWLIST,
  MIN_EXPOSURE_CHARS,
  ISSUE_RE,
  isValidExpiry,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
