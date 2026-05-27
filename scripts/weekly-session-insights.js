#!/usr/bin/env node
/**
 * weekly-session-insights.js — Mine the last 7 days of Claude Code session
 * transcripts for recurring patterns that should become memory entries.
 *
 * No LLM calls. Pure text analysis. Cost: $0.
 *
 * Inputs:  ~/.claude/projects/-Users-tompryor-Broadwayscore/*.jsonl
 *          (Each line is one JSON event from a session: user, assistant, tool result.)
 *
 * Output:  ~/Documents/claude-outputs/insights-week-YYYY-MM-DD.md
 *          Skipped entirely if no findings — no empty-noise files.
 *
 * Scheduled via launchd: ~/Library/LaunchAgents/com.broadwayscore.weekly-insights.plist
 *
 * Three extraction passes (capped at 20 candidates each):
 *  1. User corrections   — assistant did X, user said "no/stop/don't/actually" → candidate feedback memory
 *  2. Repeated lookups   — same Read/Grep target fetched ≥3x across sessions → candidate memory entry
 *  3. Recurring blockers — same error string appearing ≥2x across sessions → candidate fix
 *
 * Sunset rule: if four consecutive weekly runs produce zero findings, the
 * launchd plist should be unloaded — track via the rolling state file.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SESSIONS_DIR = path.join(os.homedir(), '.claude/projects/-Users-tompryor-Broadwayscore');
const OUT_DIR = path.join(os.homedir(), 'Documents/claude-outputs');
const STATE_FILE = path.join(OUT_DIR, '.weekly-insights-state.json');
const MAX_CANDIDATES_PER_PASS = 20;
const LOOKBACK_DAYS = 7;
const NOW = new Date();
const CUTOFF = new Date(NOW.getTime() - LOOKBACK_DAYS * 86400 * 1000);

// Patterns that signal user is correcting a previous assistant action.
// Each must be a phrase that's unambiguously a correction, not a question.
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

function listSessionFiles() {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs.readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => path.join(SESSIONS_DIR, f))
    .filter(p => {
      try {
        return fs.statSync(p).mtime >= CUTOFF;
      } catch {
        return false;
      }
    });
}

function* readEvents(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // skip malformed lines silently
    }
  }
}

function extractUserText(event) {
  if (event.type !== 'user') return null;
  const content = event.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(c => c && c.type === 'text')
      .map(c => c.text || '')
      .join('\n');
  }
  return null;
}

function extractAssistantContext(events, userIdx, windowBack = 4) {
  // Return the last assistant text + tool calls before this user message,
  // to give the candidate memory entry some context.
  const start = Math.max(0, userIdx - windowBack);
  const ctx = [];
  for (let i = start; i < userIdx; i++) {
    const e = events[i];
    if (e.type !== 'assistant') continue;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c.type === 'text' && c.text) {
        ctx.push({ kind: 'text', body: c.text.slice(0, 240) });
      } else if (c.type === 'tool_use') {
        const args = JSON.stringify(c.input || {}).slice(0, 160);
        ctx.push({ kind: 'tool', body: `${c.name}(${args})` });
      }
    }
  }
  return ctx.slice(-3);
}

function findCorrections(events, sessionId) {
  const out = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type !== 'user') continue;
    const text = extractUserText(e);
    if (!text || text.length < 4 || text.length > 2000) continue;
    const matched = CORRECTION_PATTERNS.find(re => re.test(text));
    if (!matched) continue;
    const ctx = extractAssistantContext(events, i);
    out.push({
      sessionId,
      pattern: matched.toString(),
      user: text.trim().slice(0, 400),
      context: ctx,
    });
  }
  return out;
}

function findReadGrepTargets(events) {
  const out = [];
  for (const e of events) {
    if (e.type !== 'assistant') continue;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c.type !== 'tool_use') continue;
      if (c.name === 'Read' && c.input?.file_path) {
        out.push({ kind: 'Read', target: c.input.file_path });
      } else if (c.name === 'Grep' && c.input?.pattern) {
        out.push({ kind: 'Grep', target: `${c.input.pattern} :: ${c.input.path || ''}` });
      }
    }
  }
  return out;
}

function findErrorStrings(events) {
  const out = [];
  for (const e of events) {
    if (e.type !== 'user') continue;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c.type !== 'tool_result') continue;
      let body = c.content;
      if (Array.isArray(body)) {
        body = body.filter(p => p?.type === 'text').map(p => p.text || '').join('\n');
      } else if (typeof body !== 'string') {
        continue;
      }
      // Capture short error signatures: lines starting with Error: / TypeError / etc.
      for (const line of body.split('\n')) {
        const m = line.match(/\b(Error|TypeError|ReferenceError|SyntaxError|EACCES|ENOENT|ECONNREFUSED|fatal|FAILED|Cannot find|is not a function|is not defined)\b[^\n]{0,160}/);
        if (m && line.length < 240) {
          out.push(line.trim().slice(0, 200));
        }
      }
    }
  }
  return out;
}

function countTopN(arr, n) {
  const counts = new Map();
  for (const item of arr) {
    counts.set(item, (counts.get(item) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .filter(([, c]) => c >= 2);
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { zeroStreak: 0, lastRun: null };
  }
}

function saveState(state) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const state = loadState();

  const sessionFiles = listSessionFiles();
  if (sessionFiles.length === 0) {
    state.lastRun = NOW.toISOString();
    state.zeroStreak = (state.zeroStreak || 0) + 1;
    saveState(state);
    console.log('No sessions modified in the lookback window. Nothing to mine.');
    return;
  }

  const allCorrections = [];
  const allTargets = [];
  const allErrors = [];

  for (const file of sessionFiles) {
    const sessionId = path.basename(file, '.jsonl');
    const events = [...readEvents(file)];
    if (events.length === 0) continue;
    allCorrections.push(...findCorrections(events, sessionId));
    const targets = findReadGrepTargets(events);
    for (const t of targets) allTargets.push(`${t.kind}: ${t.target}`);
    allErrors.push(...findErrorStrings(events));
  }

  const corrections = allCorrections.slice(0, MAX_CANDIDATES_PER_PASS);
  const repeatedLookups = countTopN(allTargets, MAX_CANDIDATES_PER_PASS).filter(([, c]) => c >= 3);
  const recurringErrors = countTopN(allErrors, MAX_CANDIDATES_PER_PASS);

  const findingCount = corrections.length + repeatedLookups.length + recurringErrors.length;

  if (findingCount === 0) {
    state.lastRun = NOW.toISOString();
    state.zeroStreak = (state.zeroStreak || 0) + 1;
    if (state.zeroStreak >= 4) {
      console.log(`⚠️  ${state.zeroStreak} consecutive zero-finding runs. Consider unloading the launchd plist:`);
      console.log('   launchctl unload ~/Library/LaunchAgents/com.broadwayscore.weekly-insights.plist');
    }
    saveState(state);
    console.log('No findings — skipping output (no empty noise files).');
    return;
  }

  state.zeroStreak = 0;
  state.lastRun = NOW.toISOString();
  saveState(state);

  const stamp = NOW.toISOString().slice(0, 10);
  const outPath = path.join(OUT_DIR, `insights-week-${stamp}.md`);
  const lines = [];

  lines.push(`# Weekly session insights — week ending ${stamp}`);
  lines.push('');
  lines.push(`Scanned ${sessionFiles.length} session files (modified within the last ${LOOKBACK_DAYS} days).`);
  lines.push('');
  lines.push('Each candidate below is a SUGGESTION for a `memory/feedback_*.md` entry. Review and promote by hand — none of this is auto-applied.');
  lines.push('');

  if (corrections.length) {
    lines.push('## User corrections (assistant did X, user pushed back)');
    lines.push('');
    for (const c of corrections) {
      lines.push(`### Session ${c.sessionId}`);
      lines.push('');
      lines.push(`**Correction:** ${c.user.replace(/\n/g, ' ')}`);
      lines.push('');
      if (c.context.length) {
        lines.push('**Preceding context:**');
        for (const x of c.context) {
          lines.push(`  - ${x.kind === 'tool' ? `(tool) ${x.body}` : `(text) ${x.body.replace(/\n/g, ' ')}`}`);
        }
        lines.push('');
      }
    }
  }

  if (repeatedLookups.length) {
    lines.push('## Repeated lookups (re-discovered ≥3×)');
    lines.push('');
    lines.push('If you keep looking up the same fact, it should be in memory.');
    lines.push('');
    for (const [target, count] of repeatedLookups) {
      lines.push(`- (${count}×) ${target}`);
    }
    lines.push('');
  }

  if (recurringErrors.length) {
    lines.push('## Recurring errors (same signature ≥2 sessions)');
    lines.push('');
    for (const [err, count] of recurringErrors) {
      lines.push(`- (${count}×) ${err}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('Generated by `scripts/weekly-session-insights.js`. To stop these reports, unload the plist:');
  lines.push('');
  lines.push('```');
  lines.push('launchctl unload ~/Library/LaunchAgents/com.broadwayscore.weekly-insights.plist');
  lines.push('```');

  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`Wrote ${outPath}`);
  console.log(`Findings: ${corrections.length} corrections, ${repeatedLookups.length} repeated lookups, ${recurringErrors.length} recurring errors.`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('weekly-session-insights failed:', err.message);
    process.exit(1);
  }
}
