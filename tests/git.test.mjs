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

test("every revision-taking git diff routes through the -- / --no-relative guard", () => {
  // Two failure modes are only reachable in environments awkward to build in a unit test,
  // so the guarantee is asserted against the source the way the shell: false rule is.
  //
  // 1. ENAMETOOLONG. git stat()s a bare revision argument to disambiguate revision from
  //    path. When repo_path + 1 + range_string exceeds the platform limit (260 on
  //    Windows) the stat fails and git ABORTS rather than falling back to revision
  //    parsing: "fatal: failed to stat '<A>..<B>': Filename too long". A SHA-256 repo has
  //    130-char ranges, so any checkout deeper than ~130 chars trips it — ordinary for
  //    OneDrive paths and nested CI checkouts. Reproduced at a 132-char path: bare token
  //    aborts, `--` succeeds.
  // 2. diff.relative=true scopes the diff to the cwd, which can make a valid range look
  //    empty and get it wrongly rejected. `--no-relative` defeats it.
  const source = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "codex", "scripts", "lib", "git.mjs"),
    "utf8"
  );
  assert.match(source, /function diffRevisionArgs\(revisions\) \{\s*return \["--no-relative", \.\.\.revisions, "--"\];/);

  // No `git diff` may take a revision without going through the helper. Flag any diff
  // invocation that references a range/SHA variable but not diffRevisionArgs.
  const offenders = [];
  for (const line of source.split("\n")) {
    if (!/\["diff"/.test(line)) {
      continue;
    }
    if (/diffRevisionArgs/.test(line)) {
      continue;
    }
    // Working-tree diffs legitimately take no revision at all.
    if (/(commitRange|diffRange|Revisions|Sha|commitRef)/.test(line)) {
      offenders.push(line.trim());
    }
  }
  assert.deepEqual(offenders, [], "these git diff calls pass a revision without the -- / --no-relative guard");
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
    /leave no net change/
  );
});

test("resolveReviewTarget names the cause when a range's commits cancel out", () => {
  // A real fix cycle that nets to zero (change, then revert) must not be reported as
  // "no commits" — the reviewer's operator needs to know the commits exist but cancel.
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 'v1';\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 'v2';\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });
  const first = run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim();
  run("git", ["revert", "--no-edit", first], { cwd });

  assert.throws(
    () => resolveReviewTarget(cwd, { commit: `${first}^..HEAD` }),
    /2 commit\(s\) leave no net change/
  );
});

test("commit range annotates a commit whose changes are undone later in the range", () => {
  // The combined diff is the NET effect of the range, so a commit reverted inside the
  // range legitimately has nothing in the diff. It still appears in the commit list, so
  // it must be labelled — otherwise the reviewer believes it reviewed that commit.
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "base.js"), "export const base = 'v0';\n");
  run("git", ["add", "base.js"], { cwd });
  run("git", ["commit", "-m", "base"], { cwd });
  fs.writeFileSync(path.join(cwd, "risky.js"), "export const bypass = 'BAD_AUTH_BYPASS';\n");
  run("git", ["add", "risky.js"], { cwd });
  run("git", ["commit", "-m", "risky"], { cwd });
  const risky = run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim();
  fs.rmSync(path.join(cwd, "risky.js"));
  fs.writeFileSync(path.join(cwd, "safe.js"), "export const safe = 'SAFE_MARKER';\n");
  run("git", ["add", "-A"], { cwd });
  run("git", ["commit", "-m", "fix"], { cwd });

  const target = resolveReviewTarget(cwd, { commit: `${risky}^..HEAD` });
  const context = collectReviewContext(cwd, target);

  assert.match(context.content, /SAFE_MARKER/);
  // The risky commit's content is genuinely absent from the net diff...
  assert.doesNotMatch(context.content, /BAD_AUTH_BYPASS/);
  // ...so the commit list must say so rather than implying it was reviewed.
  assert.match(context.content, /no net contribution/);
  assert.match(context.content, /NET effect/);
});

test("commit range resolves correctly when invoked from a subdirectory", () => {
  // `git diff` honors diff.relative, which scopes output to the cwd. Probing the range
  // anywhere but the repo root made a valid range look empty and rejected it.
  const cwd = makeTempDir();
  initGitRepo(cwd);
  run("git", ["config", "diff.relative", "true"], { cwd });
  fs.mkdirSync(path.join(cwd, "top"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "sub"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "sub", "keep.js"), "export const keep = 1;\n");
  fs.writeFileSync(path.join(cwd, "top", "app.js"), "export const value = 'v1';\n");
  run("git", ["add", "-A"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "top", "app.js"), "export const value = 'SUBDIR_MARKER';\n");
  run("git", ["add", "-A"], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });
  const first = run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim();

  const subdir = path.join(cwd, "sub");
  const target = resolveReviewTarget(subdir, { commit: `${first}^..HEAD` });
  const context = collectReviewContext(subdir, target);

  assert.equal(target.mode, "commit-range");
  assert.match(context.content, /SUBDIR_MARKER/);
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

test("single-SHA review of a root commit diffs against the empty tree", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 'ROOT_COMMIT_MARKER';\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  const root = run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim();

  const target = resolveReviewTarget(cwd, { commit: root });
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "commit");
  assert.match(context.summary, /root commit/);
  assert.match(context.content, /ROOT_COMMIT_MARKER/);
});

test("ROOT^..HEAD reviews a first ship instead of failing on the missing parent", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "a.js"), "export const a = 'FIRST_SHIP_A';\n");
  run("git", ["add", "a.js"], { cwd });
  run("git", ["commit", "-m", "one"], { cwd });
  const root = run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim();
  fs.writeFileSync(path.join(cwd, "b.js"), "export const b = 'FIRST_SHIP_B';\n");
  run("git", ["add", "b.js"], { cwd });
  run("git", ["commit", "-m", "two"], { cwd });

  const target = resolveReviewTarget(cwd, { commit: `${root}^..HEAD` });
  const context = collectReviewContext(cwd, target, { maxInlineFiles: 5 });

  assert.equal(target.mode, "commit-range");
  assert.match(context.content, /FIRST_SHIP_A/);
  assert.match(context.content, /FIRST_SHIP_B/);
});

test("a shallow-clone boundary commit is refused, not treated as a root commit", () => {
  // `rev-parse <sha>^` and `rev-list --max-parents=0` are both fooled by the graft: they
  // report a real commit as parentless. Treating it as a root would diff it against the
  // empty tree and present whole files as newly created — a silent wrong answer where
  // git previously failed loudly.
  const origin = makeTempDir();
  initGitRepo(origin);
  fs.writeFileSync(path.join(origin, "app.js"), "line1\n");
  run("git", ["add", "app.js"], { cwd: origin });
  run("git", ["commit", "-m", "one"], { cwd: origin });
  fs.writeFileSync(path.join(origin, "app.js"), "line1\nSHALLOW_ADDED_LINE\n");
  run("git", ["add", "app.js"], { cwd: origin });
  run("git", ["commit", "-m", "two"], { cwd: origin });

  const clone = path.join(makeTempDir(), "shallow");
  const originUrl = `file:///${origin.replace(/\\/g, "/")}`;
  const cloneResult = run("git", ["clone", "--depth", "1", originUrl, clone], { cwd: origin });
  if (cloneResult.status !== 0) {
    return; // shallow clone unsupported in this environment; nothing to assert
  }

  // Precondition: the clone really is shallow, and both of the oracles one would reach
  // for first are fooled by the graft — `rev-parse HEAD^` happily returns the parent SHA
  // read out of the commit header even though that object is absent, and
  // `rev-list --max-parents=0` names the boundary commit as the root.
  assert.equal(run("git", ["rev-parse", "--is-shallow-repository"], { cwd: clone }).stdout.trim(), "true");
  const head = run("git", ["rev-parse", "HEAD"], { cwd: clone }).stdout.trim();
  assert.equal(run("git", ["rev-parse", "--verify", "HEAD^"], { cwd: clone }).status, 0);
  assert.equal(run("git", ["rev-list", "--max-parents=0", "-n1", "HEAD"], { cwd: clone }).stdout.trim(), head);

  assert.throws(
    () => resolveReviewTarget(clone, { commit: "HEAD" }),
    /shallow clone/
  );
});

test("single-SHA review of an ordinary merge commit still works", () => {
  // The empty-diff guard must not reject ordinary merges: a --no-ff merge of a diverged
  // branch has a NON-empty first-parent diff.
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "base.js"), "export const base = 0;\n");
  run("git", ["add", "base.js"], { cwd });
  run("git", ["commit", "-m", "base"], { cwd });
  run("git", ["checkout", "-b", "side"], { cwd });
  fs.writeFileSync(path.join(cwd, "side.js"), "export const side = 'MERGED_SIDE_MARKER';\n");
  run("git", ["add", "side.js"], { cwd });
  run("git", ["commit", "-m", "side"], { cwd });
  run("git", ["checkout", "main"], { cwd });
  fs.writeFileSync(path.join(cwd, "main2.js"), "export const m = 2;\n");
  run("git", ["add", "main2.js"], { cwd });
  run("git", ["commit", "-m", "main2"], { cwd });
  run("git", ["merge", "--no-ff", "side", "-m", "merged"], { cwd });

  const target = resolveReviewTarget(cwd, { commit: "HEAD" });
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "commit");
  assert.match(context.content, /MERGED_SIDE_MARKER/);
});

test("a merge commit with no net first-parent change is refused with merge-specific guidance", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "base.js"), "export const base = 0;\n");
  run("git", ["add", "base.js"], { cwd });
  run("git", ["commit", "-m", "base"], { cwd });
  run("git", ["checkout", "-b", "side"], { cwd });
  fs.writeFileSync(path.join(cwd, "side.js"), "export const side = 1;\n");
  run("git", ["add", "side.js"], { cwd });
  run("git", ["commit", "-m", "side"], { cwd });
  run("git", ["checkout", "main"], { cwd });
  fs.writeFileSync(path.join(cwd, "main2.js"), "export const m = 2;\n");
  run("git", ["add", "main2.js"], { cwd });
  run("git", ["commit", "-m", "main2"], { cwd });
  run("git", ["merge", "-s", "ours", "side", "-m", "oursmerge"], { cwd });

  assert.throws(
    () => resolveReviewTarget(cwd, { commit: "HEAD" }),
    /merge commit that changes nothing/
  );
});

test("single-SHA review of an empty commit is refused instead of reviewing nothing", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 'v1';\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["commit", "--allow-empty", "-m", "empty"], { cwd });

  assert.throws(
    () => resolveReviewTarget(cwd, { commit: "HEAD" }),
    /changes no files/
  );
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
