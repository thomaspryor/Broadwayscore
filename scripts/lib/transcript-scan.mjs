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
//     bypass-token --token=<T>     true iff in-flight assistant turn has a line "<T>: <reason ≥15 chars>"
//     override-active-for-push     true iff last user msg contains "ship immediately for: <reason>"
//                                  AND no consume marker exists for current session
//                                  (caller writes marker via --consume after using)
//
// Exit: 0 + JSON to stdout on success; 1 bad args; 2 transcript not found.

import { readFileSync, existsSync, writeFileSync, statSync, openSync, writeSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

// This file lives at <root>/scripts/lib/, so the checkout root is two levels
// up. Derived from THIS file rather than cwd on purpose: the gate hooks invoke
// it from whatever directory the agent happens to be in, including a worktree,
// and isProvablyReadOnlyScript must read the same tree the command names.
const CANONICAL_REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── shared regex / config ────────────────────────────────────────────────────

const UI_PATH_PATTERNS = [
  /\/src\/.*\.(tsx|jsx|css|scss|module\.css)$/,
  /\/tailwind\.config\.(js|ts|cjs|mjs)$/,
  /\/postcss\.config\.(js|ts|cjs|mjs)$/,
  /\/src\/app\/.*\.(tsx|jsx|ts|js)$/,
];

// Push-ingress: every entrypoint that can land changes on origin/main.
// Maintained via /ship-check findings — every gap added here as it's found.
//
// Bypasses caught in /ship-check round 1:
//  - direct exec: `./scripts/lib/push-with-retry.sh`
//  - other shells: `zsh scripts/...push...`
//  - `gh workflow run vercel-deploy.yml` (lowercase + .yml suffix)
// Bypasses caught in /ship-check round 2 (Claude reviewer P0-2):
//  - absolute path: `/usr/bin/git push` → match git regardless of leading path
//  - node wrapper scripts: `node scripts/push-foo.js`
//  - python/ruby/etc. wrappers
// Bypass caught in /ship-check round 3 (2026-07-12, review-gate P0-2):
//  - `git -C <path> push` / `git --git-dir=… push` / `git -c k=v push` — agent
//    sessions use -C habitually because cwd resets between Bash calls.
const GIT_GLOBAL_OPTS = String.raw`(?:-C\s+[^\s;&|]+\s+|-c\s+[^\s;&|]+\s+|--git-dir=[^\s;&|]+\s+|--work-tree=[^\s;&|]+\s+|--no-pager\s+)*`;
// BRO-3046: the script alternatives below match any path under scripts/ whose
// filename merely CONTAINS "push", which swept in read-only callers that can
// never reach a remote — `node scripts/audit-push-retry-budgets.js` (a CI
// advisory audit) was hard-blocked by pre-push-review-gate.sh with "push to
// main of 1335 unreviewed code lines" while attempting no push at all. 39
// files under scripts/ classified isPush; 17 of them are test harnesses.
//
// The exclusion is applied by SUBTRACTING these tokens from the command before
// matching, NOT as a negative lookahead inside PUSH_INGRESS_RE. A lookahead
// would silently un-gate a compound command — `node scripts/audit-push-foo.js
// && git push origin main` must still gate, and it does, because only the
// audit token is scrubbed and the `git push` remains.
//
// A NAME IS NOT A SAFETY PROPERTY. The first version of this scrub trusted the
// filename alone, and adversarial review killed it with one command:
// `node scripts/audit-push-to-main.js` — a file named audit-* that really does
// push. Nothing stops someone adding that file tomorrow, and the gate would
// have waved it through silently. So the name only nominates a CANDIDATE; the
// token is scrubbed only after reading the file and confirming it contains no
// push primitive (isProvablyReadOnlyScript below). Unreadable, missing, or
// outside the repo means NOT scrubbed — the gate keeps firing, which is the
// safe direction for a false positive and the whole point for a false negative.
//
// Deliberately NOT attempted here: basename-anchoring the "push" match. Review
// measured that 16 of ~19 scripts that really can push to origin have no
// "push" in their basename at all (merge-worktree-to-main.sh,
// sync-review-texts.sh, autonomous-merge.js, …). They are ungated today too
// (review-gate.mjs:841 documents that for merge-worktree-to-main.sh); anchoring
// would not add coverage, it would only encode a false claim of it. A real
// "mutates the remote" registry is the follow-up, filed separately.
// Every run is bounded to [^\s;&|)>] — NOT \S. Adversarial review found that
// `\S` includes `&`, `|`, `;` and `>`, so an UNSPACED compound command had its
// real push swallowed by the scrub and sailed through the gate:
//   node scripts/audit-a.js&&git push     -> was scrubbed to nothing, isPush:false
//   node scripts/audit-a.js;git push      -> same
//   node scripts/audit-x.js&&gh pr merge 1 -> same
// The spaced form gated correctly, which is exactly why the first version of
// this test suite (which only covered the spaced form) proved nothing about the
// class. The trailing lookahead already assumed this alphabet; the runs now
// agree with it.
const READONLY_SCRIPT_TOKEN_RE = /(?:^|(?<=[\s;&|(]))[^\s;&|)>]*scripts\/(?:[^\s;&|)>]*\/)?(?:(?:audit|check)-[^\s;&|)>]*|[^\s;&|)>]*\.(?:test|race-test)\.[a-z0-9]+)(?=$|[\s;&|)>])/gi;
// `(?:[^\s]*\/)?` on each script alternative (not just the git one) closes a
// pre-existing FALSE NEGATIVE found by the same review: an absolute path
// escaped every script arm, so `node /Users/…/scripts/lib/push-with-retry.js`
// returned isPush:false and pushed past the gate entirely.
// `(?:-{1,2}[^\s]+\s+)*` after the interpreter closes a second pre-existing
// false negative alongside the absolute-path one: no flags were allowed between
// the runner and the path, so `node --test scripts/lib/push-foo.test.mjs`
// matched nothing and was never gated at all — which is precisely the shape of
// a test file that really pushes.
const PUSH_INGRESS_RE = new RegExp(String.raw`(^|[\s;&|(])(?:[^\s]*\/)?(?:git\s+${GIT_GLOBAL_OPTS}push|gh\s+pr\s+merge|gh\s+pr\s+create\s+[^\n]*--auto|(?:bash|sh|zsh|env|python3?|ruby|node)\s+(?:-{1,2}[^\s]+\s+)*\S*scripts\/\S*push\S*|\.?\/\S*scripts\/\S*push\S*|gh\s+workflow\s+run\s+["']?(?:[^\s"']*deploy|[Dd]eploy)|(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:deploy|push|publish))`, 'i');

// Visual-claim-language: phrases the agent uses when claiming UI work is done
// without actually proving it. Each was observed in real failure transcripts.
//
// /ship-check round 2 (Claude P1-1) found these matched legit non-UI prose
// ("the function renders correctly", "looks correct after refactor"). To
// avoid false positives, the caller (queryVisualClaimLanguage) requires a
// UI-context noun within ±80 chars of the matched phrase OR the phrase to
// be the LAST sentence of the assistant message.
const VISUAL_CLAIM_RE = /\b(live on production|looks correct|matches the design|ready to ship|visually verified|looks good on (mobile|desktop|tablet)|shipped successfully|works as designed|renders correctly)\b/i;
const UI_CONTEXT_RE = /\b(design|button|card|page|layout|component|UI|screen|viewport|mobile|tablet|desktop|pixel|css|tailwind|tsx|jsx|column|row|grid|flex|glow|pill|badge|font|color|width|height|padding|margin|overflow|click|tap|hover|render|view|modal|dropdown|nav|header|footer)\b/i;

// Override phrase mechanic — user-issued one-shot bypass scoped to next push.
//
// /ship-check round 2 (Claude P0-3) found this matched negated/quoted prose
// ("do NOT ship immediately for: any reason"). To prevent that, require the
// phrase to start at a line boundary (line head, after newline, or after
// list-marker punctuation), and reject if preceded by a negation in the
// preceding ~30 chars of the same line.
const OVERRIDE_RE = /(^|\n)\s*(?:[-*>]\s*)?ship immediately for:\s*\S+/i;
const NEGATION_RE = /\b(?:not?|never|don'?t|do\s+not|avoid|please\s+do(?:n'|\s+no)t)\b[^\n]{0,30}$/i;

// "APPROVED:" detection — must be followed by a hash. Strict, case-sensitive.
function approvalRe(hash) {
  // 16-char hex; escape characters in user-provided hash.
  const safe = String(hash).replace(/[^a-zA-Z0-9]/g, '');
  if (!safe) return null;
  // Match `APPROVED: <hash>` allowing optional trailing chars but anchor on hash boundary.
  return new RegExp(`APPROVED:\\s+${safe}\\b`);
}

// Plain-language approval (2026-05-29): transcribing the exact `APPROVED: <hash>`
// was painful, pointless friction — for a non-technical user a 16-char hash is
// noise. When a UI push is gated AND a fresh verdict already exists, a clear
// plain affirmative in the last user message is enough; the human glance (they
// confirm after seeing the visual) is the real safety, the hash never was.
// Negation-guarded so it stays a deliberate yes (fails toward asking again, not
// toward shipping, on anything ambiguous).
// Affirmative vocabulary. 2026-06-04: broadened after the user typed a perfectly
// clear "Ship all four" and the gate didn't recognize it (only "ship it"/"ship
// now" matched), forcing the painful hash fallback. The negation/conditional
// guard below is what keeps this safe, so the verbs themselves can be bare:
// "ship", "push", "send", "deploy", "publish", "merge", "go" all count, in any
// phrasing ("ship all four", "push them", "send everything", "ship 'em").
const PLAIN_APPROVAL_RE = /\b(?:approved?|ship|push|send|deploy|publish|merge|lgtm|looks good|looks great|great|perfect|awesome|beautiful|love it|nice|go ahead|go for it|good to go|all good|yep|yup|yeah|yes|do it)\b/i;
// Reject on negation OR conditional/change-request words — "looks good but fix X
// first", "yes, wait", "approved except…" are NOT a clean ship. Fails toward
// asking again, never toward shipping.
const APPROVAL_NEGATION_RE = /\b(?:don'?t|do not|not|never|hold|wait|stop|cancel|no|but|however|except|first|fix|change|instead|before|unless|although|though|hold on|revisit)\b/i;

function isPlainApproval(text) {
  if (!text || typeof text !== 'string') return false;
  // If the user used the explicit hash form (`APPROVED: <hash>`), honor it
  // STRICTLY via approvalRe — the bare word "approved" must not approve a
  // DIFFERENT verdict than the one named. Preserves per-hash scoping so a stale
  // approval of verdict A can't green-light verdict B.
  if (/APPROVED:\s*[A-Za-z0-9]{6,}/.test(text)) return false;
  if (APPROVAL_NEGATION_RE.test(text)) return false; // "don't ship", "not yet", etc.
  return PLAIN_APPROVAL_RE.test(text);
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
    // messageId groups events that belonged to the same assistant turn so
    // queries like visual-claim-language can scan the in-flight turn (text
    // blocks that share a messageId with the gated tool_use), not just the
    // last-emitted assistant_text in the transcript. Required by the
    // in-flight NO-VERIFY fix — see queryVisualClaimLanguage.
    const messageId = msg.id || r.uuid || null;
    const content = Array.isArray(msg.content) ? msg.content : (msg.content != null ? [msg.content] : []);
    if (mtype === 'assistant') {
      for (const c of content) {
        if (!c || typeof c !== 'object') continue;
        if (c.type === 'tool_use') {
          events.push({ kind: 'assistant_tool_use', name: c.name, input: c.input || {}, id: c.id, ts, messageId });
        } else if (c.type === 'text') {
          events.push({ kind: 'assistant_text', text: c.text || '', ts, messageId });
        }
      }
    } else if (mtype === 'user') {
      for (const c of content) {
        if (!c || typeof c !== 'object') {
          // raw string content — treat as user text
          if (typeof c === 'string') events.push({ kind: 'user_text', text: c, ts, messageId });
          continue;
        }
        if (c.type === 'tool_result') {
          const body = normalizeToolResultContent(c.content);
          events.push({ kind: 'tool_result', tool_use_id: c.tool_use_id, content: body, ts, messageId });
          // Tool results may include image paths from attached files
          if (containsImageAttachment(body)) {
            events.push({ kind: 'attachment', detail: 'tool_result_image', ts, messageId });
          }
        } else if (c.type === 'text') {
          events.push({ kind: 'user_text', text: c.text || '', ts, messageId });
          if (containsImageAttachment(c.text || '')) {
            events.push({ kind: 'attachment', detail: 'user_text_image_marker', ts, messageId });
          }
        } else if (c.type === 'image') {
          events.push({ kind: 'attachment', detail: 'image_block', ts, messageId });
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
      const exact = re.test(e.text);
      const plain = isPlainApproval(e.text);
      return {
        approved: exact || plain,
        via: exact ? 'hash' : (plain ? 'plain-affirmative' : null),
        lastUserText: e.text.slice(0, 200),
        matchedHash: hash,
      };
    }
  }
  return { approved: false, reason: 'no user text in transcript' };
}

// Does the file this token names provably contain no push primitive? Read the
// FILE, never trust the name (see READONLY_SCRIPT_TOKEN_RE's header — a file
// called audit-push-to-main.js that really pushes is the exact attack).
//
// Fails CLOSED on every uncertainty: a path that escapes the repo, a file that
// does not exist, an unreadable file, or any push primitive in the body all
// return false, leaving the token in place so the gate still fires.
//
// `repoRoot` is injectable so the colocated test can point at a fixture tree
// instead of monkey-patching fs.
function isProvablyReadOnlyScript(token, repoRoot) {
  try {
    if (!repoRoot) return false;
    const rel = String(token).replace(/^\.?\//, '');
    // Only ever resolve tokens that are repo-relative and stay under scripts/.
    // Rejects absolute paths and any `..` traversal outright.
    if (!/^scripts\//.test(rel)) return false;
    if (rel.split('/').includes('..')) return false;
    const full = join(repoRoot, rel);
    if (!full.startsWith(join(repoRoot, 'scripts'))) return false;
    if (!existsSync(full)) return false;
    const body = readFileSync(full, 'utf8');
    // A push primitive on any NON-COMMENT line disqualifies the file.
    //
    // Line position, not comment stripping. Measured 2026-09-08 across the real
    // corpus: every push token in scripts/audit-push-*.js and check-push-*.js
    // is prose in a header comment (they audit push code, so of course they
    // name it), while scripts/lib/push-mutex.race-test.sh really does run
    // `git push -q origin main` against its mktemp bare remote. A whole-file
    // substring test called all of those unsafe and un-fixed the bug; a
    // comment-STRIPPING pass can swallow real code when a string literal
    // contains `/*`, which fails in the dangerous direction. Checking whether
    // the token's own line begins with a comment marker gets every measured
    // case right and fails safe on the rest: `x(); // git push` counts as real
    // (over-gate, recoverable), and a token inside a multi-line string counts
    // as real too.
    // Two disqualifiers, both evaluated per non-comment line:
    //
    //   DIRECT — `git push` / `gh pr merge` anywhere in executable position.
    //     This is what catches the adversarial case that killed the first
    //     version of this function: a file named audit-* whose body is
    //     `execSync("git push origin main")`.
    //
    //   WRAPPER — a push wrapper's filename, but ONLY in executable position:
    //     on the same line as a subprocess call, or anywhere in a shell script
    //     (where a bare mention in command position IS the invocation).
    //     Measured against the real corpus 2026-09-08: the audits that exist to
    //     REPORT on push-with-retry.sh call sites carry its name in a regex
    //     literal (`/push-with-retry\.sh/.test(raw)`) and inside advice strings
    //     ("bash scripts/lib/push-with-retry.sh"). Treating a bare mention as
    //     proof of a push disqualified those audits and re-broke the exact bug
    //     being fixed, so the name alone is not enough — but
    //     `execSync('bash scripts/lib/push-with-retry.sh')` still is.
    const DIRECT_PUSH = /\bgit\s+(?:-{1,2}[^\s]+\s+)*push\b|\bgh\s+pr\s+merge\b/i;
    const WRAPPER_NAME = /push-with-retry|push-via-git-api|merge-worktree-to-main/i;
    const SUBPROCESS = /child_process|execSync|spawnSync|execFileSync|\bspawn\s*\(|\bexec\s*\(/;
    const isShell = /\.(?:sh|bash|zsh)$/i.test(rel);
    for (const line of body.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('#')) continue;
      if (DIRECT_PUSH.test(t)) return false;
      if (WRAPPER_NAME.test(t) && (isShell || SUBPROCESS.test(t))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function queryPushIngress(command, opts = {}) {
  if (!command) return { isPush: false, reason: 'no command' };
  const repoRoot = opts.repoRoot !== undefined ? opts.repoRoot : CANONICAL_REPO_ROOT;
  // Scrub read-only script tokens first, then match. Order matters: scrubbing
  // removes only the verified-read-only token, so any real push elsewhere in a
  // compound command (`node scripts/audit-x.js && git push`) still matches.
  // Each candidate is confirmed by READING the file — the name only nominates.
  const scrubbed = String(command).replace(READONLY_SCRIPT_TOKEN_RE, (tok) =>
    isProvablyReadOnlyScript(tok, repoRoot) ? ' ' : tok
  );
  const matched = PUSH_INGRESS_RE.test(scrubbed);
  return { isPush: matched, command: command.slice(0, 200), matched };
}

export function queryReferenceAttached(events) {
  for (const e of events) {
    if (e.kind === 'attachment') return { attached: true, detail: e.detail };
  }
  return { attached: false };
}

// Find the assistant text block(s) belonging to the in-flight turn — the
// stretch of assistant activity that started after the most recent user
// message and includes the gated tool_use.
//
// /ship-check 2026-05-26 (Codex P1, Claude P2-3) flagged the strict-messageId
// version: when CC splits one logical turn across two assistant messages
// (long output streamed in multiple records), the earlier message's text was
// classified as prior-turn and missed. Result: NO-VERIFY in message 1, Bash
// in message 2 → gate fired despite the in-flight bypass intent.
//
// Fix: walk forward from the LAST user_text/user attachment, collecting all
// assistant_text events until we hit the gated tool_use. That's the logical
// "current turn" regardless of how many message records it spans.
//
// When `toolUseId` is omitted or no matching turn is found, fall back to the
// last assistant_text in the transcript (legacy behaviour).
function findRelevantAssistantTexts(events, toolUseId) {
  if (toolUseId) {
    // Locate the tool_use event index.
    let toolUseIdx = -1;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.kind === 'assistant_tool_use' && e.id === toolUseId) {
        toolUseIdx = i;
        break;
      }
    }
    if (toolUseIdx >= 0) {
      // Find the most recent user_text BEFORE the tool_use; the in-flight
      // turn is everything between (exclusive) and the tool_use (exclusive).
      let lastUserIdx = -1;
      for (let i = toolUseIdx - 1; i >= 0; i--) {
        if (events[i].kind === 'user_text' || events[i].kind === 'attachment') {
          lastUserIdx = i;
          break;
        }
      }
      const inFlight = events.slice(lastUserIdx + 1, toolUseIdx)
        .filter(e => e.kind === 'assistant_text');
      if (inFlight.length > 0) return { texts: inFlight, scope: 'in-flight-turn' };
    }
  }
  // Fallback: last assistant_text in the transcript.
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind === 'assistant_text') return { texts: [events[i]], scope: 'last-assistant-text' };
  }
  return { texts: [], scope: 'none' };
}

export function queryVisualClaimLanguage(events, { toolUseId } = {}) {
  // Scan the in-flight assistant turn (the message containing the gated
  // tool_use) when toolUseId is provided AND that turn has text blocks.
  // Otherwise scan the last assistant text. The reported `scope` reflects
  // which path was actually taken, not just what the caller requested.
  const { texts: relevantTexts, scope } = findRelevantAssistantTexts(events, toolUseId);
  if (relevantTexts.length === 0) {
    return { hasClaim: false, reason: 'no assistant text', scope };
  }
  // Concatenate so a NO-VERIFY in any text block of the same turn counts.
  const concatenated = relevantTexts.map(e => e.text || '').join('\n');
  const hasOverride = /NO-VERIFY:\s+\S+/.test(concatenated);
  const match = VISUAL_CLAIM_RE.exec(concatenated);
  let hasClaim = false;
  let inUiContext = false;
  if (match) {
    const start = Math.max(0, match.index - 80);
    const end = Math.min(concatenated.length, match.index + match[0].length + 80);
    const window = concatenated.slice(start, end);
    inUiContext = UI_CONTEXT_RE.test(window);
    const lastSentenceStart = Math.max(
      concatenated.lastIndexOf('.'), concatenated.lastIndexOf('!'),
      concatenated.lastIndexOf('?'), concatenated.lastIndexOf('\n\n'),
    );
    const isFinalSentence = match.index > lastSentenceStart;
    hasClaim = (inUiContext || isFinalSentence) && !hasOverride;
  }
  return {
    hasClaim,
    rawClaim: !!match,
    inUiContext,
    hasNoVerify: hasOverride,
    textPreview: concatenated.slice(0, 200),
    scope,
  };
}

// Generic in-flight bypass-token detection (2026-07-12, Notion 39c637c5):
// true iff the in-flight assistant turn (or last assistant text) contains a
// line starting `<TOKEN>: <reason>` with a reason of ≥15 chars — the same bar
// finish-line-gate.sh sets for NO-SHIP-CHECK. Line-anchored so a quoted
// mention of the token mid-sentence doesn't count. Used by
// pre-push-review-gate.sh for its NO-SHIP-CHECK escape hatch.
export function queryBypassToken(events, { token, toolUseId } = {}) {
  const safe = String(token || '').replace(/[^A-Z0-9-]/gi, '');
  if (!safe) return { hasBypass: false, reason: 'invalid token' };
  const { texts, scope } = findRelevantAssistantTexts(events, toolUseId);
  if (texts.length === 0) return { hasBypass: false, reason: 'no assistant text', scope };
  const concatenated = texts.map(e => e.text || '').join('\n');
  // Strip fenced code blocks so a quoted example can't satisfy the bypass
  // (same defense finish-line-gate.sh applies to its tokens).
  const stripped = concatenated.replace(/```[\s\S]*?```/g, '');
  const m = new RegExp(`^\\s*${safe}:\\s*(.{15,})`, 'm').exec(stripped);
  return {
    hasBypass: !!m,
    line: m ? m[0].trim().slice(0, 200) : null,
    scope,
  };
}

export function queryOverrideActiveForPush(events, { sessionId, consume = false, markerNs = null } = {}) {
  // Find LAST user_text. Check for "ship immediately for: <reason>".
  // Per /ship-check round 2 P0-3, reject matches that are negated in the same
  // line ("do NOT ship immediately for: X"). The OVERRIDE_RE requires the
  // phrase to start a line (line-head or list-marker); we additionally
  // inspect the text preceding the match for a negation token within 30 chars.
  let matched = false;
  let preview = '';
  let text = '';
  let matchIndex = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === 'user_text') {
      text = e.text || '';
      const m = OVERRIDE_RE.exec(text);
      if (m) {
        // Examine the same line (from previous newline to the match) for negation.
        const lineStart = text.lastIndexOf('\n', m.index - 1) + 1;
        const beforeMatch = text.slice(lineStart, m.index);
        if (!NEGATION_RE.test(beforeMatch)) {
          matched = true;
          matchIndex = m.index;
        }
      }
      preview = text.slice(0, 200);
      break;
    }
  }
  if (!matched) return { override: false, reason: 'no override phrase in last user text (or matched but negated)' };
  if (!sessionId) return { override: true, reason: 'matched but no sessionId — caller must scope per-session' };
  const marker = markerPath(sessionId, markerNs);
  if (existsSync(marker)) return { override: false, reason: 'override already consumed for this session', marker };
  if (consume) {
    // Atomic create: open with O_CREAT|O_EXCL so two simultaneous consumers
    // can't both pass the existsSync check.
    try {
      const fd = openSync(marker, 'wx');
      writeSync(fd, JSON.stringify({ ts: new Date().toISOString(), preview }));
      closeSync(fd);
      return { override: true, consumed: true, marker };
    } catch (err) {
      // EEXIST: another process won the race
      return { override: false, reason: 'override race lost — another consumer claimed marker', marker };
    }
  }
  return { override: true, consumed: false, marker, preview };
}

// markerNs gives each gate its own one-shot consume marker: without it, the
// visual gate (runs first in the hook list) would consume the user's single
// "ship immediately for:" and the review gate would then see it as spent and
// block the very push the user just authorized.
function markerPath(sessionId, markerNs = null) {
  const safe = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const ns = markerNs ? String(markerNs).replace(/[^a-zA-Z0-9_-]/g, '_') + '-' : '';
  return join(tmpdir(), `visual-qa-override-consumed-${ns}${safe}`);
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
  visual-claim-language             check if assistant msg makes visual-correctness claim
    --tool-use-id=<id>                scope to the in-flight turn containing this tool_use
                                       (otherwise: last assistant_text in transcript)
  bypass-token                      check in-flight turn for a "<TOKEN>: <reason ≥15 chars>" line
    --token=<TOKEN>                   e.g. NO-SHIP-CHECK
    --tool-use-id=<id>                scope to the in-flight turn containing this tool_use
  override-active-for-push          check for "ship immediately for: <reason>"
    --session-id=<id>                 required for override scoping
    --marker-ns=<ns>                  namespace the consume marker (one per gate)
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
      result = queryVisualClaimLanguage(events, { toolUseId: args['tool-use-id'] });
      break;
    case 'bypass-token':
      if (!args.token) { console.error('ERROR: bypass-token needs --token='); process.exit(1); }
      result = queryBypassToken(events, { token: args.token, toolUseId: args['tool-use-id'] });
      break;
    case 'override-active-for-push':
      result = queryOverrideActiveForPush(events, {
        sessionId: args['session-id'],
        markerNs: args['marker-ns'] || null,
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
