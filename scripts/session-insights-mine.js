#!/usr/bin/env node
/**
 * session-insights-mine.js — self-maintaining session-insights pipeline.
 *
 * Replaces the abandoned weekly-session-insights.js / iCloud-digest flow,
 * which dead-ended at "Tom reviews a markdown file on his phone." That
 * forcing function never fires; drafts pile up unread.
 *
 * THE LOOP (no Sunday-night review required):
 *
 *   1. HOURLY via launchd (com.bwsc.session-insights-mine).
 *   2. Incrementally scan ~/.claude/projects/-Users-tompryor-Broadwayscore/*.jsonl
 *      modified since the last successful run.
 *   3. Pattern detection (3 kinds):
 *        - repeated-lookup: same Read/Grep target hit N times in a session
 *        - recurring-error: same error signature appearing in N sessions
 *        - correction: user push-back against an assistant action
 *   4. PER-PATTERN STATE in ~/.claude/insights-state.json
 *      Each pattern accumulates occurrence count + a Set of session IDs.
 *   5. AUTO-DRAFT when a deterministic pattern (lookup / error) crosses
 *      its threshold (>=2 distinct sessions). Templated markdown written
 *      to memory/inbox/feedback_<slug>.md. No LLM call. Deterministic.
 *      Same signature already in memory/ → skipped (system self-prunes).
 *   6. CORRECTIONS go to an append-only timeline: memory/correction-log.md.
 *      They're not auto-promoted — interpretation is too subjective —
 *      but they ARE captured, dated, and tied to session IDs for later
 *      "remember this rule" conversations.
 *   7. AUTO-PROMOTE drafts that have been in memory/inbox/ for >=7 days
 *      WITHOUT being edited (mtime ~= drafted_at). Move the file out of
 *      inbox/ into memory/ proper, mark `status:promoted`. If Tom edited
 *      the draft, status becomes `manual-curated` — he's signaling
 *      hands-off — and auto-promote is disabled for that entry.
 *   8. SELF-CLEANUP: drafts older than 30 days with status `manual-curated`
 *      or unchanged-but-deleted get expired from state.
 *
 * The user-visible surface:
 *   - memory/inbox/feedback_<slug>.md   (candidates)
 *   - memory/feedback_<slug>.md          (promoted)
 *   - memory/correction-log.md           (timeline of pushback, dated)
 *   - MEMORY.md is NOT auto-edited — promotion logs a reminder to run
 *     scripts/rebuild-memory-index.js (kept manual; index is high-stakes).
 *
 * Privacy: same iCloud-not-applicable design. Writes go to the canonical
 * memory dir (synced to repo cloud-memory/ via session-stop.sh). Secret
 * patterns redacted before write.
 *
 * Sunset: this script self-disables only by manual launchctl unload.
 *   launchctl unload ~/Library/LaunchAgents/com.bwsc.session-insights-mine.plist
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const SESSIONS_DIR = path.join(os.homedir(), '.claude/projects/-Users-tompryor-Broadwayscore');
const MEMORY_DIR = path.join(SESSIONS_DIR, 'memory');
const INBOX_DIR = path.join(MEMORY_DIR, 'inbox');
const STATE_FILE = path.join(os.homedir(), '.claude/insights-state.json');
const CORRECTION_LOG = path.join(MEMORY_DIR, 'correction-log.md');
const LOG_DIR = path.join(os.homedir(), 'Library/Logs');
const LOG_FILE = path.join(LOG_DIR, 'bwsc-session-insights-mine.log');

const THRESHOLD_SESSIONS = 3;       // require >=3 distinct sessions before drafting
const LOOKUP_MIN_HITS_PER_SESSION = 8;   // a single-session lookup hits this often before it counts
const ERROR_MIN_HITS_PER_SESSION = 3;
const ERROR_MIN_SIG_CHARS = 25;     // skip "Error" / "TypeError" alone
const PROMOTE_AFTER_DAYS = 7;
const EXPIRE_AFTER_DAYS = 30;
const EDIT_GRACE_MS = 60 * 1000;
const MAX_DRAFTS_PER_RUN = 10;      // cap throughput so the inbox grows as a stream not a flood

// Routine paths that produce noise more than signal as "repeated lookups".
// We Read these all the time in normal Claude Code operation; they aren't
// memorable patterns worth a memory entry.
const LOOKUP_PATH_BLOCKLIST = [
  /^\.claude\//,
  /^cloud-memory\//,
  /^memory\//,
  /^\/tmp\//,
  /node_modules\//,
  /^~\/\.claude\//,
  /\/MEMORY\.md$/,
  /\/CLAUDE\.md$/,
  /\/correction-log\.md$/,
];

// Generic error fragments that match the ERROR_RE but contain no useful
// signal on their own. The substring check is intentional (substring,
// not regex equality) — we still want to capture "Error: Cannot find module foo"
// while rejecting bare "Error".
const ERROR_SIGNATURE_BLOCKLIST = [
  /^### Error\b/,
  /^Error\s*$/,
  /^Error: \s*$/,
  /^FAILED\s*$/,
  /^\s*at\s/,                    // stack trace internals
];

const SECRET_PATTERNS = [
  [/\b(Bearer\s+)[A-Za-z0-9._\-]{20,}/g, '$1<REDACTED>'],
  [/\bsk-[A-Za-z0-9_\-]{20,}/g, 'sk-<REDACTED>'],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g, '$1_<REDACTED>'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA<REDACTED>'],
  [/\b(xox[abopr])-[A-Za-z0-9-]{10,}/g, '$1-<REDACTED>'],
  [/(api[_-]?key["\s:=]{1,5})[A-Za-z0-9._\-]{20,}/gi, '$1<REDACTED>'],
];
function scrub(s) {
  if (!s) return s;
  let out = s;
  for (const [re, sub] of SECRET_PATTERNS) out = out.replace(re, sub);
  return out;
}

const CORRECTION_PATTERNS = [
  /\bno+,?\s+(?:don'?t|stop|that'?s\s+wrong|wrong)/i,
  /\bstop\s+(?:doing|that|using)/i,
  /\bdon'?t\s+(?:use|do|run|call|edit|touch|create)/i,
  /\bdo not\s+(?:use|do|run|call|edit|touch|create)/i,
  /\bactually,?\s+(?:we|i|you)\b/i,
  /\bnever\s+(?:do|use|run|call)/i,
  /\bwhy\s+(?:did|are)\s+you\b/i,
  /\bthat'?s\s+not\s+(?:what|right|correct)/i,
  /\bnot\s+like\s+that/i,
];

const ERROR_RE = /\b(Error|TypeError|ReferenceError|SyntaxError|EACCES|ENOENT|ECONNREFUSED|fatal|FAILED|Cannot find|is not a function|is not defined)\b[^\n]{0,160}/;

function nowIso() { return new Date().toISOString(); }
function log(msg) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${nowIso()}] ${msg}\n`);
  } catch {}
  if (process.stdout.isTTY) console.log(msg);
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { lastScan: null, patterns: {} };
  }
}
function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function hashKey(parts) {
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);
}

function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function listSessionFiles(sinceIso) {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  const cutoff = sinceIso ? new Date(sinceIso) : new Date(0);
  return fs.readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => path.join(SESSIONS_DIR, f))
    .filter(p => {
      try { return fs.statSync(p).mtime > cutoff; } catch { return false; }
    });
}

function* readEvents(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch {}
  }
}

function userText(event) {
  if (event.type !== 'user') return null;
  const content = event.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(c => c?.type === 'text').map(c => c.text || '').join('\n');
  }
  return null;
}

function processSession(filePath, state) {
  const sessionId = path.basename(filePath, '.jsonl');
  const events = [...readEvents(filePath)];
  if (events.length === 0) return { corrections: 0, lookupsBumped: 0, errorsBumped: 0 };

  const lookupCounts = new Map();
  const errorCounts = new Map();
  let corrections = 0;

  for (let i = 0; i < events.length; i++) {
    const e = events[i];

    if (e.type === 'user') {
      const text = userText(e);
      if (text && text.length >= 4 && text.length <= 2000) {
        const matched = CORRECTION_PATTERNS.find(re => re.test(text));
        if (matched) {
          appendCorrectionLog({
            sessionId,
            text: scrub(text.trim().slice(0, 400)),
            ts: e.timestamp || nowIso(),
          });
          corrections++;
        }
      }
      const content = e.message?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c?.type !== 'tool_result') continue;
          let body = c.content;
          if (Array.isArray(body)) body = body.filter(p => p?.type === 'text').map(p => p.text || '').join('\n');
          if (typeof body !== 'string') continue;
          for (const line of body.split('\n')) {
            const m = line.match(ERROR_RE);
            if (!m || line.length >= 240) continue;
            const sig = scrub(line.trim().slice(0, 200));
            if (sig.length < ERROR_MIN_SIG_CHARS) continue;
            if (ERROR_SIGNATURE_BLOCKLIST.some(re => re.test(sig))) continue;
            errorCounts.set(sig, (errorCounts.get(sig) || 0) + 1);
          }
        }
      }
    }

    if (e.type === 'assistant') {
      const content = e.message?.content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (c?.type !== 'tool_use') continue;
        if (c.name === 'Read' && c.input?.file_path) {
          const normalized = normalizeReadPath(c.input.file_path);
          if (LOOKUP_PATH_BLOCKLIST.some(re => re.test(normalized))) continue;
          lookupCounts.set(normalized, (lookupCounts.get(normalized) || 0) + 1);
        }
      }
    }
  }

  let lookupsBumped = 0;
  for (const [target, hits] of lookupCounts) {
    if (hits < LOOKUP_MIN_HITS_PER_SESSION) continue;
    bumpPattern(state, {
      kind: 'repeated-lookup',
      key: hashKey(['lookup', target]),
      signature: target,
      sessionId,
      occurrences: hits,
    });
    lookupsBumped++;
  }
  let errorsBumped = 0;
  for (const [sig, hits] of errorCounts) {
    if (hits < ERROR_MIN_HITS_PER_SESSION) continue;
    bumpPattern(state, {
      kind: 'recurring-error',
      key: hashKey(['error', sig]),
      signature: sig,
      sessionId,
      occurrences: hits,
    });
    errorsBumped++;
  }

  return { corrections, lookupsBumped, errorsBumped };
}

function normalizeReadPath(p) {
  // Worktree paths look like /Users/.../Broadwayscore/.claude/worktrees/<name>/src/foo.tsx
  // — collapse them to /src/foo.tsx so the same logical file across worktrees
  // counts as one pattern.
  const wt = p.match(/\.claude\/worktrees\/[^/]+\/(.*)$/);
  if (wt) return wt[1];
  const rel = p.match(/Broadwayscore\/(.*)$/);
  if (rel) return rel[1];
  const home = p.replace(os.homedir(), '~');
  return home;
}

function bumpPattern(state, { kind, key, signature, sessionId, occurrences }) {
  const existing = state.patterns[key];
  if (!existing) {
    state.patterns[key] = {
      kind, signature,
      sessions: [sessionId],
      totalOccurrences: occurrences,
      firstSeen: nowIso(),
      lastSeen: nowIso(),
      status: 'noted',
      draftPath: null,
      draftedAt: null,
      promotedAt: null,
    };
    return;
  }
  if (!existing.sessions.includes(sessionId)) {
    existing.sessions.push(sessionId);
  }
  existing.totalOccurrences += occurrences;
  existing.lastSeen = nowIso();
}

function appendCorrectionLog({ sessionId, text, ts }) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  if (!fs.existsSync(CORRECTION_LOG)) {
    fs.writeFileSync(CORRECTION_LOG, `# Correction log\n\nAppend-only timeline of user push-back across sessions. Auto-maintained by \`scripts/session-insights-mine.js\`. Interpretation is yours: scan this when you want to remember "what was Claude doing wrong recently?"\n\n`);
  }
  // Cheap dedup: skip if the exact text was logged in the last 1KB.
  try {
    const stat = fs.statSync(CORRECTION_LOG);
    const tailStart = Math.max(0, stat.size - 8192);
    const fd = fs.openSync(CORRECTION_LOG, 'r');
    const buf = Buffer.alloc(stat.size - tailStart);
    fs.readSync(fd, buf, 0, buf.length, tailStart);
    fs.closeSync(fd);
    if (buf.toString('utf8').includes(text)) return;
  } catch {}
  const entry = `## ${ts} — session ${sessionId.slice(0, 8)}\n\n> ${text.replace(/\n/g, '\n> ')}\n\n`;
  fs.appendFileSync(CORRECTION_LOG, entry);
}

function memoryHasSignature(signatureSlug) {
  if (!fs.existsSync(MEMORY_DIR)) return false;
  try {
    const files = fs.readdirSync(MEMORY_DIR).filter(f => f.endsWith('.md'));
    return files.some(f => f.toLowerCase().includes(signatureSlug.toLowerCase().slice(0, 20)));
  } catch { return false; }
}

function draftLookup(pattern) {
  const baseName = pattern.signature.split('/').pop().replace(/\.[^.]+$/, '');
  const slug = `lookup-${slugify(baseName)}`;
  if (memoryHasSignature(slug)) return null;
  fs.mkdirSync(INBOX_DIR, { recursive: true });
  const filePath = path.join(INBOX_DIR, `feedback_${slug}.md`);
  const body = `---
name: ${slug}
description: Recurring lookup — ${pattern.signature} read ${pattern.totalOccurrences}× across ${pattern.sessions.length} sessions
metadata:
  type: project
  auto-drafted: ${nowIso()}
  source: session-insights-mine
  sessions: ${pattern.sessions.length}
  occurrences: ${pattern.totalOccurrences}
---

\`${pattern.signature}\` was read ${pattern.totalOccurrences} times across ${pattern.sessions.length} distinct sessions. Anyone working on adjacent functionality should start there.

**Auto-drafted by \`scripts/session-insights-mine.js\`** after the lookup hit the cross-session threshold. Promotes to \`memory/${path.basename(filePath)}\` in ${PROMOTE_AFTER_DAYS} days if untouched. Edit this file to disable auto-promote and manual-curate. Delete to reject.
`;
  fs.writeFileSync(filePath, body);
  return filePath;
}

function draftError(pattern) {
  const slug = `error-${slugify(pattern.signature).slice(0, 40)}`;
  if (memoryHasSignature(slug)) return null;
  fs.mkdirSync(INBOX_DIR, { recursive: true });
  const filePath = path.join(INBOX_DIR, `feedback_${slug}.md`);
  const body = `---
name: ${slug}
description: Recurring error — "${pattern.signature.slice(0, 80)}" hit ${pattern.totalOccurrences}× across ${pattern.sessions.length} sessions
metadata:
  type: project
  auto-drafted: ${nowIso()}
  source: session-insights-mine
  sessions: ${pattern.sessions.length}
  occurrences: ${pattern.totalOccurrences}
---

This error keeps appearing across multiple sessions:

\`\`\`
${pattern.signature}
\`\`\`

**${pattern.totalOccurrences} occurrences across ${pattern.sessions.length} distinct sessions.** Either the root cause is fixed and stale logs are surfacing it, or there's a chronic problem worth a memory entry with the workaround.

**Auto-drafted by \`scripts/session-insights-mine.js\`**. Edit to add the fix/explanation, then it will auto-promote to \`memory/${path.basename(filePath)}\` in ${PROMOTE_AFTER_DAYS} days. Delete if not actionable.
`;
  fs.writeFileSync(filePath, body);
  return filePath;
}

function draftEligible(state) {
  // Process eligible patterns in priority order (more sessions first → strongest
  // signal first). This way the per-run cap retains the highest-confidence drafts.
  const eligible = Object.entries(state.patterns)
    .filter(([, p]) => p.status === 'noted' && p.sessions.length >= THRESHOLD_SESSIONS)
    .sort(([, a], [, b]) => b.sessions.length - a.sessions.length);

  let drafted = 0;
  for (const [key, pattern] of eligible) {
    if (drafted >= MAX_DRAFTS_PER_RUN) {
      log(`Hit MAX_DRAFTS_PER_RUN=${MAX_DRAFTS_PER_RUN}; ${eligible.length - drafted} eligible patterns deferred to next run`);
      break;
    }

    let draftPath = null;
    if (pattern.kind === 'repeated-lookup') draftPath = draftLookup(pattern);
    else if (pattern.kind === 'recurring-error') draftPath = draftError(pattern);
    else continue;

    if (draftPath === null) {
      pattern.status = 'already-known';
      log(`Pattern ${key} (${pattern.kind}) matches existing memory; marking already-known`);
      continue;
    }
    pattern.status = 'drafted';
    pattern.draftPath = draftPath;
    pattern.draftedAt = nowIso();
    drafted++;
    log(`Drafted ${pattern.kind}: ${draftPath}`);
  }
  return drafted;
}

function promoteEligible(state) {
  let promoted = 0;
  let curated = 0;
  let expired = 0;
  const nowMs = Date.now();
  for (const [key, pattern] of Object.entries(state.patterns)) {
    if (pattern.status !== 'drafted') continue;
    if (!pattern.draftPath || !pattern.draftedAt) continue;

    const ageMs = nowMs - new Date(pattern.draftedAt).getTime();
    const ageDays = ageMs / 86400_000;

    if (!fs.existsSync(pattern.draftPath)) {
      // Tom deleted the draft — explicit reject.
      pattern.status = 'rejected';
      log(`Pattern ${key} draft was deleted; marking rejected`);
      continue;
    }

    let editedAfterDraft = false;
    try {
      const mtimeMs = fs.statSync(pattern.draftPath).mtime.getTime();
      const draftedAtMs = new Date(pattern.draftedAt).getTime();
      editedAfterDraft = mtimeMs > draftedAtMs + EDIT_GRACE_MS;
    } catch {}

    if (editedAfterDraft) {
      pattern.status = 'manual-curated';
      log(`Pattern ${key} draft was edited; marking manual-curated (auto-promote disabled)`);
      curated++;
      continue;
    }

    if (ageDays < PROMOTE_AFTER_DAYS) continue;

    // Promote: move file from inbox/ to memory/.
    const promotedPath = path.join(MEMORY_DIR, path.basename(pattern.draftPath));
    if (fs.existsSync(promotedPath)) {
      // Collision — something with the same name already in memory. Mark to surface.
      pattern.status = 'collision';
      log(`Pattern ${key} would collide with ${promotedPath}; marking collision`);
      continue;
    }
    fs.renameSync(pattern.draftPath, promotedPath);
    pattern.status = 'promoted';
    pattern.draftPath = promotedPath;
    pattern.promotedAt = nowIso();
    promoted++;
    log(`Promoted ${pattern.kind} → ${promotedPath}`);
  }
  // Expire long-dead manual-curated entries; we already decided hands-off.
  for (const [key, pattern] of Object.entries(state.patterns)) {
    if (pattern.status !== 'manual-curated') continue;
    const ageMs = nowMs - new Date(pattern.draftedAt || pattern.lastSeen).getTime();
    if (ageMs > EXPIRE_AFTER_DAYS * 86400_000) {
      pattern.status = 'expired';
      expired++;
    }
  }
  return { promoted, curated, expired };
}

function main() {
  log('--- session-insights-mine start ---');
  const state = loadState();
  const sessionFiles = listSessionFiles(state.lastScan);
  log(`Scanning ${sessionFiles.length} session files modified since ${state.lastScan || 'epoch'}`);

  let totals = { corrections: 0, lookupsBumped: 0, errorsBumped: 0 };
  for (const f of sessionFiles) {
    try {
      const r = processSession(f, state);
      totals.corrections += r.corrections;
      totals.lookupsBumped += r.lookupsBumped;
      totals.errorsBumped += r.errorsBumped;
    } catch (err) {
      log(`session ${path.basename(f)} processing failed: ${err.message}`);
    }
  }

  const drafted = draftEligible(state);
  const { promoted, curated, expired } = promoteEligible(state);

  state.lastScan = nowIso();
  saveState(state);

  log(`Done. corrections-logged=${totals.corrections} lookup-bumps=${totals.lookupsBumped} error-bumps=${totals.errorsBumped} drafted=${drafted} promoted=${promoted} edited-skipped=${curated} expired=${expired}`);
  if (promoted > 0) {
    log(`MEMORY.md is stale. Run: node scripts/rebuild-memory-index.js > /tmp/idx.md && diff cloud-memory/MEMORY.md /tmp/idx.md`);
  }
}

if (require.main === module) {
  try { main(); } catch (err) {
    log(`FATAL: ${err.message}\n${err.stack}`);
    process.exit(1);
  }
}
