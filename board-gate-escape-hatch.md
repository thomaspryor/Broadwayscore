# Escape hatch: how to un-stick your Mac if the board gate blocks you

**Read time: 1 minute. No terminal, no commands, no Claude session needed.**

---

## What this is for

Several Claude Code hooks refuse to let a session save its work (`git commit`) or finish cleanly unless a card
exists on the project board. During the Notion → Linear cutover, the board is being swapped underneath those
hooks. If that swap goes wrong — or if Linear has an outage on the wrong day — every Claude session on this Mac
can end up unable to commit, and the sessions cannot repair it themselves.

This is the off switch. It is a single empty file. When it exists, every gate hook stands down immediately,
before it talks to any board, and lets the work through.

## The file

```
/Users/tompryor/.claude/BOARD_GATE_DISABLED
```

- The folder is `.claude` inside your home folder (the one with your name on it, `tompryor`).
- The file is named `BOARD_GATE_DISABLED` — capital letters, underscores, no spaces.
- **It can be completely empty.** Nothing needs to be inside it. The hooks only check whether it exists.
- **A file extension is fine.** `BOARD_GATE_DISABLED.txt` works exactly the same as `BOARD_GATE_DISABLED`,
  because TextEdit adds `.txt` whether you want it or not. Anything starting with `BOARD_GATE_DISABLED` counts.

## How to create it, with no terminal

1. Click on the desktop, then in the menu bar choose **Go → Go to Folder…** (or press **⇧⌘G**).
2. Type this and press Return:
   ```
   ~/.claude
   ```
   A Finder window opens showing the `.claude` folder. (This folder is normally hidden because its name starts
   with a dot — Go to Folder is the way in. You can also press **⇧⌘.** in any Finder window to show hidden files.)
3. Open **TextEdit** (⌘Space, type `TextEdit`, press Return). A blank document appears.
4. Type one word in it so it is not empty — for example `off`. (An empty TextEdit document sometimes refuses
   to save. The content is ignored either way.)
5. Choose **File → Save**. In the save dialog press **⇧⌘G**, type `~/.claude`, press Return.
6. In the **Save As** box type:
   ```
   BOARD_GATE_DISABLED
   ```
   Click **Save**. If TextEdit warns about the file extension, click **Use .txt** — that is fine.

That is the whole thing. It takes effect on the very next command a Claude session runs. Nothing needs to be
restarted.

## How to turn the gate back on

Drag the file to the Trash. That is all. The gates resume on the next command.

## What it does and does not do

- **It does:** let every Claude Code session commit code and end cleanly without a board card, without
  contacting Notion or Linear at all.
- **It does not:** break anything, delete anything, change any code, or lose any work. Sessions still do their
  jobs; they just stop being blocked on card bookkeeping.
- **The trade-off:** work done while the hatch is in place may not be tracked on the board. That is deliberate.
  Untracked work is a small problem; a Mac that cannot commit is a large one.

## When you would use it

Any of these:

- A Claude session tells you it cannot commit and keeps failing to create a card.
- Several sessions at once report being blocked, or being unable to finish.
- You are told the board (Notion or Linear) is down, rate-limited, or returning errors.
- You have no idea what is wrong but nothing is saving. This is safe to try first; it is reversible in one drag.

You do not need to ask anyone before creating it. It is yours, it is reversible, and it cannot cause damage.

---

## For engineers (not needed by the owner)

- Canonical path: `$HOME/.claude/BOARD_GATE_DISABLED`. Hooks must match the **prefix**, so
  `BOARD_GATE_DISABLED.txt` and `BOARD_GATE_DISABLED.rtf` are honoured — TextEdit's default save behaviour makes
  an exact-name-only check a foot-gun for a no-terminal user.
- The check must be the **first thing** in each hook, before any board reachability probe, any `jq` on stdin, and
  any network call — the failure mode it exists for is "the board is reachable but wrong", and a probe that runs
  first can hang for its full timeout on every gated command.
- The hatch must be honoured **unconditionally**: no session-id requirement, no repo requirement, no
  "unless the diff is large" carve-out. An escape hatch with conditions is not an escape hatch.
- Hooks that honour it (all five registered in `~/.claude/settings.json`):
  `notion-card-required-commit.sh`, `notion-card-required-stop.sh`, `notion-create-block.sh`,
  `notion-create-verify.sh`, `notion-mcp-block.sh`; plus the repo-scoped cloud copy
  `.claude/hooks/notion-create-block.sh`.
- **Status: wired in (task S4-T3a landed).** Confirmed live 2026-08-26 (BRO-151) — the hatch let a
  commit through `notion-card-required-commit.sh` when Notion was correctly refusing writes
  post-cutover (BRO-377) and the session was tracking work in Linear instead.
