---
description: Run an incremental-write adversarial review of a spec file. Writes each review section to disk as it goes and appends <!-- REVIEW COMPLETE --> as the final act. Use this instead of /codex:adversarial-review for spec prose review.
argument-hint: '--spec <absolute-spec-path> --output <absolute-output-path> [--model <model|spark>] [--wait|--background]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*)
---

Run a spec adversarial review through the shared plugin runtime.
This command reviews a spec file (prose, not code) and writes the review output
incrementally — each section is written to disk as Codex finishes it. A
`<!-- REVIEW COMPLETE -->` footer is appended as the final act.

The companion checks for this marker to distinguish a complete review from a
partial file written before context overflow.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix the spec, apply patches to the spec, or suggest that you are about
  to make changes to the spec.
- Your only job is to run the review and report the companion output.

Argument handling:
- `--spec <path>`: absolute path to the spec file to review. Required.
- `--output <path>`: absolute path where the review output should be written. Required.
- `--model <model>`: model override. Passed through to Codex.
- `--wait`: run in the foreground (default behavior here).
- `--background`: detach and return immediately.
- Preserve all user-supplied arguments exactly.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" spec-adversarial-review $ARGUMENTS
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- If `[PLUGIN-INCOMPLETE]` appears in the output, surface it clearly — the review
  overflowed and the output file is partial.

Background flow:
- Launch with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" spec-adversarial-review $ARGUMENTS`,
  description: "Codex spec adversarial review",
  run_in_background: true
})
```
- After launching, tell the user: "Codex spec review started in the background. Check `/codex:status` for progress."
