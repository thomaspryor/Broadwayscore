"""Review-text write matcher used by verify-edits.sh (BRO-2632).

The caller strips heredoc bodies first. This is a best-effort command-line
guard: opaque shell -c payloads and env -S are not unwrapped. The independent
pre-push-review-gate.sh still inspects the resulting diff, as for heredocs.
"""
import re

# Recognized wrapper prefixes only. Never scan arbitrary arguments for commands:
# timeout 30 echo 'sed -i ...' must remain a harmless mention.
_H = r'[ \t]+'
_WORD = r'''(?:[^\s;&|<>"'\\]|'[^'\n]*'|"(?:\\[^\n]|[^"\\\n])*"|\\[^\n])+'''
_ASSIGN = rf'[A-Za-z_][A-Za-z0-9_]*=(?:{_WORD})?'
_BIN = r'(?:/(?:[\w.+-]+/)*)?'
_WRAPPER = (
    rf'{_BIN}timeout{_H}(?:(?:-s|--signal|-k|--kill-after){_H}{_WORD}{_H}'
    rf'|(?:-[sk]{_WORD}|--(?:signal|kill-after)={_WORD}|--foreground|--preserve-status|--verbose|--){_H})*{_WORD}{_H}'
    rf'|{_BIN}env{_H}(?:(?:-u|--unset|-C|--chdir){_H}{_WORD}{_H}'
    rf'|(?:-[uC]{_WORD}|--(?:unset|chdir)={_WORD}|-i|--ignore-environment|--){_H})*'
    rf'|{_BIN}nohup{_H}(?:--{_H})?'
    rf'|{_BIN}nice{_H}(?:(?:-n|--adjustment){_H}{_WORD}{_H}'
    rf'|(?:-n{_WORD}|--adjustment={_WORD}|-\d+|--){_H})*'
    rf'|{_BIN}stdbuf{_H}(?:(?:-[ioe]|--input|--output|--error){_H}{_WORD}{_H}'
    rf'|(?:-[ioe]{_WORD}|--(?:input|output|error)={_WORD}|--){_H})*'
    rf'|{_BIN}time{_H}(?:(?:-f|--format|-o|--output){_H}{_WORD}{_H}'
    rf'|(?:-[fo]{_WORD}|--(?:format|output)={_WORD}|-p|-a|-v|--portability|--append|--verbose|--quiet|--){_H})*'
    rf'|{_BIN}command{_H}(?:(?:-p|--){_H})*'
)
_STMT = rf'[ \t]*(?:(?:{_ASSIGN}){_H}|(?:{_WRAPPER}))*'
_shell_write_re = re.compile(
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
    # python -c "...open('.../review-texts/...', 'w')..."
    rf"|{_STMT}python3?\s+-c\s+['\"][^'\"]*open\([^)]*review-texts"
    r')',
    re.MULTILINE,
)

# Preserve the hook's existing detection of writer calls in Node/Bun payloads.
_embedded_write_re = re.compile(
    # Node/Bun writer calls must include review-texts in args (locality is
    # natural because these are single function-call expressions)
    r'writeFileSync\([^)]*review-texts'
    r'|appendFileSync\([^)]*review-texts'
    r'|createWriteStream\([^)]*review-texts'
    r'|fs\.(?:writeFile|appendFile|rename|cp)[^(]*\([^)]*review-texts'
    r'|Bun\.write\([^)]*review-texts'
)


def _shell_syntax_positions(command: str):
    """Yield executable starts and redirects, including command substitutions."""
    yield 0
    quote = None
    context = None
    depth = 0
    contexts = []
    escaped = False
    comment = False
    word_start = True
    skip_next = False
    for index, char in enumerate(command):
        if skip_next:
            skip_next = False
            continue
        if escaped:
            escaped = False
            continue
        if comment:
            if char == '\n':
                comment = False
                word_start = True
                yield index + 1
            continue
        if char == '\\' and quote != "'":
            escaped = True
            if index + 1 < len(command) and command[index + 1] != '\n':
                word_start = False
            continue
        # Substitutions execute inside double quotes. Save the enclosing
        # quote and parenthesis state, then scan their contents as commands.
        if quote != "'" and command[index:index + 2] == '$(':
            contexts.append((quote, context, depth))
            quote, context, depth = None, 'paren', 0
            word_start = True
            skip_next = True
            yield index + 2
            continue
        if quote != "'" and char == '`':
            if context == 'backtick':
                quote, context, depth = contexts.pop()
                word_start = False
            else:
                contexts.append((quote, context, depth))
                quote, context, depth = None, 'backtick', 0
                word_start = True
                yield index + 1
            continue
        if quote:
            if char == quote:
                quote = None
            continue
        if char in "'\"":
            quote = char
            word_start = False
        elif char == '#' and word_start:
            comment = True
        elif char in '\n;&|':
            word_start = True
            yield index + 1
        elif char == '>':
            word_start = True
            yield index
        elif char == '(':
            depth += 1
            word_start = True
            yield index + 1
        elif char == ')':
            if context == 'paren' and depth == 0:
                quote, context, depth = contexts.pop()
                word_start = False
            else:
                depth = max(0, depth - 1)
                word_start = True
        elif char.isspace() or char == '<':
            word_start = True
        else:
            word_start = False


def is_review_texts_write(command: str) -> bool:
    """Classify a command after the hook has stripped heredoc bodies."""
    if not command:
        return False
    if _embedded_write_re.search(command):
        return True
    return any(_shell_write_re.match(command, pos)
               for pos in _shell_syntax_positions(command))
