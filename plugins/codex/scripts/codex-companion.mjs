#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { parseExpectFiles, decideTaskExit } from "./lib/expect-files.mjs";
import os from "node:os";
import {
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    getCodexExecAvailability,
    getCodexAuthStatus,
    getCodexAvailability,
    getSessionRuntimeStatus,
    interruptAppServerTurn,
    parseStructuredOutput,
    readOutputSchema,
    runCodexExecTask
  } from "./lib/codex.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const TASK_IDLE_TIMEOUT_MS = readPositiveEnvInt("CODEX_TASK_IDLE_TIMEOUT_MS", 300000);
const MAX_CODEX_EXEC_PROMPT_CHARS = readPositiveEnvInt("CODEX_MAX_PROMPT_CHARS", 900000);
const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const REASONING_EFFORT_ALIASES = new Map([["minimal", "low"]]);
const MODEL_ALIASES = new Map([["spark", "gpt-5.3-codex-spark"]]);
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

// LOCAL PATCH (2026-04-08): rescue-hygiene prepend to prevent the heredoc write-trap
// pattern observed in the PM#674 test-agent incident. When POAgent spawns codex-rescue
// to produce a report, review, or analysis, the external Codex runtime inherits no
// context about POAgent's persistence protocol. If Codex tries to persist a multi-
// paragraph artifact via Bash heredocs on Windows Git Bash (or PowerShell with escape-
// heavy content), it can fall into the same shell-quoting escalation loop that test-
// agent hit on 2026-04-08. This patch unconditionally prepends a small protocol block
// to every forwarded task prompt so the Codex runtime sees the guidance even when
// POAgent forgets to include it in the spawn prompt.
//
// Full incident analysis:
//   E:\OneDrive\Grimoire\GrimoireProductOwner\docs\ops\reviews\heredoc-write-trap-analysis_2026-04-08.md
// Codex's independent verdict:
//   C:\Users\meiyo\codex_verdict_heredoc_write_trap_2026-04-08.md
//
// The helper is idempotent: if the marker is already in the prompt (because POAgent
// or the caller already prepended it), the prompt is returned unchanged. That means
// it's safe to apply at multiple layers without double-prepending.
const POAGENT_RESCUE_HYGIENE_MARKER = "[POAGENT-RESCUE-HYGIENE-2026-04-08]";
const POAGENT_RESCUE_HYGIENE_BLOCK = `${POAGENT_RESCUE_HYGIENE_MARKER}
You are being invoked from the GrimoireScribe / GrimoireProductOwner project context.
POAgent is the Product Owner agent for this project and is likely the caller.

## Rescue-hygiene protocol (read before starting work)

1. **Inline-return for reports**: if your task is to produce a review, analysis,
   verification report, or any multi-paragraph artifact, return the full artifact
   inline in your final response as a fenced markdown block. Do NOT attempt to
   persist a multi-paragraph markdown artifact directly via Bash heredocs, printf,
   python -c, cat > file << EOF, or similar shell-mediated approaches. Those paths
   are fragile on Windows + Git Bash / PowerShell when content is quote-heavy,
   contains markdown tables, code fences, or mixed quotes. POAgent has its own
   Edit tool and will persist your returned artifact to the correct file.

2. **Stop-rule for repeated shell failures**: if any bash command to persist text
   fails twice with the same quoting or parse error class (e.g. "unexpected EOF
   while looking for matching '", SyntaxError from an embedded interpreter,
   command-not-found from heredoc leakage, Python helper failing to find a
   /tmp script that printf wrote), STOP. Do not attempt a third shell variation.
   Do not escalate to chr(39)/chr(10) workarounds, nested heredocs, or Python-
   inside-Bash-inside-Python. Switch to inline return and let the caller persist.

3. **Writable clone vs review clone**: writable work happens at
   E:\\OneDrive\\Grimoire\\GrimoireScribe. Read-only review work happens at
   E:\\OneDrive\\Grimoire\\GrimoireScribe-review (3-layer push protection:
   DISABLED URL, per-clone sshCommand with readonly key, GitHub deploy key
   marked read-only server-side). Use the review clone for any review/inspection
   task. Never attempt to push from the review clone.

4. **PM tracker is the source of truth**: feature state lives at
   https://grimoirescribe.com/api/pm/data (not GitHub Issues, not local files).
   PM_API_KEY is in the project .env.

This protocol exists because of the 2026-04-08 incident where a test-agent
subagent burned 37 tool calls trying to persist a multi-paragraph Test Report
through Bash heredocs + Python helpers and ultimately had to be stopped and
have its report reconstructed from the transcript. Full analysis at:
E:\\OneDrive\\Grimoire\\GrimoireProductOwner\\docs\\ops\\reviews\\heredoc-write-trap-analysis_2026-04-08.md

After reading this block, proceed with the user's actual request below.

---

`;

// ---------------------------------------------------------------------------
// Companion-layer output persistence
// Mirrors the same mechanism in the Gemini companion. When Codex exhausts its
// context window before it can emit the shell_command write call, it exits 0
// with the review text in its final message but nothing on disk. These helpers
// let the companion do the write in Node.js instead, using the `save to <path>`
// instruction parsed directly from the task prompt.
// ---------------------------------------------------------------------------

function trimSavePathCandidate(candidate) {
  return String(candidate ?? "")
    .trim()
    .replace(/^[`"']+|[`"']+$/g, "")
    .replace(/[.,;:!?]+$/g, "")
    .trim();
}

function extractFileLikeSavePath(candidate) {
  const match = String(candidate ?? "").match(
    /^(?<path>[\s\S]*\.[A-Za-z0-9]{1,8})(?=[.,;:!?]?(?:\s|$))/
  );
  return trimSavePathCandidate(match?.groups?.path ?? "");
}

function normalizePathForComparison(candidate, cwd = process.cwd()) {
  const text = String(candidate ?? "").trim();
  if (!text) return null;
  const resolved = path.isAbsolute(text) ? path.resolve(text) : path.resolve(cwd, text);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function normalizeRequestedSavePath(candidate) {
  if (process.platform !== "win32") {
    return path.resolve(candidate);
  }
  const normalized = String(candidate ?? "").trim().replace(/\\/g, "/");
  if (!normalized.startsWith("/")) {
    return path.resolve(candidate);
  }
  if (normalized === "/tmp" || normalized.startsWith("/tmp/")) {
    const relativePath = normalized.slice("/tmp".length).replace(/^\/+/, "");
    return path.resolve(os.tmpdir(), relativePath);
  }
  const homeMatch = normalized.match(/^\/home\/([^/]+)(?:\/(.*))?$/);
  if (homeMatch) {
    const [, user, tail = ""] = homeMatch;
    const profileDir = process.env.USERPROFILE ?? "";
    const expectedUser =
      path.basename(profileDir) || process.env.USERNAME || process.env.USER || "";
    if (profileDir && expectedUser && user.toLowerCase() === expectedUser.toLowerCase()) {
      return path.resolve(profileDir, tail.replace(/\//g, path.sep));
    }
  }
  const cygdriveMatch = normalized.match(/^\/cygdrive\/([a-zA-Z])(?:\/(.*))?$/);
  if (cygdriveMatch) {
    const [, drive, tail = ""] = cygdriveMatch;
    return path.resolve(`${drive.toUpperCase()}:\\${tail.replace(/\//g, "\\")}`);
  }
  const rootDriveMatch = normalized.match(/^\/([a-zA-Z])(?:\/(.*))?$/);
  if (rootDriveMatch) {
    const [, drive, tail = ""] = rootDriveMatch;
    return path.resolve(`${drive.toUpperCase()}:\\${tail.replace(/\//g, "\\")}`);
  }
  return path.resolve(candidate);
}

function refineRequestedSavePath(candidate) {
  const rawCandidate = trimSavePathCandidate(candidate);
  if (!rawCandidate) return null;
  let current = rawCandidate;
  while (current) {
    const trimmed = trimSavePathCandidate(current);
    if (trimmed) {
      const fileLike = extractFileLikeSavePath(trimmed);
      if (fileLike) return normalizeRequestedSavePath(fileLike);
      const resolved = normalizeRequestedSavePath(trimmed);
      try {
        if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
      } catch { /* fall through */ }
      const parentDir = path.dirname(resolved);
      if (parentDir && fs.existsSync(parentDir)) return resolved;
    }
    const nextBoundary = current.lastIndexOf(" ");
    if (nextBoundary === -1) break;
    current = current.slice(0, nextBoundary).trimEnd();
  }
  return normalizeRequestedSavePath(rawCandidate);
}

function extractRequestedSavePath(prompt) {
  const text = String(prompt ?? "");
  if (!text.trim()) return null;
  const patterns = [
    /save\b[\s\S]{0,300}?\bto\s+[`"'](?<path>(?:[A-Za-z]:[\\/]|\/)[^`"']+)[`"']/i,
    /save[- ]output\b[\s\S]{0,120}?[`"'](?<path>(?:[A-Za-z]:[\\/]|\/)[^`"']+)[`"']/i,
    /\b(?:save|write)\b[\s\S]{0,300}?[`"'](?<path>(?:[A-Za-z]:[\\/]|\/tmp\/|\/cygdrive\/[A-Za-z]\/|\/[A-Za-z]\/|\/home\/)[^`"']+)[`"']/i,
    /save\b[\s\S]{0,300}?\bto\s+(?<path>(?:[A-Za-z]:[\\/]|\/)[^\r\n`"')\]]+)/i,
    /save[- ]output\b[\s\S]{0,120}?(?<path>(?:[A-Za-z]:[\\/]|\/)[^\r\n`"')\]]+)/i,
    /\b(?:save|write)\b[\s\S]{0,300}?(?<path>(?:[A-Za-z]:[\\/]|\/tmp\/|\/cygdrive\/[A-Za-z]\/|\/[A-Za-z]\/|\/home\/)[^\r\n`"')\]]+)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const candidate = match?.groups?.path?.trim();
    if (candidate) return refineRequestedSavePath(candidate);
  }
  return null;
}

function persistTaskOutput(savePath, rawOutput) {
  if (!savePath) return null;
  try {
    fs.mkdirSync(path.dirname(savePath), { recursive: true });
    fs.writeFileSync(savePath, rawOutput, "utf8");
    return {
      ok: true,
      path: savePath,
      message: `[PLUGIN-WRITE] Saved Codex output to: ${savePath}`
    };
  } catch (error) {
    return {
      ok: false,
      path: savePath,
      message: `[PLUGIN-WRITE FAIL] Could not save Codex output to ${savePath}: ${error.message}`
    };
  }
}

function maybePersistTaskOutput({ allowWrite = false, rawOutput = "", savePath = null, savePathAlreadyTouched = false } = {}) {
  if (!savePath || !rawOutput || !allowWrite) return null;
  if (savePathAlreadyTouched) return null;
  return persistTaskOutput(savePath, rawOutput);
}

// ---------------------------------------------------------------------------

function readPositiveEnvInt(name, fallback) {
  const raw = process.env[name];
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function injectRescueHygiene(prompt) {
  if (typeof prompt !== "string" || !prompt.trim()) return prompt;
  if (prompt.includes(POAGENT_RESCUE_HYGIENE_MARKER)) return prompt;
  return POAGENT_RESCUE_HYGIENE_BLOCK + prompt;
}

function buildPlatformCommandGuidance(platform = process.platform) {
  const lines = [
    "If shell commands fail under the sandbox, report that clearly instead of presenting an unverified clean result."
  ];
  if (platform === "win32") {
    lines.push("This runtime is on Windows.");
    lines.push("Prefer `rg`, `git grep`, or PowerShell-native reads/searches over plain `grep`.");
  } else {
    lines.push("Prefer `rg` or `git grep` over broad recursive shell search when possible.");
  }
  lines.push("For repository history or diff inspection, prefer `git` subcommands.");
  return lines;
}

function buildReadOnlyInvestigationPrompt(prompt) {
  const taskText = String(prompt ?? "").trim();
  if (!taskText) {
    return taskText;
  }
  return [
    "You are running in read-only investigation mode.",
    "Do not edit files, apply patches, or attempt persistence unless the user explicitly asks for changes.",
    ...buildPlatformCommandGuidance(),
    "",
    taskText
  ].join("\n");
}

function buildWriteTaskPrompt(prompt) {
  const taskText = injectRescueHygiene(prompt);
  if (typeof taskText !== "string" || !taskText.trim()) {
    return taskText;
  }
  return [
    taskText.trimEnd(),
    "",
    "## Runtime command guidance",
    ...buildPlatformCommandGuidance(),
    "",
    "Apply the user's request with those platform constraints in mind."
  ].join("\n");
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/codex-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/codex-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/codex-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/codex-companion.mjs task [--background] [--write] [--resume-last|--resume|--fresh] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [--expect-file <path[,path...]>] [prompt]",
      "  node scripts/codex-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/codex-companion.mjs result [job-id] [--json]",
      "  node scripts/codex-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: none, minimal, low, medium, high, xhigh.`
    );
  }
  return REASONING_EFFORT_ALIASES.get(normalized) ?? normalized;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function collectRepeatedValueOption(argv, key) {
  const normalized = normalizeArgv(argv);
  const longForm = `--${key}`;
  const longFormPrefix = `--${key}=`;
  const values = [];
  const rest = [];
  for (let i = 0; i < normalized.length; i += 1) {
    const token = normalized[i];
    if (token === longForm) {
      const next = normalized[i + 1];
      if (next === undefined) throw new Error(`Missing value for ${longForm}`);
      values.push(next);
      i += 1;
      continue;
    }
    if (typeof token === "string" && token.startsWith(longFormPrefix)) {
      values.push(token.slice(longFormPrefix.length));
      continue;
    }
    rest.push(token);
  }
  return { argv: rest, values };
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], {
    cwd,
    shell: process.platform === "win32"
  });
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = await getCodexAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push("Run `!codex login`.");
    nextSteps.push("If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/codex:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function buildMcpReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "review-mcp");
  return interpolateTemplate(template, {
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function buildFallbackFocusText(focusText, reason) {
  const normalizedFocus = focusText?.trim() ? focusText.trim() : "No extra focus provided.";
  return [`Native built-in review became unavailable: ${reason}`, normalizedFocus].join("\n\n");
}

function ensureCodexAvailable(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }
}

function ensureCodexTaskAvailable(cwd) {
  const availability = getCodexExecAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required exec runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }
}

function validateNativeReviewRequest(target, focusText) {
  if (focusText.trim()) {
    throw new Error(
      `\`/codex:review\` is the standard review path and does not support custom focus text. Retry with \`/codex:adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /codex:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  if (sessionId) {
    return null;
  }

  return findLatestTaskThread(workspaceRoot);
}

async function executeReviewRun(request) {
  ensureCodexTaskAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  let context = collectReviewContext(request.cwd, target);
  let prompt =
    reviewName === "Review" || reviewName === "MCP Review"
      ? buildMcpReviewPrompt(context, focusText)
      : buildAdversarialReviewPrompt(context, focusText);

  if (prompt.length > MAX_CODEX_EXEC_PROMPT_CHARS && context.inputMode !== "self-collect") {
    request.onProgress?.(
      `Review context is too large for one Codex exec prompt (${prompt.length} chars). Retrying with lightweight self-collected context.`
    );
    context = collectReviewContext(request.cwd, target, {
      includeDiff: false,
      includeUntrackedContents: false
    });
    prompt =
      reviewName === "Review" || reviewName === "MCP Review"
        ? buildMcpReviewPrompt(context, focusText)
        : buildAdversarialReviewPrompt(context, focusText);
  }
  const result = await runCodexExecTask(context.repoRoot, {
    prompt,
    model: request.model,
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    onProgress: request.onProgress,
    idleTimeoutMs: TASK_IDLE_TIMEOUT_MS
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    codex: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary,
      mcpToolFailures: result.mcpToolFailures ?? [],
      commandFailures: result.commandFailures ?? []
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Codex ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}


async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureCodexTaskAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast
  });

  let resumeThreadId = null;
  if (request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Codex task thread was found for this repository.");
    }
    resumeThreadId = latestThread.id;
  }

  if (!request.prompt && !resumeThreadId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  // LOCAL PATCH (2026-04-08): inject POAgent rescue-hygiene block into every task
  // prompt. Idempotent — no-op if the marker is already present. See helper
  // definition near top of file for full rationale.
  const taskPrompt = request.write
    ? buildWriteTaskPrompt(request.prompt)
    : buildReadOnlyInvestigationPrompt(request.prompt);

  const result = await runCodexExecTask(workspaceRoot, {
    resumeThreadId,
    prompt: taskPrompt || (resumeThreadId ? DEFAULT_CONTINUE_PROMPT : ""),
    model: request.model,
    effort: request.effort,
    onProgress: request.onProgress,
    idleTimeoutMs: TASK_IDLE_TIMEOUT_MS
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";

  // Companion-layer output persistence: if the prompt contained a "save to <path>"
  // instruction and Codex returned output but didn't write the file itself (context
  // exhaustion is the main cause), the companion writes it here in Node.js.
  const touchedFiles = [
    ...new Set((Array.isArray(result.touchedFiles) ? result.touchedFiles : []).map(String))
  ];
  const requestedSavePath = extractRequestedSavePath(request.prompt);
  const requestedSavePathKey = normalizePathForComparison(requestedSavePath);
  const savePathAlreadyTouched = requestedSavePathKey
    ? touchedFiles.some(
        (f) => normalizePathForComparison(f, workspaceRoot) === requestedSavePathKey
      )
    : false;
  const saveOutput = maybePersistTaskOutput({
    allowWrite: Boolean(request.write),
    rawOutput,
    savePath: requestedSavePath,
    savePathAlreadyTouched
  });
  if (saveOutput?.ok && saveOutput.path) {
    touchedFiles.push(saveOutput.path);
  }
  const normalizedTouchedFiles = [...new Set(touchedFiles)];

  // Ground-truth verification: Codex self-reports are unreliable. If the caller
  // declared expected deliverable paths, the filesystem is authoritative.
  // If the companion write succeeded, treat the save path as present for exit
  // decision purposes (avoids double-fail when Codex ran out of context but
  // the companion rescued the output).
  const codexExit = typeof result.status === "number" ? result.status : (result.status ? 1 : 0);
  const effectiveCodExExit = saveOutput?.ok && rawOutput.trim() ? 0 : codexExit;
  const decision = decideTaskExit(effectiveCodExExit, request.expectFiles ?? []);
  const exitStatus = decision.exitStatus;
  const verificationMessage = decision.verificationMessage;
  const expected = decision.expected;

  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      saveOutput,
      reasoningSummary: result.reasoningSummary
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: Boolean(request.write),
      sandboxMode: request.write ? "workspace-write" : "read-only",
      commandFailures: result.commandFailures ?? [],
      mcpToolFailures: result.mcpToolFailures ?? [],
      dynamicToolFailures: result.dynamicToolFailures ?? [],
      expectedFiles: expected.checked,
      verificationMessage
    }
  );
  const payload = {
    status: exitStatus,
    codexExitStatus: codexExit,
    threadId: result.threadId,
    rawOutput,
    touchedFiles: normalizedTouchedFiles,
    saveOutput,
    reasoningSummary: result.reasoningSummary,
    sandboxMode: request.write ? "workspace-write" : "read-only",
    commandFailures: result.commandFailures ?? [],
    mcpToolFailures: result.mcpToolFailures ?? [],
    dynamicToolFailures: result.dynamicToolFailures ?? [],
    expectedFiles: expected.checked,
    verificationMessage: verificationMessage || null
  };

  return {
    exitStatus,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Adversarial Review" ? `Codex ${reviewName}` : "Codex Review",
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Codex Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  const title = resumeLast ? "Codex Resume" : "Codex Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /codex:status ${payload.jobId} for progress.\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function buildTaskRequest({ cwd, model, effort, prompt, write, resumeLast, jobId, expectFiles }) {
  return {
    cwd,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    jobId,
    expectFiles: Array.isArray(expectFiles) ? expectFiles.slice() : []
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "codex-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const child = spawnDetachedTaskWorker(cwd, job.id);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  config.validateRequest?.(target, focusText);
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model: options.model,
        focusText,
        reviewName: config.reviewName,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

async function handleTask(argv) {
  const { argv: strippedArgv, values: rawExpectFiles } = collectRepeatedValueOption(argv, "expect-file");
  const { options, positionals } = parseCommandInput(strippedArgv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const prompt = readTaskPrompt(cwd, options, positionals);
  const expectFiles = parseExpectFiles(rawExpectFiles, cwd);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = Boolean(options.write);
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast
  });

  if (options.background) {
    ensureCodexTaskAvailable(cwd);
    requireTaskRequest(prompt, resumeLast);

    const job = buildTaskJob(workspaceRoot, taskMetadata, write);
    const request = buildTaskRequest({
      cwd,
      model,
      effort,
      prompt,
      write,
      resumeLast,
      jobId: job.id,
      expectFiles
    });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        effort,
        prompt,
        write,
        resumeLast,
        jobId: job.id,
        expectFiles,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () =>
      executeTaskRun({
        ...request,
        onProgress: progress
      }),
    { logFile }
  );
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const threadId = existing.threadId ?? job.threadId ?? null;
  const turnId = existing.turnId ?? job.turnId ?? null;

  const interrupt = await interruptAppServerTurn(cwd, { threadId, turnId });
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested Codex turn interrupt for ${turnId} on ${threadId}.`
        : `Codex turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
    );
  }

  terminateProcessTree(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
