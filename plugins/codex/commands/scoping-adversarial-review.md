---
description: Run an incremental-write adversarial framing review of a scoping plan (phase-level docs/ops/plans/*.md). Writes each of the 5 scoping review sections to disk as it goes and appends <!-- REVIEW COMPLETE --> as the final act. Use this instead of /codex:adversarial-review for scoping plan review.
argument-hint: '--spec <absolute-scoping-plan-path> --output <absolute-output-path> [--model <model|spark>] [--context-file <absolute-path>] [--wait|--background]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*)
---

Run a scoping adversarial review through the shared plugin runtime.
This command reviews a phase scoping plan (framing review, not code review) and writes
the review output incrementally — each of the 5 sections is written to disk as Codex
finishes it. A `<!-- REVIEW COMPLETE -->` footer is appended as the final act.

The companion checks for this marker to distinguish a complete review from a partial
file written before context overflow.

Output sections (exact headings — downstream judge and deduplicator read these):
1. Framing Assessment
2. Unjustified Load-Bearing Architectural Decisions
3. Child Decomposition Correctness
4. Ordering Correctness
5. Overall Verdict

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only — framing review of the phase plan.
- Do not fix the plan, apply patches to it, or suggest you are about to make changes.
- Your only job is to run the review and report the companion output verbatim.

Argument handling:
- `--spec <path>`: absolute path to the scoping plan file to review. Required.
- `--output <path>`: absolute path where the review output should be written. Required.
- `--model <model>`: model override. Passed through to Codex.
- `--context-file <path>`: optional absolute path to a UTF-8 text file with supplemental
  dispatch context (e.g. a POAgent dispatch note) to carry into the review prompt. Read
  in place; the file's path is never sent to the model, only its contents. Capped at 256 KB.
  Omit for the default behavior.
- `--wait`: run in the foreground (default behavior here).
- `--background`: detach and return immediately.
- Preserve all user-supplied arguments exactly.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" scoping-adversarial-review $ARGUMENTS
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- If `[PLUGIN-INCOMPLETE]` appears in the output, surface it clearly — the review
  overflowed and the output file is partial. The stall-reroute hook should re-run.

Background flow:
- Launch with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" scoping-adversarial-review $ARGUMENTS`,
  description: "Codex scoping adversarial review",
  run_in_background: true
})
```
- After launching, tell the user: "Codex scoping review started in the background. Check `/codex:status` for progress."
