# Changelog

## 1.0.3-grimoire.3

- Fail fast when the shared broker loses its upstream Codex app-server so review/task runs surface an error instead of hanging on an orphaned socket.
- Add a 60-second JSON-RPC request timeout for app-server startup/control calls so broker setup and turn/review start requests cannot block forever.

## 1.0.3-grimoire.2

- Restore Windows Codex CLI availability checks by allowing shell-based resolution only for the `codex` preflight probes.
- Keep the safer default `shell: false` subprocess behavior for runtime commands so the `taskkill` / MSYS path-mangling fix remains intact.

## 1.0.3-grimoire.1

- Package the fork as the `grimoire-openai-codex` Claude marketplace while keeping the plugin name `codex`.
- Preserve the Grimoire rescue-hygiene task prompt injection on all delegated task runs.
- Fix Windows process execution defaults so cancel/status flows do not route `taskkill` through Git Bash or another shell.
- Reconcile stale queued/running jobs into failed jobs when their worker PID is already gone, which prevents orphaned jobs from blocking resume flows forever.
- Treat `--effort minimal` as a compatibility alias for `low` when forwarding task runs to the Codex app server.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
