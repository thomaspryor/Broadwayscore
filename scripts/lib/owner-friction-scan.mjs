// BRO-7881: find rule/skill text that pushes a technical approval, a "should I proceed" or a stale owner-only route onto
// the owner. The owner (non-technical) decides money, irreversible steps, public posts, emails to real people, product
// and taste calls, and what they explicitly chose (ALLOWLIST below, each with the owner decision). Everything else is
// the session's call (docs/owner-escalation.md).
//
//   node scripts/lib/owner-friction-scan.mjs            -> prints the hit list, exit 0 (advisory, CLAUDE.md §19)
//   node scripts/lib/owner-friction-scan.mjs --strict   -> exit 1 on any hit
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Phrasings that hand the owner a technical approval or point at a route the code no longer requires.
export const PATTERNS = [
  { id: 'should-i-proceed', re: /\bShould I (proceed|go ahead|continue)\b/i },
  { id: 'does-this-make-sense-ask', re: /\bDoes this approach make sense\?/i },
  { id: 'user-approving-plan', re: /\b(user|owner) is approving (THE )?plan\b/i },
  { id: 'after-user-approves-plan', re: /\bAfter the (user|owner) approves (a|the) plan\b/i },
  { id: 'revised-plan-ask', re: /Want to go with the revised plan/i },
  { id: 'ask-owner-to-approve', re: /\bask (the )?(owner|user) (to approve|for (their )?approval|for sign-?off)\b/i },
  { id: 'fail-needs-owner-override', re: /(overturning it is the owner's call|fail stands until an? `?owner-override)/i },
];

// Owner-chosen cases. A hit here is kept on purpose; `why` names the owner decision.
export const ALLOWLIST = [
  // (empty today: the owner-chosen asks, e.g. §20 substantial plans, social posts, email broadcasts, are written as
  // DECISION NEEDED / owner-decision text that none of PATTERNS matches.)
];

export function scanFiles(root = ROOT) {
  const files = ['CLAUDE.md', '.claude/CLOUD.md', 'docs/owner-escalation.md'];
  const cmdDir = path.join(root, '.claude', 'commands');
  if (existsSync(cmdDir)) for (const f of readdirSync(cmdDir).sort()) if (f.endsWith('.md')) files.push(`.claude/commands/${f}`);
  return files.filter((f) => existsSync(path.join(root, f)));
}

/** -> [{ file, line, id, text }] hits not covered by the allowlist. */
export function scan({ root = ROOT, files = null, read = (f) => readFileSync(path.join(root, f), 'utf8') } = {}) {
  const hits = [];
  for (const file of files || scanFiles(root)) {
    const lines = read(file).split('\n');
    lines.forEach((text, i) => {
      for (const p of PATTERNS) {
        if (!p.re.test(text)) continue;
        if (ALLOWLIST.some((a) => a.file === file && a.id === p.id)) continue;
        hits.push({ file, line: i + 1, id: p.id, text: text.trim().slice(0, 140) });
      }
    });
  }
  return hits;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const hits = scan();
  for (const h of hits) console.log(`${h.file}:${h.line} [${h.id}] ${h.text}`);
  console.log(`owner-friction-scan: ${hits.length} hit(s) across ${scanFiles().length} file(s)${hits.length ? '' : ' (clean)'}`);
  process.exit(process.argv.includes('--strict') && hits.length ? 1 : 0);
}
