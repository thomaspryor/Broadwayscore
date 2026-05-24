#!/usr/bin/env node
// scripts/lib/transcript-scan.mjs — read a Claude Code session transcript
// (JSONL) and answer narrow questions about it. Used by hooks to enforce
// the visual-qa gate without duplicating transcript-parsing logic in shell.
//
// CLI:
//   --transcript=<path>           required, path to the .jsonl transcript
//   --query=<mode>                required, one of:
//     ui-edits-without-verdict     return most-recent Edit/Write to a UI file (path, ts, mtime), or null
//     approval-of <hash>           true iff last user TEXT message contains "APPROVED: <hash>" exactly
//     push-ingress --command=<c>   true iff <c> matches a push-ingress pattern (git push, gh pr merge,
//                                  scripts/.*push.*, etc.) — does not actually read transcript
//     reference-attached           true iff any user message in transcript has an image attachment
//     visual-claim-language        true iff last assistant TEXT block contains banned visual-correctness
//                                  claim AND no "NO-VERIFY:" in same block
//     override-active-for-push     true iff last user msg contains "ship immediately for: <reason>"
//                                  AND no consume marker exists for current session
//                                  (caller writes marker via --consume after using)
//
// Exit: 0 + JSON to stdout on success; 1 bad args; 2 transcript not found.

import { readFileSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── shared regex / config ────────────────────────────────────────────────────

const UI_PATH_PATTERNS = [
  /\/src\/.*\.(tsx|jsx|css|scss|module\.css)$/,
  /\/tailwind\.config\.(js|ts|cjs|mjs)$/,
  /\/postcss\.config\.(js|ts|cjs|mjs)$/,
  /\/src\/app\/.*\.(tsx|jsx|ts|js)$/,
];

const PUSH_INGRESS_RE = /(^|[\s;&|])(git\s+push|gh\s+pr\s+merge|bash\s+scripts\/[^\s]*push[^\s]*|sh\s+scripts\/[^\s]*push[^\s]*|gh\s+workflow\s+run\s+["']?[Dd]eploy)/;

// Visual-claim-language: things the agent says when claiming UI work is done
// without actually proving it. Each was observed in real failure transcripts.
const VISUAL_CLAIM_RE = /\b(live on production|looks correct|matches the design|ready to ship|visually verified|looks good on (mobile|desktop|tablet)|shipped successfully|works as designed|renders correctly)\b/i;

// Override phrase mechanic — user-issued one-shot bypass scoped to next push.
const OVERRIDE_RE = /\bship immediately for:\s*\S+/i;

// "APPROVED:" detection — must be followed by a hash. Strict, case-sensitive.
function approvalRe(hash) {
  // 16-char hex; escape characters in user-provided hash.
  const safe = String(hash).replace(/[^a-zA-Z0-9]/g, '');
  if (!safe) return null;
  // Match `APPROVED: <hash>` allowing optional trailing chars but anchor on hash boundary.
  return new RegExp(`APPROVED:\\s+${safe}\\b`);
}

// Reference-attached detection — Claude Code surfaces user-attached images as:
//   - tool_result content blocks with type=image
//   - text blocks containing the marker "[Image #N]" with path "/var/folders/.../clipboard-*.png"
//   - assistant <image> tags in some contexts
const IMAGE_ATTACH_PATTERNS = [
  /\[Image #\d+\]/,
  /\/var\/folders\/[^\s)]*clipboard-[^\s)]*\.(png|jpg|jpeg|webp)/i,
  /\/private\/var\/folders\/[^\s)]*clipboard-[^\s)]*\.(png|jpg|jpeg|webp)/i,
];

// ── transcript walker ────────────────────────────────────────────────────────

// Yields events in order:
//   {kind: 'assistant_text', text, ts}
//   {kind: 'assistant_tool_use', name, input, id, ts}
//   {kind: 'user_text', text, ts}        // user-typed prompts
//   {kind: 'tool_result', tool_use_id, content, ts}
//   {kind: 'attachment', detail, ts}     // detected image-paste
//
// Tolerant: skips malformed lines, treats truncated last line gracefully.
export function walkTranscript(transcriptPath) {
  const events = [];
  if (!existsSync(transcriptPath)) return events;
  const text = readFileSync(transcriptPath, 'utf8');
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const mtype = r.type;
    const ts = r.timestamp || r.created_at || null;
    const msg = r.message || {};
    const content = Array.isArray(msg.content) ? msg.content : (msg.content != null ? [msg.content] : []);
    if (mtype === 'assistant') {
      for (const c of content) {
        if (!c || typeof c !== 'object') continue;
        if (c.type === 'tool_use') {
          events.push({ kind: 'assistant_tool_use', name: c.name, input: c.input || {}, id: c.id, ts });
        } else if (c.type === 'text') {
          events.push({ kind: 'assistant_text', text: c.text || '', ts });
        }
      }
    } else if (mtype === 'user') {
      for (const c of content) {
        if (!c || typeof c !== 'object') {
          // raw string content — treat as user text
          if (typeof c === 'string') events.push({ kind: 'user_text', text: c, ts });
          continue;
        }
        if (c.type === 'tool_result') {
          const body = normalizeToolResultContent(c.content);
          events.push({ kind: 'tool_result', tool_use_id: c.tool_use_id, content: body, ts });
          // Tool results may include image paths from attached files
          if (containsImageAttachment(body)) {
            events.push({ kind: 'attachment', detail: 'tool_result_image', ts });
          }
        } else if (c.type === 'text') {
          events.push({ kind: 'user_text', text: c.text || '', ts });
          if (containsImageAttachment(c.text || '')) {
            events.push({ kind: 'attachment', detail: 'user_text_image_marker', ts });
          }
        } else if (c.type === 'image') {
          events.push({ kind: 'attachment', detail: 'image_block', ts });
        }
      }
    }
  }
  return events;
}

function normalizeToolResultContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(p => (p && typeof p === 'object' && typeof p.text === 'string') ? p.text : (typeof p === 'string' ? p : '')).join('');
  }
  return content == null ? '' : String(content);
}

function containsImageAttachment(s) {
  if (!s) return false;
  return IMAGE_ATTACH_PATTERNS.some(re => re.test(s));
}

// ── query handlers ───────────────────────────────────────────────────────────

export function queryUiEditsWithoutVerdict(events) {
  // Walk from end. Return most-recent Edit/Write/NotebookEdit on a UI file.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind !== 'assistant_tool_use') continue;
    if (!['Edit', 'Write', 'NotebookEdit'].includes(e.name)) continue;
    const fp = e.input?.file_path || '';
    if (!fp) continue;
    if (UI_PATH_PATTERNS.some(re => re.test(fp))) {
      return { hasUiEdit: true, file_path: fp, ts: e.ts, tool: e.name };
    }
  }
  return { hasUiEdit: false };
}

export function queryApprovalOf(events, hash) {
  const re = approvalRe(hash);
  if (!re) return { approved: false, reason: 'invalid hash' };
  // Find LAST user_text (not tool_result, not attachment).
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === 'user_text') {
      const matched = re.test(e.text);
      return { approved: matched, lastUserText: e.text.slice(0, 200), matchedHash: hash };
    }
  }
  return { approved: false, reason: 'no user text in transcript' };
}

export function queryPushIngress(command) {
  if (!command) return { isPush: false, reason: 'no command' };
  const matched = PUSH_INGRESS_RE.test(command);
  return { isPush: matched, command: command.slice(0, 200), matched };
}

export function queryReferenceAttached(events) {
  for (const e of events) {
    if (e.kind === 'attachment') return { attached: true, detail: e.detail };
  }
  return { attached: false };
}

export function queryVisualClaimLanguage(events) {
  // Find LAST assistant_text. Check for visual-claim pattern without NO-VERIFY.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind !== 'assistant_text') continue;
    const hasClaim = VISUAL_CLAIM_RE.test(e.text);
    const hasOverride = /NO-VERIFY:\s+\S+/.test(e.text);
    return {
      hasClaim: hasClaim && !hasOverride,
      rawClaim: hasClaim,
      hasNoVerify: hasOverride,
      textPreview: e.text.slice(0, 200),
    };
  }
  return { hasClaim: false, reason: 'no assistant text' };
}

export function queryOverrideActiveForPush(events, { sessionId, consume = false } = {}) {
  // Find LAST user_text. Check for "ship immediately for: <reason>".
  let matched = false;
  let preview = '';
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === 'user_text') {
      matched = OVERRIDE_RE.test(e.text);
      preview = e.text.slice(0, 200);
      break;
    }
  }
  if (!matched) return { override: false, reason: 'no override phrase in last user text' };
  if (!sessionId) return { override: true, reason: 'matched but no sessionId — caller must scope per-session' };
  const marker = markerPath(sessionId);
  if (existsSync(marker)) return { override: false, reason: 'override already consumed for this session', marker };
  if (consume) {
    writeFileSync(marker, JSON.stringify({ ts: new Date().toISOString(), preview }));
    return { override: true, consumed: true, marker };
  }
  return { override: true, consumed: false, marker, preview };
}

function markerPath(sessionId) {
  const safe = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(tmpdir(), `visual-qa-override-consumed-${safe}`);
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseCliArgs(argv) {
  const args = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { args.help = true; continue; }
    const eq = a.indexOf('=');
    if (eq >= 0 && a.startsWith('--')) {
      args[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (a.startsWith('--')) {
      args[a.slice(2)] = argv[++i];
    } else {
      positional.push(a);
    }
  }
  args._ = positional;
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/lib/transcript-scan.mjs --transcript=<path> --query=<mode> [options]

Queries:
  ui-edits-without-verdict          find most-recent UI-file Edit/Write
  approval-of <hash>                check if last user msg contains APPROVED: <hash>
  push-ingress --command=<cmd>      check if cmd is a push-ingress
  reference-attached                check if any user msg has an image attachment
  visual-claim-language             check if last assistant msg makes visual-correctness claim
  override-active-for-push          check for "ship immediately for: <reason>"
    --session-id=<id>                 required for override scoping
    --consume                         write the consume marker if matched

All queries print JSON to stdout. Exit 0 success / 1 bad args / 2 transcript missing.`);
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) { printHelp(); process.exit(0); }
  if (!args.query) { console.error('ERROR: --query is required'); process.exit(1); }

  // push-ingress doesn't need a transcript path.
  if (args.query === 'push-ingress') {
    console.log(JSON.stringify(queryPushIngress(args.command || '')));
    process.exit(0);
  }

  if (!args.transcript) { console.error('ERROR: --transcript is required'); process.exit(1); }
  if (!existsSync(args.transcript)) { console.error(`ERROR: transcript not found: ${args.transcript}`); process.exit(2); }

  const events = walkTranscript(args.transcript);

  let result;
  switch (args.query) {
    case 'ui-edits-without-verdict':
      result = queryUiEditsWithoutVerdict(events);
      break;
    case 'approval-of': {
      const hash = args.hash || args._[0];
      if (!hash) { console.error('ERROR: approval-of needs a hash (positional or --hash=)'); process.exit(1); }
      result = queryApprovalOf(events, hash);
      break;
    }
    case 'reference-attached':
      result = queryReferenceAttached(events);
      break;
    case 'visual-claim-language':
      result = queryVisualClaimLanguage(events);
      break;
    case 'override-active-for-push':
      result = queryOverrideActiveForPush(events, {
        sessionId: args['session-id'],
        consume: args.consume === '' || args.consume === 'true' || (args.consume !== undefined && args.consume !== 'false'),
      });
      break;
    default:
      console.error(`ERROR: unknown query "${args.query}"`);
      process.exit(1);
  }

  console.log(JSON.stringify(result));
  process.exit(0);
}

// Only run main when invoked directly (not when imported by tests).
const __isMain = import.meta.url === `file://${process.argv[1]}`;
if (__isMain) {
  main().catch(err => { console.error(`FATAL: ${err?.stack || err}`); process.exit(1); });
}
