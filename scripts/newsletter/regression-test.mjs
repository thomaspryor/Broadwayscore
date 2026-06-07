// Newsletter regression test — compares THIS week's generator output against
// a frozen baseline meta.json. Catches the most common silent breakage modes:
//
//   1. A section that USED to fire now silently returns null (skipped).
//   2. A section's rendered HTML shrinks > 50% (a data shape change wiped out
//      a row, or a guard kicked in too aggressively).
//   3. A section disappeared from the registry entirely.
//
// This is intentionally NOT a raw-HTML diff: HTML diffs are flaky (whitespace,
// attribute ordering, dynamic timestamps), and meta-level invariants catch the
// failure classes that actually matter without false positives.
//
// Fixture lives at tests/newsletter/fixtures/<weekStart>.meta.json. To re-baseline
// after an INTENTIONAL change:
//   node scripts/newsletter/generate.mjs <weekStart>
//   cp ~/Documents/claude-outputs/newsletter-mocks/A-<weekStart>.meta.json \
//      tests/newsletter/fixtures/<weekStart>.meta.json
//
// Exit codes: 0 pass · 1 baseline mismatch · 2 missing fixture / I/O failure.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Resolve fixture relative to this file (works in worktree + main checkout).
// The generator's runtime data still has to come from the main repo, so
// generate.mjs hardcodes that path itself.
const repoRoot = path.resolve(__dirname, '..', '..');
const weekStart = process.argv[2] || '2026-05-18';
const fixturePath = path.join(repoRoot, 'tests/newsletter/fixtures', `${weekStart}.meta.json`);

if (!fs.existsSync(fixturePath)) {
  console.error(`No fixture for week ${weekStart} at ${fixturePath}`);
  process.exit(2);
}

const baseline = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

// Re-run the generator. Its stderr/stdout are noisy; we just need the meta.
// Honor NEWSLETTER_OUT_DIR so the test works in CI (workspace) and locally
// (~/Documents/claude-outputs/newsletter-mocks).
const outDir = process.env.NEWSLETTER_OUT_DIR
  || path.join(process.env.HOME || '', 'Documents/claude-outputs/newsletter-mocks');
const metaPath = path.join(outDir, `A-${weekStart}.meta.json`);

execFileSync('node', [path.join(__dirname, 'generate.mjs'), weekStart], {
  cwd: repoRoot,
  stdio: ['ignore', 'pipe', 'inherit'],
});

if (!fs.existsSync(metaPath)) {
  console.error(`Generator did not produce ${metaPath}`);
  process.exit(2);
}
const current = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

const failures = [];

// Invariant 1: every section that fired in baseline must still fire.
const baselineByName = new Map(baseline.sections.map((s) => [s.name, s]));
const currentByName = new Map(current.sections.map((s) => [s.name, s]));

for (const [name, bs] of baselineByName) {
  const cs = currentByName.get(name);
  if (!cs) {
    failures.push(`section "${name}" disappeared from registry`);
    continue;
  }
  if (bs.fired && !cs.fired) {
    failures.push(`section "${name}" was firing but is now SKIPPED (${cs.skipReason})`);
  }
  // Invariant 2: htmlLength should be within ±50% of baseline. A section
  // whose body suddenly halves or doubles is almost certainly a regression.
  if (bs.fired && cs.fired && bs.htmlLength > 0) {
    const ratio = cs.htmlLength / bs.htmlLength;
    if (ratio < 0.5 || ratio > 2.0) {
      failures.push(
        `section "${name}" htmlLength shifted ${(ratio * 100).toFixed(0)}% of baseline (was ${bs.htmlLength}, now ${cs.htmlLength})`
      );
    }
  }
}

// Invariant 3: subject must be non-empty and ≤ 80 chars.
if (!current.subject) {
  failures.push('subject is empty');
} else if (current.subject.length > 80) {
  failures.push(`subject too long (${current.subject.length} chars, max 80)`);
}

if (failures.length === 0) {
  console.log(`✓ newsletter regression OK for week ${weekStart}`);
  console.log(`  ${current.sections.filter(s => s.fired).length} sections fired`);
  console.log(`  subject: ${current.subject}`);
  process.exit(0);
}

console.error(`✗ newsletter regression FAILED for week ${weekStart}:`);
for (const f of failures) console.error(`  - ${f}`);
console.error(`\nIf the change was intentional, re-baseline with:`);
console.error(`  cp ${metaPath} ${fixturePath}`);
process.exit(1);
