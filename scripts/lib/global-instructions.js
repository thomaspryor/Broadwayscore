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
 * @returns {{installed: string[], unchanged: string[], skipped: {name, reason}[]}}
 */
async function installForCloud({ homeDir, fetchFn = fetchSourceFile } = {}) {
  const installed = [];
  const unchanged = [];
  const skipped = [];
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
    const body = renderInstalled(name, text);
    if (existing === body) { unchanged.push(name); continue; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
    installed.push(name);
  }
  return { installed, unchanged, skipped };
}

module.exports = {
  SOURCE_REPO,
  GLOBAL_FILES,
  MARKER,
  renderInstalled,
  fetchSourceFile,
  installForCloud,
};
