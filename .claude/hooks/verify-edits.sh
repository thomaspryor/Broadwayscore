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

result=$(python3 - "$transcript" <<'PYEOF'
import json, sys, os

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
                for c in content:
                    if not isinstance(c, dict):
                        continue
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

# Find most recent qualifying code edit
last_edit_idx = None
last_edit_file = None
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
    last_edit_idx = i
    last_edit_file = fp
    break

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
_heredoc_re = re.compile(
    r"<<-?\s*['\"]?(\w+)['\"]?\n.*?^\1\s*$",
    re.MULTILINE | re.DOTALL,
)
def _strip_heredocs(cmd: str) -> str:
    return _heredoc_re.sub('', cmd)

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

ran_audit_sweep = any(
    kind == 'tool' and payload[0] == 'Bash'
    and _is_review_texts_write(payload[1].get('command', '') or '')
    for kind, payload in events
)

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
is_ui_edit = last_edit_file is not None and bool(UI_PATH_RE.search(last_edit_file)) and VISUAL_QA_OK

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
    elif kind == 'text':
        if 'NO-VERIFY:' in payload:
            no_verify = True

if no_verify:
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

if is_ui_edit:
    # Visual-QA branch: require .claude/visual-qa/<branch>/verdict.json with
    # mtime newer than the edited file. If file's been re-edited since the
    # last verdict, the verdict is stale.
    import subprocess as _ui_sp
    try:
        branch = _ui_sp.check_output(['git', 'branch', '--show-current'],
                                     stderr=_ui_sp.DEVNULL, text=True).strip()
    except Exception:
        branch = ''
    verdict_path = f".claude/visual-qa/{branch}/verdict.json" if branch else ''
    edit_mtime = 0
    try:
        edit_mtime = os.path.getmtime(last_edit_file) if last_edit_file and os.path.exists(last_edit_file) else 0
    except Exception:
        pass
    verdict_ok = False
    if verdict_path and os.path.exists(verdict_path):
        try:
            vm = os.path.getmtime(verdict_path)
            if vm >= edit_mtime - 1:
                verdict_ok = True
        except Exception:
            pass
    if verdict_ok:
        print("OK")
        sys.exit(0)
    print(f"UNVERIFIED_VISUAL:{basename}")
    sys.exit(0)

if generic_verified:
    print("OK")
    sys.exit(0)

print(f"UNVERIFIED:{basename}")
PYEOF
)

if [[ "$result" == SCORING_FAILED:* ]]; then
  fname="${result#SCORING_FAILED:}"
  if [[ "$fname" == "audit-sweep" ]]; then
    cat >&2 <<EOF
🛑 BLOCKED — scoring-delta found T1 flips after audit sweep of data/review-texts/
  Review the delta report above. Fix the flips, or NO-VERIFY: <user approved delta — specifics>
EOF
  else
    cat >&2 <<EOF
🛑 BLOCKED — scoring counterfactual FAILED for \`${fname}\`
  Fix the regression, or NO-VERIFY: <user approved delta — specifics>
EOF
  fi
  exit 2
fi

if [[ "$result" == UNVERIFIED_SCORING:* ]]; then
  fname="${result#UNVERIFIED_SCORING:}"
  if [[ "$fname" == "audit-sweep" ]]; then
    cat >&2 <<EOF
🛑 BLOCKED — audit sweep of data/review-texts/ without scoring-delta check
  Flag changes may flip T1 review inclusion. Run to verify:
    node scripts/scoring-delta.js
  Bypass: NO-VERIFY: <why these flag changes can't affect T1 scores>
EOF
  else
    cat >&2 <<EOF
🛑 BLOCKED — scoring-logic edit (\`${fname}\`) without counterfactual check
  Run: node scripts/scoring-delta.js
  Or:  node scripts/test-temporal-override-regression.js
  Bypass: NO-VERIFY: <why this can't affect scoring>
EOF
  fi
  exit 2
fi

if [[ "$result" == UNVERIFIED:* ]]; then
  fname="${result#UNVERIFIED:}"
  cat >&2 <<EOF
🛑 BLOCKED — unverified edit to \`${fname}\`
  Run: npx tsc --noEmit / npm run build / node scripts/${fname} ...
  Bypass: NO-VERIFY: <why untestable>
EOF
  exit 2
fi

if [[ "$result" == UNVERIFIED_VISUAL:* ]]; then
  fname="${result#UNVERIFIED_VISUAL:}"
  cat >&2 <<EOF
🛑 BLOCKED — UI edit (\`${fname}\`) without a fresh visual-qa verdict

  The FeaturedSpot incident shipped "Live on production" with HISTORICAL ACCURA
  clipped because the agent never ran /visual-qa and read full-page screenshots
  at thumbnail size. Run:

    npm run dev    # in another terminal
    node scripts/visual-qa.mjs --url http://localhost:3000 \\
      --paths "/,/affected-route" \\
      --elements "<css-sel-of-changed-element>" \\
      --refs <design-reference.png-if-user-provided>

  Then READ every element crop the runner prints at FULL resolution, paste the
  manifest to the user, and wait for "APPROVED: <hash>".

  Bypass: NO-VERIFY: <reason — e.g., dev server can't boot, hotfix, cloud session>
  Disable globally: export VISUAL_QA_DISABLE=1
  See: .claude/skills/visual-qa/skill.md
EOF
  exit 2
fi

if [[ "$result" == UNSHIPCHECKED:* ]]; then
  fname="${result#UNSHIPCHECKED:}"
  cat >&2 <<EOF
🛑 BLOCKED — edit to \`${fname}\` (scripts/lib/ or .github/workflows/) without /ship-check
  These paths bypass unit-test coverage often: helpers get tested in isolation,
  and their wrappers + workflow integration are where the real bugs live. Commit
  073db6bab0 shipped two P0s after tsc + 10 green tests; /ship-check caught them.
  Satisfy with ANY of:
    - /ship-check                              (canonical: 3-reviewer adversarial pass)
    - codex exec ...                           (Codex CLI invocation)
    - curl https://api.openai.com/v1/...       (GPT-4o reviewer call)
    - Agent tool with description containing 'review'/'audit'/'ship-check'
  Bypass: NO-VERIFY: <why this can't break anything>
EOF
  exit 2
fi

exit 0
