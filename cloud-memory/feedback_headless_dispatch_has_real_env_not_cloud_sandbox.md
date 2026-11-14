---
name: headless-dispatch-has-real-env-not-cloud-sandbox
description: "A Linear/Notion-dispatched 'headless' session on the Mac Studio is NOT a claude.ai/code cloud sandbox — it has the real .env with real scraping/API credentials, even though check-cloud-secrets.js (which checks raw process.env) reports them all MISSING"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: eb006cb8-f862-453a-9573-ef31d7fe731a
  modified: 2026-08-21T09:59:09.478Z
---

A task prompt saying "Dispatch mode: headless" does not mean the session is a stateless claude.ai/code cloud sandbox per `.claude/CLOUD.md`. On this project it more often means a locally-dispatched worktree job on the Mac Studio (auto-dispatched via `bsc-next.js`/cmux), which has the real `.env` symlinked in (`SCRAPINGBEE_API_KEY`, `BRIGHTDATA_TOKEN`, `OPENAI_API_KEY`, etc. all real values).

**The trap:** `node scripts/check-cloud-secrets.js` reads raw `process.env`, which is empty in this kind of session (no shell sourced `.env`) — it reports every Tier-1 secret MISSING even when `.env` on disk has real keys. Scripts that load credentials the codebase-standard way (`scripts/lib/load-env.js`'s `readEnvKeys()`, as `linear-client.js` does) see them fine.

**Why:** BRO-591 (2026-08-21) spent real design effort assuming live scraping was impossible in this session (based on `check-cloud-secrets.js` + a bare `process.env.SCRAPINGBEE_API_KEY` check both saying MISSING), before discovering `grep '^SCRAPINGBEE_API_KEY=' .env` showed a real 80-char key. A credential-gated code path in the new script (`--mode=replay`) initially used the same wrong raw-`process.env` check and would have repeated the same false "no creds" conclusion for any future operator.

**How to apply:** before concluding a headless/dispatched session lacks credentials, check `.env` directly (`grep '^KEY=.\+' .env` or `readEnvKeys()`) — never trust a bare `process.env.KEY` read or `check-cloud-secrets.js`'s verdict alone in a session that isn't confirmed to be a true claude.ai/code cloud sandbox. Genuine cloud sandboxes (no `~/.claude/`, per `.claude/CLOUD.md`) are the exception, not the default, for "headless" dispatch on this project.
