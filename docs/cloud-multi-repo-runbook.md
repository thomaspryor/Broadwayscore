# Multi-repo cloud sessions (BRO-5008, BRO-5221)

Moved from `.claude/CLOUD.md` (BRO-7994, byte cap).

Several repos attached, or a misspelled `create_session` source_url, start the session in `/home/user`: `--add-dir` loads commands, never hooks. The setup-script line (below) runs `scripts/install-home-claude-config.js`, which wires every hook into `/home/user/.claude` and links `commands/`, `skills/`, `agents/`; startup repairs drift. Check with its `--check`.

If that reports DRIFT, or `--check` does not exist (no checkout), no repo hooks fire: follow the hook rules by hand (no `POST /broadcasts/{id}/send`, no MCP writes to `main`, review before landing, close the card). Stall Stop gates load via the app repo `stall-stop-bootstrap.sh`; a `BRO-7194:` message means they did not.

`--adopt-hookless-settings` preserves unmarked, hookless settings, including permissions and `autoMode`, across install and uninstall.
