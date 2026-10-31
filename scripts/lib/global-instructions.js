'use strict';
/**
 * global-instructions.js — give cloud sessions the owner's global
 * instructions (BRO-4237).
 *
 * The owner's Mac loads ~/.claude/CLAUDE.md (+ anti-slop-rules.md), which
 * lives in the PRIVATE repo thomaspryor/claude-config. Cloud sessions (Claude
 * iPhone app, claude.ai, routines) have no ~/.claude, so for months they never
 * saw the rules that say who the owner is and how to work for them.
 *
 * Delivery (chosen by experiment, 2026-09-28, see BRO-4237): a
 * ~/.claude/CLAUDE.md written by a SessionStart hook is loaded natively at
 * startup by the session AND its subagents. Printed hook text is not
 * (subagents never see it; output over the cap becomes a 2 KB preview).
 *
 * Source (plan review + privacy): fetched at session start straight from the
 * private claude-config repo with the session's own GitHub token. No copy is
 * committed anywhere (Broadwayscore is public), and there is nothing to drift:
 * every session gets the current original. The owner edits only that
 * original; cloud-specific overrides live in its "## Cloud sessions" section.
 *
 * Fails open: no token / network / 404 -> nothing installed, one-line reason.
 * Never overwrites a ~/.claude file without the GENERATED marker (a real Mac
 * config or anyone's hand-written file).
 */

const fs = require('fs');
const path = require('path');

const SOURCE_REPO = 'thomaspryor/claude-config';
const GLOBAL_FILES = ['CLAUDE.md', 'anti-slop-rules.md'];
const MARKER = 'GENERATED from thomaspryor/claude-config';
const FETCH_TIMEOUT_MS = 8000;

/** Pure: what gets written to ~/.claude/<name>. */
function renderInstalled(name, content) {
  return `<!-- ${MARKER} (${name}) by the cloud session-start hook. The owner edits the original on their Mac; `
    + `this copy is rewritten at every cloud session start. -->\n${content}`;
}

// Owner-marked Mac-only blocks (BRO-5072): a line that is exactly
// `<!-- mac-only -->` opens one and `<!-- /mac-only -->` closes it. The
// Mac reads the original unchanged; the cloud copy drops these blocks so
// every cloud session stops paying for rules it is told to ignore.
const MAC_ONLY_OPEN = '<!-- mac-only -->';
const MAC_ONLY_CLOSE = '<!-- /mac-only -->';

/**
 * Pure: drop Mac-only blocks. Markers count only as whole lines (CRLF and
 * surrounding whitespace tolerated), so prose that mentions the convention is
 * never mistaken for one, nor is a marker inside a ``` fence. Any imbalance (nested open, stray close, unclosed
 * block) returns the text untouched with a warning: a bad marker must never
 * silently cut rules out of the cloud copy.
 * @returns {{text: string, removedLines: number, warning: string|null}}
 */
function stripMacOnly(text) {
  const lines = text.split('\n');
  const kept = [];
  let open = -1;
  let removed = 0;
  let inFence = false;
  for (const [i, line] of lines.entries()) {
    const t = line.trim();
    // A marker shown inside a ``` code example is text, not a marker.
    if (t.startsWith('```')) inFence = !inFence;
    if (inFence || t.startsWith('```')) {
      if (open === -1) kept.push(line); else removed++;
      continue;
    }
    if (t === MAC_ONLY_OPEN) {
      if (open !== -1) return { text, removedLines: 0, warning: `nested mac-only open at line ${i + 1}; not stripped` };
      open = i;
      removed++;
      continue;
    }
    if (t === MAC_ONLY_CLOSE) {
      if (open === -1) return { text, removedLines: 0, warning: `stray mac-only close at line ${i + 1}; not stripped` };
      open = -1;
      removed++;
      continue;
    }
    if (open === -1) kept.push(line); else removed++;
  }
  if (open !== -1) return { text, removedLines: 0, warning: `unclosed mac-only block from line ${open + 1}; not stripped` };
  return { text: kept.join('\n'), removedLines: removed, warning: null };
}

/** Default fetcher: raw file from the private source repo, null on any failure. */
async function fetchSourceFile(name, { token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.github.com/repos/${SOURCE_REPO}/contents/${encodeURIComponent(name)}?ref=main`, {
      headers: {
        Accept: 'application/vnd.github.raw',
        'User-Agent': 'bsc-global-instructions',
        ...(token ? { Authorization: `token ${token}` } : {}),
      },
      signal: controller.signal,
    });
    if (!res.ok) return { text: null, reason: `HTTP ${res.status}` };
    const text = await res.text();
    return text ? { text, reason: null } : { text: null, reason: 'empty body' };
  } catch (err) {
    return { text: null, reason: err.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : String(err.message).split('\n')[0] };
  } finally {
    clearTimeout(timer);
  }
}

function readIf(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

/**
 * Install every source file as homeDir/.claude/<name>.
 * @returns {{installed: string[], unchanged: string[], skipped: {name, reason}[], warnings: string[]}}
 */
async function installForCloud({ homeDir, fetchFn = fetchSourceFile } = {}) {
  const installed = [];
  const unchanged = [];
  const skipped = [];
  const warnings = [];
  // Fetch in parallel: startup waits at most one timeout, not one per file.
  const fetched = await Promise.all(GLOBAL_FILES.map((name) => {
    const existing = readIf(path.join(homeDir, '.claude', name));
    if (existing !== null && !existing.includes(MARKER)) return null;
    return fetchFn(name);
  }));
  for (const [i, name] of GLOBAL_FILES.entries()) {
    const dest = path.join(homeDir, '.claude', name);
    const existing = readIf(dest);
    if (existing !== null && !existing.includes(MARKER)) {
      skipped.push({ name, reason: 'hand-written file present, not overwriting' });
      continue;
    }
    const { text, reason } = fetched[i];
    if (text === null) { skipped.push({ name, reason: `fetch failed: ${reason}` }); continue; }
    const stripped = stripMacOnly(text);
    if (stripped.warning) warnings.push(`${name}: ${stripped.warning}`);
    const body = renderInstalled(name, stripped.text);
    if (existing === body) { unchanged.push(name); continue; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
    installed.push(name);
  }
  return { installed, unchanged, skipped, warnings };
}

module.exports = {
  SOURCE_REPO,
  GLOBAL_FILES,
  MARKER,
  renderInstalled,
  stripMacOnly,
  fetchSourceFile,
  installForCloud,
};
