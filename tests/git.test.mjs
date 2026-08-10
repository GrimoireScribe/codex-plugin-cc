import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { collectReviewContext, resolveReviewTarget } from "../plugins/codex/scripts/lib/git.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

test("resolveReviewTarget prefers working tree when repo is dirty", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");

  const target = resolveReviewTarget(cwd, {});

  assert.equal(target.mode, "working-tree");
});

test("resolveReviewTarget falls back to branch diff when repo is clean", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "branch");
  assert.match(target.label, /main/);
  assert.match(context.content, /Branch Diff/);
});

test("git wrappers force shell: false after the caller options spread", () => {
  // Behavioral detection is masked by the quoteShellArg layer in process.mjs, so the
  // no-shell guarantee is asserted directly against the wrapper source: shell: false
  // must appear after ...options so no caller can override it.
  const source = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "codex", "scripts", "lib", "git.mjs"),
    "utf8"
  );
  assert.match(source, /runCommand\("git", args, \{ cwd, \.\.\.options, shell: false \}\)/);
  assert.match(source, /runCommandChecked\("git", args, \{ cwd, \.\.\.options, shell: false \}\)/);
});

test("default branch names with special characters are passed to git literally", () => {
  const cwd = makeTempDir();
  const branchName = "main&branch-helper&x";
  const helperOutputPath = path.join(cwd, "branch-helper-output");
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "branch-helper.cmd"), "@echo branch-helper>branch-helper-output\r\n");
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('base');\n");
  run("git", ["add", "app.js", "branch-helper.cmd"], { cwd });
  run("git", ["commit", "-m", "base"], { cwd });
  run("git", ["branch", "-m", branchName], { cwd, shell: false });
  run("git", ["update-ref", `refs/remotes/origin/${branchName}`, branchName], { cwd, shell: false });
  run("git", ["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branchName}`], {
    cwd,
    shell: false
  });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('feature');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "feature"], { cwd });

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, branchName);
  assert.match(context.content, /Branch Diff/);
  assert.equal(fs.existsSync(helperOutputPath), false);
});

test("resolveReviewTarget honors explicit base overrides", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });

  const target = resolveReviewTarget(cwd, { base: "main" });

  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, "main");
});

test("resolveReviewTarget requires an explicit base when no default branch can be inferred", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["branch", "-m", "feature-only"], { cwd });

  assert.throws(
    () => resolveReviewTarget(cwd, {}),
    /Unable to detect the repository default branch\. Pass --base <ref> or use --scope working-tree\./
  );
});

test("collectReviewContext keeps inline diffs for tiny adversarial reviews", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('INLINE_MARKER');\n");

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, "inline-diff");
  assert.equal(context.fileCount, 1);
  assert.match(context.collectionGuidance, /primary evidence/i);
  assert.match(context.content, /INLINE_MARKER/);
});

test("collectReviewContext skips untracked directories in working tree review", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });

  const nestedRepoDir = path.join(cwd, ".claude", "worktrees", "agent-test");
  fs.mkdirSync(nestedRepoDir, { recursive: true });
  initGitRepo(nestedRepoDir);

  const target = resolveReviewTarget(cwd, { scope: "working-tree" });
  const context = collectReviewContext(cwd, target);

  assert.match(context.content, /### \.claude\/worktrees\/agent-test\/\n\(skipped: directory\)/);
});

test("collectReviewContext skips broken untracked symlinks instead of crashing", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.symlinkSync("missing-target", path.join(cwd, "broken-link"));

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "working-tree");
  assert.match(context.content, /### broken-link/);
  assert.match(context.content, /skipped: broken symlink or unreadable file/i);
});

test("collectReviewContext falls back to lightweight context for larger adversarial reviews", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(cwd, name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "a.js", "b.js", "c.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), 'export const value = "SELF_COLLECT_MARKER_A";\n');
  fs.writeFileSync(path.join(cwd, "b.js"), 'export const value = "SELF_COLLECT_MARKER_B";\n');
  fs.writeFileSync(path.join(cwd, "c.js"), 'export const value = "SELF_COLLECT_MARKER_C";\n');

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.fileCount, 3);
  assert.match(context.collectionGuidance, /lightweight summary/i);
  assert.match(context.collectionGuidance, /read-only git commands/i);
  assert.doesNotMatch(context.content, /SELF_COLLECT_MARKER_[ABC]/);
  assert.match(context.content, /## Changed Files/);
});

test("collectReviewContext falls back to lightweight context for oversized single-file diffs", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 'v1';\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), `export const value = '${"x".repeat(512)}';\n`);

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target, { maxInlineDiffBytes: 128 });

  assert.equal(context.fileCount, 1);
  assert.equal(context.inputMode, "self-collect");
  assert.ok(context.diffBytes > 128);
  assert.doesNotMatch(context.content, /xxx/);
  assert.match(context.content, /## Changed Files/);
});

test("collectReviewContext keeps untracked file content in lightweight working tree context", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  for (const name of ["a.js", "b.js"]) {
    fs.writeFileSync(path.join(cwd, name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "a.js", "b.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), 'export const value = "TRACKED_MARKER_A";\n');
  fs.writeFileSync(path.join(cwd, "b.js"), 'export const value = "TRACKED_MARKER_B";\n');
  fs.writeFileSync(path.join(cwd, "new-risk.js"), 'export const value = "UNTRACKED_RISK_MARKER";\n');

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.fileCount, 3);
  assert.doesNotMatch(context.content, /TRACKED_MARKER_[AB]/);
  assert.match(context.content, /## Untracked Files/);
  assert.match(context.content, /UNTRACKED_RISK_MARKER/);
});

// --- Commit range review support -------------------------------------------------

// NOTE: helpers.run spawns with shell: true on Windows, so commit messages must stay
// single-word — a multi-word -m argument is concatenated unquoted and git reads the
// trailing words as pathspecs, silently producing no commit.
function initTwoCommitChain(cwd) {
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "base.js"), "export const base = 'v0';\n");
  run("git", ["add", "base.js"], { cwd });
  run("git", ["commit", "-m", "base"], { cwd });
  fs.writeFileSync(path.join(cwd, "first.js"), "export const first = 'FIRST_COMMIT_MARKER';\n");
  run("git", ["add", "first.js"], { cwd });
  run("git", ["commit", "-m", "first"], { cwd });
  fs.writeFileSync(path.join(cwd, "second.js"), "export const second = 'SECOND_COMMIT_MARKER';\n");
  run("git", ["add", "second.js"], { cwd });
  run("git", ["commit", "-m", "second"], { cwd });
  return {
    base: run("git", ["rev-parse", "HEAD~2"], { cwd }).stdout.trim(),
    first: run("git", ["rev-parse", "HEAD~1"], { cwd }).stdout.trim(),
    head: run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim()
  };
}

test("resolveReviewTarget keeps single-SHA commit review unchanged", () => {
  const cwd = makeTempDir();
  const shas = initTwoCommitChain(cwd);

  const target = resolveReviewTarget(cwd, { commit: shas.head });
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "commit");
  assert.equal(target.commitRef, shas.head);
  assert.equal(target.label, `commit ${shas.head}`);
  assert.match(context.content, /## Commit Diff/);
  assert.match(context.content, /SECOND_COMMIT_MARKER/);
  // The single-SHA path must still see ONLY that commit.
  assert.doesNotMatch(context.content, /FIRST_COMMIT_MARKER/);
});

test("resolveReviewTarget reviews FIRST^..HEAD as one combined range diff", () => {
  const cwd = makeTempDir();
  const shas = initTwoCommitChain(cwd);

  const target = resolveReviewTarget(cwd, { commit: `${shas.first}^..HEAD` });
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "commit-range");
  assert.equal(target.commitRange, `${shas.first}^..HEAD`);
  assert.equal(target.label, `commit range ${shas.first}^..HEAD`);
  assert.equal(context.fileCount, 2);
  assert.match(context.summary, /2 commit\(s\)/);
  assert.match(context.content, /## Combined Range Diff/);
  // Both commits' changes must be visible to the reviewer — the coverage hole this fixes.
  assert.match(context.content, /FIRST_COMMIT_MARKER/);
  assert.match(context.content, /SECOND_COMMIT_MARKER/);
});

test("resolveReviewTarget accepts an explicit two-dot SHA range", () => {
  const cwd = makeTempDir();
  const shas = initTwoCommitChain(cwd);

  const target = resolveReviewTarget(cwd, { commit: `${shas.base}..${shas.head}` });
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "commit-range");
  assert.match(context.content, /FIRST_COMMIT_MARKER/);
  assert.match(context.content, /SECOND_COMMIT_MARKER/);
});

test("resolveReviewTarget accepts a three-dot range", () => {
  const cwd = makeTempDir();
  const shas = initTwoCommitChain(cwd);

  const target = resolveReviewTarget(cwd, { commit: `${shas.base}...${shas.head}` });
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "commit-range");
  assert.equal(target.commitRange, `${shas.base}...${shas.head}`);
  assert.match(context.content, /FIRST_COMMIT_MARKER/);
  assert.match(context.content, /SECOND_COMMIT_MARKER/);
});

// Builds two branches that diverged from a shared base:
//   main:    base -> MAIN_ONLY_MARKER      (branch "main")
//   feature: base -> FEATURE_ONLY_MARKER   (branch "feature/test", checked out)
function initDivergentBranches(cwd) {
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "base.js"), "export const base = 'v0';\n");
  run("git", ["add", "base.js"], { cwd });
  run("git", ["commit", "-m", "base"], { cwd });
  const base = run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim();

  fs.writeFileSync(path.join(cwd, "main-only.js"), "export const m = 'MAIN_ONLY_MARKER';\n");
  run("git", ["add", "main-only.js"], { cwd });
  run("git", ["commit", "-m", "mainonly"], { cwd });
  const main = run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim();

  run("git", ["checkout", "-b", "feature/test", base], { cwd });
  fs.writeFileSync(path.join(cwd, "feature-only.js"), "export const f = 'FEATURE_ONLY_MARKER';\n");
  run("git", ["add", "feature-only.js"], { cwd });
  run("git", ["commit", "-m", "featureonly"], { cwd });
  const feature = run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim();

  return { base, main, feature };
}

test("three-dot range never lists a commit whose changes are absent from the diff", () => {
  // `git log A...B` is the symmetric difference while `git diff A...B` is
  // merge-base(A,B)..B. Driving both from the user's raw string would advertise the
  // left branch's commit in "Commits In Range" while its code never appears in the
  // diff — the exact partial-coverage hole this feature exists to close.
  const cwd = makeTempDir();
  const shas = initDivergentBranches(cwd);

  const target = resolveReviewTarget(cwd, { commit: `main...${shas.feature}` });
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "commit-range");
  assert.match(context.summary, /1 commit\(s\)/);
  assert.match(context.content, /FEATURE_ONLY_MARKER/);
  assert.doesNotMatch(context.content, /MAIN_ONLY_MARKER/);
  assert.doesNotMatch(context.content, /mainonly/);
  assert.match(context.content, /featureonly/);
});

test("resolveReviewTarget rejects a divergent two-dot range", () => {
  // `git diff A..B` across diverged branches also reverts A's unique work, which no
  // commit listed by `git log A..B` performed. Reject and point at the three-dot form.
  const cwd = makeTempDir();
  const shas = initDivergentBranches(cwd);

  assert.throws(
    () => resolveReviewTarget(cwd, { commit: `main..${shas.feature}` }),
    /have diverged/
  );
});

test("resolveReviewTarget rejects a range across unrelated histories", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 'v1';\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  const first = run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim();

  run("git", ["checkout", "--orphan", "orphan"], { cwd });
  fs.writeFileSync(path.join(cwd, "other.js"), "export const value = 'other';\n");
  run("git", ["add", "other.js"], { cwd });
  run("git", ["commit", "-m", "orphan"], { cwd });
  const orphan = run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim();

  assert.throws(
    () => resolveReviewTarget(cwd, { commit: `${first}...${orphan}` }),
    /no common ancestor/
  );
});

test("resolveReviewTarget falls back to lightweight context for large ranges", () => {
  const cwd = makeTempDir();
  const shas = initTwoCommitChain(cwd);

  const target = resolveReviewTarget(cwd, { commit: `${shas.first}^..HEAD` });
  const context = collectReviewContext(cwd, target, { maxInlineFiles: 1 });

  assert.equal(context.inputMode, "self-collect");
  assert.match(context.content, /## Changed Files/);
  assert.doesNotMatch(context.content, /FIRST_COMMIT_MARKER/);
});

test("resolveReviewTarget rejects a range with an unknown endpoint", () => {
  const cwd = makeTempDir();
  const shas = initTwoCommitChain(cwd);

  assert.throws(
    () => resolveReviewTarget(cwd, { commit: `deadbeefdeadbeefdeadbeefdeadbeefdeadbeef..${shas.head}` }),
    /does not resolve to a commit/
  );
  assert.throws(
    () => resolveReviewTarget(cwd, { commit: `${shas.base}..deadbeefdeadbeefdeadbeefdeadbeefdeadbeef` }),
    /does not resolve to a commit/
  );
});

test("resolveReviewTarget rejects a range whose endpoints are identical", () => {
  const cwd = makeTempDir();
  const shas = initTwoCommitChain(cwd);

  assert.throws(
    () => resolveReviewTarget(cwd, { commit: `${shas.head}..HEAD` }),
    /same commit \(empty diff\)/
  );
});

test("resolveReviewTarget rejects a reversed range", () => {
  const cwd = makeTempDir();
  const shas = initTwoCommitChain(cwd);

  assert.throws(
    () => resolveReviewTarget(cwd, { commit: `${shas.head}..${shas.base}` }),
    /endpoints are reversed/
  );
});

test("resolveReviewTarget rejects a range that changes no files", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 'v1';\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  // An empty commit advances HEAD without touching any file: a range over it is a
  // real range with a real endpoint but nothing to review.
  run("git", ["commit", "--allow-empty", "-m", "empty"], { cwd });

  assert.throws(
    () => resolveReviewTarget(cwd, { commit: "HEAD^..HEAD" }),
    /no file changes to review/
  );
});

test("resolveReviewTarget rejects a range endpoint that is not a commit", () => {
  const cwd = makeTempDir();
  const shas = initTwoCommitChain(cwd);
  const treeSha = run("git", ["rev-parse", "HEAD^{tree}"], { cwd }).stdout.trim();

  assert.throws(
    () => resolveReviewTarget(cwd, { commit: `${treeSha}..${shas.head}` }),
    /does not resolve to a commit/
  );
});

test("resolveReviewTarget rejects malformed range syntax without silently reviewing nothing", () => {
  const cwd = makeTempDir();
  initTwoCommitChain(cwd);

  // Assert on the error itself, not just "something threw". `..HEAD` and `HEAD..` are
  // not recognized as ranges at all, so they fall through to the legacy single-ref path
  // and surface git's own rev-parse failure; the rest are rejected as bad ranges. Both
  // are acceptable outcomes, but the test must be able to tell them apart.
  const expected = [
    ["..HEAD", /rev-parse|Not a valid object name|unknown revision|ambiguous/i],
    ["HEAD..", /rev-parse|Not a valid object name|unknown revision|ambiguous/i],
    ["HEAD....HEAD", /Invalid commit range/],
    ["HEAD..nope..HEAD", /Invalid commit range/]
  ];

  for (const [bad, pattern] of expected) {
    assert.throws(
      () => resolveReviewTarget(cwd, { commit: bad }),
      (error) => {
        assert.ok(error instanceof Error, `"${bad}" must throw an Error`);
        assert.match(error.message, pattern, `"${bad}" threw an unexpected message`);
        return true;
      }
    );
  }
});

test("collectReviewContext re-resolves a hand-built commit-range target", () => {
  // A target carrying only `commitRange` (no validated `range`) must not fall back to
  // driving log and diff from the raw user string.
  const cwd = makeTempDir();
  const shas = initDivergentBranches(cwd);

  const context = collectReviewContext(cwd, {
    mode: "commit-range",
    label: `commit range main...${shas.feature}`,
    commitRange: `main...${shas.feature}`,
    explicit: true
  });

  assert.match(context.content, /FEATURE_ONLY_MARKER/);
  assert.doesNotMatch(context.content, /MAIN_ONLY_MARKER/);
});
