#!/usr/bin/env node
/**
 * Dependency audit gate with an expiring allowlist for unfixable advisories.
 *
 * Replaces the raw `npm audit --audit-level=critical` CI step (test.yml
 * "Dependency Audit"). That step has no exemption mechanism, so a critical
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
 * @returns {{ ok: boolean, errors: string[], allowedHits: Array<{ghsa:string,module:string,reason:string,expires:string}> }}
 */
function evaluateAuditReport(report, allowlist, today) {
  const errors = [];

  // Registry outage / npm error: npm emits {"error":{...}} as valid JSON, and
  // a report with no vulnerabilities object is not a clean bill of health.
  if (!report || typeof report !== 'object') {
    return { ok: false, errors: ['npm audit produced no report object'], allowedHits: [] };
  }
  if (report.error) {
    const e = report.error;
    return {
      ok: false,
      errors: [`npm audit itself errored: ${e.code || ''} ${e.summary || JSON.stringify(e).slice(0, 200)}`],
      allowedHits: [],
    };
  }
  if (!report.vulnerabilities || typeof report.vulnerabilities !== 'object') {
    return { ok: false, errors: ['npm audit report has no vulnerabilities object — refusing to treat as clean'], allowedHits: [] };
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

  for (const a of allowlist) {
    const ghsa = (a && a.ghsa) || '(unnamed)';
    if (!a || typeof a.exposure !== 'string' || a.exposure.trim().length < MIN_EXPOSURE_CHARS) {
      disqualified.add(ghsa);
      errors.push(
        `allowlist entry ${ghsa} has no usable \`exposure\` assessment `
        + `(required, >= ${MIN_EXPOSURE_CHARS} chars) — say why THIS deployment can't be reached`,
      );
      continue; // one error per entry; no need to also report its expiry
    }
    if (typeof a.issue !== 'string' || !ISSUE_RE.test(a.issue.trim())) {
      // An exemption nobody can trace back to a decision is an anonymous one.
      disqualified.add(ghsa);
      errors.push(
        `allowlist entry ${ghsa} has no \`issue\` reference (required, e.g. 'BRO-3202') `
        + '— every exemption must point at the decision that granted it',
      );
      continue;
    }
    if (!isValidExpiry(a.expires)) {
      // An unparseable expiry is worse than an expired one: string comparison
      // makes it read as "in the future" forever.
      disqualified.add(ghsa);
      errors.push(
        `allowlist entry ${ghsa} has an invalid \`expires\` (${JSON.stringify(a.expires)}) `
        + '— must be a real calendar date in strict YYYY-MM-DD form, or it never expires',
      );
      continue;
    }
    if (a.expires <= today) {
      disqualified.add(ghsa);
      errors.push(`expired allowlist entry: ${a.ghsa} (${a.module}) expired ${a.expires} — re-triage or extend with a reason`);
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
      errors.push(`allowlist has ${count} entries for ${ghsa} — collapse them into one, they silently shadow each other`);
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
  const failing = new Map(); // ghsa/url -> description
  for (const [pkgName, vuln] of Object.entries(report.vulnerabilities)) {
    for (const via of (vuln.via || [])) {
      if (typeof via !== 'object' || via === null) continue;
      if (via.severity !== 'critical') continue;
      const id = String(via.url || '').split('/').pop() || `unknown:${pkgName}:${via.title}`;
      const allowed = allowByGhsa.get(id);
      if (allowed) {
        allowedHits.set(id, allowed);
      } else {
        failing.set(id, `${pkgName}: ${via.title} (${via.url || 'no advisory url'})`);
      }
    }
  }

  for (const desc of failing.values()) errors.push(`critical advisory not in allowlist — ${desc}`);
  return { ok: errors.length === 0, errors, allowedHits: Array.from(allowedHits.values()) };
}

function main() {
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
      process.exit(1);
    }
  }

  let report;
  try {
    report = JSON.parse(raw);
  } catch (e) {
    console.error('npm audit output is not JSON:', e.message);
    process.exit(1);
  }

  const today = new Date().toISOString().slice(0, 10);
  const result = evaluateAuditReport(report, ALLOWLIST, today);

  if (result.allowedHits.length) {
    console.log('⚠️  Allowlisted critical advisories (NOT clean — tracked, unfixable today):');
    for (const a of result.allowedHits) {
      console.log(`   ${a.ghsa} (${a.module}) — ${a.reason} [expires ${a.expires}]`);
      console.log(`      exposure: ${a.exposure}`);
    }
  }

  if (!result.ok) {
    console.error('❌ Dependency audit failed:');
    for (const err of result.errors) console.error(`   ${err}`);
    process.exit(1);
  }

  console.log('✅ No unallowlisted critical advisories.');
}

module.exports = { evaluateAuditReport, ALLOWLIST, MIN_EXPOSURE_CHARS, ISSUE_RE, isValidExpiry };

if (require.main === module) main();
