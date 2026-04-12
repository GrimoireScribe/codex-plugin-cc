warning: in the working copy of 'plugins/codex/scripts/codex-companion.mjs', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'tests/runtime.test.mjs', LF will be replaced by CRLF the next time Git touches it
[1mdiff --git a/plugins/codex/scripts/codex-companion.mjs b/plugins/codex/scripts/codex-companion.mjs[m
[1mindex 7b495ea..5c7d345 100644[m
[1m--- a/plugins/codex/scripts/codex-companion.mjs[m
[1m+++ b/plugins/codex/scripts/codex-companion.mjs[m
[36m@@ -17,7 +17,6 @@[m [mimport {[m
     interruptAppServerTurn,[m
     parseStructuredOutput,[m
     readOutputSchema,[m
[31m-    runAppServerReview,[m
     runAppServerTurn[m
   } from "./lib/codex.mjs";[m
 import { readStdinIfPiped } from "./lib/fs.mjs";[m
[36m@@ -52,7 +51,6 @@[m [mimport {[m
 } from "./lib/tracked-jobs.mjs";[m
 import { resolveWorkspaceRoot } from "./lib/workspace.mjs";[m
 import {[m
[31m-  renderNativeReviewResult,[m
   renderReviewResult,[m
   renderStoredJobResult,[m
   renderCancelReport,[m
[36m@@ -66,7 +64,7 @@[m [mconst ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));[m
 const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");[m
 const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;[m
 const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;[m
[31m-const NATIVE_REVIEW_IDLE_TIMEOUT_MS = 60000;[m
[32m+[m[32mconst TASK_IDLE_TIMEOUT_MS = readPositiveEnvInt("CODEX_TASK_IDLE_TIMEOUT_MS", 180000);[m
 const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);[m
 const REASONING_EFFORT_ALIASES = new Map([["minimal", "low"]]);[m
 const MODEL_ALIASES = new Map([["spark", "gpt-5.3-codex-spark"]]);[m
[36m@@ -137,19 +135,78 @@[m [mAfter reading this block, proceed with the user's actual request below.[m
 [m
 `;[m
 [m
[32m+[m[32mfunction readPositiveEnvInt(name, fallback) {[m
[32m+[m[32m  const raw = process.env[name];[m
[32m+[m[32m  const parsed = Number(raw);[m
[32m+[m[32m  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;[m
[32m+[m[32m}[m
[32m+[m
 function injectRescueHygiene(prompt) {[m
   if (typeof prompt !== "string" || !prompt.trim()) return prompt;[m
   if (prompt.includes(POAGENT_RESCUE_HYGIENE_MARKER)) return prompt;[m
   return POAGENT_RESCUE_HYGIENE_BLOCK + prompt;[m
 }[m
 [m
[32m+[m[32mfunction buildPlatformCommandGuidance(platform = process.platform) {[m
[32m+[m[32m  const lines = [[m
[32m+[m[32m    "If shell commands fail under the sandbox, report that clearly instead of presenting an unverified clean result."[m
[32m+[m[32m  ];[m
[32m+[m[32m  if (platform === "win32") {[m
[32m+[m[32m    lines.push("This runtime is on Windows.");[m
[32m+[m[32m    lines.push("Prefer `rg`, `git grep`, or PowerShell-native reads/searches over plain `grep`.");[m
[32m+[m[32m  } else {[m
[32m+[m[32m    lines.push("Prefer `rg` or `git grep` over broad recursive shell search when possible.");[m
[32m+[m[32m  }[m
[32m+[m[32m  lines.push("For repository history or diff inspection, prefer `git` subcommands.");[m
[32m+[m[32m  return lines;[m
[32m+[m[32m}[m
[32m+[m
[32m+[m[32mfunction buildReadOnlyInvestigationPrompt(prompt) {[m
[32m+[m[32m  const taskText = String(prompt ?? "").trim();[m
[32m+[m[32m  if (!taskText) {[m
[32m+[m[32m    return taskText;[m
[32m+[m[32m  }[m
[32m+[m[32m  return [[m
[32m+[m[32m    "You are running in read-only investigation mode.",[m
[32m+[m[32m    "Do not edit files, apply patches, or attempt persistence unless the user explicitly asks for changes.",[m
[32m+[m[32m    ...buildPlatformCommandGuidance(),[m
[32m+[m[32m    "",[m
[32m+[m[32m    taskText[m
[32m+[m[32m  ].join("\n");[m
[32m+[m[32m}[m
[32m+[m
[32m+[m[32mfunction buildWriteTaskPrompt(prompt) {[m
[32m+[m[32m  const taskText = injectRescueHygiene(prompt);[m
[32m+[m[32m  if (typeof taskText !== "string" || !taskText.trim()) {[m
[32m+[m[32m    return taskText;[m
[32m+[m[32m  }[m
[32m+[m[32m  return [[m
[32m+[m[32m    taskText.trimEnd(),[m
[32m+[m[32m    "",[m
[32m+[m[32m    "## Runtime command guidance",[m
[32m+[m[32m    ...buildPlatformCommandGuidance(),[m
[32m+[m[32m    "",[m
[32m+[m[32m    "Apply the user's request with those platform constraints in mind."[m
[32m+[m[32m  ].join("\n");[m
[32m+[m[32m}[m
[32m+[m
[32m+[m[32mfunction buildGraphToolFallbackPrompt(prompt, reason) {[m
[32m+[m[32m  return [[m
[32m+[m[32m    "Graph/MCP tools are currently unavailable or unstable for this run.",[m
[32m+[m[32m    "Do not call MCP or graph tools in this attempt.",[m
[32m+[m[32m    "Use read-only git diff, rg, and file reads only.",[m
[32m+[m[32m    `Failure trigger: ${reason}`,[m
[32m+[m[32m    "",[m
[32m+[m[32m    prompt[m
[32m+[m[32m  ].join("\n");[m
[32m+[m[32m}[m
[32m+[m
 function printUsage() {[m
   console.log([m
     [[m
       "Usage:",[m
       "  node scripts/codex-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",[m
       "  node scripts/codex-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",[m
[31m-      "  node scripts/codex-companion.mjs review-mcp [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",[m
       "  node scripts/codex-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",[m
       "  node scripts/codex-companion.mjs task [--background] [--write] [--resume-last|--resume|--fresh] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [prompt]",[m
       "  node scripts/codex-companion.mjs status [job-id] [--all] [--json]",[m
[36m@@ -357,31 +414,12 @@[m [mfunction ensureCodexAvailable(cwd) {[m
   }[m
 }[m
 [m
[31m-function buildNativeReviewTarget(target) {[m
[31m-  if (target.mode === "working-tree") {[m
[31m-    return { type: "uncommittedChanges" };[m
[31m-  }[m
[31m-[m
[31m-  if (target.mode === "branch") {[m
[31m-    return { type: "baseBranch", branch: target.baseRef };[m
[31m-  }[m
[31m-[m
[31m-  return null;[m
[31m-}[m
[31m-[m
 function validateNativeReviewRequest(target, focusText) {[m
   if (focusText.trim()) {[m
     throw new Error([m
[31m-      `\`/codex:review\` now maps directly to the built-in reviewer and does not support custom focus text. Retry with \`/codex:adversarial-review ${focusText.trim()}\` for focused review instructions.`[m
[32m+[m[32m      `\`/codex:review\` is the standard review path and does not support custom focus text. Retry with \`/codex:adversarial-review ${focusText.trim()}\` for focused review instructions.`[m
     );[m
   }[m
[31m-[m
[31m-  const nativeTarget = buildNativeReviewTarget(target);[m
[31m-  if (!nativeTarget) {[m
[31m-    throw new Error("This `/codex:review` target is not supported by the built-in reviewer. Retry with `/codex:adversarial-review` for custom targeting.");[m
[31m-  }[m
[31m-[m
[31m-  return nativeTarget;[m
 }[m
 [m
 function renderStatusPayload(report, asJson) {[m
[36m@@ -466,127 +504,34 @@[m [masync function executeReviewRun(request) {[m
   });[m
   const focusText = request.focusText?.trim() ?? "";[m
   const reviewName = request.reviewName ?? "Review";[m
[31m-  if (reviewName === "Review") {[m
[31m-    const reviewTarget = validateNativeReviewRequest(target, focusText);[m
[31m-    try {[m
[31m-      const result = await runAppServerReview(request.cwd, {[m
[31m-        target: reviewTarget,[m
[31m-        model: request.model,[m
[31m-        onProgress: request.onProgress,[m
[31m-        idleTimeoutMs: NATIVE_REVIEW_IDLE_TIMEOUT_MS[m
[31m-      });[m
[31m-      const payload = {[m
[31m-        review: reviewName,[m
[31m-        target,[m
[31m-        threadId: result.threadId,[m
[31m-        sourceThreadId: result.sourceThreadId,[m
[31m-        codex: {[m
[31m-          status: result.status,[m
[31m-          stderr: result.stderr,[m
[31m-          stdout: result.reviewText,[m
[31m-          reasoning: result.reasoningSummary[m
[31m-        }[m
[31m-      };[m
[31m-      const rendered = renderNativeReviewResult([m
[31m-        {[m
[31m-          status: result.status,[m
[31m-          stdout: result.reviewText,[m
[31m-          stderr: result.stderr[m
[31m-        },[m
[31m-        { reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result.reasoningSummary }[m
[31m-      );[m
[31m-[m
[31m-      return {[m
[31m-        exitStatus: result.status,[m
[31m-        threadId: result.threadId,[m
[31m-        turnId: result.turnId,[m
[31m-        payload,[m
[31m-        rendered,[m
[31m-        summary: firstMeaningfulLine(result.reviewText, `${reviewName} completed.`),[m
[31m-        jobTitle: `Codex ${reviewName}`,[m
[31m-        jobClass: "review",[m
[31m-        targetLabel: target.label[m
[31m-      };[m
[31m-    } catch (error) {[m
[31m-      if (!shouldFallbackToSelfCollect(error)) {[m
[31m-        throw error;[m
[31m-      }[m
[31m-[m
[31m-      const detail = error instanceof Error ? error.message : String(error);[m
[31m-      request.onProgress?.({[m
[31m-        message: `Native review unavailable (${detail}). Falling back to self-collected review.`,[m
[31m-        phase: "investigating"[m
[31m-      });[m
[31m-[m
[31m-      const context = collectReviewContext(request.cwd, target);[m
[31m-      const prompt = buildAdversarialReviewPrompt(context, buildFallbackFocusText(focusText, detail));[m
[31m-      const result = await runAppServerTurn(context.repoRoot, {[m
[31m-        prompt,[m
[31m-        model: request.model,[m
[31m-        sandbox: "read-only",[m
[31m-        outputSchema: readOutputSchema(REVIEW_SCHEMA),[m
[31m-        onProgress: request.onProgress[m
[31m-      });[m
[31m-      const parsed = parseStructuredOutput(result.finalMessage, {[m
[31m-        status: result.status,[m
[31m-        failureMessage: result.error?.message ?? result.stderr[m
[31m-      });[m
[31m-      const fallbackReviewLabel = "Review (self-collected fallback)";[m
[31m-      const payload = {[m
[31m-        review: reviewName,[m
[31m-        target,[m
[31m-        threadId: result.threadId,[m
[31m-        context: {[m
[31m-          repoRoot: context.repoRoot,[m
[31m-          branch: context.branch,[m
[31m-          summary: context.summary[m
[31m-        },[m
[31m-        nativeFallback: {[m
[31m-          triggered: true,[m
[31m-          reason: detail[m
[31m-        },[m
[31m-        codex: {[m
[31m-          status: result.status,[m
[31m-          stderr: result.stderr,[m
[31m-          stdout: result.finalMessage,[m
[31m-          reasoning: result.reasoningSummary[m
[31m-        },[m
[31m-        result: parsed.parsed,[m
[31m-        rawOutput: parsed.rawOutput,[m
[31m-        parseError: parsed.parseError,[m
[31m-        reasoningSummary: result.reasoningSummary[m
[31m-      };[m
[31m-[m
[31m-      return {[m
[31m-        exitStatus: result.status,[m
[31m-        threadId: result.threadId,[m
[31m-        turnId: result.turnId,[m
[31m-        payload,[m
[31m-        rendered: renderReviewResult(parsed, {[m
[31m-          reviewLabel: fallbackReviewLabel,[m
[31m-          targetLabel: context.target.label,[m
[31m-          reasoningSummary: result.reasoningSummary[m
[31m-        }),[m
[31m-        summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${fallbackReviewLabel} finished.`),[m
[31m-        jobTitle: `Codex ${reviewName}`,[m
[31m-        jobClass: "review",[m
[31m-        targetLabel: context.target.label[m
[31m-      };[m
[31m-    }[m
[31m-  }[m
[31m-[m
   const context = collectReviewContext(request.cwd, target);[m
   const prompt =[m
[31m-    reviewName === "MCP Review"[m
[32m+[m[32m    reviewName === "Review" || reviewName === "MCP Review"[m
       ? buildMcpReviewPrompt(context, focusText)[m
       : buildAdversarialReviewPrompt(context, focusText);[m
[31m-  const result = await runAppServerTurn(context.repoRoot, {[m
[31m-    prompt,[m
[31m-    model: request.model,[m
[31m-    sandbox: "read-only",[m
[31m-    outputSchema: readOutputSchema(REVIEW_SCHEMA),[m
[31m-    onProgress: request.onProgress[m
[31m-  });[m
[32m+[m[32m  let result;[m
[32m+[m[32m  try {[m
[32m+[m[32m    result = await runAppServerTurn(context.repoRoot, {[m
[32m+[m[32m      prompt,[m
[32m+[m[32m      model: request.model,[m
[32m+[m[32m      sandbox: "read-only",[m
[32m+[m[32m      outputSchema: readOutputSchema(REVIEW_SCHEMA),[m
[32m+[m[32m      onProgress: request.onProgress[m
[32m+[m[32m    });[m
[32m+[m[32m  } catch (error) {[m
[32m+[m[32m    if (!shouldFallbackToSelfCollect(error)) {[m
[32m+[m[32m      throw error;[m
[32m+[m[32m    }[m
[32m+[m[32m    const fallbackReason = error instanceof Error ? error.message : String(error);[m
[32m+[m[32m    request.onProgress?.(`Graph/MCP path failed, retrying with self-collected review only: ${fallbackReason}`);[m
[32m+[m[32m    result = await runAppServerTurn(context.repoRoot, {[m
[32m+[m[32m      prompt: buildGraphToolFallbackPrompt(prompt, fallbackReason),[m
[32m+[m[32m      model: request.model,[m
[32m+[m[32m      sandbox: "read-only",[m
[32m+[m[32m      outputSchema: readOutputSchema(REVIEW_SCHEMA),[m
[32m+[m[32m      onProgress: request.onProgress[m
[32m+[m[32m    });[m
[32m+[m[32m  }[m
   const parsed = parseStructuredOutput(result.finalMessage, {[m
     status: result.status,[m
     failureMessage: result.error?.message ?? result.stderr[m
[36m@@ -604,7 +549,9 @@[m [masync function executeReviewRun(request) {[m
       status: result.status,[m
       stderr: result.stderr,[m
       stdout: result.finalMessage,[m
[31m-      reasoning: result.reasoningSummary[m
[32m+[m[32m      reasoning: result.reasoningSummary,[m
[32m+[m[32m      mcpToolFailures: result.mcpToolFailures ?? [],[m
[32m+[m[32m      commandFailures: result.commandFailures ?? [][m
     },[m
     result: parsed.parsed,[m
     rawOutput: parsed.rawOutput,[m
[36m@@ -657,16 +604,19 @@[m [masync function executeTaskRun(request) {[m
   // LOCAL PATCH (2026-04-08): inject POAgent rescue-hygiene block into every task[m
   // prompt. Idempotent — no-op if the marker is already present. See helper[m
   // definition near top of file for full rationale.[m
[31m-  const hygienizedPrompt = injectRescueHygiene(request.prompt);[m
[32m+[m[32m  const taskPrompt = request.write[m
[32m+[m[32m    ? buildWriteTaskPrompt(request.prompt)[m
[32m+[m[32m    : buildReadOnlyInvestigationPrompt(request.prompt);[m
 [m
   const result = await runAppServerTurn(workspaceRoot, {[m
     resumeThreadId,[m
[31m-    prompt: hygienizedPrompt,[m
[32m+[m[32m    prompt: taskPrompt,[m
     defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",[m
     model: request.model,[m
     effort: request.effort,[m
     sandbox: request.write ? "workspace-write" : "read-only",[m
     onProgress: request.onProgress,[m
[32m+[m[32m    idleTimeoutMs: request.write ? TASK_IDLE_TIMEOUT_MS : null,[m
     persistThread: true,[m
     threadName: resumeThreadId ? null : buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT)[m
   });[m
[36m@@ -682,7 +632,11 @@[m [masync function executeTaskRun(request) {[m
     {[m
       title: taskMetadata.title,[m
       jobId: request.jobId ?? null,[m
[31m-      write: Boolean(request.write)[m
[32m+[m[32m      write: Boolean(request.write),[m
[32m+[m[32m      sandboxMode: request.write ? "workspace-write" : "read-only",[m
[32m+[m[32m      commandFailures: result.commandFailures ?? [],[m
[32m+[m[32m      mcpToolFailures: result.mcpToolFailures ?? [],[m
[32m+[m[32m      dynamicToolFailures: result.dynamicToolFailures ?? [][m
     }[m
   );[m
   const payload = {[m
[36m@@ -690,7 +644,11 @@[m [masync function executeTaskRun(request) {[m
     threadId: result.threadId,[m
     rawOutput,[m
     touchedFiles: result.touchedFiles,[m
[31m-    reasoningSummary: result.reasoningSummary[m
[32m+[m[32m    reasoningSummary: result.reasoningSummary,[m
[32m+[m[32m    sandboxMode: request.write ? "workspace-write" : "read-only",[m
[32m+[m[32m    commandFailures: result.commandFailures ?? [],[m
[32m+[m[32m    mcpToolFailures: result.mcpToolFailures ?? [],[m
[32m+[m[32m    dynamicToolFailures: result.dynamicToolFailures ?? [][m
   };[m
 [m
   return {[m
[36m@@ -708,8 +666,8 @@[m [masync function executeTaskRun(request) {[m
 [m
 function buildReviewJobMetadata(reviewName, target) {[m
   return {[m
[31m-    kind: reviewName === "Adversarial Review" ? "adversarial-review" : reviewName === "MCP Review" ? "review-mcp" : "review",[m
[31m-    title: reviewName === "Review" ? "Codex Review" : reviewName === "MCP Review" ? "Codex MCP Review" : `Codex ${reviewName}`,[m
[32m+[m[32m    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",[m
[32m+[m[32m    title: reviewName === "Adversarial Review" ? `Codex ${reviewName}` : "Codex Review",[m
     summary: `${reviewName} ${target.label}`[m
   };[m
 }[m
[36m@@ -1172,11 +1130,6 @@[m [masync function main() {[m
     case "review":[m
       await handleReview(argv);[m
       break;[m
[31m-    case "review-mcp":[m
[31m-      await handleReviewCommand(argv, {[m
[31m-        reviewName: "MCP Review"[m
[31m-      });[m
[31m-      break;[m
     case "adversarial-review":[m
       await handleReviewCommand(argv, {[m
         reviewName: "Adversarial Review"[m
[1mdiff --git a/tests/runtime.test.mjs b/tests/runtime.test.mjs[m
[1mindex 9040837..5a2d7d0 100644[m
[1m--- a/tests/runtime.test.mjs[m
[1m+++ b/tests/runtime.test.mjs[m
[36m@@ -136,7 +136,7 @@[m [mtest("setup reports not ready when app-server config read fails", () => {[m
   assert.match(payload.auth.detail, /config\/read failed for cwd/);[m
 });[m
 [m
[31m-test("review renders a no-findings result from app-server review/start", () => {[m
[32m+[m[32mtest("review renders a no-findings result from the default self-collected review path", () => {[m
   const repo = makeTempDir();[m
   const binDir = makeTempDir();[m
   installFakeCodex(binDir);[m
[36m@@ -175,6 +175,76 @@[m [mtest("task runs when the active provider does not require OpenAI login", () => {[m
   assert.match(result.stdout, /Handled the requested task/);[m
 });[m
 [m
[32m+[m[32mtest("task investigation runs read-only by default and skips the write hygiene block", () => {[m
[32m+[m[32m  const repo = makeTempDir();[m
[32m+[m[32m  const binDir = makeTempDir();[m
[32m+[m[32m  const fakeStatePath = path.join(binDir, "fake-codex-state.json");[m
[32m+[m[32m  installFakeCodex(binDir);[m
[32m+[m[32m  initGitRepo(repo);[m
[32m+[m[32m  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");[m
[32m+[m[32m  run("git", ["add", "README.md"], { cwd: repo });[m
[32m+[m[32m  run("git", ["commit", "-m", "init"], { cwd: repo });[m
[32m+[m
[32m+[m[32m  const result = run("node", [SCRIPT, "task", "investigate the flaky review regression"], {[m
[32m+[m[32m    cwd: repo,[m
[32m+[m[32m    env: buildEnv(binDir)[m
[32m+[m[32m  });[m
[32m+[m
[32m+[m[32m  assert.equal(result.status, 0, result.stderr);[m
[32m+[m[32m  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));[m
[32m+[m[32m  assert.match(fakeState.lastTurnStart.prompt, /read-only investigation mode/i);[m
[32m+[m[32m  assert.doesNotMatch(fakeState.lastTurnStart.prompt, /\[POAGENT-RESCUE-HYGIENE-2026-04-08\]/);[m
[32m+[m[32m});[m
[32m+[m
[32m+[m[32mtest("task write mode injects rescue hygiene and runtime command guidance", () => {[m
[32m+[m[32m  const repo = makeTempDir();[m
[32m+[m[32m  const binDir = makeTempDir();[m
[32m+[m[32m  const fakeStatePath = path.join(binDir, "fake-codex-state.json");[m
[32m+[m[32m  installFakeCodex(binDir);[m
[32m+[m[32m  initGitRepo(repo);[m
[32m+[m[32m  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");[m
[32m+[m[32m  run("git", ["add", "README.md"], { cwd: repo });[m
[32m+[m[32m  run("git", ["commit", "-m", "init"], { cwd: repo });[m
[32m+[m
[32m+[m[32m  const result = run("node", [SCRIPT, "task", "--write", "fix the shell command usage"], {[m
[32m+[m[32m    cwd: repo,[m
[32m+[m[32m    env: buildEnv(binDir)[m
[32m+[m[32m  });[m
[32m+[m
[32m+[m[32m  assert.equal(result.status, 0, result.stderr);[m
[32m+[m[32m  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));[m
[32m+[m[32m  assert.match(fakeState.lastTurnStart.prompt, /\[POAGENT-RESCUE-HYGIENE-2026-04-08\]/);[m
[32m+[m[32m  assert.match(fakeState.lastTurnStart.prompt, /Runtime command guidance/);[m
[32m+[m[32m  assert.match(fakeState.lastTurnStart.prompt, /If shell commands fail under the sandbox, report that clearly/i);[m
[32m+[m[32m  if (process.platform === "win32") {[m
[32m+[m[32m    assert.match(fakeState.lastTurnStart.prompt, /This runtime is on Windows\./);[m
[32m+[m[32m    assert.match(fakeState.lastTurnStart.prompt, /Prefer `rg`, `git grep`, or PowerShell-native reads\/searches over plain `grep`\./);[m
[32m+[m[32m  } else {[m
[32m+[m[32m    assert.match(fakeState.lastTurnStart.prompt, /Prefer `rg` or `git grep` over broad recursive shell search when possible\./);[m
[32m+[m[32m  }[m
[32m+[m[32m});[m
[32m+[m
[32m+[m[32mtest("task surfaces plugin diagnostics for MCP and command failures", () => {[m
[32m+[m[32m  const repo = makeTempDir();[m
[32m+[m[32m  const binDir = makeTempDir();[m
[32m+[m[32m  installFakeCodex(binDir, "task-runtime-failures");[m
[32m+[m[32m  initGitRepo(repo);[m
[32m+[m[32m  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");[m
[32m+[m[32m  run("git", ["add", "README.md"], { cwd: repo });[m
[32m+[m[32m  run("git", ["commit", "-m", "init"], { cwd: repo });[m
[32m+[m
[32m+[m[32m  const result = run("node", [SCRIPT, "task", "investigate the failing rescue run"], {[m
[32m+[m[32m    cwd: repo,[m
[32m+[m[32m    env: buildEnv(binDir)[m
[32m+[m[32m  });[m
[32m+[m
[32m+[m[32m  assert.equal(result.status, 0, result.stderr);[m
[32m+[m[32m  assert.match(result.stdout, /\[PLUGIN-DIAGNOSTICS\]/);[m
[32m+[m[32m  assert.match(result.stdout, /Sandbox: read-only/);[m
[32m+[m[32m  assert.match(result.stdout, /MCP tool failures: code-review-graph\/get_minimal_context_tool \(failed\)/);[m
[32m+[m[32m  assert.match(result.stdout, /Command failures: git show HEAD~1 \(failed, exit 1\)/);[m
[32m+[m[32m});[m
[32m+[m
 test("task runs without auth preflight so Codex can refresh an expired session", () => {[m
   const repo = makeTempDir();[m
   const binDir = makeTempDir();[m
[36m@@ -211,7 +281,7 @@[m [mtest("task reports the actual Codex auth error when the run is rejected", () =>[m
   assert.match(result.stderr, /authentication expired; run codex login/);[m
 });[m
 [m
[31m-test("review accepts the quoted raw argument style for built-in base-branch review", () => {[m
[32m+[m[32mtest("review accepts the quoted raw argument style for standard base-branch review", () => {[m
   const repo = makeTempDir();[m
   const binDir = makeTempDir();[m
   installFakeCodex(binDir);[m
[36m@@ -320,6 +390,28 @@[m [mtest("review includes reasoning output when the app server returns it", () => {[m
   assert.match(result.stdout, /Reviewed the changed files and checked the likely regression paths first|Reviewed the changed files and checked the likely regression paths/i);[m
 });[m
 [m
[32m+[m[32mtest("review retries without MCP tools when the graph path crashes the turn", () => {[m
[32m+[m[32m  const repo = makeTempDir();[m
[32m+[m[32m  const binDir = makeTempDir();[m
[32m+[m[32m  const fakeStatePath = path.join(binDir, "fake-codex-state.json");[m
[32m+[m[32m  installFakeCodex(binDir, "review-fallback-after-mcp-crash");[m
[32m+[m[32m  initGitRepo(repo);[m
[32m+[m[32m  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");[m
[32m+[m[32m  run("git", ["add", "README.md"], { cwd: repo });[m
[32m+[m[32m  run("git", ["commit", "-m", "init"], { cwd: repo });[m
[32m+[m[32m  fs.writeFileSync(path.join(r