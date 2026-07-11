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
 * Adding an entry requires: the GHSA id, why it can't be fixed, a Notion card
 * or issue reference, and an expiry date ~90 days out.
 */

'use strict';

const { execSync } = require('child_process');

const ALLOWLIST = [
  {
    ghsa: 'GHSA-mp2f-45pm-3cg9',
    module: 'decompress',
    reason: 'No patched release exists (advisory range <=4.2.1; 4.2.1 is latest). '
      + 'Reached only via the sanity CLI toolchain (dev-time CMS tooling, not site runtime). '
      + 'Removal requires the breaking sanity major upgrade.',
    expires: '2026-10-15',
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

  const allowByGhsa = new Map(allowlist.map((a) => [a.ghsa, a]));
  const expired = allowlist.filter((a) => a.expires <= today);
  if (expired.length) {
    for (const a of expired) {
      errors.push(`expired allowlist entry: ${a.ghsa} (${a.module}) expired ${a.expires} — re-triage or extend with a reason`);
    }
    return { ok: false, errors, allowedHits: [] };
  }

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
    }
  }

  if (!result.ok) {
    console.error('❌ Dependency audit failed:');
    for (const err of result.errors) console.error(`   ${err}`);
    process.exit(1);
  }

  console.log('✅ No unallowlisted critical advisories.');
}

module.exports = { evaluateAuditReport, ALLOWLIST };

if (require.main === module) main();
