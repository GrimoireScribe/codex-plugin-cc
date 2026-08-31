/**
 * @typedef {import("./app-server-protocol").AppServerNotification} AppServerNotification
 * @typedef {import("./app-server-protocol").ReviewTarget} ReviewTarget
 * @typedef {import("./app-server-protocol").ThreadItem} ThreadItem
 * @typedef {import("./app-server-protocol").ThreadResumeParams} ThreadResumeParams
 * @typedef {import("./app-server-protocol").ThreadStartParams} ThreadStartParams
 * @typedef {import("./app-server-protocol").Turn} Turn
 * @typedef {import("./app-server-protocol").UserInput} UserInput
 * @typedef {((update: string | { message: string, phase: string | null, threadId?: string | null, turnId?: string | null, stderrMessage?: string | null, logTitle?: string | null, logBody?: string | null }) => void)} ProgressReporter
 * @typedef {{
 *   threadId: string,
 *   rootThreadId: string,
 *   threadIds: Set<string>,
 *   threadTurnIds: Map<string, string>,
 *   threadLabels: Map<string, string>,
 *   turnId: string | null,
 *   bufferedNotifications: AppServerNotification[],
 *   completion: Promise<TurnCaptureState>,
 *   resolveCompletion: (state: TurnCaptureState) => void,
 *   rejectCompletion: (error: unknown) => void,
 *   finalTurn: Turn | null,
 *   completed: boolean,
 *   finalAnswerSeen: boolean,
 *   pendingCollaborations: Set<string>,
 *   activeSubagentTurns: Set<string>,
 *   completionTimer: ReturnType<typeof setTimeout> | null,
 *   idleTimer: ReturnType<typeof setTimeout> | null,
 *   idleTimeoutMs: number | null,
 *   lastAgentMessage: string,
 *   reviewText: string,
 *   reasoningSummary: string[],
 *   error: unknown,
 *   messages: Array<{ lifecycle: string, phase: string | null, text: string }>,
 *   fileChanges: ThreadItem[],
 *   commandExecutions: ThreadItem[],
 *   mcpToolCalls: ThreadItem[],
 *   dynamicToolCalls: ThreadItem[],
 *   onProgress: ProgressReporter | null
 * }} TurnCaptureState
 */
import { readJsonFile } from "./fs.mjs";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BROKER_BUSY_RPC_CODE, BROKER_ENDPOINT_ENV, CodexAppServerClient } from "./app-server.mjs";
import { loadBrokerSession } from "./broker-lifecycle.mjs";
import { binaryAvailable, terminateProcessTree, quoteShellArg } from "./process.mjs";

const SERVICE_NAME = "claude_code_codex_plugin";
const TASK_THREAD_PREFIX = "Codex Companion Task";
const EXTERNAL_AGENT_IMPORT_COMPLETED = "externalAgentConfig/import/completed";
const EXTERNAL_AGENT_IMPORT_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";

// Track live temp files so we can clean them up on abnormal exit. The per-run
// finally-block cleanup handles the normal path; this set + process.on("exit")
// handler catches leaks when an uncaught exception or signal kills the process
// before the promise chain settles.
const LIVE_TEMP_FILES = new Set();
let EXIT_CLEANUP_REGISTERED = false;

function registerExitCleanup() {
  if (EXIT_CLEANUP_REGISTERED) return;
  EXIT_CLEANUP_REGISTERED = true;
  process.on("exit", () => {
    for (const filePath of LIVE_TEMP_FILES) {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch { /* best effort */ }
    }
    LIVE_TEMP_FILES.clear();
  });
}

function buildExecTempPath(kind) {
  registerExitCleanup();
  const p = path.join(os.tmpdir(), `codex-companion-${kind}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
  LIVE_TEMP_FILES.add(p);
  return p;
}

function releaseTempPath(filePath) {
  if (filePath) LIVE_TEMP_FILES.delete(filePath);
}

function pushExecConfig(args, key, value) {
  args.push("-c", `${key}=${JSON.stringify(value)}`);
}

function normalizeExecItemType(type) {
  return String(type ?? "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
}

function parseExecEvent(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function collectExecFailure(toolCalls, formatter) {
  return (toolCalls ?? [])
    .filter((item) => String(item?.status ?? "").trim().toLowerCase() === "failed")
    .map((item) => ({
      label: formatter(item),
      status: item.status
    }));
}

function writeTempJsonFile(prefix, value) {
  const filePath = buildExecTempPath(prefix);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}

function resolveCodexSpawnTarget(env = process.env) {
  if (process.platform !== "win32") {
    return { command: "codex", shell: false, preArgs: [] };
  }

  const windowsPath = env.PATH ?? env.Path ?? env.path ?? "";
  const pathEntries = String(windowsPath)
    .split(path.delimiter)
    .filter(Boolean);

  for (const entry of pathEntries) {
    const cmdPath = path.join(entry, "codex.cmd");
    if (fs.existsSync(cmdPath)) {
      const baseDir = path.dirname(cmdPath);
      const jsEntry = path.join(baseDir, "node_modules", "@openai", "codex", "bin", "codex.js");
      if (fs.existsSync(jsEntry)) {
        const bundledNode = path.join(baseDir, "node.exe");
        return {
          command: fs.existsSync(bundledNode) ? bundledNode : process.execPath,
          shell: false,
          preArgs: [jsEntry]
        };
      }
    }

    const barePath = path.join(entry, "codex");
    if (fs.existsSync(barePath)) {
      return {
        command: process.execPath,
        shell: false,
        preArgs: [barePath]
      };
    }
  }

  const whereResult = spawnSync("where.exe", ["codex"], {
    env,
    encoding: "utf8",
    windowsHide: true
  });
  const discoveredEntries =
    whereResult.status === 0
      ? String(whereResult.stdout ?? "")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
      : [];

  for (const discoveredPath of discoveredEntries) {
    if (/codex\.cmd$/i.test(discoveredPath)) {
      const baseDir = path.dirname(discoveredPath);
      const jsEntry = path.join(baseDir, "node_modules", "@openai", "codex", "bin", "codex.js");
      if (fs.existsSync(jsEntry)) {
        const bundledNode = path.join(baseDir, "node.exe");
        return {
          command: fs.existsSync(bundledNode) ? bundledNode : process.execPath,
          shell: false,
          preArgs: [jsEntry]
        };
      }
    }
    if (/([\\\/]|^)codex$/i.test(discoveredPath) && fs.existsSync(discoveredPath)) {
      return {
        command: process.execPath,
        shell: false,
        preArgs: [discoveredPath]
      };
    }
  }

  const appData = env.APPDATA ?? process.env.APPDATA ?? null;
  if (appData) {
    const npmDir = path.join(appData, "npm");
    const cmdPath = path.join(npmDir, "codex.cmd");
    const jsEntry = path.join(npmDir, "node_modules", "@openai", "codex", "bin", "codex.js");
    if (fs.existsSync(cmdPath) && fs.existsSync(jsEntry)) {
      const bundledNode = path.join(npmDir, "node.exe");
      return {
        command: fs.existsSync(bundledNode) ? bundledNode : process.execPath,
        shell: false,
        preArgs: [jsEntry]
      };
    }
  }

  return { command: "codex", shell: true, preArgs: [] };
}

function cleanCodexStderr(stderr) {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith("WARNING: proceeding, even though we could not update PATH:"))
    .filter((line) => !/CreateProcess(?:WithLogonW?|W)\b/.test(line))
    .filter((line) => !/sandbox.*(?:denied|failed|blocked)|(?:denied|failed|blocked).*sandbox/i.test(line))
    .join("\n");
}

/** @returns {ThreadStartParams} */
function buildThreadParams(cwd, options = {}) {
  return {
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: options.sandbox ?? "read-only",
    serviceName: SERVICE_NAME,
    ephemeral: options.ephemeral ?? true
  };
}

/** @returns {ThreadResumeParams} */
function buildResumeParams(threadId, cwd, options = {}) {
  return {
    threadId,
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: options.sandbox ?? "read-only"
  };
}

/** @returns {UserInput[]} */
function buildTurnInput(prompt) {
  return [{ type: "text", text: prompt, text_elements: [] }];
}

function shorten(text, limit = 72) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function looksLikeVerificationCommand(command) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    command
  );
}

function buildTaskThreadName(prompt) {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${TASK_THREAD_PREFIX}: ${excerpt}` : TASK_THREAD_PREFIX;
}

function extractThreadId(message) {
  return message?.params?.threadId ?? null;
}

function extractTurnId(message) {
  if (message?.params?.turnId) {
    return message.params.turnId;
  }
  if (message?.params?.turn?.id) {
    return message.params.turn.id;
  }
  return null;
}

function collectTouchedFiles(fileChanges) {
  const paths = new Set();
  for (const fileChange of fileChanges) {
    for (const change of fileChange.changes ?? []) {
      if (change.path) {
        paths.add(change.path);
      }
    }
  }
  return [...paths];
}

function normalizeReasoningText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function extractReasoningSections(value) {
  if (!value) {
    return [];
  }

  if (typeof value === "string") {
    const normalized = normalizeReasoningText(value);
    return normalized ? [normalized] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractReasoningSections(entry));
  }

  if (typeof value === "object") {
    if (typeof value.text === "string") {
      return extractReasoningSections(value.text);
    }
    if ("summary" in value) {
      return extractReasoningSections(value.summary);
    }
    if ("content" in value) {
      return extractReasoningSections(value.content);
    }
    if ("parts" in value) {
      return extractReasoningSections(value.parts);
    }
  }

  return [];
}

function mergeReasoningSections(existingSections, nextSections) {
  const merged = [];
  for (const section of [...existingSections, ...nextSections]) {
    const normalized = normalizeReasoningText(section);
    if (!normalized || merged.includes(normalized)) {
      continue;
    }
    merged.push(normalized);
  }
  return merged;
}

/**
 * @param {ProgressReporter | null | undefined} onProgress
 * @param {string | null | undefined} message
 * @param {string | null | undefined} [phase]
 */
function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

function emitLogEvent(onProgress, options = {}) {
  if (!onProgress) {
    return;
  }

  onProgress({
    message: options.message ?? "",
    phase: options.phase ?? null,
    stderrMessage: options.stderrMessage ?? null,
    logTitle: options.logTitle ?? null,
    logBody: options.logBody ?? null
  });
}

function labelForThread(state, threadId) {
  if (!threadId || threadId === state.rootThreadId || threadId === state.threadId) {
    return null;
  }
  return state.threadLabels.get(threadId) ?? threadId;
}

function registerThread(state, threadId, options = {}) {
  if (!threadId) {
    return;
  }

  state.threadIds.add(threadId);
  const label =
    options.threadName ??
    options.name ??
    options.agentNickname ??
    options.agentRole ??
    state.threadLabels.get(threadId) ??
    null;
  if (label) {
    state.threadLabels.set(threadId, label);
  }
}

function describeStartedItem(state, item) {
  switch (item.type) {
    case "enteredReviewMode":
      return { message: `Reviewer started: ${item.review}`, phase: "reviewing" };
    case "commandExecution":
      return {
        message: `Running command: ${shorten(item.command, 96)}`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running"
      };
    case "fileChange":
      return { message: `Applying ${item.changes.length} file change(s).`, phase: "editing" };
    case "mcpToolCall":
      return { message: `Calling ${item.server}/${item.tool}.`, phase: "investigating" };
    case "dynamicToolCall":
      return { message: `Running tool: ${item.tool}.`, phase: "investigating" };
    case "collabAgentToolCall": {
      const subagents = (item.receiverThreadIds ?? []).map((threadId) => labelForThread(state, threadId) ?? threadId);
      const summary =
        subagents.length > 0
          ? `Starting subagent ${subagents.join(", ")} via collaboration tool: ${item.tool}.`
          : `Starting collaboration tool: ${item.tool}.`;
      return { message: summary, phase: "investigating" };
    }
    case "webSearch":
      return { message: `Searching: ${shorten(item.query, 96)}`, phase: "investigating" };
    default:
      return null;
  }
}

function describeCompletedItem(state, item) {
  switch (item.type) {
    case "commandExecution": {
      const exitCode = item.exitCode ?? "?";
      const statusLabel = item.status === "completed" ? "completed" : item.status;
      return {
        message: `Command ${statusLabel}: ${shorten(item.command, 96)} (exit ${exitCode})`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running"
      };
    }
    case "fileChange":
      return { message: `File changes ${item.status}.`, phase: "editing" };
    case "mcpToolCall":
      return { message: `Tool ${item.server}/${item.tool} ${item.status}.`, phase: "investigating" };
    case "dynamicToolCall":
      return { message: `Tool ${item.tool} ${item.status}.`, phase: "investigating" };
    case "collabAgentToolCall": {
      const subagents = (item.receiverThreadIds ?? []).map((threadId) => labelForThread(state, threadId) ?? threadId);
      const summary =
        subagents.length > 0
          ? `Subagent ${subagents.join(", ")} ${item.status}.`
          : `Collaboration tool ${item.tool} ${item.status}.`;
      return { message: summary, phase: "investigating" };
    }
    case "exitedReviewMode":
      return { message: "Reviewer finished.", phase: "finalizing" };
    default:
      return null;
  }
}

/** @returns {TurnCaptureState} */
function createTurnCaptureState(threadId, options = {}) {
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  return {
    threadId,
    rootThreadId: threadId,
    threadIds: new Set([threadId]),
    threadTurnIds: new Map(),
    threadLabels: new Map(),
    turnId: null,
    bufferedNotifications: [],
    completion,
    resolveCompletion,
    rejectCompletion,
    finalTurn: null,
    completed: false,
    finalAnswerSeen: false,
    pendingCollaborations: new Set(),
    activeSubagentTurns: new Set(),
    completionTimer: null,
    idleTimer: null,
    idleTimeoutMs: Number.isFinite(options.idleTimeoutMs) && options.idleTimeoutMs > 0 ? options.idleTimeoutMs : null,
    lastAgentMessage: "",
    reviewText: "",
    reasoningSummary: [],
    error: null,
    messages: [],
    fileChanges: [],
    commandExecutions: [],
    mcpToolCalls: [],
    dynamicToolCalls: [],
    onProgress: options.onProgress ?? null
  };
}

function clearCompletionTimer(state) {
  if (state.completionTimer) {
    clearTimeout(state.completionTimer);
    state.completionTimer = null;
  }
}

function clearIdleTimer(state) {
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
}

function rejectTurn(state, error) {
  if (state.completed) {
    return;
  }

  clearCompletionTimer(state);
  clearIdleTimer(state);
  state.completed = true;
  state.error = error;
  state.rejectCompletion(error);
}

function scheduleIdleTimeout(state) {
  if (state.completed || !state.idleTimeoutMs) {
    return;
  }

  clearIdleTimer(state);
  state.idleTimer = setTimeout(() => {
    state.idleTimer = null;
    rejectTurn(state, new Error(`Codex turn timed out after ${Math.ceil(state.idleTimeoutMs / 1000)}s without progress.`));
  }, state.idleTimeoutMs);
  state.idleTimer.unref?.();
}

function completeTurn(state, turn = null, options = {}) {
  if (state.completed) {
    return;
  }

  clearCompletionTimer(state);
  clearIdleTimer(state);
  state.completed = true;

  if (turn) {
    state.finalTurn = turn;
    if (!state.turnId) {
      state.turnId = turn.id;
    }
  } else if (!state.finalTurn) {
    state.finalTurn = {
      id: state.turnId ?? "inferred-turn",
      status: "completed"
    };
  }

  if (options.inferred) {
    emitProgress(state.onProgress, "Turn completion inferred after the main thread finished and subagent work drained.", "finalizing");
  }

  state.resolveCompletion(state);
}

function scheduleInferredCompletion(state) {
  if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
    return;
  }

  if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) {
    return;
  }

  clearCompletionTimer(state);
  state.completionTimer = setTimeout(() => {
    state.completionTimer = null;
    if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
      return;
    }
    if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) {
      return;
    }
    completeTurn(state, null, { inferred: true });
  }, 250);
  state.completionTimer.unref?.();
}

function belongsToTurn(state, message) {
  const messageThreadId = extractThreadId(message);
  if (!messageThreadId || !state.threadIds.has(messageThreadId)) {
    return false;
  }
  const trackedTurnId = state.threadTurnIds.get(messageThreadId) ?? null;
  const messageTurnId = extractTurnId(message);
  return trackedTurnId === null || messageTurnId === null || messageTurnId === trackedTurnId;
}

function recordItem(state, item, lifecycle, threadId = null) {
  if (item.type === "collabAgentToolCall") {
    if (!threadId || threadId === state.threadId) {
      if (lifecycle === "started" || item.status === "inProgress") {
        state.pendingCollaborations.add(item.id);
      } else if (lifecycle === "completed") {
        state.pendingCollaborations.delete(item.id);
        scheduleInferredCompletion(state);
      }
    }
    for (const receiverThreadId of item.receiverThreadIds ?? []) {
      registerThread(state, receiverThreadId);
    }
  }

  if (item.type === "agentMessage") {
    state.messages.push({
      lifecycle,
      phase: item.phase ?? null,
      text: item.text ?? ""
    });
    if (item.text) {
      if (!threadId || threadId === state.threadId) {
        state.lastAgentMessage = item.text;
        if (lifecycle === "completed" && item.phase === "final_answer") {
          state.finalAnswerSeen = true;
          scheduleInferredCompletion(state);
        }
      }
      if (lifecycle === "completed") {
        const sourceLabel = labelForThread(state, threadId);
        emitLogEvent(state.onProgress, {
          message: sourceLabel ? `Subagent ${sourceLabel}: ${shorten(item.text, 96)}` : `Assistant message captured: ${shorten(item.text, 96)}`,
          stderrMessage: null,
          phase: item.phase === "final_answer" ? "finalizing" : null,
          logTitle: sourceLabel ? `Subagent ${sourceLabel} message` : "Assistant message",
          logBody: item.text
        });
      }
    }
    return;
  }

  if (item.type === "exitedReviewMode") {
    state.reviewText = item.review ?? "";
    if (lifecycle === "completed" && item.review) {
      emitLogEvent(state.onProgress, {
        message: "Review output captured.",
        stderrMessage: null,
        phase: "finalizing",
        logTitle: "Review output",
        logBody: item.review
      });
    }
    return;
  }

  if (item.type === "reasoning" && lifecycle === "completed") {
    const nextSections = extractReasoningSections(item.summary);
    state.reasoningSummary = mergeReasoningSections(state.reasoningSummary, nextSections);
    if (nextSections.length > 0) {
      const sourceLabel = labelForThread(state, threadId);
      emitLogEvent(state.onProgress, {
        message: sourceLabel
          ? `Subagent ${sourceLabel} reasoning: ${shorten(nextSections[0], 96)}`
          : `Reasoning summary captured: ${shorten(nextSections[0], 96)}`,
        stderrMessage: null,
        logTitle: sourceLabel ? `Subagent ${sourceLabel} reasoning summary` : "Reasoning summary",
        logBody: nextSections.map((section) => `- ${section}`).join("\n")
      });
    }
    return;
  }

  if (item.type === "fileChange" && lifecycle === "completed") {
    state.fileChanges.push(item);
    return;
  }

  if (item.type === "commandExecution" && lifecycle === "completed") {
    state.commandExecutions.push(item);
    return;
  }

  if (item.type === "mcpToolCall" && lifecycle === "completed") {
    state.mcpToolCalls.push(item);
    return;
  }

  if (item.type === "dynamicToolCall" && lifecycle === "completed") {
    state.dynamicToolCalls.push(item);
  }
}

function applyTurnNotification(state, message) {
  switch (message.method) {
    case "thread/started":
      registerThread(state, message.params.thread.id, {
        threadName: message.params.thread.name,
        name: message.params.thread.name,
        agentNickname: message.params.thread.agentNickname,
        agentRole: message.params.thread.agentRole
      });
      break;
    case "thread/name/updated":
      registerThread(state, message.params.threadId, {
        threadName: message.params.threadName ?? null
      });
      break;
    case "turn/started":
      registerThread(state, message.params.threadId);
      state.threadTurnIds.set(message.params.threadId, message.params.turn.id);
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.add(message.params.threadId);
      }
      emitProgress(
        state.onProgress,
        `Turn started (${message.params.turn.id}).`,
        "starting",
        (message.params.threadId ?? null) === state.threadId
          ? {
              threadId: message.params.threadId ?? null,
              turnId: message.params.turn.id ?? null
            }
          : {}
      );
      break;
    case "item/started":
      recordItem(state, message.params.item, "started", message.params.threadId ?? null);
      {
        const update = describeStartedItem(state, message.params.item);
        emitProgress(state.onProgress, update?.message, update?.phase ?? null);
      }
      break;
    case "item/completed":
      recordItem(state, message.params.item, "completed", message.params.threadId ?? null);
      {
        const update = describeCompletedItem(state, message.params.item);
        emitProgress(state.onProgress, update?.message, update?.phase ?? null);
      }
      break;
    case "error":
      state.error = message.params.error;
      emitProgress(state.onProgress, `Codex error: ${message.params.error.message}`, "failed");
      break;
    case "turn/completed":
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.delete(message.params.threadId);
        scheduleInferredCompletion(state);
        break;
      }
      emitProgress(
        state.onProgress,
        `Turn ${message.params.turn.status === "completed" ? "completed" : message.params.turn.status}.`,
        "finalizing"
      );
      completeTurn(state, message.params.turn);
      break;
    default:
      break;
  }
}

async function captureTurn(client, threadId, startRequest, options = {}) {
  const state = createTurnCaptureState(threadId, options);
  const previousHandler = client.notificationHandler;
  const disconnectPromise = client.exitPromise.then(() => {
    const detail =
      client.exitError ??
      new Error("Codex app-server connection closed before the turn completed.");
    state.error = detail;
    throw detail;
  });
  scheduleIdleTimeout(state);

  client.setNotificationHandler((message) => {
    scheduleIdleTimeout(state);
    if (!state.turnId) {
      state.bufferedNotifications.push(message);
      return;
    }

    if (message.method === "thread/started" || message.method === "thread/name/updated") {
      applyTurnNotification(state, message);
      return;
    }

    if (!belongsToTurn(state, message)) {
        if (previousHandler) {
          previousHandler(message);
        }
        return;
    }

    applyTurnNotification(state, message);
  });

  try {
    const response = await startRequest();
    scheduleIdleTimeout(state);
    options.onResponse?.(response, state);
    state.turnId = response.turn?.id ?? null;
    if (state.turnId) {
      state.threadTurnIds.set(state.threadId, state.turnId);
    }
    for (const message of state.bufferedNotifications) {
      if (belongsToTurn(state, message)) {
        applyTurnNotification(state, message);
      } else {
        if (previousHandler) {
          previousHandler(message);
        }
      }
    }
    state.bufferedNotifications.length = 0;

    if (response.turn?.status && response.turn.status !== "inProgress") {
      completeTurn(state, response.turn);
    }

    return await Promise.race([state.completion, disconnectPromise]);
  } finally {
    clearCompletionTimer(state);
    clearIdleTimer(state);
    client.setNotificationHandler(previousHandler ?? null);
  }
}

async function withAppServer(cwd, fn) {
  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd);
    const result = await fn(client);
    await client.close();
    return result;
  } catch (error) {
    const brokerRequested = client?.transport === "broker" || Boolean(process.env[BROKER_ENDPOINT_ENV]);
    const shouldRetryDirect =
      (client?.transport === "broker" && error?.rpcCode === BROKER_BUSY_RPC_CODE) ||
      (brokerRequested && (error?.code === "ENOENT" || error?.code === "ECONNREFUSED"));

    if (client) {
      await client.close().catch(() => {});
      client = null;
    }

    if (!shouldRetryDirect) {
      throw error;
    }

    const directClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
    try {
      return await fn(directClient);
    } finally {
      await directClient.close();
    }
  }
}

async function withDirectAppServer(cwd, fn) {
  const client = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

function resolveCodexHome() {
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

function sourceContentSha256(sourcePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
}

function importedThreadIdForSource(sourcePath) {
  const ledgerPath = path.join(resolveCodexHome(), "external_agent_session_imports.json");
  if (!fs.existsSync(ledgerPath)) {
    return null;
  }
  const ledger = readJsonFile(ledgerPath);
  const canonicalSource = fs.realpathSync(sourcePath);
  const contentSha256 = sourceContentSha256(canonicalSource);
  const records = Array.isArray(ledger?.records) ? ledger.records : [];
  const match = records
    .filter(
      (record) =>
        record?.source_path === canonicalSource &&
        record?.content_sha256 === contentSha256 &&
        typeof record?.imported_thread_id === "string"
    )
    .at(-1);
  return match?.imported_thread_id ?? null;
}

function externalAgentSessionMigration(sourcePath, cwd) {
  return {
    migrationItems: [
      {
        itemType: "SESSIONS",
        description: `Transfer Claude session ${path.basename(sourcePath)}`,
        cwd: null,
        details: {
          plugins: [],
          sessions: [{ path: sourcePath, cwd, title: null }],
          mcpServers: [],
          hooks: [],
          subagents: [],
          commands: []
        }
      }
    ]
  };
}

async function requestExternalAgentSessionImport(client, params) {
  const previousHandler = client.notificationHandler;
  let timeout = null;
  let resolveCompleted;
  let rejectCompleted;
  const completed = new Promise((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  void completed.catch(() => {});

  client.setNotificationHandler((message) => {
    if (message.method === EXTERNAL_AGENT_IMPORT_COMPLETED) {
      resolveCompleted();
      return;
    }
    previousHandler?.(message);
  });
  timeout = setTimeout(() => {
    rejectCompleted(new Error("Timed out waiting for Codex to finish importing the Claude session."));
  }, EXTERNAL_AGENT_IMPORT_TIMEOUT_MS);

  try {
    await client.request("externalAgentConfig/import", params);
    await completed;
  } finally {
    clearTimeout(timeout);
    client.setNotificationHandler(previousHandler ?? null);
  }
}

async function startThread(client, cwd, options = {}) {
  const response = await client.request("thread/start", buildThreadParams(cwd, options));
  const threadId = response.thread.id;
  if (options.threadName) {
    try {
      await client.request("thread/name/set", { threadId, name: options.threadName });
    } catch (err) {
      // Only suppress "unknown variant/method" errors from older CLI versions
      // that don't support thread/name/set. Rethrow auth, network, or server errors.
      const msg = String(err?.message ?? err ?? "");
      if (!msg.includes("unknown variant") && !msg.includes("unknown method")) {
        throw err;
      }
    }
  }
  return response;
}

async function resumeThread(client, threadId, cwd, options = {}) {
  return client.request("thread/resume", buildResumeParams(threadId, cwd, options));
}

function buildResultStatus(turnState) {
  return turnState.finalTurn?.status === "completed" ? 0 : 1;
}

function normalizeItemStatus(item) {
  if (typeof item?.status === "string" && item.status.trim()) {
    return item.status.trim();
  }
  return "unknown";
}

function isFailedItemStatus(status) {
  return status !== "completed";
}

function summarizeCommandFailures(commandExecutions) {
  return (commandExecutions ?? [])
    .filter((item) => isFailedItemStatus(normalizeItemStatus(item)))
    .map((item) => ({
      command: item.command ?? "",
      status: normalizeItemStatus(item),
      exitCode: item.exitCode ?? null
    }));
}

function summarizeToolFailures(toolCalls, formatter) {
  return (toolCalls ?? [])
    .filter((item) => isFailedItemStatus(normalizeItemStatus(item)))
    .map((item) => ({
      label: formatter(item),
      status: normalizeItemStatus(item)
    }));
}

const BUILTIN_PROVIDER_LABELS = new Map([
  ["openai", "OpenAI"],
  ["ollama", "Ollama"],
  ["lmstudio", "LM Studio"]
]);

function normalizeProviderId(value) {
  const providerId = typeof value === "string" ? value.trim() : "";
  return providerId || null;
}

function formatProviderLabel(providerId, providerConfig = null) {
  const configuredName = typeof providerConfig?.name === "string" ? providerConfig.name.trim() : "";
  if (configuredName) {
    return configuredName;
  }
  if (!providerId) {
    return "The active provider";
  }
  return BUILTIN_PROVIDER_LABELS.get(providerId) ?? providerId;
}

function buildAuthStatus(fields = {}) {
  return {
    available: true,
    loggedIn: false,
    detail: "not authenticated",
    source: "unknown",
    authMethod: null,
    verified: null,
    requiresOpenaiAuth: null,
    provider: null,
    ...fields
  };
}

function resolveProviderConfig(configResponse) {
  const config = configResponse?.config;
  if (!config || typeof config !== "object") {
    return {
      providerId: null,
      providerConfig: null
    };
  }

  const providerId = normalizeProviderId(config.model_provider);
  const providers =
    config.model_providers && typeof config.model_providers === "object" && !Array.isArray(config.model_providers)
      ? config.model_providers
      : null;
  const providerConfig =
    providerId && providers?.[providerId] && typeof providers[providerId] === "object" ? providers[providerId] : null;

  return {
    providerId,
    providerConfig
  };
}

function buildAppServerAuthStatus(accountResponse, configResponse) {
  const account = accountResponse?.account ?? null;
  const requiresOpenaiAuth =
    typeof accountResponse?.requiresOpenaiAuth === "boolean" ? accountResponse.requiresOpenaiAuth : null;
  const { providerId, providerConfig } = resolveProviderConfig(configResponse);
  const providerLabel = formatProviderLabel(providerId, providerConfig);

  if (account?.type === "chatgpt") {
    const email = typeof account.email === "string" && account.email.trim() ? account.email.trim() : null;
    return buildAuthStatus({
      loggedIn: true,
      detail: email ? `ChatGPT login active for ${email}` : "ChatGPT login active",
      source: "app-server",
      authMethod: "chatgpt",
      verified: true,
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  if (account?.type === "apiKey") {
    return buildAuthStatus({
      loggedIn: true,
      detail: "API key configured (unverified)",
      source: "app-server",
      authMethod: "apiKey",
      verified: false,
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  if (requiresOpenaiAuth === false) {
    return buildAuthStatus({
      loggedIn: true,
      detail: `${providerLabel} is configured and does not require OpenAI authentication`,
      source: "app-server",
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  return buildAuthStatus({
    loggedIn: false,
    detail: `${providerLabel} requires OpenAI authentication`,
    source: "app-server",
    requiresOpenaiAuth,
    provider: providerId
  });
}

async function getCodexAuthStatusFromClient(client, cwd) {
  try {
    const accountResponse = await client.request("account/read", { refreshToken: false });
    const configResponse = await client.request("config/read", {
      includeLayers: false,
      cwd
    });

    return buildAppServerAuthStatus(accountResponse, configResponse);
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
      source: "app-server"
    });
  }
}

export function getCodexAvailability(cwd) {
  const versionStatus = binaryAvailable("codex", ["--version"], {
    cwd,
    shell: process.platform === "win32"
  });
  if (!versionStatus.available) {
    return versionStatus;
  }

  const appServerStatus = binaryAvailable("codex", ["app-server", "--help"], {
    cwd,
    shell: process.platform === "win32"
  });
  if (!appServerStatus.available) {
    return {
      available: false,
      detail: `${versionStatus.detail}; advanced runtime unavailable: ${appServerStatus.detail}`
    };
  }

  return {
    available: true,
    detail: `${versionStatus.detail}; advanced runtime available`
  };
}

export function getSessionRuntimeStatus(env = process.env, cwd = process.cwd()) {
  const endpoint = env?.[BROKER_ENDPOINT_ENV] ?? loadBrokerSession(cwd)?.endpoint ?? null;
  if (endpoint) {
    return {
      mode: "shared",
      label: "shared session",
      detail: "This Claude session is configured to reuse one shared Codex runtime.",
      endpoint
    };
  }

  return {
    mode: "direct",
    label: "direct startup",
    detail: "No shared Codex runtime is active yet. The first review or task command will start one on demand.",
    endpoint: null
  };
}

export async function getCodexAuthStatus(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability",
      authMethod: null,
      verified: null,
      requiresOpenaiAuth: null,
      provider: null
    };
  }

  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd, {
      env: options.env,
      reuseExistingBroker: true
    });
    return await getCodexAuthStatusFromClient(client, cwd);
  } catch (error) {
    if (client) {
      await client.close().catch(() => {});
      client = null;
    }

    try {
      client = await CodexAppServerClient.connect(cwd, {
        env: options.env,
        disableBroker: true
      });
      return await getCodexAuthStatusFromClient(client, cwd);
    } catch (fallbackError) {
      return buildAuthStatus({
        loggedIn: false,
        detail: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        source: "app-server"
      });
    }
  } finally {
    if (client) {
      await client.close().catch(() => {});
    }
  }
}

export function getCodexExecAvailability(cwd) {
  const versionStatus = binaryAvailable("codex", ["--version"], {
    cwd,
    shell: process.platform === "win32"
  });
  if (!versionStatus.available) {
    return versionStatus;
  }

  const execStatus = binaryAvailable("codex", ["exec", "--help"], {
    cwd,
    shell: process.platform === "win32"
  });
  if (!execStatus.available) {
    return {
      available: false,
      detail: `${versionStatus.detail}; exec runtime unavailable: ${execStatus.detail}`
    };
  }

  return {
    available: true,
    detail: `${versionStatus.detail}; exec runtime available`
  };
}

export async function interruptAppServerTurn(cwd, { threadId, turnId }) {
  if (!threadId || !turnId) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: "missing threadId or turnId"
    };
  }

  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: availability.detail
    };
  }

  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd, { reuseExistingBroker: true });
    await client.request("turn/interrupt", { threadId, turnId });
    return {
      attempted: true,
      interrupted: true,
      transport: client.transport,
      detail: `Interrupted ${turnId} on ${threadId}.`
    };
  } catch (error) {
    return {
      attempted: true,
      interrupted: false,
      transport: client?.transport ?? null,
      detail: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await client?.close().catch(() => {});
  }
}

export async function runAppServerReview(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  return withAppServer(cwd, async (client) => {
    emitProgress(options.onProgress, "Starting Codex review thread.", "starting");
    const thread = await startThread(client, cwd, {
      model: options.model,
      sandbox: "read-only",
      ephemeral: true,
      threadName: options.threadName
    });
    const sourceThreadId = thread.thread.id;
    emitProgress(options.onProgress, `Thread ready (${sourceThreadId}).`, "starting", {
      threadId: sourceThreadId
    });
    const delivery = options.delivery ?? "inline";

    const turnState = await captureTurn(
      client,
      sourceThreadId,
      () =>
        client.request("review/start", {
          threadId: sourceThreadId,
          delivery,
          target: options.target
        }),
      {
        onProgress: options.onProgress,
        idleTimeoutMs: options.idleTimeoutMs,
        onResponse(response, state) {
          if (response.reviewThreadId) {
            state.threadIds.add(response.reviewThreadId);
            if (delivery === "detached") {
              state.threadId = response.reviewThreadId;
            }
          }
        }
      }
    );

    return {
      status: buildResultStatus(turnState),
      threadId: turnState.threadId,
      sourceThreadId,
      turnId: turnState.turnId,
      reviewText: turnState.reviewText,
      reasoningSummary: turnState.reasoningSummary,
      turn: turnState.finalTurn,
      error: turnState.error,
      stderr: cleanCodexStderr(client.stderr)
    };
  });
}

export async function importExternalAgentSession(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }
  if (!options.sourcePath) {
    throw new Error("A Claude session source path is required.");
  }

  return withDirectAppServer(cwd, async (client) => {
    emitProgress(options.onProgress, "Importing Claude session into Codex.", "transferring");
    try {
      await requestExternalAgentSessionImport(client, externalAgentSessionMigration(options.sourcePath, cwd));
    } catch (error) {
      if (error?.rpcCode === -32601) {
        throw new Error(
          "This Codex version does not support Claude session transfer. Update Codex with `npm install -g @openai/codex@latest`, then retry.",
          { cause: error }
        );
      }
      throw error;
    }
    const threadId = importedThreadIdForSource(options.sourcePath);
    if (!threadId) {
      const stderr = cleanCodexStderr(client.stderr);
      throw new Error(
        `Codex reported that the Claude import completed, but did not record an imported thread.${stderr ? `\n${stderr}` : " Check the Codex app-server logs for the underlying import error."}`
      );
    }
    emitProgress(options.onProgress, `Claude session imported (${threadId}).`, "completed", { threadId });
    return {
      threadId,
      stderr: cleanCodexStderr(client.stderr)
    };
  });
}

export async function runAppServerTurn(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  return withAppServer(cwd, async (client) => {
    let threadId;

    if (options.resumeThreadId) {
      emitProgress(options.onProgress, `Resuming thread ${options.resumeThreadId}.`, "starting");
      const response = await resumeThread(client, options.resumeThreadId, cwd, {
        model: options.model,
        sandbox: options.sandbox,
        ephemeral: false
      });
      threadId = response.thread.id;
    } else {
      emitProgress(options.onProgress, "Starting Codex task thread.", "starting");
      const response = await startThread(client, cwd, {
        model: options.model,
        sandbox: options.sandbox,
        ephemeral: options.persistThread ? false : true,
        threadName: options.persistThread ? options.threadName : options.threadName ?? null
      });
      threadId = response.thread.id;
    }

    emitProgress(options.onProgress, `Thread ready (${threadId}).`, "starting", {
      threadId
    });

    const prompt = options.prompt?.trim() || options.defaultPrompt || "";
    if (!prompt) {
      throw new Error("A prompt is required for this Codex run.");
    }

    const turnState = await captureTurn(
      client,
      threadId,
      () =>
        client.request("turn/start", {
          threadId,
          input: buildTurnInput(prompt),
          model: options.model ?? null,
          effort: options.effort ?? null,
          outputSchema: options.outputSchema ?? null
        }),
      { onProgress: options.onProgress, idleTimeoutMs: options.idleTimeoutMs }
    );

    return {
      status: buildResultStatus(turnState),
      threadId,
      turnId: turnState.turnId,
      finalMessage: turnState.lastAgentMessage,
      reasoningSummary: turnState.reasoningSummary,
      turn: turnState.finalTurn,
      error: turnState.error,
      stderr: cleanCodexStderr(client.stderr),
      fileChanges: turnState.fileChanges,
      touchedFiles: collectTouchedFiles(turnState.fileChanges),
      commandExecutions: turnState.commandExecutions,
      mcpToolCalls: turnState.mcpToolCalls,
      dynamicToolCalls: turnState.dynamicToolCalls,
      commandFailures: summarizeCommandFailures(turnState.commandExecutions),
      mcpToolFailures: summarizeToolFailures(turnState.mcpToolCalls, (item) => `${item.server}/${item.tool}`),
      dynamicToolFailures: summarizeToolFailures(turnState.dynamicToolCalls, (item) => item.tool ?? "unknown tool")
    };
  });
}

export async function runCodexExecTask(cwd, options = {}) {
  const availability = getCodexExecAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required exec runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  const outputPath = buildExecTempPath("last-message");
  const schemaPath = options.outputSchema ? writeTempJsonFile("output-schema", options.outputSchema) : null;
  const commandFailures = [];
  const mcpToolCalls = [];
  const dynamicToolCalls = [];
  let finalMessage = "";
  let accumulatedMessages = "";
  let lastMessage = "";
  let threadId = null;
  let turnId = null;
  let stderr = "";
  let stdoutRemainder = "";
  let idleTimer = null;
  let timedOut = false;
  let finalizationTimer = null;
  let finalizedAfterMessage = false;
  let killChild = () => {};

  const resetIdleTimer = () => {
    if (!options.idleTimeoutMs) {
      return;
    }
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, options.idleTimeoutMs);
  };

  const clearFinalizationTimer = () => {
    if (finalizationTimer) {
      clearTimeout(finalizationTimer);
      finalizationTimer = null;
    }
  };

  // The finalization timer kills the child process N ms after the last agent_message,
  // if no new item.started event arrives in that window. It is a fallback for when
  // turn.completed never fires (e.g. Codex exits without emitting the event).
  //
  // Default is 30s. The previous 5s default was too aggressive — gpt-5.4 can take
  // longer than 5s to deliberate between tool calls, causing the child to be killed
  // mid-turn. Incremental-write reviews (spec/scoping-adversarial-review) use 180s
  // (passed explicitly via options.finalizationTimeoutMs) because the model narrates
  // between each apply_patch section with potentially long think gaps.
  //
  // A kill from this timer resolves to exit 0 below, on the assumption that a run that
  // produced a final message succeeded. That assumption does not hold for incremental
  // reviews, where the last narration can land mid-review — codex-companion.mjs treats a
  // missing REVIEW COMPLETE marker on those runs as a failure to close that hole.
  const finalizationTimeoutMs = options.finalizationTimeoutMs ?? 30000;

  const scheduleFinalizationTimer = () => {
    clearFinalizationTimer();
    finalizationTimer = setTimeout(() => {
      finalizedAfterMessage = true;
      killChild();
    }, finalizationTimeoutMs);
  };

  /** @type {string[]} */
  const args = ["exec", "--cd", cwd, "--skip-git-repo-check", "--json", "--output-last-message", outputPath];
  if (schemaPath) {
    args.push("--output-schema", schemaPath);
  }
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.effort) {
    pushExecConfig(args, "model_reasoning_effort", options.effort);
  }
  args.push("--dangerously-bypass-approvals-and-sandbox", "--ignore-rules");
  if (options.resumeThreadId) {
    args.push("resume", options.resumeThreadId);
  }
  if (typeof options.prompt === "string") {
    args.push("-");
  }

  emitProgress(options.onProgress, "Starting Codex exec task.", "starting");

  const spawnTarget = resolveCodexSpawnTarget(options.env ?? process.env);
  const allArgs = [...spawnTarget.preArgs, ...args];
  const spawnCommand = spawnTarget.shell && allArgs.length > 0
    ? [spawnTarget.command, ...allArgs].map(quoteShellArg).join(" ")
    : spawnTarget.command;
  const spawnArgs = spawnTarget.shell && allArgs.length > 0 ? [] : allArgs;
  const child = spawn(spawnCommand, spawnArgs, {
    cwd,
    env: options.env ?? process.env,
    shell: spawnTarget.shell,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  resetIdleTimer();

  const processStdoutChunk = (chunk) => {
    resetIdleTimer();
    stdoutRemainder += chunk;
    const lines = stdoutRemainder.split(/\r?\n/);
    stdoutRemainder = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const event = parseExecEvent(trimmed);
      if (!event) {
        continue;
      }

      switch (event.type) {
        case "thread.started":
          threadId = event.thread_id ?? threadId;
          emitProgress(options.onProgress, threadId ? `Thread ready (${threadId}).` : "Thread ready.", "starting", {
            threadId: threadId ?? null
          });
          break;
        case "turn.started":
          turnId = event.turn_id ?? turnId;
          emitProgress(options.onProgress, "Turn started.", "starting", {
            threadId: threadId ?? null,
            turnId: turnId ?? null
          });
          break;
        case "item.started":
        case "tool_call.started":
        case "mcp_tool_call.started":
        case "function_call.started":
          clearFinalizationTimer();
          finalizedAfterMessage = false;
          resetIdleTimer();
          break;
        case "item.completed": {
          const item = event.item ?? {};
          const itemType = normalizeExecItemType(item.type);
          if (itemType === "agent_message" && typeof item.text === "string") {
            // finalMessage holds only the most recent agent_message — the final
            // output we want to surface. Previously this accumulated every inter-tool
            // narration chunk, which bloated transcripts with running commentary.
            // accumulatedMessages retains the full history as a fallback for when
            // Codex is killed before flushing --output-last-message (e.g., the
            // finalization timer fires mid-write). Only used if both the output file
            // and finalMessage end up empty.
            lastMessage = item.text;
            finalMessage = item.text;
            accumulatedMessages = accumulatedMessages
              ? `${accumulatedMessages}\n\n${item.text}`
              : item.text;
            emitProgress(options.onProgress, "Assistant produced a final message.", "finalizing");
            scheduleFinalizationTimer();
            break;
          }
          clearFinalizationTimer();
          finalizedAfterMessage = false;
          if (itemType === "command_execution") {
            if (String(item.status ?? "").trim().toLowerCase() === "failed") {
              commandFailures.push({
                command: item.command ?? "",
                status: item.status ?? "failed",
                exitCode: item.exit_code ?? item.exitCode ?? null
              });
            }
            break;
          }
          if (itemType === "mcp_tool_call") {
            mcpToolCalls.push(item);
            break;
          }
          if (itemType === "dynamic_tool_call") {
            dynamicToolCalls.push(item);
          }
          break;
        }
        case "turn.completed":
          emitProgress(options.onProgress, "Turn completed.", "finalizing", {
            threadId: threadId ?? null,
            turnId: turnId ?? null
          });
          break;
        case "error":
          if (event.message) {
            stderr = `${stderr}${stderr ? "\n" : ""}${event.message}`;
          }
          emitProgress(options.onProgress, `Codex error: ${event.message ?? "unknown exec error"}`, "failed");
          break;
        default:
          break;
      }
    }
  };

  killChild = () => {
    try {
      if (child.pid) {
        terminateProcessTree(child.pid);
      } else {
        child.kill();
      }
    } catch { /* already dead */ }
  };
  process.on("SIGTERM", killChild);
  process.on("SIGINT", killChild);
  process.on("exit", killChild);

  let exitStatus;
  try {
    exitStatus = await new Promise((resolve, reject) => {
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      if (typeof options.prompt === "string" && child.stdin) {
        child.stdin.write(options.prompt);
        child.stdin.end();
      }
      child.stdout?.on("data", processStdoutChunk);
      child.stderr?.on("data", (chunk) => {
        resetIdleTimer();
        stderr += String(chunk);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (idleTimer) {
          clearTimeout(idleTimer);
        }
        clearFinalizationTimer();
        if (stdoutRemainder.trim()) {
          processStdoutChunk("\n");
        }
        if (finalizedAfterMessage && finalMessage.trim()) {
          resolve(0);
          return;
        }
        if (timedOut && options.idleTimeoutMs) {
          reject(new Error(`Codex turn timed out after ${Math.ceil(options.idleTimeoutMs / 1000)}s without progress.`));
          return;
        }
        resolve(code ?? 1);
      });
    });
  } finally {
    process.removeListener("SIGTERM", killChild);
    process.removeListener("SIGINT", killChild);
    process.removeListener("exit", killChild);
  }

  const cleanedStderr = cleanCodexStderr(stderr);
  try {
    if (fs.existsSync(outputPath)) {
      const fileContent = fs.readFileSync(outputPath, "utf8");
      // Only overwrite the in-memory messages if the file actually has content.
      // Codex can leave a zero-byte --output-last-message file when it crashes or
      // is killed mid-stream (e.g., SIGTERM from finalization timer before the CLI
      // flushes). Clobbering finalMessage/lastMessage with "" would destroy any real
      // content captured from the event stream.
      if (fileContent.length > 0) {
        finalMessage = fileContent;
        lastMessage = fileContent;
      }
    }
    // Fallback: if neither the output file nor the event-sourced final message
    // captured anything, fall back to the accumulated narration so the caller has
    // something to work with. This preserves the pre-existing recovery behavior
    // for cases like context-exhaustion mid-turn.
    if (!finalMessage && accumulatedMessages) {
      finalMessage = accumulatedMessages;
    }
  } finally {
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }
    releaseTempPath(outputPath);
    if (schemaPath && fs.existsSync(schemaPath)) {
      fs.unlinkSync(schemaPath);
    }
    releaseTempPath(schemaPath);
  }

  return {
    status: exitStatus,
    threadId,
    turnId,
    finalMessage,
    lastMessage,
    stderr: cleanedStderr,
    touchedFiles: [],
    reasoningSummary: [],
    commandFailures,
    mcpToolFailures: collectExecFailure(mcpToolCalls, (item) => `${item.server ?? "unknown"}/${item.tool ?? "unknown"}`),
    dynamicToolFailures: collectExecFailure(dynamicToolCalls, (item) => item.tool ?? "unknown tool")
  };
}

export async function findLatestTaskThread(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  return withAppServer(cwd, async (client) => {
    const response = await client.request("thread/list", {
      cwd,
      limit: 20,
      sortKey: "updated_at",
      sourceKinds: ["appServer"],
      searchTerm: TASK_THREAD_PREFIX
    });

    return (
      response.data.find((thread) => typeof thread.name === "string" && thread.name.startsWith(TASK_THREAD_PREFIX)) ??
      null
    );
  });
}

export function buildPersistentTaskThreadName(prompt) {
  return buildTaskThreadName(prompt);
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Codex did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  try {
    return {
      parsed: JSON.parse(rawOutput),
      parseError: null,
      rawOutput,
      ...fallback
    };
  } catch (error) {
    return {
      parsed: null,
      parseError: error.message,
      rawOutput,
      ...fallback
    };
  }
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export { DEFAULT_CONTINUE_PROMPT, TASK_THREAD_PREFIX };
