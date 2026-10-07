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
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
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

// The draft this run is checking. Honor NEWSLETTER_OUT_DIR so the test works in
// CI (workspace) and locally (~/Documents/claude-outputs/newsletter-mocks).
const outDir = process.env.NEWSLETTER_OUT_DIR
  || path.join(process.env.HOME || '', 'Documents/claude-outputs/newsletter-mocks');
const draftMetaPath = path.join(outDir, `A-${weekStart}.meta.json`);

// Re-run the generator INTO A THROWAWAY DIRECTORY, never over the real draft.
//
// This step runs AFTER pre-send-check.mjs in newsletter-draft.yml, and
// pre-send-check may have regenerated the draft with NEWSLETTER_EXCLUDE_SHOWS +
// an editorial lead to apply a coverage swap — env only IT sets, which this
// process cannot reconstruct. A regeneration in place therefore silently undid
// the swap: the gapped opening came back, its banner disappeared, and the
// `|| echo ::warning::` wrapper in the workflow swallowed any complaint, so the
// owner's preview and the Resend draft carried content the gates had already
// rejected. (Latent until now only because a first-run week has no fixture and
// this script exits before the spawn.) Writing elsewhere removes the whole
// class — the finished draft is read-only from here on — and makes the env
// threading the workflow does for this step belt-and-braces rather than
// load-bearing.
//
// The edition is still pinned, so the comparison meta is the same edition as
// the draft. Anchor order is deliberately NOT "fixture first": fixtures are
// keyed by WEEK, not edition (one <weekStart>.meta.json for both), and the
// documented re-baseline copies a generated meta straight in — so once anyone
// re-baselines from a Broadway run, a fixture-first pin would make that week's
// West End run compare against Broadway output.
const cjsRequire = createRequire(import.meta.url);
const { resolveNewsletterEdition } = cjsRequire(path.join(repoRoot, 'scripts/lib/email-templates.js'));
let draftEditionOnDisk = null;
try { draftEditionOnDisk = JSON.parse(fs.readFileSync(draftMetaPath, 'utf8')).edition || null; } catch { /* no draft yet — fall through */ }
const pinnedEdition = draftEditionOnDisk
  || (process.env.NEWSLETTER_EDITION ? resolveNewsletterEdition(process.env.NEWSLETTER_EDITION) : 'broadway');

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newsletter-regression-'));
const actualMetaPath = path.join(outDir, `A-${weekStart}.regression-actual.meta.json`);
const metaPath = path.join(scratchDir, `A-${weekStart}.meta.json`);

// NEWSLETTER_OUT_DIR does not redirect everything generate.mjs writes: it also
// UPSERTs the cross-issue de-dup state. This throwaway re-run has no
// NEWSLETTER_EXCLUDE_SHOWS, so letting it touch data/newsletter-state.json
// would overwrite this week's row with the UNSWAPPED featured/mover ids — and
// newsletter-draft.yml commits that file two steps later, so next week's
// suppression would reflect an issue that was never sent (code-review MEDIUM,
// 2026-08-09).
//
// Point the re-run at a scratch copy inside scratchDir instead (BRO-2606). This
// replaces a snapshot-and-restore of the real file, which fixed the overwrite
// but introduced a worse one: the restore wrote the pre-spawn bytes back
// unconditionally, so a legitimate concurrent write — another session, a
// parallel workflow — landing during the re-run was silently erased. Not
// writing the file at all has no such window. Seeded from the real state so the
// comparison run reads the same suppression history the draft run did.
const statePath = path.join(repoRoot, 'data/newsletter-state.json');
const scratchStatePath = path.join(scratchDir, 'newsletter-state.json');
try { fs.copyFileSync(statePath, scratchStatePath); } catch { /* absent — the re-run starts with no memory, same as the draft run would */ }

const cleanup = () => { try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* no-op */ } };

let current;
try {
  execFileSync('node', [path.join(__dirname, 'generate.mjs'), weekStart], {
    cwd: repoRoot,
    env: { ...process.env, NEWSLETTER_EDITION: pinnedEdition, NEWSLETTER_OUT_DIR: scratchDir, NEWSLETTER_STATE_PATH: scratchStatePath },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (!fs.existsSync(metaPath)) {
    console.error(`Generator did not produce ${metaPath}`);
    cleanup();
    process.exit(2);
  }
  current = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  // Keep the comparison meta next to the draft so the re-baseline hint below
  // points at something that still exists AND matches what was compared. The
  // draft's own meta can differ (pre-send-check may have swapped a gapped show
  // out of it); copying THAT into the fixture would bake in a diff the next
  // unswapped run fails on again (code-review MEDIUM, 2026-08-09).
  try { fs.copyFileSync(metaPath, actualMetaPath); } catch { /* best effort */ }
} catch (err) {
  // A generator crash is an I/O failure (exit 2), not a baseline mismatch
  // (exit 1) — the workflow's `|| echo "no fixture yet"` would otherwise
  // report a crash to the owner as a routine first-run skip.
  console.error(`Generator failed: ${err && err.message}`);
  cleanup();
  process.exit(2);
} finally {
  // Delete inline, as soon as the meta is in memory. An exit-event handler
  // would not run on SIGINT/SIGTERM — the way a cancelled Saturday workflow
  // actually dies — and would leave /tmp/newsletter-regression-* behind. The
  // scratch state file lives inside scratchDir, so this removes it too.
  cleanup();
}

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
// Re-baseline from what was actually COMPARED, not from the draft: after a
// coverage swap those differ, and copying the draft would bake in a diff the
// next (unswapped) run fails on again.
console.error(`  cp ${actualMetaPath} ${fixturePath}`);
process.exit(1);
