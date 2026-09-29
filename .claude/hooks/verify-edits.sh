#!/usr/bin/env bash

# Self-skip if the user-level master hook exists (local CLI scenario).
# Cloud sandboxes do not have ~/.claude/hooks/, so the project copy runs there.
# Avoids double-firing identical logic on local sessions where the user-level
# Claude Code settings.json already wires the master at ~/.claude/hooks/<this-script-name>.
if [ -f "$HOME/.claude/hooks/$(basename "$0")" ]; then
  exit 0
fi
# ─── Visual-QA gate: kill switch ─────────────────────────────────────────────
# Off-ramp consumed by the is_ui_edit branch only. Does NOT disable the
# existing scoring/ship-check gates.
#
#   VISUAL_QA_DISABLE=1   user/operator emergency bypass
#
# Cloud sandbox detection is intentionally NOT here — autodetect via
# `node_modules/playwright` is unreliable across worktrees/symlinks (false
# negative in worktrees → silent skip). Cloud sessions that can't run
# Playwright will hit the block message, which lists `NO-VERIFY: <reason>`
# as the recoverable escape — pre-mortem concern about a 9-day deadlock
# only materializes if NO-VERIFY is non-functional, which it is not.
export VISUAL_QA_OK=1
[ "${VISUAL_QA_DISABLE:-0}" = "1" ] && export VISUAL_QA_OK=0

# Stop hook: blocks the session from ending if Claude edited code but never ran it.
# Catches the "I edited the file, looks correct, done!" antipattern.
#
# Logic (delegated to inline Python for sane JSONL parsing):
#   1. Find the most recent Edit/Write to a code file in the transcript
#   2. If found, check whether ANY Bash tool_use appears AFTER that edit
#   3. If no Bash followed AND no NO-VERIFY: override in subsequent assistant text → exit 2
#
# Bypass: include `NO-VERIFY: <reason>` in your final message text if the change is
# genuinely untestable (comment-only, docs, config that has no runtime effect).

input=$(cat)
transcript=$(echo "$input" | jq -r '.transcript_path // empty' 2>/dev/null)

if [ -z "$transcript" ] || [ ! -f "$transcript" ]; then
  exit 0
fi

# LOOP GUARD, per gate (BRO-4367). Claude Code sets `stop_hook_active: true`
# on Stop events after a hook already blocked in this turn-chain. This used to
# exit 0 outright, so the FIRST block of any kind spent the whole chain: a
# session blocked for a missing status line fixed that, re-claimed SAFE TO
# EXIT and skipped review, /what-else and /wrap-up unchecked. Now each gate
# blocks at most once per chain (the Mac finish-line gate's per-gate markers),
# with a hard cap of VE_CHAIN_BLOCK_CAP blocks so an unsatisfiable gate can
# never loop. Codes that blocked are listed in $_ve_chain_file (one key per
# line; the finish chain's key is its exact missing-step set, so a shrinking
# set re-blocks); the EXIT trap near the block messages records a key when
# this run blocks (exit 2). Every hook runs on a chain's first Stop
# (stop_hook_active false), so the ledger is emptied there: nothing from an
# earlier chain survives, even when another Stop hook blocked first.
stop_hook_active=$(echo "$input" | jq -r '.stop_hook_active // false' 2>/dev/null)
VE_CHAIN_BLOCK_CAP=4
_ve_chain_file="/tmp/verify-edits-chain-$(printf '%s' "$transcript" | cksum | cut -d' ' -f1)"
if [ "$stop_hook_active" = "true" ]; then
  # Unwritable ledger: nothing could be recorded, so blocking again could loop
  # forever. Fall back to the old let-it-through behavior.
  { : >> "$_ve_chain_file"; } 2>/dev/null || exit 0
  [ "$({ wc -l < "$_ve_chain_file"; } 2>/dev/null || echo 0)" -ge "$VE_CHAIN_BLOCK_CAP" ] && exit 0
else
  { : > "$_ve_chain_file"; } 2>/dev/null
fi

# CRITICAL (card #233, 2026-07-20): at the live Stop event the final assistant
# message's TEXT is not yet flushed to the transcript file (tool_use/tool_result
# entries ARE flushed — only the trailing text-only message is not; see
# finish-line-gate.sh's identical fix). Every text-scanning check below
# (NO-VERIFY, SKIP-VISUAL-CHECK, visual-claim-language, human-time-estimate)
# would silently read one message behind without this. The harness passes the
# live final text separately.
export VE_LAST_MSG=$(echo "$input" | jq -r '.last_assistant_message // empty' 2>/dev/null)
# The repo this hook ships in (.claude/hooks/ -> repo root): the chain gate
# loads scripts/lib/infra-review-scope.js from here.
export VE_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)"

export VE_SKIP_CODES=""
if [ "$stop_hook_active" = "true" ]; then
  # '|' separator: NOCHAIN keys contain commas (NOCHAIN:review,what-else).
  VE_SKIP_CODES=$(paste -sd'|' "$_ve_chain_file" 2>/dev/null)
fi
result=$(python3 - "$transcript" <<'PYEOF'
import hashlib, json, sys, os, re, shlex

# Per-gate loop guard (BRO-4367): keys that already blocked in this
# turn-chain (bash passes them in VE_SKIP_CODES) must not hide the gates
# after them. Every early-gate call site is `if <cond>: _ve_block(code)`
# followed by independent checks, so an already-blocked gate just returns and
# evaluation continues. Terminal verdicts go through _ve_final(), which swaps
# an already-blocked verdict for the finish-chain result. Keep _ve_key in
# step with the bash _ve_code computation near the block messages.
_VE_SKIP = set(c for c in os.environ.get('VE_SKIP_CODES', '').split('|') if c)

def _ve_key(code):
    head, _, rest = code.partition(':')
    return head + ':' + rest.split(':', 1)[0] if head == 'NOCHAIN' else head

def _ve_seen(code):
    return _ve_key(code) in _VE_SKIP

def _ve_block(code):
    if _ve_seen(code):
        return
    print(code)
    sys.exit(0)

def _ve_final(code):
    if _ve_seen(code):
        code = _chain_or_ok()
    print(code)
    sys.exit(0)

CODE_EXTS = ('.js', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.sh', '.rb', '.go')
# Paths that don't need execution verification.
# NOTE: We deliberately do NOT exempt `/.claude/` as a blanket — that left a gap where
# changes to the verification gate itself, hook scripts, and other in-harness automation
# could ship unverified. Instead we rely on CODE_EXTS to skip non-code (.md, .json, .yml,
# etc.) and use targeted exempts only for paths that truly have no executable surface
# (memory snapshots, CI workflows that can only run remotely, vendored deps).
EXEMPT_SUBSTRINGS = (
    '/memory/',            # auto-memory entries (.md, but belt-and-suspenders)
    '/CLAUDE.md',          # global rules (markdown, not executable)
    '/MEMORY.md',          # memory index (markdown, not executable)
    '/.github/workflows/', # CI workflows can only run on push, not locally
    '/node_modules/',      # vendored dependencies
    '/.claude/projects/',  # transcript JSONLs and file-history snapshots
    '/.claude/file-history/', # snapshots
    '/.claude/plans/',     # plan markdowns
    '/.claude/sessions/',  # session state
    '/.claude/cache/',     # cache files
    '/.claude/backups/',   # backups
    '/.claude/downloads/', # downloads
)
# What this leaves enforced under .claude/:
#   - .claude/hooks/*.sh         → must be tested before stopping
#   - .claude/skills/**/*.{sh,py,js,ts}  → same
#   - .claude/plugins/**/*.{js,ts,sh,py} → same
# Markdown skill files (.claude/commands/*.md, .claude/skills/**/*.md) are naturally
# skipped because .md is not in CODE_EXTS — they're prompt templates, not code.

# Strip heredoc bodies before scanning. Heredoc bodies are *data*, not
# executed commands, so `cat > /tmp/test.jsonl << 'EOF' ... sed -i ...
# data/review-texts/... ... EOF` is NOT an audit sweep — its actual side
# effect is writing to /tmp/. Without this, hook self-tests and any other
# heredoc that mentions both `sed -i` and `review-texts` in the body
# falsely tripped the gate. Recurred 3x in a single session 2026-05-16.
#
# The open-tag regex requires EXACTLY two '<' via lookbehind/lookahead —
# `<<<TAG` here-strings (a single token, no multi-line body at all) must NOT
# be treated as a heredoc open. The prior version matched at a here-string's
# second '<' and then DOTALL-greedily consumed forward to the next line that
# happened to equal TAG, silently swallowing real command text — including a
# genuine `sed -i .../review-texts/...` write — as fake heredoc body. Same
# false-negative class fixed in stripHeredocBodies() in
# scripts/lib/infra-review-scope.js (task #1557); ported here (task #1606).
#
# KNOWN GAP (pre-existing, unchanged by task #1606 — /ship-check adversarial
# review 2026-08-15): this is a regex heuristic, not a shell parser. It does
# not track quoting, comments, or arithmetic-expansion context, so `<<TAG`
# text inside a single-quoted string (e.g. `printf '%s' '<<EOF'`) or a
# `(( x << EOF ))` arithmetic shift can still be misread as a heredoc open,
# and text following it stripped as fake body. Confirmed this predates task
# #1606 (the pre-fix regex had the identical blind spot) and is shared by the
# JS reference (scripts/lib/infra-review-scope.js) this was ported from — not
# a regression here. A real fix needs a shell tokenizer; per that file's own
# KNOWN_GAPS list, documenting is cheaper than chasing until this is observed
# to matter in practice, and the push-time gate (pre-push-review-gate.sh)
# still sees the resulting diff either way.
#
# Hoisted here (2026-08-25, wrap-up-gate redesign) from its original spot
# further down near the audit-sweep detector — the wrap-up-close-out check
# below now also depends on it, and needs it defined before that gate's
# `try:` block executes (top-level Python heredoc statements run in file
# order; a forward reference would NameError and silently fail the gate open
# via its except-Exception, the exact class of bug that already bit the two
# gates added earlier today via a late `import re`).
_heredoc_open_re = re.compile(
    r"(?<!<)<<(?!<)(-)?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_.-]*)\2"
)
def _strip_heredocs(cmd: str) -> str:
    if '<<' not in cmd:
        return cmd
    lines = cmd.split('\n')
    out = []
    i = 0
    n = len(lines)
    while i < n:
        out.append(lines[i])
        i += 1
        tags = [(m.group(3), bool(m.group(1))) for m in _heredoc_open_re.finditer(lines[i - 1])]
        for tag, dashed in tags:
            # Plain `<<TAG` requires the line to be EXACTLY the tag (no
            # trim()); `<<-TAG` additionally permits leading TABS (not
            # spaces) before the tag. A body line that merely trims down to
            # the tag text must not end the strip early.
            while i < n and (lines[i].lstrip('\t') if dashed else lines[i]) != tag:
                i += 1
            if i >= n:
                break  # unterminated — nothing left to strip precisely
            i += 1  # drop the terminator line, continue with the next tag's body
    return '\n'.join(out)

# Extracts the close-out value from a Linear board close-out Bash command
# (`linear-brain.js update BRO-N --state <X>` or `linear-session.js report
# --status=<X>`), or None if this command isn't one. Used by the
# wrap-up-close-out gate below to require concrete evidence the session's
# Linear card was actually closed out, not just that a Skill tool_use named
# 'wrap-up' appeared somewhere (found insufficient — a plan /second-opinion
# review, 2026-08-25, showed a bare regex `.*--status[= ]+"?(done|paused)"?`
# search across the raw command string is exploitable: this repo's own
# docs/session text routinely quotes the literal example `--state Done`
# INSIDE a --comment/--summary argument's prose value — a session (very
# plausibly one editing this exact gate) could satisfy a whole-string regex
# on quoted example text with a real state of "In Progress". Tokenizing
# with shlex closes this: a quoted --comment/--summary value collapses to ONE
# token, so text "--state Done" embedded inside it is part of that token's
# string content, never two separate top-level `--state`/`Done` tokens —
# only a REAL, unquoted flag can ever match `tok == flag` below.
# Heredoc-stripping runs first because shlex can't parse unbalanced quotes
# inside heredoc-wrapped prose (this repo's convention for long values, per
# CLAUDE.md's heredoc commit-message rule) — without it, shlex.split would
# raise on essentially every real invocation.
# Linear replaced the Notion board (CLAUDE.md §6). Linear has no "Paused"
# state (linear-brain rejects it); a pause is --state Backlog, which is what
# `linear-session.js report --status=paused` sets. `linear-session.js report`
# is the close-out verb for an issue the session CLAIMED (dispatched onto
# BRO-N) rather than created.
# `notion-brain.js update --status Done` counted here until 2026-09-29
# (BRO-4274) and was removed: notion-brain's update path still WORKS (only
# create is read-only), so a Notion update satisfied this gate while the
# Linear card NOCARD requires stayed open on the board of record.
_CLOSEOUT_SCRIPTS = (
    ('linear-brain.js', 'update', '--state'),
    ('linear-session.js', 'report', '--status'),
)

def _board_closeout_status(cmd):
    if not cmd or not any(s in cmd for s, _v, _f in _CLOSEOUT_SCRIPTS):
        return None
    stripped = _strip_heredocs(cmd)
    try:
        tokens = shlex.split(stripped)
    except ValueError:
        return None  # unparseable quoting — treat as no match, don't crash the gate
    for script, verb, flag in _CLOSEOUT_SCRIPTS:
        if not any(t.endswith(script) for t in tokens) or verb not in tokens:
            continue
        for i, tok in enumerate(tokens):
            if tok == flag and i + 1 < len(tokens):
                return tokens[i + 1].strip().lower()
            if tok.startswith(flag + '='):
                return tok.split('=', 1)[1].strip().lower()
    return None

# Close-out values across both CLIs: done/paused (linear-session report
# --status) and Linear's real state names for a finished or parked card
# (linear-brain --state).
_CLOSEOUT_STATES = ('done', 'paused', 'backlog', 'canceled', 'duplicate')

# A Done the board's own gate refused (linear-brain exit 5 "❌", linear-session
# "REFUSED" / doneGateRefused:true) left the card open — it is not a close-out.
_CLOSEOUT_REFUSED_RE = re.compile(r'\bREFUSED\b|❌|"doneGateRefused"\s*:\s*true')

# One definition of "the session did real work" for every gate below: a code
# edit, a git commit/push, `gh pr create|merge`, or a GitHub MCP write.
_WORK_MCP_TOOLS = (
    'mcp__github__create_pull_request',
    'mcp__github__merge_pull_request',
    'mcp__github__push_files',
    'mcp__github__create_or_update_file',
)

def _is_work_tool(name, inp, tid):
    # A call that was refused before it ran changed nothing: a session whose
    # only edits were blocked by hooks has done no work (BRO-4238 smoke test:
    # NOCARD fired on two blocked edits).
    if tid in tool_refused_ids:
        return False
    inp = inp if isinstance(inp, dict) else {}
    if name in ('Edit', 'Write', 'NotebookEdit'):
        fp = inp.get('file_path', '') or ''
        if fp.startswith('/tmp/') or '/scratchpad/' in fp:
            return False  # throwaway analysis scripts, not repo work
        return fp.endswith(CODE_EXTS) and not any(s in fp for s in EXEMPT_SUBSTRINGS)
    if name in _WORK_MCP_TOOLS:
        return True
    if name == 'Bash':
        cmd = inp.get('command') or ''
        return bool(re.search(r'\bgit\s+(push|commit)\b', cmd) or re.search(r'\bgh\s+pr\s+(merge|create)\b', cmd))
    return False

# Card evidence (CLAUDE.md §6, "card first"): a create/claim that SUCCEEDED —
# its own tool_result carries the CLI's success marker (stderr) or the stdout
# JSON identifier (survives `2>/dev/null`). Both the command AND its own result
# must match, so a grep/cat that merely prints the marker string from source or
# tests doesn't count. A BRO-N merely mentioned in user text deliberately does
# NOT count: injected context (e.g. session-start.sh's own banner cites
# BRO-2663) arrives as user text, and a dispatched session should `claim` its
# issue anyway — the block message says how.
_CARD_CMD_RE = re.compile(r'linear-brain\.js\s+create\b|linear-session\.js\s+claim\b')
_CARD_RESULT_RE = re.compile(r'\bBRO-\d+\b|__LINEAR_ISSUE_ID__=[0-9A-Za-z-]{8,}')

def _session_has_card():
    for kind, payload in events:
        if kind != 'tool':
            continue
        name, inp, tid = payload
        if name != 'Bash' or not isinstance(inp, dict):
            continue
        if not _CARD_CMD_RE.search(_strip_heredocs(inp.get('command') or '')):
            continue
        if _CARD_RESULT_RE.search(tool_results_by_id.get(tid, '') or ''):
            return True
    return False

# Owner-asks the PR gate blocks (the owner never merges OR reviews). Merge-asks
# since 2026-09-27; review-asks since 2026-09-28 (session 01Fn6CXk parked PR
# #947 ~11h on "NOT SAFE TO EXIT — PR still open and unreviewed"). A match
# preceded in the same clause by a negation ("without waiting for review",
# "no need for your review", "doesn't need a review") describes the rule and
# doesn't count.
_MERGE_ASK_RE = re.compile(
    r"\byour\s+(merge|to merge)\b|\bfor you to merge\b"
    r"|\bready (for you )?to merge\b|\bwaiting on your merge\b"
    r"|\bonce you merge\b|\bafter you merge\b|\bmerge it when\b",
    re.IGNORECASE,
)
_REVIEW_Q = r"((a|an|the|human|owner'?s?|your)\s+){0,2}"
_REVIEW_N = r"(review|reviewers?|approval|sign-?off)"
_REVIEW_ASK_RE = re.compile(
    r"\bunreviewed\b|\bplease review\b|\b(ready )?for your " + _REVIEW_N + r"\b"
    r"|\bwait(ing)? (on|for) " + _REVIEW_Q + _REVIEW_N + r"\b"
    r"|\b(awaiting|pending|blocked on) " + _REVIEW_Q + _REVIEW_N + r"\b"
    r"|\bneeds? (a|an|your|human|owner'?s?)\s+" + _REVIEW_N + r"\b",
    re.IGNORECASE,
)
_NEGATION_RE = re.compile(r"\b(no|not|never|without)\b|n't\b", re.IGNORECASE)

def _owner_ask(text):
    # The status line's own "NOT" is not a negation of what follows it.
    text = re.sub(r'\b(NOT )?SAFE TO EXIT\b', ' ', text or '')
    for rx in (_MERGE_ASK_RE, _REVIEW_ASK_RE):
        for m in rx.finditer(text):
            clause = re.split(r'[.;:!?\n—–]', text[max(0, m.start() - 30):m.start()])[-1]
            if not _NEGATION_RE.search(clause):
                return True
    return False

# Legitimate reasons a PR is still open. NOT a bare `NOT SAFE TO EXIT` (the
# status-line gate requires that line on every work turn, so accepting it let
# ANY parked PR pass) and not "draft pending".
_PR_BLOCKER_RE = re.compile(
    r"\b(CI|checks?|tests?|test\.yml|land\.yml|(the )?land run|(the )?build)('s|\s+(is|are|has|have))?"
    r"\s+(still\s+|currently\s+)?(running|pending|in[ -]progress|queued|red|failing|failed)\b"
    r"|\bCI\s+(hasn'?t|has not|isn'?t|is not)\s+(finished|completed|done|green)\b"
    r"|\bwaiting (on|for) (the )?(CI|checks?|tests?|test\.yml|land\.yml|land run|build)\b"
    r"|\bmerge conflicts?\b|\bblocked on\b",
    re.IGNORECASE,
)
_DECISION_LINE_RE = re.compile(r"^[\s>*_-]*DECISION NEEDED:", re.MULTILINE)
_PR_BLOCKER_LINE_RE = re.compile(r"^[\s>*_-]*PR-BLOCKER:\**\s*(.*)$", re.MULTILINE)

def _pr_blocker_stated(text):
    if _PR_BLOCKER_RE.search(text) or _DECISION_LINE_RE.search(text):
        return True
    for m in _PR_BLOCKER_LINE_RE.finditer(text):
        reason = m.group(1).strip(' *_')
        # A PR-BLOCKER that is really "waiting on the owner" is the review ask
        # this gate exists to stop.
        if (len(reason) >= 10 and not _owner_ask(reason)
                and not re.search(r"\b(owner|you|your)\b", reason, re.IGNORECASE)):
            return True
    return False

# Board gates (NOCARD, NOWRAPUP) stand down when the owner flipped the
# board-gate escape hatch (board-gate-escape-hatch.md) or when Linear can't
# answer (CLAUDE.md §6: "If Linear is down: warn, continue untracked"). Decided
# HERE, in-process, so a stood-down board gate falls through to every later
# gate (PR, UNVERIFIED, scoring, visual, ship-check) instead of exiting the
# hook — a ship-check review found the earlier bash-side fail-open skipped all
# of them. Probed at most once, and only when a board gate would block.
_board_gate_cache = []

def _board_gate_enforced():
    if _board_gate_cache:
        return _board_gate_cache[0]
    ok = True
    try:
        import glob, subprocess
        if (os.environ.get('BOARD_GATE_DISABLED', '0') == '1'
                or glob.glob(os.path.join(os.path.expanduser('~'), '.claude', 'BOARD_GATE_DISABLED*'))):
            ok = False
        else:
            root = os.environ.get('CLAUDE_PROJECT_DIR') or subprocess.run(
                ['git', 'rev-parse', '--show-toplevel'], capture_output=True, text=True, timeout=5,
            ).stdout.strip()
            cli = os.path.join(root, 'scripts', 'linear-brain.js') if root else ''
            ok = bool(cli) and os.path.isfile(cli) and subprocess.run(
                ['node', cli, '--probe', '--timeout-ms', '4000'],
                cwd=root, capture_output=True, timeout=12,
            ).returncode == 0
            if not ok:
                sys.stderr.write('⚠️  Linear card gates skipped: Linear is unreachable or erroring. '
                                 'Continue untracked; put the Outcome text in your final message (CLAUDE.md §6).\n')
    except Exception:
        ok = False
    _board_gate_cache.append(ok)
    return ok

def _is_owner_record(r, text):
    """The owner's own typed message: origin.kind 'human' (current CLI). Older
    transcripts carry no origin, so fall back to "not meta, not a harness
    notice, not a compaction summary or interrupt marker" (Mac transcript.py
    is_real_user_msg). Consumed by the cloud chain gate only."""
    if r.get('isMeta') or r.get('isCompactSummary'):
        return False
    origin = r.get('origin') if isinstance(r.get('origin'), dict) else {}
    if origin:
        return origin.get('kind') == 'human'
    t = (text or '').lstrip()
    return bool(t) and not t.startswith(('<', '[Request interrupted', 'This session is being continued'))

events = []  # list of (kind, payload)
# kinds: 'tool' payload=(name,input,tool_use_id) | 'text' payload=str | 'result' payload=(tool_use_id, text)
tool_results_by_id = {}
# Tool calls whose result the harness flagged is_error (non-zero exit, a
# permission denial, an input error): they did not do what they asked.
tool_error_ids = set()
# The subset that never ran at all: refused by a PreToolUse hook, the
# permission classifier, input validation, or worktree isolation. A Bash
# "Exit code N" result DID run (a push piped into a grep that filtered every
# line exits 1 after the push succeeded), so it stays work. Every observed
# Edit/Write error is one of these refusals too.
tool_refused_ids = set()
_REFUSED_RE = re.compile(r'\s*(?:PreToolUse:|Permission for this action was denied|<tool_use_error>'
                         r'|This session is isolated in the worktree)')
try:
    with open(sys.argv[1]) as f:
        for line in f:
            try:
                r = json.loads(line)
            except Exception:
                continue
            mtype = r.get('type')
            msg = r.get('message', {})
            content = msg.get('content', []) if isinstance(msg, dict) else []
            if mtype == 'assistant':
                for c in content:
                    if not isinstance(c, dict):
                        continue
                    ct = c.get('type')
                    if ct == 'tool_use':
                        events.append(('tool', (c.get('name'), c.get('input', {}) or {}, c.get('id'))))
                    elif ct == 'text':
                        events.append(('text', c.get('text', '') or ''))
            elif mtype in ('attachment', 'queue-operation'):
                # Harness notices delivered MID-TURN — a background agent's
                # <task-notification> or <agent-message from=…> hand-back that
                # lands while the session is busy — are not user messages at
                # all: they are `attachment` records ({type:'queued_command',
                # prompt:'<task-notification>…'}) and the queue's own
                # enqueue/remove ledger rows ({type:'queue-operation',
                # content:'…'}). Seen in a real transcript (2026-09-28): four
                # finished agents had ONLY these shapes, no user record. Same
                # event kind as the idle-time delivery below.
                _att = r.get('attachment') if mtype == 'attachment' else r
                _txt = ''
                if isinstance(_att, dict):
                    if mtype == 'attachment' and _att.get('type') != 'queued_command':
                        continue
                    _txt = _att.get('prompt') if mtype == 'attachment' else _att.get('content')
                if isinstance(_txt, str) and ('<task-notification>' in _txt or '<agent-message' in _txt):
                    events.append(('user_notice', _txt))
                continue
            elif mtype == 'user':
                # Harness notices — <task-notification> (a background agent
                # finished), <agent-message from=…> hand-backs, queued-Routine
                # notices, and the owner's own typed prompts — arrive, when the
                # session is idle, as user messages whose content is a plain
                # STRING, not a list. They get their own event kind (consumed
                # by the in-flight gate only) so the existing user_text
                # consumers keep seeing exactly what they saw before.
                if isinstance(content, str):
                    events.append(('user_notice', content))
                    # The owner's own typed prompt (origin.kind 'human'; older
                    # transcripts: no origin, not meta, not a <notice>). Stop-hook
                    # feedback is isMeta. Consumed by the chain gate only.
                    _origin = r.get('origin') if isinstance(r.get('origin'), dict) else {}
                    _cmd = re.search(r'<command-name>/?([\w:-]+)</command-name>', content)
                    if _cmd:
                        # A slash command the owner typed (/ship-check, /what-else):
                        # counts like the Skill call, and is not new work (Mac
                        # finish-line-gate harvest_command).
                        events.append(('user_command', _cmd.group(1).split(':')[-1]))
                    elif _is_owner_record(r, content):
                        events.append(('user_human', ''))
                    continue
                # Tool results arrive as user messages with type=tool_result in their content.
                # User-typed text appears as type=text — used by the visual-qa
                # reference-attached and override-active-for-push checks.
                _list_text = ''.join(c.get('text', '') or '' for c in content
                                     if isinstance(c, dict) and c.get('type') == 'text')
                if _list_text and _is_owner_record(r, _list_text):
                    events.append(('user_human', ''))
                for c in content:
                    if not isinstance(c, dict):
                        continue
                    if c.get('type') == 'text':
                        events.append(('user_text', c.get('text', '') or ''))
                    elif c.get('type') == 'image':
                        events.append(('user_image', ''))
                    if c.get('type') == 'tool_result':
                        tid = c.get('tool_use_id')
                        body = c.get('content', '')
                        # content can be a string or a list of {type:text,text:...}
                        if isinstance(body, list):
                            body = ''.join(p.get('text', '') for p in body if isinstance(p, dict))
                        elif not isinstance(body, str):
                            body = str(body)
                        if tid:
                            tool_results_by_id[tid] = body
                            if c.get('is_error'):
                                tool_error_ids.add(tid)
                                if _REFUSED_RE.match(body or ''):
                                    tool_refused_ids.add(tid)
except Exception as e:
    print(f"ERROR:{e}")
    sys.exit(0)

# Append the live final assistant text (card #233): at Stop time this text
# has not been flushed to the transcript file yet, so every downstream check
# that scans "the most recent assistant text" or "text after the last edit"
# must see it. Appending it as the newest text event makes it visible to
# both patterns (backward-scan-for-most-recent AND forward-scan-from-index)
# without touching each check's logic individually.
_last_msg = os.environ.get('VE_LAST_MSG', '').strip()
if _last_msg:
    events.append(('text', _last_msg))

# Find most recent qualifying code edit. Also tally the total count of
# qualifying edits (card 387): this doubles as a monotonic fingerprint of
# "the current gated edit-set" for the NO-VERIFY bypass memo below — it only
# grows when a NEW qualifying edit lands, so comparing it across Stop events
# tells us whether anything gate-relevant changed since a bypass was logged.
last_edit_idx = None
last_edit_file = None
total_qualifying_edits = 0
for i in range(len(events) - 1, -1, -1):
    kind, payload = events[i]
    if kind != 'tool':
        continue
    name, inp, _tid = payload
    if name not in ('Edit', 'Write', 'NotebookEdit'):
        continue
    if _tid in tool_refused_ids:
        continue   # refused before it ran: the file did not change
    fp = inp.get('file_path', '') or ''
    if not fp.endswith(CODE_EXTS):
        continue
    if any(s in fp for s in EXEMPT_SUBSTRINGS):
        continue
    # Skip test files — running them IS the verification, but we don't require running OTHER files when a test was edited
    # (Actually no — even test edits should be run. Keep them in.)
    total_qualifying_edits += 1
    if last_edit_idx is None:
        last_edit_idx = i
        last_edit_file = fp

# ─── Session status-line gate (added 2026-08-23) ─────────────────────────────
# The local ~/.claude/hooks/exit-status-gate.sh enforces a "SAFE TO EXIT" /
# "NOT SAFE TO EXIT" closing line (and refuses the SAFE claim when a DECISION
# NEEDED block is still pending) — see .claude/commands/wrap-up.md. It is a
# user-level hook that was never ported to cloud (named in CLOUD.md's list of
# "12 other user-level hooks [that] DO NOT fire in cloud"), so cloud/iOS
# sessions had zero enforcement of it — root cause of 8 iOS sessions in one
# day never saying whether it was safe to end the conversation, and punting
# decisions back to a non-technical owner instead of making the call.
#
# This is a deliberately smaller reimplementation, NOT a full port: the real
# hook also runs Gate W/T (workspace/task-ref resolution against the local
# ~/.claude/tasks store, which this sandbox doesn't have — see
# scripts/lib/exit-status-gate-taskref.test.mjs for what that covers). Only
# the two checks that explain today's actual failures are implemented here.
#
# Scope: only fires once the session did something worth reporting on (a
# qualifying code edit, a push/commit, or a GitHub MCP write) — never gates
# an ordinary conversational turn. Kill switch: SESSION_STATUS_GATE_DISABLE=1.
if os.environ.get('SESSION_STATUS_GATE_DISABLE', '0') != '1':
    try:
        did_substantial_work = total_qualifying_edits > 0 or any(
            _kind == 'tool' and _is_work_tool(_payload[0], _payload[1], _payload[2])
            for _kind, _payload in events
        )
        # NOTE: deliberately does NOT require `_last_msg` to be non-empty (ship-check
        # adversarial review, task a7d9c07f) — a turn whose last action is a tool call
        # with no closing text has _last_msg == '' and genuinely has no status line.
        # Treating empty as "skip" would silently defeat the whole gate on exactly the
        # turn shape (tool-call-only ending) most likely to skip a wrap-up in practice.
        if did_substantial_work and 'NO-VERIFY:' not in (_last_msg or ''):
            _stripped = re.sub(r'```.*?```', '', _last_msg or '', flags=re.DOTALL)
            _content_lines = [ln.strip() for ln in _stripped.strip().splitlines() if ln.strip()]
            # wrap-up.md's own SESSION STATUS block puts a decorative divider
            # rule AFTER the status line ("must be the last content line (the
            # closing rule is fine)") — drop trailing divider-only lines so a
            # correctly-formatted wrap-up isn't misread as having no status line.
            _divider_re = re.compile(r'^[\-=_*~─━│┃┌┐└┘•·\s]+$')
            while _content_lines and _divider_re.match(_content_lines[-1]):
                _content_lines.pop()
            _last_line = _content_lines[-1] if _content_lines else ''
            _has_status_line = bool(re.match(r'^(NOT )?SAFE TO EXIT\b', _last_line))
            _claims_safe = bool(re.match(r'^SAFE TO EXIT\b', _last_line))
            # Line-anchored + colon-suffixed to match the canonical template
            # token exactly (wrap-up.md's "DECISION NEEDED:" block header) —
            # a bare substring match wrongly tripped on prose like "there's no
            # DECISION NEEDED here" (ship-check adversarial review).
            _has_decision_needed = bool(re.search(r'^DECISION NEEDED:', _stripped, re.MULTILINE))
            if not _has_status_line:
                _ve_block("NOSTATUSLINE")
            if _has_decision_needed and _claims_safe:
                _ve_block("FALSESAFE")
    except Exception:
        pass  # fail-open — never let this gate crash the rest of the script

# ─── In-flight-work gate (INFLIGHT, added 2026-09-28) ───────────────────────
# Owner evidence (session 01JhF7pK, 2026-09-28): a session with ten background
# agents running, a Land run in progress and two scheduled check-ins ended a
# turn on "SAFE TO EXIT". The owner reads that line as "I may close or kill
# this session now" — and had been doing exactly that to earlier sessions that
# were still mid-work. Every gate above checks the status LINE'S SHAPE or the
# board close-out; none asks whether anything is still running that would die
# with the session. This one does, from the transcript alone (there is no
# live state to read — /second-opinion review a5a8923c):
#   - a self-bound Routine still to fire: mcp__Claude_Code_Remote__send_later
#     (a one-shot into THIS session) or create_trigger without
#     persistent_session_id / create_new_session_on_fire. Its id comes from
#     the tool's own result ("trigger_id":"trig_…" or {"trigger":{"id":…}}).
#     A one-shot is live while its fire time (send_later's fire_at, or
#     run_once_at, as last set by update_trigger) is still ahead of now; a
#     cron Routine is live until delete_trigger or update_trigger
#     enabled:false. The firing itself never echoes the id (it arrives as a
#     queued-notifications notice plus a ReadNotifications body), so time is
#     the only honest signal.
#   - a background Agent without a completion: "agentId: X" in the Agent
#     result (a foreground Agent returns its report inline and never
#     matches). Completed by a later <task-notification> whose <task-id> is X
#     (any status — failed counts), an <agent-message from="X"> hand-back, or
#     TaskStop(X). A later SendMessage(to=X) resumes it: live again until the
#     next completion, so each id keeps its latest start and completion index.
#     Background Bash is deliberately NOT tracked: the review found two of
#     four background commands in a real transcript finished without any
#     notice — a guaranteed false positive.
#   Those notices arrive as user messages whose content is a plain STRING
#   (session idle) or as `attachment` / `queue-operation` records (delivered
#   mid-turn) — none of which the parser above used to read — hence the
#   separate 'user_notice' event kind it now emits, consumed only here.
# Placed right after the status-line gate: a live id with SAFE TO EXIT as the
# closing line blocks before any board/PR gate can, and the demanded rewrite
# (NOT SAFE TO EXIT — <what is still running>) passes every gate below. Own
# block, own try/except, own last-line parse (never the status-line gate's
# locals, which SESSION_STATUS_GATE_DISABLE=1 leaves undefined). Not gated on
# "did substantial work": a session that only spawned agents did no edit yet
# still dies if closed. Kill switch: INFLIGHT_GATE_DISABLE=1. Fail-open.
if os.environ.get('INFLIGHT_GATE_DISABLE', '0') != '1':
    try:
        _if_stripped = re.sub(r'```.*?```', '', _last_msg or '', flags=re.DOTALL)
        _if_lines = [ln.strip() for ln in _if_stripped.strip().splitlines() if ln.strip()]
        _if_divider_re = re.compile(r'^[\-=_*~─━│┃┌┐└┘•·\s]+$')
        while _if_lines and _if_divider_re.match(_if_lines[-1]):
            _if_lines.pop()
        _if_last_line = _if_lines[-1] if _if_lines else ''
        if re.match(r'^SAFE TO EXIT\b', _if_last_line) and 'NO-VERIFY:' not in (_last_msg or ''):
            from datetime import datetime, timezone

            def _if_parse_ts(s):
                try:
                    return datetime.fromisoformat(str(s).strip().replace('Z', '+00:00')).timestamp()
                except Exception:
                    return None

            _if_now = datetime.now(timezone.utc).timestamp()
            _if_trig_id_re = re.compile(r'"(?:trigger_id|id)"\s*:\s*"(trig_[0-9A-Za-z]+)"')
            _TRIG_CREATE = ('mcp__Claude_Code_Remote__send_later', 'mcp__Claude_Code_Remote__create_trigger')
            _trig = {}          # trig id -> {'idx', 'label', 'fire' (ts|None for cron), 'done' (idx)}
            _agent_start = {}   # agent id -> (idx, label)
            _agent_done = {}    # agent id -> idx

            for _i3, (_kind3, _payload3) in enumerate(events):
                if _kind3 == 'tool':
                    _name3, _inp3, _tid3 = _payload3
                    _inp3 = _inp3 if isinstance(_inp3, dict) else {}
                    _res3 = tool_results_by_id.get(_tid3, '') or ''
                    if _name3 in _TRIG_CREATE:
                        if _inp3.get('persistent_session_id') or _inp3.get('create_new_session_on_fire'):
                            continue  # fires into another session — this one's death does not lose it
                        _m3 = _if_trig_id_re.search(_res3)
                        if not _m3:
                            continue  # the call failed (no id in its result) — nothing was scheduled
                        _fire3 = None
                        if _name3.endswith('send_later'):
                            _fm = re.search(r'"fire_at"\s*:\s*"([^"]+)"', _res3)
                            _fire3 = _if_parse_ts(_fm.group(1)) if _fm else _if_now + 1
                        elif _inp3.get('run_once_at'):
                            _fire3 = _if_parse_ts(_inp3.get('run_once_at'))
                        _label3 = _inp3.get('name') or re.sub(r'\s+', ' ', _inp3.get('message') or _inp3.get('prompt') or '')[:60]
                        _trig[_m3.group(1)] = {'idx': _i3, 'label': _label3, 'fire': _fire3, 'done': -1}
                    elif _name3 == 'mcp__Claude_Code_Remote__update_trigger':
                        _uid3 = str(_inp3.get('trigger_id') or '')
                        if _uid3 in _trig and 'error' not in _res3[:200].lower():
                            if _inp3.get('run_once_at'):
                                _trig[_uid3]['fire'] = _if_parse_ts(_inp3.get('run_once_at'))
                                _trig[_uid3]['idx'] = _i3
                            if _inp3.get('cron_expression'):
                                _trig[_uid3]['fire'] = None
                                _trig[_uid3]['idx'] = _i3
                            if _inp3.get('enabled') is False:
                                _trig[_uid3]['done'] = _i3
                            elif _inp3.get('enabled') is True:
                                _trig[_uid3]['idx'] = _i3
                    elif _name3 == 'mcp__Claude_Code_Remote__delete_trigger':
                        _did3 = str(_inp3.get('trigger_id') or '')
                        if _did3 in _trig and 'error' not in _res3[:200].lower():
                            _trig[_did3]['done'] = _i3
                    elif _name3 == 'Agent':
                        _m3 = re.search(r'\bagentId:\s*([0-9a-z]{6,})', _res3)
                        if _m3:
                            _agent_start[_m3.group(1)] = (_i3, 'Agent "%s"' % (_inp3.get('description') or '')[:50])
                    elif _name3 == 'SendMessage':
                        _to3 = str(_inp3.get('to') or '').strip()
                        if _to3 in _agent_start and 'error' not in _res3[:200].lower():
                            _agent_start[_to3] = (_i3, _agent_start[_to3][1].replace(' (resumed)', '') + ' (resumed)')
                    elif _name3 == 'TaskStop':
                        _stop3 = str(_inp3.get('task_id') or _inp3.get('taskId') or '').strip()
                        if _stop3:
                            _agent_done[_stop3] = _i3
                elif _kind3 in ('user_notice', 'user_text'):
                    for _mn in re.finditer(r'<task-notification>(.*?)</task-notification>', _payload3 or '', flags=re.DOTALL):
                        _idm = re.search(r'<task-id>\s*([^<\s]+)\s*</task-id>', _mn.group(1))
                        if _idm:
                            _agent_done[_idm.group(1)] = _i3
                    for _mh in re.finditer(r'<agent-message\s+from="([^"]+)"', _payload3 or ''):
                        _agent_done[_mh.group(1)] = _i3

            _live = []
            for _tid_l, _t in _trig.items():
                if _t['done'] >= _t['idx']:
                    continue
                if _t['fire'] is not None and _t['fire'] <= _if_now:
                    continue  # a one-shot that has already fired
                _when = ('fires %s' % datetime.fromtimestamp(_t['fire'], timezone.utc).strftime('%Y-%m-%dT%H:%MZ')) if _t['fire'] else 'recurring'
                _live.append('trigger %s "%s" (%s)' % (_tid_l, _t['label'], _when))
            for _aid_l, (_idx_l, _lab_l) in _agent_start.items():
                if _agent_done.get(_aid_l, -1) < _idx_l:
                    _live.append('%s [%s]' % (_lab_l, _aid_l))
            if _live and not _ve_seen('INFLIGHT'):
                sys.stderr.write('   still in flight: ' + '; '.join(_live[:8])
                                 + ('; +%d more' % (len(_live) - 8) if len(_live) > 8 else '') + '\n')
                _ve_block("INFLIGHT")
    except Exception:
        pass  # fail-open — never let this gate crash the rest of the script

# ─── PR follow-through gate (added 2026-08-23) ───────────────────────────────
# Cloud sessions have no `gh` CLI (see .claude/CLOUD.md) and create/merge PRs
# via the GitHub MCP connector (mcp__github__create_pull_request /
# mcp__github__merge_pull_request) — tool names none of pre-push-review-gate.sh
# / pre-merge-review-gate.sh (matcher: "Bash" only) ever see. This project's
# own memory rule is explicit that the owner does not review PRs
# (cloud-memory/feedback_no_review_offers_user_not_technical.md, 2026-08-22
# addendum: "once a PR's own CI is green ... mark it ready and merge it
# yourself ... A draft PR sitting untouched is the same failure as asking
# should I commit or do you want to review"). Nothing enforced that before
# this. Kill switch: PR_FOLLOWTHROUGH_GATE_DISABLE=1.
if os.environ.get('PR_FOLLOWTHROUGH_GATE_DISABLE', '0') != '1':
    try:
        _opened_pr = False
        _merged_pr = False
        _landed_pushed = False     # pushed to land/** (git or MCP create_branch/dispatch)
        _land_followed = False     # checked a workflow run after that push
        # Anchored: `git push origin HEAD:refs/heads/land/x`, `... HEAD:land/x`,
        # `git push origin land/x` — not `foo-land/`.
        _land_push_re = re.compile(r'git\s+push\b[^\n;&|]*\s(\S*:)?(refs/heads/)?land/')
        for _kind, _payload in events:
            if _kind != 'tool':
                continue
            _name, _inp, _tid = _payload
            _inp = _inp if isinstance(_inp, dict) else {}
            if _name == 'mcp__github__create_pull_request':
                _opened_pr = True
            elif _name == 'mcp__github__merge_pull_request':
                # Only a merge that happened counts (BRO-4238): github-main-guard.sh
                # now refuses Broadwayscore merges, and a refused attempt must not
                # switch off the follow-through checks below. Positive match on the
                # success payload ({"sha":…,"merged":true,…}): API failures read
                # "failed to merge …: 405 …" and denials carry no "error" word.
                if re.search(r'"merged"\s*:\s*true', tool_results_by_id.get(_tid, '') or ''):
                    _merged_pr = True
            elif _name == 'Bash' and _land_push_re.search(_inp.get('command') or ''):
                _landed_pushed = True
            elif _name == 'mcp__github__create_branch' and str(_inp.get('branch') or '').startswith('land/'):
                _landed_pushed = True
            elif (_name == 'mcp__github__actions_run_trigger'
                  and 'land' in str(_inp.get('workflow_id') or '')):
                _landed_pushed = True
            elif _landed_pushed and _name in ('mcp__github__actions_get', 'mcp__github__actions_list'):
                _land_followed = True
        _msg_ok = bool(_last_msg) and 'NO-VERIFY:' not in _last_msg
        _stripped_owner = re.sub(r'```.*?```', '', _last_msg or '', flags=re.DOTALL)
        # OWNERMERGE (2026-09-27): the owner never merges — this repo lands via
        # land/** (land.yml). "NOT SAFE TO EXIT — waiting on your merge" used
        # to satisfy the blocker regex below; three iOS sessions in one day
        # parked finished work that way. Merge-asks only: "waiting on your
        # decision" / DECISION NEEDED stay legitimate.
        # Addressed-to-you forms only: "the owner ... merge" reads as a
        # description of the rule ("never ask the owner to merge") and false-
        # positived on the very session that shipped this gate. Quoted and
        # backticked spans are dropped too, so citing the phrase is safe.
        # Review-asks too (2026-09-28): the owner never REVIEWS either.
        # Session 01Fn6CXk parked PR #947 ~11h on "NOT SAFE TO EXIT — PR still
        # open and unreviewed" / "ready for your review", neither of which
        # matched the merge-only forms above. "Waiting ..." (not "wait") so a
        # description like "never wait for review" doesn't trip it.
        # Patterns: _MERGE_ASK_RE / _REVIEW_ASK_RE via _owner_ask() (top of script).
        _owner_scan = re.sub(r'`[^`\n]*`|"[^"\n]*"|\u201c[^\u201d\n]*\u201d', '', _stripped_owner)
        if (_msg_ok and (_opened_pr or _landed_pushed) and not _merged_pr
                and _owner_ask(_owner_scan)):
            _ve_block("OWNERMERGE")
        # A land/** push is follow-through, but not proof it landed (land.yml
        # can refuse): SAFE TO EXIT additionally needs a later run check.
        if (_msg_ok and _landed_pushed and not _land_followed and not _merged_pr
                and re.search(r'^SAFE TO EXIT\b', _stripped_owner.strip().splitlines()[-1] if _stripped_owner.strip() else '')):
            _ve_block("LANDUNCHECKED")
        if _landed_pushed:
            _merged_pr = True
        if _opened_pr and not _merged_pr and _msg_ok:
            # Strip fences here too (ship-check adversarial review found this
            # asymmetric with the status gate above) — a quoted example
            # containing blocker-shaped text must not satisfy the check.
            # Bare "blocked" dropped in favor of "blocked on" — too generic on
            # its own (matched unrelated "the cron is blocked on rate limits").
            # `NOT SAFE TO EXIT` and `draft (by design|pending)` no longer
            # count (2026-09-28): the status-line gate REQUIRES every
            # substantial-work message to end in (NOT) SAFE TO EXIT, so
            # accepting it here meant ANY parked PR passed. A still-running CI
            # run is the one common legitimate wait, so it's named explicitly;
            # anything else goes on a `PR-BLOCKER: <specific reason>` line.
            _pr_stripped = re.sub(r'```.*?```', '', _last_msg, flags=re.DOTALL)
            # `DECISION NEEDED:` sits outside the \b(...)\b group: a trailing
            # \b can never match after the colon, so it silently never matched
            # before — the bare NOT SAFE TO EXIT alternative masked that.
            if not _pr_blocker_stated(_pr_stripped):
                _ve_block("PRUNMERGED")
    except Exception:
        pass  # fail-open — never let this gate crash the rest of the script

# ─── Card-first gate (added 2026-09-28) ─────────────────────────────────────
# CLAUDE.md §6: every session files (or claims) its Linear card at the start.
# Cloud had no enforcement — the local ~/.claude notion-card-required-* gates
# never fire here — and the SessionStart banner still pointed at the retired
# notion-brain.js, so a session (01Fn6CXk, 2026-09-27) edited, pushed and
# merged a PR with no card at all. A Stop-time check, not a PreToolUse one on
# commit: a /plan-review found a PreToolUse gate too easy to wedge (compaction,
# stderr-only markers, subagents) for an every-commit block. Runs AFTER the
# PR gates so a card-less session that parks a PR hits the PR gate first.
# Stands down (and falls through) via _board_gate_enforced().
# Bypass: `NO-CARD: <reason ≥10 chars>`. Kill switch: CARD_GATE_DISABLE=1.
if os.environ.get('CARD_GATE_DISABLE', '0') != '1':
    try:
        _did_work_nc = any(
            _kind == 'tool' and _is_work_tool(_payload[0], _payload[1], _payload[2])
            for _kind, _payload in events
        )
        _nc_msg = re.sub(r'```.*?```', '', _last_msg or '', flags=re.DOTALL)
        if (_did_work_nc and 'NO-VERIFY:' not in _nc_msg
                and not re.search(r'NO-CARD:\s*\S.{9,}', _nc_msg)
                and not _session_has_card()
                and _board_gate_enforced()):
            _ve_block("NOCARD")
    except Exception:
        pass  # fail-open — never let this gate crash the rest of the script

# ─── Wrap-up-close-out gate (added 2026-08-25, redesigned same day) ──────────
# Real-world evidence: a session's final message read "SAFE TO EXIT — fix
# confirmed live in production, nothing outstanding" — a perfectly formatted
# status line — but when directly asked "did you run /wrap-up and /what-else?"
# the session admitted it had run neither. The session-status-line gate above
# only checks the LINE'S TEXT SHAPE; it has no way to know whether the
# mandatory close-out skill actually ran.
#
# v1 of this gate (shipped same day, PR #708) checked for a `Skill` tool_use
# with skill=='wrap-up' after the last substantial-work event. The owner
# rejected that as too weak: invoking the skill only loads its instructions
# into context — it doesn't verify the session actually DID anything wrap-up
# mandates, so a token Skill call would satisfy the gate while changing
# nothing about the real failure mode (the evidence session never touched
# its board card). Redesigned to check for the concrete ARTIFACT wrap-up.md's
# Phase 4 requires instead of the tool-name gesture: this session's Linear
# card actually closed out (Done, or parked in Backlog) via `linear-brain.js
# update` / `linear-session.js report` (originally a Notion card via
# notion-brain.js; Notion is retired, BRO-4274) — the one
# phase CLAUDE.md §6 independently mandates for every session regardless of
# size ("Session end: ... -> Done/Paused"), unlike /what-else (Phase 2, which
# Quick sessions skip) or the async-op check (Phase 3 — out of scope for THIS
# gate; since 2026-09-28 the in-flight gate above covers its agent and
# self-bound-Routine half from the transcript, CI runs stay the session's job). Satisfying this check IS the required
# outcome, not a proxy for it — it can't be gamed by going through empty
# motions the way a bare Skill call can.
#
# Detection is position-aware (mirrors the ship-check gate's scan_start
# convention: the close-out must appear STRICTLY AFTER the last
# substantial-work event, so an early close-out can't cover later, uncovered
# work — /second-opinion review, task adae199b, found this exact gaming path
# in the first "anywhere in session" draft) and tokenizes the Bash command
# with shlex rather than regex-searching the raw string (a second
# /second-opinion review of THIS redesign found the naive regex exploitable:
# this repo's own docs/commit conventions routinely quote the literal example
# `--status Done` INSIDE an unrelated --outcome/--notes argument's prose, and
# a whole-string regex can't tell that from a real flag — see
# _board_closeout_status()'s comment near the top of this script for the
# fix). Deliberately a separate, self-contained block (not nested in the
# session-status-line gate above, and NOT reusing its locals) so
# SESSION_STATUS_GATE_DISABLE can't accidentally also disable this gate via a
# NameError-then-fail-open path. Kill switch: WRAPUP_GATE_DISABLE=1 (kept
# from v1 — same gate, stronger check).
if os.environ.get('WRAPUP_GATE_DISABLE', '0') != '1':
    try:
        _last_work_idx = None
        for _i, (_kind, _payload) in enumerate(events):
            if _kind == 'tool' and _is_work_tool(_payload[0], _payload[1], _payload[2]):
                _last_work_idx = _i

        # A session that declared NO-CARD and really has no card (none filed
        # or claimed) has nothing to close; NOCARD accepted that, so NOWRAPUP
        # must too. A session that DID file a card can't use NO-CARD to skip
        # closing it (adversarial review, BRO-4274).
        _wu_no_card = (bool(re.search(r'NO-CARD:\s*\S.{9,}', re.sub(r'```.*?```', '', _last_msg or '', flags=re.DOTALL)))
                       and not _session_has_card())
        if (_last_work_idx is not None and _last_msg and 'NO-VERIFY:' not in _last_msg
                and not _wu_no_card):
            _wu_stripped = re.sub(r'```.*?```', '', _last_msg, flags=re.DOTALL)
            _wu_lines = [ln.strip() for ln in _wu_stripped.strip().splitlines() if ln.strip()]
            _wu_divider_re = re.compile(r'^[\-=_*~─━│┃┌┐└┘•·\s]+$')
            while _wu_lines and _wu_divider_re.match(_wu_lines[-1]):
                _wu_lines.pop()
            _wu_last_line = _wu_lines[-1] if _wu_lines else ''
            _wu_claims_safe = bool(re.match(r'^SAFE TO EXIT\b', _wu_last_line))
            if _wu_claims_safe:
                _wrapup_closed_out = False
                for _i2 in range(_last_work_idx + 1, len(events)):
                    _kind2, _payload2 = events[_i2]
                    if _kind2 != 'tool':
                        continue
                    _name2, _inp2, _tid2 = _payload2
                    if _name2 == 'Bash':
                        _status_val = _board_closeout_status(_inp2.get('command') or '')
                        # A close-out that errored (is_error: exit !=0, denied, crashed)
                        # left the card as it was (BRO-4238 what-else).
                        if (_status_val in _CLOSEOUT_STATES
                                and _tid2 not in tool_error_ids
                                and not _CLOSEOUT_REFUSED_RE.search(tool_results_by_id.get(_tid2, '') or '')):
                            _wrapup_closed_out = True
                            break
                if not _wrapup_closed_out and _board_gate_enforced():
                    _ve_block("NOWRAPUP")
    except Exception:
        pass  # fail-open — never let this gate crash the rest of the script

# Detect audit sweeps: sessions that edit data/review-texts/ flag fields via Bash
# (not Edit tool). These bypass the is_scoring_edit gate because last_edit_file never
# matches SCORING_LOGIC_SUBSTRINGS. Detect by presence of 'review-texts' in any Bash cmd.
# An "audit sweep" is a Bash command that *mutates* files under data/review-texts/.
# Mere mention of the path (e.g., in a notion-brain --notes arg, a ls/grep, or a
# git log string) is NOT a sweep — those tripped this flag for the entire session
# and slapped the scoring-delta gate onto every unrelated edit. Require both:
# the path appears AND a write primitive appears in the same command.
#
# The heredoc-body-stripping helper used below is now defined near the top
# of the script (hoisted 2026-08-25 so the wrap-up-close-out gate can also
# use it before this point in the file executes) — see that definition's
# comment for the stripping rationale and known gaps.

# Each alternation requires BOTH the write primitive AND the review-texts path
# to be locally adjacent in the same statement. Bare `sed -i` is no longer
# enough — an echo string like `echo "=== T2: real sed -i on review-texts"`
# embeds the bytes but never executes them. Statement-boundary anchor
# `(?:^|[\n;&|]\s*)` requires the primitive to start a fresh shell statement
# (not be mid-string).
_STMT = r'(?:^|[\n;&|]\s*)'
_audit_write_re = re.compile(
    r'(?:'
    # In-place edit ON a review-texts path (within the same statement; bounded
    # by the next statement separator)
    rf'{_STMT}sed\s+-i[^\n;&|]{{0,300}}review-texts/'
    rf'|{_STMT}perl\s+-(?:pi|i)[^\n;&|]{{0,300}}review-texts/'
    # find ... data/review-texts ... -exec sed/rm/mv/cp/perl
    rf'|{_STMT}find\s+\S*review-texts\S*[^;&|]*-exec\s+\S*(?:sed|rm|mv|cp|perl)'
    # xargs sed/rm/mv/cp/perl operating on review-texts
    rf'|{_STMT}xargs\s+\S*(?:sed|rm|mv|cp|perl)\b[^\n;&|]{{0,300}}review-texts/'
    # mv/cp/rm/tee targeting review-texts
    rf'|{_STMT}(?:mv|cp|rm)\s+[^|;&\n]{{0,300}}review-texts/'
    rf'|{_STMT}tee\s+\S*review-texts/'
    # Shell redirect into review-texts (write side of `>` and `>>`)
    r'|>>?\s*\S*review-texts/'
    # Node/Bun writer calls — must include review-texts in args (locality is
    # natural because these are single function-call expressions)
    r'|writeFileSync\([^)]*review-texts'
    r'|appendFileSync\([^)]*review-texts'
    r'|createWriteStream\([^)]*review-texts'
    r'|fs\.(?:writeFile|appendFile|rename|cp)[^(]*\([^)]*review-texts'
    r'|Bun\.write\([^)]*review-texts'
    # python -c "...open('.../review-texts/...', 'w')..."
    rf"|{_STMT}python3?\s+-c\s+['\"][^'\"]*open\([^)]*review-texts"
    r')',
    re.MULTILINE,
)
def _is_review_texts_write(cmd: str) -> bool:
    if not cmd:
        return False
    # Heredoc bodies are data, not executable commands. Strip them before
    # scanning so test fixtures and JSONL transcripts don't trigger.
    cmd = _strip_heredocs(cmd)
    # Each alternation now embeds the review-texts requirement, so the prior
    # outer `'review-texts' in cmd` shortcut is no longer needed.
    return bool(_audit_write_re.search(cmd))

sweep_write_count = sum(
    1 for kind, payload in events
    if kind == 'tool' and payload[0] == 'Bash'
    and _is_review_texts_write(payload[1].get('command', '') or '')
)
ran_audit_sweep = sweep_write_count > 0

# Human-time-estimate gate (added 2026-05-30): fires on every Stop, even with
# no edit. The user said "sessions make bad decisions based on these inflated
# estimates" — catching it must not require a code edit to have happened.
import re as _ht_re
_HUMAN_TIME_ESTIMATE_RE = _ht_re.compile(
    r'\b('
    r'half\s+a?\s*day|'
    r'(?:a\s+)?couple\s+(?:of\s+)?(?:hours?|days?|weeks?)|'
    r'(?:a\s+)?few\s+(?:hours?|days?|weeks?)|'
    r'(?:will|would|should|gonna|going\s+to|takes?|estimate(?:d|s)?|need|require(?:s|d)?)\s+'
    r'(?:about\s+|roughly\s+|~|approximately\s+)?'
    r'\d{1,3}\s*(?:[-–]\s*\d{1,3}\s*)?'
    r'(?:hours?|days?|weeks?|hrs?)|'
    r'\d{1,3}\s*(?:hours?|days?|weeks?)\s+(?:of\s+)?(?:work|effort|engineering|coding|editing)'
    r')\b',
    _ht_re.IGNORECASE,
)
for _i in range(len(events) - 1, -1, -1):
    _k, _p = events[_i]
    if _k == 'text':
        _txt = _p or ''
        _m = _HUMAN_TIME_ESTIMATE_RE.search(_txt)
        if _m and 'NO-VERIFY:' not in _txt and not _ve_seen('HUMAN_TIME_ESTIMATE'):
            print(f"HUMAN_TIME_ESTIMATE:{_m.group(1)}")
            sys.exit(0)
        break  # only the most recent assistant_text counts

# NO-VERIFY bypass idempotency (card 387, 2026-07-24): a bypass declared once
# for the current gate-relevant edit-set must not have to be restated on
# every later turn-end. The generic/scoring/shipcheck/visual "verified" paths
# below are already idempotent for free — they scan forward from last_edit_idx,
# which is a stable index in the append-only transcript, so a qualifying Bash
# found once stays found on every future replay. NO-VERIFY was the ONE
# exception: it was scanned only from the last USER message onward (needed so
# same-turn NO-VERIFY written before the Edit call is still seen), which means
# a bypass declared in turn N goes out of range the moment turn N+1 starts,
# even with zero new edits — forcing the same declaration to be retyped every
# turn (owner report, screenshot of session 1013c9a2). Fix: persist the
# fingerprint of the edit-set (qualifying edits + audit-sweep writes, both
# monotonic) at which NO-VERIFY was last honored; short-circuit here while it
# still matches. A NEW qualifying edit or sweep-write changes the fingerprint
# and re-arms every gate below immediately.
_edit_fingerprint = total_qualifying_edits * 1000003 + sweep_write_count
_state_path = '/tmp/verify-edits-satisfied-' + \
    hashlib.md5(sys.argv[1].encode()).hexdigest()[:16] + '.json'

def _read_verify_state():
    # Must return a dict — a non-dict value (e.g. corrupted/tampered state
    # file containing a bare number or list) would raise on the .get() call
    # below with no enclosing try/except in this script (unlike
    # finish-line-gate.sh, which fails open on ANY exception by design).
    # That crash would print nothing, bash would see an empty $result, and
    # the gate would silently pass — a fail-OPEN path in a script that's
    # meant to fail closed. Guard it here instead (ship-check finding, card 387).
    try:
        with open(_state_path) as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}

def _write_verify_state(fp):
    try:
        with open(_state_path, 'w') as f:
            json.dump({'bypassSatisfiedAt': fp}, f)
    except OSError:
        pass

# ─── Cloud finish-line chain (BRO-4238 phase 2) ──────────────────────────────
# Port of the Mac finish-line-gate's Gates 1 and 4 into the cloud Stop hook.
# A SAFE TO EXIT claim after code edits needs (a) a review since those edits,
# (b) an actual /what-else run and (c) an actual /wrap-up run for this piece
# of work. Before this, the only review gate here fired for scripts/lib/ alone
# (and never for workflows, which EXEMPT_SUBSTRINGS drops), so a session
# edited .claude/hooks/*.sh, claimed SAFE TO EXIT and ran neither until the
# owner asked (2026-09-29).
# Parity with the Mac gate (BRO-4367, same day: a session ran /second-opinion
# plus an Agent "code review", did wrap-up "by hand" and passed): only Skill
# calls or owner-typed slash commands count (an Agent description or a codex
# call is not a review here; the older UNSHIPCHECKED gate still accepts them),
# a session with more than CHAIN_BIG_SESSION_EDITS code edits needs /ship-check
# or /code-review, and /wrap-up must actually run. NOWRAPUP above still
# requires wrap-up's real outcome (the Linear close-out) on top of this.
# Mid-work Stops (NOT SAFE TO EXIT) are left alone. Bypass: NO-SHIP-CHECK:
# <reason> for the review (NO-VERIFY: waives execution evidence only),
# NO-WHAT-ELSE: <reason> and NO-WRAP-UP: <reason> for the other two.
# Kill switch: CLOUD_CHAIN_GATE_DISABLE=1. Fails open on any error.
CHAIN_TRIGGER_DIRS = ('/src/', '/scripts/', '/.claude/hooks/', '/.github/workflows/', '/supabase/')
CHAIN_TRIGGER_EXTS = CODE_EXTS + ('.yml', '.yaml', '.sql')
CHAIN_STRONG_REVIEWS = ('ship-check', 'code-review')
CHAIN_REVIEW_SKILLS = CHAIN_STRONG_REVIEWS + ('second-opinion',)
CHAIN_BIG_SESSION_EDITS = 15   # Mac BIG_SESSION_EDITS
CHAIN_FIXUP_BUDGET = 8   # edits right after a review are its fixups (Mac FIXUP_BUDGET)

def _chain_result():
    stripped = re.sub(r'```.*?```', '', _last_msg or '', flags=re.DOTALL)
    lines = [ln.strip() for ln in stripped.strip().splitlines() if ln.strip()]
    divider = re.compile(r'^[\-=_*~─━│┃┌┐└┘•·\s]+$')
    while lines and divider.match(lines[-1]):
        lines.pop()
    if not lines or not re.match(r'^SAFE TO EXIT\b', lines[-1]):
        return None
    def is_trigger(fp):
        return (fp.endswith(CHAIN_TRIGGER_EXTS) and '/node_modules/' not in fp
                and (any(d in fp for d in CHAIN_TRIGGER_DIRS)
                     or fp.startswith(tuple(d.lstrip('/') for d in CHAIN_TRIGGER_DIRS))))
    edits, reviews, what_else, wrap_up, humans, bash_cmds = [], [], [], [], [], []
    for i, (kind, payload) in enumerate(events):
        if kind == 'user_human':
            humans.append(i)
            continue
        if kind == 'user_command':
            if payload in CHAIN_REVIEW_SKILLS:
                reviews.append((i, payload))
            elif payload == 'what-else':
                what_else.append(i)
            elif payload == 'wrap-up':
                wrap_up.append(i)
            continue
        if kind != 'tool':
            continue
        name, inp, _tid = payload
        if name in ('Edit', 'Write', 'MultiEdit', 'NotebookEdit'):
            fp = inp.get('file_path', '') or inp.get('notebook_path', '') or ''
            if is_trigger(fp) and _tid not in tool_refused_ids:
                edits.append((i, os.path.basename(fp)))
        elif name == 'Bash' and _tid not in tool_refused_ids:
            bash_cmds.append((i, inp.get('command', '') or ''))
        if name == 'Skill':
            # Namespaced skills ("plugin:ship-check") normalize like typed commands.
            sk = (inp.get('skill') or '').split(':')[-1]
            if sk in CHAIN_REVIEW_SKILLS:
                reviews.append((i, sk))
            elif sk == 'what-else':
                what_else.append(i)
            elif sk == 'wrap-up':
                wrap_up.append(i)
    # Bash-side edits (sed -i, cat >, cp, python open(...,'w')): most of the
    # motivating session's edits went through Bash, invisible to Edit/Write.
    edits.extend(_bash_code_edits(bash_cmds, is_trigger))
    edits.sort()
    if not edits:
        return None
    turn_text = '\n'.join(p for k, p in events[(humans[-1] if humans else 0):] if k == 'text')
    turn_text = re.sub(r'```.*?```', '', turn_text, flags=re.DOTALL)
    missing = []
    # Review: every code edit is covered by an earlier review, except up to
    # CHAIN_FIXUP_BUDGET fixups made before the owner's next message. A big
    # session (Mac BIG_SESSION_EDITS) needs a strong review; /second-opinion
    # is for small diffs only.
    big = len(edits) > CHAIN_BIG_SESSION_EDITS
    usable = [i for i, sk in reviews if not big or sk in CHAIN_STRONG_REVIEWS]
    last_review = usable[-1] if usable else None
    after = [e for e in edits if last_review is None or e[0] > last_review]
    if after and last_review is not None:
        next_human = next((h for h in humans if h > last_review), None)
        fixups = [e for e in after if next_human is None or e[0] < next_human]
        if len(fixups) == len(after) and len(after) <= CHAIN_FIXUP_BUDGET:
            after = []
    if after and not re.search(r'^\s*NO-SHIP-CHECK:\s*\S.{9,}', turn_text, re.M):
        missing.append('review-strong' if big else 'review')
    # /what-else and /wrap-up: once for this piece of work (since the owner's
    # message that started the latest edits). Only real invocations count.
    work_start = max((h for h in humans if h < edits[-1][0]), default=-1)
    for step, seen in (('what-else', what_else), ('wrap-up', wrap_up)):
        token = 'NO-' + step.upper()
        if not any(w > work_start for w in seen) \
                and not re.search(r'^\s*' + token + r':\s*\S.{9,}', turn_text, re.M):
            missing.append(step)
    # One combined result: the Stop hook blocks each code once per chain, so
    # separate codes would let the second missing step through.
    if missing:
        return f"NOCHAIN:{','.join(missing)}:{after[-1][1] if after else edits[-1][1]}"
    return None

_PY_WRITE_RE = re.compile(r"open\([^)]*,\s*['\"][wa]|\.write_text\(|\.write_bytes\(")
_QUOTED_PATH_RE = re.compile(r"['\"]([^'\"\s]+\.\w{1,5})['\"]")

def _bash_code_edits(bash_cmds, is_trigger):
    out = []
    for i, cmd in bash_cmds:
        # python heredoc edits (p='x.sh'; open(p,'w')): quoted code paths in a
        # command that writes a file.
        if _PY_WRITE_RE.search(cmd):
            for m in _QUOTED_PATH_RE.finditer(cmd):
                if is_trigger(m.group(1)):
                    out.append((i, os.path.basename(m.group(1))))
                    break
    shell = [(i, c) for i, c in bash_cmds if c and not _PY_WRITE_RE.search(c)]
    scope = os.path.join(os.environ.get('VE_REPO_ROOT', '.'), 'scripts', 'lib', 'infra-review-scope.js')
    if not shell or not os.path.isfile(scope):
        return out
    try:
        import subprocess as _cs
        js = ("const s=require(process.argv[1]);let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{"
              "const out=JSON.parse(d).map(c=>{try{return s.bashWriteTargets(c)}catch(e){return []}});"
              "process.stdout.write(JSON.stringify(out))})")
        res = _cs.run(['node', '-e', js, scope], input=json.dumps([c for _, c in shell]),
                      capture_output=True, text=True, timeout=8)
        for (i, _c), targets in zip(shell, json.loads(res.stdout or '[]')):
            hit = next((t for t in targets if is_trigger(t)), None)
            if hit:
                out.append((i, os.path.basename(hit)))
    except Exception:
        pass   # fail open: Edit/Write edits still count
    return out

def _chain_or_ok():
    # Runs at each OK exit below, so the chain never takes the Stop hook's one
    # block ahead of UNVERIFIED / UNSHIPCHECKED / scoring / visual-QA (the
    # stop_hook_active guard lets the second Stop through).
    if os.environ.get('CLOUD_CHAIN_GATE_DISABLE', '0') == '1':
        return 'OK'
    try:
        r = _chain_result() or 'OK'
        return 'OK' if _ve_seen(r) else r
    except Exception:
        return 'OK'   # fail open

_verify_state = _read_verify_state()
if _edit_fingerprint > 0 and _verify_state.get('bypassSatisfiedAt') == _edit_fingerprint:
    print(_chain_or_ok())
    sys.exit(0)

if last_edit_idx is None and not ran_audit_sweep:
    print(_chain_or_ok())
    sys.exit(0)

# Look for a QUALIFYING Bash tool_use OR a NO-VERIFY override in text after the edit.
# Qualifying = touches the edited file, OR runs a known build/test/typecheck command.
# A bare `ls` or `echo` does NOT count — that's gaming the gate.
basename = os.path.basename(last_edit_file) if last_edit_file else 'audit-sweep'
basename_no_ext = os.path.splitext(basename)[0] if last_edit_file else 'audit-sweep'

# ─── BWSC scoring-logic gate ─────────────────────────────────────────────────
# When an edit touches a file on the SCORING_LOGIC list, generic "tests passed"
# is NOT sufficient — the 2026-04-14 Giant incident shipped with unit tests
# green but would have excluded 183 legitimate T1 reviews from flagship shows.
# For these files, the session must also run the scoring-delta check (or the
# temporal-override regression fixture, or a full rebuild + analyze-rebuild-drops).
# See memory/feedback_scoring_delta_required.md.
SCORING_LOGIC_SUBSTRINGS = (
    '/scripts/lib/review-guards.js',
    '/scripts/rebuild-all-reviews.js',
    '/src/lib/scoring.ts',
    '/src/lib/engine.ts',
    '/src/lib/data-core.ts',
)

# ─── BWSC visual-QA gate (added 2026-05-24) ──────────────────────────────────
# Edits to files producing rendered HTML require a verdict.json from
# scripts/visual-qa.mjs whose mtime is newer than the latest UI edit. Reason:
# the FeaturedSpot incident shipped "Live on production" with a clipped
# "HISTORICAL ACCURA" label because the agent read full-page screenshots at
# thumbnail size and missed the clip. The runner takes element crops at full
# pixel resolution AND runs a structural overflow probe AND optionally runs
# two-model LLM diff vs reference designs. See memory/feedback_local_preview_before_push.md.
#
# Bypass: VISUAL_QA_DISABLE=1 env (set at hook entry) → VISUAL_QA_OK=0 here,
# or `NO-VERIFY: <reason>` in last assistant text.
import re as _ui_re
UI_PATH_RE = _ui_re.compile(
    r'(/src/.*\.(?:tsx|jsx|css|scss|module\.css)$'
    r'|/tailwind\.config\.\w+$'
    r'|/postcss\.config\.\w+$'
    r'|/src/app/.*\.(?:tsx|jsx|ts|js)$)'
)
VISUAL_QA_OK = os.environ.get('VISUAL_QA_OK', '1') == '1'

# A path-based match is necessary but not sufficient — many edits to UI files
# are non-visual (import reordering, string-array data edits, type-only
# changes, comment-only fixes). Inspect the EDIT diff to confirm the change
# actually touches visual surface: className, style/sx props, CSS values,
# JSX structure (open/close tags), or new JSX elements.
#
# This is the second-most-common Stop-hook noise source after stale-edit
# echoes (which the per-commit memo below kills). Sessions 2026-05-25 hit it
# twice in one turn (BeatTheCriticsClient.tsx adding ['Slant', 'TheaterMania']
# to a string array — non-visual but ui_edit fired).
VISUAL_DIFF_HINT_RE = _ui_re.compile(
    r'(?:'
    r'\bclassName\s*=|\bclassname\s*=|\bclass\s*=|'  # className/class attr
    r'\bstyle\s*=|\bsx\s*=|'                          # style/sx props
    r'<[A-Z][A-Za-z0-9]*\b|</[A-Z][A-Za-z0-9]*>|'    # JSX component open/close
    r'<(?:div|span|p|h[1-6]|button|a|img|svg|input|form|section|article|nav|header|footer|main|aside|ul|ol|li)\b|'  # core HTML
    r'background(?:-color)?\s*:|color\s*:|font-(?:size|weight|family)\s*:|'  # CSS props
    r'(?:^|\s)(?:padding|margin|border|width|height|gap|grid|flex|display|position|top|left|right|bottom|z-index|opacity|transform|transition)\s*:|'
    r'@media\b|@keyframes\b'                          # media queries / animations
    r')',
    _ui_re.IGNORECASE | _ui_re.MULTILINE,
)


# P1a (/ship-check 2026-05-26 Codex + Claude): for CSS files, CSS modules,
# tailwind.config, postcss.config — ANY edit is visual. The diff regex misses
# `--brand: #ff0` → `#00f` (no className keyword) and `colors: { brand: '#ff0' }`
# tailwind additions (no JSX). Path-only is sufficient for these classes.
VISUAL_BY_PATH_RE = _ui_re.compile(
    r'(?:^|/)(?:'
    r'.*\.(?:css|scss|module\.css|module\.scss)$'
    r'|tailwind\.config\.(?:js|ts|cjs|mjs)$'
    r'|postcss\.config\.(?:js|ts|cjs|mjs)$'
    r')',
)


# Strip string literals (single/double/backtick) from a code snippet before
# running the visual-diff hint regex. Without this, a TSX file containing a
# DATA string like `text: '<div className="x"/>'` (e.g. an email-template
# fixture, a docs example) trips the gate even though the actual edit was
# data-only. /ship-check 2026-05-26 Codex P1.
#
# Implementation: replace each balanced quoted run with a single space. Honor
# backslash escapes. Backtick template literals don't support interpolation
# parsing here — we treat them as opaque strings, which is conservative
# (might miss visual surface inside `${...}` interpolation, but that's a tiny
# minority and the regex still runs on whatever is OUTSIDE the backticks).
_STRING_LITERAL_RE = _ui_re.compile(
    r"'(?:\\.|[^'\\])*'"      # single-quoted
    r'|"(?:\\.|[^"\\])*"'     # double-quoted
    r'|`(?:\\.|[^`\\])*`'     # backtick
)


def _strip_string_literals(text):
    return _STRING_LITERAL_RE.sub(' ', text)


def _edit_touches_visual_surface(events_list, edit_idx, file_path):
    """Return True iff the Edit/Write at events_list[edit_idx] mutates visual
    surface (className/style/CSS/JSX). False = data-only edit (string array,
    import reorder, comment fix); the Stop hook should NOT fire.

    Short-circuit: edits to *.css/*.scss/tailwind.config/postcss.config always
    count as visual, regardless of diff content.

    For .tsx/.jsx/.ts/.js: strip string literals before running the regex so
    `text: '<div className="x"/>'` (data) doesn't trip the gate. The actual
    JSX `<div className=...>` syntax is NOT inside quotes and survives the
    strip, so real visual edits still match.
    """
    if file_path and VISUAL_BY_PATH_RE.search(file_path):
        return True
    if edit_idx is None or edit_idx >= len(events_list):
        return True  # fail-safe: assume visual, gate stays strict
    kind, payload = events_list[edit_idx]
    if kind != 'tool':
        return True
    name, inp, _ = payload
    text_blob = ''
    if name == 'Edit':
        text_blob = (inp.get('new_string', '') or '') + '\n' + (inp.get('old_string', '') or '')
    elif name == 'Write':
        text_blob = inp.get('content', '') or ''
    elif name == 'NotebookEdit':
        text_blob = inp.get('new_source', '') or ''
    if not text_blob:
        return True
    code_only = _strip_string_literals(text_blob)
    return bool(VISUAL_DIFF_HINT_RE.search(code_only))


# Per-commit memo: skip the gate when (a) HEAD hasn't moved AND (b) no NEW UI
# edits have happened since the gate was last satisfied. The memo records
# both the HEAD SHA and the timestamp of the latest UI edit at satisfy-time;
# both must match for the short-circuit to apply.
#
# /ship-check 2026-05-26 (Codex P0): the previous SHA-only memo silently
# passed any uncommitted UI edit landing on a HEAD where the gate was
# satisfied earlier in the session. New edit → no verdict → ships unverified.
# This version invalidates the memo on every fresh UI edit.
_last_satisfied_marker = '.claude/visual-qa/last-satisfied'

def _read_last_satisfied():
    try:
        with open(_last_satisfied_marker) as f:
            content = f.read().strip()
        if content.startswith('{'):
            return json.loads(content)
        # Legacy bare-SHA format from v2 pre-hotfix; reject (invalidate memo).
        return None
    except Exception:
        return None

def _current_head_sha():
    try:
        import subprocess as _sp
        return _sp.check_output(['git', 'rev-parse', 'HEAD'], stderr=_sp.DEVNULL, text=True).strip()
    except Exception:
        return None

def _latest_ui_edit_ts(events_list):
    """Return the ts of the most-recent Edit/Write/NotebookEdit on a UI file
    in this session, or None if there are none. Used to invalidate the memo
    when new UI edits land since the gate was satisfied."""
    for i in range(len(events_list) - 1, -1, -1):
        kind, payload = events_list[i]
        if kind != 'tool':
            continue
        name, inp, _tid = payload
        if name not in ('Edit', 'Write', 'NotebookEdit') or _tid in tool_refused_ids:
            continue
        fp = inp.get('file_path', '') or ''
        if fp and UI_PATH_RE.search(fp):
            # ts may not be present on every event; payload's third slot was
            # the tool_use_id, not a timestamp. Read it from the raw events
            # structure: we stored ('tool', (name, input, id)) only. There's
            # no ts captured. Fall back to event index as a monotonic proxy.
            return f"idx:{i}"
    return None

is_ui_edit_path = last_edit_file is not None and bool(UI_PATH_RE.search(last_edit_file))
is_ui_edit_visual = is_ui_edit_path and _edit_touches_visual_surface(events, last_edit_idx, last_edit_file)
is_ui_edit = is_ui_edit_visual and VISUAL_QA_OK

_head_sha = _current_head_sha()
_last_ok = _read_last_satisfied()
_current_edit_marker = _latest_ui_edit_ts(events)

# Short-circuit only if: (a) memo exists, (b) HEAD matches, (c) the latest UI
# edit marker matches what was recorded at satisfy-time. Any new UI edit
# since the last satisfy invalidates (c). Catches the silent-pass bug:
# satisfy on commit X → edit ComponentB without committing → previously
# would skip; now fires.
if (is_ui_edit
        and _head_sha and _last_ok
        and _last_ok.get('headSha') == _head_sha
        and _last_ok.get('latestEditMarker') == _current_edit_marker):
    print(_chain_or_ok())
    sys.exit(0)

def _write_last_satisfied(sha, edit_marker):
    if not sha:
        return
    try:
        os.makedirs(os.path.dirname(_last_satisfied_marker), exist_ok=True)
        with open(_last_satisfied_marker, 'w') as f:
            json.dump({'headSha': sha, 'latestEditMarker': edit_marker}, f)
    except Exception:
        pass

# Track ANY UI edit anywhere in the session (not just most recent), so the
# visual-claim-language and reference-attached triggers fire even when the
# most recent edit was a non-UI file. Both triggers fire independently of
# whether last_edit_file itself is UI.
# /ship-check 2026-05-26 hotfix3: this scan was previously path-only. That
# meant a .tsx edit whose diff only touched a string literal (data, not JSX)
# still flipped the flag, and the outer visual-branch trigger pulled the
# gate. Now: a UI-path edit only counts if it ALSO touched visual surface
# in the diff (same diff-aware check the last-edit branch uses).
def _event_is_visual_ui_edit(idx):
    e = events[idx]
    if e[0] != 'tool': return False
    nm, ip, _tid = e[1]
    if nm not in ('Edit', 'Write', 'NotebookEdit') or _tid in tool_refused_ids: return False
    fp = ip.get('file_path', '') or ''
    if not (fp and UI_PATH_RE.search(fp)): return False
    return _edit_touches_visual_surface(events, idx, fp)

any_ui_edit_in_session = any(_event_is_visual_ui_edit(i) for i in range(len(events)))

# Visual-claim-language: assistant making UI-correctness claim ("Live on production",
# "looks correct", etc.) without a NO-VERIFY: override in the same text block.
# Last assistant_text is checked; needs UI edit in session AND visual gate ENABLED.
VISUAL_CLAIM_RE = _ui_re.compile(
    r'\b(live on production|looks correct|matches the design|ready to ship|'
    r'visually verified|looks good on (mobile|desktop|tablet)|shipped successfully|'
    r'works as designed|renders correctly)\b',
    _ui_re.IGNORECASE,
)
visual_claim_made = False
if any_ui_edit_in_session and VISUAL_QA_OK:
    for i in range(len(events) - 1, -1, -1):
        k, p = events[i]
        if k == 'text':
            txt = p or ''
            if VISUAL_CLAIM_RE.search(txt) and 'NO-VERIFY:' not in txt:
                visual_claim_made = True
            break  # only check most recent assistant_text

# Human-time estimate detection (added 2026-05-30 per user feedback): I keep
# quoting "half a day" / "couple hours" / "a few days" for work *I'm* doing,
# even though I work in minutes. The user explicitly said sessions make bad
# decisions based on these inflated estimates. Block when the last assistant
# text contains human-pace estimate phrases — agent must re-quote in
# Claude-pace minutes or bypass with NO-VERIFY: <reason this is external time>.
HUMAN_TIME_ESTIMATE_RE = _ui_re.compile(
    r'\b('
    # Standalone human-pace expressions (almost always an estimate, not a literal duration)
    r'half\s+a?\s*day|'
    r'(?:a\s+)?couple\s+(?:of\s+)?(?:hours?|days?|weeks?)|'
    r'(?:a\s+)?few\s+(?:hours?|days?|weeks?)|'
    # Numeric in estimate context: "will take 3 hours", "takes 2 days", "about 4 hrs"
    r'(?:will|would|should|gonna|going\s+to|takes?|estimate(?:d|s)?|need|require(?:s|d)?)\s+'
    r'(?:about\s+|roughly\s+|~|approximately\s+)?'
    r'\d{1,3}\s*(?:[-–]\s*\d{1,3}\s*)?'
    r'(?:hours?|days?|weeks?|hrs?)|'
    # "N hours of work", "N days of effort"
    r'\d{1,3}\s*(?:hours?|days?|weeks?)\s+(?:of\s+)?(?:work|effort|engineering|coding|editing)'
    r')\b',
    _ui_re.IGNORECASE,
)
# NOTE: the human-time-estimate check itself was moved EARLIER in the script
# (right after event parsing, before the no-edit early-exit) so it fires on
# every Stop, not just when a code edit happened. The regex definition above
# stays here for proximity to other detection regexes; the print/exit is at
# the top with the early gates.

# Reference-attached: user pasted a design image. If any UI edit happened + the
# session has a verdict but with verdicts:null (no LLM review), block with the
# instruction to re-run with --refs. Without an image attached, this trigger
# does not fire — the agent isn't expected to invent a reference.
import re as _img_re
# Concrete (not placeholder) image-attachment patterns. The old loose checks
# `'[Image #' in txt` and `'clipboard-' in txt` self-triggered on the hook's
# OWN block-message echoes (which contain literal placeholder examples like
# `/var/folders/.../clipboard-<timestamp>-<id>.png` and `[Image #N]`) re-
# ingested as user_text via Stop-hook feedback. Now we require concrete IDs
# so placeholders / literal documentation don't count as real attachments.
_IMAGE_TAG_RE = _img_re.compile(r'\[Image #\d+\]')
_CLIPBOARD_PATH_RE = _img_re.compile(r'/(?:private/)?var/folders/[^/<>\s]+/[^/<>\s]+/(?:T/)?clipboard-\d+-[A-Za-z0-9]+\.(?:png|jpg|jpeg|webp)', _img_re.IGNORECASE)

def _has_concrete_image_ref(text: str) -> bool:
    if not text:
        return False
    return bool(_IMAGE_TAG_RE.search(text) or _CLIPBOARD_PATH_RE.search(text))

reference_attached = False
# Walk events for image markers in user text, user image blocks, and tool_results.
for kind, payload in events:
    if kind == 'user_text':
        if _has_concrete_image_ref(payload or ''):
            reference_attached = True
            break
    elif kind == 'user_image':
        reference_attached = True
        break
    elif kind == 'tool':
        nm, ip, tid = payload
        # User-provided image attachments sometimes surface in tool_results
        body = tool_results_by_id.get(tid, '') or ''
        if _has_concrete_image_ref(body):
            reference_attached = True
            break

# ─── BWSC ship-check gate (added 2026-05-16) ─────────────────────────────────
# Edits to scripts/lib/ or .github/workflows/ require either /ship-check or an
# adversarial-reviewer Bash (codex exec, OpenAI gpt-4o curl, Agent tool with
# 'review' in description) before the session can claim "done." Reason: tests of
# pure helpers in scripts/lib/ frequently miss bugs in the I/O wrappers that
# consume them. Commit 073db6bab0 shipped two P0s (shape mismatch + wrong-artifact
# jq assertion) that 10 green unit tests + tsc didn't catch. /ship-check (3-reviewer
# adversarial pass) caught both immediately. See memory/feedback_test_pure_function_at_io_boundary.md.
SHIPCHECK_TRIGGER_SUBSTRINGS = (
    '/scripts/lib/',                    # any helper in the lib dir
    '/.github/workflows/',              # any workflow YAML
)
SCORING_DELTA_CMD_PATTERNS = (
    'scoring-delta',                 # the counterfactual script
    'test-temporal-override-regression',  # fixture regression test
    'analyze-rebuild-drops',         # post-rebuild drop analyzer
    # NOTE: 'test-opening-night-fixes' is deliberately NOT accepted. That's the 276-case
    # unit-test harness that was GREEN when the 2026-04-14 Giant bad fix shipped — it
    # updates its own expectations when the code under test changes, so it can't catch
    # behavioral regressions against real data. Only whole-dataset counterfactuals count.
)
is_scoring_edit = last_edit_file is not None and any(s in last_edit_file for s in SCORING_LOGIC_SUBSTRINGS)
is_shipcheck_edit = last_edit_file is not None and any(s in last_edit_file for s in SHIPCHECK_TRIGGER_SUBSTRINGS)

VERIFICATION_CMD_PATTERNS = (
    'tsc', 'next build', 'next dev', 'npm run build', 'npm run test', 'npm test',
    'vitest', 'jest', 'pytest', 'go test', 'cargo test', 'cargo build',
    'npm run typecheck', 'npm run lint', 'eslint', 'next lint',
    'curl ', 'gh run ', 'gh workflow ', 'playwright',
    'node -e', 'node --check',  # node --check is weak but at least it loaded the file
    'python -c', 'python3 -c',
)

def qualifies(cmd: str) -> bool:
    if not cmd:
        return False
    # Touches the edited file by name (basename or full path)
    if basename in cmd or (last_edit_file is not None and last_edit_file in cmd):
        return True
    # Or runs a recognized verification command
    cl = cmd.lower()
    return any(p in cl for p in VERIFICATION_CMD_PATTERNS)

def qualifies_scoring(cmd: str) -> bool:
    if not cmd:
        return False
    cl = cmd.lower()
    return any(p in cl for p in SCORING_DELTA_CMD_PATTERNS)

# Failure markers in the output of scoring-delta / regression test. If the command
# ran and its result contains one of these, the counterfactual FAILED — the session
# must either revise the change or use NO-VERIFY to override after user confirmation.
# Just running the command with a failing result is NOT sufficient to satisfy the gate.
SCORING_FAILURE_MARKERS = (
    'SCORING DELTA — significant change detected',
    'BEFORE MERGING:',
    'FAIL — temporal override regression',
    '❌ FAIL',
)

generic_verified = False
scoring_verified = False   # scoring-delta-class command ran AND passed (no failure marker)
scoring_ran_but_failed = False  # command ran but output showed a failure
shipcheck_verified = False
no_verify = False

# Ship-check evidence — any one of these in the post-edit transcript satisfies the gate:
#   1. Skill tool_use with skill='ship-check' (the canonical path)
#   2. Bash containing 'codex exec' (adversarial reviewer via Codex CLI)
#   3. Bash containing 'api.openai.com/v1/chat/completions' (GPT-4o reviewer curl)
#   4. Agent tool_use whose description contains 'review' or 'ship-check' or 'audit'
SHIPCHECK_BASH_PATTERNS = ('codex exec', 'api.openai.com/v1/chat/completions')
SHIPCHECK_AGENT_DESC_TOKENS = ('review', 'ship-check', 'shipcheck', 'audit')

scan_start = (last_edit_idx + 1) if last_edit_idx is not None else 0

# NO-VERIFY: scans the CURRENT assistant turn, not just events after the last edit.
# Bug: text comes before the Edit tool call in the transcript within the same turn,
# so scan_start (last_edit_idx+1) would never see a NO-VERIFY: written at turn start.
# Fix: find the last user message, then scan everything after it for NO-VERIFY:.
# The owner's messages arrive as plain strings in current transcripts
# (user_human), not list text (user_text): anchoring on user_text alone left
# the window at the whole session, so one NO-VERIFY: from hours earlier waived
# every later unverified edit (BRO-4238 what-else).
last_user_msg_idx = -1
for i in range(len(events) - 1, -1, -1):
    if events[i][0] in ('user_text', 'user_human'):
        last_user_msg_idx = i
        break
no_verify_scan_start = last_user_msg_idx + 1 if last_user_msg_idx >= 0 else 0
for i in range(no_verify_scan_start, len(events)):
    kind, payload = events[i]
    if kind == 'text':
        if 'NO-VERIFY:' in payload or 'SKIP-VISUAL-CHECK:' in payload:
            no_verify = True
    elif kind == 'tool':
        name, inp, _ = payload
        if name == 'Bash':
            cmd = inp.get('command', '') or ''
            if 'SKIP-VISUAL-CHECK:' in cmd and 'git commit' in cmd:
                # Guard: SKIP-VISUAL-CHECK in a commit claims CI verified the visual.
                # Verify that claim — only accept when CI is actually green.
                # This closes the rot-loop where the token was used while CI was red.
                try:
                    import subprocess as _sc_sp
                    ci_conclusion = _sc_sp.check_output(
                        ['gh', 'run', 'list', '--workflow=test.yml', '--limit=1',
                         '--json=conclusion', '--jq', '.[0].conclusion'],
                        text=True, stderr=_sc_sp.DEVNULL, timeout=10
                    ).strip()
                    if ci_conclusion == 'success':
                        no_verify = True
                    # else: CI is red/pending/unknown — reject the SKIP-VISUAL-CHECK claim
                except Exception:
                    pass  # gh unavailable or timed out — fail closed, reject claim

for i in range(scan_start, len(events)):
    kind, payload = events[i]
    if kind == 'tool':
        name, inp, tid = payload
        if name == 'Bash':
            cmd = inp.get('command', '') or ''
            if qualifies(cmd):
                generic_verified = True
            if qualifies_scoring(cmd):
                result_text = tool_results_by_id.get(tid, '') or ''
                if any(marker in result_text for marker in SCORING_FAILURE_MARKERS):
                    scoring_ran_but_failed = True
                else:
                    scoring_verified = True
            if any(p in cmd for p in SHIPCHECK_BASH_PATTERNS):
                shipcheck_verified = True
        elif name == 'Skill':
            if (inp.get('skill') or '') == 'ship-check':
                shipcheck_verified = True
        elif name in ('Agent', 'Task'):
            desc = (inp.get('description') or '').lower()
            if any(tok in desc for tok in SHIPCHECK_AGENT_DESC_TOKENS):
                shipcheck_verified = True

if no_verify:
    # Write the satisfied memo so subsequent turns in the same session don't re-fire.
    _write_last_satisfied(_head_sha, _current_edit_marker)
    _write_verify_state(_edit_fingerprint)
    print(_chain_or_ok())
    sys.exit(0)

if is_scoring_edit or ran_audit_sweep:
    # Stricter gate: must run a scoring-delta-class command AND its output must not
    # contain a failure marker (or the session must explicitly NO-VERIFY after).
    # Label so the error message tells the user which trigger fired. If the edit
    # itself is on the scoring watchlist, blame the file; if it's an audit sweep
    # whose only signal is the Bash mutations, blame 'audit-sweep'.
    label = basename if is_scoring_edit else 'audit-sweep'
    if scoring_verified:
        print(_chain_or_ok())
        sys.exit(0)
    if scoring_ran_but_failed:
        _ve_final(f"SCORING_FAILED:{label}")
        sys.exit(0)
    _ve_final(f"UNVERIFIED_SCORING:{label}")
    sys.exit(0)

if is_shipcheck_edit and not shipcheck_verified:
    # Edits to scripts/lib/ or .github/workflows/ need an adversarial-reviewer pass.
    # Generic tsc/test green is NOT sufficient — see header note.
    _ve_final(f"UNSHIPCHECKED:{basename}")
    sys.exit(0)

# Visual-QA branch — triggered ONLY when this session is actually doing UI
# work. reference_attached alone (a screenshot pasted for unrelated reasons)
# must not enter this branch; the original code did, and any stale verdict
# on disk from a prior session then tripped UNVERIFIED_VISUAL_REF /
# UNVERIFIED_VISUAL_SCHEMA against a non-UI session.
# /ship-check 2026-05-26 round 2 — P1b hotfix2.
visual_branch_relevant = (
    is_ui_edit                 # most recent edit is a UI file with visual diff
    or visual_claim_made       # assistant claimed visual correctness
    or any_ui_edit_in_session  # any earlier edit in this session was UI
)
if visual_branch_relevant:
    # Visual-QA branch (triggered by any of):
    #   1. is_ui_edit: most recent edit is to a UI file
    #   2. visual_claim_made: assistant claimed visual correctness w/o NO-VERIFY
    #   3. any_ui_edit_in_session + (reference_attached or implicit): UI work
    #      happened earlier this session
    # Require .claude/visual-qa/<branch>/verdict.json with mtime newer than
    # the edited file. For reference_attached, additionally require verdict
    # has non-null LLM verdicts (so agent actually ran the comparison).
    import subprocess as _ui_sp
    try:
        branch = _ui_sp.check_output(['git', 'branch', '--show-current'],
                                     stderr=_ui_sp.DEVNULL, text=True).strip()
    except Exception:
        branch = ''
    verdict_path = f".claude/visual-qa/{branch}/verdict.json" if branch else ''
    edit_mtime = 0
    try:
        edit_mtime = os.path.getmtime(last_edit_file) if last_edit_file and UI_PATH_RE.search(last_edit_file) and os.path.exists(last_edit_file) else 0
    except Exception:
        pass
    verdict_ok = False
    verdict_has_llm = False
    if verdict_path and os.path.exists(verdict_path):
        try:
            vm = os.path.getmtime(verdict_path)
            if vm >= edit_mtime - 1:
                verdict_ok = True
            with open(verdict_path) as _vf:
                _vj = json.load(_vf)
                if _vj.get('verdicts') is not None:
                    verdict_has_llm = True
        except Exception:
            pass
    # Reference-attached additionally requires LLM review actually ran.
    # Schema-version gate (v2 required after the 2026-05-25 hash overhaul).
    # Stale v1 verdicts must NOT satisfy the gate — they were computed against
    # the old non-content-equivalent hash, so the user's APPROVED hash is
    # meaningless to the new pre-push hook.
    verdict_schema = None
    if verdict_path and os.path.exists(verdict_path):
        try:
            with open(verdict_path) as _vf:
                _vj_sv = json.load(_vf)
                verdict_schema = _vj_sv.get('schemaVersion')
        except Exception:
            pass
    # P1b (/ship-check 2026-05-26): reference_attached alone — with no UI
    # edit in this session AND no visual claim — must not trigger the
    # schema-version gate. Sessions where the user pasted an image earlier
    # (a screenshot of an error, say) but never touched UI files were
    # firing UNVERIFIED_VISUAL_SCHEMA on stale v1 verdicts from prior work.
    schema_gate_relevant = is_ui_edit or any_ui_edit_in_session or visual_claim_made
    if schema_gate_relevant and verdict_ok and verdict_schema != 2:
        _ve_final(f"UNVERIFIED_VISUAL_SCHEMA:{basename or 'ui-edit'}")
        sys.exit(0)
    # REF gate fires only when reference attached AND a UI edit / claim
    # made it relevant — bare attachments (a screenshot of an unrelated error)
    # must not trip this. Already guarded by visual_branch_relevant on the
    # outer block, but make the inner condition explicit for clarity.
    if reference_attached and schema_gate_relevant and verdict_ok and not verdict_has_llm:
        _ve_final(f"UNVERIFIED_VISUAL_REF:{basename or 'ui-edit'}")
        sys.exit(0)
    if visual_claim_made and not verdict_ok:
        _ve_final(f"UNVERIFIED_VISUAL_CLAIM:{basename or 'ui-edit'}")
        sys.exit(0)
    if verdict_ok:
        # Record satisfied HEAD + latest UI-edit marker so delayed echoes
        # don't re-fire the gate, AND so a NEW uncommitted UI edit DOES
        # re-fire it.
        _write_last_satisfied(_head_sha, _current_edit_marker)
        print(_chain_or_ok())
        sys.exit(0)
    # Only block if the CURRENT edit is a visual UI change. If we entered this
    # branch only because any_ui_edit_in_session is True (stale from an earlier
    # turn) but the current edit is text/data, don't re-fire — that's the pain
    # point for copy/prize-amount/legal-text edits after a prior UI edit.
    if is_ui_edit:
        _ve_final(f"UNVERIFIED_VISUAL:{basename or 'ui-edit'}")
    else:
        print(_chain_or_ok())
    sys.exit(0)

if generic_verified:
    print(_chain_or_ok())
    sys.exit(0)

_ve_final(f"UNVERIFIED:{basename}")
PYEOF
)

# Per-gate loop guard (see LOOP GUARD above). The ledger key mirrors python's
# _ve_key(): the code, or for the finish chain NOCHAIN:<missing steps>.
# Backstop: a key that already blocked in this chain lets this Stop through
# (python should already have skipped it).
_ve_code="${result%%:*}"
if [ "$_ve_code" = "NOCHAIN" ]; then
  _ve_rest="${result#NOCHAIN:}"
  _ve_code="NOCHAIN:${_ve_rest%%:*}"
fi
if [ "$stop_hook_active" = "true" ] && grep -qxF -- "$_ve_code" "$_ve_chain_file" 2>/dev/null; then
  exit 0
fi
_ve_record_block() {
  [ "$1" = "2" ] || return 0
  printf '%s\n' "$_ve_code" >> "$_ve_chain_file" 2>/dev/null
}
trap '_ve_record_block $?' EXIT

# Block messages: one-liner format (cause + fix + bypass). Full rules live in
# .claude/skills/visual-qa/skill.md and the gate comments; the assistant reading
# this only needs the action, not the full incident history. Short messages =
# less for the agent to echo back to the user.

if [[ "$result" == HUMAN_TIME_ESTIMATE:* ]]; then
  phrase="${result#HUMAN_TIME_ESTIMATE:}"
  echo "🛑 BLOCKED: human-time estimate detected (\"${phrase}\") for work you're doing. Quote Claude-pace wall-clock (minutes, not hours/days) — bad sessions follow bad estimates. Bypass: NO-VERIFY: <why this estimate is for external/human time, not your own work>." >&2
  exit 2
fi

if [[ "$result" == SCORING_FAILED:* ]]; then
  fname="${result#SCORING_FAILED:}"
  if [[ "$fname" == "audit-sweep" ]]; then
    echo "🛑 BLOCKED: scoring-delta found T1 flips after audit sweep. Fix flips, or NO-VERIFY: <user-approved delta + specifics>." >&2
  else
    echo "🛑 BLOCKED: scoring counterfactual FAILED for \`${fname}\`. Fix regression, or NO-VERIFY: <user-approved delta + specifics>." >&2
  fi
  exit 2
fi

if [[ "$result" == UNVERIFIED_SCORING:* ]]; then
  fname="${result#UNVERIFIED_SCORING:}"
  if [[ "$fname" == "audit-sweep" ]]; then
    echo "🛑 BLOCKED: audit sweep of data/review-texts/ without scoring-delta. Run: node scripts/scoring-delta.js. Bypass: NO-VERIFY: <why these flags can't affect T1>." >&2
  else
    echo "🛑 BLOCKED: scoring-logic edit (\`${fname}\`) without counterfactual. Run: node scripts/scoring-delta.js (or test-temporal-override-regression.js). Bypass: NO-VERIFY: <why this can't affect scoring>." >&2
  fi
  exit 2
fi

if [[ "$result" == UNVERIFIED:* ]]; then
  fname="${result#UNVERIFIED:}"
  echo "🛑 BLOCKED: unverified edit to \`${fname}\`. Run: npx tsc --noEmit / npm run build / appropriate script. Bypass: NO-VERIFY: <why untestable>." >&2
  exit 2
fi

if [[ "$result" == UNVERIFIED_VISUAL_CLAIM:* ]]; then
  fname="${result#UNVERIFIED_VISUAL_CLAIM:}"
  echo "🛑 BLOCKED: visual-correctness claim without a fresh visual-qa verdict (UI edit: \`${fname}\`). Run /visual-qa, then make the claim. Bypass: NO-VERIFY: <reason>. See .claude/skills/visual-qa/skill.md." >&2
  exit 2
fi

if [[ "$result" == UNVERIFIED_VISUAL_REF:* ]]; then
  fname="${result#UNVERIFIED_VISUAL_REF:}"
  echo "🛑 BLOCKED: user attached a design reference but visual-qa ran without --refs (\`${fname}\`). Re-run /visual-qa with --refs=<path>. Bypass: NO-VERIFY: <why the user's reference is being skipped>." >&2
  exit 2
fi

if [[ "$result" == UNVERIFIED_VISUAL_SCHEMA:* ]]; then
  fname="${result#UNVERIFIED_VISUAL_SCHEMA:}"
  echo "🛑 BLOCKED: UI edit (\`${fname}\`) but verdict.json is stale schema (v1, need v2). Re-run /visual-qa. Bypass: NO-VERIFY: <reason>." >&2
  exit 2
fi

if [[ "$result" == UNVERIFIED_VISUAL:* ]]; then
  fname="${result#UNVERIFIED_VISUAL:}"
  echo "🛑 BLOCKED: UI edit (\`${fname}\`) without a fresh visual-qa verdict. Run /visual-qa, read element crops, present manifest. Bypass: NO-VERIFY: <reason>. Disable globally: VISUAL_QA_DISABLE=1. See .claude/skills/visual-qa/skill.md." >&2
  exit 2
fi

if [[ "$result" == UNSHIPCHECKED:* ]]; then
  fname="${result#UNSHIPCHECKED:}"
  echo "🛑 BLOCKED: edit to \`${fname}\` (scripts/lib/ or .github/workflows/) without ship-check. Satisfy via /ship-check, codex exec, GPT-4o curl, or Agent with 'review'/'audit' in description. Bypass: NO-VERIFY: <why this can't break anything>." >&2
  exit 2
fi

if [[ "$result" == NOCHAIN:* ]]; then
  rest="${result#NOCHAIN:}"
  steps="${rest%%:*}"
  fname="${rest#*:}"
  todo=""
  bypass=""
  case ",$steps," in
    *,review-strong,*) todo="/ship-check (or /code-review; this session is too big for /second-opinion)"; bypass="NO-SHIP-CHECK: <why no review is needed>" ;;
    *,review,*) todo="/ship-check (or /second-opinion for a small diff)"; bypass="NO-SHIP-CHECK: <why no review is needed>" ;;
  esac
  for s in what-else wrap-up; do
    case ",$steps," in *,$s,*)
      todo="${todo:+$todo, then }/$s"
      bypass="${bypass:+$bypass / }NO-$(echo "$s" | tr 'a-z' 'A-Z'): <reason>" ;;
    esac
  done
  echo "🛑 BLOCKED: SAFE TO EXIT after code edits (latest: \`${fname}\`), but the finish chain is incomplete. Still to run, as real skill calls (an Agent \"review\", a codex call or doing the steps by hand does not count): ${todo}. Fix what they find, then close. Step truly n/a: ${bypass}." >&2
  exit 2
fi

if [[ "$result" == "NOSTATUSLINE" ]]; then
  echo "🛑 BLOCKED: session did real work (edit/commit/push/PR) but the final message has no closing SAFE TO EXIT / NOT SAFE TO EXIT line. Close with the SESSION STATUS block per .claude/commands/wrap-up.md. Bypass: NO-VERIFY: <reason>." >&2
  exit 2
fi

if [[ "$result" == "FALSESAFE" ]]; then
  echo "🛑 BLOCKED: message has a DECISION NEEDED block but claims SAFE TO EXIT — a pending decision is always NOT SAFE TO EXIT. If it's a technical/implementation call, decide it yourself instead (cloud-memory/feedback_decide_technical_calls_myself.md) rather than asking. Bypass: NO-VERIFY: <reason>." >&2
  exit 2
fi

if [[ "$result" == "OWNERMERGE" ]]; then
  echo "🛑 BLOCKED: you asked the owner to merge or review. The owner never merges or reviews PRs in this repo. Once CI is green, land it yourself: git push origin HEAD:refs/heads/land/<name> (land.yml rebases onto main, re-runs the blocking gates, fast-forwards main; MCP fallback: mcp__github__create_branch land/<name> or dispatch land.yml with branch=<name>). Follow the Land run to LANDED, close the PR, then report. Bypass: NO-VERIFY: <reason>." >&2
  exit 2
fi
if [[ "$result" == "LANDUNCHECKED" ]]; then
  echo "🛑 BLOCKED: you pushed to land/** but claim SAFE TO EXIT without checking the Land run. land.yml can refuse a branch. Check the run (mcp__github__actions_list / actions_get on land.yml) and report LANDED or the refusal. Bypass: NO-VERIFY: <reason>." >&2
  exit 2
fi
if [[ "$result" == "PRUNMERGED" ]]; then
  echo "🛑 BLOCKED: a PR was opened via the GitHub MCP connector this session but never landed, with no stated blocker. This project's owner does not review or merge PRs — once CI is green, land it yourself: git push origin HEAD:refs/heads/land/<name> (land.yml rebases, re-runs the gates, fast-forwards main), follow the Land run, then close the PR. Or state the blocker: CI still running, CI red, a merge conflict, a DECISION NEEDED:, or a line PR-BLOCKER: <specific reason>. NOT SAFE TO EXIT alone, or waiting on review, is not a blocker (cloud-memory/feedback_no_review_offers_user_not_technical.md). Bypass: NO-VERIFY: <reason>." >&2
  exit 2
fi

if [[ "$result" == "NOCARD" ]]; then
  echo "🛑 BLOCKED: this session did real work (edit/commit/push/PR) but never filed or claimed its Linear card (CLAUDE.md §6: card first). Run: node scripts/linear-brain.js create '<title>' --dispatch --notes '...## Acceptance criteria...' — or, if you were given an existing issue, node scripts/linear-session.js claim --issue=BRO-N. Notion is retired: never notion-brain.js. Bypass: NO-CARD: <reason, 10+ chars>." >&2
  exit 2
fi

if [[ "$result" == "INFLIGHT" ]]; then
  echo "🛑 BLOCKED: claiming SAFE TO EXIT while this session still has work in flight (listed above). SAFE TO EXIT tells the owner this session can be closed or killed right now; a background agent or a Routine scheduled to wake this session dies with it. Collect the agent's hand-back (or TaskStop it) and delete_trigger any check-in you no longer need, or end with: NOT SAFE TO EXIT — <what is still running and what happens when it finishes>. Bypass: NO-VERIFY: <reason>." >&2
  exit 2
fi

if [[ "$result" == "NOWRAPUP" ]]; then
  echo "🛑 BLOCKED: claiming SAFE TO EXIT after real work, but this session's Linear card was never closed out after that work. Run: node scripts/linear-brain.js update BRO-N --state Done (needs a PR-EVIDENCE line citing the landed commit URL, https://github.com/thomaspryor/Broadwayscore/commit/<sha on main>, which verifies through GitHub even in a shallow cloud clone, or an Acceptance-criteria check; a refused update doesn't count). To pause, or when Done is refused: node scripts/linear-session.js report --issue=BRO-N --status=paused --summary=\"...\" (Linear has no Paused state; this sets Backlog). Invoking /wrap-up is required but not enough on its own, and a notion-brain.js update does not count (Notion is retired). Bypass: NO-VERIFY: <reason> (or NO-CARD: <reason> if this session has no card by design)." >&2
  exit 2
fi

exit 0
