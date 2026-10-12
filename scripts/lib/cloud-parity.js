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

// Drops the repo-only guard block: from the first line STARTING with "# Self-skip" to the next
// line that is exactly "fi". Anchored and first-block-only (unlike the shell sed, which also
// matched a mid-file comment mentioning the marker and hid everything after it).
function stripSelfSkip(text) {
  const out = [];
  let state = 0; // 0 before, 1 inside, 2 done
  for (const line of text.split('\n')) {
    if (state === 0 && line.startsWith('# Self-skip')) state = 1;
    if (state === 1) { if (line === 'fi') state = 2; continue; }
    out.push(line);
  }
  return out.join('\n');
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

module.exports = { parseManifest, stripSelfSkip, compareManifest, buildAlert };
