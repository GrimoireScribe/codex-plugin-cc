import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { isFastTierReviewModel } from "../plugins/codex/scripts/codex-companion.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");

// =========================================================================
// SPEC-model-registry-refresh: GPT-6 lineup (gpt-6-astra/gpt-6-sol/gpt-6-luna), plugin
// default model/effort (overriding config.toml), and removal of the dead prior-generation
// models. These tests assert against OBSERVABLE behavior only: the argv/model/effort the
// companion actually hands to the fake `codex exec`, or the request stored in a background
// job file — never a production constant compared against itself.
// =========================================================================

function setUpRepo(behavior) {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, behavior);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return { repo, binDir };
}

function setUpDiffRepo() {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");
  return { repo, binDir };
}

function readFakeState(binDir) {
  return JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
}

function runSpecReview(repo, binDir, extraArgs, envExtra = {}) {
  const specPath = path.join(repo, "spec.md");
  const outputPath = path.join(repo, "out.md");
  fs.writeFileSync(specPath, "# Spec\n\nSome requirement.\n");
  return run(
    "node",
    [SCRIPT, "spec-adversarial-review", "--spec", specPath, "--output", outputPath, ...extraArgs],
    {
      cwd: repo,
      env: { ...buildEnv(binDir), ...envExtra }
    }
  );
}

function runScopingReview(repo, binDir, extraArgs, envExtra = {}) {
  const specPath = path.join(repo, "scoping-plan.md");
  const outputPath = path.join(repo, "out.md");
  fs.writeFileSync(specPath, "# Scoping Plan\n\nSome phase plan.\n");
  return run(
    "node",
    [SCRIPT, "scoping-adversarial-review", "--spec", specPath, "--output", outputPath, ...extraArgs],
    {
      cwd: repo,
      env: { ...buildEnv(binDir), ...envExtra }
    }
  );
}

// --- a: alias resolution and literal passthrough for unaliased names -------------------

test("model alias: --model astra|sol|luna resolve to gpt-6-*", () => {
  for (const [input, expected] of [
    ["astra", "gpt-6-astra"],
    ["sol", "gpt-6-sol"],
    ["luna", "gpt-6-luna"]
  ]) {
    const { repo, binDir } = setUpRepo();
    const result = run("node", [SCRIPT, "task", "--model", input, "diagnose the failing test"], {
      cwd: repo,
      env: buildEnv(binDir)
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFakeState(binDir).lastTurnStart.model, expected, `--model ${input}`);
  }
});

test("model alias: --model spark and --model terra pass through literally (no alias exists)", () => {
  for (const literal of ["spark", "terra"]) {
    const { repo, binDir } = setUpRepo();
    const result = run("node", [SCRIPT, "task", "--model", literal, "diagnose the failing test"], {
      cwd: repo,
      env: buildEnv(binDir)
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFakeState(binDir).lastTurnStart.model, literal, `--model ${literal} must not be rewritten`);
  }
});

// --- b: no --model/--effort on task -> plugin default (gpt-6-astra, medium) ------------

test("task with no --model/--effort resolves to the plugin default (gpt-6-astra, medium)", () => {
  const { repo, binDir } = setUpRepo();
  const result = run("node", [SCRIPT, "task", "diagnose the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  const state = readFakeState(binDir);
  assert.equal(state.lastTurnStart.model, "gpt-6-astra");
  assert.equal(state.lastTurnStart.effort, "medium");
});

// --- b2: no --model/--effort on review/adversarial-review/spec-adversarial-review/
// scoping-adversarial-review -> plugin default (gpt-6-astra, medium). Round-1 review found
// that only `task` was covered here: `review`/`adversarial-review` resolve model/effort
// inline in a callback (a mutation that reverted to the unresolved options.model there
// went uncaught), and spec/scoping only had effort-cap coverage, never a model assertion
// (a mutation that dropped resolveModel() from either handler also went uncaught). These
// four tests close that gap directly against the model the fake codex actually received.

test("review with no --model/--effort resolves to the plugin default (gpt-6-astra, medium)", () => {
  const { repo, binDir } = setUpDiffRepo();
  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  const state = readFakeState(binDir);
  assert.equal(state.lastTurnStart.model, "gpt-6-astra");
  assert.equal(state.lastTurnStart.effort, "medium");
});

test("adversarial-review with no --model/--effort resolves to the plugin default (gpt-6-astra, medium)", () => {
  const { repo, binDir } = setUpDiffRepo();
  const result = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  const state = readFakeState(binDir);
  assert.equal(state.lastTurnStart.model, "gpt-6-astra");
  assert.equal(state.lastTurnStart.effort, "medium");
});

test("spec-adversarial-review with no --model/--effort resolves to the plugin default (gpt-6-astra, medium)", () => {
  const { repo, binDir } = setUpRepo("incremental-review-complete");
  const result = runSpecReview(repo, binDir, []);
  assert.equal(result.status, 0, result.stderr);
  const state = readFakeState(binDir);
  assert.equal(state.lastTurnStart.model, "gpt-6-astra");
  assert.equal(state.lastTurnStart.effort, "medium");
});

test("scoping-adversarial-review with no --model/--effort resolves to the plugin default (gpt-6-astra, medium)", () => {
  const { repo, binDir } = setUpRepo("incremental-review-complete");
  const result = runScopingReview(repo, binDir, []);
  assert.equal(result.status, 0, result.stderr);
  const state = readFakeState(binDir);
  assert.equal(state.lastTurnStart.model, "gpt-6-astra");
  assert.equal(state.lastTurnStart.effort, "medium");
});

// --- c: CODEX_DEFAULT_MODEL / CODEX_DEFAULT_EFFORT, and explicit flags beating env ------

test("CODEX_DEFAULT_MODEL=luna and CODEX_DEFAULT_EFFORT=high resolve to gpt-6-luna + high", () => {
  const { repo, binDir } = setUpRepo();
  const result = run("node", [SCRIPT, "task", "diagnose the failing test"], {
    cwd: repo,
    env: { ...buildEnv(binDir), CODEX_DEFAULT_MODEL: "luna", CODEX_DEFAULT_EFFORT: "high" }
  });
  assert.equal(result.status, 0, result.stderr);
  const state = readFakeState(binDir);
  assert.equal(state.lastTurnStart.model, "gpt-6-luna");
  assert.equal(state.lastTurnStart.effort, "high");
});

test("an explicit --model/--effort flag beats CODEX_DEFAULT_MODEL/CODEX_DEFAULT_EFFORT", () => {
  const { repo, binDir } = setUpRepo();
  const result = run(
    "node",
    [SCRIPT, "task", "--model", "sol", "--effort", "low", "diagnose the failing test"],
    {
      cwd: repo,
      env: { ...buildEnv(binDir), CODEX_DEFAULT_MODEL: "luna", CODEX_DEFAULT_EFFORT: "high" }
    }
  );
  assert.equal(result.status, 0, result.stderr);
  const state = readFakeState(binDir);
  assert.equal(state.lastTurnStart.model, "gpt-6-sol");
  assert.equal(state.lastTurnStart.effort, "low");
});

// --- d: invalid CODEX_DEFAULT_EFFORT fails loudly ---------------------------------------

test("an invalid CODEX_DEFAULT_EFFORT fails loudly instead of being silently ignored", () => {
  const { repo, binDir } = setUpRepo();
  const result = run("node", [SCRIPT, "task", "diagnose the failing test"], {
    cwd: repo,
    env: { ...buildEnv(binDir), CODEX_DEFAULT_EFFORT: "banana" }
  });
  assert.notEqual(result.status, 0, "an invalid CODEX_DEFAULT_EFFORT must not silently fall back to a default");
  assert.match(result.stderr, /CODEX_DEFAULT_EFFORT/, "the failure must name the offending env var");
});

// --- e: review/adversarial-review accept --effort; default medium when absent ----------

test("review accepts --effort and passes it to exec", () => {
  const { repo, binDir } = setUpDiffRepo();
  const result = run("node", [SCRIPT, "review", "--effort", "high"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFakeState(binDir).lastTurnStart.effort, "high");
});

test("review defaults to medium effort when --effort is absent", () => {
  const { repo, binDir } = setUpDiffRepo();
  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFakeState(binDir).lastTurnStart.effort, "medium");
});

test("adversarial-review accepts --effort and passes it to exec", () => {
  const { repo, binDir } = setUpDiffRepo();
  const result = run("node", [SCRIPT, "adversarial-review", "--effort", "low"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFakeState(binDir).lastTurnStart.effort, "low");
});

test("adversarial-review defaults to medium effort when --effort is absent", () => {
  const { repo, binDir } = setUpDiffRepo();
  const result = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFakeState(binDir).lastTurnStart.effort, "medium");
});

// --- f: fast-tier set membership ---------------------------------------------------------

test("fast-tier set membership: gpt-6-luna, gpt-5.6-terra, gpt-5.6-luna are fast tier; gpt-6-astra, gpt-6-sol, gpt-5.6-sol are not", () => {
  assert.equal(isFastTierReviewModel("gpt-6-luna"), true);
  assert.equal(isFastTierReviewModel("gpt-5.6-terra"), true);
  assert.equal(isFastTierReviewModel("gpt-5.6-luna"), true);
  assert.equal(isFastTierReviewModel("gpt-6-astra"), false);
  assert.equal(isFastTierReviewModel("gpt-6-sol"), false);
  assert.equal(isFastTierReviewModel("gpt-5.6-sol"), false);
});

// --- g: spec/scoping effort-cap ordering --------------------------------------------------

test("spec-adversarial-review: fast-tier model with no --effort/env is capped to high", () => {
  const { repo, binDir } = setUpRepo("incremental-review-complete");
  const result = runSpecReview(repo, binDir, ["--model", "gpt-5.6-terra"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFakeState(binDir).lastTurnStart.effort, "high");
});

test("spec-adversarial-review: fast-tier model with --effort xhigh is capped to high", () => {
  const { repo, binDir } = setUpRepo("incremental-review-complete");
  const result = runSpecReview(repo, binDir, ["--model", "gpt-5.6-terra", "--effort", "xhigh"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFakeState(binDir).lastTurnStart.effort, "high");
});

test("spec-adversarial-review: non-fast-tier model with no --effort/env defaults to medium (no cap)", () => {
  const { repo, binDir } = setUpRepo("incremental-review-complete");
  const result = runSpecReview(repo, binDir, ["--model", "sol"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFakeState(binDir).lastTurnStart.effort, "medium");
});

test("spec-adversarial-review: fast-tier model with CODEX_DEFAULT_EFFORT=xhigh env (no flag) is still capped to high", () => {
  const { repo, binDir } = setUpRepo("incremental-review-complete");
  const result = runSpecReview(repo, binDir, ["--model", "luna"], { CODEX_DEFAULT_EFFORT: "xhigh" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFakeState(binDir).lastTurnStart.effort, "high");
});

// This case is the one that actually distinguishes "env counts as caller-supplied" from
// "no flag/env falls through to the null-forces-high branch": capFastTierReviewEffort only
// forces "high" when the incoming effort is null or xhigh, so an xhigh env value produces
// "high" either way and would not catch a resolver that silently drops the env layer. A
// non-high/xhigh env value (low) is passed straight through untouched only if the env value
// actually reaches the cap function as the caller-supplied effort.
test("spec-adversarial-review: fast-tier model with CODEX_DEFAULT_EFFORT=low env (no flag) respects the caller-supplied low", () => {
  const { repo, binDir } = setUpRepo("incremental-review-complete");
  const result = runSpecReview(repo, binDir, ["--model", "luna"], { CODEX_DEFAULT_EFFORT: "low" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFakeState(binDir).lastTurnStart.effort, "low");
});

// --- g2: scoping-adversarial-review shares the same effort-cap ordering as spec. Round-1
// review found scoping-adversarial-review had NO tests of its own at all (only spec did),
// so a mutation reverting the scoping handler specifically (as opposed to the spec handler)
// went uncaught. These mirror the two core spec cap cases against the scoping subcommand.

test("scoping-adversarial-review: fast-tier model with no --effort/env is capped to high", () => {
  const { repo, binDir } = setUpRepo("incremental-review-complete");
  const result = runScopingReview(repo, binDir, ["--model", "gpt-5.6-terra"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFakeState(binDir).lastTurnStart.effort, "high");
});

test("scoping-adversarial-review: non-fast-tier model with no --effort/env defaults to medium (no cap)", () => {
  const { repo, binDir } = setUpRepo("incremental-review-complete");
  const result = runScopingReview(repo, binDir, ["--model", "sol"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFakeState(binDir).lastTurnStart.effort, "medium");
});

// --- h: background task job stores the resolved model/effort -----------------------------

test("a background task job stores the resolved model/effort for the worker to re-run", async () => {
  const { repo, binDir } = setUpRepo("slow-task");

  const launched = run(
    "node",
    [SCRIPT, "task", "--background", "--json", "--model", "luna", "investigate the failing test"],
    {
      cwd: repo,
      env: buildEnv(binDir)
    }
  );
  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.match(launchPayload.jobId, /^task-/);

  const waited = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--json"],
    { cwd: repo, env: buildEnv(binDir) }
  );
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).job.status, "completed");

  const resultRun = run("node", [SCRIPT, "result", launchPayload.jobId, "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(resultRun.status, 0, resultRun.stderr);
  const resultPayload = JSON.parse(resultRun.stdout);
  assert.equal(resultPayload.storedJob.request.model, "gpt-6-luna");
  assert.equal(resultPayload.storedJob.request.effort, "medium");

  // The value actually launched at the fake codex must match the stored request --
  // proof the worker re-ran with the resolved values rather than re-resolving.
  const state = readFakeState(binDir);
  assert.equal(state.lastTurnStart.model, "gpt-6-luna");
  assert.equal(state.lastTurnStart.effort, "medium");
});
