#!/usr/bin/env python3
"""Audit workflows for outputs-after-push silent loss (local audit tool, not CI).

Flags job steps that appear to write repo files AFTER the job's last push of
that tree — such writes are discarded at job end with no error. Also finds the
inverse blind spot with --no-push-jobs: jobs that write repo files but never
push at all (how the update-show-status quota-ledger loss hid from pass 1).

Heuristic scanner: expect benign hits (dispatch-only steps, self-committing
health stamps, gitignored scratch, GITHUB_STEP_SUMMARY writers). Every hit
needs a benign-or-fix triage — see "Step Ordering: Writes Before Pushes" in
.github/workflows/CLAUDE.md and the 2026-07-11 audit (Notion 39a637c5-416f-81e4:
21 jobs triaged, 18 benign, 3 fixed).

Usage:
  python3 scripts/audit-outputs-after-push.py                # post-push writers
  python3 scripts/audit-outputs-after-push.py --no-push-jobs # write-but-never-push jobs

Requires: pyyaml (pip install pyyaml). Run from the repo root.
"""
import yaml, glob, re, json, sys

NO_PUSH_MODE = '--no-push-jobs' in sys.argv

def is_push_step(step):
    uses = step.get('uses','') or ''
    run = step.get('run','') or ''
    if re.search(r'\./\.github/actions/push-', uses): return uses.split('/')[-1]
    if 'git push' in run or 'push-with-retry.sh' in run: return 'git push'
    return None

def writes_files(step):
    """Heuristic: does this step potentially write to a repo working tree?"""
    run = step.get('run','') or ''
    uses = step.get('uses','') or ''
    if not run and uses:
        # composite actions other than push/checkout/setup/notify could write
        name = uses.split('/')[-1].split('@')[0]
        if name in ('notify-failure','dispatch-deploy','setup-node','setup-playwright','check-file-sizes'): return None
        if name.startswith(('checkout','push')): return None
        if uses.startswith('actions/'): return None
        return f'uses:{name}'
    signals = []
    if re.search(r'\bnode\s+(scripts|\.\/scripts)/', run): signals.append('node script')
    if re.search(r'(?<!&)>>?\s*(?!/tmp|/dev|\$GITHUB|"?\$\{?GITHUB|&)', run) and re.search(r'>>?\s*["\']?(data/|public/|scripts/|src/|\./|[A-Za-z0-9_./-]+\.(json|md|txt|csv|html))', run): signals.append('redirect')
    if re.search(r'\b(cp|mv|rsync)\b.*\b(data/|public/|src/)', run): signals.append('cp/mv')
    if re.search(r'\bjq\b.*>\s*\S', run): signals.append('jq write')
    return ', '.join(signals) if signals else None

results = {}
for path in sorted(glob.glob('.github/workflows/*.yml') + glob.glob('.github/workflows/*.yaml')):
    try:
        wf = yaml.safe_load(open(path))
    except Exception as e:
        print(f'PARSE FAIL {path}: {e}', file=sys.stderr); continue
    if not isinstance(wf, dict): continue
    for jobname, job in (wf.get('jobs') or {}).items():
        steps = job.get('steps') or []
        push_idx = [(i, is_push_step(s)) for i,s in enumerate(steps) if is_push_step(s)]
        if NO_PUSH_MODE:
            if push_idx: continue
            writers = []
            for i, s in enumerate(steps):
                w = writes_files(s)
                if w:
                    writers.append({'step': s.get('name', s.get('uses', 'unnamed')), 'idx': i, 'signals': w})
            if writers:
                results.setdefault(path, []).append({'job': jobname, 'pushes': [], 'writers': writers})
            continue
        if not push_idx: continue
        first_push = push_idx[0][0]
        after = []
        for i in range(first_push+1, len(steps)):
            s = steps[i]
            # skip if this step is itself a push (covers the later writes)
            if is_push_step(s):
                # writes before a LATER push are fine; reset
                after = []
                continue
            w = writes_files(s)
            if w:
                after.append({'step': s.get('name', s.get('uses', 'unnamed')), 'idx': i, 'signals': w})
        if after:
            results.setdefault(path, []).append({'job': jobname, 'pushes': [p[1] for p in push_idx], 'post_push_writers': after})

print(json.dumps(results, indent=1))
print(f'\n{len(results)} workflows flagged', file=sys.stderr)
