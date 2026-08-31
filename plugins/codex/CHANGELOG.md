# Changelog

## 1.0.3-grimoire.12

- Port upstream v1.0.5 `/codex:transfer`: converts the current Claude Code session into a persistent, resumable Codex thread via the external-agent session importer (`externalAgentConfig/import`), with the `SessionStart` hook now exporting the transcript path and `--source` as a manual override.
- Declare `requestAttestation: false` in the app-server initialize capabilities and include captured stderr when the spawned app-server exits unexpectedly (upstream parity).
- Drop the deprecated `experimentalRawEvents` field from thread/start params, matching upstream and Codex CLI 0.145.0.

## Unreleased

- Treat a missing `<!-- REVIEW COMPLETE -->` marker as a failing exit for incremental-write reviews (`spec-adversarial-review`, `scoping-adversarial-review`). A finalization-timer kill resolves to exit 0 inside `runCodexExecTask`, and deliverable verification only checked that the declared output path existed, so a review truncated mid-write exited 0 and callers that publish on exit 0 promoted the fragment as a finished artifact. The marker is now load-bearing for these two commands; generic `--expect-file` task runs are unaffected.
- Raise the incremental-write finalization timeout from 60s to 180s. Deep-tier models can deliberate for well over a minute between the narration that precedes the review-evidence section and the `apply_patch` that writes it; the idle timeout remains the real backstop.
- Add the Owner Law 7 "Occam's Gate" clause to every Codex review prompt: `adversarial-review`, `review-mcp`, `spec-adversarial-review`, and `scoping-adversarial-review`. When the artifact under review declares a `## Occam's Gate` section, every Medium-or-higher finding must carry an `Occam impact` verdict (`WITHIN_BASELINE` / `EXPANDS_BASELINE`), and every `EXPANDS_BASELINE` finding must carry a complete four-part `Occam rebuttal` or it cannot support a fail verdict. When the artifact declares no such section, the fields are omitted and prompt behavior is unchanged. The two JSON-output review modes carry the fields inside the finding `body` because `review-output.schema.json` is closed (`additionalProperties: false`) and cannot accept new top-level finding keys.
- Add `--context-file <path>` to `/codex:spec-adversarial-review` and `/codex:scoping-adversarial-review`. The file's contents are injected into the review prompt under a fixed, load-bearing `REVIEWER CONTEXT` label that marks them as a supplemental dispatch note rather than artifact content, so carried context stays out of `files_examined`. The file's own path is never sent to the model. A supplied-but-unusable value (empty, missing, unreadable, empty/whitespace-only file, or over the 256 KB cap) fails fast with a nonzero exit before Codex is spawned, so a dispatch that mandates carriage can never run uncarried. With the flag omitted, prompt rendering is unchanged.
- Make `/codex:review` the default MCP-capable self-collected standard review path.
- Remove the separate `/codex:review:mcp` and `/codex:review-mcp` command surfaces.

## 1.0.3-grimoire.11

- Port upstream v1.0.6 shell hardening: `git.mjs` now forces `shell: false` on every git invocation so repository-derived arguments (branch names, refs) can never pass through a shell, with an upstream regression test covering special-character default branch names.

## 1.0.3-grimoire.10

- Move `/codex:review`, `/codex:adversarial-review`, and rescue/task execution onto direct `codex exec` so MCP-capable flows no longer depend on the older app-server review path.
- Add Windows Codex CLI resolution fallbacks for direct exec launches and send prompts over stdin/output-schema temp files to avoid shell quoting and long-argv failures.
- Harden stale background job reconciliation by rewriting dead queued/running job records to failed state instead of leaving stale process metadata behind.

## 1.0.3-grimoire.6

- Expose `--model <model|spark>` on the then-current review slash-command surfaces before the MCP aliases were later folded into `/codex:review`.

## 1.0.3-grimoire.5

- Propagate `idleTimeoutMs` into the `runAppServerTurn` capture path so MCP review, adversarial review, rescue, and task runs inherit the same per-turn idle watchdog as native review.

## 1.0.3-grimoire.4

- Add the first MCP-capable self-collected standard review path before it was later folded into `/codex:review`.
- At that point, keep native `/codex:review` unchanged while allowing a separate MCP-capable review flow.

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
