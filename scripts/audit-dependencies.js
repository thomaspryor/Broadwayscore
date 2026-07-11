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
 *   - fails on ANY critical advisory not in ALLOWLIST
 *   - fails on any allowlisted entry past its expiry (forces re-triage)
 *   - prints what was allowlisted so the log never reads as "clean"
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
  const allowByGhsa = new Map(ALLOWLIST.map((a) => [a.ghsa, a]));
  const expired = ALLOWLIST.filter((a) => a.expires <= today);
  if (expired.length) {
    console.error('❌ Expired dependency-audit allowlist entries (re-triage or extend with a reason):');
    for (const a of expired) console.error(`   ${a.ghsa} (${a.module}) expired ${a.expires}`);
    process.exit(1);
  }

  const failures = [];
  const allowedHits = new Set();
  for (const [name, vuln] of Object.entries(report.vulnerabilities || {})) {
    if (vuln.severity !== 'critical') continue;
    // Direct advisories on this package (objects in `via`); string entries are
    // transitive pointers to another vulnerability key and are judged there.
    const direct = (vuln.via || []).filter((v) => typeof v === 'object');
    const unallowed = direct.filter((v) => {
      const id = (v.url || '').split('/').pop();
      if (allowByGhsa.has(id)) { allowedHits.add(id); return false; }
      return true;
    });
    if (direct.length > 0 && unallowed.length > 0) {
      failures.push({ name, advisories: unallowed.map((v) => `${v.title} (${v.url})`) });
    }
    if (direct.length === 0) {
      // Purely transitive critical — allowed only if every root cause it
      // points at resolves to an allowlisted advisory. Walk one level.
      const roots = (vuln.via || []).filter((v) => typeof v === 'string');
      const rootAllowed = roots.every((r) => {
        const rv = report.vulnerabilities[r];
        return rv && (rv.via || []).filter((v) => typeof v === 'object')
          .every((v) => allowByGhsa.has((v.url || '').split('/').pop()));
      });
      if (!rootAllowed) failures.push({ name, advisories: [`transitive critical via ${roots.join(', ')}`] });
    }
  }

  if (allowedHits.size) {
    console.log('⚠️  Allowlisted critical advisories (NOT clean — tracked, unfixable today):');
    for (const id of allowedHits) {
      const a = allowByGhsa.get(id);
      console.log(`   ${id} (${a.module}) — ${a.reason} [expires ${a.expires}]`);
    }
  }

  if (failures.length) {
    console.error('❌ Critical advisories not in allowlist:');
    for (const f of failures) {
      console.error(`   ${f.name}:`);
      for (const adv of f.advisories) console.error(`     - ${adv}`);
    }
    process.exit(1);
  }

  console.log('✅ No unallowlisted critical advisories.');
}

main();
