'use strict';
/**
 * Cloud parity comparison (BRO-4239). Pure logic: reads a manifest of
 * repo-dir / ~/.claude-dir pairs and reports files whose two copies differ.
 * A file missing from the global side is "unverified", never drift: cloud
 * sessions have no Mac masters to compare against.
 */
const fs = require('fs');
const path = require('path');

const MODES = ['exact', 'strip-self-skip'];

function parseManifest(text) {
  let m;
  try { m = JSON.parse(text); } catch (e) { throw new Error(`cloud-parity manifest is not valid JSON: ${e.message}`); }
  if (!m || !Array.isArray(m.pairs) || m.pairs.length === 0) throw new Error('cloud-parity manifest needs a non-empty "pairs" array');
  for (const p of m.pairs) {
    for (const k of ['name', 'repoDir', 'globalDir', 'pattern']) {
      if (typeof p[k] !== 'string' || !p[k]) throw new Error(`cloud-parity pair ${JSON.stringify(p.name || p)} is missing "${k}"`);
    }
    if (!p.pattern.startsWith('*.')) throw new Error(`cloud-parity pair "${p.name}": pattern must look like "*.ext"`);
    if (p.mode === undefined) p.mode = 'exact';
    if (!MODES.includes(p.mode)) throw new Error(`cloud-parity pair "${p.name}": mode must be one of ${MODES.join('|')}`);
  }
  return m;
}

// The repo-only guard that exits when the Mac master exists. It names its own
// hook, by $(basename "$0") or by file name, and sits at column 0, so a check
// on some other ~/.claude/hooks/ path (hooks/lib/...) is never mistaken for it.
const GUARD_RE = /^if \[ -f "\$HOME\/\.claude\/hooks\/(\$\(basename "\$0"\)|[A-Za-z0-9_.-]+\.sh)" \]/;
const ONE_LINE_GUARD_RE = /;\s*then\s+exit 0\s*;\s*fi\s*$/;

// Drops the first guard, anchored on the guard itself (BRO-4239 follow-up).
// Covers the multi-line form, the one-line form (check-skill-redaction.sh)
// and a guard with no "# Self-skip" comment (block-prompting-remote-tools.sh).
// Its comment goes too, but only when it sits in the run of comment/blank
// lines directly above the guard: notion-create-block.sh has real code
// between its "# Self-skip" note and the guard, and that code is compared.
// A master without the guard comes back unchanged.
function stripSelfSkip(text) {
  const lines = text.split('\n');
  const guard = lines.findIndex((l) => GUARD_RE.test(l));
  if (guard < 0) return text;
  let end = guard;
  if (!ONE_LINE_GUARD_RE.test(lines[guard])) {
    end = lines.findIndex((l, i) => i > guard && /^fi\s*$/.test(l));
    if (end < 0) return text;
  }
  let start = guard;
  let top = guard;
  while (top > 0 && /^\s*(#.*)?$/.test(lines[top - 1])) top--;
  const note = lines.slice(top, guard).findIndex((l) => /^#.*Self-skip/.test(l));
  if (note >= 0) start = top + note;
  return [...lines.slice(0, start), ...lines.slice(end + 1)].join('\n');
}

function normalize(text, mode) {
  return mode === 'strip-self-skip' ? stripSelfSkip(text) : text;
}

function compareManifest(manifest, { repoRoot, claudeHome }) {
  const drifted = [];
  const missingGlobal = [];
  let compared = 0;
  for (const p of manifest.pairs) {
    const repoDir = path.join(repoRoot, p.repoDir);
    const globalDir = path.join(claudeHome, p.globalDir);
    const ext = p.pattern.slice(1);
    if (!fs.existsSync(repoDir)) continue;
    for (const f of fs.readdirSync(repoDir).filter((n) => n.endsWith(ext)).sort()) {
      const rel = `${p.repoDir}/${f}`;
      const gp = path.join(globalDir, f);
      if (!fs.existsSync(gp)) { missingGlobal.push(rel); continue; }
      compared++;
      const a = normalize(fs.readFileSync(path.join(repoDir, f), 'utf8'), p.mode);
      const b = normalize(fs.readFileSync(gp, 'utf8'), p.mode);
      if (a !== b) drifted.push(rel);
    }
  }
  return { compared, drifted, missingGlobal, checkable: fs.existsSync(claudeHome) && compared > 0 };
}

function buildAlert(result) {
  const list = result.drifted.map((d) => `- ${d}`).join('\n');
  return {
    conditionKey: 'cloud-parity-drift',
    title: `Cloud parity drift: ${result.drifted.length} repo cop${result.drifted.length === 1 ? 'y differs' : 'ies differ'} from ~/.claude`,
    description: `These repo files differ from their ~/.claude masters. Cloud sessions run only the repo copy:\n${list}\n\nMerge best-of-both, make both sides identical, commit the repo side and claude-sync push.`,
    severity: 'warning',
    disposition: 'digest',
  };
}

module.exports = { GUARD_RE, parseManifest, stripSelfSkip, compareManifest, buildAlert };
