import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

export function installFakeCodex(binDir, behavior = "review-ok") {
  const statePath = path.join(binDir, "fake-codex-state.json");
  const scriptPath = path.join(binDir, "codex");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const readline = require("node:readline");

	const STATE_PATH = ${JSON.stringify(statePath)};
	const BEHAVIOR = ${JSON.stringify(behavior)};
	const interruptibleTurns = new Map();

	function loadState() {
	  if (!fs.existsSync(STATE_PATH)) {
	    return { nextThreadId: 1, nextTurnId: 1, appServerStarts: 0, threads: [], capabilities: null, lastInterrupt: null };
	  }
	  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
	}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function requiresExperimental(field, message, state) {
  if (!(field in (message.params || {}))) {
    return false;
  }
  return !state.capabilities || state.capabilities.experimentalApi !== true;
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function buildThread(thread) {
  return {
    id: thread.id,
    preview: thread.preview || "",
    ephemeral: Boolean(thread.ephemeral),
    modelProvider: "openai",
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    status: { type: "idle" },
    path: null,
    cwd: thread.cwd,
    cliVersion: "fake-codex",
    source: "appServer",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: thread.name || null,
    turns: []
  };
}

function buildTurn(id, status = "inProgress", error = null) {
  return { id, status, items: [], error };
}

function buildAccountReadResult() {
  switch (BEHAVIOR) {
    case "logged-out":
    case "refreshable-auth":
    case "auth-run-fails":
      return { account: null, requiresOpenaiAuth: true };
    case "provider-no-auth":
    case "env-key-provider":
      return { account: null, requiresOpenaiAuth: false };
    case "api-key-account-only":
      return { account: { type: "apiKey" }, requiresOpenaiAuth: true };
    default:
      return {
        account: { type: "chatgpt", email: "test@example.com", planType: "plus" },
        requiresOpenaiAuth: true
      };
  }
}

function buildConfigReadResult() {
  switch (BEHAVIOR) {
    case "provider-no-auth":
      return {
        config: { model_provider: "ollama" },
        origins: {}
      };
    case "env-key-provider":
      return {
        config: {
          model_provider: "openai-custom",
          model_providers: {
            "openai-custom": {
              name: "OpenAI custom",
              env_key: "OPENAI_API_KEY",
              requires_openai_auth: false
            }
          }
        },
        origins: {}
      };
    default:
      return {
        config: { model_provider: "openai" },
        origins: {}
      };
  }
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function nextThread(state, cwd, ephemeral) {
  const thread = {
    id: "thr_" + state.nextThreadId++,
    cwd: cwd || process.cwd(),
    name: null,
    preview: "",
    ephemeral: Boolean(ephemeral),
    createdAt: now(),
    updatedAt: now()
  };
  state.threads.unshift(thread);
  saveState(state);
  return thread;
}

function ensureThread(state, threadId) {
  const thread = state.threads.find((candidate) => candidate.id === threadId);
  if (!thread) {
    throw new Error("unknown thread " + threadId);
  }
  return thread;
}

function nextTurnId(state) {
  const turnId = "turn_" + state.nextTurnId++;
  saveState(state);
  return turnId;
}

function importLedgerPath() {
  return path.join(process.env.CODEX_HOME || path.join(process.env.HOME, ".codex"), "external_agent_session_imports.json");
}

function loadImportLedger() {
  const ledgerPath = importLedgerPath();
  return fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, "utf8")) : { records: [] };
}

function saveImportLedger(ledger) {
  const ledgerPath = importLedgerPath();
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
}

function emitTurnCompleted(threadId, turnId, item) {
  const items = Array.isArray(item) ? item : [item];
  send({ method: "turn/started", params: { threadId, turn: buildTurn(turnId) } });
  for (const entry of items) {
    if (entry && entry.started) {
      send({ method: "item/started", params: { threadId, turnId, item: entry.started } });
    }
    if (entry && entry.completed) {
      send({ method: "item/completed", params: { threadId, turnId, item: entry.completed } });
    }
  }
  send({ method: "turn/completed", params: { threadId, turn: buildTurn(turnId, "completed") } });
}

function emitTurnCompletedLater(threadId, turnId, item, delayMs) {
  setTimeout(() => {
    emitTurnCompleted(threadId, turnId, item);
  }, delayMs);
}

function nativeReviewText(target) {
  if (target.type === "baseBranch") {
    return "Reviewed changes against " + target.branch + ".\\nNo material issues found.";
  }
  if (target.type === "custom") {
    return "Reviewed custom target.\\nNo material issues found.";
  }
  return "Reviewed uncommitted changes.\\nNo material issues found.";
}

function structuredReviewPayload(prompt) {
  if (prompt.includes("adversarial software review")) {
    if (BEHAVIOR === "adversarial-clean") {
      return JSON.stringify({
        verdict: "approve",
        summary: "No material issues found.",
        findings: [],
        next_steps: []
      });
    }

    return JSON.stringify({
      verdict: "needs-attention",
      summary: "One adversarial concern surfaced.",
      findings: [
        {
          severity: "high",
          title: "Missing empty-state guard",
          body: "The change assumes data is always present.",
          file: "src/app.js",
          line_start: 4,
          line_end: 6,
          confidence: 0.87,
          recommendation: "Handle empty collections before indexing."
        }
      ],
      next_steps: ["Add an empty-state test."]
    });
  }

  if (BEHAVIOR === "invalid-json") {
    return "not valid json";
  }

  return JSON.stringify({
    verdict: "approve",
    summary: "No material issues found.",
    findings: [],
    next_steps: []
  });
}

function taskPayload(prompt, resume) {
  if (prompt.includes("<task>") && prompt.includes("Only review the work from the previous Claude turn.")) {
    if (BEHAVIOR === "adversarial-clean") {
      return "ALLOW: No blocking issues found in the previous turn.";
    }
    return "BLOCK: Missing empty-state guard in src/app.js:4-6.";
  }

  if (resume || prompt.includes("Continue from the current thread state") || prompt.includes("follow up")) {
    return "Resumed the prior run.\\nFollow-up prompt accepted.";
  }

  return "Handled the requested task.\\nTask prompt accepted.";
}

function writeLastMessageFile(filePath, text) {
  if (!filePath) {
    return;
  }
  fs.writeFileSync(filePath, text, "utf8");
}

function emitExecEvent(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function handleExec(args) {
  const state = loadState();
  let index = 1;
  let resume = false;
  let resumeThreadId = null;
  let model = null;
  let effort = null;
  let outputLastMessage = null;
  let outputSchemaPath = null;
  let dangerousBypass = false;

  if (args[index] === "resume") {
    resume = true;
    index += 1;
  }

  while (index < args.length) {
    const token = args[index];
    if (token === "--help") {
      console.log("fake exec help");
      process.exit(0);
    }
    if (token === "--dangerously-bypass-approvals-and-sandbox") {
      dangerousBypass = true;
      index += 1;
      continue;
    }
    if (token === "--ignore-rules") {
      index += 1;
      continue;
    }
    if (token === "--model") {
      model = args[index + 1] ?? null;
      index += 2;
      continue;
    }
    if (token === "-c") {
      const configValue = args[index + 1] ?? "";
      const match = /^model_reasoning_effort=(.+)$/.exec(configValue);
      if (match) {
        try {
          effort = JSON.parse(match[1]);
        } catch {
          effort = match[1];
        }
      }
      index += 2;
      continue;
    }
    if (token === "--output-last-message") {
      outputLastMessage = args[index + 1] ?? null;
      index += 2;
      continue;
    }
    if (token === "--output-schema") {
      outputSchemaPath = args[index + 1] ?? null;
      index += 2;
      continue;
    }
    if (token === "--cd" || token === "--skip-git-repo-check" || token === "--json") {
      index += token === "--cd" ? 2 : 1;
      continue;
    }
    break;
  }

  if (resume) {
    resumeThreadId = args[index] ?? null;
    index += 1;
  }

  let prompt = args.slice(index).join(" ").trim();
  if (prompt === "-") {
    prompt = fs.readFileSync(0, "utf8").trim();
  }
  const threadId = resumeThreadId || "thr_" + state.nextThreadId++;
  const turnId = "turn_" + state.nextTurnId++;
  const payload = outputSchemaPath ? structuredReviewPayload(prompt) : taskPayload(prompt, resume);

  state.lastTurnStart = {
    threadId,
    turnId,
    model,
    effort,
    prompt
  };
  state.lastExec = {
    args,
    dangerousBypass,
    outputLastMessage
  };
  saveState(state);

  if (BEHAVIOR === "stalled-task") {
    setInterval(() => {}, 60000);
    return false;
  }

  // Silent-but-alive simulation (PM#2053, 2026-09-11). Codex CLI 0.154 writes no
  // --json events while the model polls a long-running shell command, but its
  // session rollout file under $CODEX_HOME/sessions/YYYY/MM/DD keeps growing.
  //   silent-rollout-progress: grows for ~1s, then finishes normally
  //   silent-rollout-stops:    grows briefly, then goes truly quiet forever
  //   silent-rollout-forever:  grows forever and never finishes
  if (BEHAVIOR === "silent-rollout-progress" || BEHAVIOR === "silent-rollout-stops" || BEHAVIOR === "silent-rollout-forever") {
    const day = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const sessionsDir = path.join(process.env.CODEX_HOME, "sessions", String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()));
    fs.mkdirSync(sessionsDir, { recursive: true });
    const rolloutPath = path.join(sessionsDir, "rollout-fake-" + threadId + ".jsonl");
    // Real Codex writes session metadata before the first event, so the file exists
    // (with content that must not count as growth) by the time thread.started lands.
    fs.writeFileSync(rolloutPath, JSON.stringify({ type: "session_meta" }) + "\\n");
    emitExecEvent({ type: "thread.started", thread_id: threadId });
    emitExecEvent({ type: "turn.started", turn_id: turnId });
    let writes = 0;
    setInterval(() => {
      if (BEHAVIOR === "silent-rollout-stops" && writes >= 3) {
        return;
      }
      fs.appendFileSync(rolloutPath, JSON.stringify({ type: "poll", n: writes }) + "\\n");
      writes += 1;
      if (BEHAVIOR === "silent-rollout-progress" && writes >= 60) {
        emitExecEvent({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: payload } });
        emitExecEvent({ type: "turn.completed" });
        writeLastMessageFile(outputLastMessage, payload);
        process.exit(0);
      }
    }, 50);
    return false;
  }

  // Falsifiers for how the liveness baseline is taken (blind review of 404288d):
  //   silent-rollout-dead-after-start: startup records, then nothing at all
  //   silent-rollout-dead-after-event: startup records, one later event, then nothing
  //   silent-rollout-chatty: log always growing, an event every 1.5s, finishes after ~12s
  if (BEHAVIOR === "silent-rollout-dead-after-start" || BEHAVIOR === "silent-rollout-dead-after-event" || BEHAVIOR === "silent-rollout-chatty") {
    const day = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const sessionsDir = path.join(process.env.CODEX_HOME, "sessions", String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()));
    fs.mkdirSync(sessionsDir, { recursive: true });
    const rolloutPath = path.join(sessionsDir, "rollout-fake-" + threadId + ".jsonl");
    fs.writeFileSync(rolloutPath, JSON.stringify({ type: "session_meta" }) + "\\n");
    // One write, so both lines reach the runtime in a single chunk, before it knows the thread id.
    process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: threadId }) + "\\n" + JSON.stringify({ type: "turn.started", turn_id: turnId }) + "\\n");
    if (BEHAVIOR === "silent-rollout-dead-after-event") {
      setTimeout(() => {
        fs.appendFileSync(rolloutPath, JSON.stringify({ type: "reasoning" }) + "\\n");
        emitExecEvent({ type: "item.completed", item: { id: "item_r", type: "reasoning" } });
      }, 200);
    }
    if (BEHAVIOR === "silent-rollout-chatty") {
      const started = Date.now();
      setInterval(() => {
        fs.appendFileSync(rolloutPath, JSON.stringify({ type: "poll" }) + "\\n");
      }, 50);
      setInterval(() => {
        if (Date.now() - started >= 12000) {
          emitExecEvent({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: payload } });
          emitExecEvent({ type: "turn.completed" });
          writeLastMessageFile(outputLastMessage, payload);
          process.exit(0);
        }
        emitExecEvent({ type: "item.completed", item: { id: "item_c", type: "reasoning" } });
      }, 1500);
    }
    setInterval(() => {}, 60000);
    return false;
  }

  // Incremental-write review simulation (PM#2011 V3-e, 2026-08-31). The real model
  // writes the review to disk section by section via apply_patch and appends
  // <!-- REVIEW COMPLETE --> as its final act. When the finalization timer kills the
  // child mid-review, the CLI still resolves to exit 0 and a partial file is left on
  // disk. Both behaviours below exit 0 on purpose: exit 0 is exactly the condition
  // under which a truncated review used to be published as if it were finished.
  if (BEHAVIOR === "incremental-review-truncated" || BEHAVIOR === "incremental-review-complete") {
    const outMatch = /Write your review to:\\s*(.+)/.exec(prompt);
    if (outMatch) {
      const reviewPath = outMatch[1].trim();
      let body = "## 1 Executive Summary\\n\\nShip recommendation: pass.\\n\\n"
        + "## 2 Critical Findings\\n\\nNo critical findings.\\n\\n"
        + "## 3 High Findings\\n\\nNo high findings.\\n\\n"
        + "## 4 Medium and Low Findings\\n\\nNo medium or low findings.\\n";
      if (BEHAVIOR === "incremental-review-complete") {
        body += "\\n## 5 Review Evidence\\n\\n\`\`\`json\\n{}\\n\`\`\`\\n\\n"
          + "## 6 Verdict\\n\\nverdict: pass\\n<!-- REVIEW COMPLETE -->\\n";
      }
      fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
      fs.writeFileSync(reviewPath, body, "utf8");
    }
  }

  emitExecEvent({ type: "thread.started", thread_id: threadId });
  emitExecEvent({ type: "turn.started", turn_id: turnId });
  emitExecEvent({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: payload } });
  emitExecEvent({ type: "turn.completed" });
  writeLastMessageFile(outputLastMessage, payload);
  process.exit(0);
}

function buildTaskRuntimeFailureItems(turnId) {
  return [
    {
      completed: {
        type: "mcpToolCall",
        id: "mcp_" + turnId,
        server: "code-review-graph",
        tool: "get_minimal_context_tool",
        status: "failed"
      }
    },
    {
      completed: {
        type: "commandExecution",
        id: "cmd_" + turnId,
        command: "git show HEAD~1",
        status: "failed",
        exitCode: 1
      }
    },
    {
      completed: {
        type: "agentMessage",
        id: "msg_" + turnId,
        text: "Completed the investigation, but some runtime checks failed.",
        phase: "final_answer"
      }
    }
  ];
}

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("codex-cli test");
  process.exit(0);
}
if (args[0] === "exec" && args[1] === "--help") {
  console.log("fake exec help");
  process.exit(0);
}
if (args[0] === "app-server" && args[1] === "--help") {
  console.log("fake app-server help");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  if (BEHAVIOR === "logged-out" || BEHAVIOR === "refreshable-auth" || BEHAVIOR === "auth-run-fails" || BEHAVIOR === "provider-no-auth" || BEHAVIOR === "env-key-provider" || BEHAVIOR === "api-key-account-only") {
    console.error("not authenticated");
    process.exit(1);
  }
  console.log("logged in");
  process.exit(0);
}
if (args[0] === "login") {
  process.exit(0);
}
if (args[0] === "exec") {
  if (handleExec(args) !== false) {
    process.exit(0);
  }
} else if (args[0] !== "app-server") {
  process.exit(1);
}
const bootState = loadState();
bootState.appServerStarts = (bootState.appServerStarts || 0) + 1;
saveState(bootState);

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  const message = JSON.parse(line);
  const state = loadState();

  try {
    switch (message.method) {
      case "initialize":
        state.capabilities = message.params.capabilities || null;
        saveState(state);
        send({ id: message.id, result: { userAgent: "fake-codex-app-server" } });
        break;

      case "initialized":
        break;

      case "account/read":
        send({ id: message.id, result: buildAccountReadResult() });
        break;

      case "config/read":
        if (BEHAVIOR === "config-read-fails") {
          throw new Error("config/read failed for cwd");
        }
        send({ id: message.id, result: buildConfigReadResult() });
        break;

      case "thread/start": {
        if (BEHAVIOR === "auth-run-fails") {
          throw new Error("authentication expired; run codex login");
        }
        if (requiresExperimental("persistExtendedHistory", message, state) || requiresExperimental("persistFullHistory", message, state)) {
          throw new Error("thread/start.persistFullHistory requires experimentalApi capability");
        }
        const thread = nextThread(state, message.params.cwd, message.params.ephemeral);
        send({ id: message.id, result: { thread: buildThread(thread), model: message.params.model || "gpt-5.4", modelProvider: "openai", serviceTier: null, cwd: thread.cwd, approvalPolicy: "never", sandbox: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false }, reasoningEffort: null } });
        send({ method: "thread/started", params: { thread: { id: thread.id } } });
        break;
      }

      case "thread/name/set": {
        const thread = ensureThread(state, message.params.threadId);
        thread.name = message.params.name;
        thread.updatedAt = now();
        saveState(state);
        send({ id: message.id, result: {} });
        break;
      }

      case "thread/list": {
        let threads = state.threads.slice();
        if (message.params.cwd) {
          threads = threads.filter((thread) => thread.cwd === message.params.cwd);
        }
        if (message.params.searchTerm) {
          threads = threads.filter((thread) => (thread.name || "").includes(message.params.searchTerm));
        }
        threads.sort((left, right) => right.updatedAt - left.updatedAt);
        send({ id: message.id, result: { data: threads.map(buildThread), nextCursor: null } });
        break;
      }

      case "thread/resume": {
        if (requiresExperimental("persistExtendedHistory", message, state) || requiresExperimental("persistFullHistory", message, state)) {
          throw new Error("thread/resume.persistFullHistory requires experimentalApi capability");
        }
        const thread = ensureThread(state, message.params.threadId);
        thread.updatedAt = now();
        saveState(state);
        send({ id: message.id, result: { thread: buildThread(thread), model: message.params.model || "gpt-5.4", modelProvider: "openai", serviceTier: null, cwd: thread.cwd, approvalPolicy: "never", sandbox: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false }, reasoningEffort: null } });
        break;
      }

      case "externalAgentConfig/import": {
        if (BEHAVIOR === "external-import-unsupported") {
          send({ id: message.id, error: { code: -32601, message: "Unsupported method: externalAgentConfig/import" } });
          break;
        }
        if (BEHAVIOR === "external-import-fails") {
          send({ id: message.id, result: {} });
          send({ method: "externalAgentConfig/import/completed", params: {} });
          break;
        }
        const sessions = (message.params.migrationItems || [])
          .flatMap((item) => item.details && Array.isArray(item.details.sessions) ? item.details.sessions : []);
        const session = sessions[0];
        if (!session) {
          throw new Error("missing external session migration");
        }
        const sourcePath = fs.realpathSync(session.path);
        const contents = fs.readFileSync(sourcePath, "utf8");
        const contentSha256 = crypto.createHash("sha256").update(contents).digest("hex");
        const ledger = loadImportLedger();
        let record = ledger.records.find(
          (candidate) => candidate.source_path === sourcePath && candidate.content_sha256 === contentSha256
        );
        let thread;
        if (record) {
          thread = ensureThread(state, record.imported_thread_id);
        } else {
          const records = contents.split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
          const title = records.find((entry) => entry.type === "custom-title")?.customTitle || null;
          const messages = records
            .filter((entry) => entry.type === "user" || entry.type === "assistant")
            .map((entry) => ({ role: entry.type, text: entry.message?.content || "" }));
          thread = nextThread(state, session.cwd, false);
          thread.name = title;
          thread.preview = messages.find((entry) => entry.role === "user")?.text || "";
          thread.visibleMessages = messages;
          state.lastExternalAgentImport = { sourcePath, threadId: thread.id, messages };
          record = {
            source_path: sourcePath,
            content_sha256: contentSha256,
            imported_thread_id: thread.id,
            imported_at: now(),
            source_modified_at: null
          };
          ledger.records.push(record);
          saveState(state);
          saveImportLedger(ledger);
        }
        send({ id: message.id, result: {} });
        send({ method: "externalAgentConfig/import/completed", params: {} });
        break;
      }

      case "review/start": {
        const thread = ensureThread(state, message.params.threadId);
        let reviewThread = thread;
        if (message.params.delivery === "detached") {
          reviewThread = nextThread(state, thread.cwd, true);
          send({ method: "thread/started", params: { thread: { id: reviewThread.id } } });
        }
        const turnId = nextTurnId(state);
        send({ id: message.id, result: { turn: buildTurn(turnId), reviewThreadId: reviewThread.id } });
        emitTurnCompleted(reviewThread.id, turnId, [
          {
            started: { type: "enteredReviewMode", id: turnId, review: "current changes" }
          },
          ...(BEHAVIOR === "with-reasoning"
            ? [
                {
                  completed: {
                    type: "reasoning",
                    id: "reasoning_" + turnId,
                    summary: [{ text: "Reviewed the changed files and checked the likely regression paths." }],
                    content: []
                  }
                }
              ]
            : []),
          {
            completed: { type: "exitedReviewMode", id: turnId, review: nativeReviewText(message.params.target) }
          }
        ]);
        break;
      }

	      case "turn/start": {
	        const thread = ensureThread(state, message.params.threadId);
	        const prompt = (message.params.input || [])
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\\n");
        const turnId = nextTurnId(state);
        thread.updatedAt = now();
	        state.lastTurnStart = {
	          threadId: message.params.threadId,
	          turnId,
	          model: message.params.model ?? null,
	          effort: message.params.effort ?? null,
	          prompt
	        };
	        saveState(state);
	        send({ id: message.id, result: { turn: buildTurn(turnId) } });

        if (
          BEHAVIOR === "review-fallback-after-mcp-crash" &&
          message.params.outputSchema &&
          !prompt.includes("Do not call MCP or graph tools in this attempt.")
        ) {
          process.exit(1);
        }

        const payload = message.params.outputSchema && message.params.outputSchema.properties && message.params.outputSchema.properties.verdict
          ? structuredReviewPayload(prompt)
          : taskPayload(prompt, thread.name && thread.name.startsWith("Codex Companion Task") && prompt.includes("Continue from the current thread state"));

        if (
          BEHAVIOR === "with-subagent" ||
          BEHAVIOR === "with-late-subagent-message" ||
          BEHAVIOR === "with-subagent-no-main-turn-completed"
        ) {
          const subThread = nextThread(state, thread.cwd, true);
          const subThreadRecord = ensureThread(state, subThread.id);
          subThreadRecord.name = "design-challenger";
          saveState(state);
          const subTurnId = nextTurnId(state);

          send({ method: "thread/started", params: { thread: { ...buildThread(subThreadRecord), name: "design-challenger", agentNickname: "design-challenger" } } });
          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
          send({
            method: "item/started",
            params: {
              threadId: thread.id,
              turnId,
              item: {
                type: "collabAgentToolCall",
                id: "collab_" + turnId,
                tool: "wait",
                status: "inProgress",
                senderThreadId: thread.id,
                receiverThreadIds: [subThread.id],
                prompt: "Challenge the implementation approach",
                model: null,
                reasoningEffort: null,
                agentsStates: {
                  [subThread.id]: { status: "inProgress", message: "Investigating design tradeoffs" }
                }
              }
            }
          });
          if (BEHAVIOR === "with-late-subagent-message") {
            send({
              method: "item/completed",
              params: {
                threadId: thread.id,
                turnId,
                item: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
              }
            });
          }
          send({ method: "turn/started", params: { threadId: subThread.id, turn: buildTurn(subTurnId) } });
          send({
            method: "item/completed",
            params: {
              threadId: subThread.id,
              turnId: subTurnId,
              item: {
                type: "reasoning",
                id: "reasoning_" + subTurnId,
                summary: [{ text: "Questioned the retry strategy and the cache invalidation boundaries." }],
                content: []
              }
            }
          });
          send({
            method: "item/completed",
            params: {
              threadId: subThread.id,
              turnId: subTurnId,
              item: {
                type: "agentMessage",
                id: "msg_" + subTurnId,
                text: "The design assumes retries are harmless, but they can duplicate side effects without stronger idempotency guarantees.",
                phase: "analysis"
              }
            }
          });
          send({ method: "turn/completed", params: { threadId: subThread.id, turn: buildTurn(subTurnId, "completed") } });
          send({
            method: "item/completed",
            params: {
              threadId: thread.id,
              turnId,
              item: {
                type: "collabAgentToolCall",
                id: "collab_" + turnId,
                tool: "wait",
                status: "completed",
                senderThreadId: thread.id,
                receiverThreadIds: [subThread.id],
                prompt: "Challenge the implementation approach",
                model: null,
                reasoningEffort: null,
                agentsStates: {
                  [subThread.id]: { status: "completed", message: "Finished" }
                }
              }
            }
          });
          if (BEHAVIOR !== "with-late-subagent-message") {
            send({
              method: "item/completed",
              params: {
                threadId: thread.id,
                turnId,
                item: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
              }
            });
          }
          if (BEHAVIOR !== "with-subagent-no-main-turn-completed") {
            send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "completed") } });
          }
          break;
        }

        const items = BEHAVIOR === "task-runtime-failures"
          ? buildTaskRuntimeFailureItems(turnId)
          : [
          ...(BEHAVIOR === "with-reasoning"
            ? [
                {
                  completed: {
                    type: "reasoning",
                    id: "reasoning_" + turnId,
                    summary: [{ text: "Inspected the prompt, gathered evidence, and checked the highest-risk paths first." }],
                    content: []
                  }
              }
            ]
            : []),
          {
            completed: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
          }
        ];

	        if (BEHAVIOR === "interruptible-slow-task") {
	          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
	          const timer = setTimeout(() => {
	            if (!interruptibleTurns.has(turnId)) {
	              return;
	            }
	            interruptibleTurns.delete(turnId);
	            for (const entry of items) {
	              if (entry && entry.completed) {
	                send({ method: "item/completed", params: { threadId: thread.id, turnId, item: entry.completed } });
	              }
	            }
	            send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "completed") } });
	          }, 5000);
	          interruptibleTurns.set(turnId, { threadId: thread.id, timer });
	        } else if (BEHAVIOR === "stalled-task") {
	          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
	        } else if (BEHAVIOR === "slow-task") {
	          emitTurnCompletedLater(thread.id, turnId, items, 400);
	        } else {
	          emitTurnCompleted(thread.id, turnId, items);
	        }
	        break;
	      }

	      case "turn/interrupt": {
	        state.lastInterrupt = {
	          threadId: message.params.threadId,
	          turnId: message.params.turnId
	        };
	        saveState(state);
	        const pending = interruptibleTurns.get(message.params.turnId);
	        if (pending) {
	          clearTimeout(pending.timer);
	          interruptibleTurns.delete(message.params.turnId);
	          send({
	            method: "turn/completed",
	            params: {
	              threadId: pending.threadId,
	              turn: buildTurn(message.params.turnId, "interrupted")
	            }
	          });
	        }
	        send({ id: message.id, result: {} });
	        break;
	      }

	      default:
	        send({ id: message.id, error: { code: -32601, message: "Unsupported method: " + message.method } });
        break;
    }
  } catch (error) {
    send({ id: message.id, error: { code: -32000, message: error.message } });
  }
});
`;
  writeExecutable(scriptPath, source);

  // On Windows, npm global binaries are invoked via .cmd wrappers.
  // Create a codex.cmd so the fake binary is discoverable by spawn with shell: true.
  if (process.platform === "win32") {
    const cmdWrapper = `@echo off\r\nnode "%~dp0codex" %*\r\n`;
    fs.writeFileSync(path.join(binDir, "codex.cmd"), cmdWrapper, { encoding: "utf8" });
  }
}

export function buildEnv(binDir) {
  const sep = process.platform === "win32" ? ";" : ":";
  return {
    ...process.env,
    PATH: `${binDir}${sep}${process.env.PATH}`
  };
}
