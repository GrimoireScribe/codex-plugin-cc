function severityRank(severity) {
  switch (severity) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    default:
      return 3;
  }
}

function formatLineRange(finding) {
  if (!finding.line_start) {
    return "";
  }
  if (!finding.line_end || finding.line_end === finding.line_start) {
    return `:${finding.line_start}`;
  }
  return `:${finding.line_start}-${finding.line_end}`;
}

// Graph MCP tools whose presence in `tools_used` witnesses a graph-grounded review.
// Matched as substrings so `mcp__code-review-graph__get_impact_radius` counts.
const GRAPH_TOOL_MARKERS = [
  "get_review_context",
  "get_affected_flows",
  "get_impact_radius",
  "query_graph",
  "list_communities",
  "get_architecture_overview"
];

// Scopes that assert the reviewer went beyond the provided artifact. These are the
// scopes the deep tier's mandatory graph-first step is supposed to produce.
const WIDER_SCOPES = new Set(["targeted-repository", "repository-wide"]);

function isNonEmptyString(value) {
  return typeof value === "string" && Boolean(value.trim());
}

function validateReviewEvidenceShape(evidence) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return "Missing object `review_evidence`.";
  }
  if (!isNonEmptyString(evidence.scope)) {
    return "Missing string `review_evidence.scope`.";
  }
  if (!Array.isArray(evidence.files_examined) || evidence.files_examined.length === 0) {
    return "Missing non-empty array `review_evidence.files_examined`.";
  }
  if (!Array.isArray(evidence.checks_performed) || evidence.checks_performed.length === 0) {
    return "Missing non-empty array `review_evidence.checks_performed`.";
  }
  for (const [index, entry] of evidence.checks_performed.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return `\`review_evidence.checks_performed[${index}]\` is not an object.`;
    }
    if (!isNonEmptyString(entry.check)) {
      return `Missing string \`review_evidence.checks_performed[${index}].check\`.`;
    }
    if (!Array.isArray(entry.evidence) || !entry.evidence.some((item) => isNonEmptyString(item))) {
      return `Missing non-empty array \`review_evidence.checks_performed[${index}].evidence\`.`;
    }
  }
  if (!Array.isArray(evidence.tools_used)) {
    return "Missing array `review_evidence.tools_used`.";
  }
  if (!Array.isArray(evidence.limitations)) {
    return "Missing array `review_evidence.limitations`.";
  }
  return null;
}

function validateReviewResultShape(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "Expected a top-level JSON object.";
  }
  if (typeof data.verdict !== "string" || !data.verdict.trim()) {
    return "Missing string `verdict`.";
  }
  if (typeof data.summary !== "string" || !data.summary.trim()) {
    return "Missing string `summary`.";
  }
  if (!Array.isArray(data.findings)) {
    return "Missing array `findings`.";
  }
  if (!Array.isArray(data.next_steps)) {
    return "Missing array `next_steps`.";
  }
  return validateReviewEvidenceShape(data.review_evidence);
}

// A wider-than-artifact scope claim is the deep tier's graph-grounded claim. Treat it as
// unwitnessed unless `tools_used` names a graph tool or `limitations` documents the
// failure/fallback. A self-report is disclosure, not proof — this only flags the gap.
export function auditGraphWitness(evidence) {
  const warnings = [];
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return warnings;
  }
  const scope = isNonEmptyString(evidence.scope) ? evidence.scope.trim() : "";
  if (!WIDER_SCOPES.has(scope)) {
    return warnings;
  }
  const tools = Array.isArray(evidence.tools_used) ? evidence.tools_used : [];
  const hasGraphCall = tools.some(
    (tool) => isNonEmptyString(tool) && GRAPH_TOOL_MARKERS.some((marker) => tool.includes(marker))
  );
  if (hasGraphCall) {
    return warnings;
  }
  const limitations = Array.isArray(evidence.limitations) ? evidence.limitations : [];
  const documentsFallback = limitations.some(
    (item) => isNonEmptyString(item) && /graph/i.test(item)
  );
  if (documentsFallback) {
    return warnings;
  }
  warnings.push(
    `Scope claims \`${scope}\` but \`tools_used\` names no graph tool and \`limitations\` documents no graph failure or fallback. Treat the wider-scope claim as unwitnessed.`
  );
  return warnings;
}

function normalizeReviewFinding(finding, index) {
  const source = finding && typeof finding === "object" && !Array.isArray(finding) ? finding : {};
  const lineStart = Number.isInteger(source.line_start) && source.line_start > 0 ? source.line_start : null;
  const lineEnd =
    Number.isInteger(source.line_end) && source.line_end > 0 && (!lineStart || source.line_end >= lineStart)
      ? source.line_end
      : lineStart;

  return {
    severity: typeof source.severity === "string" && source.severity.trim() ? source.severity.trim() : "low",
    title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : `Finding ${index + 1}`,
    body: typeof source.body === "string" && source.body.trim() ? source.body.trim() : "No details provided.",
    file: typeof source.file === "string" && source.file.trim() ? source.file.trim() : "unknown",
    line_start: lineStart,
    line_end: lineEnd,
    confidence: typeof source.confidence === "number" && Number.isFinite(source.confidence) ? source.confidence : null,
    severity_rationale: isNonEmptyString(source.severity_rationale) ? source.severity_rationale.trim() : "",
    corrective_invariant: isNonEmptyString(source.corrective_invariant) ? source.corrective_invariant.trim() : "",
    recommendation: typeof source.recommendation === "string" ? source.recommendation.trim() : "",
    fix_confidence: isNonEmptyString(source.fix_confidence) ? source.fix_confidence.trim() : "",
    trigger_conditions: isNonEmptyString(source.trigger_conditions) ? source.trigger_conditions.trim() : ""
  };
}

function normalizeReviewEvidence(evidence) {
  return {
    scope: evidence.scope.trim(),
    files_examined: evidence.files_examined.filter((item) => isNonEmptyString(item)).map((item) => item.trim()),
    checks_performed: evidence.checks_performed.map((entry) => ({
      check: entry.check.trim(),
      evidence: entry.evidence.filter((item) => isNonEmptyString(item)).map((item) => item.trim())
    })),
    tools_used: evidence.tools_used.filter((item) => isNonEmptyString(item)).map((item) => item.trim()),
    limitations: evidence.limitations.filter((item) => isNonEmptyString(item)).map((item) => item.trim())
  };
}

function normalizeReviewResultData(data) {
  return {
    verdict: data.verdict.trim(),
    summary: data.summary.trim(),
    review_evidence: normalizeReviewEvidence(data.review_evidence),
    findings: data.findings.map((finding, index) => normalizeReviewFinding(finding, index)),
    next_steps: data.next_steps
      .filter((step) => typeof step === "string" && step.trim())
      .map((step) => step.trim())
  };
}

function isStructuredReviewStoredResult(storedJob) {
  const result = storedJob?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  return (
    Object.prototype.hasOwnProperty.call(result, "result") ||
    Object.prototype.hasOwnProperty.call(result, "parseError")
  );
}

function formatJobLine(job) {
  const parts = [job.id, `${job.status || "unknown"}`];
  if (job.kindLabel) {
    parts.push(job.kindLabel);
  }
  if (job.title) {
    parts.push(job.title);
  }
  return parts.join(" | ");
}

function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function formatCodexResumeCommand(job) {
  if (!job?.threadId) {
    return null;
  }
  return `codex resume ${job.threadId}`;
}

function appendActiveJobsTable(lines, jobs) {
  lines.push("Active jobs:");
  lines.push("| Job | Kind | Status | Phase | Elapsed | Codex Session ID | Summary | Actions |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const job of jobs) {
    const actions = [`/codex:status ${job.id}`];
    if (job.status === "queued" || job.status === "running") {
      actions.push(`/codex:cancel ${job.id}`);
    }
    lines.push(
      `| ${escapeMarkdownCell(job.id)} | ${escapeMarkdownCell(job.kindLabel)} | ${escapeMarkdownCell(job.status)} | ${escapeMarkdownCell(job.phase ?? "")} | ${escapeMarkdownCell(job.elapsed ?? "")} | ${escapeMarkdownCell(job.threadId ?? "")} | ${escapeMarkdownCell(job.summary ?? "")} | ${actions.map((action) => `\`${action}\``).join("<br>")} |`
    );
  }
}

function pushJobDetails(lines, job, options = {}) {
  lines.push(`- ${formatJobLine(job)}`);
  if (job.summary) {
    lines.push(`  Summary: ${job.summary}`);
  }
  if (job.phase) {
    lines.push(`  Phase: ${job.phase}`);
  }
  if (options.showElapsed && job.elapsed) {
    lines.push(`  Elapsed: ${job.elapsed}`);
  }
  if (options.showDuration && job.duration) {
    lines.push(`  Duration: ${job.duration}`);
  }
  if (job.threadId) {
    lines.push(`  Codex session ID: ${job.threadId}`);
  }
  const resumeCommand = formatCodexResumeCommand(job);
  if (resumeCommand) {
    lines.push(`  Resume in Codex: ${resumeCommand}`);
  }
  if (job.logFile && options.showLog) {
    lines.push(`  Log: ${job.logFile}`);
  }
  if ((job.status === "queued" || job.status === "running") && options.showCancelHint) {
    lines.push(`  Cancel: /codex:cancel ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && options.showResultHint) {
    lines.push(`  Result: /codex:result ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && job.jobClass === "task" && job.write && options.showReviewHint) {
    lines.push("  Review changes: /codex:review --wait");
    lines.push("  Stricter review: /codex:adversarial-review --wait");
  }
  if (job.progressPreview?.length) {
    lines.push("  Progress:");
    for (const line of job.progressPreview) {
      lines.push(`    ${line}`);
    }
  }
}

// Member 4 of the review-evidence contract: the evidence must reach the review DOCUMENT,
// not just the JSON. A judge reads the rendered Markdown, so a clearance's scope, checks,
// and limitations have to be visible here or the contract is lost at the last hop.
function appendReviewEvidenceSection(lines, evidence) {
  lines.push("## Review Evidence", "");
  lines.push(`- Scope: ${evidence.scope}`);
  lines.push(`- Files examined (${evidence.files_examined.length}):`);
  for (const file of evidence.files_examined) {
    lines.push(`  - ${file}`);
  }
  lines.push("- Checks performed:");
  for (const entry of evidence.checks_performed) {
    lines.push(`  - ${entry.check}`);
    for (const item of entry.evidence) {
      lines.push(`    - Evidence: ${item}`);
    }
  }
  lines.push(`- Tools used: ${evidence.tools_used.length > 0 ? evidence.tools_used.join(", ") : "none"}`);
  if (evidence.limitations.length > 0) {
    lines.push("- Limitations:");
    for (const limitation of evidence.limitations) {
      lines.push(`  - ${limitation}`);
    }
  } else {
    lines.push("- Limitations: none recorded");
  }

  const warnings = auditGraphWitness(evidence);
  for (const warning of warnings) {
    lines.push(`- [PLUGIN-EVIDENCE-WARNING] ${warning}`);
  }

  lines.push("");
}

function appendReasoningSection(lines, reasoningSummary) {
  if (!Array.isArray(reasoningSummary) || reasoningSummary.length === 0) {
    return;
  }

  lines.push("", "Reasoning:");
  for (const section of reasoningSummary) {
    lines.push(`- ${section}`);
  }
}

export function renderSetupReport(report) {
  const lines = [
    "# Codex Setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- node: ${report.node.detail}`,
    `- npm: ${report.npm.detail}`,
    `- codex: ${report.codex.detail}`,
    `- auth: ${report.auth.detail}`,
    `- session runtime: ${report.sessionRuntime.label}`,
    `- review gate: ${report.reviewGateEnabled ? "enabled" : "disabled"}`,
    ""
  ];

  if (report.actionsTaken.length > 0) {
    lines.push("Actions taken:");
    for (const action of report.actionsTaken) {
      lines.push(`- ${action}`);
    }
    lines.push("");
  }

  if (report.nextSteps.length > 0) {
    lines.push("Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderReviewResult(parsedResult, meta) {
  if (!parsedResult.parsed) {
    const lines = [
      `# Codex ${meta.reviewLabel}`,
      "",
      "Codex did not return valid structured JSON.",
      "",
      `- Parse error: ${parsedResult.parseError}`
    ];

    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }

    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);

    return `${lines.join("\n").trimEnd()}\n`;
  }

  const validationError = validateReviewResultShape(parsedResult.parsed);
  if (validationError) {
    const lines = [
      `# Codex ${meta.reviewLabel}`,
      "",
      `Target: ${meta.targetLabel}`,
      "Codex returned JSON with an unexpected review shape.",
      "",
      `- Validation error: ${validationError}`
    ];

    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }

    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);

    return `${lines.join("\n").trimEnd()}\n`;
  }

  const data = normalizeReviewResultData(parsedResult.parsed);
  const findings = [...data.findings].sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
  const lines = [
    `# Codex ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    `Verdict: ${data.verdict}`,
    "",
    data.summary,
    ""
  ];

  appendReviewEvidenceSection(lines, data.review_evidence);

  if (findings.length === 0) {
    lines.push("No material findings.");
  } else {
    lines.push("Findings:");
    for (const finding of findings) {
      const lineSuffix = formatLineRange(finding);
      lines.push(`- [${finding.severity}] ${finding.title} (${finding.file}${lineSuffix})`);
      lines.push(`  ${finding.body}`);
      if (finding.confidence !== null) {
        lines.push(`  Confidence: ${finding.confidence}`);
      }
      if (finding.severity_rationale) {
        lines.push(`  Severity rationale: ${finding.severity_rationale}`);
      }
      if (finding.trigger_conditions) {
        lines.push(`  Trigger conditions: ${finding.trigger_conditions}`);
      }
      if (finding.corrective_invariant) {
        lines.push(`  Corrective invariant: ${finding.corrective_invariant}`);
      }
      if (finding.recommendation) {
        lines.push(`  Recommendation: ${finding.recommendation}`);
      }
      if (finding.fix_confidence) {
        lines.push(`  Fix confidence: ${finding.fix_confidence}`);
      }
    }
  }

  if (data.next_steps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of data.next_steps) {
      lines.push(`- ${step}`);
    }
  }

  appendReasoningSection(lines, meta.reasoningSummary);

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderNativeReviewResult(result, meta) {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  const lines = [
    `# Codex ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    ""
  ];

  if (stdout) {
    lines.push(stdout);
  } else if (result.status === 0) {
    lines.push("Codex review completed without any stdout output.");
  } else {
    lines.push("Codex review failed.");
  }

  if (stderr) {
    lines.push("", "stderr:", "", "```text", stderr, "```");
  }

  appendReasoningSection(lines, meta.reasoningSummary);

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderTaskResult(parsedResult, meta) {
  const diagnostics = [];
  if (meta?.sandboxMode) {
    diagnostics.push(`Sandbox: ${meta.sandboxMode}`);
  }
  if (Array.isArray(meta?.mcpToolFailures) && meta.mcpToolFailures.length > 0) {
    diagnostics.push(
      `MCP tool failures: ${meta.mcpToolFailures.map((item) => `${item.label} (${item.status})`).join(", ")}`
    );
  }
  if (Array.isArray(meta?.dynamicToolFailures) && meta.dynamicToolFailures.length > 0) {
    diagnostics.push(
      `Tool failures: ${meta.dynamicToolFailures.map((item) => `${item.label} (${item.status})`).join(", ")}`
    );
  }
  if (Array.isArray(meta?.commandFailures) && meta.commandFailures.length > 0) {
    diagnostics.push(
      `Command failures: ${meta.commandFailures
        .map((item) => `${item.command || "unknown command"} (${item.status}${item.exitCode == null ? "" : `, exit ${item.exitCode}`})`)
        .join(", ")}`
    );
  }

  let expectedBlock = "";
  if (Array.isArray(meta?.expectedFiles) && meta.expectedFiles.length > 0) {
    const lines = meta.expectedFiles.map((f) => {
      if (f.status === "PRESENT") return `- PRESENT (${f.size} bytes): ${f.path}`;
      if (f.status === "EMPTY") return `- EMPTY (0 bytes): ${f.path}`;
      return `- MISSING${f.error ? ` (${f.error})` : ""}: ${f.path}`;
    });
    expectedBlock = `[EXPECTED-FILES]\n${lines.join("\n")}\n`;
    if (meta.verificationMessage) {
      expectedBlock += `- ${meta.verificationMessage}\n`;
    }
    expectedBlock += "\n";
  }

  const rawOutput = typeof parsedResult?.rawOutput === "string" ? parsedResult.rawOutput : "";
  const saveOutput = parsedResult?.saveOutput ?? null;
  const completionMarkerMissing = parsedResult?.completionMarkerMissing ?? false;
  let saveBlock = "";
  if (saveOutput) {
    saveBlock = `${saveOutput.message}\n\n`;
  }
  // Warn when a save path was resolved but the completion marker is absent — indicates
  // the review overflowed before finishing, or the companion write failed. Does NOT
  // assert "file written" because saveOutput.ok may be false (failed write).
  const markerWarning = completionMarkerMissing
    ? "[PLUGIN-INCOMPLETE] <!-- REVIEW COMPLETE --> marker missing from output file. The review either overflowed before finishing or the write failed — treat the output file as partial. Stall-reroute should re-run.\n\n"
    : "";
  const diagnosticPrefix =
    diagnostics.length > 0 ? `[PLUGIN-DIAGNOSTICS]\n- ${diagnostics.join("\n- ")}\n\n` : "";
  if (rawOutput) {
    const output = rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
    return `${diagnosticPrefix}${markerWarning}${saveBlock}${expectedBlock}${output}`;
  }

  const message = String(parsedResult?.failureMessage ?? "").trim() || "Codex did not return a final message.";
  return `${diagnosticPrefix}${markerWarning}${saveBlock}${expectedBlock}${message}\n`;
}

export function renderStatusReport(report) {
  const lines = [
    "# Codex Status",
    "",
    `Session runtime: ${report.sessionRuntime.label}`,
    `Review gate: ${report.config.stopReviewGate ? "enabled" : "disabled"}`,
    ""
  ];

  if (report.running.length > 0) {
    appendActiveJobsTable(lines, report.running);
    lines.push("");
    lines.push("Live details:");
    for (const job of report.running) {
      pushJobDetails(lines, job, {
        showElapsed: true,
        showLog: true
      });
    }
    lines.push("");
  }

  if (report.latestFinished) {
    lines.push("Latest finished:");
    pushJobDetails(lines, report.latestFinished, {
      showDuration: true,
      showLog: report.latestFinished.status === "failed"
    });
    lines.push("");
  }

  if (report.recent.length > 0) {
    lines.push("Recent jobs:");
    for (const job of report.recent) {
      pushJobDetails(lines, job, {
        showDuration: true,
        showLog: job.status === "failed"
      });
    }
    lines.push("");
  } else if (report.running.length === 0 && !report.latestFinished) {
    lines.push("No jobs recorded yet.", "");
  }

  if (report.needsReview) {
    lines.push("The stop-time review gate is enabled.");
    lines.push("Ending the session will trigger a fresh Codex adversarial review and block if it finds issues.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderJobStatusReport(job) {
  const lines = ["# Codex Job Status", ""];
  pushJobDetails(lines, job, {
    showElapsed: job.status === "queued" || job.status === "running",
    showDuration: job.status !== "queued" && job.status !== "running",
    showLog: true,
    showCancelHint: true,
    showResultHint: true,
    showReviewHint: true
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderStoredJobResult(job, storedJob) {
  const threadId = storedJob?.threadId ?? job.threadId ?? null;
  const resumeCommand = threadId ? `codex resume ${threadId}` : null;
  if (isStructuredReviewStoredResult(storedJob) && storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nCodex session ID: ${threadId}\nResume in Codex: ${resumeCommand}\n`;
  }

  const rawOutput =
    (typeof storedJob?.result?.rawOutput === "string" && storedJob.result.rawOutput) ||
    (typeof storedJob?.result?.codex?.stdout === "string" && storedJob.result.codex.stdout) ||
    "";
  if (rawOutput) {
    const output = rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nCodex session ID: ${threadId}\nResume in Codex: ${resumeCommand}\n`;
  }

  if (storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nCodex session ID: ${threadId}\nResume in Codex: ${resumeCommand}\n`;
  }

  const lines = [
    `# ${job.title ?? "Codex Result"}`,
    "",
    `Job: ${job.id}`,
    `Status: ${job.status}`
  ];

  if (threadId) {
    lines.push(`Codex session ID: ${threadId}`);
    lines.push(`Resume in Codex: ${resumeCommand}`);
  }

  if (job.summary) {
    lines.push(`Summary: ${job.summary}`);
  }

  if (job.errorMessage) {
    lines.push("", job.errorMessage);
  } else if (storedJob?.errorMessage) {
    lines.push("", storedJob.errorMessage);
  } else {
    lines.push("", "No captured result payload was stored for this job.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderCancelReport(job) {
  const lines = [
    "# Codex Cancel",
    "",
    `Cancelled ${job.id}.`,
    ""
  ];

  if (job.title) {
    lines.push(`- Title: ${job.title}`);
  }
  if (job.summary) {
    lines.push(`- Summary: ${job.summary}`);
  }
  lines.push("- Check `/codex:status` for the updated queue.");

  return `${lines.join("\n").trimEnd()}\n`;
}
