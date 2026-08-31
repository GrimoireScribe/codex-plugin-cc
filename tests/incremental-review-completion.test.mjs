import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

const MARKER = "<!-- REVIEW COMPLETE -->";

// =========================================================================
// PM#2011 V3-e, 2026-08-31. A DEEP-tier spec review was killed by the 60s
// finalization timer while the model deliberated on the Section 5 evidence
// block. runCodexExecTask resolves a finalization kill to exit 0, and
// decideTaskExit only asserts that the declared output path EXISTS -- never
// that it is complete. The companion therefore exited 0 on a review that
// stopped after Section 4, and POAgent's wrapper (which publishes on exit 0)
// promoted the fragment to the canonical artifact name. Cycles are immutable,
// so the two complete re-runs that followed could never be published.
//
// The contract these tests pin: for incremental-write reviews, a missing
// completion marker is a FAILING exit, regardless of the file existing and
// regardless of the CLI reporting success.
// =========================================================================

function setUpRepoAndCodex(behavior) {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, behavior);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return { repo, binDir };
}

function runSpecReview(behavior, subcommand = "spec-adversarial-review") {
  const { repo, binDir } = setUpRepoAndCodex(behavior);
  const specPath = path.join(repo, "spec.md");
  const outputPath = path.join(repo, "out.md");
  fs.writeFileSync(specPath, "# Spec\n\nSome requirement.\n");

  const result = run("node", [SCRIPT, subcommand, "--spec", specPath, "--output", outputPath], {
    cwd: repo,
    env: buildEnv(binDir),
    shell: false
  });
  return { result, outputPath };
}

test("spec review: truncated review (no completion marker) exits nonzero even though the CLI exited 0", () => {
  const { result, outputPath } = runSpecReview("incremental-review-truncated");

  // The fake CLI wrote a real file and exited 0 -- the exact shape of the incident.
  assert.ok(fs.existsSync(outputPath), "the partial review must be on disk (that is the trap)");
  const written = fs.readFileSync(outputPath, "utf8");
  assert.ok(!written.includes(MARKER), "fixture must produce a review with no completion marker");
  assert.ok(written.includes("## 4 Medium and Low Findings"), "fixture must look like a plausible review");

  assert.notEqual(result.status, 0, "a review with no completion marker must not exit 0");
});

// This asserts the NEW verification line, not the pre-existing renderer warning about
// completionMarkerMissing. That warning was already printed before this fix and would keep
// printing if the exit-code change were reverted, so matching it would prove nothing.
test("spec review: the incomplete-review failure explains that the artifact must not be published", () => {
  const { result } = runSpecReview("incremental-review-truncated");
  const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.match(combined, /Incremental review is incomplete/, "the failure must name the missing marker");
  assert.match(combined, /do not publish it/, "the failure must tell the caller not to publish");
});

test("scoping review: truncated review (no completion marker) exits nonzero", () => {
  const { result } = runSpecReview("incremental-review-truncated", "scoping-adversarial-review");
  assert.notEqual(result.status, 0, "the scoping path shares the incremental-write contract");
});

// Falsification control. Without this, the two tests above would still pass if the
// companion simply started failing every review -- which would be a worse regression
// than the one being fixed.
test("spec review: a complete review (marker present) still exits 0", () => {
  const { result, outputPath } = runSpecReview("incremental-review-complete");

  const written = fs.readFileSync(outputPath, "utf8");
  assert.ok(written.includes(MARKER), "fixture must produce a review carrying the marker");
  assert.equal(result.status, 0, "a complete review must still succeed");
});
