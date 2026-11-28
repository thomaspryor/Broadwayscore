# Cloud UI change speed (BRO-7629)

Read when a small UI change should go from "owner says build it" to live in one sitting.

1. Fast tests: pushing `land/*` runs `scripts/lib/land-fast-tests.js` (unit tests that name a changed file; a test naming the file by full path is never cut by the cap). Push first; run `land-local-check.js` (about 20 min) only if the preflight or land asks.
2. Visual approval is durable: after an approved push the gate writes `visual-approved/<YYYYMMDD>-<id>` on origin (id = verbatim patch-id of the diff restricted to UI files, 7-day TTL, `scripts/lib/visual-approval-durable.js`). A new container or a follow-up commit with the same UI diff passes; any UI change gets a new id and asks again. Master hook note: on a Mac the `~/.claude/hooks` master shadows the repo copy, so this holds in cloud.
3. Screenshots in cloud: `npm run cloud:visual-qa -- --paths=/my-shows,/show/hamilton` starts `next dev` on a free port, waits for the first compile, runs `scripts/visual-qa.mjs` (widths 360 to 1440), stops the server and removes `.next/dev`.
4. Session env: `session-start.sh` exports `NEXT_TELEMETRY_DISABLED=1` and `--max-old-space-size=8192` through `CLAUDE_ENV_FILE`. `npm run typecheck` appends the heap flag.
5. Quiet stops: session start restores `data/gold-lists-computed.json` residue from a killed check (`restore-prebuild-residue.js`) and points `claude/<name>` at `origin/main` when it holds no local commits.
