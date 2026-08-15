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

# INFINITE LOOP GUARD: Claude Code sets `stop_hook_active: true` on subsequent
# Stop events when a hook has already blocked once in this turn-chain. If we
# block again, Claude loops forever. Let it through — Claude has seen our block
# message once; if it hasn't satisfied the gate yet, blocking again won't help.
stop_hook_active=$(echo "$input" | jq -r '.stop_hook_active // false' 2>/dev/null)
if [ "$stop_hook_active" = "true" ]; then
  exit 0
fi

# CRITICAL (card #233, 2026-07-20): at the live Stop event the final assistant
# message's TEXT is not yet flushed to the transcript file (tool_use/tool_result
# entries ARE flushed — only the trailing text-only message is not; see
# finish-line-gate.sh's identical fix). Every text-scanning check below
# (NO-VERIFY, SKIP-VISUAL-CHECK, visual-claim-language, human-time-estimate)
# would silently read one message behind without this. The harness passes the
# live final text separately.
export VE_LAST_MSG=$(echo "$input" | jq -r '.last_assistant_message // empty' 2>/dev/null)

result=$(python3 - "$transcript" <<'PYEOF'
import hashlib, json, sys, os

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

events = []  # list of (kind, payload)
# kinds: 'tool' payload=(name,input,tool_use_id) | 'text' payload=str | 'result' payload=(tool_use_id, text)
tool_results_by_id = {}
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
            elif mtype == 'user':
                # Tool results arrive as user messages with type=tool_result in their content.
                # User-typed text appears as type=text — used by the visual-qa
                # reference-attached and override-active-for-push checks.
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

# Detect audit sweeps: sessions that edit data/review-texts/ flag fields via Bash
# (not Edit tool). These bypass the is_scoring_edit gate because last_edit_file never
# matches SCORING_LOGIC_SUBSTRINGS. Detect by presence of 'review-texts' in any Bash cmd.
# An "audit sweep" is a Bash command that *mutates* files under data/review-texts/.
# Mere mention of the path (e.g., in a notion-brain --notes arg, a ls/grep, or a
# git log string) is NOT a sweep — those tripped this flag for the entire session
# and slapped the scoring-delta gate onto every unrelated edit. Require both:
# the path appears AND a write primitive appears in the same command.
import re

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
        if _m and 'NO-VERIFY:' not in _txt:
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

_verify_state = _read_verify_state()
if _edit_fingerprint > 0 and _verify_state.get('bypassSatisfiedAt') == _edit_fingerprint:
    print("OK")
    sys.exit(0)

if last_edit_idx is None and not ran_audit_sweep:
    print("OK")
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
        name, inp, _ = payload
        if name not in ('Edit', 'Write', 'NotebookEdit'):
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
    print("OK")
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
    nm, ip, _ = e[1]
    if nm not in ('Edit', 'Write', 'NotebookEdit'): return False
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
last_user_msg_idx = -1
for i in range(len(events) - 1, -1, -1):
    if events[i][0] == 'user_text':
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
    print("OK")
    sys.exit(0)

if is_scoring_edit or ran_audit_sweep:
    # Stricter gate: must run a scoring-delta-class command AND its output must not
    # contain a failure marker (or the session must explicitly NO-VERIFY after).
    # Label so the error message tells the user which trigger fired. If the edit
    # itself is on the scoring watchlist, blame the file; if it's an audit sweep
    # whose only signal is the Bash mutations, blame 'audit-sweep'.
    label = basename if is_scoring_edit else 'audit-sweep'
    if scoring_verified:
        print("OK")
        sys.exit(0)
    if scoring_ran_but_failed:
        print(f"SCORING_FAILED:{label}")
        sys.exit(0)
    print(f"UNVERIFIED_SCORING:{label}")
    sys.exit(0)

if is_shipcheck_edit and not shipcheck_verified:
    # Edits to scripts/lib/ or .github/workflows/ need an adversarial-reviewer pass.
    # Generic tsc/test green is NOT sufficient — see header note.
    print(f"UNSHIPCHECKED:{basename}")
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
        print(f"UNVERIFIED_VISUAL_SCHEMA:{basename or 'ui-edit'}")
        sys.exit(0)
    # REF gate fires only when reference attached AND a UI edit / claim
    # made it relevant — bare attachments (a screenshot of an unrelated error)
    # must not trip this. Already guarded by visual_branch_relevant on the
    # outer block, but make the inner condition explicit for clarity.
    if reference_attached and schema_gate_relevant and verdict_ok and not verdict_has_llm:
        print(f"UNVERIFIED_VISUAL_REF:{basename or 'ui-edit'}")
        sys.exit(0)
    if visual_claim_made and not verdict_ok:
        print(f"UNVERIFIED_VISUAL_CLAIM:{basename or 'ui-edit'}")
        sys.exit(0)
    if verdict_ok:
        # Record satisfied HEAD + latest UI-edit marker so delayed echoes
        # don't re-fire the gate, AND so a NEW uncommitted UI edit DOES
        # re-fire it.
        _write_last_satisfied(_head_sha, _current_edit_marker)
        print("OK")
        sys.exit(0)
    # Only block if the CURRENT edit is a visual UI change. If we entered this
    # branch only because any_ui_edit_in_session is True (stale from an earlier
    # turn) but the current edit is text/data, don't re-fire — that's the pain
    # point for copy/prize-amount/legal-text edits after a prior UI edit.
    if is_ui_edit:
        print(f"UNVERIFIED_VISUAL:{basename or 'ui-edit'}")
    else:
        print("OK")
    sys.exit(0)

if generic_verified:
    print("OK")
    sys.exit(0)

print(f"UNVERIFIED:{basename}")
PYEOF
)

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

exit 0
